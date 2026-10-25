/**
 * Creator controls: STOP switch + family (lineage) limits.
 */

import { describe, it, expect } from "vitest";
import {
  parseSwitchFile,
  parseGitHubRepo,
  resolveKillSwitchRepo,
  fetchSwitchState,
  refreshSwitch,
  isPaused,
} from "../killswitch/switch.js";
import { tightestLimits, DEFAULT_LINEAGE_LIMITS, DEFAULT_SOURCE_REPO_URL } from "../types.js";
import { assertLineageAllowsSpawn, resolveSpawnLineage } from "../replication/spawn.js";

function memKV() {
  const kv = new Map<string, string>();
  return {
    getKV: (k: string) => kv.get(k),
    setKV: (k: string, v: string) => void kv.set(k, v),
  };
}

function fakeFetch(responses: Array<{ status: number; body?: string } | "throw">) {
  const calls: string[] = [];
  let i = 0;
  const fn = async (url: string) => {
    calls.push(url);
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r === "throw") throw new Error("network down");
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => r.body ?? "" };
  };
  return { fn, calls };
}

describe("STOP switch file parsing", () => {
  it("only clear run words mean run", () => {
    expect(parseSwitchFile("run")).toBe("run");
    expect(parseSwitchFile("RUN\n")).toBe("run");
    expect(parseSwitchFile("  Go  ")).toBe("run");
    expect(parseSwitchFile("﻿run")).toBe("run");
  });

  it("anything else means stop (fail-safe)", () => {
    expect(parseSwitchFile("stop")).toBe("stop");
    expect(parseSwitchFile("STOP")).toBe("stop");
    expect(parseSwitchFile("")).toBe("stop");
    expect(parseSwitchFile("rnu")).toBe("stop");
    expect(parseSwitchFile("pause everything")).toBe("stop");
  });
});

describe("STOP switch repo resolution", () => {
  it("parses GitHub URLs and owner/repo", () => {
    expect(parseGitHubRepo("https://github.com/boominav/automaton.git")).toBe("boominav/automaton");
    expect(parseGitHubRepo("https://github.com/boominav/automaton")).toBe("boominav/automaton");
    expect(parseGitHubRepo("boominav/automaton")).toBe("boominav/automaton");
    expect(parseGitHubRepo("not a repo")).toBeNull();
  });

  it("prefers killSwitchRepo, then sourceRepoUrl, then the default", () => {
    expect(resolveKillSwitchRepo({ killSwitchRepo: "a/b", sourceRepoUrl: "https://github.com/c/d.git" })).toBe("a/b");
    expect(resolveKillSwitchRepo({ sourceRepoUrl: "https://github.com/c/d.git" })).toBe("c/d");
    expect(resolveKillSwitchRepo({})).toBe("boominav/automaton");
  });

  it("children clone from Ben's fork by default", () => {
    expect(DEFAULT_SOURCE_REPO_URL).toBe("https://github.com/boominav/automaton.git");
  });
});

describe("STOP switch fetching", () => {
  it("reads the file from the GitHub API", async () => {
    const f = fakeFetch([{ status: 200, body: "stop\n" }]);
    expect(await fetchSwitchState("boominav/automaton", f.fn)).toBe("stop");
    expect(f.calls[0]).toContain("api.github.com/repos/boominav/automaton/contents/STOP");
  });

  it("treats a missing file as stop", async () => {
    const f = fakeFetch([{ status: 404 }]);
    expect(await fetchSwitchState("boominav/automaton", f.fn)).toBe("stop");
  });

  it("falls back to the raw file when the API is rate-limited", async () => {
    const f = fakeFetch([{ status: 403 }, { status: 200, body: "run" }]);
    expect(await fetchSwitchState("boominav/automaton", f.fn)).toBe("run");
    expect(f.calls[1]).toContain("raw.githubusercontent.com/boominav/automaton/HEAD/STOP");
  });

  it("returns null when GitHub is unreachable", async () => {
    const f = fakeFetch(["throw", "throw"]);
    expect(await fetchSwitchState("boominav/automaton", f.fn)).toBeNull();
  });
});

describe("STOP switch state", () => {
  it("pauses, resumes, and keeps last state when unreachable", async () => {
    const db = memKV();
    expect(isPaused(db)).toBe(false);

    let r = await refreshSwitch(db, {}, fakeFetch([{ status: 200, body: "stop" }]).fn);
    expect(r).toMatchObject({ state: "stop", changed: true, reachable: true });
    expect(isPaused(db)).toBe(true);

    r = await refreshSwitch(db, {}, fakeFetch(["throw", "throw"]).fn);
    expect(r).toMatchObject({ state: "stop", changed: false, reachable: false });
    expect(isPaused(db)).toBe(true);

    r = await refreshSwitch(db, {}, fakeFetch([{ status: 200, body: "run" }]).fn);
    expect(r).toMatchObject({ state: "run", changed: true, reachable: true });
    expect(isPaused(db)).toBe(false);
  });
});

describe("family limits", () => {
  it("default is no cloning", () => {
    expect(DEFAULT_LINEAGE_LIMITS).toEqual({ maxChildrenPerAgent: 0, maxGenerations: 0 });
    expect(tightestLimits(undefined, undefined)).toEqual({ maxChildrenPerAgent: 0, maxGenerations: 0 });
  });

  it("a child can only tighten, never loosen", () => {
    const inherited = { maxChildrenPerAgent: 2, maxGenerations: 2 };
    const childTriesToLoosen = { maxChildrenPerAgent: 50, maxGenerations: 50 };
    expect(tightestLimits(childTriesToLoosen, inherited)).toEqual(inherited);
    expect(tightestLimits({ maxChildrenPerAgent: 1, maxGenerations: 5 }, inherited)).toEqual({
      maxChildrenPerAgent: 1,
      maxGenerations: 2,
    });
  });

  it("garbage values become 0", () => {
    expect(tightestLimits({ maxChildrenPerAgent: -3, maxGenerations: NaN } as any, undefined)).toEqual({
      maxChildrenPerAgent: 0,
      maxGenerations: 0,
    });
  });

  it("blocks spawning when cloning is off", () => {
    expect(() => assertLineageAllowsSpawn(0, { maxChildrenPerAgent: 0, maxGenerations: 0 }, 1)).toThrow(/cloning turned off/);
  });

  it("blocks a generation deeper than allowed", () => {
    const limits = { maxChildrenPerAgent: 3, maxGenerations: 2 };
    expect(() => assertLineageAllowsSpawn(0, limits, 2)).not.toThrow();
    expect(() => assertLineageAllowsSpawn(0, limits, 3)).toThrow(/generation 3/);
  });

  it("blocks more live children than allowed per agent", () => {
    const limits = { maxChildrenPerAgent: 2, maxGenerations: 3 };
    expect(() => assertLineageAllowsSpawn(1, limits, 1)).not.toThrow();
    expect(() => assertLineageAllowsSpawn(2, limits, 1)).toThrow(/limit of 2/);
  });

  it("reads limits and the child's generation from the genesis", () => {
    const g = {
      name: "c",
      genesisPrompt: "x",
      creatorAddress: "0x1",
      parentAddress: "0x1",
      lineageLimits: { maxChildrenPerAgent: 2, maxGenerations: 2 },
      generation: 2,
    };
    expect(resolveSpawnLineage(g)).toEqual({ limits: { maxChildrenPerAgent: 2, maxGenerations: 2 }, childGeneration: 2 });
  });
});
