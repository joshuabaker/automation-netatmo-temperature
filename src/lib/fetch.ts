export class TransientApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientApiError";
  }
}

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;
const FETCH_TIMEOUT_MS = 4000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await delay(BASE_DELAY_MS * Math.pow(2, attempt - 1));
    }

    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (response.ok || response.status < 500) {
        return response;
      }

      lastError = new Error(
        `HTTP ${response.status}: ${await response.text()}`
      );
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new TransientApiError(
    `All ${MAX_RETRIES + 1} attempts failed: ${lastError?.message}`
  );
}
