import { afterEach, describe, expect, it } from "vitest";
import { compileContext } from "../../src/compiler.js";
import { compareAscii } from "../../src/normalize.js";
import {
  type CompileResult,
  EXIT_BUDGET_INFEASIBLE,
  EXIT_PROVENANCE_VIOLATION,
  VeriBrainError,
} from "../../src/types.js";
import {
  invokeCli,
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

function isoOffset(baseMs: number, deltaMs: number): string {
  return new Date(baseMs + deltaMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function buildEvictionWorkspace(): {
  root: string;
  brainDir: string;
  now: Date;
  p0DecidedClause: string;
  p1DecidedClause: string;
  p0ObsSummary: string;
  p1ObsSummary: string;
} {
  const { root, brainDir } = tracker.create("vb-ge2-");
  // Anchor timestamps to current wall clock (<= now) so CLI subprocesses using Date.now()
  // never trigger future-dated created_at_utc provenance errors.
  const nowMs = Math.floor(Date.now() / 1000) * 1000;
  const now = new Date(nowMs);

  const p0DecidedClause = "P0-INVARIANT: Never silently drop safety or provenance rules.";
  const p1DecidedClause = "P1-INVARIANT: Preserve Zone A prefix byte identity across compiles.";
  const p0ObsSummary = "P0-OBSERVED: Critical staging security gate verified green.";
  const p1ObsSummary = "P1-OBSERVED: Primary API migration checksum verified on staging.";

  writeDecidedFixture(brainDir, {
    id: "DEC-001",
    priority: "P0",
    roles: ["builder"],
    signedAtUtc: isoOffset(nowMs, -2 * DAY_MS),
    body: `${p0DecidedClause} Every compilation must keep this rule verbatim in Zone A.`,
  });
  writeDecidedFixture(brainDir, {
    id: "DEC-002",
    priority: "P1",
    roles: ["builder"],
    signedAtUtc: isoOffset(nowMs, -2 * DAY_MS),
    body: `${p1DecidedClause} Deterministic ordering guarantees stable prefix KV cache hits.`,
  });

  writeObservedFixture(brainDir, {
    claim_id: "OBS-p0-gate",
    env: "staging",
    git_sha: "abcdef123456",
    observed_at_utc: isoOffset(nowMs, -HOUR_MS),
    ttl_seconds: 7200,
    issuer: "ci",
    roles: ["builder"],
    priority: "P0",
    summary: p0ObsSummary,
    evidence_ref: "ci:gate/p0",
  });
  writeObservedFixture(brainDir, {
    claim_id: "OBS-p1-migration",
    env: "staging",
    git_sha: "abcdef123456",
    observed_at_utc: isoOffset(nowMs, -55 * 60 * 1000),
    ttl_seconds: 7200,
    issuer: "ci",
    roles: ["builder"],
    priority: "P1",
    summary: p1ObsSummary,
    evidence_ref: "ci:gate/p1",
  });

  // Two P2 observed facts with distinct timestamps to verify oldest-first P2 eviction
  writeObservedFixture(brainDir, {
    claim_id: "OBS-p2-older",
    env: "staging",
    git_sha: "abcdef123456",
    observed_at_utc: isoOffset(nowMs, -4 * HOUR_MS),
    ttl_seconds: 86400,
    issuer: "ci",
    roles: ["builder"],
    priority: "P2",
    summary:
      "Older P2 telemetry observation containing verbose diagnostic metrics and extra detail tokens so evicting it frees substantial budget space in Zone B.",
    evidence_ref: "ci:metrics/older-p2",
  });
  writeObservedFixture(brainDir, {
    claim_id: "OBS-p2-newer",
    env: "staging",
    git_sha: "abcdef123456",
    observed_at_utc: isoOffset(nowMs, -2 * HOUR_MS),
    ttl_seconds: 86400,
    issuer: "ci",
    roles: ["builder"],
    priority: "P2",
    summary:
      "Newer P2 telemetry observation containing verbose diagnostic metrics and extra detail tokens so evicting it frees substantial budget space in Zone B.",
    evidence_ref: "ci:metrics/newer-p2",
  });

  // Two scars with distinct non-future timestamps to verify oldest-first scar eviction
  writeScarsFixture(brainDir, [
    {
      scar_id: "SCAR-older",
      created_at_utc: isoOffset(nowMs, -10 * DAY_MS),
      expires_at_utc: isoOffset(nowMs, 15 * DAY_MS),
      regression_test: "tests/golden/eval-2-budget-eviction.test.ts#L1",
      roles: ["builder"],
      hint: "Older scar note with extended factual explanation consuming ample token budget so step-wise eviction removes SCAR-older before SCAR-newer.",
    },
    {
      scar_id: "SCAR-newer",
      created_at_utc: isoOffset(nowMs, -3 * DAY_MS),
      expires_at_utc: isoOffset(nowMs, 20 * DAY_MS),
      regression_test: "tests/golden/eval-2-budget-eviction.test.ts#L2",
      roles: ["builder"],
      hint: "Newer scar note with extended factual explanation consuming ample token budget so step-wise eviction removes SCAR-newer after SCAR-older.",
    },
  ]);

  // Two hypotheses with distinct non-future timestamps to verify oldest-first hypothesis eviction
  writeHypothesisFixture(brainDir, {
    id: "HYP-older",
    created_at_utc: isoOffset(nowMs, -3 * DAY_MS),
    expires_at_utc: isoOffset(nowMs, 2 * DAY_MS),
    roles: ["builder"],
    hint: "Older agent hypothesis containing substantial prose so that tight token budgets deterministically evict HYP-older as the very first candidate.",
  });
  writeHypothesisFixture(brainDir, {
    id: "HYP-newer",
    created_at_utc: isoOffset(nowMs, -DAY_MS),
    expires_at_utc: isoOffset(nowMs, 4 * DAY_MS),
    roles: ["builder"],
    hint: "Newer agent hypothesis containing substantial prose so that tight token budgets deterministically evict HYP-newer second after HYP-older.",
  });

  return { root, brainDir, now, p0DecidedClause, p1DecidedClause, p0ObsSummary, p1ObsSummary };
}

describe("Golden Context Eval #2: Zero Silent P0/P1 Truncation", () => {
  it("evicts Zone B in exact priority order hypotheses -> oldest scars -> P2 observed with ASCII-sorted evicted_ids and verbatim notices while preserving P0/P1 intact", () => {
    const { root, brainDir, now, p0DecidedClause, p1DecidedClause, p0ObsSummary, p1ObsSummary } =
      buildEvictionWorkspace();

    const full = compileContext({
      role: "builder",
      env: "staging",
      gitSha: "abcdef123456",
      maxTokens: 8192,
      brainDir,
      repoRoot: root,
      now,
    });
    expect(full.evicted_ids).toEqual([]);

    // Exact eviction selection cascade (oldest hypothesis -> newer hypothesis -> oldest scar -> ...)
    const expectedCascade = [
      "HYP-older",
      "HYP-newer",
      "SCAR-older",
      "SCAR-newer",
      "OBS-p2-older",
      "OBS-p2-newer",
    ];

    const observedEvictionStages = new Map<number, string[]>();
    let budget = full.total_tokens_est - 1;
    let firstInfeasibleBudget: number | null = null;

    while (budget >= full.zone_a_tokens_est) {
      let res: CompileResult | null = null;
      try {
        res = compileContext({
          role: "builder",
          env: "staging",
          gitSha: "abcdef123456",
          maxTokens: budget,
          brainDir,
          repoRoot: root,
          now,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(VeriBrainError);
        expect((err as VeriBrainError).exitCode).toBe(EXIT_BUDGET_INFEASIBLE);
        firstInfeasibleBudget = budget;
        break;
      }

      expect(res.total_tokens_est).toBeLessThanOrEqual(budget);
      expect(res.zone_a_sha256).toBe(full.zone_a_sha256);
      expect(res.zone_a).toBe(full.zone_a);

      // P0/P1 decided & P0/P1 observed MUST NEVER be evicted or truncated
      expect(res.zone_a).toContain(p0DecidedClause);
      expect(res.zone_a).toContain(p1DecidedClause);
      expect(res.zone_b).toContain(p0ObsSummary);
      expect(res.zone_b).toContain(p1ObsSummary);
      expect(res.evicted_ids).not.toContain("DEC-001");
      expect(res.evicted_ids).not.toContain("DEC-002");
      expect(res.evicted_ids).not.toContain("OBS-p0-gate");
      expect(res.evicted_ids).not.toContain("OBS-p1-migration");

      // Exact ASCII-sorted set of the first k items in the eviction cascade (Bench P2)
      const expectedSorted = [...expectedCascade.slice(0, res.evicted_ids.length)].sort(
        compareAscii,
      );
      expect(res.evicted_ids).toEqual(expectedSorted);

      // Every evicted ID must have a verbatim [EVICTED: <id>, reason=token_budget] line in ASCII order
      const noticeLines = res.zone_b.split("\n").filter((line) => line.startsWith("[EVICTED: "));
      expect(noticeLines).toEqual(
        expectedSorted.map((id) => `[EVICTED: ${id}, reason=token_budget]`),
      );

      if (!observedEvictionStages.has(res.evicted_ids.length)) {
        observedEvictionStages.set(res.evicted_ids.length, [...res.evicted_ids]);
      }

      budget = res.total_tokens_est - 1;
    }

    // Confirm all 6 cascade stages were reached (including stage 1: ["HYP-older"] and stage 2: ["HYP-newer", "HYP-older"])
    expect(observedEvictionStages.get(1)).toEqual(["HYP-older"]);
    expect(observedEvictionStages.get(2)).toEqual(["HYP-newer", "HYP-older"]);
    for (let k = 1; k <= expectedCascade.length; k += 1) {
      expect(observedEvictionStages.get(k)).toEqual(
        [...expectedCascade.slice(0, k)].sort(compareAscii),
      );
    }
    expect(firstInfeasibleBudget).not.toBeNull();
    expect(firstInfeasibleBudget as number).toBeGreaterThan(full.zone_a_tokens_est);
  });

  it("fails closed with exit 3 and strictly zero bytes stdout when Zone A alone exceeds --max-tokens", () => {
    const { root, brainDir, now } = buildEvictionWorkspace();

    const full = compileContext({
      role: "builder",
      env: "staging",
      gitSha: "abcdef123456",
      maxTokens: 8192,
      brainDir,
      repoRoot: root,
      now,
    });
    const impossibleCap = full.zone_a_tokens_est - 1;
    expect(impossibleCap).toBeGreaterThan(0);

    // 1. Direct compiler API throws EXIT_BUDGET_INFEASIBLE (3)
    try {
      compileContext({
        role: "builder",
        env: "staging",
        gitSha: "abcdef123456",
        maxTokens: impossibleCap,
        brainDir,
        repoRoot: root,
        now,
      });
      expect.unreachable("expected compileContext to throw EXIT_BUDGET_INFEASIBLE");
    } catch (err) {
      expect(err).toBeInstanceOf(VeriBrainError);
      const vbErr = err as VeriBrainError;
      expect(vbErr.exitCode).toBe(EXIT_BUDGET_INFEASIBLE);
      expect(vbErr.code).toBe("BUDGET_INFEASIBLE");
    }

    // 2. CLI returns exit 3 with strictly zero stdout and actionable stderr
    const cliRes = invokeCli([
      "compile",
      "--role",
      "builder",
      "--env",
      "staging",
      "--git-sha",
      "abcdef123456",
      "--max-tokens",
      String(impossibleCap),
      "--brain-dir",
      brainDir,
      "--repo-root",
      root,
    ]);
    expect(cliRes.code).toBe(EXIT_BUDGET_INFEASIBLE);
    expect(cliRes.stdout).toBe("");
    expect(Buffer.byteLength(cliRes.stdout, "utf8")).toBe(0);
    expect(cliRes.stderr).toContain("ERROR [EXIT 3] BUDGET_INFEASIBLE");
    expect(cliRes.stderr).toContain("fix:");
  });

  it("fails closed with exit 4 on future-dated created_at_utc (2099-...) to prevent TTL bypass (Security P2)", () => {
    // 1. Future-dated hypothesis
    {
      const { root, brainDir } = tracker.create("vb-ge2-future-hyp-");
      writeHypothesisFixture(brainDir, {
        id: "HYP-future-ttl-bypass",
        created_at_utc: "2099-01-01T00:00:00Z",
        expires_at_utc: "2099-01-05T00:00:00Z",
        roles: ["builder"],
        hint: "Attempt to bypass 7-day TTL with a year-2099 created_at_utc timestamp.",
      });
      const res = invokeCli([
        "compile",
        "--role",
        "builder",
        "--env",
        "staging",
        "--brain-dir",
        brainDir,
        "--repo-root",
        root,
      ]);
      expect(res.code).toBe(EXIT_PROVENANCE_VIOLATION);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("ERROR [EXIT 4] PROVENANCE_VIOLATION");
      expect(res.stderr).toContain("rule: hypothesis_future_created_at");
    }

    // 2. Future-dated scar
    {
      const { root, brainDir } = tracker.create("vb-ge2-future-scar-");
      writeScarsFixture(brainDir, [
        {
          scar_id: "SCAR-future-ttl-bypass",
          created_at_utc: "2099-01-01T00:00:00Z",
          expires_at_utc: "2099-01-20T00:00:00Z",
          regression_test: "tests/golden/eval-2-budget-eviction.test.ts#L1",
          hint: "Attempt to bypass 30-day scar TTL with a year-2099 created_at_utc timestamp.",
        },
      ]);
      const res = invokeCli([
        "compile",
        "--role",
        "builder",
        "--env",
        "staging",
        "--brain-dir",
        brainDir,
        "--repo-root",
        root,
      ]);
      expect(res.code).toBe(EXIT_PROVENANCE_VIOLATION);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("ERROR [EXIT 4] PROVENANCE_VIOLATION");
      expect(res.stderr).toContain("rule: scar_future_created_at");
    }
  });
});
