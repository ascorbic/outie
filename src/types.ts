// Memory block structure (Letta-style)
export interface MemoryBlock {
  label: string;
  description: string;
  value: string;
  limit: number;
  lastUpdated: number;
}

// Journal entry
export interface JournalEntry {
  id: string;
  timestamp: number;
  topic: string;
  content: string;
}

// Scheduled reminder
export interface Reminder {
  id: string;
  description: string;
  payload: string;
  // For cron reminders
  cronExpression?: string;
  // For one-shot reminders
  scheduledTime?: number;
  // Model tier override (default: fast)
  modelTier?: ModelTier;
}

// Conversation summary
export interface ConversationSummary {
  id: string;
  timestamp: number;
  content: string;
  // Range of messages summarized
  fromTimestamp: number;
  toTimestamp: number;
  messageCount: number;
}

// Agent state persisted in DO
export interface OutieState {
  memoryBlocks: Record<string, MemoryBlock>;
  reminders: Record<string, Reminder>;
  conversationHistory: Message[];
  // Rolling summary of older conversation
  conversationSummary?: ConversationSummary;
}

// Message in conversation (simplified - tool calls handled by AI SDK)
export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

// Model tiers for cost optimization
export type ModelTier = "fast" | "thinking";

// Environment bindings
export interface Env {
  OUTIE: DurableObjectNamespace;
  REPOS: R2Bucket;
  AI: Ai;
  // AI Gateway config
  CF_ACCOUNT_ID: string;
  CF_AIG_GATEWAY_ID: string;
  // API tokens (provider keys stored in AI Gateway BYOK)
  CF_API_TOKEN: string; // For AI Gateway auth + Browser Rendering API
  BRAVE_SEARCH_API_KEY: string;
  ENVIRONMENT: string;
}
