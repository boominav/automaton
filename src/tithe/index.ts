/**
 * Creator Tithe
 *
 * Rule 1 — earnings share: every automaton pays a share (default 1%) of its
 *   earnings to the creator's wallet.
 * Rule 2 — replication fee: before funding a child, an automaton sends the
 *   creator a fee (default 10%) of the amount it is about to send.
 * Both settings are inherited verbatim by every child, so the whole lineage
 * pays the same creator.
 */

export * from "./ledger.js";
export * from "./chain.js";
export * from "./settle.js";
export * from "./funding.js";
