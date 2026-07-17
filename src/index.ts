import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { getClientInfo, setWebhook } from "./monobankApi";

const MONO_TOKEN = requireEnv("MONO_TOKEN");
const BOT_INCOMING_URL = requireEnv("BOT_INCOMING_URL");
const WEBHOOK_SECRET = requireEnv("WEBHOOK_SECRET");
const PORT = Number(process.env.PORT ?? 3000);

// No DB access from this service (deliberately minimal, no Prisma/DATABASE_URL — see
// package.json). Railway's local filesystem is ephemeral (wiped on redeploy/restart),
// so this file is a best-effort recovery aid, not durable storage — the error-level
// console.error below is the actually durable trail, since Railway's own log platform
// persists stdout/stderr independently of the container's disk.
const FAILED_FORWARDS_LOG_PATH = process.env.FAILED_FORWARDS_LOG_PATH ?? path.join(process.cwd(), "failed_forwards.log");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// TODO(step 2 — real deploy): confirm RAILWAY_PUBLIC_DOMAIN is the exact env var
// Railway injects for a service's generated public domain (per docs.railway.com,
// it's a domain only, no protocol — hence the https:// prefix below). If it turns
// out to be named differently or unset at deploy time, set OWN_PUBLIC_URL manually
// in the service's Railway variables as a fallback (full URL, with protocol).
function getOwnPublicUrl(): string {
  if (process.env.OWN_PUBLIC_URL) {
    return process.env.OWN_PUBLIC_URL;
  }
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  throw new Error(
    "Cannot determine own public URL: neither RAILWAY_PUBLIC_DOMAIN nor OWN_PUBLIC_URL is set",
  );
}

function isAuthorized(req: Request): boolean {
  const provided = req.header("X-Webhook-Secret");
  if (!provided) return false;

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(WEBHOOK_SECRET);
  if (providedBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(providedBuf, expectedBuf);
}

function requireWebhookSecret(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// See mono_api_railway_multi_user_plan.md, open question 8.1: retry a bounded number
// of times before giving up. monobank itself is no longer asked to redeliver on
// failure (we ack it 200 immediately, before forwarding even starts — see the POST "/"
// handler below), so if every attempt here fails, the transaction is only recoverable
// via recordFailedForward's error log / failed_forwards.log — there is no automatic
// retry beyond FORWARD_MAX_ATTEMPTS.
const FORWARD_MAX_ATTEMPTS = 3;
const FORWARD_BACKOFF_MS = [500, 1500];

async function forwardToBot(rawBody: Buffer, contentType: string | undefined): Promise<boolean> {
  for (let attempt = 1; attempt <= FORWARD_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(BOT_INCOMING_URL, {
        method: "POST",
        headers: {
          "Content-Type": contentType ?? "application/json",
          "X-Webhook-Secret": WEBHOOK_SECRET,
        },
        body: new Uint8Array(rawBody),
      });

      if (response.ok) {
        return true;
      }

      console.error(`[forward] bot responded ${response.status} (attempt ${attempt}/${FORWARD_MAX_ATTEMPTS})`);
    } catch (err) {
      console.error(`[forward] attempt ${attempt}/${FORWARD_MAX_ATTEMPTS} failed:`, err);
    }

    if (attempt < FORWARD_MAX_ATTEMPTS) {
      await sleep(FORWARD_BACKOFF_MS[attempt - 1]);
    }
  }

  return false;
}

type FailedForwardStatementItem = {
  id?: string;
  time?: number;
  description?: string;
  amount?: number;
};

type FailedForwardPayload = {
  type?: string;
  data?: {
    account?: string;
    statementItem?: FailedForwardStatementItem;
  };
};

// Manual-recovery aid for a transaction that could not be forwarded after
// FORWARD_MAX_ATTEMPTS — see the comment above forwardToBot. Never retries or
// re-queues anything itself; it only makes the loss visible and inspectable.
async function recordFailedForward(rawBody: Buffer): Promise<void> {
  let parsed: FailedForwardPayload | null = null;
  try {
    parsed = JSON.parse(rawBody.toString("utf8")) as FailedForwardPayload;
  } catch {
    // Not valid JSON — record will fall back to the raw body string below.
  }

  const item = parsed?.data?.statementItem;

  const record = {
    loggedAt: new Date().toISOString(),
    monoTransactionId: item?.id ?? null,
    amount: item?.amount ?? null,
    description: item?.description ?? null,
    time: item?.time ?? null,
    rawPayload: parsed ?? rawBody.toString("utf8"),
  };

  console.error("[forward] FAILED after all retries — transaction not delivered to bot, needs manual recovery", JSON.stringify(record));

  try {
    await appendFile(FAILED_FORWARDS_LOG_PATH, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    console.error("[forward] additionally failed to write failed_forwards.log:", err);
  }
}

const app = express();

app.get("/health", (_req: Request, res: Response) => {
  res.sendStatus(200);
});

// Raw body capture for the monobank inbound webhook: forwarded byte-for-byte,
// so no JSON parsing here.
//
// Acks monobank immediately, before forwarding — forwardToBot's own retry loop
// (up to 3 attempts, 500ms/1500ms backoff) previously ran *before* this response,
// so a slow bot or a transient network blip on attempt 1 could push our own
// response past monobank's webhook timeout and trigger a monobank-level redelivery
// of the same transaction. The bot's /mono/incoming endpoint already deduplicates
// by monobank transaction id, so that redelivery was mostly harmless, but there's
// no reason to risk it (or the extra latency) when acking fast costs nothing here.
app.post("/", express.raw({ type: () => true, limit: "2mb" }), (req: Request, res: Response) => {
  const rawBody = req.body instanceof Buffer ? req.body : Buffer.from([]);
  const contentType = req.header("Content-Type");

  res.sendStatus(200);

  void forwardToBot(rawBody, contentType).then((forwarded) => {
    if (!forwarded) {
      void recordFailedForward(rawBody);
    }
  });
});

app.get("/account-info", requireWebhookSecret, async (_req: Request, res: Response) => {
  try {
    const clientInfo = await getClientInfo(MONO_TOKEN);
    res.json({ clientName: clientInfo.name, accounts: clientInfo.accounts });
  } catch (err) {
    console.error("[account-info] failed:", err);
    res.status(502).json({ error: "Failed to fetch account info from monobank" });
  }
});

app.post(
  "/register-webhook",
  express.json(),
  requireWebhookSecret,
  async (req: Request, res: Response) => {
    const accountId = req.body?.accountId;
    if (typeof accountId !== "string" || accountId.length === 0) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }

    try {
      const publicUrl = getOwnPublicUrl();
      await setWebhook(MONO_TOKEN, publicUrl);
      res.json({ ok: true });
    } catch (err) {
      console.error("[register-webhook] failed:", err);
      res.status(502).json({ error: "Failed to register webhook with monobank" });
    }
  },
);

app.listen(PORT, () => {
  console.log(`Receiver listening on port ${PORT}`);
});
