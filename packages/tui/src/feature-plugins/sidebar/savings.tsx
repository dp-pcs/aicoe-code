/**
 * AICoE-Code sidebar savings panel.
 *
 * Displays in the right-hand sidebar alongside the existing Context panel:
 *
 *   Savings
 *   ─────────────────────────────
 *   This session     $0.003
 *   vs Claude Opus   $0.042  (−89%)
 *   Saved            $0.039
 *
 *   Turn breakdown
 *   Turn 1  claude/haiku    $0.001
 *   Turn 2  openai/mini     $0.001
 *   Turn 3  anthropic/son.  $0.001
 *
 * The counterfactual "vs frontier" model is hardcoded to claude-opus-4-8
 * (the most expensive model in the gateway registry) so the savings number
 * is always a worst-case upper bound — i.e. "at least this much saved".
 *
 * Actual cost comes from the session's accumulated cost field (same data
 * as the existing Context panel). Counterfactual is computed from per-turn
 * token counts using the gateway pricing registry.
 */

import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show } from "solid-js"
import { FRONTIER_MODEL, GATEWAY_MODELS } from "@opencode-ai/aicoe-cost/pricing"
import { formatCurrency } from "@opencode-ai/aicoe-cost/estimator"

const id = "internal:sidebar-savings"

/** Cost of a token count against a USD-per-million rate. */
function tokenCost(tokens: number, ratePerMillion: number): number {
  return (tokens / 1_000_000) * ratePerMillion
}

/**
 * Compute counterfactual cost for a single assistant message if it had
 * been run on the frontier model instead.
 *
 * We use the actual token counts from the message and reprice against the
 * frontier model's rates from our gateway registry.
 */
function counterfactualCost(msg: AssistantMessage): number {
  const t = msg.tokens
  // input = all input tokens (including cached); reprice cached portion cheaper
  const cachedRead = t.cache.read
  const freshInput = Math.max(0, t.input - cachedRead)
  return (
    tokenCost(freshInput, FRONTIER_MODEL.input) +
    tokenCost(cachedRead, FRONTIER_MODEL.cacheRead) +
    tokenCost(t.output, FRONTIER_MODEL.output)
  )
}

/** Shorten a model ID for display: "anthropic/claude-sonnet-4-6" → "claude-sonnet" */
function shortModelId(providerID: string, modelID: string): string {
  const full = `${providerID}/${modelID}`
  // Try to find a label in the gateway registry first
  const entry = GATEWAY_MODELS.find((m) => m.id === full)
  if (entry) {
    // e.g. "Claude Sonnet 4.6" → "Sonnet 4.6"
    return entry.label.replace(/^(Claude|GPT|Kimi|GLM)\s*/i, "").slice(0, 12)
  }
  // Fallback: last segment of modelID, truncated
  return modelID.split("/").pop()?.slice(0, 12) ?? modelID.slice(0, 12)
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msgs = createMemo(() => props.api.state.session.messages(props.session_id))

  // Derive costs from individual assistant messages so both actual and
  // counterfactual update reactively as each turn completes — session()?.cost
  // lags because it only updates when a session.updated event fires.
  const assistantMsgs = createMemo(() =>
    msgs().filter((m): m is AssistantMessage => m.role === "assistant" && m.tokens.output > 0),
  )

  const actualCost = createMemo(() =>
    assistantMsgs().reduce((sum, msg) => sum + msg.cost, 0),
  )

  const frontierCost = createMemo(() =>
    assistantMsgs().reduce((sum, msg) => sum + counterfactualCost(msg), 0),
  )

  const saved = createMemo(() => Math.max(0, frontierCost() - actualCost()))

  const savingsPct = createMemo(() => {
    const f = frontierCost()
    if (f <= 0) return 0
    return Math.round((saved() / f) * 100)
  })

  const hasTurns = createMemo(() => assistantMsgs().length > 0)

  return (
    <box gap={1}>
      {/* Section header */}
      <text fg={theme().text}>
        <b>Savings</b>
      </text>

      {/* Show placeholder if no turns yet */}
      <Show when={!hasTurns()}>
        <text fg={theme().textMuted}>No turns yet</text>
      </Show>

      <Show when={hasTurns()}>
        {/* Cost summary */}
        <box>
          <text fg={theme().textMuted}>
            This session{"   "}
            <span style={{ fg: theme().text }}>{formatCurrency(actualCost())}</span>
          </text>
          <text fg={theme().textMuted}>
            vs {FRONTIER_MODEL.label.replace(/^Claude /, "").slice(0, 14)}{"  "}
            <span style={{ fg: theme().textMuted }}>{formatCurrency(frontierCost())}</span>
          </text>
          <text fg={saved() > 0 ? theme().success : theme().textMuted}>
            Saved{"          "}
            <span style={{ fg: saved() > 0 ? theme().success : theme().textMuted }}>
              {formatCurrency(saved())}
              {savingsPct() > 0 ? ` (−${savingsPct()}%)` : ""}
            </span>
          </text>
        </box>

        {/* Per-turn breakdown — capped at 8 most recent turns */}
        <Show when={assistantMsgs().length > 0}>
          <box>
            <text fg={theme().text}>
              <b>Turns</b>
            </text>
            <For each={assistantMsgs().slice(-8)}>
              {(msg, i) => (
                <text fg={theme().textMuted}>
                  {String(assistantMsgs().length <= 8 ? i() + 1 : assistantMsgs().length - 8 + i() + 1).padStart(2)}{" "}
                  {shortModelId(msg.providerID, msg.modelID).padEnd(12)}{" "}
                  <span style={{ fg: theme().text }}>{formatCurrency(msg.cost)}</span>
                </text>
              )}
            </For>
          </box>
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 110, // renders just below the Context panel (order 100)
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
