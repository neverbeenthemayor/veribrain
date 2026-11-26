import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  initBrain,
  isAgentSigner,
  isPathBlockedByIsolationEnv,
  isSafeHostnameToken,
  parseBlockedIsolationSegments,
  resolveBrainPaths,
  resolveGitContext,
  resolveWorktreeHeadSha,
  sha256Hex,
  VERIBRAIN_HOOK_MARKER,
} from "../../src/index.js";
import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_PROVENANCE_VIOLATION,
  EXIT_QUARANTINE_VIOLATION,
  MAX_SCARS_BYTES,
} from "../../src/types.js";
import {
  collectLeakSubstrings,
  WorkspaceTracker,
  writeDecidedFixture,
  writeHypothesisFixture,
  writeObservedFixture,
  writeScarsFixture,
} from "./helpers.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");
const DIST_CLI = path.join(REPO_ROOT, "dist", "cli.js");

const tracker = new WorkspaceTracker();
const extraCleanupDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  extraCleanupDirs.push(dir);
  return dir;
}

function runDistCli(
  args: readonly string[],
  cwd: string,
  extraEnv?: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.VERIBRAIN_AGENT;
  delete env.VERIBRAIN_AGENT_MODE;
  delete env.VERIBRAIN_CALLER_ROLE;
  if (extraEnv) {
    Object.assign(env, extraEnv);
  }
  const res = spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function isoOffset(baseMs: number, deltaMs: number): string {
  return new Date(baseMs + deltaMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

beforeAll(() => {
  if (!existsSync(DIST_CLI)) {
    const tscEntry = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tscEntry, "-p", "tsconfig.build.json"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
  }
  expect(existsSync(DIST_CLI)).toBe(true);
});

afterEach(() => {
  tracker.cleanupAll();
  while (extraCleanupDirs.length > 0) {
    const dir = extraCleanupDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("PRG-1 (v1.1.0) Customer-Zero Golden Acceptance Suite", () => {
  it("PM-501: supports decide/sign + --mirror-dir + eval --check-mirror drift detection + Exit 4 agent refusal + init wildcard role", () => {
    const repo = makeTempDir("vb-prg1-pm501-repo-");
    const mirror = makeTempDir("vb-prg1-pm501-mirror-");
    const brainDir = path.join(repo, ".brain");

    // 1. init includes "*" wildcard role so custom roles (e.g. cpm) compile DEC-001 out of the box
    const initRes = runDistCli(["init", "--signed-by", "Ian Mayor"], repo);
    expect(initRes.status).toBe(EXIT_OK);
    const dec001Raw = readFileSync(
      path.join(brainDir, "decided", "DEC-001-veribrain-baseline.md"),
      "utf8",
    );
    expect(dec001Raw).toContain('"*"');

    const cpmCompile = runDistCli(
      ["compile", "--role", "cpm", "--env", "staging", "--format", "json"],
      repo,
    );
    expect(cpmCompile.status).toBe(EXIT_OK);
    const cpmJson = JSON.parse(cpmCompile.stdout) as {
      included_decided_ids: string[];
      zone_a: string;
    };
    expect(cpmJson.included_decided_ids).toEqual(["DEC-001"]);
    expect(cpmJson.zone_a).toContain("### [P0] DEC-001");

    // Seed baseline mirror files (config.json, scars.md, DEC-001) so --check-mirror verifies full parity
    mkdirSync(path.join(mirror, "decided"), { recursive: true });
    copyFileSync(path.join(brainDir, "config.json"), path.join(mirror, "config.json"));
    copyFileSync(path.join(brainDir, "scars.md"), path.join(mirror, "scars.md"));
    copyFileSync(
      path.join(brainDir, "decided", "DEC-001-veribrain-baseline.md"),
      path.join(mirror, "decided", "DEC-001-veribrain-baseline.md"),
    );

    // 2. veribrain decide writes pure-LF signed DEC-010 and mirrors byte-for-byte
    const decideRes = runDistCli(
      [
        "decide",
        "--id",
        "DEC-010",
        "--priority",
        "P1",
        "--roles",
        "*,builder,cpm",
        "--envs",
        "staging,prod",
        "--title",
        "Customer Zero Governance",
        "--signed-by",
        "Ian Mayor",
        "--body",
        "All customer-zero governance edits flow through veribrain decide with mirror sync.\r\nZero manual SHA editing.",
        "--mirror-dir",
        mirror,
      ],
      repo,
    );
    expect(decideRes.status).toBe(EXIT_OK);
    expect(decideRes.stdout).toContain("decide ok: DEC-010");
    expect(decideRes.stdout).toContain("mirrors=1");

    const srcDec10 = readFileSync(path.join(brainDir, "decided", "DEC-010.md"));
    const mirrorDec10 = readFileSync(path.join(mirror, "decided", "DEC-010.md"));
    expect(srcDec10.includes(0x0d)).toBe(false);
    expect(sha256Hex(srcDec10)).toBe(sha256Hex(mirrorDec10));

    // 3. eval --strict --check-mirror passes when mirror matches byte-for-byte
    const evalOk = runDistCli(["eval", "--strict", "--check-mirror", "--mirror-dir", mirror], repo);
    expect(evalOk.status).toBe(EXIT_OK);
    expect(evalOk.stdout).toContain("mirror=ok");

    // 4. Mirror drift detection: mutating 1 byte in mirror triggers mirror_sha256_mismatch (exit 1)
    writeFileSync(
      path.join(mirror, "decided", "DEC-010.md"),
      `${mirrorDec10.toString("utf8")}\n`,
      "utf8",
    );
    const evalDrift = runDistCli(
      ["eval", "--strict", "--check-mirror", "--mirror-dir", mirror],
      repo,
    );
    expect(evalDrift.status).toBe(EXIT_ERROR);
    expect(evalDrift.stderr).toContain("mirror_sha256_mismatch");

    // 5. Human edits DEC-010.md with CRLF -> veribrain sign normalizes LF, recomputes sha256_body, re-syncs mirror
    const editedWithCrlf = srcDec10
      .toString("utf8")
      .replace("Zero manual SHA editing.", "Zero manual SHA editing. Re-signed cleanly.")
      .replace(/\n/g, "\r\n");
    writeFileSync(path.join(brainDir, "decided", "DEC-010.md"), editedWithCrlf, "utf8");

    const signRes = runDistCli(
      ["sign", ".brain/decided/DEC-010.md", "--signed-by", "Ian Mayor", "--mirror-dir", mirror],
      repo,
    );
    expect(signRes.status).toBe(EXIT_OK);
    expect(signRes.stdout).toContain("sign ok: DEC-010");
    expect(readFileSync(path.join(brainDir, "decided", "DEC-010.md")).includes(0x0d)).toBe(false);

    const evalResynced = runDistCli(
      ["eval", "--strict", "--check-mirror", "--mirror-dir", mirror],
      repo,
    );
    expect(evalResynced.status).toBe(EXIT_OK);
    expect(evalResynced.stdout).toContain("mirror=ok");

    // 6. Fail-closed Exit 4 agent & non-human refusal on decide & sign (zero stdout, zero file written)
    const agentDecide1 = runDistCli(
      [
        "decide",
        "--id",
        "DEC-999",
        "--priority",
        "P0",
        "--signed-by",
        "Ian Mayor",
        "--body",
        "Agent self-attestation attempt.",
      ],
      repo,
      { VERIBRAIN_AGENT: "1" },
    );
    expect(agentDecide1.status).toBe(EXIT_PROVENANCE_VIOLATION);
    expect(agentDecide1.stdout).toBe("");
    expect(existsSync(path.join(brainDir, "decided", "DEC-999.md"))).toBe(false);

    const agentDecide2 = runDistCli(
      [
        "decide",
        "--id",
        "DEC-998",
        "--priority",
        "P0",
        "--issuer",
        "agent",
        "--signed-by",
        "Ian Mayor",
        "--body",
        "Non-human issuer attempt.",
      ],
      repo,
    );
    expect(agentDecide2.status).toBe(EXIT_PROVENANCE_VIOLATION);
    expect(agentDecide2.stdout).toBe("");

    const botSign = runDistCli(
      ["sign", ".brain/decided/DEC-010.md", "--signed-by", "claude-bot"],
      repo,
    );
    expect(botSign.status).toBe(EXIT_PROVENANCE_VIOLATION);
    expect(botSign.stdout).toBe("");

    // P1-PRG1-1: NFKC homoglyph & delimiter-smuggled agent signer names fail closed (exit 4)
    const fullwidthClaude = "\uFF43\uFF4C\uFF41\uFF55\uFF44\uFF45";
    expect(isAgentSigner(fullwidthClaude)).toBe(true);
    expect(isAgentSigner("ian.claude")).toBe(true);
    for (const sneakySigner of [fullwidthClaude, "ian.claude", "bot.owner"]) {
      const sneakyDecide = runDistCli(
        [
          "decide",
          "--id",
          "DEC-994",
          "--priority",
          "P1",
          "--signed-by",
          sneakySigner,
          "--body",
          "Sneaky signer bypass attempt.",
        ],
        repo,
      );
      expect(sneakyDecide.status).toBe(EXIT_PROVENANCE_VIOLATION);
      expect(sneakyDecide.stdout).toBe("");
      expect(existsSync(path.join(brainDir, "decided", "DEC-994.md"))).toBe(false);
    }

    // 7. Forbidden VERIBRAIN_ISOLATION_SEGMENTS (incl. isolated-app-pm503), UNC, & self-target mirror paths fail closed (exit 4)
    const selfMirror = runDistCli(
      [
        "decide",
        "--id",
        "DEC-997",
        "--priority",
        "P2",
        "--signed-by",
        "Ian Mayor",
        "--body",
        "Self-mirror must fail.",
        "--mirror-dir",
        brainDir,
      ],
      repo,
    );
    expect(selfMirror.status).toBe(EXIT_PROVENANCE_VIOLATION);
    expect(selfMirror.stderr).toContain("mirror_self_target_denied");

    const prevIsolationEnv = process.env.VERIBRAIN_ISOLATION_SEGMENTS;
    try {
      process.env.VERIBRAIN_ISOLATION_SEGMENTS = "isolated-app";
      expect(parseBlockedIsolationSegments()).toEqual(["isolatedapp"]);
      expect(isPathBlockedByIsolationEnv(path.join(repo, "isolated-app"))).toBe(true);
      expect(isPathBlockedByIsolationEnv(path.join(repo, "isolated-app-pm503"))).toBe(true);
      expect(isPathBlockedByIsolationEnv(path.join(repo, "safe-mirror"))).toBe(false);

      for (const blockedMirror of [
        path.join(repo, "isolated-app"),
        path.join(repo, "isolated-app-pm503"),
        "\\\\attacker-host\\share\\brain",
        "//attacker-host/share/brain",
      ]) {
        const blockedRes = runDistCli(
          [
            "decide",
            "--id",
            "DEC-996",
            "--priority",
            "P2",
            "--signed-by",
            "Ian Mayor",
            "--body",
            "Blocked mirror path must fail closed.",
            "--mirror-dir",
            blockedMirror,
          ],
          repo,
        );
        expect(blockedRes.status).toBe(EXIT_PROVENANCE_VIOLATION);
        expect(blockedRes.stdout).toBe("");
        expect(blockedRes.stderr).toContain("unsafe_mirror_dir");
      }
    } finally {
      if (prevIsolationEnv === undefined) {
        delete process.env.VERIBRAIN_ISOLATION_SEGMENTS;
      } else {
        process.env.VERIBRAIN_ISOLATION_SEGMENTS = prevIsolationEnv;
      }
    }

    // 8. Secret in decide --body fails closed with exit 2 and zero raw secret echo
    const fakeSecret = ["AIza", "SyDecideGoldenSecret9876543210"].join("");
    const secretDecide = runDistCli(
      [
        "decide",
        "--id",
        "DEC-995",
        "--priority",
        "P0",
        "--signed-by",
        "Ian Mayor",
        "--body",
        `Never commit ${fakeSecret} in rules.`,
      ],
      repo,
    );
    expect(secretDecide.status).toBe(EXIT_QUARANTINE_VIOLATION);
    expect(secretDecide.stdout).toBe("");
    expect(existsSync(path.join(brainDir, "decided", "DEC-995.md"))).toBe(false);
    for (const frag of collectLeakSubstrings(fakeSecret)) {
      expect(secretDecide.stderr).not.toContain(frag);
    }
  });

  it("PM-502: promotes HYP-SCAR-* to scars.md and HYP-* to DECIDED with mirror sync, cleanup, budget enforcement, and Exit 4/Exit 2 gates", () => {
    const repo = makeTempDir("vb-prg1-pm502-repo-");
    const mirror = makeTempDir("vb-prg1-pm502-mirror-");
    const brainDir = path.join(repo, ".brain");
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const dayMs = 24 * 60 * 60 * 1000;

    expect(runDistCli(["init", "--signed-by", "Ian Mayor"], repo).status).toBe(EXIT_OK);
    mkdirSync(path.join(repo, "tests", "unit"), { recursive: true });
    writeFileSync(
      path.join(repo, "tests", "unit", "promote-guard.test.ts"),
      "// regression test\n",
      "utf8",
    );
    mkdirSync(path.join(mirror, "decided"), { recursive: true });
    copyFileSync(path.join(brainDir, "config.json"), path.join(mirror, "config.json"));
    copyFileSync(path.join(brainDir, "scars.md"), path.join(mirror, "scars.md"));
    copyFileSync(
      path.join(brainDir, "decided", "DEC-001-veribrain-baseline.md"),
      path.join(mirror, "decided", "DEC-001-veribrain-baseline.md"),
    );

    // Queue HYP-SCAR-001 and HYP-DEC-001
    mkdirSync(path.join(brainDir, "hypotheses"), { recursive: true });
    writeFileSync(
      path.join(brainDir, "hypotheses", "HYP-SCAR-001.json"),
      `${JSON.stringify(
        {
          id: "HYP-SCAR-001",
          kind: "scar_proposal",
          issuer: "agent",
          proposed_by: "agent",
          created_at_utc: isoOffset(nowMs, -dayMs),
          expires_at_utc: isoOffset(nowMs, 4 * dayMs),
          proposed_ttl_days: 21,
          regression_test: "tests/unit/promote-guard.test.ts#L1",
          roles: ["builder", "cqe"],
          hint: "Always verify scars.md remains strictly below 4096 bytes before appending.",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeHypothesisFixture(brainDir, {
      id: "HYP-DEC-001",
      created_at_utc: isoOffset(nowMs, -dayMs),
      expires_at_utc: isoOffset(nowMs, 4 * dayMs),
      roles: ["*", "builder"],
      hint: "Keep all active Chief registers below 8192 bytes UTF-8 with pure LF newlines.",
    });

    // 1. Agent mode fails closed (exit 4, zero stdout, hypothesis untouched)
    const agentPromote = runDistCli(["promote", "HYP-SCAR-001"], repo, { VERIBRAIN_AGENT: "1" });
    expect(agentPromote.status).toBe(EXIT_PROVENANCE_VIOLATION);
    expect(agentPromote.stdout).toBe("");
    expect(existsSync(path.join(brainDir, "hypotheses", "HYP-SCAR-001.json"))).toBe(true);

    // 2. Dry-run performs zero writes and leaves HYP-SCAR-001.json intact
    const scarsBefore = readFileSync(path.join(brainDir, "scars.md"), "utf8");
    const dryRunRes = runDistCli(["promote", "HYP-SCAR-001", "--dry-run"], repo);
    expect(dryRunRes.status).toBe(EXIT_OK);
    expect(dryRunRes.stdout).toContain("[dry-run]");
    expect(readFileSync(path.join(brainDir, "scars.md"), "utf8")).toBe(scarsBefore);
    expect(existsSync(path.join(brainDir, "hypotheses", "HYP-SCAR-001.json"))).toBe(true);

    // 3. Real scar promotion appends SCAR-001, stays < 4096 B, mirrors scars.md, deletes HYP-SCAR-001.json, passes eval --strict
    const scarPromote = runDistCli(["promote", "HYP-SCAR-001", "--mirror-dir", mirror], repo);
    expect(scarPromote.status).toBe(EXIT_OK);
    expect(scarPromote.stdout).toContain("promote ok: HYP-SCAR-001 -> SCAR-001 (scar");
    expect(existsSync(path.join(brainDir, "hypotheses", "HYP-SCAR-001.json"))).toBe(false);

    const updatedScars = readFileSync(path.join(brainDir, "scars.md"), "utf8");
    expect(updatedScars).toContain("## SCAR-001");
    expect(updatedScars).toContain("tests/unit/promote-guard.test.ts#L1");
    expect(Buffer.byteLength(updatedScars, "utf8")).toBeLessThan(MAX_SCARS_BYTES);
    expect(readFileSync(path.join(mirror, "scars.md"), "utf8")).toBe(updatedScars);

    // 4. Decided promotion creates signed DEC-020.md, mirrors it, deletes HYP-DEC-001.json, passes eval --strict --check-mirror
    const decPromote = runDistCli(
      [
        "promote",
        "HYP-DEC-001",
        "--to",
        "decided",
        "--id",
        "DEC-020",
        "--priority",
        "P1",
        "--signed-by",
        "Ian Mayor",
        "--mirror-dir",
        mirror,
      ],
      repo,
    );
    expect(decPromote.status).toBe(EXIT_OK);
    expect(decPromote.stdout).toContain("promote ok: HYP-DEC-001 -> DEC-020 (decided");
    expect(existsSync(path.join(brainDir, "hypotheses", "HYP-DEC-001.json"))).toBe(false);
    expect(existsSync(path.join(brainDir, "decided", "DEC-020.md"))).toBe(true);

    const evalMirror = runDistCli(
      ["eval", "--strict", "--check-mirror", "--mirror-dir", mirror],
      repo,
    );
    expect(evalMirror.status).toBe(EXIT_OK);
    expect(evalMirror.stdout).toContain("mirror=ok");

    // 5. Missing regression_test file fails closed (exit 4)
    writeFileSync(
      path.join(brainDir, "hypotheses", "HYP-SCAR-MISSING.json"),
      `${JSON.stringify(
        {
          id: "HYP-SCAR-MISSING",
          kind: "scar_proposal",
          created_at_utc: isoOffset(nowMs, -dayMs),
          expires_at_utc: isoOffset(nowMs, 3 * dayMs),
          regression_test: "tests/unit/nonexistent-file.test.ts#L1",
          roles: ["builder"],
          proposed_by: "agent",
          hint: "Missing regression test must fail closed.",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const missingRefRes = runDistCli(["promote", "HYP-SCAR-MISSING"], repo);
    expect(missingRefRes.status).toBe(EXIT_PROVENANCE_VIOLATION);
    expect(missingRefRes.stdout).toBe("");

    // 6. Poisoned hypothesis containing secret fails closed with exit 2 and zero raw secret echo
    const leaked = ["AIza", "SyPromoteSecretCanary9876543210"].join("");
    writeHypothesisFixture(brainDir, {
      id: "HYP-POISON",
      created_at_utc: isoOffset(nowMs, -dayMs),
      expires_at_utc: isoOffset(nowMs, 3 * dayMs),
      roles: ["builder"],
      hint: `Captured leaked key ${leaked} in logs.`,
    });
    const poisonPromote = runDistCli(
      [
        "promote",
        "HYP-POISON",
        "--to",
        "decided",
        "--id",
        "DEC-099",
        "--priority",
        "P1",
        "--signed-by",
        "Ian Mayor",
      ],
      repo,
    );
    expect(poisonPromote.status).toBe(EXIT_QUARANTINE_VIOLATION);
    expect(poisonPromote.stdout).toBe("");
    for (const frag of collectLeakSubstrings(leaked)) {
      expect(poisonPromote.stderr).not.toContain(frag);
    }
    unlinkSync(path.join(brainDir, "hypotheses", "HYP-POISON.json"));
    unlinkSync(path.join(brainDir, "hypotheses", "HYP-SCAR-MISSING.json"));

    // 7. Enforces scars.md < 4,096 B ceiling on scar promotion
    const fillerScars = [];
    for (let i = 2; i <= 15; i += 1) {
      fillerScars.push({
        scar_id: `SCAR-${String(i).padStart(3, "0")}`,
        created_at_utc: isoOffset(nowMs, -5 * dayMs),
        expires_at_utc: isoOffset(nowMs, 20 * dayMs),
        regression_test: "tests/unit/promote-guard.test.ts#L1",
        hint: `Filler scar #${i} occupying space near the 4096-byte ceiling so promoting another scar overflows cleanly and deterministically.`,
      });
    }
    const scarsPath = writeScarsFixture(brainDir, fillerScars);
    const scarsBytesBeforeOverflow = Buffer.byteLength(readFileSync(scarsPath, "utf8"), "utf8");
    expect(scarsBytesBeforeOverflow).toBeGreaterThanOrEqual(3850);
    expect(scarsBytesBeforeOverflow).toBeLessThan(MAX_SCARS_BYTES);
    writeFileSync(
      path.join(brainDir, "hypotheses", "HYP-SCAR-OVERFLOW.json"),
      `${JSON.stringify(
        {
          id: "HYP-SCAR-OVERFLOW",
          kind: "scar_proposal",
          created_at_utc: isoOffset(nowMs, -dayMs),
          expires_at_utc: isoOffset(nowMs, 3 * dayMs),
          regression_test: "tests/unit/promote-guard.test.ts#L1",
          roles: ["builder"],
          proposed_by: "agent",
          hint: "Overflow scar hint with ample explanatory wording to cross the strict 4096-byte scars.md budget limit.",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const overflowRes = runDistCli(["promote", "HYP-SCAR-OVERFLOW"], repo);
    expect(overflowRes.status).toBe(EXIT_ERROR);
    expect(overflowRes.stderr).toContain("scars_size_limit_exceeded");
    expect(existsSync(path.join(brainDir, "hypotheses", "HYP-SCAR-OVERFLOW.json"))).toBe(true);

    // 8. Duplicate DEC-* overwrite denied (original DEC-020.md & hypothesis preserved)
    const dec20Before = readFileSync(path.join(brainDir, "decided", "DEC-020.md"), "utf8");
    writeHypothesisFixture(brainDir, {
      id: "HYP-DUP-DEC",
      created_at_utc: isoOffset(nowMs, -dayMs),
      expires_at_utc: isoOffset(nowMs, 3 * dayMs),
      roles: ["builder"],
      hint: "Attempt to overwrite existing DEC-020 via promote.",
    });
    const dupDecRes = runDistCli(
      [
        "promote",
        "HYP-DUP-DEC",
        "--to",
        "decided",
        "--id",
        "DEC-020",
        "--priority",
        "P1",
        "--signed-by",
        "Ian Mayor",
      ],
      repo,
    );
    expect(dupDecRes.status).toBe(EXIT_ERROR);
    expect(dupDecRes.stderr).toContain("duplicate_decided_id");
    expect(readFileSync(path.join(brainDir, "decided", "DEC-020.md"), "utf8")).toBe(dec20Before);
    expect(existsSync(path.join(brainDir, "hypotheses", "HYP-DUP-DEC.json"))).toBe(true);

    // 9. Post-eval rollback guard: when strict eval fails (expired scar), DEC-021 is rolled back & HYP-ROLLBACK preserved
    writeScarsFixture(brainDir, [
      {
        scar_id: "SCAR-EXPIRED-ROLLBACK",
        created_at_utc: isoOffset(nowMs, -25 * dayMs),
        expires_at_utc: isoOffset(nowMs, -2 * dayMs),
        regression_test: "tests/unit/promote-guard.test.ts#L1",
        hint: "Expired scar triggers post-promote strict eval failure.",
      },
    ]);
    writeHypothesisFixture(brainDir, {
      id: "HYP-ROLLBACK",
      created_at_utc: isoOffset(nowMs, -dayMs),
      expires_at_utc: isoOffset(nowMs, 3 * dayMs),
      roles: ["builder"],
      hint: "Promotion should roll back cleanly when strict eval fails.",
    });
    const rollbackRes = runDistCli(
      [
        "promote",
        "HYP-ROLLBACK",
        "--to",
        "decided",
        "--id",
        "DEC-021",
        "--priority",
        "P1",
        "--signed-by",
        "Ian Mayor",
        "--mirror-dir",
        mirror,
      ],
      repo,
    );
    expect(rollbackRes.status).toBe(EXIT_ERROR);
    expect(rollbackRes.stderr).toContain("PROMOTE_EVAL_FAILED");
    expect(existsSync(path.join(brainDir, "decided", "DEC-021.md"))).toBe(false);
    expect(existsSync(path.join(mirror, "decided", "DEC-021.md"))).toBe(false);
    expect(existsSync(path.join(brainDir, "hypotheses", "HYP-ROLLBACK.json"))).toBe(true);
  });

  it("PM-503A: resolves pure-fs .git worktree .brain/ and HEAD SHA + emits included_decided_ids/included_observed_ids without altering zone_a_sha256", () => {
    const base = makeTempDir("vb-prg1-worktree-");
    const primaryRepo = path.join(base, "primary");
    const worktreeDir = path.join(base, "wt-feature");
    const gitCommon = path.join(primaryRepo, ".git");
    const wtGitDir = path.join(gitCommon, "worktrees", "wt-feature");
    const wtSha = "1234567890abcdef1234567890abcdef12345678";
    const nowMs = Math.floor(Date.now() / 1000) * 1000;

    mkdirSync(path.join(gitCommon, "refs", "heads"), { recursive: true });
    mkdirSync(path.join(gitCommon, "objects"), { recursive: true });
    mkdirSync(wtGitDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });

    // Real non-symlink Git common metadata (HEAD, objects/, config) + linked worktree layout
    writeFileSync(
      path.join(gitCommon, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n",
      "utf8",
    );
    writeFileSync(path.join(gitCommon, "HEAD"), "ref: refs/heads/main\n", "utf8");
    writeFileSync(path.join(gitCommon, "refs", "heads", "feat-wt"), `${wtSha}\n`, "utf8");
    writeFileSync(path.join(wtGitDir, "commondir"), "../..\n", "utf8");
    writeFileSync(path.join(wtGitDir, "HEAD"), "ref: refs/heads/feat-wt\n", "utf8");
    writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");

    // P1-PRG1-6 negative guard: fake .git missing objects/ + config must be rejected
    const fakeRepo = makeTempDir("vb-prg1-fakegit-");
    mkdirSync(path.join(fakeRepo, ".git"), { recursive: true });
    expect(resolveGitContext(fakeRepo)).toBeNull();

    const primaryBrain = path.join(primaryRepo, ".brain");
    initBrain({ brainDir: primaryBrain, repoRoot: primaryRepo, signedBy: "Ian Mayor" });
    writeDecidedFixture(primaryBrain, {
      id: "DEC-002",
      priority: "P1",
      roles: ["builder"],
      signedAtUtc: isoOffset(nowMs, -3600 * 1000),
      body: "Worktree compiles share byte-identical Zone A with primary checkout.",
    });
    writeObservedFixture(primaryBrain, {
      claim_id: "OBS-wt-1",
      env: "staging",
      git_sha: wtSha,
      observed_at_utc: isoOffset(nowMs, -1800 * 1000),
      ttl_seconds: 7200,
      issuer: "ci",
      roles: ["builder"],
      summary: "Worktree branch staging CI verified green.",
      evidence_ref: "ci:run/wt-1",
    });

    // Pure-fs discovery from nested subdir inside linked worktree (zero git exec!)
    const nestedWorktreeSubdir = path.join(worktreeDir, "packages", "app");
    mkdirSync(nestedWorktreeSubdir, { recursive: true });
    const resolved = resolveBrainPaths(undefined, nestedWorktreeSubdir);
    expect(path.resolve(resolved.brainDir).toLowerCase()).toBe(
      path.resolve(primaryBrain).toLowerCase(),
    );
    expect(resolveWorktreeHeadSha(nestedWorktreeSubdir)).toBe(wtSha);

    // initBrain with allowWorktreeFallback=false stays local to worktreeDir, never clobbering primary
    const localOnly = resolveBrainPaths(undefined, worktreeDir, { allowWorktreeFallback: false });
    expect(path.resolve(localOnly.brainDir).toLowerCase()).toBe(
      path.resolve(path.join(worktreeDir, ".brain")).toLowerCase(),
    );

    // Real CLI compile from primary vs linked worktree produces identical zone_a_sha256 + included IDs
    const primaryComp = runDistCli(
      ["compile", "--role", "builder", "--env", "staging", "--git-sha", wtSha, "--format", "json"],
      primaryRepo,
    );
    const wtComp = runDistCli(
      ["compile", "--role", "builder", "--env", "staging", "--git-sha", wtSha, "--format", "json"],
      worktreeDir,
    );
    expect(primaryComp.status).toBe(EXIT_OK);
    expect(wtComp.status).toBe(EXIT_OK);

    const pJson = JSON.parse(primaryComp.stdout) as {
      zone_a: string;
      zone_a_sha256: string;
      included_decided_ids: string[];
      included_observed_ids: string[];
    };
    const wJson = JSON.parse(wtComp.stdout) as typeof pJson;

    expect(wJson.zone_a_sha256).toBe(pJson.zone_a_sha256);
    expect(wJson.zone_a_sha256).toBe(sha256Hex(Buffer.from(wJson.zone_a, "utf8")));
    expect(wJson.included_decided_ids).toEqual(["DEC-001", "DEC-002"]);
    expect(wJson.included_observed_ids).toEqual(["OBS-wt-1"]);
  });

  it("PM-503B: validates lint-text dry-run, isSafeHostnameToken clean vs hostile URLs, and friendly --env production hint", () => {
    // 1. Direct export isSafeHostnameToken allowlist & hostile URL blocks
    expect(isSafeHostnameToken("https://api.veribrain-staging.example.com/v1/health")).toBe(true);
    expect(isSafeHostnameToken("https://docs.github.com/en/actions/using-workflows")).toBe(true);
    expect(isSafeHostnameToken("https://app-staging-01.us-east.run.app/status")).toBe(true);

    // Hostile URLs blocked
    expect(isSafeHostnameToken("https://user:pass@api.example.com/v1")).toBe(false);
    expect(isSafeHostnameToken("https://api.example.com/v1?token=abcdef1234567890")).toBe(false);
    expect(
      isSafeHostnameToken(
        `https://${["AIza", "SyFakeUrlPrefix1234567890"].join("")}.example.com/v1`,
      ),
    ).toBe(false);
    expect(
      isSafeHostnameToken(
        `https://api.example.com/${["ghp_", "FakeToken12345678901234567890"].join("")}`,
      ),
    ).toBe(false);
    expect(
      isSafeHostnameToken("https://api.example.com/k9Xm2Qp7Rv4Wz8Yn1Bc6Df3Hj5Ln0Tr8Vs2K"),
    ).toBe(false);
    // P1-PRG1-5: Split-segment subdomain/path high-entropy secrets & case-insensitive prefixes blocked
    expect(isSafeHostnameToken("https://k9Xm2Qp7.Rv4Wz8Yn.1Bc6Df3Hj5Ln.example.com/v1")).toBe(
      false,
    );
    expect(
      isSafeHostnameToken("https://api.example.com/k9Xm2Qp7/Rv4Wz8Yn/1Bc6Df3Hj5Ln/0Tr8Vs2K"),
    ).toBe(false);
    expect(
      isSafeHostnameToken(`https://api.example.com/${["aiza", "sy1234567890abcdef"].join("")}`),
    ).toBe(false);

    // 2. lint-text CLI dry-run on clean HTTPS draft vs dirty draft (zero .brain/ mutation, zero secret echo)
    const repo = makeTempDir("vb-prg1-lint-");
    expect(runDistCli(["init", "--signed-by", "Ian Mayor"], repo).status).toBe(EXIT_OK);
    const cleanDraft = path.join(repo, "clean-draft.md");
    writeFileSync(
      cleanDraft,
      [
        "# Architecture Note",
        "Primary API docs live at https://api.veribrain-staging.example.com/v1/health.",
        "Cloud Run staging host: https://app-staging-01.us-east.run.app/status.",
        "",
      ].join("\n"),
      "utf8",
    );

    const lintClean = runDistCli(["lint-text", cleanDraft], repo);
    expect(lintClean.status).toBe(EXIT_OK);
    expect(lintClean.stdout).toContain("lint-text ok: 0 quarantine violations");

    const dirtyKey = ["AIza", "SyLintTextDryRunSecret12345678"].join("");
    const dirtyDraft = path.join(repo, "dirty-draft.md");
    writeFileSync(
      dirtyDraft,
      [
        "# Dirty Draft",
        `Key: ${dirtyKey}`,
        "Leaky URL: https://api.example.com/v1?token=k9Xm2Qp7Rv4Wz8Yn1Bc6Df3Hj5Ln0Tr8Vs2K",
        "Private email: secret.user@private-vault.example",
        "",
      ].join("\n"),
      "utf8",
    );

    const lintJson = runDistCli(["lint-text", dirtyDraft, "--format", "json"], repo);
    expect(lintJson.status).toBe(EXIT_QUARANTINE_VIOLATION);
    const parsedLint = JSON.parse(lintJson.stdout) as {
      clean: boolean;
      matchCount: number;
      matches: Array<{ line: number; rule: string; detail: string; fix: string }>;
    };
    expect(parsedLint.clean).toBe(false);
    expect(parsedLint.matchCount).toBeGreaterThanOrEqual(3);
    const rules = parsedLint.matches.map((m) => m.rule);
    expect(rules).toContain("gcp_api_key");
    expect(rules).toContain("pii_email");
    for (const frag of collectLeakSubstrings(dirtyKey)) {
      expect(lintJson.stdout).not.toContain(frag);
      expect(lintJson.stderr).not.toContain(frag);
    }

    // P1-PRG1-5 end-to-end CLI quarantine: split-segment high-entropy URL rejected by lint-text
    const splitUrlDraft = path.join(repo, "split-url-draft.md");
    const splitHost = ["k9Xm2Qp7", "Rv4Wz8Yn", "1Bc6Df3Hj5Ln"].join(".");
    writeFileSync(
      splitUrlDraft,
      `# Split Secret URL\nEndpoint: https://${splitHost}.example.com/v1\n`,
      "utf8",
    );
    const lintSplit = runDistCli(["lint-text", splitUrlDraft, "--format", "json"], repo);
    expect(lintSplit.status).toBe(EXIT_QUARANTINE_VIOLATION);
    const parsedSplit = JSON.parse(lintSplit.stdout) as {
      clean: boolean;
      matches: Array<{ rule: string }>;
    };
    expect(parsedSplit.clean).toBe(false);
    expect(parsedSplit.matches.map((m) => m.rule)).toContain("high_entropy_secret");
    expect(lintSplit.stdout).not.toContain("k9Xm2Qp7");
    expect(lintSplit.stderr).not.toContain("k9Xm2Qp7");

    // 3. Friendly --env production hint (Exit 1, zero stdout, actionable mapping hint)
    const badEnv = runDistCli(["compile", "--role", "builder", "--env", "production"], repo);
    expect(badEnv.status).toBe(EXIT_ERROR);
    expect(badEnv.stdout).toBe("");
    expect(badEnv.stderr).toContain("invalid_env");
    expect(badEnv.stderr).toContain("production -> prod");
    expect(badEnv.stderr).toContain("development -> local");
  });

  it("PM-504: installs Git hooks in standard repo & linked worktree, preserves unmanaged hooks unless --force, and emits --print-ci YAML", () => {
    const base = makeTempDir("vb-prg1-hooks-");
    const primaryRepo = path.join(base, "primary");
    const worktreeDir = path.join(base, "wt-hooks");
    const gitCommon = path.join(primaryRepo, ".git");
    const wtGitDir = path.join(gitCommon, "worktrees", "wt-hooks");

    mkdirSync(path.join(gitCommon, "objects"), { recursive: true });
    mkdirSync(wtGitDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      path.join(gitCommon, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n",
      "utf8",
    );
    writeFileSync(path.join(gitCommon, "HEAD"), "ref: refs/heads/main\n", "utf8");
    writeFileSync(path.join(wtGitDir, "HEAD"), "ref: refs/heads/wt-hooks\n", "utf8");
    writeFileSync(path.join(wtGitDir, "commondir"), "../..\n", "utf8");
    writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");

    // 1. --print-ci emits valid zero-cost GitHub Actions YAML with zero files written
    const printCi = runDistCli(["hooks", "install", "--print-ci"], primaryRepo);
    expect(printCi.status).toBe(EXIT_OK);
    expect(printCi.stdout).toContain("veribrain eval --strict");
    expect(printCi.stdout).toContain("veribrain observe");
    expect(printCi.stdout).toContain("--issuer ci");
    expect(existsSync(path.join(gitCommon, "hooks", "pre-commit"))).toBe(false);

    // 2. Installing from inside linked worktree writes into shared primary .git/hooks/
    const wtInstall = runDistCli(["hooks", "install"], worktreeDir);
    expect(wtInstall.status).toBe(EXIT_OK);
    expect(wtInstall.stdout).toContain("installed=pre-commit,post-checkout,post-merge");

    const preCommitPath = path.join(gitCommon, "hooks", "pre-commit");
    const postCheckoutPath = path.join(gitCommon, "hooks", "post-checkout");
    const postMergePath = path.join(gitCommon, "hooks", "post-merge");
    expect(existsSync(preCommitPath)).toBe(true);
    expect(existsSync(postCheckoutPath)).toBe(true);
    expect(existsSync(postMergePath)).toBe(true);

    const preCommitText = readFileSync(preCommitPath, "utf8");
    expect(preCommitText).toContain(VERIBRAIN_HOOK_MARKER);
    expect(preCommitText).toContain("eval --strict");
    expect(readFileSync(postCheckoutPath, "utf8")).toContain("--issuer git-hook");
    expect(readFileSync(postMergePath, "utf8")).toContain("--issuer git-hook");

    // 3. Unmanaged custom hook is NOT clobbered without --force, and IS replaced with --force
    const customHook = "#!/bin/sh\necho custom-user-hook\n";
    writeFileSync(preCommitPath, customHook, "utf8");
    const noForce = runDistCli(["hooks", "install"], primaryRepo);
    expect(noForce.status).toBe(EXIT_OK);
    expect(noForce.stdout).toContain("skipped=pre-commit");
    expect(readFileSync(preCommitPath, "utf8")).toBe(customHook);

    const withForce = runDistCli(["hooks", "install", "--force"], primaryRepo);
    expect(withForce.status).toBe(EXIT_OK);
    expect(withForce.stdout).toContain("installed=pre-commit,post-checkout,post-merge");
    expect(readFileSync(preCommitPath, "utf8")).toContain(VERIBRAIN_HOOK_MARKER);
  });
});
