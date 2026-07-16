import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { getClientInfo, setWebhook } from "./monobankApi";

const MONO_TOKEN = requireEnv("MONO_TOKEN");
const BOT_INCOMING_URL = requireEnv("BOT_INCOMING_URL");
const WEBHOOK_SECRET = requireEnv("WEBHOOK_SECRET");
const PORT = Number(process.env.PORT ?? 3000);

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

// See mono_api_railway_multi_user_plan.md, open question 8.1: retry a bounded
// number of times before giving up. If every attempt fails, we respond
// non-2xx to monobank so its own webhook retry mechanism has a chance to
// redeliver later, instead of silently dropping the transaction.
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

const app = express();

// Raw body capture for the monobank inbound webhook: forwarded byte-for-byte,
// so no JSON parsing here.
app.post("/", express.raw({ type: () => true, limit: "2mb" }), async (req: Request, res: Response) => {
  const rawBody = req.body instanceof Buffer ? req.body : Buffer.from([]);

  const forwarded = await forwardToBot(rawBody, req.header("Content-Type"));
  if (forwarded) {
    res.sendStatus(200);
  } else {
    res.sendStatus(502);
  }
});

app.get("/account-info", requireWebhookSecret, async (_req: Request, res: Response) => {
  try {
    const clientInfo = await getClientInfo(MONO_TOKEN);
    res.json({ accounts: clientInfo.accounts });
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
