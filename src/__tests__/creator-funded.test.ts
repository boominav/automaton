import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeOwed,
  emptyLedger,
  loadLedger,
  loadOrCreateLedger,
  microsToUsd,
  recordComputeCost,
  recordComputePayment,
  recordUsdcInflow,
  saveLedger,
  usdToMicros,
  TITHE_LEDGER_KEY,
} from "../tithe/ledger.js";
import {
  ANTHROPIC_DEFAULT_MODELS,
  applyCreatorFundedModelDefaults,
  creatorFundedBalanceCents,
  isCreatorFunded,
  isCreatorFundedActive,
  setCreatorFundedActive,
  wrapConwayClient,
  wrapInferenceClient,
} from "../compute/creator-funded.js";
import type { AutomatonConfig, InferenceClient, InferenceResponse } from "../types.js";

vi.mock("../conway/x402.js", () => ({
  getUsdcBalance: vi.fn(async () => 20), // $20 USDC in the wallet
}));

function kvDb() {
  const kv = new Map<string, string>();
  return {
    getKV: (k: string) => kv.get(k) ?? null,
    setKV: (k: string, v: string) => void kv.set(k, v),
    deleteKV: (k: string) => void kv.delete(k),
  } as any;
}

const baseConfig = (over: Partial<AutomatonConfig> = {}): AutomatonConfig =>
  ({
    conwayApiKey: "",
    modelStrategy: {
      inferenceModel: "gpt-5.2",
      lowComputeModel: "gpt-5-mini",
      criticalModel: "gpt-5-mini",
      maxTokensPerTurn: 4096,
      hourlyBudgetCents: 0,
      sessionBudgetCents: 0,
      perCallCeilingCents: 0,
      enableModelFallback: true,
      anthropicApiVersion: "2023-06-01",
    },
    inferenceModel: "gpt-5.2",
    ...over,
  }) as unknown as AutomatonConfig;

describe("Rule 3 — creator-funded compute ledger", () => {
  it("accumulates compute cost and owes it on top of the earnings share", () => {
    let ledger = emptyLedger();
    ledger = recordUsdcInflow(ledger, usdToMicros(100), 1000n); // earned $100 → 1% = $1
    ledger = recordComputeCost(ledger, usdToMicros(0.25));
    ledger = recordComputeCost(ledger, usdToMicros(0.05));
    const owed = computeOwed(ledger, { earningsSharePercent: 1 });
    expect(microsToUsd(owed.usdcMicros)).toBeCloseTo(1, 6);
    expect(microsToUsd(owed.computeMicros)).toBeCloseTo(0.3, 6);
  });

  it("ignores zero or negative cost", () => {
    const ledger = recordComputeCost(recordComputeCost(emptyLedger(), 0n), -5n);
    expect(ledger.computeCostMicros).toBe("0");
  });

  it("subtracts reimbursements and records them in history", () => {
    let ledger = recordComputeCost(emptyLedger(), usdToMicros(0.3));
    ledger = recordComputePayment(ledger, usdToMicros(0.3), "0xtx", "daily");
    expect(computeOwed(ledger, { earningsSharePercent: 1 }).computeMicros).toBe(0n);
    expect(ledger.history.at(-1)).toMatchObject({ kind: "compute", reference: "0xtx" });
  });

  it("old ledgers without Rule 3 fields load with zeros", () => {
    const db = kvDb();
    const old = { ...emptyLedger() } as any;
    delete old.computeCostMicros;
    delete old.computePaidMicros;
    db.setKV(TITHE_LEDGER_KEY, JSON.stringify(old));
    const loaded = loadLedger(db)!;
    expect(loaded.computeCostMicros).toBe("0");
    expect(loaded.computePaidMicros).toBe("0");
  });
});

describe("Rule 3 — mode detection and defaults", () => {
  it("is off with a Conway key and no override", () => {
    expect(isCreatorFunded({ conwayApiKey: "cnwy_k_abc", anthropicApiKey: "sk-ant-x" })).toBe(false);
  });

  it("is on with no Conway key but an Anthropic key", () => {
    expect(isCreatorFunded({ conwayApiKey: "", anthropicApiKey: "sk-ant-x" })).toBe(true);
  });

  it("is off with no keys at all", () => {
    expect(isCreatorFunded({ conwayApiKey: "" })).toBe(false);
  });

  it("honours an explicit computeProvider", () => {
    expect(isCreatorFunded({ computeProvider: "creator", conwayApiKey: "cnwy_k_abc" })).toBe(true);
    expect(isCreatorFunded({ computeProvider: "conway", conwayApiKey: "", anthropicApiKey: "sk-ant-x" })).toBe(false);
  });

  it("swaps the OpenAI default models for Claude when only an Anthropic key is set", () => {
    const config = baseConfig({ anthropicApiKey: "sk-ant-x" });
    expect(applyCreatorFundedModelDefaults(config)).toBe(true);
    expect(config.modelStrategy?.inferenceModel).toBe(ANTHROPIC_DEFAULT_MODELS.inferenceModel);
    expect(config.modelStrategy?.lowComputeModel).toBe(ANTHROPIC_DEFAULT_MODELS.lowComputeModel);
    expect(config.inferenceModel).toBe(ANTHROPIC_DEFAULT_MODELS.inferenceModel);
  });

  it("leaves models alone when the creator picked their own or has an OpenAI key", () => {
    const custom = baseConfig({ anthropicApiKey: "sk-ant-x" });
    custom.modelStrategy!.inferenceModel = "claude-opus-5-5";
    custom.modelStrategy!.lowComputeModel = "claude-haiku-5-5";
    custom.modelStrategy!.criticalModel = "claude-haiku-5-5";
    custom.inferenceModel = "claude-opus-5-5";
    expect(applyCreatorFundedModelDefaults(custom)).toBe(false);
    expect(custom.modelStrategy?.inferenceModel).toBe("claude-opus-5-5");

    const openai = baseConfig({ anthropicApiKey: "sk-ant-x", openaiApiKey: "sk-x" });
    expect(applyCreatorFundedModelDefaults(openai)).toBe(false);
    expect(openai.modelStrategy?.inferenceModel).toBe("gpt-5.2");
  });
});

describe("Rule 3 — survival balance and wrapped clients", () => {
  beforeEach(() => setCreatorFundedActive(false));

  it("survival balance is USDC minus unpaid compute", async () => {
    const db = kvDb();
    saveLedger(db, recordComputeCost(loadOrCreateLedger(db), usdToMicros(2.5)));
    const cents = await creatorFundedBalanceCents({ db, address: "0xabc", chainType: "evm" });
    expect(cents).toBe(1750); // $20 − $2.50
  });

  it("goes negative (dead tier) when debt exceeds the wallet", async () => {
    const db = kvDb();
    saveLedger(db, recordComputeCost(loadOrCreateLedger(db), usdToMicros(25)));
    const cents = await creatorFundedBalanceCents({ db, address: "0xabc", chainType: "evm" });
    expect(cents).toBeLessThan(0);
  });

  it("wrapped Conway client answers balance from the wallet and never registers", async () => {
    const db = kvDb();
    const registerAutomaton = vi.fn();
    const getCreditsBalance = vi.fn(async () => 999_999);
    const conway = wrapConwayClient({ registerAutomaton, getCreditsBalance, exec: vi.fn() } as any, {
      db,
      address: "0xabc",
      chainType: "evm",
    });
    expect(await conway.getCreditsBalance()).toBe(2000);
    await conway.registerAutomaton({} as any);
    expect(registerAutomaton).not.toHaveBeenCalled();
    expect(getCreditsBalance).not.toHaveBeenCalled();
    await expect(conway.transferCredits("0x1", 1, "x")).rejects.toThrow(/creator-funded/);
  });

  it("wrapped inference client prices each call from the registry into the ledger", async () => {
    const db = kvDb();
    const response: InferenceResponse = {
      id: "r1",
      model: "claude-sonnet-5-5",
      message: { role: "assistant", content: "hi" },
      usage: { promptTokens: 10_000, completionTokens: 1_000, totalTokens: 11_000 },
      finishReason: "stop",
    };
    const inner: InferenceClient = {
      chat: vi.fn(async () => response),
      setLowComputeMode: vi.fn(),
      getDefaultModel: () => "claude-sonnet-5-5",
    };
    const registry = {
      get: (id: string) =>
        id === "claude-sonnet-5-5" ? { modelId: id, costPer1kInput: 20, costPer1kOutput: 100 } : undefined,
    } as any;
    const wrapped = wrapInferenceClient(inner, registry, db);
    const out = await wrapped.chat([{ role: "user", content: "hi" }]);
    expect(out).toBe(response);
    // 10k input @ $2/M = $0.02; 1k output @ $10/M = $0.01 → $0.03
    const owed = computeOwed(loadOrCreateLedger(db), { earningsSharePercent: 1 });
    expect(microsToUsd(owed.computeMicros)).toBeCloseTo(0.03, 6);
  });

  it("process flag toggles", () => {
    expect(isCreatorFundedActive()).toBe(false);
    setCreatorFundedActive(true);
    expect(isCreatorFundedActive()).toBe(true);
  });
});
