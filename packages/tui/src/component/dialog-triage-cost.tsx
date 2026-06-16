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
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
      {/* Title row */}
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Cost estimate
        </text>
        <text fg={theme.textMuted} onMouseUp={() => { dialog.clear(); props.onDismiss() }}>
          esc skip
        </text>
      </box>

      {/* Loading state */}
      <Show when={assessment.loading}>
        <text fg={theme.textMuted}>Assessing request...</text>
      </Show>

      {/* Error state */}
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
        {(data) => (
          <>
            {/* Triage summary */}
            <text fg={theme.textMuted}>
              {data().triageResult.complexity} task ·{" "}
              {data().triageResult.suggestedTier} tier ·{" "}
              ~{data().triageResult.estimatedOutputTokens} output tokens
              {data().triageResult.tier === 2 ? " · escalated" : ""}
            </text>

            {/* Model list */}
            <For each={data().estimates}>
              {(estimate, i) => {
                const isSelected = () => i() === store.selectedIndex
                const isRec = () => i() === data().recommendedIndex
                return (
                  <box
                    flexDirection="row"
                    justifyContent="space-between"
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={isSelected() ? theme.primary : undefined}
                    onMouseUp={() => {
                      setStore("selectedIndex", i())
                      confirm()
                    }}
                  >
                    <text fg={isSelected() ? theme.selectedListItemText : theme.text}>
                      {isSelected() ? "▶ " : "  "}
                      {estimate.model.label}
                      {isRec() ? " ✓" : ""}
                    </text>
                    <text fg={isSelected() ? theme.selectedListItemText : theme.textMuted}>
                      {formatCurrency(estimate.cost)}{" "}
                      in {formatRate(estimate.model.input)} · out {formatRate(estimate.model.output)}
                    </text>
                  </box>
                )
              }}
            </For>

            {/* Footer */}
            <box paddingBottom={1}>
              <text fg={theme.textMuted}>↑↓ select · Enter confirm · Esc skip check</text>
            </box>
          </>
        )}
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
