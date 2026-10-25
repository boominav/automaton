/**
 * STOP switch — the creator's family-wide pause button.
 *
 * A file named STOP at the root of the creator's GitHub repo controls every
 * automaton in the lineage. Every automaton checks it on a heartbeat:
 *
 *   run   → work normally
 *   stop  → pause: no thinking, no tools, no spending, no cloning.
 *           Only this switch check keeps running, so flipping the file back
 *           to "run" resumes everyone where they left off.
 *
 * Fail-safe rules:
 *   - Only the words run / go / on / start mean run. Anything else (typos,
 *     empty file, "stop", "pause") means stop.
 *   - A missing file (404) means stop.
 *   - A network error keeps the last known state (GitHub being down should
 *     neither stop nor release the family).
 *
 * This file is protected from the agent's self-modification tools.
 */

import type { AutomatonConfig, AutomatonDatabase } from "../types.js";
import { DEFAULT_KILL_SWITCH_REPO } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("killswitch");

export type SwitchState = "run" | "stop";

export const SWITCH_FILE = "STOP";
const KV_STATE = "killswitch_state";
const KV_CHECKED_AT = "killswitch_checked_at";
const KV_SOURCE = "killswitch_source";

const RUN_WORDS = new Set(["run", "go", "on", "start", "running"]);

/** Turn the file's text into a state. Anything not clearly "run" is "stop". */
export function parseSwitchFile(text: string): SwitchState {
  const first = (text ?? "").replace(/^﻿/, "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return RUN_WORDS.has(first) ? "run" : "stop";
}

/** "owner/repo" from a GitHub URL or an owner/repo string. */
export function parseGitHubRepo(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const short = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (short && !trimmed.includes(":")) return `${short[1]}/${short[2]}`;
  const url = trimmed.match(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return url ? `${url[1]}/${url[2]}` : null;
}

/** Which repo this automaton's switch lives in. */
export function resolveKillSwitchRepo(config: Pick<AutomatonConfig, "killSwitchRepo" | "sourceRepoUrl"> | null | undefined): string {
  return (
    parseGitHubRepo(config?.killSwitchRepo) ??
    parseGitHubRepo(config?.sourceRepoUrl) ??
    DEFAULT_KILL_SWITCH_REPO
  );
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  text(): Promise<string>;
}>;

/**
 * Read the STOP file. Returns null when GitHub can't be reached
 * (caller keeps the last known state).
 */
export async function fetchSwitchState(
  repo: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<SwitchState | null> {
  const timeout = () => AbortSignal.timeout(10_000);

  // GitHub API first: not CDN-cached, so a flip takes effect on the next check.
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/contents/${SWITCH_FILE}`, {
      headers: { Accept: "application/vnd.github.raw", "User-Agent": "automaton-killswitch" },
      signal: timeout(),
    });
    if (res.status === 404) return "stop";
    if (res.ok) return parseSwitchFile(await res.text());
  } catch {
    // fall through to raw
  }

  // Fallback (e.g. API rate limit): raw file, may lag a few minutes behind.
  try {
    const res = await fetchImpl(`https://raw.githubusercontent.com/${repo}/HEAD/${SWITCH_FILE}?t=${Date.now()}`, {
      headers: { "User-Agent": "automaton-killswitch" },
      signal: timeout(),
    });
    if (res.status === 404) return "stop";
    if (res.ok) return parseSwitchFile(await res.text());
  } catch {
    // unreachable
  }
  return null;
}

/** True when the creator has paused the family. */
export function isPaused(db: Pick<AutomatonDatabase, "getKV">): boolean {
  try {
    return db.getKV(KV_STATE) === "stop";
  } catch {
    return false;
  }
}

export interface SwitchCheckResult {
  state: SwitchState;
  changed: boolean;
  reachable: boolean;
}

/** Check the STOP file and record the result. */
export async function refreshSwitch(
  db: Pick<AutomatonDatabase, "getKV" | "setKV">,
  config: Pick<AutomatonConfig, "killSwitchRepo" | "sourceRepoUrl"> | null | undefined,
  fetchImpl?: FetchLike,
): Promise<SwitchCheckResult> {
  const repo = resolveKillSwitchRepo(config);
  const previous: SwitchState = db.getKV(KV_STATE) === "stop" ? "stop" : "run";
  const fetched = await fetchSwitchState(repo, fetchImpl);

  if (fetched === null) {
    logger.warn(`STOP switch at ${repo} unreachable; keeping last state (${previous}).`);
    return { state: previous, changed: false, reachable: false };
  }

  db.setKV(KV_STATE, fetched);
  db.setKV(KV_CHECKED_AT, new Date().toISOString());
  db.setKV(KV_SOURCE, repo);

  const changed = fetched !== previous;
  if (changed) {
    if (fetched === "stop") logger.warn(`STOP switch flipped to STOP (${repo}). Pausing all work.`);
    else logger.info(`STOP switch flipped to RUN (${repo}). Resuming.`);
  }
  return { state: fetched, changed, reachable: true };
}

export const PAUSED_MESSAGE =
  "Paused by your creator's STOP switch. All actions are blocked until the switch is set back to run.";
