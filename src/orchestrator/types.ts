/**
 * Orchestrator Types
 * 
 * Core types for the Outie orchestrator architecture.
 * The orchestrator is a "dumb" coordinator that:
 * - Receives triggers (telegram, alarms, web)
 * - Builds context from state
 * - Wakes sandbox and sends prompts to OpenCode
 * - Serves MCP tools over Streamable HTTP
 */

// =============================================================================
// Trigger Types
// =============================================================================

export type TriggerType = 'message' | 'alarm' | 'ambient';

export interface TriggerContext {
  type: TriggerType;
  triggerId?: string;
  payload: string;
  source?: 'telegram' | 'web' | 'api';
  chatId?: string;
}

// =============================================================================
// Conversation Buffer
// =============================================================================

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  trigger: TriggerType;
  source?: string;
}

export interface ConversationStats {
  messageCount: number;
  estimatedTokens: number;
  needsCompaction: boolean;
}

// =============================================================================
// State Files (injected into context)
// =============================================================================

export interface StateFile {
  name: string;
  content: string;
  updatedAt: number;
}

// =============================================================================
// Journal
// =============================================================================

export interface JournalEntry {
  id: string;
  timestamp: number;
  topic: string;
  content: string;
}

// =============================================================================
// Reminders / Scheduling
// =============================================================================

export interface Reminder {
  id: string;
  description: string;
  payload: string;
  cronExpression?: string;    // For recurring
  scheduledTime?: number;     // For one-shot (epoch ms)
  createdAt: number;
}

// =============================================================================
// Conversation Summary (for context recovery)
// =============================================================================

export interface ConversationSummary {
  id: string;
  timestamp: number;
  summary: string;
  notes?: string;
  keyDecisions?: string[];
  openThreads?: string[];
  learnedPatterns?: string[];
}

// =============================================================================
// Topics (distilled knowledge)
// =============================================================================

export interface Topic {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

// =============================================================================
// Built Context (assembled for each invocation)
// =============================================================================

export interface BuiltContext {
  // Identity and state files
  identity: string;
  stateFiles: Record<string, string>;
  
  // Temporal context
  recentConversation: ConversationMessage[];
  recentJournal: JournalEntry[];
  lastSummary?: ConversationSummary;
  
  // Stats
  conversationStats: ConversationStats;
  
  // Timestamp
  timestamp: string;
  localTime: string;
}

// =============================================================================
// Invocation Result
// =============================================================================

export interface InvocationResult {
  response: string;
  wasInterrupted?: boolean;
}
