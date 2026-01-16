/**
 * Outie Orchestrator - Durable Object
 * 
 * The "dumb" orchestrator that:
 * 1. Receives triggers (telegram, alarms, web UI)
 * 2. Builds context from state
 * 3. Wakes sandbox and sends prompts to OpenCode
 * 4. Connects to MCP bridge in container via WebSocket
 * 5. Manages alarms for scheduled reminders
 * 
 * All reasoning happens in OpenCode. This DO just coordinates.
 * 
 * MCP Bridge Architecture:
 * - Container runs mcp-bridge server on ports 8787 (HTTP) and 8788 (WS)
 * - DO connects to WS port (DO-initiated, bypasses Access)
 * - OpenCode connects to HTTP port on localhost (no Access needed)
 * - MCP requests flow: OpenCode -> bridge HTTP -> bridge WS -> DO -> SQLite
 */

import { DurableObject } from 'cloudflare:workers';
import { getSandbox, Sandbox } from '@cloudflare/sandbox';
import {
  createOpencodeServer,
  proxyToOpencode,
  createOpencode,
} from '@cloudflare/sandbox/opencode';
import type { OpencodeClient, Config } from '@opencode-ai/sdk';

import type { TriggerContext, ConversationMessage, Reminder } from './types';
import { initSchema, appendConversation, getAllReminders, deleteReminder, getConversationStats, clearConversation } from './state';
import { buildContext, buildSystemPrompt, buildDynamicContext, buildPrompt } from './context';
import { McpServer } from './mcp-server';
import { getNextCronTime } from '../scheduling';
import { getGitHubAppCredentials, getInstallationToken } from '../github';

// MCP Bridge ports in container
const MCP_BRIDGE_WS_PORT = 8788;

// Concrete Sandbox subclass with Env type bound for proper wrangler typing
export class OutieSandbox extends Sandbox<Env> {}

// Keep exporting base Sandbox for migration compatibility
export { Sandbox } from '@cloudflare/sandbox';

// =============================================================================
// OpenCode Configuration
// =============================================================================

function getOpencodeConfig(env: Env): Config {
  return {
    model: 'zai-coding-plan/glm-4.7',
    provider: {
      zhipu: {
        options: {
          apiKey: env.ZAI_API_KEY,
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
  private mcpBridgeWs: WebSocket | null = null;
  private mcpBridgeConnecting = false;
  
  // Session management for interrupt support
  private currentSessionId: string | null = null;
  private currentClient: OpencodeClient | null = null;
  private isProcessing = false;

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
    if (reminders.length === 0) {
      console.log(`[ORCHESTRATOR] No reminders, clearing alarm`);
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const now = Date.now();
    let nextTime = Infinity;
    
    for (const reminder of reminders) {
      const time = reminder.scheduledTime ??
        (reminder.cronExpression ? getNextCronTime(reminder.cronExpression) : Infinity);
      // Only consider future times
      if (time > now && time < nextTime) {
        nextTime = time;
      }
    }

    if (nextTime < Infinity) {
      await this.ctx.storage.setAlarm(nextTime);
      console.log(`[ORCHESTRATOR] Next alarm scheduled for ${new Date(nextTime).toISOString()}`);
    } else {
      console.log(`[ORCHESTRATOR] No future alarms to schedule`);
      await this.ctx.storage.deleteAlarm();
    }
  }

  // Alarm handler - fires for scheduled reminders
  async alarm(): Promise<void> {
    await this.init();
    const now = Date.now();
    const reminders = getAllReminders(this.ctx.storage.sql);

    for (const reminder of reminders) {
      const isOneShot = !!reminder.scheduledTime;
      const time = reminder.scheduledTime ??
        (reminder.cronExpression ? getNextCronTime(reminder.cronExpression) : Infinity);

      // For one-shot reminders that are in the past (missed), delete them
      if (isOneShot && time < now - 60000) {
        console.log(`[ORCHESTRATOR] Deleting missed one-shot reminder: ${reminder.id}`);
        deleteReminder(this.ctx.storage.sql, reminder.id);
        continue;
      }

      // Fire if within 1 minute of scheduled time
      if (Math.abs(time - now) < 60000) {
        console.log(`[ORCHESTRATOR] Firing reminder: ${reminder.id}`);
        
        // Delete one-shot reminders after firing
        if (isOneShot) {
          deleteReminder(this.ctx.storage.sql, reminder.id);
        }
        
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

  // ==========================================================================
  // MCP Bridge WebSocket Connection
  // ==========================================================================

  /**
   * Connect to the MCP bridge running in the container.
   * The bridge runs a WS server on port 8788 that we connect to.
   * This connection is DO-initiated, so it bypasses Cloudflare Access.
   */
  private async connectToMcpBridge(sandbox: Sandbox<Env>): Promise<void> {
    if (this.mcpBridgeWs && this.mcpBridgeWs.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    if (this.mcpBridgeConnecting) {
      // Wait for existing connection attempt
      await new Promise<void>(resolve => {
        const check = () => {
          if (!this.mcpBridgeConnecting) resolve();
          else setTimeout(check, 100);
        };
        check();
      });
      return;
    }

    this.mcpBridgeConnecting = true;

    try {
      // Start the MCP bridge process if not running
      console.log('[ORCHESTRATOR] Starting MCP bridge in container...');
      try {
        await sandbox.startProcess('cd /opt/mcp-bridge && bun run index.ts', {
          processId: 'mcp-bridge',
        });
      } catch (e) {
        // Process might already be running
        console.log('[ORCHESTRATOR] MCP bridge may already be running:', e);
      }

      // Wait a moment for the server to start
      await new Promise(r => setTimeout(r, 2000));

      // Connect to the WS server using sandbox.wsConnect
      console.log('[ORCHESTRATOR] Connecting to MCP bridge WebSocket...');
      
      // Create WebSocket upgrade request
      const wsRequest = new Request('http://localhost/', {
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
        },
      });

      // Use wsConnect which is attached to the sandbox stub by getSandbox()

      
      const response = await sandbox.wsConnect(wsRequest, MCP_BRIDGE_WS_PORT);
      
      const ws = response.webSocket;
      if (!ws) {
        throw new Error('WebSocket upgrade failed - no webSocket in response');
      }

      // Accept the WebSocket
      ws.accept();

      // Set up message handler
      ws.addEventListener('message', async (event) => {
        try {
          const data = JSON.parse(event.data as string);
          const { requestId, request } = data;

          // Process the MCP request
          const mcpResponse = await this.getMcpServer().handleJsonRpcDirect(request);

          // Send response back to bridge
          ws.send(JSON.stringify({ requestId, response: mcpResponse }));
        } catch (error) {
          console.error('[ORCHESTRATOR] Error handling MCP bridge message:', error);
        }
      });

      ws.addEventListener('close', () => {
        console.log('[ORCHESTRATOR] MCP bridge WebSocket closed');
        this.mcpBridgeWs = null;
      });

      ws.addEventListener('error', (error) => {
        console.error('[ORCHESTRATOR] MCP bridge WebSocket error:', error);
        this.mcpBridgeWs = null;
      });

      this.mcpBridgeWs = ws;
      console.log('[ORCHESTRATOR] MCP bridge connected');
    } finally {
      this.mcpBridgeConnecting = false;
    }
  }

  // ==========================================================================
  // Web UI Proxy
  // ==========================================================================

  async handleWebUI(request: Request): Promise<Response> {
    await this.init();
    
    const sandbox = getSandbox(this.env.SANDBOX, 'opencode', {
      sleepAfter: '30m', // Longer timeout for interactive use
    });

    // Wait for sandbox to be ready (container needs to start)
    await this.waitForSandboxReady(sandbox);

    // Start or get OpenCode server
    const server = await createOpencodeServer(sandbox, {
      directory: '/home/user',
      config: getOpencodeConfig(this.env),
    });

    // Proxy to OpenCode web UI
    return proxyToOpencode(request, sandbox, server);
  }

  // Wait for sandbox container to be ready by polling
  private async waitForSandboxReady(
    sandbox: ReturnType<typeof getSandbox>,
    maxAttempts = 30
  ): Promise<void> {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await sandbox.exec('echo ready');
        console.log(`[ORCHESTRATOR] Sandbox ready after ${attempt} attempts`);
        return;
      } catch (err) {
        if (attempt === maxAttempts) {
          throw new Error(`Sandbox not ready after ${maxAttempts} attempts: ${err}`);
        }
        console.log(`[ORCHESTRATOR] Waiting for sandbox (attempt ${attempt}/${maxAttempts})...`);
        await sleep(1000);
      }
    }
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
    console.log(`[ORCHESTRATOR] Getting sandbox...`);
    const sandbox = getSandbox<Sandbox<Env>>(this.env.SANDBOX, 'opencode', {
      sleepAfter: '10m',
    });

    // Set environment variables for the sandbox (API keys for OpenCode)
    console.log(`[ORCHESTRATOR] Setting sandbox env vars...`);
    const envVars: Record<string, string> = {
      ANTHROPIC_API_KEY: this.env.ANTHROPIC_KEY ?? '',
    };

    // Generate GitHub token from App credentials if available
    const ghCreds = getGitHubAppCredentials(this.env);
    if (ghCreds) {
      try {
        const githubToken = await getInstallationToken(ghCreds);
        envVars.GITHUB_TOKEN = githubToken;
        console.log(`[ORCHESTRATOR] GitHub token generated`);
      } catch (err) {
        console.error(`[ORCHESTRATOR] Failed to get GitHub token:`, err);
      }
    } else {
      console.log(`[ORCHESTRATOR] No GitHub App credentials configured`);
    }

    await sandbox.setEnvVars(envVars);

    // Wait for container to be ready
    console.log(`[ORCHESTRATOR] Waiting for sandbox ready...`);
    await this.waitForSandboxReady(sandbox);
    console.log(`[ORCHESTRATOR] Sandbox ready`);

    // Connect to MCP bridge (starts bridge if needed, connects via WS)
    console.log(`[ORCHESTRATOR] Connecting to MCP bridge...`);
    await this.connectToMcpBridge(sandbox);
    console.log(`[ORCHESTRATOR] MCP bridge connected`);

    console.log(`[ORCHESTRATOR] Creating OpenCode client`);
    const { client } = await createOpencode<OpencodeClient>(sandbox, {
      directory: '/home/user',
      config: getOpencodeConfig(this.env),
    });
    this.currentClient = client;

    // If we're already processing, abort and reuse the session for continuity
    let sessionId: string;
    let wasInterrupted = false;
    
    if (this.isProcessing && this.currentSessionId) {
      console.log(`[ORCHESTRATOR] Aborting previous session ${this.currentSessionId}`);
      try {
        await client.session.abort({ path: { id: this.currentSessionId } });
        wasInterrupted = true;
      } catch (err) {
        console.log(`[ORCHESTRATOR] Abort failed (session may have completed):`, err);
      }
    }

    // Reuse session only if we just interrupted it, otherwise create fresh
    if (wasInterrupted && this.currentSessionId) {
      sessionId = this.currentSessionId;
      console.log(`[ORCHESTRATOR] Reusing interrupted session ${sessionId}`);
    } else {
      console.log(`[ORCHESTRATOR] Creating new session`);
      const session = await client.session.create({
        body: { title: `${trigger.type}: ${trigger.triggerId ?? 'invoke'}` },
        query: { directory: '/home/user' },
      });

      if (!session.data) {
        throw new Error('Failed to create OpenCode session');
      }
      sessionId = session.data.id;
      this.currentSessionId = sessionId;
    }

    console.log(`[ORCHESTRATOR] Sending prompt to session ${sessionId}`);
    this.isProcessing = true;
    
    let result;
    try {
      result = await client.session.prompt({
        path: { id: sessionId },
        query: { directory: '/home/user' },
        body: {
          model: { providerID: 'zai-coding-plan', modelID: 'glm-4.7' },
          parts: [
            { type: 'text', text: systemPrompt },
            { type: 'text', text: prompt },
          ],
        },
      });
    } finally {
      this.isProcessing = false;
    }

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
