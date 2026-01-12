import { tool } from "ai";
import { z } from "zod";
import type { Outie } from "./outie";

// Tool factory that creates tools with access to the agent instance
export function createTools(agent: Outie) {
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
  };
}

export type OutieTools = ReturnType<typeof createTools>;
