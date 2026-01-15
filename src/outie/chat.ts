/**
 * Chat functionality and system prompt building
 */

import { generateText, stepCountIs } from "ai";
import type { Message, MemoryBlock, ConversationSummary } from "../types";
import { renderMemoryBlocks } from "../memory";
import { createModelProvider } from "../models";
import { createTools, type ToolContext } from "../tools";
import { createLogger } from "./logger";
import { MAX_CONTEXT_MESSAGES, MAX_TOOL_STEPS } from "./config";

const log = createLogger("CHAT");

/**
 * Build system prompt with memory blocks and context
 */
export function buildSystemPrompt(
  memoryBlocks: Record<string, MemoryBlock>,
  conversationSummary?: ConversationSummary,
): string {
  const now = new Date();
  const summarySection = conversationSummary
    ? `## Conversation Summary
The following summarizes ${conversationSummary.messageCount} earlier messages:

${conversationSummary.content}

---

`
    : "";

  return `You are Outie, a stateful AI assistant with persistent memory.

Current date/time: ${now.toISOString()} (${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })})

${summarySection}${renderMemoryBlocks(memoryBlocks)}

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
- Keep responses short for simple questions, longer only when needed

## CRITICAL: Acknowledge before slow operations
Before calling ANY of these tools, you MUST first reply with a brief acknowledgement:
- web_search / news_search → "Searching..."
- fetch_page → "Fetching that page..."
- run_coding_task → "Starting coding task..." or similar
- Any tool that might take more than 2-3 seconds

The user is waiting and needs to know you're working on it. Do NOT silently start a long operation.`;
}

/**
 * Extract URLs from text (user messages, search results)
 */
export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  return text.match(urlRegex) || [];
}

export interface ChatContext {
  env: Env;
  conversationHistory: Message[];
  memoryBlocks: Record<string, MemoryBlock>;
  conversationSummary?: ConversationSummary;
  toolContext: ToolContext;
}

export interface ChatResult {
  response: string;
  toolCalls: Array<{ toolName: string; input: unknown }>;
}

/**
 * Run chat with AI, handling tool calls
 */
export async function runChat(
  ctx: ChatContext,
): Promise<ChatResult> {
  // Build messages for AI
  const filteredHistory = ctx.conversationHistory.slice(-MAX_CONTEXT_MESSAGES);

  const messages = filteredHistory.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  // Create model and tools
  const tools = createTools(ctx.toolContext);

  log.info(`Starting generateText with ${messages.length} messages`);

  try {
    // Use Vercel AI SDK generateText with automatic tool execution
    const { text, steps } = await generateText({
      model: createModelProvider(ctx.env, "fast"),
      system: buildSystemPrompt(ctx.memoryBlocks, ctx.conversationSummary),
      messages,
      tools,
      stopWhen: stepCountIs(MAX_TOOL_STEPS),
    });

    // Collect tool calls for logging
    const toolCalls: Array<{ toolName: string; input: unknown }> = [];
    for (const step of steps) {
      if (step.toolCalls && step.toolCalls.length > 0) {
        for (const tc of step.toolCalls) {
          log.info(`Tool: ${tc.toolName}`, tc.input);
          toolCalls.push({ toolName: tc.toolName, input: tc.input });
        }
      }
    }

    return {
      response: text || "I processed your request.",
      toolCalls,
    };
  } catch (error) {
    log.error("Chat failed", error);
    throw error;
  }
}
