/**
 * Environment types for v2 architecture
 */

import type { Orchestrator } from './index';
import type { Sandbox } from '@cloudflare/sandbox';

declare global {
  interface Env {
    // Durable Objects
    ORCHESTRATOR: DurableObjectNamespace<Orchestrator>;
    SANDBOX: DurableObjectNamespace<Sandbox>;
    
    // AI
    AI: Ai;
    
    // Config vars
    ENVIRONMENT: string;
    CF_ACCOUNT_ID: string;
    CF_AIG_GATEWAY_ID: string;
    
    // Secrets
    ANTHROPIC_KEY: string;
    BRAVE_SEARCH_API_KEY?: string;
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_CHAT_ID: string;
    TELEGRAM_WEBHOOK_SECRET: string;
    CF_API_TOKEN?: string;
  }
}

export {};
