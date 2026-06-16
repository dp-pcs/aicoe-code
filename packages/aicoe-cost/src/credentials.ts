/**
 * aicoe-cost: credential resolution
 *
 * Reads the CoE LiteLLM gateway URL and API key using a priority chain:
 *
 *   1. Environment variables (AICOE_LITELLM_URL + AICOE_API_KEY)
 *   2. macOS Keychain (service="aicoe-code", account="litellm-api-key")
 *      combined with URL from ~/.aicoe-code/config.json
 *   3. ~/.aicoe-code/config.json for both (non-macOS fallback)
 *
 * This mirrors the resolution logic in the original cli/src/auth.ts so
 * existing stored credentials work without any migration.
 *
 * No external dependencies — uses only Node/Bun built-ins.
 */

import { execSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { TriageEnv } from "./triage.ts"

const KEYCHAIN_SERVICE = "aicoe-code"
const KEYCHAIN_ACCOUNT = "litellm-api-key"
const CONFIG_PATH = join(homedir(), ".aicoe-code", "config.json")
const DEFAULT_URL = "https://litellm.elelem.expert"

function readConfig(): { litellmUrl?: string; apiKey?: string } {
  try {
    if (!existsSync(CONFIG_PATH)) return {}
    const raw = readFileSync(CONFIG_PATH, "utf-8")
    const parsed = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function keychainGet(): string | null {
  if (process.platform !== "darwin") return null
  try {
    const result = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    )
    return result.trim() || null
  } catch {
    return null
  }
}

let cached: TriageEnv | null | undefined

/**
 * Resolve CoE gateway credentials. Returns a TriageEnv with both
 * litellmUrl and apiKey populated, or an empty object if not configured
 * (triage will fall back to keyword heuristics).
 *
 * Result is cached for the process lifetime.
 */
export function resolveTriageEnv(): TriageEnv {
  if (cached !== undefined) return cached ?? {}

  // 1. Environment variables
  if (process.env["AICOE_LITELLM_URL"] && process.env["AICOE_API_KEY"]) {
    cached = {
      litellmUrl: process.env["AICOE_LITELLM_URL"],
      apiKey: process.env["AICOE_API_KEY"],
    }
    return cached
  }

  const config = readConfig()

  // 2. Keychain API key + config/default URL
  const keychainKey = keychainGet()
  if (keychainKey) {
    cached = {
      litellmUrl: config.litellmUrl ?? DEFAULT_URL,
      apiKey: keychainKey,
    }
    return cached
  }

  // 3. Config file only (both URL and key stored there)
  if (config.litellmUrl && config.apiKey) {
    cached = { litellmUrl: config.litellmUrl, apiKey: config.apiKey }
    return cached
  }

  // Not configured — triage will use heuristics
  cached = null
  return {}
}

/** Clear the cache (useful in tests or after a login flow). */
export function clearTriageEnvCache(): void {
  cached = undefined
}
