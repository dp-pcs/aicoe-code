/**
 * aicoe-cost: triage classifier
 *
 * Two-tier task classification:
 *   Tier 1 — cheap model (default: gpt-5.4-mini via LiteLLM gateway)
 *   Tier 2 — frontier model (default: claude-opus-4-8) for ambiguous or
 *             high-stakes prompts
 *
 * Falls back to keyword heuristics when no gateway URL/key is configured.
 */

export interface TriageResult {
  taskType: string
  complexity: "simple" | "medium" | "hard"
  confidence: number
  estimatedOutputTokens: number
  outputTokenRange: [number, number]
  reason: string
  suggestedTier: "small" | "mid" | "flagship"
  suggestedModels: string[]
  /** Which triage tier produced the final classification */
  tier: 1 | 2
  escalationReason?: string
}

export interface TriageEnv {
  /** Base URL of LiteLLM gateway, e.g. https://litellm.elelem.expert */
  litellmUrl?: string
  /** Bearer API key for the gateway */
  apiKey?: string
  /** Override the cheap Tier-1 model ID */
  tier1Model?: string
  /** Override the frontier Tier-2 model ID */
  tier2Model?: string
  /** Confidence below which Tier-2 escalation fires (default 0.7) */
  confidenceThreshold?: number
}

// ---------------------------------------------------------------------------
// Heuristic tables
// ---------------------------------------------------------------------------

const COMPLEXITY_OUTPUT_RANGES: Record<TriageResult["complexity"], [number, number]> = {
  simple: [50, 300],
  medium: [200, 800],
  hard: [500, 2500],
}

const TIER_FOR_COMPLEXITY: Record<TriageResult["complexity"], TriageResult["suggestedTier"]> = {
  simple: "small",
  medium: "mid",
  hard: "flagship",
}

const SUGGESTED_MODELS: Record<TriageResult["complexity"], string[]> = {
  simple: ["openai/gpt-5.4-mini", "anthropic/claude-haiku-4-5"],
  medium: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"],
  hard: ["anthropic/claude-opus-4-8", "openai/gpt-5.5"],
}

const HIGH_STAKES_KEYWORDS = [
  "security",
  "production",
  "legal",
  "compliance",
  "audit",
  "pii",
  "payment",
  "credential",
  "secret",
  "auth",
  "permission",
  "penetration",
  "vulnerability",
]

const SIMPLE_SIGNALS = ["summarize", "explain", "rename", "what is", "define", "quick", "how do i"]
const MEDIUM_SIGNALS = ["refactor", "component", "fix", "debug", "test", "function", "bug", "issue"]
const HARD_SIGNALS = ["architecture", "large refactor", "complex", "design", "migrate", "rewrite", "system"]

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function hasHighStakesSignal(prompt: string): { triggered: boolean; keyword?: string } {
  const p = prompt.toLowerCase()
  for (const keyword of HIGH_STAKES_KEYWORDS) {
    if (p.includes(keyword)) return { triggered: true, keyword }
  }
  return { triggered: false }
}

// ---------------------------------------------------------------------------
// Heuristic fallback (no gateway required)
// ---------------------------------------------------------------------------

export function mockTriage(prompt: string, forceTier2 = false): TriageResult {
  const p = prompt.toLowerCase()
  let complexity: TriageResult["complexity"] = "medium"

  if (SIMPLE_SIGNALS.some((w) => p.includes(w))) complexity = "simple"
  if (MEDIUM_SIGNALS.some((w) => p.includes(w))) complexity = "medium"
  if (HARD_SIGNALS.some((w) => p.includes(w))) complexity = "hard"

  const highStakes = hasHighStakesSignal(prompt)
  const tier: TriageResult["tier"] = forceTier2 || highStakes.triggered ? 2 : 1
  const confidence = highStakes.triggered ? 0.95 : 0.75

  const [min, max] = COMPLEXITY_OUTPUT_RANGES[complexity]
  const estimated = Math.round((min + max) / 2)

  return {
    taskType: complexity === "simple" ? "summary" : complexity === "medium" ? "code_edit" : "architecture",
    complexity,
    confidence,
    estimatedOutputTokens: estimated,
    outputTokenRange: [min, max],
    reason: `Keyword heuristic classified this as ${complexity}-complexity work.`,
    suggestedTier: TIER_FOR_COMPLEXITY[complexity],
    suggestedModels: SUGGESTED_MODELS[complexity],
    tier,
    escalationReason: highStakes.triggered
      ? `High-stakes keyword: "${highStakes.keyword}". Escalated to frontier triage.`
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// LLM-based triage (calls gateway)
// ---------------------------------------------------------------------------

const TRIAGE_SYSTEM_PROMPT =
  "You are a task classifier for a coding assistant. Analyze the user request and return ONLY " +
  "a single raw JSON object. Do not wrap it in markdown, code fences, or any explanation. " +
  'Required keys: taskType (string), complexity ("simple"|"medium"|"hard"), confidence (number 0-1), ' +
  "estimatedOutputTokens (number), outputTokenRange ([low, high]), reason (string), " +
  'suggestedTier ("small"|"mid"|"flagship"), suggestedModels (array of model ids). ' +
  "Available models: anthropic/claude-haiku-4-5, anthropic/claude-sonnet-4-6, anthropic/claude-opus-4-8, " +
  "openai/gpt-5.4-mini, openai/gpt-5.4, openai/gpt-5.5. Be concise."

function parseTriageJson(raw: string): TriageResult | null {
  const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim()
  try {
    return JSON.parse(cleaned) as TriageResult
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        return JSON.parse(match[0]) as TriageResult
      } catch {
        // fall through
      }
    }
  }
  return null
}

async function callTriageModel(
  prompt: string,
  env: TriageEnv,
  model: string,
  highStakes: boolean,
): Promise<TriageResult> {
  if (!env.litellmUrl || !env.apiKey) {
    return mockTriage(prompt, highStakes)
  }

  const system = highStakes
    ? TRIAGE_SYSTEM_PROMPT + " This task is ambiguous or high-stakes; err toward a higher tier."
    : TRIAGE_SYSTEM_PROMPT

  const response = await fetch(`${env.litellmUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: 350,
    }),
  })

  if (!response.ok) {
    // Gateway unavailable — fall back to heuristics silently
    return mockTriage(prompt, highStakes)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const raw = data.choices?.[0]?.message?.content ?? ""
  const parsed = parseTriageJson(raw)

  if (!parsed) {
    const fallback = mockTriage(prompt, highStakes)
    return {
      ...fallback,
      reason: `${fallback.reason} (triage model returned invalid JSON; using heuristic fallback)`,
    }
  }

  const [, max] = COMPLEXITY_OUTPUT_RANGES[parsed.complexity] ?? [200, 800]
  return {
    ...parsed,
    estimatedOutputTokens: parsed.estimatedOutputTokens || max,
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function triage(prompt: string, env: TriageEnv = {}): Promise<TriageResult> {
  const highStakes = hasHighStakesSignal(prompt)
  const threshold = env.confidenceThreshold ?? 0.7
  const tier1 = env.tier1Model ?? "openai/gpt-5.4-mini"

  const tier1Result = await callTriageModel(prompt, env, tier1, false)

  const shouldEscalate =
    highStakes.triggered || tier1Result.confidence < threshold || tier1Result.suggestedTier === "flagship"

  if (!shouldEscalate) {
    return { ...tier1Result, tier: 1 }
  }

  const tier2 = env.tier2Model ?? "anthropic/claude-opus-4-8"
  const tier2Result = await callTriageModel(prompt, env, tier2, true)

  return {
    ...tier2Result,
    tier: 2,
    escalationReason: highStakes.triggered
      ? `High-stakes keyword: "${highStakes.keyword}". Escalated to ${tier2}.`
      : tier1Result.confidence < threshold
        ? `Tier-1 confidence ${tier1Result.confidence.toFixed(2)} < ${threshold}. Escalated to ${tier2}.`
        : `Tier-1 suggested flagship. Escalated to ${tier2} for confirmation.`,
  }
}

/**
 * Rough input token estimate — used to pre-compute the cost menu before
 * the actual request fires.
 *
 * Uses char/4 approximation (no tiktoken dependency in this package).
 */
export function estimateInputTokens(prompt: string, context = ""): number {
  return Math.ceil((prompt.length + context.length) / 4)
}
