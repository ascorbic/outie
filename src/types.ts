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
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  // For tool messages
  tool_call_id?: string;
  name?: string;
  // For assistant messages with tool calls
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
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

// Claude API types
export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

export interface ClaudeContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ClaudeResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ClaudeContentBlock[];
  model: string;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}
