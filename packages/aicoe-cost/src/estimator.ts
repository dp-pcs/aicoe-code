/**
 * aicoe-cost: cost estimator
 *
 * Computes estimated cost for a model + token count combination,
 * builds sorted comparison menus, and picks the cheapest model
 * that meets a suggested tier.
 */

import { type ModelPrice, TIER_RANK, GATEWAY_MODELS, findGatewayModel } from "./pricing.ts"

export interface CostEstimate {
  model: ModelPrice
  inputTokens: number
  outputTokens: number
  /** Estimated cost assuming all input is fresh (worst case) */
  cost: number
  /** Estimated cost assuming some input is cached */
  costCachedInput: number
  tierRank: number
}

export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  options: { cachedInputFraction?: number } = {},
): CostEstimate {
  const model = findGatewayModel(modelId)
  if (!model) throw new Error(`Unknown model in gateway registry: ${modelId}`)

  const cachedFraction = options.cachedInputFraction ?? 0
  const cachedInput = Math.floor(inputTokens * cachedFraction)
  const freshInput = inputTokens - cachedInput

  const cost =
    (freshInput / 1_000_000) * model.input + (outputTokens / 1_000_000) * model.output

  const costCachedInput =
    (freshInput / 1_000_000) * model.input +
    (cachedInput / 1_000_000) * model.cacheRead +
    (outputTokens / 1_000_000) * model.output

  return {
    model,
    inputTokens,
    outputTokens,
    cost,
    costCachedInput,
    tierRank: TIER_RANK[model.tier],
  }
}

/**
 * Build a sorted cost menu for a set of model IDs.
 * Unknown model IDs are silently skipped (not all gateway models may be
 * registered in GATEWAY_MODELS yet).
 */
export function estimateMenu(
  modelIds: string[],
  inputTokens: number,
  outputTokens: number,
  options?: { cachedInputFraction?: number },
): CostEstimate[] {
  return modelIds
    .flatMap((id) => {
      try {
        return [estimateCost(id, inputTokens, outputTokens, options)]
      } catch {
        return []
      }
    })
    .sort((a, b) => a.cost - b.cost)
}

/**
 * Build a full menu across all gateway models — useful for the counterfactual
 * "what would this have cost on every model" display.
 */
export function fullMenu(
  inputTokens: number,
  outputTokens: number,
  options?: { cachedInputFraction?: number },
): CostEstimate[] {
  return estimateMenu(
    GATEWAY_MODELS.map((m) => m.id),
    inputTokens,
    outputTokens,
    options,
  )
}

/**
 * Pick the cheapest model that meets or exceeds the suggested tier.
 * Falls back to the globally cheapest option if none meet the tier.
 */
export function pickRecommendation(
  estimates: CostEstimate[],
  suggestedTier: ModelPrice["tier"],
): CostEstimate {
  const meetsTier = estimates.filter(
    (e) => TIER_RANK[e.model.tier] >= TIER_RANK[suggestedTier],
  )
  return meetsTier[0] ?? estimates[0]!
}

export function formatCurrency(n: number): string {
  if (n === 0) return "$0.00"
  if (n < 0.001) return `${(n * 1000).toFixed(3)}m¢`
  if (n < 0.01) return `${(n * 100).toFixed(2)}¢`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

/**
 * Format a per-million-token price as a readable rate string.
 * e.g. 3.0 → "$3.00/M"  0.75 → "75¢/M"
 */
export function formatRate(perMillion: number): string {
  if (perMillion === 0) return "free"
  if (perMillion < 1) return `${(perMillion * 100).toFixed(0)}¢/M`
  return `$${perMillion.toFixed(2)}/M`
}
