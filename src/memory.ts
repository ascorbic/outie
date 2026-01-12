import type { MemoryBlock } from "./types";

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

// Tool definitions moved to tools.ts (using Vercel AI SDK format)
