/**
 * Outie Orchestrator - Durable Object
 * 
 * The "dumb" orchestrator that:
 * 1. Receives triggers (telegram, alarms, web UI)
 * 2. Builds context from state
 * 3. Wakes sandbox and sends prompts to OpenCode
 * 4. Serves MCP tools over HTTP
 * 5. Manages alarms for scheduled reminders
 * 
 * All reasoning happens in OpenCode. This DO just coordinates.
 */

import { DurableObject } from 'cloudflare:workers';
import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import {
  createOpencodeServer,
  proxyToOpencode,
  createOpencode,
} from '@cloudflare/sandbox/opencode';
import type { OpencodeClient, Config } from '@opencode-ai/sdk';

import type { TriggerContext, ConversationMessage, Reminder } from './types';
import { initSchema, appendConversation, getAllReminders, getConversationStats, clearConversation } from './state';
import { buildContext, buildSystemPrompt, buildDynamicContext, buildPrompt } from './context';
import { McpServer } from './mcp-server';
import { getNextCronTime } from '../scheduling';

// Re-export Sandbox for wrangler.jsonc binding
export { Sandbox } from '@cloudflare/sandbox';

// =============================================================================
// OpenCode Configuration
// =============================================================================

function getOpencodeConfig(env: Env): Config {
  return {
    // Use Anthropic directly (BYOK not working through gateway)
    provider: {
      anthropic: {
        options: {
          apiKey: env.ANTHROPIC_KEY,
        },
      },
    },
    // Auto-allow all operations for autonomous mode
    permission: {
      edit: 'allow',
      bash: 'allow',
    },
  };
}

// =============================================================================
// Orchestrator Durable Object
// =============================================================================

export class Orchestrator extends DurableObject<Env> {
  private initialized = false;
  private mcpServer: McpServer | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // Initialize schema on first use
  private async init(): Promise<void> {
    if (this.initialized) return;
    initSchema(this.ctx.storage.sql);
    this.initialized = true;
  }

  // ==========================================================================
  // Alarm Scheduling
  // ==========================================================================

  private async scheduleNextAlarm(): Promise<void> {
    const reminders = getAllReminders(this.ctx.storage.sql);
    if (reminders.length === 0) return;

    let nextTime = Infinity;
    for (const reminder of reminders) {
      const time = reminder.scheduledTime ??
        (reminder.cronExpression ? getNextCronTime(reminder.cronExpression) : Infinity);
      if (time < nextTime) {
        nextTime = time;
      }
    }

    if (nextTime < Infinity) {
      await this.ctx.storage.setAlarm(nextTime);
      console.log(`[ORCHESTRATOR] Next alarm scheduled for ${new Date(nextTime).toISOString()}`);
    }
  }

  // Alarm handler - fires for scheduled reminders
  async alarm(): Promise<void> {
    await this.init();
    const now = Date.now();
    const reminders = getAllReminders(this.ctx.storage.sql);

    for (const reminder of reminders) {
      const time = reminder.scheduledTime ??
        (reminder.cronExpression ? getNextCronTime(reminder.cronExpression) : Infinity);

      // Fire if within 1 minute of scheduled time
      if (Math.abs(time - now) < 60000) {
        console.log(`[ORCHESTRATOR] Firing reminder: ${reminder.id}`);
        
        try {
          await this.invoke({
            type: 'alarm',
            triggerId: reminder.id,
            payload: `[REMINDER: ${reminder.description}]\n\n${reminder.payload}`,
          });
        } catch (error) {
          console.error(`[ORCHESTRATOR] Reminder failed:`, error);
        }
      }
    }

    await this.scheduleNextAlarm();
  }

  // ==========================================================================
  // MCP Server
  // ==========================================================================

  private getMcpServer(): McpServer {
    if (!this.mcpServer) {
      this.mcpServer = new McpServer({
        sql: this.ctx.storage.sql,
        env: this.env,
        ai: this.env.AI,
        scheduleAlarm: () => this.scheduleNextAlarm(),
      });
    }
    return this.mcpServer;
  }

  // Handle MCP requests (called from fetch)
  async handleMcp(request: Request): Promise<Response> {
    await this.init();
    return this.getMcpServer().handleRequest(request);
  }

  // ==========================================================================
  // Web UI Proxy
  // ==========================================================================

  async handleWebUI(request: Request): Promise<Response> {
    await this.init();
    
    const sandbox = getSandbox(this.env.SANDBOX, 'opencode', {
      sleepAfter: '30m', // Longer timeout for interactive use
    });

    // Start or get OpenCode server
    const server = await createOpencodeServer(sandbox, {
      directory: '/home/user',
      config: getOpencodeConfig(this.env),
    });

    // Proxy to OpenCode web UI
    return proxyToOpencode(request, sandbox, server);
  }

  // ==========================================================================
  // Main Invocation (Telegram, Alarm, Ambient)
  // ==========================================================================

  async invoke(trigger: TriggerContext): Promise<string> {
    await this.init();
    console.log(`[ORCHESTRATOR] Invoke: ${trigger.type} (${trigger.triggerId ?? 'no-id'})`);

    // 1. Build context from state
    const context = buildContext(this.ctx.storage.sql);
    const systemPrompt = buildSystemPrompt(context.identity);
    const dynamicContext = buildDynamicContext(context, trigger);
    const prompt = buildPrompt(dynamicContext, trigger, context.conversationStats.needsCompaction);

    // 2. Save user message to conversation buffer (if message trigger)
    if (trigger.type === 'message') {
      const userMsg: ConversationMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: trigger.payload,
        timestamp: Date.now(),
        trigger: trigger.type,
        source: trigger.source,
      };
      appendConversation(this.ctx.storage.sql, userMsg);
    }

    // 3. Wake sandbox and send prompt to OpenCode
    const sandbox = getSandbox(this.env.SANDBOX, 'opencode', {
      sleepAfter: '10m',
    });

    console.log(`[ORCHESTRATOR] Creating OpenCode client`);
    const { client } = await createOpencode<OpencodeClient>(sandbox, {
      directory: '/home/user',
      config: getOpencodeConfig(this.env),
    });

    // Create a fresh session for each invocation (Acme pattern)
    console.log(`[ORCHESTRATOR] Creating session`);
    const session = await client.session.create({
      body: { title: `${trigger.type}: ${trigger.triggerId ?? 'invoke'}` },
      query: { directory: '/home/user' },
    });

    if (!session.data) {
      throw new Error('Failed to create OpenCode session');
    }

    console.log(`[ORCHESTRATOR] Sending prompt to session ${session.data.id}`);
    const result = await client.session.prompt({
      path: { id: session.data.id },
      query: { directory: '/home/user' },
      body: {
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
        parts: [
          { type: 'text', text: systemPrompt },
          { type: 'text', text: prompt },
        ],
      },
    });

    // Extract response text
    const parts = result.data?.parts ?? [];
    const textParts: string[] = [];
    for (const p of parts) {
      if (p.type === 'text' && 'text' in p) {
        textParts.push((p as { text: string }).text ?? '');
      }
    }
    const response = textParts.join('\n');

    console.log(`[ORCHESTRATOR] Got response (${response.length} chars)`);

    // 4. Save assistant message to conversation buffer
    if (response.trim()) {
      const assistantMsg: ConversationMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response,
        timestamp: Date.now(),
        trigger: trigger.type,
      };
      appendConversation(this.ctx.storage.sql, assistantMsg);
    }

    return response;
  }

  // ==========================================================================
  // RPC Methods (called from Worker)
  // ==========================================================================

  async chat(message: string, source?: string, chatId?: string): Promise<string> {
    return this.invoke({
      type: 'message',
      payload: message,
      source: source as TriggerContext['source'],
      chatId,
    });
  }

  async resetConversation(): Promise<{ success: boolean; message: string }> {
    await this.init();
    clearConversation(this.ctx.storage.sql);
    return { success: true, message: 'Conversation cleared' };
  }

  async getConversationStats(): Promise<{ messageCount: number; estimatedTokens: number; needsCompaction: boolean }> {
    await this.init();
    return getConversationStats(this.ctx.storage.sql);
  }
}
