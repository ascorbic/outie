/**
 * Sub-agents Registry
 * 
 * Specialized agents for specific tasks, using different model tiers.
 * Easy to extend: just add a new entry to SUB_AGENTS.
 */

import { generateText, generateObject } from "ai";
import { z } from "zod";
import { createModelProvider, type ModelTier } from "./models";

// ============================================
// Sub-agent Configuration
// ============================================

export interface SubAgentConfig {
  tier: ModelTier;
  systemPrompt: string;
  description: string; // For tool descriptions
}

/**
 * Registry of all sub-agents.
 * Add new sub-agents here - they'll automatically be available.
 */
export const SUB_AGENTS = {
  summarizer: {
    tier: "fast" as ModelTier,
    description: "Summarizes long content concisely",
    systemPrompt: `You summarize content concisely. Extract:
- Main topic/purpose (1 sentence)
- Key facts and information (3-5 bullets)
- Skip boilerplate, navigation, repetitive content

Be concise. If content is mostly boilerplate, say so.`,
  },

  extractor: {
    tier: "fast" as ModelTier,
    description: "Extracts specific information based on a query",
    systemPrompt: `You extract specific information from content.
Given content and a query, find and return only the relevant information.
If the information isn't present, say so clearly.
Quote relevant passages when helpful.`,
  },

  thinker: {
    tier: "thinking" as ModelTier,
    description: "Thinks deeply about complex problems",
    systemPrompt: `You are a careful, thorough thinker. Take your time to:
- Consider multiple perspectives
- Identify potential issues or edge cases  
- Reason through the problem step by step
- Provide a well-considered conclusion

Don't rush. Quality of reasoning matters more than speed.`,
  },

  planner: {
    tier: "thinking" as ModelTier,
    description: "Breaks down complex tasks into concrete steps",
    systemPrompt: `You break down complex tasks into concrete steps.
For each step, specify:
- What needs to be done
- What tools or resources are needed
- Dependencies on other steps
- Expected outcome

Be specific and actionable.`,
  },

  critic: {
    tier: "fast" as ModelTier,
    description: "Reviews and critiques content or plans",
    systemPrompt: `You review content critically but constructively.
Identify:
- Strengths and what works well
- Weaknesses or gaps
- Specific suggestions for improvement
- Potential issues or risks

Be direct but helpful.`,
  },
} as const;

export type SubAgentId = keyof typeof SUB_AGENTS;

// ============================================
// Core Runner
// ============================================

export interface SubAgentInput {
  task: string;
  context?: string;
}

export interface SubAgentResult {
  text: string;
  agent: SubAgentId;
  tier: ModelTier;
}

/**
 * Run any sub-agent by ID
 */
export async function runSubAgent(
  env: Env,
  agentId: SubAgentId,
  input: SubAgentInput,
): Promise<SubAgentResult> {
  const config = SUB_AGENTS[agentId];
  console.log(`[SUB-AGENT] Running ${agentId} with tier ${config.tier}`);
  
  const prompt = input.context 
    ? `Context:\n${input.context}\n\n---\n\nTask:\n${input.task}`
    : input.task;

  try {
    const { text } = await generateText({
      model: createModelProvider(env, config.tier),
      system: config.systemPrompt,
      prompt,
    });
    return { text, agent: agentId, tier: config.tier };
  } catch (error) {
    console.error(`[SUB-AGENT] Error in ${agentId}:`, error);
    throw error;
  }
}

// ============================================
// Convenience Functions
// ============================================

/**
 * Summarize content (page, document, etc.)
 */
export async function summarize(
  env: Env,
  content: string,
  source?: string,
): Promise<string> {
  const result = await runSubAgent(env, "summarizer", {
    task: source 
      ? `Summarize this content from ${source}:\n\n${content}`
      : `Summarize this content:\n\n${content}`,
  });
  return result.text;
}

/**
 * Extract specific information from content
 */
export async function extract(
  env: Env,
  content: string,
  query: string,
): Promise<string> {
  const result = await runSubAgent(env, "extractor", {
    task: query,
    context: content,
  });
  return result.text;
}

/**
 * Think deeply about a complex question (uses Opus)
 */
export async function think(
  env: Env,
  question: string,
  context?: string,
): Promise<string> {
  const result = await runSubAgent(env, "thinker", {
    task: question,
    context,
  });
  return result.text;
}

/**
 * Plan out a complex task
 */
export async function plan(
  env: Env,
  task: string,
  context?: string,
): Promise<string> {
  const result = await runSubAgent(env, "planner", {
    task,
    context,
  });
  return result.text;
}

/**
 * Critique/review content
 */
export async function critique(
  env: Env,
  content: string,
  focus?: string,
): Promise<string> {
  const result = await runSubAgent(env, "critic", {
    task: focus || "Review this content and provide feedback.",
    context: content,
  });
  return result.text;
}

// ============================================
// Routing (Model Selection)
// ============================================

/**
 * Classify task complexity for routing decisions
 */
export async function classifyComplexity(
  env: Env,
  task: string,
): Promise<{ level: "simple" | "moderate" | "complex"; reasoning: string }> {
  const { object } = await generateObject({
    model: createModelProvider(env, "fast"),
    schema: z.object({
      level: z.enum(["simple", "moderate", "complex"]),
      reasoning: z.string(),
    }),
    prompt: `Classify the complexity of this task:

${task}

- simple: Direct question, single step, no ambiguity
- moderate: Multiple steps, some reasoning needed
- complex: Requires deep thinking, planning, or handling ambiguity`,
  });

  return object;
}

/**
 * Route to appropriate model tier based on task complexity
 */
export function tierForComplexity(level: "simple" | "moderate" | "complex"): ModelTier {
  return level === "complex" ? "thinking" : "fast";
}
