/**
 * Context Builder
 *
 * Builds the context that gets injected into each OpenCode invocation.
 * Follows the Acme pattern:
 * - System prompt (static, caches well)
 * - Dynamic context (state files, journal, conversation, timestamp)
 */

import type {
  BuiltContext,
  ConversationMessage,
  JournalEntry,
  ConversationSummary,
  TriggerContext,
} from './types';
import {
  getRecentConversation,
  getRecentJournal,
  getRecentSummaries,
  getAllStateFiles,
  getConversationStats,
} from './state';

const TIMEZONE = 'Europe/London';

// =============================================================================
// Context Building
// =============================================================================

export function buildContext(sql: SqlStorage): BuiltContext {
  const now = new Date();
  const timestamp = now.toISOString();
  const localTime = now.toLocaleString('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  // Load all state
  const stateFiles = getAllStateFiles(sql);
  const identity = stateFiles['identity'] ?? '# Identity\n\nNo identity configured.';
  const recentConversation = getRecentConversation(sql, 30);
  const recentJournal = getRecentJournal(sql, 40);
  const summaries = getRecentSummaries(sql, 1);
  const lastSummary = summaries[0];
  const conversationStats = getConversationStats(sql);

  return {
    identity,
    stateFiles,
    recentConversation,
    recentJournal,
    lastSummary,
    conversationStats,
    timestamp,
    localTime,
  };
}

// =============================================================================
// Format for Injection
// =============================================================================

function formatConversation(messages: ConversationMessage[]): string {
  if (messages.length === 0) {
    return '(no conversation history)';
  }

  return messages.map(m => {
    const time = new Date(m.timestamp).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit'
    });
    const prefix = m.role === 'user' ? 'User' : 'You';
    const truncated = m.content.length > 5000
      ? m.content.slice(0, 5000) + '...'
      : m.content;
    return `<message time="${time}" from="${prefix}">
${truncated}
</message>`;
  }).join('\n\n');
}

function formatJournal(entries: JournalEntry[]): string {
  if (entries.length === 0) {
    return '(no journal entries)';
  }

  return entries.map(e => {
    const date = new Date(e.timestamp).toISOString().split('T')[0];
    return `<journal date="${date}" topic="${e.topic}">${e.content}</journal>`;
  }).join('\n\n');
}

function formatSummary(summary?: ConversationSummary): string {
  if (!summary) {
    return '(no previous summary)';
  }

  const parts = [`**${new Date(summary.timestamp).toISOString().split('T')[0]}**: ${summary.summary}`];
  if (summary.notes) parts.push(`Notes: ${summary.notes}`);
  if (summary.keyDecisions?.length) parts.push(`Key decisions: ${summary.keyDecisions.join('; ')}`);
  if (summary.openThreads?.length) parts.push(`Open threads: ${summary.openThreads.join('; ')}`);
  if (summary.learnedPatterns?.length) parts.push(`Learned patterns: ${summary.learnedPatterns.join('; ')}`);
  return parts.join('\n');
}

// =============================================================================
// Build System Prompt (Static - Caches Well)
// =============================================================================

export function buildSystemPrompt(identity: string): string {
  return `
<identity>
${identity}
</identity>

## Operating Principles

1. **If you didn't write it down, you won't remember it next message** - Use memory tools for anything important
2. **Only communicate when meaningful, but write everything down** - For ambient ticks, only respond if there's something important, but journal everything
3. **All outgoing communication via tools** - Use send_telegram MCP tool for Telegram messages
4. **Update topics when you learn something new** - Keep your journal updated with new insights
5. You can update your identity and state files at any time by writing to the appropriate state file. Keep them up to date as you learn more about them and yourself.
`.trim();
}

// =============================================================================
// Build Dynamic Context (Changes Each Invocation)
// =============================================================================

export function buildDynamicContext(context: BuiltContext, trigger: TriggerContext): string {
  return `
<current_time>
<timestamp>${context.timestamp}</timestamp>
<local>${context.localTime}</local>
<trigger>${trigger.type}${trigger.triggerId ? ` (${trigger.triggerId})` : ''}</trigger>
</current_time>

<context_status>
<conversation_buffer messages="${context.conversationStats.messageCount}" tokens="~${context.conversationStats.estimatedTokens}" threshold="50000" />
<compaction_needed>${context.conversationStats.needsCompaction}</compaction_needed>
</context_status>

<state_files>
<today>
${context.stateFiles['today'] ?? '(no today file)'}
</today>

<matt>
${context.stateFiles['matt'] ?? '(no matt file)'}
</matt>
</state_files>

<recent_journal count="40">
${formatJournal(context.recentJournal)}
</recent_journal>

<last_summary>
${formatSummary(context.lastSummary)}
</last_summary>

<recent_conversation>
${formatConversation(context.recentConversation)}
</recent_conversation>
`.trim();
}

function extractCoreStateFiles(files: Record<string, string>): { today: string; matt: string } {
  return {
    today: files['today'] ?? '(no today file)',
    matt: files['matt'] ?? '(no matt file)',
  };
}

// =============================================================================
// Build Full Prompt
// =============================================================================

export function buildPrompt(dynamicContext: string, trigger: TriggerContext, needsCompaction: boolean): string {
  let prompt = dynamicContext;

  // Add compaction notice if buffer is getting large
  if (needsCompaction) {
    prompt += `\n\n---\n\n**CONTEXT COMPACTION NEEDED:** Your conversation buffer is getting large. Please call \`save_conversation_summary\` with a summary of what we've discussed, key decisions made, and open threads. This will clear the buffer for fresh context.`;
  }

  // Add trigger-specific content
  switch (trigger.type) {
    case 'message':
      return `${prompt}\n\n---\n\nUser message: ${trigger.payload}`;

    case 'alarm':
      return `${prompt}\n\n---\n\nScheduled reminder: ${trigger.payload}\n\n**IMPORTANT:** This is a scheduled trigger – your response will NOT be sent to Telegram automatically. If you want Matt to see this reminder, you MUST use the \`send_telegram\` tool explicitly.`;

    case 'ambient':
      return `${prompt}\n\n---\n\nThis is an ambient invocation. Check your state and decide if any action is needed.\n\n**IMPORTANT:** This is an ambient trigger – your response will NOT be sent to Telegram automatically. If you want Matt to see something, you MUST use the \`send_telegram\` tool explicitly. If nothing requires attention, just respond briefly for logging purposes.`;

    default:
      return prompt;
  }
}
