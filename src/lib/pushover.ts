const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

export async function sendPushoverNotification(
  title: string,
  message: string
): Promise<void> {
  const user = process.env.PUSHOVER_USER;
  const token = process.env.PUSHOVER_TOKEN;

  if (!user || !token) {
    console.warn("Pushover not configured, skipping notification");
    return;
  }

  const params = new URLSearchParams({
    token,
    user,
    title,
    message,
  });

  const response = await fetch(PUSHOVER_API_URL, {
    method: "POST",
    body: params,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Pushover API error: ${response.status} - ${errorText}`);
  }
}
