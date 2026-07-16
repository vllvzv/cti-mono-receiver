// Copied 1:1 from src/services/monobankApiService.ts in the main bot repo.
// Duplicated intentionally: this service is a separate deploy unit and must
// not import from the bot's codebase (see mono_api_railway_multi_user_plan.md, 4.4).

const MONOBANK_API_BASE_URL = "https://api.monobank.ua";

export type MonoAccount = {
  id: string;
  sendId?: string;
  balance: number;
  creditLimit: number;
  type: string;
  currencyCode: number;
  cashbackType?: string;
  maskedPan?: string[];
  iban: string;
};

export type MonoClientInfo = {
  clientId: string;
  name: string;
  webHookUrl?: string;
  permissions?: string;
  accounts: MonoAccount[];
};

export class MonobankApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "MonobankApiError";
    this.status = status;
  }
}

export async function getClientInfo(token: string): Promise<MonoClientInfo> {
  const response = await fetch(`${MONOBANK_API_BASE_URL}/personal/client-info`, {
    method: "GET",
    headers: { "X-Token": token },
  });

  if (!response.ok) {
    throw new MonobankApiError(`Monobank client-info failed: ${response.status}`, response.status);
  }

  return (await response.json()) as MonoClientInfo;
}

export async function setWebhook(token: string, url: string): Promise<void> {
  const response = await fetch(`${MONOBANK_API_BASE_URL}/personal/webhook`, {
    method: "POST",
    headers: {
      "X-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ webHookUrl: url }),
  });

  if (!response.ok) {
    throw new MonobankApiError(`Monobank setWebhook failed: ${response.status}`, response.status);
  }
}
