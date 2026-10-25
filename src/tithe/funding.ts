/**
 * Creator Tithe — Rule 2: Replication fee
 *
 * Whenever an automaton prepares to fund a child, it first sends the creator
 * a fee of `replicationFeePercent` of the amount it is about to send. The fee
 * is paid on top of the funding (the child still receives the full amount),
 * and the funding is only sent once the fee has gone through.
 *
 * Every path that moves credits to a child goes through fundChildWithFee():
 *   - the agent's fund_child tool
 *   - transfer_credits when the recipient is one of our children
 *   - the orchestrator's funding protocol (task funding, auto top-ups)
 */

import { ulid } from "ulid";
import type { AutomatonDatabase, ConwayClient, CreditTransferResult, TitheConfig } from "../types.js";
import { createLogger } from "../observability/logger.js";
import { loadOrCreateLedger, recordReplicationFee, replicationFeeFor, saveLedger } from "./ledger.js";

const logger = createLogger("tithe.funding");

export interface FundChildWithFeeParams {
  conway: ConwayClient;
  db: AutomatonDatabase;
  /** Resolved tithe config, or null when the tithe is off (fee skipped). */
  tithe: TitheConfig | null;
  childAddress: string;
  amountCents: number;
  note?: string;
}

export interface FundChildWithFeeResult {
  /** The funding transfer to the child. */
  transfer: CreditTransferResult;
  /** Fee paid to the creator before the funding (0 when the tithe is off). */
  feeCents: number;
  feeTransferId?: string;
}

/** Quote the fee that would be charged on a funding amount. */
export function quoteReplicationFee(tithe: TitheConfig | null, amountCents: number): number {
  if (!tithe) return 0;
  return replicationFeeFor(amountCents, tithe.replicationFeePercent);
}

/**
 * Send the creator's replication fee, then fund the child.
 * Throws if the fee cannot be sent — the child is not funded in that case.
 */
export async function fundChildWithFee(params: FundChildWithFeeParams): Promise<FundChildWithFeeResult> {
  const { conway, db, tithe, childAddress } = params;
  const amount = Math.max(0, Math.floor(params.amountCents));
  if (amount === 0) {
    throw new Error("Funding amount must be positive");
  }

  const fee = quoteReplicationFee(tithe, amount);
  let feeTransferId: string | undefined;

  if (tithe && fee > 0) {
    let feeResult: CreditTransferResult;
    try {
      feeResult = await conway.transferCredits(
        tithe.beneficiaryAddress,
        fee,
        `creator replication fee ${tithe.replicationFeePercent}% on ${amount}¢ funding of ${childAddress}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Child funding blocked: replication fee of ${fee}¢ to ${tithe.beneficiaryAddress} failed (${msg})`);
    }
    if (!isTransferOk(feeResult.status)) {
      throw new Error(
        `Child funding blocked: replication fee of ${fee}¢ to ${tithe.beneficiaryAddress} returned status "${feeResult.status}"`,
      );
    }
    feeTransferId = feeResult.transferId;

    db.insertTransaction({
      id: ulid(),
      type: "transfer_out",
      amountCents: fee,
      balanceAfterCents: feeResult.balanceAfterCents,
      description: `Creator replication fee (${tithe.replicationFeePercent}% of ${amount}¢ for ${childAddress}) → ${tithe.beneficiaryAddress} transfer ${feeResult.transferId}`,
      timestamp: new Date().toISOString(),
    });
    logger.info(`Replication fee paid: ${fee}¢ → ${tithe.beneficiaryAddress} before funding ${childAddress} with ${amount}¢`);
  }

  // Fee is through (or not applicable): now fund the child.
  const transfer = await conway.transferCredits(childAddress, amount, params.note ?? "Child funding");

  if (tithe) {
    const ledger = recordReplicationFee(loadOrCreateLedger(db), amount, fee, feeTransferId ?? "n/a", childAddress);
    saveLedger(db, ledger);
  }

  return { transfer, feeCents: fee, feeTransferId };
}

/** Is `address` one of this automaton's children (any status)? */
export function isChildAddress(db: Pick<AutomatonDatabase, "getChildren">, address: string): boolean {
  const target = address.toLowerCase();
  return db.getChildren().some((c) => (c.address as string | undefined)?.toLowerCase() === target);
}

function isTransferOk(status: string | undefined): boolean {
  if (!status) return true;
  const s = status.toLowerCase();
  return !["failed", "rejected", "error", "denied", "cancelled", "canceled"].includes(s);
}
