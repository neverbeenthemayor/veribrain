import { afterEach, describe, expect, it } from "vitest";
import { evaluateBrain } from "../../src/commands/eval.js";
import { compileContext } from "../../src/compiler.js";
import { EXIT_ERROR } from "../../src/types.js";
import {
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

describe("Golden Context Eval #3: Stale (env, git_sha, ttl) Auto-Expiry", () => {
  it("excludes expired, wrong-env, and wrong-git-sha claims from Zone B and lists them in sorted excluded_stale_ids", () => {
    const { root, brainDir } = tracker.create("vb-ge3-");
    writeDecidedFixture(brainDir, {
      id: "DEC-001",
      priority: "P0",
      roles: ["builder"],
      body: "Staging verification claims expire automatically once TTL elapses or commit changes.",
    });

    const targetSha = "abc1234dead5678";
    const compileTime = new Date("2026-11-28T12:00:00Z");

    // 1. Fresh exact match
    writeObservedFixture(brainDir, {
      claim_id: "OBS-fresh-exact",
      env: "staging",
      git_sha: targetSha,
      observed_at_utc: "2026-11-28T11:30:00Z",
      ttl_seconds: 3600,
      issuer: "ci",
      roles: ["builder"],
      summary: "FRESH_EXACT_STAGING_HEALTH_OK",
      evidence_ref: "ci:run/100",
    });

    // 2. Fresh matching SHA differing only by hex case
    writeObservedFixture(brainDir, {
      claim_id: "OBS-fresh-upper-sha",
      env: "staging",
      git_sha: targetSha.toUpperCase(),
      observed_at_utc: "2026-11-28T11:45:00Z",
      ttl_seconds: 1800,
      issuer: "git-hook",
      roles: ["builder"],
      summary: "FRESH_UPPERCASE_SHA_MATCH_OK",
      evidence_ref: "hook:pre-push/101",
    });

    // 3. Exact TTL boundary: observed at 11:00:00Z + 3600s === 12:00:00Z (still fresh at exact boundary)
    writeObservedFixture(brainDir, {
      claim_id: "OBS-boundary-exact",
      env: "staging",
      git_sha: targetSha,
      observed_at_utc: "2026-11-28T11:00:00Z",
      ttl_seconds: 3600,
      issuer: "verifier-script",
      roles: ["builder"],
      summary: "BOUNDARY_EXACT_TTL_STILL_FRESH",
      evidence_ref: "script:verify/102",
    });

    // 4. Expired by 1 second: 11:00:00Z + 3599s < 12:00:00Z
    writeObservedFixture(brainDir, {
      claim_id: "OBS-expired-1s",
      env: "staging",
      git_sha: targetSha,
      observed_at_utc: "2026-11-28T11:00:00Z",
      ttl_seconds: 3599,
      issuer: "ci",
      roles: ["builder"],
      summary: "STALE_EXPIRED_BY_ONE_SECOND_MUST_NOT_APPEAR",
      evidence_ref: "ci:run/103",
    });

    // 5. Wrong env (prod & local)
    writeObservedFixture(brainDir, {
      claim_id: "OBS-wrong-env-prod",
      env: "prod",
      git_sha: targetSha,
      observed_at_utc: "2026-11-28T11:55:00Z",
      ttl_seconds: 3600,
      issuer: "ci",
      roles: ["builder"],
      summary: "STALE_WRONG_ENV_PROD_MUST_NOT_APPEAR",
      evidence_ref: "ci:run/104",
    });
    writeObservedFixture(brainDir, {
      claim_id: "OBS-wrong-env-local",
      env: "local",
      git_sha: targetSha,
      observed_at_utc: "2026-11-28T11:55:00Z",
      ttl_seconds: 3600,
      issuer: "git-hook",
      roles: ["builder"],
      summary: "STALE_WRONG_ENV_LOCAL_MUST_NOT_APPEAR",
      evidence_ref: "hook:local/105",
    });

    // 6. Wrong git_sha
    writeObservedFixture(brainDir, {
      claim_id: "OBS-wrong-sha",
      env: "staging",
      git_sha: "deadbeef9999",
      observed_at_utc: "2026-11-28T11:55:00Z",
      ttl_seconds: 3600,
      issuer: "ci",
      roles: ["builder"],
      summary: "STALE_WRONG_GIT_SHA_MUST_NOT_APPEAR",
      evidence_ref: "ci:run/106",
    });

    // 7. Non-matching role (must not appear in zone_b OR excluded_stale_ids)
    writeObservedFixture(brainDir, {
      claim_id: "OBS-other-role",
      env: "staging",
      git_sha: targetSha,
      observed_at_utc: "2026-11-28T11:55:00Z",
      ttl_seconds: 3600,
      issuer: "ci",
      roles: ["cfoe"],
      summary: "OTHER_ROLE_ONLY_CLAIM",
      evidence_ref: "ci:run/107",
    });

    // 8. Expired scar and expired hypothesis
    writeScarsFixture(brainDir, [
      {
        scar_id: "SCAR-expired",
        created_at_utc: "2026-10-01T00:00:00Z",
        expires_at_utc: "2026-10-25T00:00:00Z",
        regression_test: "tests/golden/eval-3-stale-expiry.test.ts#L1",
        roles: ["builder"],
        hint: "EXPIRED_SCAR_MUST_NOT_APPEAR",
      },
      {
        scar_id: "SCAR-active",
        created_at_utc: "2026-11-20T00:00:00Z",
        expires_at_utc: "2026-12-15T00:00:00Z",
        regression_test: "tests/golden/eval-3-stale-expiry.test.ts#L2",
        roles: ["builder"],
        hint: "ACTIVE_SCAR_SHOULD_APPEAR",
      },
    ]);
    writeHypothesisFixture(brainDir, {
      id: "HYP-expired",
      created_at_utc: "2026-11-18T00:00:00Z",
      expires_at_utc: "2026-11-24T00:00:00Z",
      roles: ["builder"],
      hint: "EXPIRED_HYP_MUST_NOT_APPEAR",
    });

    const result = compileContext({
      role: "builder",
      env: "staging",
      gitSha: targetSha,
      brainDir,
      repoRoot: root,
      now: compileTime,
    });

    // Fresh claims present with mandatory citations
    expect(result.zone_b).toContain("FRESH_EXACT_STAGING_HEALTH_OK");
    expect(result.zone_b).toContain(`Based on: OBS-fresh-exact (staging@${targetSha})`);
    expect(result.zone_b).toContain("FRESH_UPPERCASE_SHA_MATCH_OK");
    expect(result.zone_b).toContain("BOUNDARY_EXACT_TTL_STILL_FRESH");
    expect(result.zone_b).toContain("ACTIVE_SCAR_SHOULD_APPEAR");

    // Stale claims completely absent from Zone B and Zone A
    const forbidden = [
      "OBS-expired-1s",
      "STALE_EXPIRED_BY_ONE_SECOND_MUST_NOT_APPEAR",
      "OBS-wrong-env-prod",
      "STALE_WRONG_ENV_PROD_MUST_NOT_APPEAR",
      "OBS-wrong-env-local",
      "STALE_WRONG_ENV_LOCAL_MUST_NOT_APPEAR",
      "OBS-wrong-sha",
      "STALE_WRONG_GIT_SHA_MUST_NOT_APPEAR",
      "OBS-other-role",
      "OTHER_ROLE_ONLY_CLAIM",
      "SCAR-expired",
      "EXPIRED_SCAR_MUST_NOT_APPEAR",
      "HYP-expired",
      "EXPIRED_HYP_MUST_NOT_APPEAR",
    ];
    for (const token of forbidden) {
      expect(result.zone_b).not.toContain(token);
      expect(result.zone_a).not.toContain(token);
    }

    expect(result.excluded_stale_ids).toEqual([
      "HYP-expired",
      "OBS-expired-1s",
      "OBS-wrong-env-local",
      "OBS-wrong-env-prod",
      "OBS-wrong-sha",
      "SCAR-expired",
    ]);

    // Advance clock by 1 second: OBS-boundary-exact must now auto-expire too
    const oneSecondLater = compileContext({
      role: "builder",
      env: "staging",
      gitSha: targetSha,
      brainDir,
      repoRoot: root,
      now: new Date("2026-11-28T12:00:01Z"),
    });
    expect(oneSecondLater.zone_b).not.toContain("OBS-boundary-exact");
    expect(oneSecondLater.excluded_stale_ids).toContain("OBS-boundary-exact");
  });

  it("omitting --git-sha accepts fresh same-env records across commits while still excluding wrong-env and expired records, and strict eval flags expiry", () => {
    const { root, brainDir } = tracker.create("vb-ge3-nosha-");
    writeDecidedFixture(brainDir, {
      id: "DEC-001",
      priority: "P0",
      roles: ["builder"],
      body: "Environment isolation always applies even when git SHA filter is omitted.",
    });

    writeObservedFixture(brainDir, {
      claim_id: "OBS-staging-a",
      env: "staging",
      git_sha: "1111111",
      observed_at_utc: "2026-11-28T11:50:00Z",
      ttl_seconds: 3600,
      issuer: "ci",
      roles: ["builder"],
      summary: "Staging commit A verified.",
      evidence_ref: "ci:run/a",
    });
    writeObservedFixture(brainDir, {
      claim_id: "OBS-staging-b",
      env: "staging",
      git_sha: "2222222",
      observed_at_utc: "2026-11-28T11:55:00Z",
      ttl_seconds: 3600,
      issuer: "ci",
      roles: ["builder"],
      summary: "Staging commit B verified.",
      evidence_ref: "ci:run/b",
    });
    writeObservedFixture(brainDir, {
      claim_id: "OBS-staging-expired",
      env: "staging",
      git_sha: "3333333",
      observed_at_utc: "2026-11-28T09:00:00Z",
      ttl_seconds: 60,
      issuer: "ci",
      roles: ["builder"],
      summary: "Expired staging check.",
      evidence_ref: "ci:run/c",
    });
    writeObservedFixture(brainDir, {
      claim_id: "OBS-prod-fresh",
      env: "prod",
      git_sha: "4444444",
      observed_at_utc: "2026-11-28T11:55:00Z",
      ttl_seconds: 3600,
      issuer: "ci",
      roles: ["builder"],
      summary: "Fresh prod check.",
      evidence_ref: "ci:run/d",
    });

    const now = new Date("2026-11-28T12:00:00Z");
    const compiled = compileContext({
      role: "builder",
      env: "staging",
      brainDir,
      repoRoot: root,
      now,
    });

    expect(compiled.zone_b).toContain("OBS-staging-a");
    expect(compiled.zone_b).toContain("OBS-staging-b");
    expect(compiled.zone_b).not.toContain("OBS-staging-expired");
    expect(compiled.zone_b).not.toContain("OBS-prod-fresh");
    expect(compiled.excluded_stale_ids).toEqual(["OBS-prod-fresh", "OBS-staging-expired"]);

    const strictEval = evaluateBrain({
      strict: true,
      brainDir,
      repoRoot: root,
      now,
    });
    expect(strictEval.ok).toBe(false);
    expect(strictEval.exitCode).toBe(EXIT_ERROR);
    expect(
      strictEval.issues.some(
        (issue) => issue.claimId === "OBS-staging-expired" && issue.rule === "observed_expired",
      ),
    ).toBe(true);
  });
});
