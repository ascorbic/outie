import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  verifyWebhook,
  sendMessage,
  sendTypingIndicator,
  type TelegramUpdate,
} from "./telegram";
import { chatUI } from "./ui";
import type { Outie } from "./outie/index";

// Re-export Durable Objects
export { Outie } from "./outie/index";
export { Sandbox, OutieSandbox } from "./sandbox";

const app = new Hono<{ Bindings: Env }>();

// Helper to get the default Outie DO stub
function getOutie(env: Env): DurableObjectStub<Outie> {
  return env.OUTIE.get(env.OUTIE.idFromName("default"));
}

// Security headers
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
});

// CORS for local development
app.use("*", cors());

// Web UI
app.get("/", (c) => {
  return c.html(chatUI);
});

// Health check
app.get("/health", (c) => {
  return c.json({
    name: "outie",
    status: "ok",
    version: "0.1.0",
  });
});

// Chat endpoint - RPC to DO
app.post("/chat", async (c) => {
  const { message } = await c.req.json<{ message: string }>();
  const response = await getOutie(c.env).chat(message);
  return c.json({ response });
});

// Get memory blocks - RPC to DO
app.get("/memory", async (c) => {
  const blocks = await getOutie(c.env).getMemoryBlocks();
  return c.json(blocks);
});

// Get reminders - RPC to DO
app.get("/reminders", async (c) => {
  const reminders = await getOutie(c.env).getReminders();
  return c.json(reminders);
});

// Reset conversation history - RPC to DO
app.post("/reset", async (c) => {
  const result = await getOutie(c.env).resetConversation();
  return c.json(result);
});


// ==========================================
// Telegram Bot webhook
// ==========================================

// Allowed Telegram user IDs (add more as needed)
const ALLOWED_TELEGRAM_USERS = new Set([
  99498607, // Matt
]);

app.post("/telegram", async (c) => {
  // Verify request is from Telegram
  if (!verifyWebhook(c.req.raw, c.env)) {
    console.warn("[TELEGRAM] Webhook verification failed");
    return c.json({ ok: false }, 401);
  }

  try {
    const update: TelegramUpdate = await c.req.json();

    // Only process messages
    if (!update.message?.text) {
      return c.json({ ok: true });
    }

    const { message } = update;
    const userId = message.from.id;
    const chatId = message.chat.id;
    const text = message.text!; // Already checked above

    console.log(`[TELEGRAM] Message from ${message.from.username ?? userId}: ${text.slice(0, 50)}`);

    // Access control - check if user is allowed
    if (!ALLOWED_TELEGRAM_USERS.has(userId)) {
      console.warn(`[TELEGRAM] Unauthorized user: ${userId}`);
      // Silent ignore for unauthorized users
      return c.json({ ok: true });
    }

    // Show typing indicator immediately
    await sendTypingIndicator(c.env, chatId);

    // Forward to Outie via RPC, with source context
    const response = await getOutie(c.env).chat(text, { source: "telegram", chatId: String(chatId) });

    // Send response back to Telegram
    await sendMessage(c.env, chatId, response, {
      replyToMessageId: message.message_id,
    });

    return c.json({ ok: true });
  } catch (error) {
    console.error(`[TELEGRAM] Error processing update: ${error}`);
    return c.json({ ok: true }); // Always return 200 to Telegram
  }
});

// Run a coding task synchronously.
// Client should use a long timeout (5-10 minutes).
// Routes through Outie DO for state management via RPC.
app.post("/code", async (c) => {
  const { repo_url, task } = await c.req.json<{ repo_url: string; task: string }>();
  try {
    const result = await getOutie(c.env).runManagedCodingTask(repo_url, task);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  }
});

export default app;
