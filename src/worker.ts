/**
 * Outie Worker - Entry Point
 * 
 * Routes requests to the Orchestrator DO:
 * - /telegram - Webhook for Telegram messages
 * - /* - Web UI proxy to OpenCode
 * - /health, /stats, /reset - API endpoints
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
import { generateHTML } from './ui/template';

// Re-export Durable Objects for wrangler binding
export { Orchestrator, OutieSandbox, Sandbox } from './orchestrator';

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
      console.log('[TELEGRAM] No text message to process');
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
      console.log('[TELEGRAM] /clear command received');
      try {
        console.log('[TELEGRAM] Calling resetConversation...');
        const result = await getOrchestrator(c.env).resetConversation();
        console.log('[TELEGRAM] resetConversation result:', JSON.stringify(result));
        const sent = await sendMessage(c.env, chatId, 'Conversation cleared.', {
          replyToMessageId: message.message_id,
        });
        console.log('[TELEGRAM] Message sent:', sent);
      } catch (clearError) {
        console.error('[TELEGRAM] Error clearing conversation:', clearError);
        await sendMessage(c.env, chatId, `Error clearing: ${clearError}`, {
          replyToMessageId: message.message_id,
        });
      }
      return c.json({ ok: true });
    }

    // Show typing indicator
    await sendTypingIndicator(c.env, chatId);

    // Forward to Orchestrator
    const response = await getOrchestrator(c.env).chat(text, 'telegram', String(chatId));

    // Handle empty response (model refused/censored)
    const replyText = response.trim() || '[No response - model may have refused to answer]';

    // Send response back to Telegram
    await sendMessage(c.env, chatId, replyText, {
      replyToMessageId: message.message_id,
    });

    return c.json({ ok: true });
  } catch (error) {
    console.error(`[TELEGRAM] Error: ${error}`);
    return c.json({ ok: true }); // Always return 200 to Telegram
  }
});

// =============================================================================
// Memory Browser UI
// =============================================================================

// Main memory browser UI
app.get('/memories', async (c) => {
  const orchestrator = getOrchestrator(c.env);
  const [data, sessionStatus] = await Promise.all([
    orchestrator.getAllData(),
    orchestrator.getSessionStatus(),
  ]);

  const html = generateHTML({ ...data, sessionStatus });
  return c.html(html);
});

// API endpoint for JSON data
app.get('/api/data', async (c) => {
  const data = await getOrchestrator(c.env).getAllData();
  return c.json(data);
});

// Session status endpoint
app.get('/api/session', async (c) => {
  const status = await getOrchestrator(c.env).getSessionStatus();
  return c.json(status);
});

// =============================================================================
// Web UI - Proxy to OpenCode
// =============================================================================

// Catch-all route - proxy to OpenCode web UI
app.all('*', async (c) => {
  return getOrchestrator(c.env).handleWebUI(c.req.raw);
});

export default app;
