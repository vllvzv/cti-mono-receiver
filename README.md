# mono-receiver-template

Minimal per-FOP monobank webhook receiver. One Railway service per FOP, each
with its own `MONO_TOKEN` and public domain, so outbound calls to monobank
(`getClientInfo`, `setWebhook`) come from a distributed set of IPs instead of
one shared bot server.

See `docs/mono_api_railway_multi_user_plan.md` in the main `cti-finance-bot`
repo for the full architecture. This folder is a staging copy — step 2 of that
plan is to move it into its own GitHub repo for Railway to deploy from.

## Endpoints

- `POST /` — inbound webhook from monobank (no auth, monobank itself calls
  this). Forwards the raw request body to `BOT_INCOMING_URL` with header
  `X-Webhook-Secret: ${WEBHOOK_SECRET}`. Acks monobank with 200 before
  forwarding. On a network error, timeout (10 s), 5xx or 429 retries up to 7
  times (1 s, 5 s, 15 s, 1 min, 2 min, 5 min); other 4xx are not retried. A
  forward that never succeeds is logged and appended to `failed_forwards.log`.
- `GET /account-info` — requires header `X-Webhook-Secret` matching the
  `WEBHOOK_SECRET` env var (401 otherwise). Calls monobank `client-info` with
  `MONO_TOKEN` and returns `{ clientName, accounts }` — `clientName` is the
  account owner's name as registered with monobank (there is no separate
  EDRPOU/INN field in this API), for the caller to visually cross-check
  against the FOP it expects to be connecting.
- `POST /register-webhook` — same `X-Webhook-Secret` check, body
  `{ "accountId": string }`. Registers this service's own public URL as the
  monobank webhook for `MONO_TOKEN`.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MONO_TOKEN` | yes | Monobank Personal API token for this FOP. |
| `BOT_INCOMING_URL` | yes | Bot's inbound webhook endpoint, e.g. `https://cti-finance-bot.railway.app/mono/incoming`. |
| `WEBHOOK_SECRET` | yes | Shared secret verified on `/account-info` and `/register-webhook`; also sent to `BOT_INCOMING_URL` when forwarding. |
| `PORT` | no (default `3000`) | HTTP port the service listens on. |
| `RAILWAY_PUBLIC_DOMAIN` | auto (Railway) | Injected by Railway for the service's generated public domain. Used to build the URL passed to `setWebhook`. **Unverified — confirm the exact variable name at deploy time (plan step 2).** |
| `OWN_PUBLIC_URL` | fallback | Set manually if `RAILWAY_PUBLIC_DOMAIN` isn't available or isn't the right variable. Full URL including `https://`. Takes precedence over `RAILWAY_PUBLIC_DOMAIN` when set. |

## Run

```
npm install && npm run build && npm start
```

For local development with hot reload: `npm run dev` (reads a local `.env`
file if present — see `.env.example`).
