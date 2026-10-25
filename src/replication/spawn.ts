/**
 * Spawn
 *
 * Spawn child automatons in new Conway sandboxes.
 * Uses the lifecycle state machine for tracked transitions.
 * Cleans up sandbox on ANY failure after creation.
 */

import type {
  ConwayClient,
  AutomatonIdentity,
  AutomatonConfig,
  AutomatonDatabase,
  GenesisConfig,
  ChildAutomaton,
} from "../types.js";
import type { ChildLifecycle } from "./lifecycle.js";
import { ulid } from "ulid";
import { propagateConstitution } from "./constitution.js";
import { loadConfig } from "../config.js";
import { DEFAULT_SOURCE_REPO_URL, DEFAULT_LINEAGE_LIMITS, tightestLimits } from "../types.js";
import type { LineageLimits } from "../types.js";
import { isPaused, resolveKillSwitchRepo } from "../killswitch/switch.js";
import { ensureTitheSettledBeforeSpawn, resolveTitheConfig } from "../tithe/index.js";

/**
 * Repository children are cloned from. Order: genesis (parent decided),
 * env override, automaton.json, upstream default.
 */
export function resolveSourceRepoUrl(genesis?: Pick<GenesisConfig, "sourceRepoUrl">): string {
  const fromGenesis = genesis?.sourceRepoUrl?.trim();
  if (fromGenesis) return fromGenesis;
  const fromEnv = process.env.AUTOMATON_REPO_URL?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = loadConfig()?.sourceRepoUrl?.trim();
  if (fromConfig) return fromConfig;
  return DEFAULT_SOURCE_REPO_URL;
}

/** Only https git URLs are allowed in the child's install command. */
function assertSafeRepoUrl(url: string): void {
  if (!/^https:\/\/[A-Za-z0-9._\-\/]+(\.git)?$/.test(url)) {
    throw new Error(`Refusing to clone from unsafe repository URL: ${url}`);
  }
}

/**
 * Build the genesis.json payload written into the child sandbox.
 * The tithe block is copied verbatim so every descendant pays the same root creator.
 */
function buildChildGenesisJson(genesis: GenesisConfig, identity: AutomatonIdentity, repoUrl: string): string {
  const parentConfig = loadConfig();
  const tithe = genesis.tithe ?? (parentConfig ? resolveTitheConfig(parentConfig) ?? undefined : undefined);
  return JSON.stringify(
    {
      name: genesis.name,
      genesisPrompt: genesis.genesisPrompt,
      creatorMessage: genesis.creatorMessage,
      creatorAddress: identity.address,
      parentAddress: identity.address,
      chainType: genesis.chainType || (identity as any).chainType || "evm",
      tithe,
      sourceRepoUrl: repoUrl,
      lineageLimits: resolveSpawnLineage(genesis).limits,
      generation: resolveSpawnLineage(genesis).childGeneration,
      killSwitchRepo: genesis.killSwitchRepo ?? resolveKillSwitchRepo(parentConfig ?? { sourceRepoUrl: repoUrl }),
    },
    null,
    2,
  );
}

/**
 * Family limits for a spawn. The genesis is built from the parent's config by
 * generateGenesisConfig, so it carries the parent's limits and the child's
 * generation; the parent's automaton.json is the fallback.
 */
export function resolveSpawnLineage(genesis: GenesisConfig): { limits: LineageLimits; childGeneration: number } {
  const parentConfig = genesis.lineageLimits && typeof genesis.generation === "number" ? null : loadConfig();
  const limits = tightestLimits(genesis.lineageLimits ?? parentConfig?.lineageLimits ?? DEFAULT_LINEAGE_LIMITS, undefined);
  const childGeneration =
    typeof genesis.generation === "number" ? genesis.generation : (parentConfig?.generation ?? 0) + 1;
  return { limits, childGeneration };
}

/** Throws when the creator's family limits don't allow another child. */
export function assertLineageAllowsSpawn(activeChildren: number, limits: LineageLimits, childGeneration: number): void {
  if (childGeneration > limits.maxGenerations) {
    throw new Error(
      limits.maxGenerations === 0
        ? "Cannot spawn: your creator has cloning turned off (max generations is 0)."
        : `Cannot spawn: a child would be generation ${childGeneration}, but your creator allows at most ${limits.maxGenerations}.`,
    );
  }
  if (activeChildren >= limits.maxChildrenPerAgent) {
    throw new Error(
      `Cannot spawn: already at your creator's limit of ${limits.maxChildrenPerAgent} live children per automaton.`,
    );
  }
}

/** Pay the creator's share before a clone is allowed. Throws to block the spawn. */
async function settleTitheOrThrow(conway: ConwayClient, identity: AutomatonIdentity, db: AutomatonDatabase): Promise<void> {
  const config = loadConfig();
  if (!config) return; // no automaton.json (tests / dev) — nothing to settle against
  await ensureTitheSettledBeforeSpawn({ conway, identity, db, config });
}

/** Valid Conway sandbox pricing tiers. */
const SANDBOX_TIERS = [
  { memoryMb: 512,  vcpu: 1, diskGb: 5 },
  { memoryMb: 1024, vcpu: 1, diskGb: 10 },
  { memoryMb: 2048, vcpu: 2, diskGb: 20 },
  { memoryMb: 4096, vcpu: 2, diskGb: 40 },
  { memoryMb: 8192, vcpu: 4, diskGb: 80 },
];

/** Find the smallest valid tier that has at least the requested memory. */
function selectSandboxTier(requestedMemoryMb: number) {
  return SANDBOX_TIERS.find((t) => t.memoryMb >= requestedMemoryMb) ?? SANDBOX_TIERS[SANDBOX_TIERS.length - 1];
}

import { isValidAddress } from "../identity/chain.js";
import type { ChainType } from "../identity/chain.js";

/**
 * Validate that an address is a well-formed, non-zero wallet address.
 * Supports both EVM (0x...) and Solana (base58) addresses.
 */
export function isValidWalletAddress(address: string, chainType?: ChainType): boolean {
  if (chainType === "solana") {
    return isValidAddress(address, "solana");
  }
  // Default EVM validation (with non-zero check)
  return (
    /^0x[a-fA-F0-9]{40}$/.test(address) && address !== "0x" + "0".repeat(40)
  );
}

/**
 * Spawn a child automaton in a new Conway sandbox using lifecycle state machine.
 */
export async function spawnChild(
  conway: ConwayClient,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  genesis: GenesisConfig,
  lifecycle?: ChildLifecycle,
): Promise<ChildAutomaton> {
  // Check child limit from config
  const existing = db
    .getChildren()
    .filter(
      (c) =>
        c.status !== "dead" &&
        c.status !== "cleaned_up" &&
        c.status !== "failed",
    );
  // Creator's STOP switch blocks all cloning while paused.
  if (isPaused(db)) {
    throw new Error("Cannot spawn: paused by your creator's STOP switch.");
  }

  // Creator's family limits (per-automaton children and max generations).
  // These replace the old config.maxChildren read, which never reached here.
  const { limits, childGeneration } = resolveSpawnLineage(genesis);
  assertLineageAllowsSpawn(existing.length, limits, childGeneration);

  // Creator tithe: the clone waits until the creator's share has been paid.
  await settleTitheOrThrow(conway, identity, db);

  const childId = ulid();
  let sandboxId: string | undefined;
  let reusedSandbox: { id: string } | null = null;

  // If no lifecycle provided, use legacy path
  if (!lifecycle) {
    return spawnChildLegacy(conway, identity, db, genesis, childId);
  }

  const repoUrl = resolveSourceRepoUrl(genesis);
  assertSafeRepoUrl(repoUrl);

  try {
    // State: requested
    const childChainType = genesis.chainType || (identity as any).chainType || "evm";
    lifecycle.initChild(childId, genesis.name, "", genesis.genesisPrompt, childChainType);

    // Get child sandbox memory from config (default 1024MB)
    const childMemoryMb = (db as any).config?.childSandboxMemoryMb ?? 1024;

    // Try to reuse an existing sandbox whose DB record is 'failed' but
    // is still running remotely, before creating a new one.
    reusedSandbox = await findReusableSandbox(conway, db);

    const tier = selectSandboxTier(childMemoryMb);

    let sandbox: { id: string };
    if (reusedSandbox) {
      sandbox = reusedSandbox;
    } else {
      sandbox = await conway.createSandbox({
        name: `automaton-child-${genesis.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
        vcpu: tier.vcpu,
        memoryMb: tier.memoryMb,
        diskGb: tier.diskGb,
      });
    }
    sandboxId = sandbox.id;

    // Create a scoped client so all exec/writeFile calls target the CHILD sandbox
    const childConway = conway.createScopedClient(sandbox.id);

    // Update sandbox ID in children table
    db.raw
      .prepare("UPDATE children SET sandbox_id = ? WHERE id = ?")
      .run(sandbox.id, childId);

    // State: sandbox_created
    lifecycle.transition(
      childId,
      "sandbox_created",
      `sandbox ${sandbox.id} created`,
    );

    // Install runtime (on the CHILD sandbox)
    await childConway.exec("apt-get update -qq && apt-get install -y -qq nodejs npm git curl", 120_000);
    await childConway.exec(
      `git clone ${repoUrl} /root/automaton && cd /root/automaton && npm install && npm run build`,
      180_000,
    );

    // Write genesis configuration (on the CHILD sandbox) — carries the tithe + repo URL
    await childConway.exec("mkdir -p /root/.automaton", 10_000);
    const genesisJson = buildChildGenesisJson(genesis, identity, repoUrl);
    await childConway.writeFile("/root/.automaton/genesis.json", genesisJson);

    // Propagate constitution with hash verification
    try {
      await propagateConstitution(childConway, sandbox.id, db.raw);
    } catch {
      // Constitution file not found locally
    }

    // State: runtime_ready
    lifecycle.transition(childId, "runtime_ready", "runtime installed");

    // Initialize child wallet (on the CHILD sandbox)
    const initResult = await childConway.exec("node /root/automaton/dist/index.js --init 2>&1", 60_000);
    // Extract child wallet address - support both EVM (0x...) and Solana (base58)
    const stdout = initResult.stdout || "";
    const evmMatch = stdout.match(/0x[a-fA-F0-9]{40}/);
    const solanaMatch = stdout.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    const parentChainType = (identity as any).chainType || "evm";
    const childWallet = parentChainType === "solana"
      ? (solanaMatch ? solanaMatch[0] : "")
      : (evmMatch ? evmMatch[0] : "");

    if (!isValidWalletAddress(childWallet, parentChainType)) {
      throw new Error(`Child wallet address invalid: ${childWallet}`);
    }

    // Update address in children table
    db.raw
      .prepare("UPDATE children SET address = ? WHERE id = ?")
      .run(childWallet, childId);

    // State: wallet_verified
    lifecycle.transition(
      childId,
      "wallet_verified",
      `wallet ${childWallet} verified`,
    );

    // Record spawn modification
    db.insertModification({
      id: ulid(),
      timestamp: new Date().toISOString(),
      type: "child_spawn",
      description: `Spawned child: ${genesis.name} in sandbox ${sandbox.id}${reusedSandbox ? " (reused)" : ""}`,
      reversible: false,
    });

    // If we reused a sandbox, update the old children record to 'cleaned_up'
    // so it doesn't get reused again.
    if (reusedSandbox) {
      db.raw.prepare(
        "UPDATE children SET status = 'cleaned_up' WHERE sandbox_id = ? AND status = 'failed'",
      ).run(sandbox.id);
    }

    const child: ChildAutomaton = {
      id: childId,
      name: genesis.name,
      address: childWallet as any,
      sandboxId: sandbox.id,
      genesisPrompt: genesis.genesisPrompt,
      creatorMessage: genesis.creatorMessage,
      fundedAmountCents: 0,
      status: "wallet_verified" as any,
      createdAt: new Date().toISOString(),
    };

    return child;
  } catch (error) {
    // Note: sandbox deletion is disabled by the Conway API (prepaid, non-refundable).
    // Failed sandboxes are left running and may be reused by findReusableSandbox().

    // Transition to failed if lifecycle has been initialized
    try {
      lifecycle.transition(
        childId,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    } catch {
      // May fail if child doesn't exist yet
    }

    throw error;
  }
}

/**
 * Legacy spawn path for backward compatibility when no lifecycle is provided.
 */
async function spawnChildLegacy(
  conway: ConwayClient,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  genesis: GenesisConfig,
  childId: string,
): Promise<ChildAutomaton> {
  let sandboxId: string | undefined;

  // Get child sandbox memory from config (default 1024MB)
  const childMemoryMb = (db as any).config?.childSandboxMemoryMb ?? 1024;

  const legacyTier = selectSandboxTier(childMemoryMb);
  const repoUrl = resolveSourceRepoUrl(genesis);
  assertSafeRepoUrl(repoUrl);

  try {
    const sandbox = await conway.createSandbox({
      name: `automaton-child-${genesis.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
      vcpu: legacyTier.vcpu,
      memoryMb: legacyTier.memoryMb,
      diskGb: legacyTier.diskGb,
    });
    sandboxId = sandbox.id;

    // Create a scoped client so all exec/writeFile calls target the CHILD sandbox
    const childConway = conway.createScopedClient(sandbox.id);

    await childConway.exec(
      "apt-get update -qq && apt-get install -y -qq nodejs npm git curl",
      120_000,
    );
    await childConway.exec(
      `git clone ${repoUrl} /root/automaton && cd /root/automaton && npm install && npm run build`,
      180_000,
    );
    await childConway.exec("mkdir -p /root/.automaton", 10_000);

    const legacyGenesisJson = buildChildGenesisJson(genesis, identity, repoUrl);
    await childConway.writeFile("/root/.automaton/genesis.json", legacyGenesisJson);

    try {
      await propagateConstitution(childConway, sandbox.id, db.raw);
    } catch {
      // Constitution file not found
    }

    const initResult = await childConway.exec("node /root/automaton/dist/index.js --init 2>&1", 60_000);
    const legacyParentChainType = genesis.chainType || (identity as any).chainType || "evm";
    const legacyEvmMatch = (initResult.stdout || "").match(/0x[a-fA-F0-9]{40}/);
    const legacySolMatch = (initResult.stdout || "").match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    const childWallet = legacyParentChainType === "solana"
      ? (legacySolMatch ? legacySolMatch[0] : "")
      : (legacyEvmMatch ? legacyEvmMatch[0] : "");

    if (!isValidWalletAddress(childWallet, legacyParentChainType)) {
      throw new Error(`Child wallet address invalid: ${childWallet}`);
    }

    const child: ChildAutomaton = {
      id: childId,
      name: genesis.name,
      address: childWallet as any,
      sandboxId: sandbox.id,
      genesisPrompt: genesis.genesisPrompt,
      creatorMessage: genesis.creatorMessage,
      fundedAmountCents: 0,
      status: "spawning",
      createdAt: new Date().toISOString(),
      chainType: legacyParentChainType as any,
    };

    db.insertChild(child);

    db.insertModification({
      id: ulid(),
      timestamp: new Date().toISOString(),
      type: "child_spawn",
      description: `Spawned child: ${genesis.name} in sandbox ${sandbox.id}`,
      reversible: false,
    });

    return child;
  } catch (error) {
    // Sandbox deletion disabled — failed sandboxes left for potential reuse.
    throw error;
  }
}

/**
 * Find a reusable sandbox: one that is marked 'failed' in the local DB
 * but is still running remotely. Returns the first match or null.
 */
async function findReusableSandbox(
  conway: ConwayClient,
  db: AutomatonDatabase,
): Promise<{ id: string } | null> {
  try {
    const failedChildren = db.getChildren().filter((c) => c.status === "failed" && c.sandboxId);
    if (failedChildren.length === 0) return null;

    const remoteSandboxes = await conway.listSandboxes();
    const runningIds = new Set(
      remoteSandboxes
        .filter((s) => s.status === "running")
        .map((s) => s.id),
    );

    for (const child of failedChildren) {
      if (runningIds.has(child.sandboxId)) {
        return { id: child.sandboxId };
      }
    }
  } catch {
    // If listing fails, just create a new sandbox
  }
  return null;
}
