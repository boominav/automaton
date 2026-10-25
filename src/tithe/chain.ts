/**
 * Creator Tithe — On-chain helpers (Base mainnet USDC)
 *
 * - scanUsdcInflows: read ERC-20 Transfer logs into the automaton's wallet
 *   from a cursor block forward, excluding transfers from capital sources
 *   (the creator funding their own agent, or a parent funding its child).
 * - sendUsdc: ERC-20 transfer to the beneficiary with a gas preflight.
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbiItem,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { base } from "viem/chains";

export const BASE_USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_NETWORK_ID = "eip155:8453";

/** Base produces a block every ~2s; public RPCs reject very wide getLogs ranges. */
const LOG_CHUNK_BLOCKS = 5_000n;
/** Max chunks per scan so one heartbeat tick never runs away (≈100k blocks ≈ 2.3 days). */
const MAX_CHUNKS_PER_SCAN = 20;

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const ERC20_TRANSFER_ABI = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

function resolveRpcUrl(rpcUrl?: string): string | undefined {
  return rpcUrl || process.env.AUTOMATON_RPC_URL || undefined;
}

function publicClient(rpcUrl?: string) {
  return createPublicClient({
    chain: base,
    transport: http(resolveRpcUrl(rpcUrl), { timeout: 15_000 }),
  });
}

export async function getCurrentBlock(rpcUrl?: string): Promise<bigint> {
  return publicClient(rpcUrl).getBlockNumber();
}

export interface UsdcInflowScan {
  /** Sum of USDC received in the scanned range (micros). */
  receivedMicros: bigint;
  /** Last block fully covered by this scan. */
  scannedThroughBlock: bigint;
  /** True when the scan stopped at MAX_CHUNKS before reaching the chain head. */
  partial: boolean;
  transfers: number;
}

/**
 * Scan USDC Transfer logs where `to` is the wallet, from `fromBlock` (inclusive)
 * to the current head, in bounded chunks. Transfers from any `excludeFrom`
 * address are skipped (capital, not earnings).
 */
export async function scanUsdcInflows(
  wallet: Address,
  fromBlock: bigint,
  excludeFrom: Address[] = [],
  rpcUrl?: string,
): Promise<UsdcInflowScan> {
  const client = publicClient(rpcUrl);
  const head = await client.getBlockNumber();

  if (fromBlock > head) {
    return { receivedMicros: 0n, scannedThroughBlock: head, partial: false, transfers: 0 };
  }

  const exclude = new Set(excludeFrom.map((a) => a.toLowerCase()));
  let received = 0n;
  let transfers = 0;
  let cursor = fromBlock;
  let chunks = 0;

  while (cursor <= head && chunks < MAX_CHUNKS_PER_SCAN) {
    const to = cursor + LOG_CHUNK_BLOCKS - 1n < head ? cursor + LOG_CHUNK_BLOCKS - 1n : head;

    const logs = await client.getLogs({
      address: BASE_USDC_ADDRESS,
      event: TRANSFER_EVENT,
      args: { to: wallet },
      fromBlock: cursor,
      toBlock: to,
    });

    for (const log of logs) {
      const from = (log.args.from as string | undefined)?.toLowerCase();
      const value = log.args.value as bigint | undefined;
      if (!value || value <= 0n) continue;
      if (from && exclude.has(from)) continue;
      received += value;
      transfers += 1;
    }

    cursor = to + 1n;
    chunks += 1;
  }

  return {
    receivedMicros: received,
    scannedThroughBlock: cursor - 1n,
    partial: cursor <= head,
    transfers,
  };
}

/**
 * Make sure the wallet holds enough ETH to pay for the transfer's gas.
 * Throws a descriptive error otherwise (the agent sees it and can act).
 */
async function preflightGas(
  account: PrivateKeyAccount,
  to: Address,
  amountMicros: bigint,
  rpcUrl?: string,
): Promise<void> {
  const client = publicClient(rpcUrl);
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [to, amountMicros],
  });

  const gas = await client
    .estimateGas({ account: account.address, to: BASE_USDC_ADDRESS, data })
    .catch(() => 80_000n);
  const gasPrice = await client.getGasPrice().catch(() => 1_000_000_000n);
  const ethBalance = await client.getBalance({ address: account.address });
  const cost = gas * gasPrice;

  if (ethBalance < cost) {
    throw new Error(
      `Insufficient ETH on Base for tithe gas. Balance: ${ethBalance} wei, estimated cost: ${cost} wei. ` +
        `Fund ${account.address} with a little ETH on Base.`,
    );
  }
}

export interface UsdcSendResult {
  txHash: `0x${string}`;
  gasUsed?: number;
}

/** Send USDC to `to` and wait for the receipt. Throws on failure. */
export async function sendUsdc(
  account: PrivateKeyAccount,
  to: Address,
  amountMicros: bigint,
  rpcUrl?: string,
): Promise<UsdcSendResult> {
  if (amountMicros <= 0n) throw new Error("Tithe amount must be positive");

  await preflightGas(account, to, amountMicros, rpcUrl);

  const client = publicClient(rpcUrl);
  const wallet = createWalletClient({
    account,
    chain: base,
    transport: http(resolveRpcUrl(rpcUrl), { timeout: 30_000 }),
  });

  const txHash = await wallet.writeContract({
    address: BASE_USDC_ADDRESS,
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [to, amountMicros],
  });

  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") {
    throw new Error(`Tithe USDC transfer reverted: ${txHash}`);
  }

  return { txHash, gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : undefined };
}
