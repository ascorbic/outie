import { DurableObject } from "cloudflare:workers";
import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type {
  Env,
  OutieState,
  MemoryBlock,
  JournalEntry,
  Reminder,
  Message,
  ConversationSummary,
} from "./types";
import { DEFAULT_MEMORY_BLOCKS, renderMemoryBlocks } from "./memory";
import { getNextCronTime } from "./scheduling";
import { searchWeb, searchNews } from "./web-search";
import { fetchPageAsMarkdown } from "./web-fetch";
import { createTools } from "./tools";

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
      
      CREATE TABLE IF NOT EXISTS conversation_summary (
        id TEXT PRIMARY KEY,
        timestamp INTEGER,
        content TEXT,
        from_timestamp INTEGER,
        to_timestamp INTEGER,
        message_count INTEGER
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
      for (const [, block] of Object.entries(DEFAULT_MEMORY_BLOCKS)) {
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

    // Load conversation summary if exists
    const summaries = this.ctx.storage.sql
      .exec<{
        id: string;
        timestamp: number;
        content: string;
        from_timestamp: number;
        to_timestamp: number;
        message_count: number;
      }>("SELECT * FROM conversation_summary ORDER BY timestamp DESC LIMIT 1")
      .toArray();

    if (summaries.length > 0) {
      const s = summaries[0];
      this.state.conversationSummary = {
        id: s.id,
        timestamp: s.timestamp,
        content: s.content,
        fromTimestamp: s.from_timestamp,
        toTimestamp: s.to_timestamp,
        messageCount: s.message_count,
      };
    }

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
  private async searchJournalEntries(
    query: string,
    limit: number = 5,
  ): Promise<Array<{ entry: JournalEntry; score: number }>> {
    const queryEmbedding = await this.getEmbedding(query);

    const entries = this.ctx.storage.sql
      .exec<{
        id: string;
        timestamp: number;
        topic: string;
        content: string;
        embedding: string | null;
      }>("SELECT * FROM journal WHERE embedding IS NOT NULL")
      .toArray();

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
      .filter((r) => r.score > 0.3)
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

  // Summarize old messages when history exceeds threshold
  private async summarizeIfNeeded(): Promise<void> {
    const SUMMARIZE_THRESHOLD = 50;
    const SUMMARIZE_RATIO = 0.7;

    const history = this.state.conversationHistory;
    if (history.length < SUMMARIZE_THRESHOLD) return;

    const numToSummarize = Math.floor(history.length * SUMMARIZE_RATIO);
    const toSummarize = history.slice(0, numToSummarize);
    const toKeep = history.slice(numToSummarize);

    const conversationText = toSummarize
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n");

    const previousSummary = this.state.conversationSummary
      ? `Previous summary:\n${this.state.conversationSummary.content}\n\n`
      : "";

    console.log(
      `[SUMMARIZE] Summarizing ${numToSummarize} messages (keeping ${toKeep.length})`,
    );

    const workersai = createWorkersAI({ binding: this.env.AI });

    const { text: summaryText } = await generateText({
      // @ts-expect-error - model name is valid but not in provider types
      model: workersai("@cf/meta/llama-3.1-8b-instruct"),
      system: `You are a summarization assistant. Summarize the following conversation concisely, preserving:
1. Key facts and decisions made
2. Important context about the user
3. Any commitments or follow-ups mentioned
4. The overall flow of topics discussed

Keep the summary under 500 words. Focus on what would be important to know if continuing this conversation later.`,
      prompt: `${previousSummary}Conversation to summarize:\n\n${conversationText}`,
    });

    if (!summaryText) {
      console.error("[SUMMARIZE] Failed to generate summary");
      return;
    }

    const summary: ConversationSummary = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      content: summaryText,
      fromTimestamp: toSummarize[0]?.timestamp ?? Date.now(),
      toTimestamp: toSummarize[toSummarize.length - 1]?.timestamp ?? Date.now(),
      messageCount:
        (this.state.conversationSummary?.messageCount ?? 0) + numToSummarize,
    };

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO conversation_summary 
       (id, timestamp, content, from_timestamp, to_timestamp, message_count) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      summary.id,
      summary.timestamp,
      summary.content,
      summary.fromTimestamp,
      summary.toTimestamp,
      summary.messageCount,
    );

    // Delete summarized messages from SQLite
    for (const msg of toSummarize) {
      this.ctx.storage.sql.exec("DELETE FROM messages WHERE id = ?", msg.id);
    }

    this.state.conversationSummary = summary;
    this.state.conversationHistory = toKeep;

    console.log(
      `[SUMMARIZE] Created summary (${summaryText.length} chars), total messages summarized: ${summary.messageCount}`,
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

      if (reminder.scheduledTime && time < now - 3600000) {
        console.log(`Deleting expired reminder: ${reminder.id}`);
        this.deleteReminder(reminder.id);
        continue;
      }

      if (Math.abs(time - now) < 60000) {
        console.log(
          `Firing reminder: ${reminder.id} - ${reminder.description}`,
        );

        try {
          const response = await this.chat(
            `[REMINDER TRIGGERED: ${reminder.description}]\n\n${reminder.payload}\n\nPlease process this reminder and take any appropriate actions. Write a journal entry about what you did.`,
          );
          console.log(`Reminder processed: ${response}`);
        } catch (error) {
          console.error(`Failed to process reminder: ${error}`);
        }

        if (reminder.scheduledTime) {
          this.deleteReminder(reminder.id);
        }
      }
    }

    await this.scheduleNextAlarm();
  }

  // ==========================================
  // Tool handler methods (called by tools.ts)
  // ==========================================

  memoryInsert(block: string, content: string, line: number): string {
    const memBlock = this.state.memoryBlocks[block];
    if (!memBlock) {
      return `Error: Unknown memory block "${block}". Available: persona, human, scratchpad`;
    }

    const lines = memBlock.value.split("\n");
    lines.splice(line, 0, content);
    memBlock.value = lines.join("\n");
    memBlock.lastUpdated = Date.now();

    if (memBlock.value.length > memBlock.limit) {
      this.saveMemoryBlock(memBlock);
      return `Warning: Block "${block}" exceeds limit (${memBlock.value.length}/${memBlock.limit})`;
    }

    this.saveMemoryBlock(memBlock);
    return `Inserted into "${block}" at line ${line}`;
  }

  memoryReplace(block: string, oldStr: string, newStr: string): string {
    const memBlock = this.state.memoryBlocks[block];
    if (!memBlock) {
      return `Error: Unknown memory block "${block}"`;
    }

    if (!memBlock.value.includes(oldStr)) {
      return `Error: "${oldStr}" not found in block "${block}"`;
    }

    memBlock.value = memBlock.value.replace(oldStr, newStr);
    memBlock.lastUpdated = Date.now();
    this.saveMemoryBlock(memBlock);
    return `Replaced in "${block}"`;
  }

  async journalWrite(topic: string, content: string): Promise<string> {
    const entry: JournalEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      topic,
      content,
    };
    await this.saveJournalEntry(entry);
    return `Journal entry saved: ${topic}`;
  }

  async journalSearch(query: string, limit: number): Promise<string> {
    const results = await this.searchJournalEntries(query, limit);

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

  async scheduleReminder(
    id: string,
    description: string,
    payload: string,
    cron: string,
  ): Promise<string> {
    const reminder: Reminder = {
      id,
      description,
      payload,
      cronExpression: cron,
    };
    this.state.reminders[id] = reminder;
    this.saveReminder(reminder);
    await this.scheduleNextAlarm();
    return `Scheduled reminder "${id}": ${description}`;
  }

  async scheduleOnce(
    id: string,
    description: string,
    payload: string,
    datetime: string,
  ): Promise<string> {
    const scheduledTime = new Date(datetime).getTime();
    const reminder: Reminder = {
      id,
      description,
      payload,
      scheduledTime,
    };
    this.state.reminders[id] = reminder;
    this.saveReminder(reminder);
    await this.scheduleNextAlarm();
    return `Scheduled one-time reminder "${id}" for ${datetime}`;
  }

  cancelReminder(id: string): string {
    if (!this.state.reminders[id]) {
      return `Error: Reminder "${id}" not found`;
    }
    this.deleteReminder(id);
    return `Cancelled reminder "${id}"`;
  }

  listReminders(): string {
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

  async webSearch(query: string, count: number): Promise<string> {
    const apiKey = this.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      return "Error: BRAVE_SEARCH_API_KEY not configured";
    }

    try {
      const results = await searchWeb(query, apiKey, {
        count: Math.min(count, 10),
      });
      if (results.length === 0) {
        return `No results found for "${query}"`;
      }

      // Add URLs to allowlist
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

  async newsSearch(query: string, count: number): Promise<string> {
    const apiKey = this.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      return "Error: BRAVE_SEARCH_API_KEY not configured";
    }

    try {
      const results = await searchNews(query, apiKey, {
        count: Math.min(count, 10),
      });
      if (results.length === 0) {
        return `No news found for "${query}"`;
      }

      // Add URLs to allowlist
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

  async fetchPage(url: string, waitForJs: boolean): Promise<string> {
    // Security: Only allow URLs from search results or user input
    if (!this.allowedUrls.has(url)) {
      return `BLOCKED: URL "${url}" not in allowlist. URLs must come from search results or user messages.`;
    }

    const apiToken = this.env.CF_API_TOKEN;
    const accountId = this.env.CF_ACCOUNT_ID;
    if (!apiToken || !accountId) {
      return "Error: CF_API_TOKEN or CF_ACCOUNT_ID not configured";
    }

    try {
      const markdown = await fetchPageAsMarkdown(url, accountId, apiToken, {
        waitUntil: waitForJs ? "networkidle0" : undefined,
      });

      if (!markdown) {
        return `No content found at ${url}`;
      }

      // Truncate if too long
      if (markdown.length > 8000) {
        return markdown.slice(0, 8000) + "\n\n[Content truncated...]";
      }
      return markdown;
    } catch (error) {
      return `Fetch error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // Build system prompt with memory blocks
  private buildSystemPrompt(): string {
    const now = new Date();
    const summarySection = this.state.conversationSummary
      ? `## Conversation Summary
The following summarizes ${this.state.conversationSummary.messageCount} earlier messages:

${this.state.conversationSummary.content}

---

`
      : "";

    return `You are Outie, a stateful AI assistant with persistent memory.

Current date/time: ${now.toISOString()} (${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })})

${summarySection}${renderMemoryBlocks(this.state.memoryBlocks)}

## Tools

You have tools to persist information. Your text responses are ephemeral but tool calls persist.

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
- Use web_search to find current information
- Use news_search for breaking news or recent developments

For fetching web pages:
- Use fetch_page to read webpage content
- IMPORTANT: You can ONLY fetch URLs from search results or user messages

IMPORTANT: If someone asks you to remember something, you MUST call a memory tool.

Be direct and helpful.`;
  }

  // Main chat endpoint using Vercel AI SDK
  async chat(userMessage: string): Promise<string> {
    await this.init();

    // Extract URLs from user message and add to allowlist
    const userUrls = this.extractUrls(userMessage);
    for (const url of userUrls) {
      this.allowedUrls.add(url);
    }

    // Save user message
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    };
    this.saveMessage(userMsg);
    this.state.conversationHistory.push(userMsg);

    // Build messages for AI
    const MAX_CONTEXT_MESSAGES = 20;
    const filteredHistory =
      this.state.conversationHistory.slice(-MAX_CONTEXT_MESSAGES);

    const messages = filteredHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    // Create Workers AI provider and tools
    const workersai = createWorkersAI({ binding: this.env.AI });
    const tools = createTools(this);

    console.log(
      `[CHAT] Starting generateText with ${messages.length} messages`,
    );

    // Use Vercel AI SDK generateText with automatic tool execution
    const { text, steps } = await generateText({
      // @ts-expect-error - model name is valid but not in provider types
      model: workersai("@cf/moonshotai/kimi-k2-instruct"),
      system: this.buildSystemPrompt(),
      messages,
      tools,
      stopWhen: stepCountIs(10), // Allow up to 10 tool call steps
    });

    // Log tool usage
    for (const step of steps) {
      if (step.toolCalls && step.toolCalls.length > 0) {
        for (const tc of step.toolCalls) {
          console.log(`[TOOL] ${tc.toolName}:`, tc.input);
        }
      }
    }

    const finalResponse = text || "I processed your request.";

    // Save assistant message
    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: finalResponse,
      timestamp: Date.now(),
    };
    this.saveMessage(assistantMsg);
    this.state.conversationHistory.push(assistantMsg);

    // Check if we need to summarize
    await this.summarizeIfNeeded();

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
      this.ctx.storage.sql.exec("DELETE FROM messages");
      this.ctx.storage.sql.exec("DELETE FROM conversation_summary");
      this.state.conversationHistory = [];
      this.state.conversationSummary = undefined;
      this.allowedUrls.clear();
      return Response.json({
        success: true,
        message: "Conversation history and summary cleared",
      });
    }

    if (url.pathname === "/debug" && request.method === "GET") {
      await this.init();
      return Response.json({
        allowedUrls: [...this.allowedUrls],
        historyLength: this.state.conversationHistory.length,
        hasSummary: !!this.state.conversationSummary,
        summaryMessageCount: this.state.conversationSummary?.messageCount ?? 0,
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}
