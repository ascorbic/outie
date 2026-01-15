/**
 * Conversation summarization
 */

import { generateText } from "ai";
import type { Message, ConversationSummary } from "../types";
import { createSummarizationModel } from "../models";
import { saveSummary, deleteMessage } from "./state";
import { createLogger } from "./logger";
import { SUMMARIZE_THRESHOLD, SUMMARIZE_RATIO } from "./config";

const log = createLogger("SUMMARIZE");

export interface SummarizationContext {
  env: Env;
  sql: DurableObjectStorage["sql"];
  conversationHistory: Message[];
  conversationSummary?: ConversationSummary;
}

export interface SummarizationResult {
  summary: ConversationSummary;
  remainingHistory: Message[];
}

/**
 * Summarize old messages when history exceeds threshold
 * Returns null if no summarization needed
 */
export async function summarizeIfNeeded(
  ctx: SummarizationContext,
): Promise<SummarizationResult | null> {
  const history = ctx.conversationHistory;
  if (history.length < SUMMARIZE_THRESHOLD) return null;

  const numToSummarize = Math.floor(history.length * SUMMARIZE_RATIO);
  const toSummarize = history.slice(0, numToSummarize);
  const toKeep = history.slice(numToSummarize);

  const conversationText = toSummarize
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

  const previousSummary = ctx.conversationSummary
    ? `Previous summary:\n${ctx.conversationSummary.content}\n\n`
    : "";

  log.info(`Summarizing ${numToSummarize} messages (keeping ${toKeep.length})`);

  try {
    const { text: summaryText } = await generateText({
      model: createSummarizationModel(ctx.env),
      system: `You are a summarization assistant. Summarize the following conversation concisely, preserving:
1. Key facts and decisions made
2. Important context about the user
3. Any commitments or follow-ups mentioned
4. The overall flow of topics discussed

Keep the summary under 500 words. Focus on what would be important to know if continuing this conversation later.`,
      prompt: `${previousSummary}Conversation to summarize:\n\n${conversationText}`,
    });

    if (!summaryText) {
      log.error("Failed to generate summary - empty response");
      return null;
    }

    const summary: ConversationSummary = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      content: summaryText,
      fromTimestamp: toSummarize[0]?.timestamp ?? Date.now(),
      toTimestamp: toSummarize[toSummarize.length - 1]?.timestamp ?? Date.now(),
      messageCount: (ctx.conversationSummary?.messageCount ?? 0) + numToSummarize,
    };

    // Save to database
    saveSummary(ctx.sql, summary);

    // Delete summarized messages from SQLite
    for (const msg of toSummarize) {
      deleteMessage(ctx.sql, msg.id);
    }

    log.info(`Created summary (${summaryText.length} chars), total messages summarized: ${summary.messageCount}`);

    return {
      summary,
      remainingHistory: toKeep,
    };
  } catch (error) {
    log.error("Summarization failed", error);
    return null;
  }
}
