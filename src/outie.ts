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
import { WEB_SEARCH_TOOLS, searchWeb, searchNews } from "./web-search";
import { WEB_FETCH_TOOLS, fetchPageAsMarkdown } from "./web-fetch";

export class Outie extends DurableObject<Env> {
  private state: OutieState;
  private initialized = false;
  // URLs that are allowed to be fetched (from search results or user input)
  private allowedUrls: Set<string> = new Set();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = {
      memoryBlocks: { ...DEFAULT_MEMORY_BLOCKS },
      reminders: {},
      conversationHistory: [],
    };
  }

  // Extract URLs from text (user messages, search results)
  private extractUrls(text: string): string[] {
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
    return text.match(urlRegex) || [];
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
        content TEXT,
        embedding TEXT
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

  // Generate embedding using Workers AI
  private async getEmbedding(text: string): Promise<number[]> {
    const result = await this.env.AI.run("@cf/baai/bge-small-en-v1.5", {
      text: [text],
    });
    // Result has data array of embeddings
    if ("data" in result && result.data && result.data.length > 0) {
      return result.data[0];
    }
    throw new Error("Failed to generate embedding");
  }

  // Cosine similarity between two vectors
  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // Save journal entry to SQLite with embedding
  private async saveJournalEntry(entry: JournalEntry): Promise<void> {
    // Generate embedding for the content
    const embedding = await this.getEmbedding(
      `${entry.topic}: ${entry.content}`,
    );

    this.ctx.storage.sql.exec(
      `INSERT INTO journal (id, timestamp, topic, content, embedding) VALUES (?, ?, ?, ?, ?)`,
      entry.id,
      entry.timestamp,
      entry.topic,
      entry.content,
      JSON.stringify(embedding),
    );
  }

  // Semantic search over journal entries
  private async searchJournal(
    query: string,
    limit: number = 5,
  ): Promise<Array<{ entry: JournalEntry; score: number }>> {
    // Get query embedding
    const queryEmbedding = await this.getEmbedding(query);

    // Load all journal entries with embeddings
    const entries = this.ctx.storage.sql
      .exec<{
        id: string;
        timestamp: number;
        topic: string;
        content: string;
        embedding: string | null;
      }>("SELECT * FROM journal WHERE embedding IS NOT NULL")
      .toArray();

    // Calculate similarity scores
    const results = entries
      .map((e) => {
        const embedding = e.embedding ? JSON.parse(e.embedding) : null;
        const score = embedding
          ? this.cosineSimilarity(queryEmbedding, embedding)
          : 0;
        return {
          entry: {
            id: e.id,
            timestamp: e.timestamp,
            topic: e.topic,
            content: e.content,
          },
          score,
        };
      })
      .filter((r) => r.score > 0.3) // Minimum similarity threshold
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return results;
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

      // If this is a one-shot reminder that's more than 1 hour in the past, just delete it
      if (reminder.scheduledTime && time < now - 3600000) {
        console.log(`Deleting expired reminder: ${reminder.id}`);
        this.deleteReminder(reminder.id);
        continue;
      }

      // Fire if within 1 minute of scheduled time
      if (Math.abs(time - now) < 60000) {
        // Process the reminder
        console.log(
          `Firing reminder: ${reminder.id} - ${reminder.description}`,
        );

        // Process the reminder payload with AI
        try {
          const response = await this.chat(
            `[REMINDER TRIGGERED: ${reminder.description}]\n\n${reminder.payload}\n\nPlease process this reminder and take any appropriate actions. Write a journal entry about what you did.`,
          );
          console.log(`Reminder processed: ${response}`);
        } catch (error) {
          console.error(`Failed to process reminder: ${error}`);
        }

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
        // Handle both 'block' and 'topic' (model sometimes confuses parameters)
        const blockName = (args.block as string) || (args.topic as string);
        const block = this.state.memoryBlocks[blockName];
        if (!block)
          return `Error: Unknown memory block "${blockName}". Available: persona, human, scratchpad`;

        const lines = block.value.split("\n");
        const line = (args.line as number) ?? 0;
        lines.splice(line, 0, args.content as string);
        block.value = lines.join("\n");
        block.lastUpdated = Date.now();

        if (block.value.length > block.limit) {
          return `Warning: Block "${blockName}" exceeds limit (${block.value.length}/${block.limit})`;
        }

        this.saveMemoryBlock(block);
        return `Inserted into "${blockName}" at line ${line}`;
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
        await this.saveJournalEntry(entry);
        return `Journal entry saved: ${entry.topic}`;
      }

      case "journal_search": {
        const query = args.query as string;
        const limit = (args.limit as number) ?? 5;

        // Semantic search using embeddings
        const results = await this.searchJournal(query, limit);

        if (results.length === 0) {
          return "No relevant journal entries found";
        }

        return results
          .map(
            (r) =>
              `[${new Date(r.entry.timestamp).toISOString()}] ${r.entry.topic} (${(r.score * 100).toFixed(0)}% match): ${r.entry.content}`,
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

      case "web_search": {
        const apiKey = this.env.BRAVE_SEARCH_API_KEY;
        if (!apiKey) {
          return "Error: BRAVE_SEARCH_API_KEY not configured";
        }
        const query = args.query as string;
        const count = Math.min((args.count as number) ?? 5, 10);
        try {
          const results = await searchWeb(query, apiKey, { count });
          if (results.length === 0) {
            return `No results found for "${query}"`;
          }
          // Add search result URLs to allowlist for fetch_page
          for (const r of results) {
            this.allowedUrls.add(r.url);
          }
          return results
            .map(
              (r) =>
                `**${r.title}**\n${r.url}\n${r.description}${r.age ? ` (${r.age})` : ""}`,
            )
            .join("\n\n");
        } catch (error) {
          return `Search error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      case "news_search": {
        const apiKey = this.env.BRAVE_SEARCH_API_KEY;
        if (!apiKey) {
          return "Error: BRAVE_SEARCH_API_KEY not configured";
        }
        const query = args.query as string;
        const count = Math.min((args.count as number) ?? 5, 10);
        try {
          const results = await searchNews(query, apiKey, { count });
          if (results.length === 0) {
            return `No news found for "${query}"`;
          }
          // Add search result URLs to allowlist for fetch_page
          for (const r of results) {
            this.allowedUrls.add(r.url);
          }
          return results
            .map(
              (r) =>
                `**${r.title}**\n${r.url}\n${r.description}${r.age ? ` (${r.age})` : ""}`,
            )
            .join("\n\n");
        } catch (error) {
          return `News search error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      case "fetch_page": {
        const url = args.url as string;

        // Security: Only allow URLs from search results or user input
        // This check MUST happen before anything else
        if (!this.allowedUrls.has(url)) {
          return `BLOCKED: URL "${url}" not in allowlist. Allowed URLs: [${[...this.allowedUrls].join(", ")}]`;
        }

        const apiToken = this.env.CF_API_TOKEN;
        const accountId = this.env.CF_ACCOUNT_ID;
        if (!apiToken || !accountId) {
          return "Error: CF_API_TOKEN or CF_ACCOUNT_ID not configured";
        }

        const waitForJs = args.wait_for_js as boolean;
        console.log(
          `[FETCH] Fetching ${url} with account ${accountId}, token ${apiToken.slice(0, 4)}...`,
        );
        try {
          const markdown = await fetchPageAsMarkdown(url, accountId, apiToken, {
            waitUntil: waitForJs ? "networkidle0" : undefined,
          });
          console.log(`[FETCH] Success, got ${markdown.length} chars`);
          if (!markdown) {
            return `No content found at ${url}`;
          }
          // Truncate if too long (keep first 8000 chars to fit in context)
          if (markdown.length > 8000) {
            return markdown.slice(0, 8000) + "\n\n[Content truncated...]";
          }
          return markdown;
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[FETCH] Error: ${errMsg}`);
          return `Fetch error: ${errMsg}`;
        }
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }

  // Build system prompt with memory blocks
  private buildSystemPrompt(): string {
    const now = new Date();
    return `You are Outie, a stateful AI assistant with persistent memory.

Current date/time: ${now.toISOString()} (${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })})

${renderMemoryBlocks(this.state.memoryBlocks)}

## Tools

You MUST use tools to persist information. Your text responses are ephemeral but tool calls persist.

When the user tells you something to remember:
- Use memory_insert with block="human" to store information about the user
- Use memory_insert with block="scratchpad" for working notes
- Use memory_replace to update existing information

When you want to record observations:
- Use journal_write with a topic and content

For scheduling reminders:
- Use schedule_once with an ISO 8601 datetime for one-time reminders
- Use cancel_reminder with the reminder ID to cancel
- Always use the CURRENT year (${now.getFullYear()}) when scheduling

For web search:
- Use web_search to find current information, research topics, or answer questions about recent events
- Use news_search specifically for breaking news or recent developments

For fetching web pages:
- Use fetch_page to read the full content of a webpage (articles, documentation, blog posts)
- Set wait_for_js=true for JavaScript-heavy pages or SPAs
- IMPORTANT: You can ONLY fetch URLs that came from search results or were provided by the user. Do not fabricate URLs.

IMPORTANT: If someone asks you to remember something, you MUST call a memory tool. Do not just acknowledge it in text.

Be direct and helpful.`;
  }

  // Main chat endpoint using Workers AI with tool execution loop
  async chat(userMessage: string): Promise<string> {
    await this.init();

    // Extract URLs from user message and add to allowlist
    const userUrls = this.extractUrls(userMessage);
    for (const url of userUrls) {
      this.allowedUrls.add(url);
      console.log(`[URL ALLOWLIST] Added from user message: ${url}`);
    }
    console.log(
      `[URL ALLOWLIST] Current size: ${this.allowedUrls.size}, URLs: ${[...this.allowedUrls].join(", ")}`,
    );

    // Save user message
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    };
    this.saveMessage(userMsg);
    this.state.conversationHistory.push(userMsg);

    // Tool execution loop - max 5 iterations to prevent infinite loops
    const MAX_TOOL_ITERATIONS = 5;
    const MAX_CONTEXT_MESSAGES = 20; // Limit context to avoid overwhelming the model
    let finalResponse = "";

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      // Build messages for Workers AI (OpenAI format)
      type OpenAIMessage = {
        role: "system" | "user" | "assistant" | "tool";
        content: string | null;
        tool_call_id?: string;
        name?: string;
        tool_calls?: Array<{
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }>;
      };

      // Filter and limit conversation history for context
      // Only filter OLD errors - keep recent ones so model can respond appropriately
      const historyLength = this.state.conversationHistory.length;
      const filteredHistory = this.state.conversationHistory
        .filter((m, idx) => {
          // Keep all non-tool messages
          if (m.role !== "tool") return true;
          // Keep recent messages (last 10) even if errors - model needs to see them
          if (idx >= historyLength - 10) return true;
          // Filter out old tool errors - they poison the context
          if (m.content.startsWith("Error:")) return false;
          return true;
        })
        .slice(-MAX_CONTEXT_MESSAGES);

      const messages: OpenAIMessage[] = [
        { role: "system", content: this.buildSystemPrompt() },
        ...filteredHistory.map((m) => {
          const msg: OpenAIMessage = {
            role: m.role,
            content: m.content || "", // Workers AI requires string, not null
          };
          if (m.tool_calls) {
            msg.tool_calls = m.tool_calls;
          }
          if (m.tool_call_id) {
            msg.tool_call_id = m.tool_call_id;
          }
          if (m.name) {
            msg.name = m.name;
          }
          return msg;
        }),
      ];

      // Call Workers AI with function calling
      // Using Kimi K2 - 1T parameter model with OpenAI-compatible format
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawResponse = await (this.env.AI.run as any)(
        "@cf/moonshotai/kimi-k2-instruct",
        {
          messages,
          tools: [
            ...MEMORY_TOOLS,
            ...SCHEDULING_TOOLS,
            ...WEB_SEARCH_TOOLS,
            ...WEB_FETCH_TOOLS,
          ].map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
          max_tokens: 4096,
        },
      );

      // Debug: log the full response
      console.log("AI Response:", JSON.stringify(rawResponse, null, 2));

      // Normalize response - handle both Workers AI native and OpenAI formats
      let textContent: string | null = null;
      let toolCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown> | string;
      }> = [];

      // OpenAI format (Kimi K2)
      if (
        rawResponse &&
        typeof rawResponse === "object" &&
        "choices" in rawResponse
      ) {
        const choices = (
          rawResponse as {
            choices: Array<{
              message: {
                content: string | null;
                tool_calls?: Array<{
                  id: string;
                  function: { name: string; arguments: string };
                }>;
              };
            }>;
          }
        ).choices;
        if (choices && choices[0]) {
          textContent = choices[0].message.content;
          if (choices[0].message.tool_calls) {
            toolCalls = choices[0].message.tool_calls.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            }));
          }
        }
      }
      // Workers AI native format
      else if (rawResponse && typeof rawResponse === "object") {
        const resp = rawResponse as {
          response?: string;
          tool_calls?: Array<{
            id: string;
            name: string;
            arguments: Record<string, unknown> | string;
          }>;
        };
        textContent = resp.response ?? null;
        toolCalls = resp.tool_calls ?? [];
      }
      // String response
      else if (typeof rawResponse === "string") {
        textContent = rawResponse;
      }

      // Check if the model wants to call tools
      if (toolCalls.length > 0) {
        // First, add the assistant message with tool_calls
        const assistantWithTools: Message = {
          id: crypto.randomUUID(),
          role: "assistant" as const,
          content: textContent ?? "",
          timestamp: Date.now(),
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments:
                typeof tc.arguments === "string"
                  ? tc.arguments
                  : JSON.stringify(tc.arguments),
            },
          })),
        };
        this.state.conversationHistory.push(assistantWithTools);

        // Execute each tool call and add results
        for (const toolCall of toolCalls) {
          const args =
            typeof toolCall.arguments === "string"
              ? JSON.parse(toolCall.arguments)
              : toolCall.arguments;

          console.log(`Tool call: ${toolCall.name}`, args);
          const result = await this.handleToolCall(toolCall.name, args);
          console.log(`Tool result: ${result}`);

          // Add tool result message
          this.state.conversationHistory.push({
            id: crypto.randomUUID(),
            role: "tool" as const,
            content: result,
            timestamp: Date.now(),
            tool_call_id: toolCall.id,
            name: toolCall.name,
          });
        }
        // Continue loop to get next response
        continue;
      }

      // No tool calls - we have the final response
      finalResponse = textContent ?? "I processed your request.";
      break;
    }

    // Save final assistant message
    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: finalResponse,
      timestamp: Date.now(),
    };
    this.saveMessage(assistantMsg);
    this.state.conversationHistory.push(assistantMsg);

    return finalResponse;
  }

  // HTTP fetch handler
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/chat" && request.method === "POST") {
      const body = (await request.json()) as { message: string };
      const response = await this.chat(body.message);
      return Response.json({ response });
    }

    if (url.pathname === "/memory" && request.method === "GET") {
      await this.init();
      return Response.json(this.state.memoryBlocks);
    }

    if (url.pathname === "/reminders" && request.method === "GET") {
      await this.init();
      return Response.json(this.state.reminders);
    }

    if (url.pathname === "/reset" && request.method === "POST") {
      await this.init();
      // Clear conversation history from SQLite and memory
      this.ctx.storage.sql.exec("DELETE FROM messages");
      this.state.conversationHistory = [];
      this.allowedUrls.clear();
      return Response.json({
        success: true,
        message: "Conversation history cleared",
      });
    }

    if (url.pathname === "/debug" && request.method === "GET") {
      await this.init();
      return Response.json({
        allowedUrls: [...this.allowedUrls],
        historyLength: this.state.conversationHistory.length,
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

    if (url.pathname === "/reset" && request.method === "POST") {
      await this.init();
      // Clear conversation history from SQLite and memory
      this.ctx.storage.sql.exec("DELETE FROM messages");
      this.state.conversationHistory = [];
      this.allowedUrls.clear();
      return new Response(
        JSON.stringify({
          success: true,
          message: "Conversation history cleared",
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response("Not Found", { status: 404 });
  }
}
