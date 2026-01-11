import type { MemoryBlock, JournalEntry } from "./types";

// Default memory blocks (Letta-style)
export const DEFAULT_MEMORY_BLOCKS: Record<string, MemoryBlock> = {
  persona: {
    label: "persona",
    description:
      "Your identity and how you behave. Update this as you learn about yourself.",
    value: `I am Outie, a stateful coding agent. I maintain memory across sessions and work proactively.

## Role
- Proactive: Check for things that need attention
- Stateful: If I didn't write it down, I won't remember it
- Direct: No filler, no excessive enthusiasm`,
    limit: 2000,
    lastUpdated: Date.now(),
  },
  human: {
    label: "human",
    description:
      "What you know about the human you are working with. Update as you learn more.",
    value: "",
    limit: 2000,
    lastUpdated: Date.now(),
  },
  scratchpad: {
    label: "scratchpad",
    description:
      "Working notes, current tasks, temporary information. Clear when no longer needed.",
    value: "",
    limit: 1000,
    lastUpdated: Date.now(),
  },
};

// Render memory blocks as XML for system prompt
export function renderMemoryBlocks(
  blocks: Record<string, MemoryBlock>,
): string {
  const parts = ["<memory_blocks>"];

  for (const [key, block] of Object.entries(blocks)) {
    parts.push(`<${key}>`);
    parts.push(`<description>${block.description}</description>`);
    parts.push(
      `<metadata>chars_current=${block.value.length}, chars_limit=${block.limit}</metadata>`,
    );
    parts.push(`<value>${block.value}</value>`);
    parts.push(`</${key}>`);
  }

  parts.push("</memory_blocks>");
  return parts.join("\n");
}

// Memory tools for the agent
export const MEMORY_TOOLS = [
  {
    name: "memory_insert",
    description: "Insert content into a memory block at a specific line",
    parameters: {
      type: "object",
      properties: {
        block: {
          type: "string",
          description: "Memory block label (persona, human, scratchpad)",
        },
        content: { type: "string", description: "Content to insert" },
        line: {
          type: "number",
          description: "Line number to insert at (0 = beginning)",
        },
      },
      required: ["block", "content"],
    },
  },
  {
    name: "memory_replace",
    description: "Replace content in a memory block",
    parameters: {
      type: "object",
      properties: {
        block: { type: "string", description: "Memory block label" },
        old_str: { type: "string", description: "String to find and replace" },
        new_str: { type: "string", description: "Replacement string" },
      },
      required: ["block", "old_str", "new_str"],
    },
  },
  {
    name: "journal_write",
    description: "Write a journal entry to archival memory",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Short topic/category" },
        content: { type: "string", description: "The journal entry content" },
      },
      required: ["topic", "content"],
    },
  },
  {
    name: "journal_search",
    description: "Search journal entries",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
];
