/**
 * Outie Worker - Entry Point
 * 
 * Routes requests to the Orchestrator DO:
 * - /telegram - Webhook for Telegram messages
 * - /mcp/* - MCP server for OpenCode tools
 * - /* - Web UI proxy to OpenCode
 * - /health - Health check
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  verifyWebhook,
  sendMessage,
  sendTypingIndicator,
  type TelegramUpdate,
} from './telegram';
import type { Orchestrator } from './orchestrator';

// Re-export Durable Objects for wrangler binding
export { Orchestrator, Sandbox } from './orchestrator';

const app = new Hono<{ Bindings: Env }>();

// =============================================================================
// Helpers
// =============================================================================

function getOrchestrator(env: Env): DurableObjectStub<Orchestrator> {
  return env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName('default'));
}

// =============================================================================
// Security Headers
// =============================================================================

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
});

app.use('*', cors());

// =============================================================================
// Routes
// =============================================================================

// Health check
app.get('/health', (c) => {
  return c.json({
    name: 'outie',
    status: 'ok',
    version: '2.0.0',
    architecture: 'orchestrator + opencode',
  });
});

// MCP endpoint - proxy to orchestrator
app.all('/mcp/*', async (c) => {
  // Rewrite URL to strip /mcp prefix
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/mcp/, '') || '/';
  const request = new Request(url.toString(), c.req.raw);
  
  return getOrchestrator(c.env).handleMcp(request);
});

// Conversation stats
app.get('/stats', async (c) => {
  const stats = await getOrchestrator(c.env).getConversationStats();
  return c.json(stats);
});

// Reset conversation
app.post('/reset', async (c) => {
  const result = await getOrchestrator(c.env).resetConversation();
  return c.json(result);
});

// =============================================================================
// Telegram Webhook
// =============================================================================

const ALLOWED_TELEGRAM_USERS = new Set([
  99498607, // Matt
]);

app.post('/telegram', async (c) => {
  // Verify request is from Telegram
  if (!verifyWebhook(c.req.raw, c.env)) {
    console.warn('[TELEGRAM] Webhook verification failed');
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
    const text = message.text!;

    console.log(`[TELEGRAM] Message from ${message.from.username ?? userId}: ${text.slice(0, 50)}`);

    // Access control
    if (!ALLOWED_TELEGRAM_USERS.has(userId)) {
      console.warn(`[TELEGRAM] Unauthorized user: ${userId}`);
      return c.json({ ok: true });
    }

    // Handle /clear command
    if (text.trim().toLowerCase() === '/clear') {
      await getOrchestrator(c.env).resetConversation();
      await sendMessage(c.env, chatId, 'Conversation cleared.', {
        replyToMessageId: message.message_id,
      });
      return c.json({ ok: true });
    }

    // Show typing indicator
    await sendTypingIndicator(c.env, chatId);

    // Forward to Orchestrator
    const response = await getOrchestrator(c.env).chat(text, 'telegram', String(chatId));

    // Send response back to Telegram
    await sendMessage(c.env, chatId, response, {
      replyToMessageId: message.message_id,
    });

    return c.json({ ok: true });
  } catch (error) {
    console.error(`[TELEGRAM] Error: ${error}`);
    return c.json({ ok: true }); // Always return 200 to Telegram
  }
});

// =============================================================================
// Web UI - Proxy to OpenCode
// =============================================================================

// Catch-all route - proxy to OpenCode web UI
app.all('*', async (c) => {
  return getOrchestrator(c.env).handleWebUI(c.req.raw);
});

export default app;
