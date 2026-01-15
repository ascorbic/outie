/**
 * Outie - Stateful AI Assistant Durable Object
 */

import { DurableObject } from "cloudflare:workers";
import type {
  OutieState,
  MemoryBlock,
  JournalEntry,
  Reminder,
  Message,
} from "../types";
import { DEFAULT_MEMORY_BLOCKS } from "../memory";
import { getNextCronTime } from "../scheduling";
import { searchWeb, searchNews } from "../web-search";
import { fetchPageAsMarkdown } from "../web-fetch";
import { notifyOwner, sendMessage } from "../telegram";

// Module imports
import { createLogger } from "./logger";
import { MAX_PAGE_CONTENT_LENGTH, MAX_SEARCH_RESULTS } from "./config";
import {
  initSchema,
  loadState,
  saveMemoryBlock,
  saveJournalEntry,
  saveReminder,
  deleteReminder as deleteReminderFromDb,
  saveMessage,
  clearConversation,
} from "./state";
import { getEmbedding, searchJournal } from "./embeddings";
import { extractUrls, runChat } from "./chat";
import { summarizeIfNeeded } from "./summarization";
import { runManagedCodingTask } from "./coding";

const log = createLogger("OUTIE");

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

  // Initialize state from SQLite
  private async init(): Promise<void> {
    if (this.initialized) return;

    initSchema(this.ctx.storage.sql);
    const loadedState = loadState(this.ctx.storage.sql);
    
    this.state = loadedState;

    // If no blocks were loaded, initialize with defaults
    const hasBlocks = Object.keys(loadedState.memoryBlocks).some(
      key => loadedState.memoryBlocks[key].value !== DEFAULT_MEMORY_BLOCKS[key]?.value
    );
    if (!hasBlocks) {
      for (const [, block] of Object.entries(DEFAULT_MEMORY_BLOCKS)) {
        saveMemoryBlock(this.ctx.storage.sql, block);
      }
    }

    this.initialized = true;
  }

  // Schedule next alarm for reminders
  private async scheduleNextAlarm(): Promise<void> {
    const reminders = Object.values(this.state.reminders);
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
    }
  }

  // Helper to delete reminder
  private deleteReminder(id: string): void {
    deleteReminderFromDb(this.ctx.storage.sql, id);
    delete this.state.reminders[id];
  }

  // DO alarm handler
  async alarm(): Promise<void> {
    await this.init();
    const now = Date.now();

    for (const reminder of Object.values(this.state.reminders)) {
      const time = reminder.scheduledTime ?? 
        (reminder.cronExpression ? getNextCronTime(reminder.cronExpression) : Infinity);

      // Delete expired one-time reminders (more than 1 hour old)
      if (reminder.scheduledTime && time < now - 3600000) {
        log.info(`Deleting expired reminder: ${reminder.id}`);
        this.deleteReminder(reminder.id);
        continue;
      }

      // Fire reminder if within 1 minute of scheduled time
      if (Math.abs(time - now) < 60000) {
        log.info(`Firing reminder: ${reminder.id} - ${reminder.description}`);

        try {
          const response = await this.chat(
            `[REMINDER TRIGGERED: ${reminder.description}]\n\n${reminder.payload}\n\nPlease process this reminder and take any appropriate actions. Write a journal entry about what you did.`,
          );
          log.info(`Reminder processed: ${response}`);

          // Send notification via Telegram
          await notifyOwner(
            this.env,
            `🔔 *Reminder*: ${reminder.description}\n\n${response}`,
          );
        } catch (error) {
          log.error(`Failed to process reminder`, error);
          // Notify about failure
          await notifyOwner(
            this.env,
            `⚠️ *Reminder failed*: ${reminder.description}\n\nError: ${error}`,
          );
        }

        // Delete one-time reminders after firing
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
      saveMemoryBlock(this.ctx.storage.sql, memBlock);
      return `Warning: Block "${block}" exceeds limit (${memBlock.value.length}/${memBlock.limit})`;
    }

    saveMemoryBlock(this.ctx.storage.sql, memBlock);
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
    saveMemoryBlock(this.ctx.storage.sql, memBlock);
    return `Replaced in "${block}"`;
  }

  async journalWrite(topic: string, content: string): Promise<string> {
    const entry: JournalEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      topic,
      content,
    };
    const embedding = await getEmbedding(this.env.AI, `${entry.topic}: ${entry.content}`);
    saveJournalEntry(this.ctx.storage.sql, entry, embedding);
    return `Journal entry saved: ${topic}`;
  }

  async journalSearch(query: string, limit: number): Promise<string> {
    const results = await searchJournal(this.env.AI, this.ctx.storage.sql, query, limit);

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
    saveReminder(this.ctx.storage.sql, reminder);
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
    saveReminder(this.ctx.storage.sql, reminder);
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
        const schedule = r.cronExpression ?? 
          (r.scheduledTime ? new Date(r.scheduledTime).toISOString() : "unknown");
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
        count: Math.min(count, MAX_SEARCH_RESULTS),
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
        count: Math.min(count, MAX_SEARCH_RESULTS),
      });
      log.info(`Got ${results.length} news results for "${query}"`);
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
      if (markdown.length > MAX_PAGE_CONTENT_LENGTH) {
        return markdown.slice(0, MAX_PAGE_CONTENT_LENGTH) + "\n\n[Content truncated...]";
      }
      return markdown;
    } catch (error) {
      return `Fetch error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // ==========================================
  // Managed Coding Task Orchestration
  // ==========================================

  async runManagedCodingTask(
    repoUrl: string,
    task: string,
  ): Promise<{ response: string; branch: string }> {
    await this.init();
    return runManagedCodingTask(
      {
        env: this.env,
        sql: this.ctx.storage.sql,
        sandboxBinding: this.env.SANDBOX,
      },
      repoUrl,
      task,
    );
  }

  // Main chat endpoint
  async chat(userMessage: string): Promise<string> {
    await this.init();

    // Extract URLs from user message and add to allowlist
    const userUrls = extractUrls(userMessage);
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
    saveMessage(this.ctx.storage.sql, userMsg);
    this.state.conversationHistory.push(userMsg);

    // Run chat with AI
    const result = await runChat({
      env: this.env,
      conversationHistory: this.state.conversationHistory,
      memoryBlocks: this.state.memoryBlocks,
      conversationSummary: this.state.conversationSummary,
      toolContext: this,
    });

    // Save assistant message
    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: result.response,
      timestamp: Date.now(),
    };
    saveMessage(this.ctx.storage.sql, assistantMsg);
    this.state.conversationHistory.push(assistantMsg);

    // Check if we need to summarize
    const summarization = await summarizeIfNeeded({
      env: this.env,
      sql: this.ctx.storage.sql,
      conversationHistory: this.state.conversationHistory,
      conversationSummary: this.state.conversationSummary,
    });
    
    if (summarization) {
      this.state.conversationSummary = summarization.summary;
      this.state.conversationHistory = summarization.remainingHistory;
    }

    return result.response;
  }

  // ==========================================
  // RPC methods (called directly from worker)
  // ==========================================

  async getMemoryBlocks(): Promise<Record<string, MemoryBlock>> {
    await this.init();
    return this.state.memoryBlocks;
  }

  async getReminders(): Promise<Record<string, Reminder>> {
    await this.init();
    return this.state.reminders;
  }

  async resetConversation(): Promise<{ success: boolean; message: string }> {
    await this.init();
    clearConversation(this.ctx.storage.sql);
    this.state.conversationHistory = [];
    this.state.conversationSummary = undefined;
    this.allowedUrls.clear();
    return {
      success: true,
      message: "Conversation history and summary cleared",
    };
  }
}
