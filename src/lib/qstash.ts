import { Client, Receiver } from "@upstash/qstash";
import type { ResetPayload } from "../types.js";

const DEFAULT_RESET_DELAY_SECONDS = 30; // 30 second delay before resetting
const QSTASH_QUEUE_NAME = "netatmo-setpoint";

export class QStashClient {
  private client: Client;
  private receiver: Receiver;
  private baseUrl: string;

  constructor(
    token: string,
    signingKeys: { current: string; next: string },
    baseUrl: string
  ) {
    this.client = new Client({ token });
    this.receiver = new Receiver({
      currentSigningKey: signingKeys.current,
      nextSigningKey: signingKeys.next,
    });
    this.baseUrl = baseUrl;
  }

  /**
   * Schedule a reset callback after a delay
   */
  async scheduleReset(
    payload: ResetPayload,
    delaySeconds: number = DEFAULT_RESET_DELAY_SECONDS
  ): Promise<string> {
    const url = `${this.baseUrl}/reset`;

    console.log(
      `[QStash] Scheduling reset callback to ${url} in ${delaySeconds}s (queue: ${QSTASH_QUEUE_NAME})`
    );

    const result = await this.client.publishJSON({
      url,
      body: payload,
      delay: delaySeconds,
      queue: QSTASH_QUEUE_NAME,
    });

    console.log(`[QStash] Scheduled reset with message ID: ${result.messageId}`);
    return result.messageId;
  }

  /**
   * Verify an incoming QStash webhook signature
   *
   * @param signature - The Upstash-Signature header
   * @param body - The raw request body
   * @returns true if valid, false otherwise
   */
  async verifySignature(signature: string, body: string): Promise<boolean> {
    try {
      await this.receiver.verify({
        signature,
        body,
      });
      return true;
    } catch (error) {
      console.error("[QStash] Signature verification failed:", error);
      return false;
    }
  }

  /**
   * Get the receiver for middleware use
   */
  getReceiver(): Receiver {
    return this.receiver;
  }
}

/**
 * Get the base URL from environment, throwing if not available
 */
function getBaseUrl(): string {
  const vercelUrl = process.env.VERCEL_URL;

  if (!vercelUrl) {
    throw new Error(
      "Missing required environment variable: VERCEL_URL. " +
        "This should be set automatically in Vercel deployments, " +
        "or manually for local development."
    );
  }

  // VERCEL_URL doesn't include protocol
  return `https://${vercelUrl}`;
}

/**
 * Create a QStash client from environment variables
 */
export function createQStashClient(): QStashClient {
  const token = process.env.QSTASH_TOKEN;
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!token || !currentSigningKey || !nextSigningKey) {
    throw new Error(
      "Missing required QStash environment variables: QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY"
    );
  }

  const baseUrl = getBaseUrl();

  return new QStashClient(
    token,
    {
      current: currentSigningKey,
      next: nextSigningKey,
    },
    baseUrl
  );
}
