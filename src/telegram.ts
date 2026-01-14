// Telegram Bot API integration
import type { Env } from "./types";

const TELEGRAM_API = "https://api.telegram.org/bot";

// Telegram message types (subset we care about)
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from: {
    id: number;
    username?: string;
    first_name: string;
  };
  chat: {
    id: number;
    type: "private" | "group" | "supergroup" | "channel";
  };
  date: number;
  text?: string;
}

// Send a message to a chat
export async function sendMessage(
  env: Env,
  chatId: string | number,
  text: string,
  options?: {
    parseMode?: "Markdown" | "MarkdownV2" | "HTML";
    disableNotification?: boolean;
    replyToMessageId?: number;
  },
): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error("[TELEGRAM] Bot token not configured");
    return false;
  }

  try {
    const response = await fetch(`${TELEGRAM_API}${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: options?.parseMode ?? "Markdown",
        disable_notification: options?.disableNotification,
        reply_to_message_id: options?.replyToMessageId,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[TELEGRAM] Failed to send message: ${error}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`[TELEGRAM] Error sending message: ${error}`);
    return false;
  }
}

// Send a message to the configured owner
export async function notifyOwner(
  env: Env,
  text: string,
  options?: {
    parseMode?: "Markdown" | "MarkdownV2" | "HTML";
    disableNotification?: boolean;
  },
): Promise<boolean> {
  if (!env.TELEGRAM_CHAT_ID) {
    console.error("[TELEGRAM] Owner chat ID not configured");
    return false;
  }

  return sendMessage(env, env.TELEGRAM_CHAT_ID, text, options);
}

// Verify webhook request is from Telegram
export function verifyWebhook(request: Request, env: Env): boolean {
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    // No secret configured, skip verification (not recommended for production)
    console.warn("[TELEGRAM] Webhook secret not configured, skipping verification");
    return true;
  }

  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  return secret === env.TELEGRAM_WEBHOOK_SECRET;
}

// Escape special characters for MarkdownV2
export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

// Format a code block
export function codeBlock(code: string, language?: string): string {
  return `\`\`\`${language ?? ""}\n${code}\n\`\`\``;
}

// Send typing indicator
export async function sendTypingIndicator(
  env: Env,
  chatId: string | number,
): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return false;
  }

  try {
    const response = await fetch(`${TELEGRAM_API}${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        action: "typing",
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
