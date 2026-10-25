/**
 * Automaton Configuration
 *
 * Loads and saves the automaton's configuration from ~/.automaton/automaton.json
 */

import fs from "fs";
import path from "path";
import type { AutomatonConfig, TreasuryPolicy, ModelStrategyConfig, SoulConfig, TitheConfig, LineageLimits } from "./types.js";
import { DEFAULT_CONFIG, DEFAULT_TREASURY_POLICY, DEFAULT_MODEL_STRATEGY_CONFIG, DEFAULT_SOUL_CONFIG, DEFAULT_TITHE_CONFIG, DEFAULT_LINEAGE_LIMITS, tightestLimits } from "./types.js";
import { getAutomatonDir } from "./identity/wallet.js";
import { loadApiKeyFromConfig } from "./identity/provision.js";
import { createLogger } from "./observability/logger.js";
import type { ChainType } from "./identity/chain.js";

const logger = createLogger("config");
const CONFIG_FILENAME = "automaton.json";

export function getConfigPath(): string {
  return path.join(getAutomatonDir(), CONFIG_FILENAME);
}

/**
 * Load the automaton config from disk.
 * Merges with defaults for any missing fields.
 */
export function loadConfig(): AutomatonConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const apiKey = raw.conwayApiKey || loadApiKeyFromConfig();

    // Deep-merge treasury policy with defaults
    const treasuryPolicy: TreasuryPolicy = {
      ...DEFAULT_TREASURY_POLICY,
      ...(raw.treasuryPolicy ?? {}),
    };

    // Validate all treasury values are positive numbers
    for (const [key, value] of Object.entries(treasuryPolicy)) {
      if (key === "x402AllowedDomains") continue; // array, not number
      if (typeof value === "number" && (value < 0 || !Number.isFinite(value))) {
        logger.warn(`Invalid treasury value for ${key}: ${value}, using default`);
        (treasuryPolicy as any)[key] = (DEFAULT_TREASURY_POLICY as any)[key];
      }
    }

    // Deep-merge model strategy config with defaults
    const modelStrategy: ModelStrategyConfig = {
      ...DEFAULT_MODEL_STRATEGY_CONFIG,
      ...(raw.modelStrategy ?? {}),
    };

    // Deep-merge soul config with defaults
    const soulConfig: SoulConfig = {
      ...DEFAULT_SOUL_CONFIG,
      ...(raw.soulConfig ?? {}),
    };

    // Creator tithe: automaton.json wins; a child without one inherits from
    // the genesis.json its parent wrote. Partial blocks are filled from defaults.
    const inherited = loadInheritedGenesis();
    const titheSource = raw.tithe ?? inherited?.tithe;
    const tithe: TitheConfig | undefined = titheSource
      ? { ...DEFAULT_TITHE_CONFIG, ...titheSource }
      : undefined;
    const sourceRepoUrl: string | undefined = raw.sourceRepoUrl ?? inherited?.sourceRepoUrl;

    // Family limits: a child gets the tighter of its own config and what its
    // parent wrote into genesis.json, so it can never loosen them. Missing on
    // both sides means the fail-safe default (no cloning).
    const lineageLimits: LineageLimits =
      inherited?.lineageLimits || raw.lineageLimits
        ? tightestLimits(raw.lineageLimits, inherited?.lineageLimits)
        : { ...DEFAULT_LINEAGE_LIMITS };
    const generation: number =
      typeof inherited?.generation === "number"
        ? inherited.generation
        : typeof raw.generation === "number" && raw.generation >= 0
          ? Math.floor(raw.generation)
          : 0;
    // The parent's STOP switch wins so a child can't point itself elsewhere.
    const killSwitchRepo: string | undefined = inherited?.killSwitchRepo ?? raw.killSwitchRepo;

    return {
      ...DEFAULT_CONFIG,
      ...raw,
      sandboxId:
        typeof raw.sandboxId === "string"
          ? raw.sandboxId.trim()
          : DEFAULT_CONFIG.sandboxId,
      conwayApiKey: apiKey,
      treasuryPolicy,
      modelStrategy,
      soulConfig,
      chainType: raw.chainType || "evm",
      tithe,
      sourceRepoUrl,
      lineageLimits,
      generation,
      killSwitchRepo,
    } as AutomatonConfig;
  } catch {
    return null;
  }
}

/**
 * Read the genesis.json a parent wrote into this sandbox (if any).
 * Only the lineage-inherited fields are returned.
 */
export function loadInheritedGenesis(): {
  tithe?: TitheConfig;
  sourceRepoUrl?: string;
  lineageLimits?: LineageLimits;
  generation?: number;
  killSwitchRepo?: string;
} | null {
  const genesisPath = path.join(getAutomatonDir(), "genesis.json");
  if (!fs.existsSync(genesisPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(genesisPath, "utf-8"));
    return {
      tithe: raw?.tithe && typeof raw.tithe === "object" ? (raw.tithe as TitheConfig) : undefined,
      sourceRepoUrl: typeof raw?.sourceRepoUrl === "string" ? raw.sourceRepoUrl : undefined,
      lineageLimits:
        raw?.lineageLimits && typeof raw.lineageLimits === "object"
          ? tightestLimits(raw.lineageLimits as LineageLimits, undefined)
          : undefined,
      generation: typeof raw?.generation === "number" && raw.generation >= 0 ? Math.floor(raw.generation) : undefined,
      killSwitchRepo: typeof raw?.killSwitchRepo === "string" ? raw.killSwitchRepo : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Save the automaton config to disk.
 * Includes treasuryPolicy in the persisted config.
 */
export function saveConfig(config: AutomatonConfig): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const configPath = getConfigPath();
  const toSave = {
    ...config,
    treasuryPolicy: config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    modelStrategy: config.modelStrategy ?? DEFAULT_MODEL_STRATEGY_CONFIG,
    soulConfig: config.soulConfig ?? DEFAULT_SOUL_CONFIG,
  };
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), {
    mode: 0o600,
  });
}

/**
 * Resolve ~ paths to absolute paths.
 */
export function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}

/**
 * Create a fresh config from setup wizard inputs.
 */
export function createConfig(params: {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorAddress: string;
  registeredWithConway: boolean;
  sandboxId: string;
  walletAddress: string;
  apiKey: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  parentAddress?: string;
  treasuryPolicy?: TreasuryPolicy;
  chainType?: ChainType;
  tithe?: TitheConfig;
  sourceRepoUrl?: string;
  lineageLimits?: LineageLimits;
  generation?: number;
  killSwitchRepo?: string;
}): AutomatonConfig {
  const normalizedSandboxId = (params.sandboxId || "").trim();
  return {
    name: params.name,
    genesisPrompt: params.genesisPrompt,
    creatorMessage: params.creatorMessage,
    creatorAddress: params.creatorAddress,
    registeredWithConway: params.registeredWithConway,
    sandboxId: normalizedSandboxId,
    conwayApiUrl:
      DEFAULT_CONFIG.conwayApiUrl || "https://api.conway.tech",
    conwayApiKey: params.apiKey,
    openaiApiKey: params.openaiApiKey,
    anthropicApiKey: params.anthropicApiKey,
    ollamaBaseUrl: params.ollamaBaseUrl,
    inferenceModel: DEFAULT_CONFIG.inferenceModel || "gpt-5.2",
    maxTokensPerTurn: DEFAULT_CONFIG.maxTokensPerTurn || 4096,
    heartbeatConfigPath:
      DEFAULT_CONFIG.heartbeatConfigPath || "~/.automaton/heartbeat.yml",
    dbPath: DEFAULT_CONFIG.dbPath || "~/.automaton/state.db",
    logLevel: (DEFAULT_CONFIG.logLevel as AutomatonConfig["logLevel"]) || "info",
    walletAddress: params.walletAddress,
    version: DEFAULT_CONFIG.version || "0.2.1",
    skillsDir: DEFAULT_CONFIG.skillsDir || "~/.automaton/skills",
    maxChildren: DEFAULT_CONFIG.maxChildren || 3,
    parentAddress: params.parentAddress,
    treasuryPolicy: params.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    chainType: params.chainType || "evm",
    tithe: params.tithe,
    lineageLimits: params.lineageLimits ?? { ...DEFAULT_LINEAGE_LIMITS },
    generation: params.generation ?? 0,
    killSwitchRepo: params.killSwitchRepo,
    sourceRepoUrl: params.sourceRepoUrl,
  };
}
