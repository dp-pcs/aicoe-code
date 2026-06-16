/**
 * DialogTriageCost — cost-awareness intercept shown before a new session.
 *
 * Flow:
 *  1. Runs triage on the pending prompt text against the CoE LiteLLM gateway.
 *  2. Builds a ranked cost menu from the gateway model registry.
 *  3. Shows the recommended model + estimated cost; lets user confirm or pick
 *     a different model.
 *  4. Resolves via onConfirm({ providerID, modelID, ... }) or onDismiss().
 *
 * Gateway credentials are read from:
 *   AICOE_LITELLM_URL  — e.g. https://litellm.elelem.expert
 *   AICOE_API_KEY      — Bearer key for the gateway
 *
 * Falls back to keyword heuristics when the gateway is not configured.
 */

import { TextAttributes } from "@opentui/core"
import { createStore } from "solid-js/store"
import { createResource, For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useBindings } from "../keymap"
import {
  triage,
  estimateInputTokens,
  type TriageResult,
} from "@opencode-ai/aicoe-cost/triage"
import {
  estimateMenu,
  pickRecommendation,
  formatCurrency,
  formatRate,
  type CostEstimate,
} from "@opencode-ai/aicoe-cost/estimator"
import { GATEWAY_MODELS } from "@opencode-ai/aicoe-cost/pricing"
import { resolveTriageEnv } from "@opencode-ai/aicoe-cost/credentials"

export interface TriageCostResult {
  providerID: string
  modelID: string
  wasRecommended: boolean
  estimate: CostEstimate
  triageResult: TriageResult
}

export type DialogTriageCostProps = {
  promptText: string
  onConfirm: (result: TriageCostResult) => void
  onDismiss: () => void
}



/** Map a gateway model ID like "anthropic/claude-sonnet-4-6" to { providerID, modelID } */
function splitGatewayModelId(id: string): { providerID: string; modelID: string } {
  const slash = id.indexOf("/")
  if (slash < 0) return { providerID: id, modelID: id }
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }
}

export function DialogTriageCost(props: DialogTriageCostProps) {
  const dialog = useDialog()
  const { theme } = useTheme()

  const [store, setStore] = createStore({ selectedIndex: 0 })

  const [assessment] = createResource(
    () => props.promptText,
    async (promptText) => {
      const triageResult = await triage(promptText, resolveTriageEnv())
      const inputTokens = estimateInputTokens(promptText)
      const allModelIds = GATEWAY_MODELS.map((m) => m.id)
      const estimates = estimateMenu(allModelIds, inputTokens, triageResult.estimatedOutputTokens)
      const recommendation = pickRecommendation(estimates, triageResult.suggestedTier)
      const recommendedIndex = estimates.findIndex((e) => e.model.id === recommendation.model.id)
      // Pre-select the recommendation
      setStore("selectedIndex", recommendedIndex >= 0 ? recommendedIndex : 0)
      return { triageResult, estimates, recommendation, recommendedIndex }
    },
  )

  function confirm() {
    const data = assessment()
    if (!data) {
      props.onDismiss()
      return
    }
    const estimate = data.estimates[store.selectedIndex]
    if (!estimate) {
      props.onDismiss()
      return
    }
    dialog.clear()
    props.onConfirm({
      ...splitGatewayModelId(estimate.model.id),
      wasRecommended: store.selectedIndex === data.recommendedIndex,
      estimate,
      triageResult: data.triageResult,
    })
  }

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: "Confirm model selection",
        group: "Dialog",
        cmd: confirm,
      },
      {
        key: "up",
        desc: "Previous model",
        group: "Dialog",
        cmd: () => {
          setStore("selectedIndex", (i) => Math.max(0, i - 1))
        },
      },
      {
        key: "down",
        desc: "Next model",
        group: "Dialog",
        cmd: () => {
          const data = assessment()
          const max = data ? data.estimates.length - 1 : 0
          setStore("selectedIndex", (i) => Math.min(max, i + 1))
        },
      },
      {
        key: "escape",
        desc: "Skip cost check",
        group: "Dialog",
        cmd: () => {
          dialog.clear()
          props.onDismiss()
        },
      },
      // 1–9 direct pick
      ...Array.from({ length: 9 }, (_, n) => ({
        key: String(n + 1),
        desc: `Pick model ${n + 1}`,
        group: "Dialog",
        cmd: () => {
          const data = assessment()
          if (!data) return
          if (n < data.estimates.length) {
            setStore("selectedIndex", n)
          }
        },
      })),
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>

      {/* Title row */}
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          COST MENU · per request
        </text>
        <text fg={theme.textMuted} onMouseUp={() => { dialog.clear(); props.onDismiss() }}>
          esc skip
        </text>
      </box>

      {/* Loading */}
      <Show when={assessment.loading}>
        <text fg={theme.textMuted}>Assessing request...</text>
      </Show>

      {/* Error */}
      <Show when={assessment.error}>
        <box gap={1}>
          <text fg={theme.error}>Assessment failed — continuing with current model.</text>
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme.primary}
            onMouseUp={() => { dialog.clear(); props.onDismiss() }}
          >
            <text fg={theme.selectedListItemText}>Continue</text>
          </box>
        </box>
      </Show>

      {/* Results */}
      <Show when={assessment()}>
        {(data) => {
          const rec = data().estimates[data().recommendedIndex]
          const dearest = data().estimates.reduce(
            (a, b) => (b.cost > a.cost ? b : a),
            data().estimates[0]!,
          )
          const saved = rec ? Math.max(0, (dearest?.cost ?? 0) - rec.cost) : 0
          const pct = dearest && dearest.cost > 0 && rec
            ? Math.round((1 - rec.cost / dearest.cost) * 100)
            : 0

          return (
            <>
              {/* Triage context line */}
              <text fg={theme.textMuted}>
                {data().triageResult.complexity} task ·{" "}
                ~{data().triageResult.estimatedOutputTokens} output tokens
                {data().triageResult.tier === 2 ? " · escalated" : ""}
              </text>

              {/* Model rows */}
              <For each={data().estimates}>
                {(estimate, i) => {
                  const isSelected = () => i() === store.selectedIndex
                  const isRec = () => i() === data().recommendedIndex
                  const ratio = rec && rec.cost > 0 ? estimate.cost / rec.cost : 1
                  const note = isRec()
                    ? "BEST VALUE"
                    : ratio > 1.2
                      ? `${ratio.toFixed(1)}× more`
                      : ""
                  const costFg = () =>
                    isSelected()
                      ? theme.selectedListItemText
                      : isRec()
                        ? theme.success
                        : ratio >= 10
                          ? theme.warning
                          : theme.text

                  return (
                    <box
                      flexDirection="row"
                      paddingLeft={1}
                      paddingRight={1}
                      backgroundColor={isSelected() ? theme.primary : undefined}
                      onMouseUp={() => {
                        setStore("selectedIndex", i())
                        confirm()
                      }}
                    >
                      {/* ★ recommended marker */}
                      <text fg={theme.warning}>
                        {isRec() ? "★ " : "  "}
                      </text>
                      {/* › cursor */}
                      <text fg={isSelected() ? theme.accent : theme.textMuted}>
                        {isSelected() ? "› " : "  "}
                      </text>
                      {/* number */}
                      <text fg={theme.textMuted}>{`${i() + 1} `}</text>
                      {/* label */}
                      <text fg={theme.text}>
                        {estimate.model.label.padEnd(20)}
                      </text>
                      {/* provider */}
                      <text fg={theme.textMuted}>{estimate.model.provider.padEnd(11)}</text>
                      {/* cost */}
                      <text attributes={isRec() ? TextAttributes.BOLD : undefined} fg={costFg()}>
                        {formatCurrency(estimate.cost).padStart(7)}{" "}
                      </text>
                      {/* note */}
                      <text fg={isRec() ? theme.success : theme.textMuted}>{note}</text>
                    </box>
                  )
                }}
              </For>

              {/* Savings callout — only shown when there's a meaningful saving */}
              <Show when={saved > 0}>
                <box
                  flexDirection="column"
                  borderStyle="rounded"
                  borderColor={theme.success}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  <box flexDirection="row">
                    <text attributes={TextAttributes.BOLD} fg={theme.success}>✓ </text>
                    <text fg={theme.text}>
                      {`Right-sized to ${rec?.model.label} — you save `}
                    </text>
                    <text attributes={TextAttributes.BOLD} fg={theme.success}>
                      {formatCurrency(saved)}
                    </text>
                  </box>
                  <text fg={theme.textMuted}>
                    {`vs ${dearest?.model.label} · ${pct}% cheaper, same job`}
                  </text>
                </box>
              </Show>

              {/* Keybind hints */}
              <box flexDirection="row" paddingBottom={1}>
                <text fg={theme.textMuted}>  </text>
                <text fg={theme.accent}>enter</text>
                <text fg={theme.textMuted}> accept  </text>
                <text fg={theme.accent}>1-{data().estimates.length}</text>
                <text fg={theme.textMuted}> pick  </text>
                <text fg={theme.accent}>esc</text>
                <text fg={theme.textMuted}> skip</text>
              </box>
            </>
          )
        }}
      </Show>
    </box>
  )
}

/**
 * Show the triage cost dialog and resolve with the user's choice.
 * Returns null if the user dismissed (use current model as-is).
 */
DialogTriageCost.show = (
  dialog: DialogContext,
  promptText: string,
): Promise<TriageCostResult | null> => {
  return new Promise<TriageCostResult | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogTriageCost
          promptText={promptText}
          onConfirm={(result) => resolve(result)}
          onDismiss={() => resolve(null)}
        />
      ),
      () => resolve(null),
    )
  })
}
