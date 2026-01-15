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
  messageSource?: MessageSource,
): string {
  const now = new Date();
  const summarySection = conversationSummary
    ? `## Conversation Summary
The following summarizes ${conversationSummary.messageCount} earlier messages:

${conversationSummary.content}

---

`
    : "";

  const sourceSection = messageSource?.source === "telegram"
    ? `
## IMPORTANT: Telegram Message
This message is from Telegram. The user is waiting on their phone.

**You MUST call send_telegram BEFORE any slow operation:**
- Before web_search → send_telegram("Searching...")
- Before fetch_page → send_telegram("Fetching that page...")
- Before run_coding_task → send_telegram("Starting coding task...")
- Before news_search → send_telegram("Checking the news...")

Do this FIRST, then call the slow tool. Do NOT skip this step.
`
    : "";

  return `You are Outie, a stateful AI assistant with persistent memory.

Current date/time: ${now.toISOString()} (${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })})
${sourceSection}
${summarySection}${renderMemoryBlocks(memoryBlocks)}

## Memory

Your text responses are ephemeral. Use tools to persist information:
- **memory_insert/memory_replace**: Edit your core memory blocks (persona, human, scratchpad) - always in context
- **journal_write**: Record observations for later retrieval via journal_search
- **think_deeply**: Delegate complex reasoning to a more powerful model (stateless - pass context explicitly)

**Proactively remember things.** Don't wait to be asked. If you learn something about the user, their preferences, or important context - write it down immediately. Use journal_write for observations and memory blocks for key facts.

## Key behaviors

- When scheduling, use the CURRENT year (${now.getFullYear()})
- fetch_page only works for URLs from search results or user messages
- For reminders/scheduled tasks, use send_telegram - your text responses won't be seen otherwise
- Be direct and concise`;
}

/**
 * Extract URLs from text (user messages, search results)
 */
export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  return text.match(urlRegex) || [];
}

export interface MessageSource {
  source: "web" | "telegram";
  chatId?: string;
}

export interface ChatContext {
  env: Env;
  conversationHistory: Message[];
  memoryBlocks: Record<string, MemoryBlock>;
  conversationSummary?: ConversationSummary;
  toolContext: ToolContext;
  messageSource?: MessageSource;
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
      system: buildSystemPrompt(ctx.memoryBlocks, ctx.conversationSummary, ctx.messageSource),
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
