/**
 * MCP Server (Streamable HTTP Transport)
 *
 * Exposes memory, scheduling, and communication tools over MCP.
 * OpenCode in the sandbox connects to this server.
 *
 * Implements the MCP Streamable HTTP transport:
 * - POST for JSON-RPC requests
 * - Responses can be JSON or SSE stream
 * - Session management via Mcp-Session-Id header
 */

import type {
  JournalEntry,
  ConversationSummary,
  Reminder,
  Topic,
} from './types';
import {
  saveJournalEntry,
  saveSummary,
  getRecentSummaries,
  clearConversation,
  saveReminder,
  deleteReminder,
  getAllReminders,
  saveTopic,
  getTopic,
  listTopics,
  getStateFile,
  saveStateFile,
} from './state';
import { sendMessage } from '../telegram';
import { getEmbedding, searchJournal, searchTopics } from './embeddings';

// =============================================================================
// JSON-RPC Types
// =============================================================================

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

// =============================================================================
// Tool Definitions
// =============================================================================

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  // Memory tools
  {
    name: 'journal_write',
    description: 'Write a journal entry. Use to record observations, decisions, things to remember.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Short topic/category for the entry' },
        content: { type: 'string', description: 'The journal entry content' },
      },
      required: ['topic', 'content'],
    },
  },
  {
    name: 'journal_search',
    description: 'Semantic search over journal entries to find relevant past context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language query' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'topic_write',
    description: 'Create or update a topic - distilled knowledge about a concept or tool.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Topic name' },
        content: { type: 'string', description: 'Distilled knowledge (keep concise)' },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'topic_get',
    description: 'Read a topic by name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Topic name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'topic_list',
    description: 'List all topics.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'topic_search',
    description: 'Semantic search over topics.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language query' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
  },

  // State file tools
  {
    name: 'state_read',
    description: 'Read a state file (identity, today, matt, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'State file name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'state_write',
    description: 'Write a state file.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'State file name' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['name', 'content'],
    },
  },

  // Communication tools
  {
    name: 'send_telegram',
    description: 'Send a message to Telegram.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to send' },
        chat_id: { type: 'string', description: 'Optional: specific chat ID' },
      },
      required: ['message'],
    },
  },

  // Scheduling tools
  {
    name: 'schedule_recurring',
    description: 'Schedule a recurring reminder using cron syntax.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique reminder ID' },
        description: { type: 'string', description: 'What this reminder is for' },
        payload: { type: 'string', description: 'Message to process when reminder fires' },
        cron: { type: 'string', description: 'Cron expression' },
      },
      required: ['id', 'description', 'payload', 'cron'],
    },
  },
  {
    name: 'schedule_once',
    description: 'Schedule a one-time reminder at a specific datetime.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique reminder ID' },
        description: { type: 'string', description: 'What this reminder is for' },
        payload: { type: 'string', description: 'Message to process when reminder fires' },
        datetime: { type: 'string', description: 'ISO 8601 datetime' },
      },
      required: ['id', 'description', 'payload', 'datetime'],
    },
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel a scheduled reminder.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Reminder ID to cancel' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_reminders',
    description: 'List all scheduled reminders.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // Conversation management
  {
    name: 'save_conversation_summary',
    description: 'Save a summary of the conversation for context recovery. This clears the conversation buffer.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Brief summary of what was discussed' },
        notes: { type: 'string', description: 'Freeform notes' },
        key_decisions: { type: 'array', items: { type: 'string' }, description: 'Important decisions made' },
        open_threads: { type: 'array', items: { type: 'string' }, description: 'Topics to follow up on' },
        learned_patterns: { type: 'array', items: { type: 'string' }, description: 'New patterns learned' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'get_recent_summaries',
    description: 'Get recent conversation summaries for context.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of summaries (default 3)' },
      },
    },
  },
];

// =============================================================================
// MCP Server Implementation
// =============================================================================

export interface McpServerContext {
  sql: SqlStorage;
  env: Env;
  ai: Ai;
  scheduleAlarm: () => Promise<void>;
}

export class McpServer {
  private sql: SqlStorage;
  private env: Env;
  private ai: Ai;
  private scheduleAlarm: () => Promise<void>;
  private sessionId: string;

  constructor(ctx: McpServerContext) {
    this.sql = ctx.sql;
    this.env = ctx.env;
    this.ai = ctx.ai;
    this.scheduleAlarm = ctx.scheduleAlarm;
    this.sessionId = crypto.randomUUID();
  }

  /**
   * Handle JSON-RPC request directly (for WebSocket bridge).
   * Returns the response object without HTTP wrapping.
   */
  async handleJsonRpcDirect(request: JsonRpcRequest | JsonRpcRequest[]): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    const requests = Array.isArray(request) ? request : [request];
    const responses: JsonRpcResponse[] = [];

    for (const req of requests) {
      const response = await this.handleJsonRpcRequest(req);
      if (response) {
        responses.push(response);
      }
    }

    if (responses.length === 0) {
      return null; // All notifications
    }

    return responses.length === 1 ? responses[0] : responses;
  }

  /**
   * Handle HTTP request (Streamable HTTP transport)
   */
  async handleRequest(request: Request): Promise<Response> {
    const method = request.method;

    // Check session header for existing sessions
    const requestSessionId = request.headers.get('Mcp-Session-Id');

    if (method === 'POST') {
      return this.handlePost(request, requestSessionId);
    }

    if (method === 'GET') {
      // GET is for opening an SSE stream for server-initiated messages
      // We don't need this for our use case
      return new Response(null, { status: 405 });
    }

    if (method === 'DELETE') {
      // Session termination
      if (requestSessionId === this.sessionId) {
        // Session terminated
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }

    return new Response(null, { status: 405 });
  }

  private async handlePost(request: Request, sessionId: string | null): Promise<Response> {
    const body = await request.json() as JsonRpcRequest | JsonRpcRequest[];

    // Handle batch or single request
    const requests = Array.isArray(body) ? body : [body];
    const responses: JsonRpcResponse[] = [];

    for (const req of requests) {
      const response = await this.handleJsonRpcRequest(req);
      if (response) {
        responses.push(response);
      }
    }

    // If all were notifications, return 202
    if (responses.length === 0) {
      return new Response(null, { status: 202 });
    }

    // Return single response or array
    const responseBody = responses.length === 1 ? responses[0] : responses;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add session ID on initialize response
    if (requests.some(r => r.method === 'initialize')) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    return new Response(JSON.stringify(responseBody), { headers });
  }

  private async handleJsonRpcRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const { id, method, params } = request;

    try {
      switch (method) {
        // MCP Lifecycle
        case 'initialize':
          return this.jsonRpcResult(id, {
            protocolVersion: '2025-03-26',
            serverInfo: {
              name: 'outie-mcp',
              version: '1.0.0',
            },
            capabilities: {
              tools: {},
            },
          });

        case 'initialized':
          // Notification, no response
          return null;

        case 'ping':
          return this.jsonRpcResult(id, {});

        // Tool listing
        case 'tools/list':
          return this.jsonRpcResult(id, {
            tools: TOOL_DEFINITIONS,
          });

        // Tool execution
        case 'tools/call':
          return this.handleToolCall(id, params as { name: string; arguments: Record<string, unknown> });

        default:
          return this.jsonRpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.jsonRpcError(id, -32603, message);
    }
  }

  private async handleToolCall(
    id: string | number,
    params: { name: string; arguments: Record<string, unknown> }
  ): Promise<JsonRpcResponse> {
    const { name, arguments: args } = params;

    try {
      const result = await this.executeTool(name, args);
      return this.jsonRpcResult(id, {
        content: [{ type: 'text', text: result }],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.jsonRpcResult(id, {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      });
    }
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    console.log(`[MCP] Tool call: ${name}`, JSON.stringify(args).slice(0, 200));
    const startTime = Date.now();

    try {
      const result = await this.executeToolInternal(name, args);
      console.log(`[MCP] Tool ${name} completed in ${Date.now() - startTime}ms`);
      return result;
    } catch (err) {
      console.error(`[MCP] Tool ${name} failed:`, err);
      throw err;
    }
  }

  private async executeToolInternal(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      // Journal
      case 'journal_write': {
        const { topic, content } = args as { topic: string; content: string };
        const entry: JournalEntry = {
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          topic,
          content,
        };
        const embedding = await getEmbedding(this.ai, `${topic}: ${content}`);
        saveJournalEntry(this.sql, entry, embedding);
        return `Journal entry saved: ${topic}`;
      }

      case 'journal_search': {
        const { query, limit = 5 } = args as { query: string; limit?: number };
        const results = await searchJournal(this.ai, this.sql, query, limit);
        if (results.length === 0) return 'No matching journal entries found.';
        return results.map((r: { entry: JournalEntry; score: number }) =>
          `[${new Date(r.entry.timestamp).toISOString().split('T')[0]}] [${r.entry.topic}] (${(r.score * 100).toFixed(0)}% match)\n${r.entry.content}`
        ).join('\n\n---\n\n');
      }

      // Topics
      case 'topic_write': {
        const { name: topicName, content } = args as { name: string; content: string };
        const existing = getTopic(this.sql, topicName);
        const now = Date.now();
        const topic: Topic = {
          id: existing?.id ?? crypto.randomUUID(),
          name: topicName,
          content,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        const embedding = await getEmbedding(this.ai, `${topicName}: ${content}`);
        saveTopic(this.sql, topic, embedding);
        return existing ? `Updated topic "${topicName}"` : `Created topic "${topicName}"`;
      }

      case 'topic_get': {
        const { name: topicName } = args as { name: string };
        const topic = getTopic(this.sql, topicName);
        if (!topic) return `Topic "${topicName}" not found.`;
        return `# ${topic.name}\n\n${topic.content}`;
      }

      case 'topic_list': {
        const topics = listTopics(this.sql);
        if (topics.length === 0) return 'No topics yet.';
        return topics.map(t =>
          `- ${t.name} (updated ${new Date(t.updatedAt).toLocaleDateString()})`
        ).join('\n');
      }

      case 'topic_search': {
        const { query, limit = 5 } = args as { query: string; limit?: number };
        const results = await searchTopics(this.ai, this.sql, query, limit);
        if (results.length === 0) return 'No matching topics found.';
        return results.map((r: { topic: Topic; score: number }) =>
          `## ${r.topic.name} (${(r.score * 100).toFixed(0)}% match)\n${r.topic.content}`
        ).join('\n\n---\n\n');
      }

      // State files
      case 'state_read': {
        const { name: fileName } = args as { name: string };
        const file = getStateFile(this.sql, fileName);
        if (!file) return `State file "${fileName}" not found.`;
        return file.content;
      }

      case 'state_write': {
        const { name: fileName, content } = args as { name: string; content: string };
        saveStateFile(this.sql, {
          name: fileName,
          content,
          updatedAt: Date.now(),
        });
        return `State file "${fileName}" saved.`;
      }

      // Communication
      case 'send_telegram': {
        const { message, chat_id } = args as { message: string; chat_id?: string };
        const targetChatId = chat_id ?? this.env.TELEGRAM_CHAT_ID;
        if (!targetChatId) return 'Error: No chat ID and TELEGRAM_CHAT_ID not configured';
        const success = await sendMessage(this.env, targetChatId, message);
        return success ? `Message sent to Telegram` : 'Failed to send Telegram message';
      }

      // Scheduling
      case 'schedule_recurring': {
        const { id: reminderId, description, payload, cron } = args as {
          id: string; description: string; payload: string; cron: string;
        };
        const reminder: Reminder = {
          id: reminderId,
          description,
          payload,
          cronExpression: cron,
          createdAt: Date.now(),
        };
        saveReminder(this.sql, reminder);
        await this.scheduleAlarm();
        return `Scheduled recurring reminder "${reminderId}": ${description}`;
      }

      case 'schedule_once': {
        const { id: reminderId, description, payload, datetime } = args as {
          id: string; description: string; payload: string; datetime: string;
        };
        const scheduledTime = new Date(datetime).getTime();
        if (isNaN(scheduledTime)) return `Invalid datetime: ${datetime}`;
        if (scheduledTime <= Date.now()) return `Cannot schedule in the past: ${datetime}`;

        const reminder: Reminder = {
          id: reminderId,
          description,
          payload,
          scheduledTime,
          createdAt: Date.now(),
        };
        saveReminder(this.sql, reminder);
        await this.scheduleAlarm();
        return `Scheduled one-time reminder "${reminderId}" for ${datetime}`;
      }

      case 'cancel_reminder': {
        const { id: reminderId } = args as { id: string };
        deleteReminder(this.sql, reminderId);
        return `Cancelled reminder "${reminderId}"`;
      }

      case 'list_reminders': {
        const reminders = getAllReminders(this.sql);
        if (reminders.length === 0) return 'No scheduled reminders.';
        return reminders.map(r => {
          const schedule = r.cronExpression ??
            (r.scheduledTime ? new Date(r.scheduledTime).toISOString() : 'unknown');
          return `- ${r.id}: ${r.description} (${schedule})`;
        }).join('\n');
      }

      // Conversation management
      case 'save_conversation_summary': {
        const { summary, notes, key_decisions, open_threads, learned_patterns } = args as {
          summary: string;
          notes?: string;
          key_decisions?: string[];
          open_threads?: string[];
          learned_patterns?: string[];
        };
        const summaryEntry: ConversationSummary = {
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          summary,
          notes,
          keyDecisions: key_decisions,
          openThreads: open_threads,
          learnedPatterns: learned_patterns,
        };
        saveSummary(this.sql, summaryEntry);
        clearConversation(this.sql);
        return `Conversation summary saved. Buffer cleared.`;
      }

      case 'get_recent_summaries': {
        const { count = 3 } = args as { count?: number };
        const summaries = getRecentSummaries(this.sql, count);
        if (summaries.length === 0) return 'No conversation summaries yet.';
        return summaries.map(s => {
          const parts = [`**${new Date(s.timestamp).toISOString().split('T')[0]}**: ${s.summary}`];
          if (s.notes) parts.push(`Notes: ${s.notes}`);
          if (s.keyDecisions?.length) parts.push(`Decisions: ${s.keyDecisions.join(', ')}`);
          if (s.openThreads?.length) parts.push(`Open: ${s.openThreads.join(', ')}`);
          return parts.join('\n');
        }).join('\n\n---\n\n');
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private jsonRpcResult(id: string | number, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private jsonRpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}
