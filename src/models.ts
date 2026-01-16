/**
 * Model providers via Cloudflare AI Gateway
 * 
 * Uses ai-gateway-provider for native AI Gateway integration with:
 * - BYOK (stored keys in gateway)
 * - Automatic fallback support
 * - Caching, rate limiting, etc.
 */

import { createAiGateway } from "ai-gateway-provider";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ModelTier } from "./types";

// Re-export for convenience
export type { ModelTier } from "./types";

// Model definitions by tier
const MODELS = {
  // Fast tier: Gemini 2.5 Flash
  fast: {
    provider: "google" as const,
    model: "gemini-2.5-flash",
  },
  // Thinking tier: Claude Opus 4 (for complex reasoning)
  thinking: {
    provider: "anthropic" as const,
    model: "claude-opus-4-20250514",
  },
} as const;

/**
 * Create a model provider for the given tier
 * Uses Cloudflare AI Gateway with BYOK for all providers
 */
export function createModelProvider(env: Env, tier: ModelTier = "fast") {
  const config = MODELS[tier];

  const aigateway = createAiGateway({
    accountId: env.CF_ACCOUNT_ID,
    gateway: env.CF_AIG_GATEWAY_ID,
    apiKey: env.CF_API_TOKEN,
  });

  if (config.provider === "google") {
    const google = createGoogleGenerativeAI({
      apiKey: "BYOK", // Gateway injects the real key
    });
    return aigateway([google(config.model)]);
  }

  // Anthropic
  const anthropic = createAnthropic({
    apiKey: "BYOK", // Gateway injects the real key
  });
  return aigateway([anthropic(config.model)]);
}

/**
 * Create a model with automatic fallback
 * If primary fails, falls back to secondary
 */
export function createModelWithFallback(
  env: Env,
  primary: ModelTier,
  fallback: ModelTier,
) {
  const aigateway = createAiGateway({
    accountId: env.CF_ACCOUNT_ID,
    gateway: env.CF_AIG_GATEWAY_ID,
    apiKey: env.CF_API_TOKEN,
  });

  const primaryConfig = MODELS[primary];
  const fallbackConfig = MODELS[fallback];

  const models = [];

  // Add primary
  if (primaryConfig.provider === "google") {
    const google = createGoogleGenerativeAI({ apiKey: "BYOK" });
    models.push(google(primaryConfig.model));
  } else {
    const anthropic = createAnthropic({ apiKey: "BYOK" });
    models.push(anthropic(primaryConfig.model));
  }

  // Add fallback
  if (fallbackConfig.provider === "google") {
    const google = createGoogleGenerativeAI({ apiKey: "BYOK" });
    models.push(google(fallbackConfig.model));
  } else {
    const anthropic = createAnthropic({ apiKey: "BYOK" });
    models.push(anthropic(fallbackConfig.model));
  }

  return aigateway(models);
}

// For summarization, use a cheap fast model
export function createSummarizationModel(env: Env) {
  return createModelProvider(env, "fast");
}
