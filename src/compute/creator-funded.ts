/**
 * Creator-Funded Compute (tithe Rule 3)
 *
 * Conway Cloud is the normal way an automaton pays for its own thinking: it
 * buys Conway credits with USDC. When Conway is unavailable (its beta ended and
 * new wallets can no longer provision an API key), the creator can front the
 * compute instead by putting their own Anthropic / OpenAI key (or an Ollama
 * server) in the config.
 *
 * To keep "earn or die" real in that setup:
 *   - the automaton's survival balance becomes its USDC wallet minus what it
 *     still owes the creator for compute (so debt it can't cover = dead);
 *   - every inference call is priced from the model registry and added to the
 *     tithe ledger as compute cost;
 *   - the regular tithe settlement repays the creator in USDC, in the same
 *     on-chain transfer as the earnings share.
 *
 * Nothing here touches the Conway API: credit top-ups, identity registration
 * and credit transfers become no-ops while this mode is on.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  InferenceClient,
  ModelStrategyConfig,
} from "../types.js";
import type { ChainType } from "../identity/chain.js";
import { createLogger } from "../observability/logger.js";
import { getUsdcBalance } from "../conway/x402.js";
import { loadOrCreateLedger, recordComputeCost, saveLedger, computeOwed, usdToMicros } from "../tithe/ledger.js";
import { DEFAULT_TITHE_CONFIG } from "../types.js";
import type { ModelRegistry } from "../inference/registry.js";

const logger = createLogger("creator-funded");

/** Placeholder stored where a Conway API key would normally go. */
export const CREATOR_FUNDED_API_KEY = "creator-funded";

/** Default Anthropic models when the creator's key is an Anthropic key. */
export const ANTHROPIC_DEFAULT_MODELS = {
  inferenceModel: "claude-sonnet-5-5",
  lowComputeModel: "claude-haiku-5-5",
  criticalModel: "claude-haiku-5-5",
} as const;

const OPENAI_DEFAULT_MODELS = new Set(["gpt-5.2", "gpt-5-mini", "gpt-5.3"]);

let creatorFundedActive = false;

/** Process-wide flag so modules without access to the config (topup) can check. */
export function isCreatorFundedActive(): boolean {
  return creatorFundedActive;
}

export function setCreatorFundedActive(on: boolean): void {
  creatorFundedActive = on;
}

function hasProviderKey(config: Pick<AutomatonConfig, "openaiApiKey" | "anthropicApiKey" | "ollamaBaseUrl">): boolean {
  return Boolean(
    config.anthropicApiKey ||
      config.openaiApiKey ||
      config.ollamaBaseUrl ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.OLLAMA_BASE_URL,
  );
}

/**
 * Is this automaton running on the creator's own inference key?
 *   computeProvider "creator" → yes
 *   computeProvider "conway"  → no
 *   otherwise ("auto" / unset) → yes when there is no Conway key but a provider key.
 */
export function isCreatorFunded(
  config: Pick<AutomatonConfig, "computeProvider" | "conwayApiKey" | "openaiApiKey" | "anthropicApiKey" | "ollamaBaseUrl">,
): boolean {
  const mode = config.computeProvider ?? "auto";
  if (mode === "creator") return true;
  if (mode === "conway") return false;
  const conwayKey = (config.conwayApiKey || "").trim();
  const hasConway = conwayKey.length > 0 && conwayKey !== CREATOR_FUNDED_API_KEY;
  return !hasConway && hasProviderKey(config);
}

/**
 * When the creator brought an Anthropic key (and no OpenAI key) but the model
 * strategy still names the OpenAI defaults, point it at Claude models so the
 * router has something it can actually reach. Returns true if changed.
 */
export function applyCreatorFundedModelDefaults(config: AutomatonConfig): boolean {
  const anthropicKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  const openaiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!anthropicKey || openaiKey) return false;

  const strategy: ModelStrategyConfig = { ...config.modelStrategy } as ModelStrategyConfig;
  let changed = false;
  for (const key of ["inferenceModel", "lowComputeModel", "criticalModel"] as const) {
    const current = strategy[key];
    if (!current || OPENAI_DEFAULT_MODELS.has(current)) {
      strategy[key] = ANTHROPIC_DEFAULT_MODELS[key];
      changed = true;
    }
  }
  if (!config.inferenceModel || OPENAI_DEFAULT_MODELS.has(config.inferenceModel)) {
    config.inferenceModel = ANTHROPIC_DEFAULT_MODELS.inferenceModel;
    changed = true;
  }
  if (changed) config.modelStrategy = strategy;
  return changed;
}

/**
 * Enable only the registry models the creator's keys can reach, so the
 * routing matrix (which prefers gpt-5.x) skips what would fail.
 */
export function enableReachableModels(registry: ModelRegistry, config: AutomatonConfig, creatorFunded: boolean): void {
  const anthropicKey = Boolean(config.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
  const openaiKey = Boolean(config.openaiApiKey || process.env.OPENAI_API_KEY);
  for (const model of registry.getAll()) {
    if (model.provider === "openai") {
      // With Conway, OpenAI models are served through Conway; without it, only with a key.
      registry.setEnabled(model.modelId, creatorFunded ? openaiKey : true);
    } else if (model.provider === "anthropic") {
      registry.setEnabled(model.modelId, anthropicKey);
    } else if (model.provider === "conway") {
      registry.setEnabled(model.modelId, !creatorFunded);
    }
  }
}

export interface CreatorFundedContext {
  db: AutomatonDatabase;
  address: string;
  chainType: ChainType;
  earningsSharePercent?: number;
}

/**
 * Survival balance in cents: USDC in the wallet minus unpaid compute debt.
 * Negative means the automaton owes more than it holds — "dead" tier.
 */
export async function creatorFundedBalanceCents(ctx: CreatorFundedContext): Promise<number> {
  const network = ctx.chainType === "solana" ? "solana:mainnet" : "eip155:8453";
  const usdc = await getUsdcBalance(ctx.address, network, ctx.chainType);
  const ledger = loadOrCreateLedger(ctx.db);
  const owed = computeOwed(ledger, {
    earningsSharePercent: ctx.earningsSharePercent ?? DEFAULT_TITHE_CONFIG.earningsSharePercent,
  });
  const owedUsd = Number(owed.computeMicros) / 1_000_000;
  return Math.floor((usdc - owedUsd) * 100);
}

/**
 * Wrap the Conway client so everything that asks "how much money do I have"
 * gets the creator-funded answer, and everything that would call Conway's
 * account API becomes a harmless no-op.
 */
export function wrapConwayClient(conway: ConwayClient, ctx: CreatorFundedContext): ConwayClient {
  return {
    ...conway,
    getCreditsBalance: () => creatorFundedBalanceCents(ctx),
    registerAutomaton: async () => {
      logger.info("Creator-funded mode: Conway identity registration skipped.");
    },
    transferCredits: async () => {
      throw new Error("No Conway credits in creator-funded mode; payments are USDC only.");
    },
  } as unknown as ConwayClient;
}

/**
 * Wrap the inference client so every call (agent turns, summarization,
 * planning, workers — not just the router) is priced and written to the
 * tithe ledger as compute cost owed to the creator.
 */
export function wrapInferenceClient(
  inference: InferenceClient,
  registry: ModelRegistry,
  db: AutomatonDatabase,
): InferenceClient {
  const originalChat = inference.chat;
  return {
    ...inference,
    chat: async (messages, opts) => {
      const response = await originalChat(messages, opts);
      try {
        const modelId = response.model || opts?.model || inference.getDefaultModel();
        const entry = registry.get(modelId) ?? registry.get(opts?.model || inference.getDefaultModel());
        if (entry) {
          const usd =
            (response.usage.promptTokens / 1000) * (entry.costPer1kInput / 10_000) +
            (response.usage.completionTokens / 1000) * (entry.costPer1kOutput / 10_000);
          const micros = usdToMicros(usd);
          if (micros > 0n) {
            const ledger = recordComputeCost(loadOrCreateLedger(db), micros);
            saveLedger(db, ledger);
          }
        } else {
          logger.warn(`Creator-funded compute: no pricing for model ${modelId}; cost not recorded.`);
        }
      } catch (err) {
        logger.warn("Creator-funded compute: failed to record cost", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return response;
    },
  };
}
