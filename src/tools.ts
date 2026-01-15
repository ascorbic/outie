import { tool } from "ai";
import { z } from "zod";

// Interface for tool context - matches Outie's tool handler methods
export interface ToolContext {
  getEnv(): Env;
  memoryInsert(block: string, content: string, line: number): string;
  memoryReplace(block: string, oldStr: string, newStr: string): string;
  journalWrite(topic: string, content: string): Promise<string>;
  journalSearch(query: string, limit: number): Promise<string>;
  scheduleReminder(id: string, description: string, payload: string, cron: string): Promise<string>;
  scheduleOnce(id: string, description: string, payload: string, datetime: string): Promise<string>;
  cancelReminder(id: string): string;
  listReminders(): string;
  sendTelegram(message: string, chatId?: string): Promise<string>;
  webSearch(query: string, count: number): Promise<string>;
  newsSearch(query: string, count: number): Promise<string>;
  fetchPage(url: string, waitForJs: boolean): Promise<string>;
  runManagedCodingTask(repoUrl: string, task: string): Promise<{ response: string; branch: string }>;
}

// Tool factory that creates tools with access to the agent instance
export function createTools(agent: ToolContext) {
  return {
    // Memory tools
    memory_insert: tool({
      description:
        "Insert text at a specific line in a memory block. Use this to add new information.",
      inputSchema: z.object({
        block: z
          .enum(["persona", "human", "scratchpad"])
          .describe("Which memory block to edit"),
        content: z.string().describe("Text to insert"),
        line: z
          .number()
          .optional()
          .default(0)
          .describe("Line number to insert at (0 for beginning)"),
      }),
      execute: async ({ block, content, line }) => {
        return agent.memoryInsert(block, content, line);
      },
    }),

    memory_replace: tool({
      description:
        "Replace a specific string in a memory block with a new string. Use for precise edits.",
      inputSchema: z.object({
        block: z
          .enum(["persona", "human", "scratchpad"])
          .describe("Which memory block to edit"),
        old_str: z.string().describe("Exact text to find and replace"),
        new_str: z.string().describe("Replacement text"),
      }),
      execute: async ({ block, old_str, new_str }) => {
        return agent.memoryReplace(block, old_str, new_str);
      },
    }),

    // Journal tools
    journal_write: tool({
      description:
        "Write an observation or thought to your journal for long-term memory.",
      inputSchema: z.object({
        topic: z.string().describe("Short topic/category for the entry"),
        content: z.string().describe("The journal entry content"),
      }),
      execute: async ({ topic, content }) => {
        return agent.journalWrite(topic, content);
      },
    }),

    journal_search: tool({
      description:
        "Search your journal for past observations using semantic search.",
      inputSchema: z.object({
        query: z.string().describe("What to search for"),
        limit: z
          .number()
          .optional()
          .default(5)
          .describe("Maximum results to return"),
      }),
      execute: async ({ query, limit }) => {
        return agent.journalSearch(query, limit);
      },
    }),

    // Scheduling tools
    schedule_reminder: tool({
      description:
        "Schedule a recurring reminder using cron syntax (e.g., '0 9 * * *' for 9am daily).",
      inputSchema: z.object({
        id: z.string().describe("Unique identifier for this reminder"),
        description: z.string().describe("What this reminder is for"),
        payload: z.string().describe("Message to process when reminder fires"),
        cron: z.string().describe("Cron expression for the schedule"),
      }),
      execute: async ({ id, description, payload, cron }) => {
        return agent.scheduleReminder(id, description, payload, cron);
      },
    }),

    schedule_once: tool({
      description: "Schedule a one-time reminder at a specific date/time.",
      inputSchema: z.object({
        id: z.string().describe("Unique identifier for this reminder"),
        description: z.string().describe("What this reminder is for"),
        payload: z.string().describe("Message to process when reminder fires"),
        datetime: z
          .string()
          .describe("ISO 8601 datetime (e.g., '2026-01-15T10:00:00')"),
      }),
      execute: async ({ id, description, payload, datetime }) => {
        return agent.scheduleOnce(id, description, payload, datetime);
      },
    }),

    cancel_reminder: tool({
      description: "Cancel a scheduled reminder by its ID.",
      inputSchema: z.object({
        id: z.string().describe("ID of the reminder to cancel"),
      }),
      execute: async ({ id }) => {
        return agent.cancelReminder(id);
      },
    }),

    list_reminders: tool({
      description: "List all scheduled reminders.",
      inputSchema: z.object({}),
      execute: async () => {
        return agent.listReminders();
      },
    }),

    // Web tools
    web_search: tool({
      description: "Search the web for current information using Brave Search.",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        count: z
          .number()
          .optional()
          .default(5)
          .describe("Number of results (max 10)"),
      }),
      execute: async ({ query, count }) => {
        return agent.webSearch(query, count);
      },
    }),

    news_search: tool({
      description: "Search for recent news articles using Brave Search.",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        count: z
          .number()
          .optional()
          .default(5)
          .describe("Number of results (max 10)"),
      }),
      execute: async ({ query, count }) => {
        return agent.newsSearch(query, count);
      },
    }),

    fetch_page: tool({
      description:
        "Fetch and read a webpage as markdown. Only works for URLs from search results or user messages.",
      inputSchema: z.object({
        url: z.string().url().describe("URL to fetch"),
        wait_for_js: z
          .boolean()
          .optional()
          .default(false)
          .describe("Wait for JavaScript to execute (for SPAs)"),
      }),
      execute: async ({ url, wait_for_js }) => {
        return agent.fetchPage(url, wait_for_js);
      },
    }),

    // Telegram tool
    send_telegram: tool({
      description:
        "Send a message to Telegram. Use this to notify the user or send information to their Telegram chat.",
      inputSchema: z.object({
        message: z.string().describe("The message to send"),
        chat_id: z
          .string()
          .optional()
          .describe("Optional: specific chat ID (defaults to owner's chat)"),
      }),
      execute: async ({ message, chat_id }) => {
        return agent.sendTelegram(message, chat_id);
      },
    }),

    // Coding task tool - delegates to OpenCode in a sandbox
    // Uses runManagedCodingTask for state management (branch, session continuation)
    run_coding_task: tool({
      description:
        `Delegate a task to OpenCode running in a secure sandbox. Use for implementing features, fixing bugs, refactoring code, exploring or making changes to a git repository. OpenCode is an advanced coding agent that can perform complex tasks on a repo when given instructions. Changes are automatically committed and pushed to a feature branch.`,
      inputSchema: z.object({
        repo_url: z
          .string()
          .describe("Git repository URL to clone (e.g., https://github.com/user/repo)"),
        task: z
          .string()
          .describe("Detailed description of what to implement, fix, or change"),
      }),
      execute: async ({ repo_url, task }) => {
        try {
          console.log("[TOOL] Running managed coding task");
          const result = await agent.runManagedCodingTask(repo_url, task);

          console.log("[TOOL] Coding task completed on branch:", result.branch);

          return `## Response\n${result.response}\n\n**Branch:** \`${result.branch}\``;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return `Error running coding task: ${message}`;
        }
      },
    }),
  };
}

export type OutieTools = ReturnType<typeof createTools>;
