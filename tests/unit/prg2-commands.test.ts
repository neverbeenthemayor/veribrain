import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { attestTest } from "../../src/commands/attest-test.js";
import { checkCitations } from "../../src/commands/check-citations.js";
import { decideRule } from "../../src/commands/decide.js";
import { evaluateBrain } from "../../src/commands/eval.js";
import { initBrain } from "../../src/commands/init.js";
import { proposeScar, recordHypothesis } from "../../src/commands/mcp.js";
import { writeObservation } from "../../src/commands/observe.js";
import { DEFAULT_RETRO_ROLES, generateRetroReport } from "../../src/commands/retro.js";
import { compileContext } from "../../src/compiler.js";
import { computeDecidedBodyHash } from "../../src/normalize.js";
import { clearFileReadCache } from "../../src/schema.js";
import {
  EXIT_BUDGET_INFEASIBLE,
  EXIT_ERROR,
  EXIT_PROVENANCE_VIOLATION,
  EXIT_QUARANTINE_VIOLATION,
  MAX_ENV_TTL_SECONDS,
  type VeriBrainError,
  ZONE_A0_BOUNDARY_MARKER,
} from "../../src/types.js";

const tempDirs: string[] = [];

function makeTempDir(prefix = "veribrain-prg2-unit-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function captureCli(
  argv: string[],
  env?: NodeJS.ProcessEnv,
): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = runCli(argv, {
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    env: env ?? {},
  });
  return { code, stdout, stderr };
}

function writeDecidedRaw(
  brainDir: string,
  params: {
    id: string;
    priority: "P0" | "P1" | "P2";
    roles: string[];
    status?: "active" | "superseded";
    supersedes?: string;
    title?: string;
    body: string;
    signedAtUtc?: string;
  },
): void {
  const sha = computeDecidedBodyHash(params.body);
  const lines = [
    "---",
    `id: ${params.id}`,
    ...(params.title ? [`title: ${params.title}`] : []),
    `priority: ${params.priority}`,
    `roles: [${params.roles.map((r) => (r === "*" ? '"*"' : r)).join(", ")}]`,
    "signed_by: Ian Mayor",
    `signed_at_utc: ${params.signedAtUtc ?? "2026-11-27T09:00:00Z"}`,
    `sha256_body: ${sha}`,
    `status: ${params.status ?? "active"}`,
    ...(params.supersedes ? [`supersedes: ${params.supersedes}`] : []),
    "---",
    params.body,
    "",
  ];
  writeFileSync(path.join(brainDir, "decided", `${params.id}.md`), lines.join("\n"), "utf8");
}

afterEach(() => {
  clearFileReadCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("PRG-2 (v1.2.0) Unit Suite: PM-601..PM-605", () => {
  it("PM-601: split Zone A0+A1 yields 100% byte-identical zone_a0_sha256 across all 8 roles while preserving 1.0 legacy byte invariance", () => {
    const root = makeTempDir();
    const brainDir = path.join(root, ".brain");
    initBrain({ brainDir, repoRoot: root, signedBy: "Ian Mayor", envVars: {} });

    // Shared constitutional rules (with enough tokens to exceed 1,024 floor) + role-specific rules
    const longSharedBody = Array.from(
      { length: 40 },
      (_, idx) =>
        `Constitutional invariant clause ${idx + 1}: deterministic compilation keeps Zone A0 completely invariant across all engineering roles with zero volatile timestamps.`,
    ).join("\n");
    writeDecidedRaw(brainDir, {
      id: "DEC-002",
      priority: "P0",
      roles: ["*"],
      body: longSharedBody,
    });
    writeDecidedRaw(brainDir, {
      id: "DEC-003",
      priority: "P1",
      roles: ["builder"],
      body: "Builder-only TypeScript ESM rule.",
    });
    writeDecidedRaw(brainDir, {
      id: "DEC-004",
      priority: "P1",
      roles: ["security"],
      body: "Security-only red-team audit rule.",
    });

    // Legacy 1.0 default: zone_a0 equals zone_a, zone_a1 empty, zero A0_END marker
    const legacy = compileContext({
      role: "builder",
      env: "staging",
      brainDir,
      repoRoot: root,
    });
    expect(legacy.schema_version).toBe("1.0");
    expect(legacy.zone_a_layout).toBe("legacy");
    expect(legacy.zone_a0).toBe(legacy.zone_a);
    expect(legacy.zone_a1).toBe("");
    expect(legacy.zone_a0_sha256).toBe(legacy.zone_a_sha256);
    expect(legacy.zone_a1_bytes).toBe(0);
    expect(legacy.zone_a1_tokens_est).toBe(0);
    expect(legacy.zone_a).not.toContain(ZONE_A0_BOUNDARY_MARKER);

    // Explicit split override on 1.0 config -> byte-identical zone_a0 across all 8 Chief roles!
    const a0Hashes = new Set<string>();
    for (const role of DEFAULT_RETRO_ROLES) {
      const splitRes = compileContext({
        role,
        env: "staging",
        zoneALayout: "split",
        brainDir,
        repoRoot: root,
      });
      expect(splitRes.zone_a_layout).toBe("split");
      expect(splitRes.zone_a0).not.toContain(`role: ${role}`);
      expect(splitRes.zone_a0).not.toContain(`Role: ${role}`);
      expect(splitRes.zone_a1).toContain(`role: ${role}`);
      expect(splitRes.zone_a).toBe(
        `${splitRes.zone_a0}${ZONE_A0_BOUNDARY_MARKER}\n\n${splitRes.zone_a1}`,
      );
      expect(splitRes.zone_a0_tokens_est).toBeGreaterThanOrEqual(1024);
      expect(splitRes.kv_cache_floor_advisory).toBeNull();
      a0Hashes.add(splitRes.zone_a0_sha256);
    }
    expect(a0Hashes.size).toBe(1);

    // Builder sees DEC-003 in zone_a1; security sees DEC-004 in zone_a1; cpm sees _No role-specific DECIDED rules._
    const bSplit = compileContext({
      role: "builder",
      env: "staging",
      zoneALayout: "split",
      brainDir,
      repoRoot: root,
    });
    const sSplit = compileContext({
      role: "security",
      env: "staging",
      zoneALayout: "split",
      brainDir,
      repoRoot: root,
    });
    const cSplit = compileContext({
      role: "cpm",
      env: "staging",
      zoneALayout: "split",
      brainDir,
      repoRoot: root,
    });
    expect(bSplit.zone_a1).toContain("DEC-003");
    expect(bSplit.zone_a1).not.toContain("DEC-004");
    expect(sSplit.zone_a1).toContain("DEC-004");
    expect(sSplit.zone_a1).not.toContain("DEC-003");
    expect(cSplit.zone_a1).toContain("_No role-specific DECIDED rules._");

    // Schema 1.1 defaults automatically to split layout; invalid layout fails EXIT_ERROR
    const cfgPath = path.join(brainDir, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.schema_version = "1.1";
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    const v11Auto = compileContext({
      role: "builder",
      env: "local",
      brainDir,
      repoRoot: root,
      bypassReadCache: true,
    });
    expect(v11Auto.schema_version).toBe("1.1");
    expect(v11Auto.zone_a_layout).toBe("split");

    const badLayout = captureCli([
      "compile",
      "--role",
      "builder",
      "--env",
      "local",
      "--zone-a-layout",
      "bogus",
      "--brain-dir",
      brainDir,
    ]);
    expect(badLayout.code).toBe(EXIT_ERROR);
  });

  it("PM-602: attest-test enforces Exit 4 in agent mode, blocks shell metacharacters, hashes output without echoing secrets, and records pass / --record-failure", () => {
    const root = makeTempDir();
    const brainDir = path.join(root, ".brain");
    initBrain({ brainDir, repoRoot: root, signedBy: "Ian Mayor", envVars: {} });

    // Agent mode fails closed with Exit 4 BEFORE executing anything
    const agentRes = captureCli(
      [
        "attest-test",
        "--git-sha",
        "abcdef1",
        "--brain-dir",
        brainDir,
        "--repo-root",
        root,
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { VERIBRAIN_AGENT: "1" },
    );
    expect(agentRes.code).toBe(EXIT_PROVENANCE_VIOLATION);
    expect(agentRes.stdout).toBe("");

    // Shell metacharacters in --cmd fail closed with Exit 1
    for (const badCmd of [
      "node -v; echo pwn",
      "node -v && echo pwn",
      "node -v | cat",
      "node $(whoami)",
      "node `id`",
      "node -v > out.txt",
    ]) {
      try {
        attestTest({ cmd: badCmd, gitSha: "abcdef1", brainDir, repoRoot: root, envVars: {} });
        expect.unreachable(`metacharacter cmd must fail: ${badCmd}`);
      } catch (err) {
        expect((err as VeriBrainError).exitCode).toBe(EXIT_ERROR);
        expect((err as VeriBrainError).rule).toBe("unsafe_shell_metacharacters");
      }
    }

    // Passing command whose child stdout/stderr emits a secret canary: NEVER echoed into receipt or CLI output!
    const secretCanary = ["AIza", "SyAttestCanaryMustNeverAppear1234"].join("");
    const childCanaryExpr = '["AIza","SyAttestCanaryMustNeverAppear1234"].join("")';
    const passRes = attestTest({
      argv: [
        process.execPath,
        "-e",
        `const s=${childCanaryExpr}; console.log("passed "+s); console.error("warn "+s);`,
      ],
      env: "staging",
      gitSha: "abcdef1234",
      ttlSeconds: 3600,
      ttlMode: "env-ttl",
      brainDir,
      repoRoot: root,
      envVars: {},
    });
    expect(passRes.passed).toBe(true);
    expect(passRes.recorded).toBe(true);
    expect(passRes.file_path).toBeTruthy();
    expect(passRes.claim_id.startsWith("OBS-VERIFY-")).toBe(true);
    expect(passRes.output_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(passRes.git_diff_stat_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(passRes)).not.toContain(secretCanary);
    expect(JSON.stringify(passRes)).not.toContain("AIza");

    const writtenJson = readFileSync(passRes.file_path as string, "utf8");
    expect(writtenJson).toContain('"issuer": "verifier-script"');
    expect(writtenJson).toContain('"ttl_mode": "env-ttl"');
    expect(writtenJson).not.toContain(secretCanary);

    // evaluateBrain --strict MUST pass cleanly on an attest-test-generated receipt
    expect(evaluateBrain({ brainDir, repoRoot: root, strict: true }).ok).toBe(true);

    // Failing command without --record-failure returns Exit 1 and writes NO receipt
    const failNoRecord = captureCli([
      "attest-test",
      "--claim-id",
      "OBS-VERIFY-fail-skip",
      "--git-sha",
      "abcdef1",
      "--brain-dir",
      brainDir,
      "--repo-root",
      root,
      "--",
      process.execPath,
      "-e",
      `console.error("secret "+${childCanaryExpr}); process.exit(2);`,
    ]);
    expect(failNoRecord.code).toBe(EXIT_ERROR);
    expect(failNoRecord.stderr).not.toContain(secretCanary);
    expect(existsSync(path.join(brainDir, "observed", "OBS-VERIFY-fail-skip.json"))).toBe(false);

    // Failing command WITH --record-failure returns Exit 1 AND writes receipt
    const failRecorded = captureCli([
      "attest-test",
      "--claim-id",
      "OBS-VERIFY-fail-rec",
      "--git-sha",
      "abcdef1",
      "--record-failure",
      "--brain-dir",
      brainDir,
      "--repo-root",
      root,
      "--",
      process.execPath,
      "-e",
      "process.exit(3)",
    ]);
    expect(failRecorded.code).toBe(EXIT_ERROR);
    expect(existsSync(path.join(brainDir, "observed", "OBS-VERIFY-fail-rec.json"))).toBe(true);

    // --dry-run runs command without writing receipt
    const dryRunRes = attestTest({
      argv: [process.execPath, "-e", "process.exit(0)"],
      claimId: "OBS-VERIFY-dry-1",
      gitSha: "abcdef1",
      dryRun: true,
      brainDir,
      repoRoot: root,
      envVars: {},
    });
    expect(dryRunRes.passed).toBe(true);
    expect(dryRunRes.recorded).toBe(false);
    expect(dryRunRes.dry_run).toBe(true);
    expect(existsSync(path.join(brainDir, "observed", "OBS-VERIFY-dry-1.json"))).toBe(false);
  });

  it("PM-603: check-citations skips fenced code blocks, ignores placeholders, detects missing/superseded/expired drift, and rejects path traversal (Exit 4)", () => {
    const root = makeTempDir();
    const brainDir = path.join(root, ".brain");
    const now = new Date("2026-11-27T10:00:00Z");
    initBrain({ brainDir, repoRoot: root, signedBy: "Ian Mayor", now, envVars: {} });

    writeDecidedRaw(brainDir, {
      id: "DEC-002",
      priority: "P1",
      roles: ["*"],
      status: "superseded",
      body: "Old superseded policy.",
    });
    writeDecidedRaw(brainDir, {
      id: "DEC-003",
      priority: "P1",
      roles: ["*"],
      status: "active",
      supersedes: "DEC-002",
      body: "Replacement policy for DEC-002.",
    });
    writeObservation({
      claimId: "OBS-live-1",
      env: "staging",
      gitSha: "abcdef1",
      ttlSeconds: 3600,
      summary: "Live check.",
      evidenceRef: "ci:1",
      issuer: "ci",
      brainDir,
      repoRoot: root,
      now,
      envVars: {},
    });
    writeObservation({
      claimId: "OBS-expired-1",
      env: "staging",
      gitSha: "abcdef1",
      ttlSeconds: 60,
      summary: "Expired check.",
      evidenceRef: "ci:2",
      issuer: "ci",
      brainDir,
      repoRoot: root,
      now: new Date(now.getTime() - 120_000),
      envVars: {},
    });

    mkdirSync(path.join(root, "docs", "archive"), { recursive: true });
    // Excluded archive doc citing missing DEC-999 must NOT be scanned by default
    writeFileSync(path.join(root, "docs", "archive", "old.md"), "Archived DEC-999.\n", "utf8");

    // Clean doc with valid citations, placeholders, and fenced code block containing DEC-888
    writeFileSync(
      path.join(root, "README.md"),
      [
        "Valid rules: DEC-001, DEC-003, OBS-live-1.",
        "Placeholders: DEC-NNN, DEC-###, OBS-XXX, DEC-000, OBS-ID, DEC-FOO-EXAMPLE, OBS-VERIFY-*.",
        "```bash",
        "veribrain decide --id DEC-888 --body 'inside code fence'",
        "```",
        "",
      ].join("\n"),
      "utf8",
    );

    const cleanRes = checkCitations({ brainDir, repoRoot: root, now });
    expect(cleanRes.ok).toBe(true);
    expect(cleanRes.issues).toEqual([]);

    // With --include-code-blocks, DEC-888 inside fence IS flagged
    const withCode = checkCitations({
      brainDir,
      repoRoot: root,
      includeCodeBlocks: true,
      now,
    });
    expect(withCode.ok).toBe(false);
    expect(
      withCode.issues.some((i) => i.claim_id === "DEC-888" && i.kind === "missing_decided"),
    ).toBe(true);

    // Add doc with all 4 drift classes
    writeFileSync(
      path.join(root, "docs", "policy.md"),
      [
        "Missing decided: DEC-404.",
        "Superseded decided: DEC-002.",
        "Missing observed: OBS-404.",
        "Expired observed: OBS-expired-1.",
        "",
      ].join("\n"),
      "utf8",
    );

    const driftRes = checkCitations({ brainDir, repoRoot: root, now });
    expect(driftRes.ok).toBe(false);
    expect(driftRes.issues.map((i) => i.kind)).toEqual([
      "missing_decided",
      "superseded_decided",
      "missing_observed",
      "expired_observed",
    ]);
    const sup = driftRes.issues.find((i) => i.kind === "superseded_decided");
    expect(sup?.replacement_id).toBe("DEC-003");
    expect(sup?.detail).toContain("superseded by DEC-003");

    // --decided-only skips OBS-* issues
    const decidedOnly = checkCitations({ brainDir, repoRoot: root, decidedOnly: true, now });
    expect(decidedOnly.issues.map((i) => i.kind)).toEqual([
      "missing_decided",
      "superseded_decided",
    ]);

    // Path traversal escape in --paths fails closed with Exit 4
    try {
      checkCitations({ paths: ["../outside.md"], brainDir, repoRoot: root, now });
      expect.unreachable("traversal path must fail Exit 4");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
    }
  });

  it("PM-604: env-ttl survives cross-commit compiles, stays env-isolated, caps TTL <= 7d, and retro generates uncapped audit digest", () => {
    const root = makeTempDir();
    const brainDir = path.join(root, ".brain");
    const now = new Date("2026-11-27T10:00:00Z");
    initBrain({ brainDir, repoRoot: root, signedBy: "Ian Mayor", now, envVars: {} });
    mkdirSync(path.join(root, "tests", "unit"), { recursive: true });
    writeFileSync(path.join(root, "tests", "unit", "ok.test.ts"), "// ok\n", "utf8");

    // env-ttl > 7d rejected fail-closed
    try {
      writeObservation({
        claimId: "OBS-too-long",
        env: "staging",
        gitSha: "aaaa111",
        ttlSeconds: MAX_ENV_TTL_SECONDS + 1,
        ttlMode: "env-ttl",
        summary: "Too long.",
        evidenceRef: "ci:1",
        issuer: "ci",
        brainDir,
        repoRoot: root,
        now,
        envVars: {},
      });
      expect.unreachable("env-ttl > 7d must fail");
    } catch (err) {
      expect((err as VeriBrainError).rule).toBe("env_ttl_exceeded");
    }

    // Valid env-ttl observation on commit aaaa111 + sha-pinned on commit aaaa111
    writeObservation({
      claimId: "OBS-env-live",
      env: "staging",
      gitSha: "aaaa111",
      ttlSeconds: 3600,
      ttlMode: "env-ttl",
      summary: "Staging smoke green.",
      evidenceRef: "ci:run/10",
      issuer: "ci",
      brainDir,
      repoRoot: root,
      now,
      envVars: {},
    });
    writeObservation({
      claimId: "OBS-sha-pinned",
      env: "staging",
      gitSha: "aaaa111",
      ttlSeconds: 3600,
      ttlMode: "sha-pinned",
      summary: "Commit aaaa111 green.",
      evidenceRef: "ci:run/11",
      issuer: "ci",
      brainDir,
      repoRoot: root,
      now,
      envVars: {},
    });

    // Compile against NEW commit bbbb222 on staging: env-ttl survives, sha-pinned excluded!
    const stagingNewCommit = compileContext({
      role: "builder",
      env: "staging",
      gitSha: "bbbb222",
      brainDir,
      repoRoot: root,
      now,
    });
    expect(stagingNewCommit.included_observed_ids).toEqual(["OBS-env-live"]);
    expect(stagingNewCommit.excluded_stale_ids).toContain("OBS-sha-pinned");
    expect(stagingNewCommit.zone_b).toContain("Based on: OBS-env-live (staging@aaaa111, env-ttl)");

    // Compile on prod: staging env-ttl observation is strictly excluded!
    const prodCompile = compileContext({
      role: "builder",
      env: "prod",
      gitSha: "bbbb222",
      brainDir,
      repoRoot: root,
      now,
    });
    expect(prodCompile.included_observed_ids).toEqual([]);
    expect(prodCompile.excluded_stale_ids).toContain("OBS-env-live");

    // Compile after expiry: env-ttl is excluded!
    const afterExpiry = compileContext({
      role: "builder",
      env: "staging",
      gitSha: "bbbb222",
      brainDir,
      repoRoot: root,
      now: new Date(now.getTime() + 4000 * 1000),
    });
    expect(afterExpiry.included_observed_ids).toEqual([]);
    expect(afterExpiry.excluded_stale_ids).toContain("OBS-env-live");

    // Evaluate passes on valid env-ttl
    expect(evaluateBrain({ brainDir, repoRoot: root, strict: true, now }).ok).toBe(true);

    // Queue a hypothesis & scar proposal and run retro report
    recordHypothesis({
      id: "HYP-RETRO-1",
      hint: "Evaluate split prefix token floor.",
      brainDir,
      repoRoot: root,
      now,
    });
    proposeScar({
      id: "HYP-SCAR-RETRO-1",
      hint: "Keep A0 free of role strings.",
      regressionTest: "tests/unit/ok.test.ts#L1",
      brainDir,
      repoRoot: root,
      now,
    });
    decideRule({
      id: "DEC-002",
      priority: "P1",
      signedBy: "Ian Mayor",
      body: "Shared rule for retro audit.",
      brainDir,
      repoRoot: root,
      now,
      envVars: {},
    });

    const retro = generateRetroReport({
      since: "7d",
      env: "staging",
      zoneALayout: "split",
      brainDir,
      repoRoot: root,
      now,
    });
    expect(retro.eval_ok).toBe(true);
    expect(retro.zone_a_layout).toBe("split");
    expect(retro.role_floor_audit).toHaveLength(8);
    expect(
      retro.expiring_items.some((e) => e.id === "OBS-env-live" && e.status === "expiring_48h"),
    ).toBe(true);
    expect(retro.pending_hypotheses).toHaveLength(2);
    expect(retro.markdown).toContain("# VeriBrain Retrospective Report");
    expect(retro.markdown).toContain("veribrain promote HYP-SCAR-RETRO-1 --to scar");
    expect(retro.markdown).toContain("veribrain promote HYP-RETRO-1 --to decided");
  });

  it("Security & CQE Hardening (P1-PRG2-1..3, P2-PRG2-1..2, P3-PRG2-2, CQE P3-2)", () => {
    const root = makeTempDir();
    const brainDir = path.join(root, ".brain");
    const now = new Date("2026-11-27T10:00:00Z");
    initBrain({ brainDir, repoRoot: root, signedBy: "Ian Mayor", now, envVars: {} });

    // 1. P1-PRG2-1: Raw quarantine scan on attest-test executable/args BEFORE truncation, even with --dry-run
    const splitSecret = ["AIza", "SyRawArgSecretMustBlock1234567890123"].join("");
    for (const badArgv of [
      [process.execPath, "-e", `console.log("${splitSecret}")`],
      [process.execPath, "alice@example.com"],
      [process.execPath, `--token=${splitSecret}`],
    ]) {
      try {
        attestTest({
          argv: badArgv,
          gitSha: "abcdef1",
          dryRun: true,
          brainDir,
          repoRoot: root,
          envVars: {},
        });
        expect.unreachable(`Raw secret/PII argv must quarantine: ${badArgv[1]}`);
      } catch (err) {
        expect((err as VeriBrainError).exitCode).toBe(EXIT_QUARANTINE_VIOLATION);
      }
    }

    // Non-secret arg with '=' or '@' is redacted in command/evidence_ref/summary (never leaked)
    const redactedArgRes = attestTest({
      argv: [process.execPath, "--token=localdev123", "--version"],
      gitSha: "abcdef1",
      dryRun: true,
      brainDir,
      repoRoot: root,
      envVars: {},
    });
    expect(redactedArgRes.command).toContain("redacted-arg");
    expect(redactedArgRes.command).not.toContain("localdev123");
    expect(redactedArgRes.evidence_ref).not.toContain("localdev123");
    expect(redactedArgRes.summary).not.toContain("localdev123");

    // 2. P2-PRG2-2: VERIBRAIN_AGENT=1 attest-test --invalid fails closed with Exit 4 BEFORE flag parsing
    const agentInvalid = captureCli(["attest-test", "--invalid"], { VERIBRAIN_AGENT: "1" });
    expect(agentInvalid.code).toBe(EXIT_PROVENANCE_VIOLATION);
    expect(agentInvalid.stdout).toBe("");

    // Mixing `--` with `--arg` fails closed with Exit 1
    try {
      attestTest({
        argv: [process.execPath, "--version"],
        args: ["--extra"],
        gitSha: "abcdef1",
        brainDir,
        repoRoot: root,
        envVars: {},
      });
      expect.unreachable("mixing -- and --arg must fail");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_ERROR);
      expect((err as VeriBrainError).rule).toBe("ambiguous_command");
    }

    // NUL byte in command arg fails closed with Exit 1
    try {
      attestTest({
        argv: [process.execPath, "bad\0arg"],
        gitSha: "abcdef1",
        brainDir,
        repoRoot: root,
        envVars: {},
      });
      expect.unreachable("NUL char in arg must fail");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_ERROR);
      expect((err as VeriBrainError).rule).toBe("invalid_command_arg");
    }

    // 3. CQE P3-2: attest-test --timeout 100 on sleeping child -> timed_out: true, Exit 1
    const timeoutRes = captureCli([
      "attest-test",
      "--timeout",
      "100",
      "--git-sha",
      "abcdef1",
      "--format",
      "json",
      "--brain-dir",
      brainDir,
      "--repo-root",
      root,
      "--",
      process.execPath,
      "-e",
      "setTimeout(() => {}, 2500)",
    ]);
    expect(timeoutRes.code).toBe(EXIT_ERROR);
    const timeoutJson = JSON.parse(timeoutRes.stdout) as { timed_out: boolean; passed: boolean };
    expect(timeoutJson.timed_out).toBe(true);
    expect(timeoutJson.passed).toBe(false);

    // 4. P1-PRG2-2: check-citations --paths ../outside-dir fails Exit 4 BEFORE lstatSync & never echoes raw path
    const outsideDirName = "vb-outside-probe-secret-dir";
    const outsideDir = path.resolve(root, "..", outsideDirName);
    mkdirSync(outsideDir, { recursive: true });
    tempDirs.push(outsideDir);
    try {
      checkCitations({ paths: [`../${outsideDirName}`], brainDir, repoRoot: root, now });
      expect.unreachable("outside-dir path must fail Exit 4");
    } catch (err) {
      const vbErr = err as VeriBrainError;
      expect(vbErr.exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
      expect(vbErr.detail).not.toContain(outsideDirName);
      expect(vbErr.fix).not.toContain(outsideDirName);
    }

    // UNC path refused with Exit 4 in checkCitations and attestTest
    try {
      checkCitations({ repoRoot: "\\\\server\\share\\repo", brainDir });
      expect.unreachable("UNC repoRoot must fail Exit 4");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
    }

    // 5. P1-PRG2-3: Oversized root *.md (> 512 KB) fails closed with Exit 1 (not silently skipped)
    const oversizedRoot = makeTempDir("vb-prg2-oversized-");
    const oversizedBrain = path.join(oversizedRoot, ".brain");
    initBrain({
      brainDir: oversizedBrain,
      repoRoot: oversizedRoot,
      signedBy: "Ian Mayor",
      now,
      envVars: {},
    });
    writeFileSync(path.join(oversizedRoot, "HUGE.md"), `${"a".repeat(512 * 1024 + 64)}\n`, "utf8");
    try {
      checkCitations({ brainDir: oversizedBrain, repoRoot: oversizedRoot, now });
      expect.unreachable("oversized root markdown must fail Exit 1");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_ERROR);
      expect((err as VeriBrainError).rule).toBe("file_size_limit_exceeded");
    }

    // 6. P2-PRG2-1: Symlinked / junctioned .brain/observed fails closed with Exit 4
    const symRoot = makeTempDir("vb-prg2-symobs-");
    const symBrain = path.join(symRoot, ".brain");
    const escapeTarget = makeTempDir("vb-prg2-symescape-");
    initBrain({ brainDir: symBrain, repoRoot: symRoot, signedBy: "Ian Mayor", now, envVars: {} });
    rmSync(path.join(symBrain, "observed"), { recursive: true, force: true });
    symlinkSync(
      escapeTarget,
      path.join(symBrain, "observed"),
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      writeObservation({
        claimId: "OBS-sym-escape",
        env: "local",
        gitSha: "abcdef1",
        ttlSeconds: 3600,
        summary: "Should fail.",
        evidenceRef: "ci:1",
        issuer: "ci",
        brainDir: symBrain,
        repoRoot: symRoot,
        now,
        envVars: {},
      });
      expect.unreachable("symlinked .brain/observed must fail Exit 4");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
    }

    // 7. CQE P3-2: Split-mode compileContext throws EXIT_BUDGET_INFEASIBLE (Exit 3) when tight
    try {
      compileContext({
        role: "builder",
        env: "local",
        zoneALayout: "split",
        maxTokens: 50,
        brainDir,
        repoRoot: root,
        now,
      });
      expect.unreachable("tight maxTokens in split mode must throw Exit 3");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_BUDGET_INFEASIBLE);
    }

    // 8. P3-PRG2-2 & CQE P3-2: retro rejects > 32 roles AND renders eval_ok:false + MISSING scar row
    try {
      generateRetroReport({
        roles: Array.from({ length: 33 }, (_, i) => `role-${i}`),
        brainDir,
        repoRoot: root,
        now,
      });
      expect.unreachable("> 32 roles in retro must fail Exit 1");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_ERROR);
      expect((err as VeriBrainError).rule).toBe("role_limit_exceeded");
    }

    // Add a scar pointing to a missing regression test so strict eval fails (eval_ok: false)
    const badBrainRoot = makeTempDir("vb-prg2-retro-fail-");
    const badBrainDir = path.join(badBrainRoot, ".brain");
    initBrain({
      brainDir: badBrainDir,
      repoRoot: badBrainRoot,
      signedBy: "Ian Mayor",
      now,
      envVars: {},
    });
    writeFileSync(
      path.join(badBrainDir, "scars.md"),
      [
        "# Scars",
        "",
        "## SCAR-MISS-1",
        "- created_at_utc: 2026-11-26T00:00:00Z",
        "- expires_at_utc: 2026-12-20T00:00:00Z",
        "- regression_test: tests/unit/does-not-exist.test.ts#L1",
        "- roles: [*]",
        "- hint: Ensure missing scar tests are flagged in retro.",
        "",
      ].join("\n"),
      "utf8",
    );

    const badRetro = generateRetroReport({
      since: "7d",
      env: "local",
      zoneALayout: "split",
      brainDir: badBrainDir,
      repoRoot: badBrainRoot,
      now,
    });
    expect(badRetro.eval_ok).toBe(false);
    expect(badRetro.scar_checks.some((s) => s.scar_id === "SCAR-MISS-1" && !s.test_exists)).toBe(
      true,
    );
    expect(badRetro.markdown).toContain("FAIL");
    expect(badRetro.markdown).toContain("MISSING");
    expect(badRetro.markdown).toContain("SCAR-MISS-1");
  });
});
