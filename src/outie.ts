import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  OutieState,
  MemoryBlock,
  JournalEntry,
  Reminder,
  Message,
} from "./types";
import {
  DEFAULT_MEMORY_BLOCKS,
  renderMemoryBlocks,
  MEMORY_TOOLS,
} from "./memory";
import { getNextCronTime, SCHEDULING_TOOLS } from "./scheduling";

export class Outie extends DurableObject<Env> {
  private state: OutieState;
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = {
      memoryBlocks: { ...DEFAULT_MEMORY_BLOCKS },
      reminders: {},
      conversationHistory: [],
    };
  }

  // Initialize state from SQLite
  private async init(): Promise<void> {
    if (this.initialized) return;

    // Create tables if they don't exist
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS memory_blocks (
        label TEXT PRIMARY KEY,
        description TEXT,
        value TEXT,
        char_limit INTEGER,
        last_updated INTEGER
      );
      
      CREATE TABLE IF NOT EXISTS journal (
        id TEXT PRIMARY KEY,
        timestamp INTEGER,
        topic TEXT,
        content TEXT
      );
      
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        description TEXT,
        payload TEXT,
        cron_expression TEXT,
        scheduled_time INTEGER
      );
      
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        role TEXT,
        content TEXT,
        timestamp INTEGER
      );
    `);

    // Load memory blocks
    const blocks = this.ctx.storage.sql
      .exec<{
        label: string;
        description: string;
        value: string;
        char_limit: number;
        last_updated: number;
      }>("SELECT * FROM memory_blocks")
      .toArray();

    for (const block of blocks) {
      this.state.memoryBlocks[block.label] = {
        label: block.label,
        description: block.description,
        value: block.value,
        limit: block.char_limit,
        lastUpdated: block.last_updated,
      };
    }

    // If no blocks, initialize with defaults
    if (blocks.length === 0) {
      for (const [label, block] of Object.entries(DEFAULT_MEMORY_BLOCKS)) {
        this.saveMemoryBlock(block);
      }
    }

    // Load reminders
    const reminders = this.ctx.storage.sql
      .exec<{
        id: string;
        description: string;
        payload: string;
        cron_expression: string | null;
        scheduled_time: number | null;
      }>("SELECT * FROM reminders")
      .toArray();

    for (const r of reminders) {
      this.state.reminders[r.id] = {
        id: r.id,
        description: r.description,
        payload: r.payload,
        cronExpression: r.cron_expression ?? undefined,
        scheduledTime: r.scheduled_time ?? undefined,
      };
    }

    // Load recent messages (last 50)
    const messages = this.ctx.storage.sql
      .exec<{
        id: string;
        role: string;
        content: string;
        timestamp: number;
      }>("SELECT * FROM messages ORDER BY timestamp DESC LIMIT 50")
      .toArray();

    this.state.conversationHistory = messages.reverse().map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
      timestamp: m.timestamp,
    }));

    this.initialized = true;
  }

  // Save memory block to SQLite
  private saveMemoryBlock(block: MemoryBlock): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO memory_blocks (label, description, value, char_limit, last_updated)
       VALUES (?, ?, ?, ?, ?)`,
      block.label,
      block.description,
      block.value,
      block.limit,
      block.lastUpdated,
    );
  }

  // Save journal entry to SQLite
  private saveJournalEntry(entry: JournalEntry): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO journal (id, timestamp, topic, content) VALUES (?, ?, ?, ?)`,
      entry.id,
      entry.timestamp,
      entry.topic,
      entry.content,
    );
  }

  // Save reminder to SQLite
  private saveReminder(reminder: Reminder): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO reminders (id, description, payload, cron_expression, scheduled_time)
       VALUES (?, ?, ?, ?, ?)`,
      reminder.id,
      reminder.description,
      reminder.payload,
      reminder.cronExpression ?? null,
      reminder.scheduledTime ?? null,
    );
  }

  // Delete reminder from SQLite
  private deleteReminder(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM reminders WHERE id = ?", id);
    delete this.state.reminders[id];
  }

  // Save message to SQLite
  private saveMessage(message: Message): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (id, role, content, timestamp) VALUES (?, ?, ?, ?)`,
      message.id,
      message.role,
      message.content,
      message.timestamp,
    );
  }

  // Schedule next alarm for reminders
  private async scheduleNextAlarm(): Promise<void> {
    const reminders = Object.values(this.state.reminders);
    if (reminders.length === 0) return;

    let nextTime = Infinity;
    for (const reminder of reminders) {
      const time =
        reminder.scheduledTime ?? getNextCronTime(reminder.cronExpression!);
      if (time < nextTime) {
        nextTime = time;
      }
    }

    if (nextTime < Infinity) {
      await this.ctx.storage.setAlarm(nextTime);
    }
  }

  // DO alarm handler
  async alarm(): Promise<void> {
    await this.init();
    const now = Date.now();

    for (const reminder of Object.values(this.state.reminders)) {
      const time =
        reminder.scheduledTime ?? getNextCronTime(reminder.cronExpression!);

      // Fire if within 1 minute of scheduled time
      if (Math.abs(time - now) < 60000) {
        // Process the reminder
        console.log(
          `Firing reminder: ${reminder.id} - ${reminder.description}`,
        );

        // TODO: Actually process the payload with Claude
        // For now just log it

        // If one-shot, delete it
        if (reminder.scheduledTime) {
          this.deleteReminder(reminder.id);
        }
      }
    }

    // Schedule next alarm
    await this.scheduleNextAlarm();
  }

  // Handle tool calls
  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (name) {
      case "memory_insert": {
        const block = this.state.memoryBlocks[args.block as string];
        if (!block) return `Error: Unknown memory block "${args.block}"`;

        const lines = block.value.split("\n");
        const line = (args.line as number) ?? 0;
        lines.splice(line, 0, args.content as string);
        block.value = lines.join("\n");
        block.lastUpdated = Date.now();

        if (block.value.length > block.limit) {
          return `Warning: Block "${args.block}" exceeds limit (${block.value.length}/${block.limit})`;
        }

        this.saveMemoryBlock(block);
        return `Inserted into "${args.block}" at line ${line}`;
      }

      case "memory_replace": {
        const block = this.state.memoryBlocks[args.block as string];
        if (!block) return `Error: Unknown memory block "${args.block}"`;

        const oldStr = args.old_str as string;
        const newStr = args.new_str as string;

        if (!block.value.includes(oldStr)) {
          return `Error: "${oldStr}" not found in block "${args.block}"`;
        }

        block.value = block.value.replace(oldStr, newStr);
        block.lastUpdated = Date.now();
        this.saveMemoryBlock(block);
        return `Replaced in "${args.block}"`;
      }

      case "journal_write": {
        const entry: JournalEntry = {
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          topic: args.topic as string,
          content: args.content as string,
        };
        this.saveJournalEntry(entry);
        return `Journal entry saved: ${entry.topic}`;
      }

      case "journal_search": {
        const query = args.query as string;
        const limit = (args.limit as number) ?? 10;

        // Simple search - in production would use FTS or vector search
        const results = this.ctx.storage.sql
          .exec<{
            id: string;
            timestamp: number;
            topic: string;
            content: string;
          }>(
            `SELECT * FROM journal 
           WHERE topic LIKE ? OR content LIKE ?
           ORDER BY timestamp DESC LIMIT ?`,
            `%${query}%`,
            `%${query}%`,
            limit,
          )
          .toArray();

        if (results.length === 0) {
          return "No journal entries found";
        }

        return results
          .map(
            (r) =>
              `[${new Date(r.timestamp).toISOString()}] ${r.topic}: ${r.content}`,
          )
          .join("\n\n");
      }

      case "schedule_reminder": {
        const reminder: Reminder = {
          id: args.id as string,
          description: args.description as string,
          payload: args.payload as string,
          cronExpression: args.cron as string,
        };
        this.state.reminders[reminder.id] = reminder;
        this.saveReminder(reminder);
        await this.scheduleNextAlarm();
        return `Scheduled reminder "${reminder.id}": ${reminder.description}`;
      }

      case "schedule_once": {
        const datetime = new Date(args.datetime as string).getTime();
        const reminder: Reminder = {
          id: args.id as string,
          description: args.description as string,
          payload: args.payload as string,
          scheduledTime: datetime,
        };
        this.state.reminders[reminder.id] = reminder;
        this.saveReminder(reminder);
        await this.scheduleNextAlarm();
        return `Scheduled one-time reminder "${reminder.id}" for ${args.datetime}`;
      }

      case "cancel_reminder": {
        const id = args.id as string;
        if (!this.state.reminders[id]) {
          return `Error: Reminder "${id}" not found`;
        }
        this.deleteReminder(id);
        return `Cancelled reminder "${id}"`;
      }

      case "list_reminders": {
        const reminders = Object.values(this.state.reminders);
        if (reminders.length === 0) {
          return "No scheduled reminders";
        }
        return reminders
          .map((r) => {
            const schedule =
              r.cronExpression ?? new Date(r.scheduledTime!).toISOString();
            return `- ${r.id}: ${r.description} (${schedule})`;
          })
          .join("\n");
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }

  // Build system prompt with memory blocks
  private buildSystemPrompt(): string {
    return `You are Outie, a stateful AI assistant with persistent memory.

${renderMemoryBlocks(this.state.memoryBlocks)}

You have access to tools for managing your memory and scheduling. Use them proactively:
- Update memory blocks when you learn something important
- Write to journal for observations and decisions
- Schedule reminders for future tasks

Be direct and helpful. Your memory persists across conversations.`;
  }

  // Main chat endpoint
  async chat(userMessage: string): Promise<string> {
    await this.init();

    // Save user message
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    };
    this.saveMessage(userMsg);
    this.state.conversationHistory.push(userMsg);

    // Build messages for Claude
    const messages = this.state.conversationHistory.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Call Claude API
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: this.buildSystemPrompt(),
        messages,
        tools: [...MEMORY_TOOLS, ...SCHEDULING_TOOLS],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Claude API error: ${error}`);
    }

    const data = (await response.json()) as {
      content: Array<
        | { type: "text"; text: string }
        | {
            type: "tool_use";
            id: string;
            name: string;
            input: Record<string, unknown>;
          }
      >;
      stop_reason: string;
    };

    // Process response
    let assistantContent = "";
    const toolResults: Array<{ tool_use_id: string; content: string }> = [];

    for (const block of data.content) {
      if (block.type === "text") {
        assistantContent += block.text;
      } else if (block.type === "tool_use") {
        const result = await this.handleToolCall(block.name, block.input);
        toolResults.push({ tool_use_id: block.id, content: result });
      }
    }

    // If there were tool calls, we need to continue the conversation
    if (toolResults.length > 0 && data.stop_reason === "tool_use") {
      // For now, just append tool results to response
      // In production, would continue the conversation with Claude
      assistantContent +=
        "\n\n[Tool results: " +
        toolResults.map((r) => r.content).join(", ") +
        "]";
    }

    // Save assistant message
    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: assistantContent,
      timestamp: Date.now(),
    };
    this.saveMessage(assistantMsg);
    this.state.conversationHistory.push(assistantMsg);

    return assistantContent;
  }

  // HTTP fetch handler
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/chat" && request.method === "POST") {
      const body = (await request.json()) as { message: string };
      const response = await this.chat(body.message);
      return new Response(JSON.stringify({ response }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/memory" && request.method === "GET") {
      await this.init();
      return new Response(JSON.stringify(this.state.memoryBlocks), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/reminders" && request.method === "GET") {
      await this.init();
      return new Response(JSON.stringify(this.state.reminders), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
