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

// Agent state persisted in DO
export interface OutieState {
  memoryBlocks: Record<string, MemoryBlock>;
  reminders: Record<string, Reminder>;
  conversationHistory: Message[];
}

// Message in conversation
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
  ANTHROPIC_API_KEY: string;
  ENVIRONMENT: string;
}
