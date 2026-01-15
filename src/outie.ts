import { DurableObject } from "cloudflare:workers";
import { generateText, stepCountIs } from "ai";
import type {
  Env,
  OutieState,
  MemoryBlock,
  JournalEntry,
  Reminder,
  Message,
  ConversationSummary,
  ModelTier,
  CodingTaskState,
  CodingTaskDecision,
} from "./types";
import { DEFAULT_MEMORY_BLOCKS, renderMemoryBlocks } from "./memory";
import { getNextCronTime } from "./scheduling";
import { searchWeb, searchNews } from "./web-search";
import { fetchPageAsMarkdown } from "./web-fetch";
import { createTools } from "./tools";
import { createModelProvider, createSummarizationModel } from "./models";
import { notifyOwner, sendMessage } from "./telegram";
import { runCodingTask } from "./sandbox";

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

  // Expose env for tools that need bindings (e.g., sandbox)
  getEnv(): Env {
    return this.env;
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
      
      CREATE TABLE IF NOT EXISTS coding_task_state (
        repo_url TEXT PRIMARY KEY,
        branch TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_task TEXT NOT NULL,
        last_timestamp INTEGER NOT NULL
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

    const { text: summaryText } = await generateText({
      model: createSummarizationModel(this.env),
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

          // Send notification via Telegram
          await notifyOwner(
            this.env,
            `🔔 *Reminder*: ${reminder.description}\n\n${response}`,
          );
        } catch (error) {
          console.error(`Failed to process reminder: ${error}`);
          // Notify about failure
          await notifyOwner(
            this.env,
            `⚠️ *Reminder failed*: ${reminder.description}\n\nError: ${error}`,
          );
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

  async sendTelegram(message: string, chatId?: string): Promise<string> {
    const targetChatId = chatId ?? this.env.TELEGRAM_CHAT_ID;
    if (!targetChatId) {
      return "Error: No chat ID provided and TELEGRAM_CHAT_ID not configured";
    }

    const success = await sendMessage(this.env, targetChatId, message);
    if (success) {
      return `Message sent to Telegram chat ${targetChatId}`;
    }
    return "Failed to send Telegram message";
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
      console.log(`[NEWS] Got ${results.length} results for "${query}"`);
      if (results.length === 0) {
        return `No news articles found for "${query}". Try a more specific topic like "technology" or "AI" instead of generic terms like "headlines". You can also use web_search with a news-related query.`;
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

  // ==========================================
  // Coding Task State Management
  // ==========================================

  // Get coding task state for a repo
  getCodingTaskState(repoUrl: string): CodingTaskState | null {
    const rows = this.ctx.storage.sql
      .exec<{
        repo_url: string;
        branch: string;
        session_id: string;
        last_task: string;
        last_timestamp: number;
      }>("SELECT * FROM coding_task_state WHERE repo_url = ?", repoUrl)
      .toArray();

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      repoUrl: row.repo_url,
      branch: row.branch,
      sessionId: row.session_id,
      lastTask: row.last_task,
      lastTimestamp: row.last_timestamp,
    };
  }

  // Save coding task state
  saveCodingTaskState(state: CodingTaskState): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO coding_task_state 
       (repo_url, branch, session_id, last_task, last_timestamp)
       VALUES (?, ?, ?, ?, ?)`,
      state.repoUrl,
      state.branch,
      state.sessionId,
      state.lastTask,
      state.lastTimestamp,
    );
  }

  // Decide whether to continue or start new coding task
  async decideCodingTaskAction(
    repoUrl: string,
    task: string,
    previousState: CodingTaskState | null,
  ): Promise<CodingTaskDecision> {
    // If no previous state, always create new
    if (!previousState) {
      const branch = await this.generateBranchName(task);
      return { action: "new", branch };
    }

    // Check how old the previous task is
    const ageMs = Date.now() - previousState.lastTimestamp;
    const ageHours = ageMs / (1000 * 60 * 60);

    // If more than 24 hours old, start fresh
    if (ageHours > 24) {
      const branch = await this.generateBranchName(task);
      return { action: "new", branch };
    }

    // Ask the model to decide
    const prompt = `You're managing coding tasks in a repository.

Previous task (${this.formatTimeAgo(ageMs)} ago):
Branch: ${previousState.branch}
Task: ${previousState.lastTask}

New task: ${task}

Is the new task a CONTINUATION of the previous work (same feature/bug/topic), or is it NEW unrelated work?

Reply with ONLY valid JSON, no other text:
- If continuing: {"action": "continue"}
- If new work: {"action": "new", "branch": "innie/descriptive-slug"}

Branch names should be lowercase, use hyphens, and describe the work (e.g., "innie/add-error-handling", "innie/fix-auth-bug").`;

    try {
      const { text } = await generateText({
        model: createModelProvider(this.env, "fast"),
        prompt,
      });

      // Parse the JSON response
      const jsonMatch = text.match(/\{[^}]+\}/);
      if (jsonMatch) {
        const decision = JSON.parse(jsonMatch[0]) as CodingTaskDecision;
        if (decision.action === "continue" || (decision.action === "new" && decision.branch)) {
          return decision;
        }
      }
    } catch (error) {
      console.error("[CODING_TASK] Failed to parse decision:", error);
    }

    // Fallback: generate new branch
    const branch = await this.generateBranchName(task);
    return { action: "new", branch };
  }

  // Generate a branch name from task description
  private async generateBranchName(task: string): Promise<string> {
    try {
      const { text } = await generateText({
        model: createModelProvider(this.env, "fast"),
        prompt: `Generate a git branch name for this task. Use the format "innie/descriptive-slug".
Rules:
- Lowercase only
- Use hyphens between words
- Max 50 characters total
- Be descriptive but concise

Task: ${task}

Reply with ONLY the branch name, nothing else.`,
      });

      const branch = text.trim().toLowerCase().replace(/[^a-z0-9\-\/]/g, "-");
      if (branch.startsWith("innie/") && branch.length <= 50) {
        return branch;
      }
    } catch (error) {
      console.error("[CODING_TASK] Failed to generate branch name:", error);
    }

    // Fallback: generate from task
    const slug = task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 30)
      .replace(/-+$/, "");
    return `innie/${slug}`;
  }

  // Format time ago for display
  private formatTimeAgo(ms: number): string {
    const minutes = Math.floor(ms / (1000 * 60));
    if (minutes < 60) return `${minutes} minutes`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hours`;
    const days = Math.floor(hours / 24);
    return `${days} days`;
  }

  // ==========================================
  // Managed Coding Task Orchestration
  // ==========================================

  // Run a coding task with full state management
  // This is the main entry point for both the tool and /code endpoint
  async runManagedCodingTask(
    repoUrl: string,
    task: string,
  ): Promise<{ response: string; diff: string; branch: string }> {
    await this.init();

    console.log(`[CODING_TASK] Starting managed task for ${repoUrl}`);

    // 1. Get existing state for this repo
    const previousState = this.getCodingTaskState(repoUrl);
    if (previousState) {
      console.log(`[CODING_TASK] Found previous state: branch=${previousState.branch}, session=${previousState.sessionId}`);
    }

    // 2. Decide whether to continue or start fresh
    const decision = await this.decideCodingTaskAction(repoUrl, task, previousState);
    console.log(`[CODING_TASK] Decision: ${decision.action}${decision.branch ? `, branch=${decision.branch}` : ""}`);

    // 3. Run the task in sandbox
    const result = await runCodingTask(this.env.SANDBOX, {
      repoUrl,
      task,
      previousState: previousState ?? undefined,
      decision,
      // GITHUB_TOKEN needs to be added to wrangler.jsonc secrets
      githubToken: (this.env as unknown as Record<string, string>).GITHUB_TOKEN,
    });

    // 4. Save updated state
    this.saveCodingTaskState(result.state);
    console.log(`[CODING_TASK] Saved state: branch=${result.state.branch}, session=${result.state.sessionId}`);

    return {
      response: result.response,
      diff: result.diff,
      branch: result.state.branch,
    };
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

For coding tasks:
- Use run_coding_task to delegate code changes to OpenCode in a sandbox
- Provide a git repository URL and a clear description of what to implement/fix
- OpenCode will clone the repo, make changes, and return a diff
- Use this for implementing features, fixing bugs, or refactoring code

For Telegram:
- Use send_telegram to send messages to the user's Telegram chat
- Useful for notifications, alerts, or sending information the user wants to receive on mobile

IMPORTANT: If someone asks you to remember something, you MUST call a memory tool.

## Response style
- Be direct and concise - this is a chat interface
- If a task will take more than a few seconds (web search, fetching pages, coding tasks), first send a brief acknowledgement like "Searching..." or "Let me look that up" before proceeding
- Keep responses short for simple questions, longer only when needed`;
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

    // Create model and tools
    const tools = createTools(this);

    console.log(
      `[CHAT] Starting generateText with ${messages.length} messages`,
    );

    // Use Vercel AI SDK generateText with automatic tool execution
    const { text, steps } = await generateText({
      model: createModelProvider(this.env, "fast"),
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
