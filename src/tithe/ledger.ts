/**
 * Creator Tithe — Ledger
 *
 * Rule 1: tracks everything this automaton's wallet has earned (USDC on-chain and
 * Conway credits) and how much of the creator's share has already been paid.
 * Rule 2: tracks child funding sent and the replication fees paid on it.
 * Pure functions over a small JSON record stored in the KV table, so the math
 * is unit-testable without a chain or a database.
 *
 * Amounts are kept as integers to avoid float drift:
 *   - USDC in micro-units (6 decimals), serialized as decimal strings (bigint)
 *   - Conway credits in cents
 */

import type { AutomatonDatabase, TitheConfig } from "../types.js";

export const TITHE_LEDGER_KEY = "tithe_ledger";
export const USDC_MICROS_PER_USD = 1_000_000n;

export interface TitheSettlementRecord {
  at: string;
  kind: "usdc" | "credits" | "replication_fee";
  /** Micros for usdc, cents for credits. */
  amount: string;
  reference: string; // tx hash or transfer id
  reason: string;
}

export interface TitheLedger {
  version: 1;
  activatedAt: string;
  /** Total USDC received (micros, bigint string), excluding transfers from the beneficiary. */
  usdcReceivedMicros: string;
  /** Total USDC paid to the beneficiary as tithe (micros, bigint string). */
  usdcPaidMicros: string;
  /** Last fully scanned block for USDC inflows (bigint string). Null until first scan. */
  usdcCursorBlock: string | null;
  /** Total Conway credits observed arriving (cents), net of the automaton's own top-ups. */
  creditsReceivedCents: number;
  /** Total Conway credits paid to the beneficiary as tithe (cents). */
  creditsPaidCents: number;
  /** Last observed credit balance (cents) and when, for delta tracking. */
  lastCreditBalanceCents: number | null;
  lastCreditObservationAt: string | null;
  /** Rule 2: total child funding this automaton has sent (cents) and the fees paid on it. */
  childFundingSentCents: number;
  replicationFeesPaidCents: number;
  /** Most recent settlements, newest last (capped). */
  history: TitheSettlementRecord[];
}

const HISTORY_CAP = 50;

export function emptyLedger(now: Date = new Date()): TitheLedger {
  return {
    version: 1,
    activatedAt: now.toISOString(),
    usdcReceivedMicros: "0",
    usdcPaidMicros: "0",
    usdcCursorBlock: null,
    creditsReceivedCents: 0,
    creditsPaidCents: 0,
    lastCreditBalanceCents: null,
    lastCreditObservationAt: null,
    childFundingSentCents: 0,
    replicationFeesPaidCents: 0,
    history: [],
  };
}

export function loadLedger(db: Pick<AutomatonDatabase, "getKV">): TitheLedger | null {
  const raw = db.getKV(TITHE_LEDGER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1) {
      // Fill fields added after the first release.
      return { ...emptyLedger(), ...parsed } as TitheLedger;
    }
  } catch {
    // fall through
  }
  return null;
}

export function saveLedger(db: Pick<AutomatonDatabase, "setKV">, ledger: TitheLedger): void {
  db.setKV(TITHE_LEDGER_KEY, JSON.stringify(ledger));
}

export function loadOrCreateLedger(
  db: Pick<AutomatonDatabase, "getKV" | "setKV">,
  now: Date = new Date(),
): TitheLedger {
  const existing = loadLedger(db);
  if (existing) return existing;
  const fresh = emptyLedger(now);
  saveLedger(db, fresh);
  return fresh;
}

/** Validate and clamp the percent to something sane (0..100). */
export function normalizePercent(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0) return 0;
  if (percent > 100) return 100;
  return percent;
}

/**
 * Share of an integer amount owed at `percent`, rounded down.
 * Works for both bigint micros and number cents.
 */
export function shareOf(amount: bigint, percent: number): bigint;
export function shareOf(amount: number, percent: number): number;
export function shareOf(amount: bigint | number, percent: number): bigint | number {
  const p = normalizePercent(percent);
  // Represent percent with 4 decimals of precision (e.g. 12.3456%).
  const pScaled = BigInt(Math.round(p * 10_000));
  if (typeof amount === "bigint") {
    return (amount * pScaled) / 1_000_000n;
  }
  return Number((BigInt(Math.max(0, Math.floor(amount))) * pScaled) / 1_000_000n);
}

export interface TitheOwed {
  usdcMicros: bigint;
  creditsCents: number;
}

/** Rule 1: how much of the earnings share is owed right now, after what was already paid. */
export function computeOwed(ledger: TitheLedger, config: Pick<TitheConfig, "earningsSharePercent">): TitheOwed {
  const pct = config.earningsSharePercent;
  const usdcDue = shareOf(BigInt(ledger.usdcReceivedMicros), pct) - BigInt(ledger.usdcPaidMicros);
  const creditsDue = shareOf(ledger.creditsReceivedCents, pct) - ledger.creditsPaidCents;
  return {
    usdcMicros: usdcDue > 0n ? usdcDue : 0n,
    creditsCents: creditsDue > 0 ? creditsDue : 0,
  };
}

/** Record USDC that arrived on-chain and advance the scan cursor. */
export function recordUsdcInflow(
  ledger: TitheLedger,
  receivedMicros: bigint,
  scannedThroughBlock: bigint,
): TitheLedger {
  return {
    ...ledger,
    usdcReceivedMicros: (BigInt(ledger.usdcReceivedMicros) + (receivedMicros > 0n ? receivedMicros : 0n)).toString(),
    usdcCursorBlock: scannedThroughBlock.toString(),
  };
}

/**
 * Record a credit-balance observation. Any increase since the last observation
 * is treated as an inflow, minus credits the automaton bought itself with its
 * own USDC in the meantime (those were already tithed as USDC when they arrived).
 *
 * Decreases are spending and are ignored. A spend and a receipt inside the same
 * interval net against each other, so this slightly undercounts; the heartbeat
 * observes every minute, which keeps that error small.
 */
export function recordCreditObservation(
  ledger: TitheLedger,
  balanceCents: number,
  selfPurchasedSinceLastCents: number,
  now: Date = new Date(),
): TitheLedger {
  const balance = Math.max(0, Math.floor(balanceCents));
  const purchased = Math.max(0, Math.floor(selfPurchasedSinceLastCents));
  let received = ledger.creditsReceivedCents;

  if (ledger.lastCreditBalanceCents !== null) {
    const delta = balance - ledger.lastCreditBalanceCents;
    const inflow = delta - purchased;
    if (inflow > 0) received += inflow;
  }

  return {
    ...ledger,
    creditsReceivedCents: received,
    lastCreditBalanceCents: balance,
    lastCreditObservationAt: now.toISOString(),
  };
}

export function recordUsdcPayment(
  ledger: TitheLedger,
  paidMicros: bigint,
  txHash: string,
  reason: string,
  now: Date = new Date(),
): TitheLedger {
  return pushHistory(
    {
      ...ledger,
      usdcPaidMicros: (BigInt(ledger.usdcPaidMicros) + paidMicros).toString(),
    },
    { at: now.toISOString(), kind: "usdc", amount: paidMicros.toString(), reference: txHash, reason },
  );
}

export function recordCreditsPayment(
  ledger: TitheLedger,
  paidCents: number,
  transferId: string,
  reason: string,
  now: Date = new Date(),
): TitheLedger {
  return pushHistory(
    {
      ...ledger,
      creditsPaidCents: ledger.creditsPaidCents + Math.max(0, Math.floor(paidCents)),
    },
    { at: now.toISOString(), kind: "credits", amount: String(Math.floor(paidCents)), reference: transferId, reason },
  );
}

/** Rule 2: record a child funding and the fee that was paid on it first. */
export function recordReplicationFee(
  ledger: TitheLedger,
  fundingCents: number,
  feeCents: number,
  transferId: string,
  childAddress: string,
  now: Date = new Date(),
): TitheLedger {
  const funding = Math.max(0, Math.floor(fundingCents));
  const fee = Math.max(0, Math.floor(feeCents));
  return pushHistory(
    {
      ...ledger,
      childFundingSentCents: ledger.childFundingSentCents + funding,
      replicationFeesPaidCents: ledger.replicationFeesPaidCents + fee,
      // The fee and the funding both leave our balance; keep the delta baseline in sync
      // so the next observation doesn't treat anything as an inflow.
      lastCreditBalanceCents:
        ledger.lastCreditBalanceCents === null
          ? null
          : Math.max(0, ledger.lastCreditBalanceCents - funding - fee),
    },
    { at: now.toISOString(), kind: "replication_fee", amount: String(fee), reference: transferId, reason: `funding ${childAddress}` },
  );
}

/** Rule 2: fee owed on a funding amount (rounded up so the creator never loses a cent). */
export function replicationFeeFor(fundingCents: number, percent: number): number {
  const p = normalizePercent(percent);
  const funding = Math.max(0, Math.floor(fundingCents));
  if (funding === 0 || p === 0) return 0;
  return Math.ceil((funding * p) / 100);
}

function pushHistory(ledger: TitheLedger, record: TitheSettlementRecord): TitheLedger {
  const history = [...ledger.history, record];
  return { ...ledger, history: history.slice(-HISTORY_CAP) };
}

export function microsToUsd(micros: bigint): number {
  return Number(micros) / Number(USDC_MICROS_PER_USD);
}

export function usdToMicros(usd: number): bigint {
  return BigInt(Math.round(usd * Number(USDC_MICROS_PER_USD)));
}

/** Human-readable one-liner for logs and the agent's context. */
export function describeLedger(
  ledger: TitheLedger,
  config: Pick<TitheConfig, "earningsSharePercent" | "replicationFeePercent">,
): string {
  const owed = computeOwed(ledger, config);
  return (
    `earnings share ${config.earningsSharePercent}% — earned $${microsToUsd(BigInt(ledger.usdcReceivedMicros)).toFixed(2)} USDC ` +
    `+ ${(ledger.creditsReceivedCents / 100).toFixed(2)} credits; ` +
    `paid $${microsToUsd(BigInt(ledger.usdcPaidMicros)).toFixed(2)} USDC ` +
    `+ ${(ledger.creditsPaidCents / 100).toFixed(2)} credits; ` +
    `owed $${microsToUsd(owed.usdcMicros).toFixed(2)} USDC + ${(owed.creditsCents / 100).toFixed(2)} credits. ` +
    `replication fee ${config.replicationFeePercent}% — funded children ${(ledger.childFundingSentCents / 100).toFixed(2)} credits, ` +
    `fees paid ${(ledger.replicationFeesPaidCents / 100).toFixed(2)} credits`
  );
}
