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

// Environment bindings
export interface Env {
  OUTIE: DurableObjectNamespace;
  REPOS: R2Bucket;
  AI: Ai;
  // AI Gateway config
  CF_ACCOUNT_ID: string;
  CF_AIG_GATEWAY_ID: string;
  // API tokens
  ANTHROPIC_API_KEY: string;
  BRAVE_SEARCH_API_KEY: string;
  CF_API_TOKEN: string; // For Browser Rendering API
  // For OpenCode in sandbox - AI Gateway auth token
  CF_AIG_TOKEN?: string;
  ENVIRONMENT: string;
}
