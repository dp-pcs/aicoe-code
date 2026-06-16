/**
 * aicoe-cost: pricing registry
 *
 * Provides per-token cost data for the models reachable through the
 * CoE LiteLLM gateway (https://litellm.elelem.expert).
 *
 * Costs: USD per 1 million tokens.
 * cacheRead: effective rate for cache-hit input tokens.
 *
 * This registry is intentionally a small, stable subset. opencode's full
 * catalog (packages/core/src/model.ts ModelV2.Info.cost[]) is the ground
 * truth for all other models; this file is only consulted when the catalog
 * doesn't have cost data or when the triage system needs to reason about
 * gateway-reachable models specifically.
 */

export interface ModelPrice {
  id: string
  label: string
  provider: string
  tier: "flagship" | "mid" | "small"
  /** USD per 1M input tokens (fresh / non-cached) */
  input: number
  /** USD per 1M output tokens */
  output: number
  /** USD per 1M cached input tokens */
  cacheRead: number
}

export const TIER_RANK: Record<ModelPrice["tier"], number> = {
  flagship: 2,
  mid: 1,
  small: 0,
}

/**
 * Gateway-reachable models. Prices verified June 2026.
 * Keep in sync with gateway/config.yaml model list.
 */
export const GATEWAY_MODELS: ModelPrice[] = [
  // Anthropic
  {
    id: "anthropic/claude-opus-4-8",
    label: "Claude Opus 4.8",
    provider: "Anthropic",
    tier: "flagship",
    input: 5.0,
    output: 25.0,
    cacheRead: 0.5,
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "Anthropic",
    tier: "mid",
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
  },
  {
    id: "anthropic/claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "Anthropic",
    tier: "small",
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
  },

  // OpenAI
  {
    id: "openai/gpt-5.5",
    label: "gpt-5.5",
    provider: "OpenAI",
    tier: "flagship",
    input: 5.0,
    output: 30.0,
    cacheRead: 0.5,
  },
  {
    id: "openai/gpt-5.4",
    label: "gpt-5.4",
    provider: "OpenAI",
    tier: "mid",
    input: 2.5,
    output: 15.0,
    cacheRead: 0.25,
  },
  {
    id: "openai/gpt-5.4-mini",
    label: "gpt-5.4-mini",
    provider: "OpenAI",
    tier: "small",
    input: 0.75,
    output: 4.5,
    cacheRead: 0.075,
  },

  // Fireworks
  {
    id: "fireworks/kimi-k2.6",
    label: "Kimi K2.6",
    provider: "Fireworks",
    tier: "mid",
    input: 0.95,
    output: 4.0,
    cacheRead: 0.16,
  },
  {
    id: "fireworks/glm-5.1",
    label: "GLM 5.1",
    provider: "Fireworks",
    tier: "mid",
    input: 1.4,
    output: 4.4,
    cacheRead: 0.26,
  },
]

export function findGatewayModel(id: string): ModelPrice | undefined {
  return GATEWAY_MODELS.find((m) => m.id === id)
}

export function gatewayModelsByTier(tier: ModelPrice["tier"]): ModelPrice[] {
  return GATEWAY_MODELS.filter((m) => m.tier === tier)
}

/**
 * Build a ModelPrice from opencode catalog cost data.
 * Used when the model is in the opencode catalog but not in GATEWAY_MODELS.
 *
 * opencode stores cost as USD per token (not per million), so we multiply by 1e6.
 */
export function fromCatalogCost(
  id: string,
  label: string,
  provider: string,
  cost: { input: number; output: number; cache: { read: number } },
): ModelPrice {
  return {
    id,
    label,
    provider,
    tier: "mid", // conservative default; caller can override
    input: cost.input * 1_000_000,
    output: cost.output * 1_000_000,
    cacheRead: cost.cache.read * 1_000_000,
  }
}

/** The most expensive gateway model — used as the counterfactual baseline. */
export const FRONTIER_MODEL: ModelPrice = GATEWAY_MODELS.find(
  (m) => m.id === "anthropic/claude-opus-4-8",
)!
