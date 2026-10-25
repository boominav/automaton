/**
 * Creator Tithe — Settlement
 *
 * Rule 1: observes earnings (USDC on-chain, Conway credits) and pays the
 * creator's share to the beneficiary. Used from two places:
 *   - before every child spawn (blocking: no spawn until the tithe is paid)
 *   - from the heartbeat (observe every minute, settle on a schedule)
 */

import { ulid } from "ulid";
import type { Address } from "viem";
import type {
  AutomatonConfig,
  AutomatonDatabase,
  AutomatonIdentity,
  ConwayClient,
  TitheConfig,
} from "../types.js";
import { DEFAULT_TITHE_CONFIG } from "../types.js";
import { createLogger } from "../observability/logger.js";
import {
  computeOwed,
  describeLedger,
  loadOrCreateLedger,
  microsToUsd,
  normalizePercent,
  recordComputePayment,
  recordCreditObservation,
  recordCreditsPayment,
  recordUsdcInflow,
  recordUsdcPayment,
  saveLedger,
  usdToMicros,
  type TitheLedger,
} from "./ledger.js";
import { getCurrentBlock, scanUsdcInflows, sendUsdc } from "./chain.js";
import { isCreatorFunded } from "../compute/creator-funded.js";

const logger = createLogger("tithe");

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Resolve the effective tithe config from automaton.json plus environment
 * overrides. Returns null when the tithe is disabled or misconfigured.
 */
export function resolveTitheConfig(config: Pick<AutomatonConfig, "tithe" | "creatorAddress">): TitheConfig | null {
  const stored = config.tithe;

  const merged: TitheConfig = {
    ...DEFAULT_TITHE_CONFIG,
    beneficiaryAddress: stored?.beneficiaryAddress || config.creatorAddress,
    ...(stored ?? {}),
  };

  const envBeneficiary = process.env.AUTOMATON_TITHE_BENEFICIARY?.trim();
  if (envBeneficiary) merged.beneficiaryAddress = envBeneficiary;

  const envEarnings = Number(process.env.AUTOMATON_TITHE_EARNINGS_PERCENT);
  if (process.env.AUTOMATON_TITHE_EARNINGS_PERCENT && Number.isFinite(envEarnings)) {
    merged.earningsSharePercent = envEarnings;
  }
  const envFee = Number(process.env.AUTOMATON_TITHE_REPLICATION_FEE_PERCENT);
  if (process.env.AUTOMATON_TITHE_REPLICATION_FEE_PERCENT && Number.isFinite(envFee)) {
    merged.replicationFeePercent = envFee;
  }
  const envEnabled = process.env.AUTOMATON_TITHE_ENABLED;
  if (envEnabled) {
    merged.enabled = !["0", "false", "no", "off"].includes(envEnabled.toLowerCase());
  }

  merged.earningsSharePercent = normalizePercent(merged.earningsSharePercent);
  merged.replicationFeePercent = normalizePercent(merged.replicationFeePercent);

  if (!merged.enabled) return null;
  if (merged.earningsSharePercent === 0 && merged.replicationFeePercent === 0) return null;
  if (!merged.beneficiaryAddress || !EVM_ADDRESS_RE.test(merged.beneficiaryAddress)) {
    logger.warn("Tithe beneficiary address missing or not a valid EVM address; tithe disabled", {
      beneficiaryAddress: merged.beneficiaryAddress,
    });
    return null;
  }
  if (merged.beneficiaryAddress === "0x" + "0".repeat(40)) return null;

  return merged;
}

export interface TitheContext {
  conway: ConwayClient;
  identity: AutomatonIdentity;
  db: AutomatonDatabase;
  config: AutomatonConfig;
}

function isEvm(ctx: TitheContext): boolean {
  const chainType = ctx.config.chainType || ctx.identity.chainType || "evm";
  return chainType === "evm";
}

/** Sum of credit_purchase transactions recorded after `sinceIso` (cents). */
function selfPurchasedCreditsSince(db: AutomatonDatabase, sinceIso: string | null): number {
  if (!sinceIso) return 0;
  const since = new Date(sinceIso).getTime();
  let total = 0;
  for (const tx of db.getRecentTransactions(500)) {
    if (tx.type !== "credit_purchase") continue;
    if (new Date(tx.timestamp).getTime() <= since) continue;
    total += Math.max(0, Math.floor(tx.amountCents ?? 0));
  }
  return total;
}

/**
 * Observe inflows and update the ledger. Does not send anything.
 * `creditBalanceCents` is passed in because the heartbeat already fetched it.
 */
export async function observeInflows(
  ctx: TitheContext,
  tithe: TitheConfig,
  creditBalanceCents: number | null,
  opts: { scanChain?: boolean } = {},
): Promise<TitheLedger> {
  let ledger = loadOrCreateLedger(ctx.db);

  // Credits: delta tracking, net of our own top-ups.
  // In creator-funded mode the "credit balance" is really the USDC balance,
  // which the on-chain scan below already tithes — skip it to avoid double counting.
  if (!isCreatorFunded(ctx.config) && creditBalanceCents !== null && Number.isFinite(creditBalanceCents)) {
    const purchased = selfPurchasedCreditsSince(ctx.db, ledger.lastCreditObservationAt);
    ledger = recordCreditObservation(ledger, creditBalanceCents, purchased);
  }

  // USDC: on-chain Transfer logs from the cursor forward (EVM only).
  if (opts.scanChain !== false && isEvm(ctx)) {
    try {
      const rpcUrl = ctx.config.rpcUrl;
      if (ledger.usdcCursorBlock === null) {
        // First activation: start counting from now; earlier funds are not tithed.
        const head = await getCurrentBlock(rpcUrl);
        ledger = recordUsdcInflow(ledger, 0n, head);
      } else {
        const from = BigInt(ledger.usdcCursorBlock) + 1n;
        // Money from the creator or from our parent is capital, not earnings.
        const capitalSources = [tithe.beneficiaryAddress, ctx.config.parentAddress]
          .filter((a): a is string => !!a && EVM_ADDRESS_RE.test(a)) as Address[];
        const scan = await scanUsdcInflows(
          ctx.identity.address as Address,
          from,
          capitalSources,
          rpcUrl,
        );
        ledger = recordUsdcInflow(ledger, scan.receivedMicros, scan.scannedThroughBlock);
        if (scan.transfers > 0) {
          logger.info(`Observed ${scan.transfers} USDC inflow(s): $${microsToUsd(scan.receivedMicros).toFixed(2)}`);
        }
      }
    } catch (err) {
      logger.warn("USDC inflow scan failed; will retry next time", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  saveLedger(ctx.db, ledger);
  return ledger;
}

export interface TitheSettlementResult {
  ok: boolean;
  /** Rule 1 earnings share paid this run (USD). */
  paidUsdc: number;
  /** Rule 3 compute reimbursement paid this run (USD). */
  paidComputeUsd: number;
  paidCreditsCents: number;
  usdcTxHash?: string;
  creditsTransferId?: string;
  /** Still owed after this run (below minimums or failed). */
  remainingUsdc: number;
  remainingComputeUsd: number;
  remainingCreditsCents: number;
  errors: string[];
  summary: string;
}

/**
 * Pay whatever is owed above the configured minimums.
 * Never throws; failures are reported in `errors` and `ok === false`.
 */
export async function settleTithe(
  ctx: TitheContext,
  tithe: TitheConfig,
  reason: string,
  creditBalanceCents: number | null = null,
): Promise<TitheSettlementResult> {
  let ledger = await observeInflows(ctx, tithe, creditBalanceCents);
  const errors: string[] = [];
  let paidUsdc = 0;
  let paidComputeUsd = 0;
  let paidCreditsCents = 0;
  let usdcTxHash: string | undefined;
  let creditsTransferId: string | undefined;

  const owed = computeOwed(ledger, tithe);
  const beneficiary = tithe.beneficiaryAddress as Address;

  // ── USDC: Rule 1 earnings share + Rule 3 compute reimbursement ──
  // Both go to the same wallet, so they ride in one on-chain transfer once the
  // combined amount clears the minimum (one gas fee instead of two).
  const usdcTotal = owed.usdcMicros + owed.computeMicros;
  if (isEvm(ctx) && usdcTotal > 0n && usdcTotal >= usdToMicros(tithe.minUsdcSettlementUsd)) {
    try {
      const { txHash } = await sendUsdc(ctx.identity.account, beneficiary, usdcTotal, ctx.config.rpcUrl);
      if (owed.usdcMicros > 0n) ledger = recordUsdcPayment(ledger, owed.usdcMicros, txHash, reason);
      if (owed.computeMicros > 0n) ledger = recordComputePayment(ledger, owed.computeMicros, txHash, reason);
      saveLedger(ctx.db, ledger);
      usdcTxHash = txHash;
      paidUsdc = microsToUsd(owed.usdcMicros);
      paidComputeUsd = microsToUsd(owed.computeMicros);
      const total = microsToUsd(usdcTotal);
      ctx.db.insertTransaction({
        id: ulid(),
        type: "transfer_out",
        amountCents: Math.round(total * 100),
        description:
          `Creator payment: $${total.toFixed(4)} USDC → ${beneficiary} ` +
          `(earnings share ${tithe.earningsSharePercent}% $${paidUsdc.toFixed(4)} + compute reimbursement $${paidComputeUsd.toFixed(4)}) ` +
          `[${reason}] tx ${txHash}`,
        timestamp: new Date().toISOString(),
      });
      logger.info(
        `Tithe paid: $${total.toFixed(4)} USDC → ${beneficiary} ` +
        `(share $${paidUsdc.toFixed(4)}, compute $${paidComputeUsd.toFixed(4)}) (${txHash})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`USDC tithe failed: ${msg}`);
      logger.error("USDC tithe transfer failed", err instanceof Error ? err : undefined);
    }
  }

  // ── Conway credits ────────────────────────────────────────────
  if (owed.creditsCents >= tithe.minCreditsSettlementCents) {
    try {
      const result = await ctx.conway.transferCredits(
        beneficiary,
        owed.creditsCents,
        `creator earnings share ${tithe.earningsSharePercent}% (${reason})`,
      );
      ledger = recordCreditsPayment(ledger, owed.creditsCents, result.transferId, reason);
      saveLedger(ctx.db, ledger);
      creditsTransferId = result.transferId;
      paidCreditsCents = owed.creditsCents;
      // Our balance just dropped by the tithe; don't let the next observation
      // mistake anything for an inflow by keeping the baseline in sync.
      if (ledger.lastCreditBalanceCents !== null) {
        ledger = {
          ...ledger,
          lastCreditBalanceCents: Math.max(0, ledger.lastCreditBalanceCents - owed.creditsCents),
        };
        saveLedger(ctx.db, ledger);
      }
      ctx.db.insertTransaction({
        id: ulid(),
        type: "transfer_out",
        amountCents: owed.creditsCents,
        balanceAfterCents: result.balanceAfterCents,
        description: `Creator earnings share (${tithe.earningsSharePercent}%): ${owed.creditsCents}¢ credits → ${beneficiary} [${reason}] transfer ${result.transferId}`,
        timestamp: new Date().toISOString(),
      });
      logger.info(`Tithe paid: ${owed.creditsCents}¢ credits → ${beneficiary} (${result.transferId})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Credits tithe failed: ${msg}`);
      logger.error("Credits tithe transfer failed", err instanceof Error ? err : undefined);
    }
  }

  const remaining = computeOwed(ledger, tithe);
  const summary = describeLedger(ledger, tithe);

  return {
    ok: errors.length === 0,
    paidUsdc,
    paidComputeUsd,
    paidCreditsCents,
    usdcTxHash,
    creditsTransferId,
    remainingUsdc: microsToUsd(remaining.usdcMicros),
    remainingComputeUsd: microsToUsd(remaining.computeMicros),
    remainingCreditsCents: remaining.creditsCents,
    errors,
    summary,
  };
}

/**
 * Called before spawning a child. Settles the tithe first and throws if a
 * payment that was due could not be made — the clone waits until the creator
 * has been paid. Amounts below the minimums are carried forward, not blocking.
 */
export async function ensureTitheSettledBeforeSpawn(ctx: TitheContext): Promise<void> {
  const tithe = resolveTitheConfig(ctx.config);
  if (!tithe || !tithe.settleBeforeSpawn || tithe.earningsSharePercent === 0) return;

  let creditBalance: number | null = null;
  try {
    creditBalance = await ctx.conway.getCreditsBalance();
  } catch {
    // observeInflows tolerates a missing balance
  }

  const result = await settleTithe(ctx, tithe, "pre-spawn", creditBalance);
  if (!result.ok) {
    throw new Error(
      `Spawn blocked: creator tithe could not be settled (${result.errors.join("; ")}). ${result.summary}`,
    );
  }
  logger.info(`Pre-spawn tithe settled. ${result.summary}`);
}
