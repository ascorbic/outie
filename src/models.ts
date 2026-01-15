import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ModelTier } from "./types";

// AI Gateway base URL
const aiGatewayBase = (accountId: string, gatewayId: string) =>
  `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}`;

// Model definitions by tier
const MODELS = {
  // Fast tier: Gemini 2.5 Flash - $0.30/$2.50 per 1M tokens
  fast: {
    provider: "google" as const,
    model: "gemini-2.5-flash",
  },
  // Thinking tier: Claude Opus 4 - $15/$75 per 1M tokens (use for reflections)
  thinking: {
    provider: "anthropic" as const,
    model: "claude-opus-4-20250514",
  },
} as const;

export function createModelProvider(env: Env, tier: ModelTier = "fast") {
  const { accountId, gatewayId } = {
    accountId: env.CF_ACCOUNT_ID,
    gatewayId: env.CF_AIG_GATEWAY_ID,
  };

  // Auth header for AI Gateway (BYOK handles provider keys)
  const headers = {
    "cf-aig-authorization": `Bearer ${env.CF_API_TOKEN}`,
  };

  const config = MODELS[tier];

  if (config.provider === "google") {
    const google = createGoogleGenerativeAI({
      // BYOK: gateway injects the real key, but SDK requires a value
      apiKey: "BYOK",
      baseURL: `${aiGatewayBase(accountId, gatewayId)}/google-ai-studio/v1beta`,
      headers,
    });
    return google(config.model);
  }

  // Anthropic
  const anthropic = createAnthropic({
    // BYOK: gateway injects the real key, but SDK requires a value
    apiKey: "BYOK",
    baseURL: `${aiGatewayBase(accountId, gatewayId)}/anthropic`,
    headers,
  });
  return anthropic(config.model);
}

// For summarization, use a cheap fast model
export function createSummarizationModel(env: Env) {
  return createModelProvider(env, "fast");
}
