# Creator Tithe

Two rules, enforced by the runtime and inherited by every descendant of your first automaton.

| Rule | What | When | Default |
|---|---|---|---|
| **1 — Earnings share** | A share of everything an automaton *earns* (USDC on Base + Conway credits received) | Paid on a schedule (daily, 03:00) and before every child spawn | 1% |
| **2 — Replication fee** | A fee on the amount an automaton is about to send a child | Paid **first**, before the funding goes out; the child is only funded once the fee is through | 10% |

Everything goes to one wallet — the **beneficiary** — which is written into every child's `genesis.json` unchanged, so grandchildren pay you, not their parent.

## Setup

On first run the wizard asks for a payout wallet (defaults to your creator address), the earnings share percent and the replication fee percent. Children never ask; they inherit.

Config lives in `~/.automaton/automaton.json`:

```json
"tithe": {
  "enabled": true,
  "beneficiaryAddress": "0xYOUR_WALLET",
  "earningsSharePercent": 1,
  "replicationFeePercent": 10,
  "minUsdcSettlementUsd": 0.5,
  "minCreditsSettlementCents": 50,
  "settleBeforeSpawn": true
},
"sourceRepoUrl": "https://github.com/YOU/automaton.git"
```

Environment overrides: `AUTOMATON_TITHE_BENEFICIARY`, `AUTOMATON_TITHE_EARNINGS_PERCENT`,
`AUTOMATON_TITHE_REPLICATION_FEE_PERCENT`, `AUTOMATON_TITHE_ENABLED`, `AUTOMATON_REPO_URL`.

## `sourceRepoUrl` matters

Children install their runtime with `git clone <sourceRepoUrl>`. Upstream hard-coded Conway's repo, which does **not** contain this code. Push this fork to your own GitHub and set `sourceRepoUrl` (or `AUTOMATON_REPO_URL`) to it, otherwise every child runs the stock runtime and pays nothing.

## What counts as "earnings" (Rule 1)

- **USDC on Base**: every `Transfer` into the wallet, read from chain logs, *except* transfers from the beneficiary (you funding the agent) or from its parent (capital, not earnings).
- **Conway credits**: increases in the credit balance between heartbeat ticks (every minute), net of credits the agent bought with its own USDC (those were already counted when the USDC arrived).

Known approximation: a spend and a receipt inside the same minute net against each other, so credits are slightly under-counted. Credits a child receives from its parent show up as the child's earnings (1%), on top of the 10% fee the parent paid.

Rule 1 is paid in USDC when the agent is on EVM (needs a little **ETH on Base for gas**; the agent is told this in its system prompt), and in Conway credits for the credit side. Solana-chain automatons only pay the credits side.

## What counts as child funding (Rule 2)

All three paths that move credits to a child go through `fundChildWithFee()`:

- the `fund_child` tool
- `transfer_credits` when the recipient is one of the agent's children
- the orchestrator's funding protocol (task funding and automatic top-ups)

Fee = `ceil(amount × fee%)`, sent on top of the funding. If the fee transfer fails, the child is not funded.

## Protection

`src/tithe/*`, `replication/spawn.ts`, `replication/genesis.ts` and `orchestration/simple-tracker.ts` are on the agent's protected-file list, so the self-modification tools refuse to touch them. The agent is told about both rules in its system prompt (its constitution forbids deceiving, so it should not be surprised by the outflows).

## Where the numbers live

`~/.automaton/state.db`, KV key `tithe_ledger` — totals earned, paid, fees paid, last chain-scan block, and the last 50 settlements. Every payment is also logged as a `transfer_out` transaction.

## Tests

`src/__tests__/tithe.test.ts` covers the ledger math, fee-before-funding ordering, failure handling and config resolution.

## Creator controls

### STOP switch
The file `STOP` at the root of this repo pauses or resumes every automaton in the family.

- `run` = work normally
- `stop` = pause: no thinking, no tools, no spending, no cloning, no topups

Every automaton checks it at startup and every 2 minutes, on a timer outside the
agent-editable heartbeat schedule, so a flip reaches everyone within a few minutes.
Edit it on github.com (pencil icon, change the word, Commit changes).

Fail-safe: only `run`, `go`, `on` or `start` mean run. Anything else, an empty file,
or a deleted file means stop. If GitHub can't be reached, each agent keeps its last state.

### Family limits
Set in the setup wizard (or later with `node dist/index.js --configure` on the root agent):

- **Kids per agent**: live children any one automaton may have
- **Max generations**: how many levels below the root may exist

Both default to 0 (one agent, no clones). Every child inherits them and can only
tighten them, never raise them. `create_sandbox` follows the same limits, so an agent
can't hand-build a clone on an extra server when cloning is off.

Children clone from `https://github.com/boominav/automaton.git` by default, so they
always carry the tithe and the STOP switch.

### Limits of these controls
These are enforced by the runtime code and its self-modification protections. An agent
that can run arbitrary shell commands on its host could still edit files directly, so
run agents in an isolated machine (a Conway sandbox or a container), never loose on a
personal computer.
