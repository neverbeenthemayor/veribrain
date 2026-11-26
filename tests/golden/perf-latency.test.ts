import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateBrain } from "../../src/commands/eval.js";
import { compileContext } from "../../src/compiler.js";
import { MAX_SCARS_BYTES, type Priority } from "../../src/types.js";
import {
  type ScarFixtureInput,
  WorkspaceTracker,
  writeDecidedFixture,
  writeHypothesisFixture,
  writeObservedFixture,
  writeScarsFixture,
} from "./helpers.js";

const tracker = new WorkspaceTracker();

afterEach(() => {
  tracker.cleanupAll();
});

function percentile(sortedAsc: readonly number[], p: number): number {
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx] ?? Number.POSITIVE_INFINITY;
}

describe("Golden Perf Gate: 100-Run In-Process Compile Latency & Determinism", () => {
  it("completes 100 sequential compiles at p95 < 15.0 ms with 100/100 identical zone_a_sha256 on a realistic multi-file brain", async () => {
    const { root, brainDir } = tracker.create("vb-perf-100-");
    const targetSha = "a1b2c3d4e5f67890";
    const now = new Date("2026-11-28T12:00:00Z");

    // 1. >= 10 DECIDED files (12 files across P0, P1, P2)
    const priorities: readonly Priority[] = ["P0", "P1", "P2"];
    for (let i = 1; i <= 12; i += 1) {
      const id = `DEC-${String(i).padStart(3, "0")}`;
      const priority = priorities[(i - 1) % priorities.length] ?? "P1";
      writeDecidedFixture(brainDir, {
        id,
        priority,
        roles: ["builder", "cqe"],
        body: [
          `Policy ${id} (${priority}): VeriBrain compiles Zone A deterministically with zero LLM calls and strict ASCII sorting.`,
          `All artifacts under .brain/ must pass fail-closed schema, quarantine, and provenance verification before any context emission.`,
          `No timestamps, git commit hashes, or environment names may appear inside Zone A static prefix headers or decided rule blocks.`,
        ].join("\n"),
      });
    }

    // 2. 20 OBSERVED files: 15 fresh matching (staging, targetSha) + 5 stale (2 expired, 2 wrong env, 1 wrong git_sha)
    for (let i = 1; i <= 15; i += 1) {
      const id = `OBS-fresh-${String(i).padStart(2, "0")}`;
      writeObservedFixture(brainDir, {
        claim_id: id,
        env: "staging",
        git_sha: targetSha,
        observed_at_utc: "2026-11-28T11:30:00Z",
        ttl_seconds: 7200,
        issuer: i % 2 === 0 ? "ci" : "verifier-script",
        roles: ["builder"],
        priority: i <= 2 ? "P1" : "P2",
        summary: `Verified staging subsystem #${i} health check green with deterministic build hash and zero regressions.`,
        evidence_ref: `ci:staging/run-${1000 + i}`,
      });
    }
    // 5 stale observations
    writeObservedFixture(brainDir, {
      claim_id: "OBS-stale-expired-01",
      env: "staging",
      git_sha: targetSha,
      observed_at_utc: "2026-11-28T09:00:00Z",
      ttl_seconds: 600,
      issuer: "ci",
      roles: ["builder"],
      summary: "Expired staging build #1.",
      evidence_ref: "ci:staging/old-1",
    });
    writeObservedFixture(brainDir, {
      claim_id: "OBS-stale-expired-02",
      env: "staging",
      git_sha: targetSha,
      observed_at_utc: "2026-11-28T10:00:00Z",
      ttl_seconds: 1200,
      issuer: "ci",
      roles: ["builder"],
      summary: "Expired staging build #2.",
      evidence_ref: "ci:staging/old-2",
    });
    writeObservedFixture(brainDir, {
      claim_id: "OBS-stale-env-prod",
      env: "prod",
      git_sha: targetSha,
      observed_at_utc: "2026-11-28T11:50:00Z",
      ttl_seconds: 3600,
      issuer: "ci",
      roles: ["builder"],
      summary: "Production-only observation excluded from staging.",
      evidence_ref: "ci:prod/run-1",
    });
    writeObservedFixture(brainDir, {
      claim_id: "OBS-stale-env-local",
      env: "local",
      git_sha: targetSha,
      observed_at_utc: "2026-11-28T11:50:00Z",
      ttl_seconds: 3600,
      issuer: "git-hook",
      roles: ["builder"],
      summary: "Local dev observation excluded from staging.",
      evidence_ref: "hook:local/run-1",
    });
    writeObservedFixture(brainDir, {
      claim_id: "OBS-stale-wrong-sha",
      env: "staging",
      git_sha: "deadbeef99998888",
      observed_at_utc: "2026-11-28T11:55:00Z",
      ttl_seconds: 3600,
      issuer: "ci",
      roles: ["builder"],
      summary: "Older commit staging observation excluded by SHA.",
      evidence_ref: "ci:staging/other-sha",
    });

    // 3. ~3.5 KB scars.md (strictly >= 3,300 B and < 4,096 B)
    const scars: ScarFixtureInput[] = [];
    for (let i = 1; i <= 12; i += 1) {
      scars.push({
        scar_id: `SCAR-PERF-${String(i).padStart(2, "0")}`,
        created_at_utc: "2026-11-20T09:00:00Z",
        expires_at_utc: "2026-12-18T09:00:00Z",
        regression_test: `tests/golden/perf-latency.test.ts#L${i}`,
        roles: ["builder"],
        hint: `Anti-pattern #${i}: Keep deterministic prefix serialization isolated from volatile runtime metadata and verify regression tests remain linked.`,
      });
    }
    const scarsPath = writeScarsFixture(brainDir, scars);
    const scarsBytes = Buffer.byteLength(readFileSync(scarsPath, "utf8"), "utf8");
    expect(scarsBytes).toBeGreaterThanOrEqual(3300);
    expect(scarsBytes).toBeLessThan(MAX_SCARS_BYTES);

    // 4. 5 active hypotheses
    for (let i = 1; i <= 5; i += 1) {
      writeHypothesisFixture(brainDir, {
        id: `HYP-PERF-${String(i).padStart(2, "0")}`,
        created_at_utc: `2026-11-28T0${i}:00:00Z`,
        expires_at_utc: "2026-12-03T09:00:00Z",
        roles: ["builder"],
        hint: `Candidate improvement #${i}: benchmark token estimator calibration against Gemini countTokens in Stage 2.`,
      });
    }

    // Confirm fixture passes baseline eval (non-strict allows expired observed without failing)
    const evalCheck = evaluateBrain({ brainDir, repoRoot: root, now });
    expect(evalCheck.ok).toBe(true);
    expect(evalCheck.counts.decided).toBe(12);
    expect(evalCheck.counts.observed).toBe(20);
    expect(evalCheck.counts.hypotheses).toBe(5);
    expect(evalCheck.counts.scars).toBe(12);

    // Allow freshly written temp fixtures to age past the 50ms stat-cache safety guard
    await new Promise((resolve) => setTimeout(resolve, 60));

    // 10 warmup runs (untimed)
    for (let w = 0; w < 10; w += 1) {
      compileContext({
        role: "builder",
        env: "staging",
        gitSha: targetSha,
        maxTokens: 16384,
        brainDir,
        repoRoot: root,
        now,
      });
    }

    // 100 timed sequential runs
    const timingsMs: number[] = [];
    const zoneAHashes = new Set<string>();
    const zoneBOutputs = new Set<string>();

    for (let run = 0; run < 100; run += 1) {
      const t0 = performance.now();
      const res = compileContext({
        role: "builder",
        env: "staging",
        gitSha: targetSha,
        maxTokens: 16384,
        brainDir,
        repoRoot: root,
        now,
      });
      const elapsed = performance.now() - t0;
      timingsMs.push(elapsed);
      zoneAHashes.add(res.zone_a_sha256);
      zoneBOutputs.add(res.zone_b);
      expect(res.excluded_stale_ids).toHaveLength(5);
    }

    expect(timingsMs).toHaveLength(100);
    expect(zoneAHashes.size).toBe(1);
    expect(zoneBOutputs.size).toBe(1);

    const sorted = [...timingsMs].sort((a, b) => a - b);
    const p95 = percentile(sorted, 95);
    expect(p95).toBeLessThan(15.0);
  });
});
