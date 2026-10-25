import { describe, it, expect, vi } from "vitest";
import {
  computeOwed,
  emptyLedger,
  loadLedger,
  loadOrCreateLedger,
  microsToUsd,
  recordCreditObservation,
  recordCreditsPayment,
  recordReplicationFee,
  recordUsdcInflow,
  recordUsdcPayment,
  replicationFeeFor,
  shareOf,
  usdToMicros,
  TITHE_LEDGER_KEY,
} from "../tithe/ledger.js";
import { resolveTitheConfig } from "../tithe/settle.js";
import { fundChildWithFee, quoteReplicationFee, isChildAddress } from "../tithe/funding.js";
import type { TitheConfig } from "../types.js";

const BEN = "0x1111111111111111111111111111111111111111";
const CHILD = "0x3333333333333333333333333333333333333333";

const fullTithe = (over: Partial<TitheConfig> = {}): TitheConfig => ({
  enabled: true,
  beneficiaryAddress: BEN,
  earningsSharePercent: 1,
  replicationFeePercent: 10,
  minUsdcSettlementUsd: 0.5,
  minCreditsSettlementCents: 50,
  settleBeforeSpawn: true,
  ...over,
});

function memoryDb() {
  const kv = new Map<string, string>();
  const transactions: any[] = [];
  return {
    kv,
    transactions,
    getKV: (k: string) => kv.get(k),
    setKV: (k: string, v: string) => void kv.set(k, v),
    insertTransaction: (t: any) => void transactions.push(t),
    getChildren: () => [{ address: CHILD, status: "healthy" }] as any,
  };
}

describe("Rule 1 — earnings share ledger", () => {
  it("owes exactly 1% of USDC earnings", () => {
    let ledger = emptyLedger();
    ledger = recordUsdcInflow(ledger, usdToMicros(100), 1000n);
    const owed = computeOwed(ledger, { earningsSharePercent: 1 });
    expect(microsToUsd(owed.usdcMicros)).toBeCloseTo(1, 6);
    expect(owed.creditsCents).toBe(0);
  });

  it("subtracts what has already been paid and keeps the scan cursor", () => {
    let ledger = emptyLedger();
    ledger = recordUsdcInflow(ledger, usdToMicros(100), 1000n);
    ledger = recordUsdcPayment(ledger, usdToMicros(1), "0xabc", "test");
    expect(computeOwed(ledger, { earningsSharePercent: 1 }).usdcMicros).toBe(0n);

    ledger = recordUsdcInflow(ledger, usdToMicros(50), 2000n);
    expect(microsToUsd(computeOwed(ledger, { earningsSharePercent: 1 }).usdcMicros)).toBeCloseTo(0.5, 6);
    expect(ledger.usdcCursorBlock).toBe("2000");
    expect(ledger.history).toHaveLength(1);
  });

  it("treats credit balance increases as earnings and ignores spending", () => {
    let ledger = emptyLedger();
    ledger = recordCreditObservation(ledger, 1000, 0); // baseline
    ledger = recordCreditObservation(ledger, 1500, 0); // +500 earned
    ledger = recordCreditObservation(ledger, 1200, 0); // spent 300
    ledger = recordCreditObservation(ledger, 2200, 0); // +1000 earned
    expect(ledger.creditsReceivedCents).toBe(1500);
    expect(computeOwed(ledger, { earningsSharePercent: 1 }).creditsCents).toBe(15);
  });

  it("does not count credits the automaton bought with its own USDC", () => {
    let ledger = emptyLedger();
    ledger = recordCreditObservation(ledger, 0, 0);
    ledger = recordCreditObservation(ledger, 2000, 2000); // pure self top-up
    expect(ledger.creditsReceivedCents).toBe(0);
    ledger = recordCreditObservation(ledger, 3000, 300); // 700 earned + 300 top-up
    expect(ledger.creditsReceivedCents).toBe(700);
  });

  it("records credit payments and never reports negative owed", () => {
    let ledger = emptyLedger();
    ledger = recordCreditObservation(ledger, 0, 0);
    ledger = recordCreditObservation(ledger, 10_000, 0);
    ledger = recordCreditsPayment(ledger, 100, "tr_1", "pre-spawn");
    expect(computeOwed(ledger, { earningsSharePercent: 1 }).creditsCents).toBe(0);
    expect(computeOwed(ledger, { earningsSharePercent: 0.5 }).creditsCents).toBe(0);
  });

  it("rounds shares down and clamps percent", () => {
    expect(shareOf(999, 1)).toBe(9);
    expect(shareOf(1000n, 12.5)).toBe(125n);
    expect(shareOf(1000, 150)).toBe(1000);
    expect(shareOf(1000, -5)).toBe(0);
  });

  it("persists through a KV store and upgrades old records", () => {
    const db = memoryDb();
    const first = loadOrCreateLedger(db);
    expect(db.kv.has(TITHE_LEDGER_KEY)).toBe(true);
    expect(loadOrCreateLedger(db).activatedAt).toBe(first.activatedAt);

    // A ledger written before the replication-fee fields existed still loads.
    const { childFundingSentCents: _a, replicationFeesPaidCents: _b, ...old } = first;
    db.setKV(TITHE_LEDGER_KEY, JSON.stringify(old));
    const upgraded = loadLedger(db)!;
    expect(upgraded.childFundingSentCents).toBe(0);
    expect(upgraded.replicationFeesPaidCents).toBe(0);
  });
});

describe("Rule 2 — replication fee", () => {
  it("charges 10% of the funding amount, rounded up", () => {
    expect(replicationFeeFor(1000, 10)).toBe(100);
    expect(replicationFeeFor(999, 10)).toBe(100);
    expect(replicationFeeFor(5, 10)).toBe(1);
    expect(replicationFeeFor(0, 10)).toBe(0);
    expect(replicationFeeFor(1000, 0)).toBe(0);
    expect(quoteReplicationFee(null, 1000)).toBe(0);
    expect(quoteReplicationFee(fullTithe(), 1000)).toBe(100);
  });

  it("sends the fee to the creator BEFORE funding the child, child gets the full amount", async () => {
    const calls: Array<{ to: string; amount: number }> = [];
    const conway = {
      transferCredits: vi.fn(async (to: string, amount: number) => {
        calls.push({ to, amount });
        return { transferId: `tr_${calls.length}`, status: "completed", toAddress: to, amountCents: amount };
      }),
    } as any;
    const db = memoryDb();

    const result = await fundChildWithFee({
      conway,
      db: db as any,
      tithe: fullTithe(),
      childAddress: CHILD,
      amountCents: 1000,
    });

    expect(calls).toEqual([
      { to: BEN, amount: 100 },
      { to: CHILD, amount: 1000 },
    ]);
    expect(result.feeCents).toBe(100);
    expect(result.feeTransferId).toBe("tr_1");
    expect(result.transfer.transferId).toBe("tr_2");

    const ledger = loadLedger(db)!;
    expect(ledger.childFundingSentCents).toBe(1000);
    expect(ledger.replicationFeesPaidCents).toBe(100);
    expect(ledger.history[0].kind).toBe("replication_fee");
    expect(db.transactions).toHaveLength(1);
    expect(db.transactions[0].amountCents).toBe(100);
  });

  it("does not fund the child when the fee cannot be sent", async () => {
    const conway = {
      transferCredits: vi.fn(async (to: string) => {
        if (to === BEN) throw new Error("insufficient credits");
        return { transferId: "tr_child", status: "completed", toAddress: to, amountCents: 1000 };
      }),
    } as any;
    const db = memoryDb();

    await expect(
      fundChildWithFee({ conway, db: db as any, tithe: fullTithe(), childAddress: CHILD, amountCents: 1000 }),
    ).rejects.toThrow(/replication fee/);
    expect(conway.transferCredits).toHaveBeenCalledTimes(1);
    expect(conway.transferCredits.mock.calls[0][0]).toBe(BEN);
  });

  it("does not fund the child when the fee transfer reports failure", async () => {
    const conway = {
      transferCredits: vi.fn(async (to: string, amount: number) => ({
        transferId: "x",
        status: to === BEN ? "failed" : "completed",
        toAddress: to,
        amountCents: amount,
      })),
    } as any;
    await expect(
      fundChildWithFee({ conway, db: memoryDb() as any, tithe: fullTithe(), childAddress: CHILD, amountCents: 1000 }),
    ).rejects.toThrow(/status "failed"/);
    expect(conway.transferCredits).toHaveBeenCalledTimes(1);
  });

  it("skips the fee when the tithe is off", async () => {
    const conway = {
      transferCredits: vi.fn(async (to: string, amount: number) => ({
        transferId: "t", status: "completed", toAddress: to, amountCents: amount,
      })),
    } as any;
    const result = await fundChildWithFee({ conway, db: memoryDb() as any, tithe: null, childAddress: CHILD, amountCents: 1000 });
    expect(result.feeCents).toBe(0);
    expect(conway.transferCredits).toHaveBeenCalledTimes(1);
    expect(conway.transferCredits.mock.calls[0][0]).toBe(CHILD);
  });

  it("recognises child addresses case-insensitively", () => {
    const db = memoryDb();
    expect(isChildAddress(db as any, CHILD.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isChildAddress(db as any, BEN)).toBe(false);
  });

  it("keeps the credit baseline in sync after fee + funding leave the balance", () => {
    let ledger = emptyLedger();
    ledger = recordCreditObservation(ledger, 5000, 0);
    ledger = recordReplicationFee(ledger, 1000, 100, "tr", CHILD);
    expect(ledger.lastCreditBalanceCents).toBe(3900);
    // Next observation at the real post-funding balance sees no phantom inflow.
    ledger = recordCreditObservation(ledger, 3900, 0);
    expect(ledger.creditsReceivedCents).toBe(0);
  });
});

describe("resolveTitheConfig", () => {
  it("defaults to the creator address, 1% earnings, 10% replication fee", () => {
    const resolved = resolveTitheConfig({ creatorAddress: BEN });
    expect(resolved).not.toBeNull();
    expect(resolved!.beneficiaryAddress).toBe(BEN);
    expect(resolved!.earningsSharePercent).toBe(1);
    expect(resolved!.replicationFeePercent).toBe(10);
    expect(resolved!.settleBeforeSpawn).toBe(true);
  });

  it("returns null when disabled or when both rules are 0%", () => {
    expect(resolveTitheConfig({ creatorAddress: BEN, tithe: fullTithe({ enabled: false }) })).toBeNull();
    expect(
      resolveTitheConfig({ creatorAddress: BEN, tithe: fullTithe({ earningsSharePercent: 0, replicationFeePercent: 0 }) }),
    ).toBeNull();
    // One rule alone keeps it on.
    expect(resolveTitheConfig({ creatorAddress: BEN, tithe: fullTithe({ earningsSharePercent: 0 }) })).not.toBeNull();
  });

  it("rejects an invalid beneficiary", () => {
    expect(resolveTitheConfig({ creatorAddress: "not-an-address" })).toBeNull();
  });

  it("keeps the root beneficiary over a child's creator (its parent)", () => {
    const parentWallet = "0x2222222222222222222222222222222222222222";
    const resolved = resolveTitheConfig({ creatorAddress: parentWallet, tithe: fullTithe() });
    expect(resolved!.beneficiaryAddress).toBe(BEN);
  });
});
