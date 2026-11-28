import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { decideRule } from "../../src/commands/decide.js";
import { formatDoctorMarkdown, formatDoctorText, runDoctor } from "../../src/commands/doctor.js";
import { VERIBRAIN_HOOK_MARKER } from "../../src/commands/hooks.js";
import { initBrain } from "../../src/commands/init.js";
import { proposeScar, recordHypothesis } from "../../src/commands/mcp.js";
import { writeObservation } from "../../src/commands/observe.js";
import { runStats } from "../../src/commands/stats.js";
import { compileContext } from "../../src/compiler.js";
import { METRICS_FILENAME } from "../../src/metrics.js";
import { syncMirrorFiles } from "../../src/mirror.js";
import { compareAscii, sha256Hex } from "../../src/normalize.js";
import { clearFileReadCache } from "../../src/schema.js";
import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_PROVENANCE_VIOLATION,
  EXIT_QUARANTINE_VIOLATION,
  type VeriBrainError,
} from "../../src/types.js";

const tempDirs: string[] = [];

function makeTempDir(prefix = "veribrain-prg4-unit-"): string {
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

function hashDirectoryTree(rootDir: string): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort(compareAscii)) {
      const full = path.join(dir, name);
      const rel = path.relative(rootDir, full).split(path.sep).join("/");
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        entries.push(`L:${rel}`);
      } else if (st.isDirectory()) {
        entries.push(`D:${rel}`);
        walk(full);
      } else if (st.isFile()) {
        entries.push(`F:${rel}:${sha256Hex(readFileSync(full))}`);
      }
    }
  };
  walk(rootDir);
  return sha256Hex(entries.join("\n"));
}

function buildLongConstitutionalBody(): string {
  const p =
    "All engineers and agents must enforce deterministic compilation, byte-frozen Zone A0 prefixes, strict human provenance, and zero secret persistence across every role and environment.";
  return Array.from({ length: 24 }, (_, idx) => `${idx + 1}. ${p}`).join("\n");
}

function createFakeGitWithPreCommitHook(repoRoot: string, managed: boolean): void {
  const gitDir = path.join(repoRoot, ".git");
  mkdirSync(path.join(gitDir, "objects"), { recursive: true });
  mkdirSync(path.join(gitDir, "hooks"), { recursive: true });
  writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  writeFileSync(path.join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n", "utf8");
  const hookBody = managed
    ? `#!/bin/sh\n${VERIBRAIN_HOOK_MARKER}\nveribrain eval --strict\n`
    : "#!/bin/sh\necho custom hook\n";
  writeFileSync(path.join(gitDir, "hooks", "pre-commit"), hookBody, "utf8");
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

describe("PRG-4 (v1.4.0) PM-702 Unit Suite: veribrain doctor", () => {
  it("proves strict read-only execution (even with metrics.enabled=true) and 100% byte determinism across repeated runs", () => {
    const root = makeTempDir();
    const brainDir = path.join(root, ".brain");
    const now = new Date("2026-11-28T10:00:00Z");
    initBrain({ brainDir, repoRoot: root, signedBy: "Ian Mayor", now, envVars: {} });
    runStats({ enable: true, brainDir, repoRoot: root, now, envVars: {} });

    const beforeHash = hashDirectoryTree(root);
    const res1 = runDoctor({ brainDir, repoRoot: root, now, envVars: {} });
    const res2 = runDoctor({ brainDir, repoRoot: root, now, envVars: {} });
    const cliRun = captureCli(["doctor", "--brain-dir", brainDir, "--repo-root", root]);
    const afterHash = hashDirectoryTree(root);

    expect(afterHash).toBe(beforeHash);
    expect(existsSync(path.join(brainDir, METRICS_FILENAME))).toBe(false);
    expect(cliRun.code).toBe(EXIT_OK);
    expect(JSON.stringify(res1)).toBe(JSON.stringify(res2));
    expect(formatDoctorText(res1)).toBe(formatDoctorText(res2));
    expect(formatDoctorMarkdown(res1)).toBe(formatDoctorMarkdown(res2));
  });

  it("progresses deterministically across Maturity L0 -> L1 -> L2 -> L3 -> L4 and respects --strict and agent mode", () => {
    const root = makeTempDir();
    const brainDir = path.join(root, ".brain");
    const now = new Date("2026-11-28T10:00:00Z");

    // L0: missing .brain/ -> FAIL, exit 1, init fix, dependent checks INFO skipped
    const l0 = runDoctor({ brainDir, repoRoot: root, now, envVars: {} });
    expect(l0.ok).toBe(false);
    expect(l0.exit_code).toBe(EXIT_ERROR);
    expect(l0.maturity.level).toBe("L0");
    expect(l0.checks.find((c) => c.id === "brain.present")?.status).toBe("FAIL");
    expect(l0.checks.find((c) => c.id === "brain.present")?.fix[0]).toContain("veribrain init");
    for (const dep of l0.checks.slice(1)) {
      expect(dep.status).toBe("INFO");
      expect(dep.summary).toContain("skipped");
    }

    // L1: initialized with DEC-001 (< 1024 split A0 tokens)
    initBrain({ brainDir, repoRoot: root, signedBy: "Ian Mayor", now, envVars: {} });
    const l1 = runDoctor({ brainDir, repoRoot: root, now, envVars: {} });
    expect(l1.ok).toBe(true);
    expect(l1.exit_code).toBe(EXIT_OK);
    expect(l1.maturity.level).toBe("L1");
    expect(l1.checks.find((c) => c.id === "zone_a0.floor")?.status).toBe("WARN");
    expect(l1.checks.find((c) => c.id === "tier2.observed")?.status).toBe("WARN");

    // --strict turns WARN into Exit 1
    const l1Strict = runDoctor({ brainDir, repoRoot: root, strict: true, now, envVars: {} });
    expect(l1Strict.ok).toBe(false);
    expect(l1Strict.exit_code).toBe(EXIT_ERROR);

    // Agent mode is ALLOWED for read-only doctor
    const agentRes = captureCli(["doctor", "--brain-dir", brainDir, "--repo-root", root], {
      VERIBRAIN_AGENT: "1",
    });
    expect(agentRes.code).toBe(EXIT_OK);
    expect(agentRes.stdout).toContain("Maturity: L1/4");

    // L2: add shared constitutional DEC-002 >= 1024 est. tokens (still schema 1.0 -> zone_a0.floor INFO)
    decideRule({
      id: "DEC-002",
      priority: "P0",
      roles: ["*"],
      signedBy: "Ian Mayor",
      title: "Shared Constitutional Floor",
      body: buildLongConstitutionalBody(),
      brainDir,
      repoRoot: root,
      now,
      envVars: {},
    });
    const l2 = runDoctor({ brainDir, repoRoot: root, now, envVars: {} });
    expect(l2.maturity.level).toBe("L2");
    expect(l2.checks.find((c) => c.id === "zone_a0.floor")?.status).toBe("INFO");
    expect(formatDoctorText(l2)).toContain("Maturity: L2/4 (Tier 1 + shared prefix)");

    // Switch to schema 1.1 -> zone_a0.floor becomes PASS
    const cfgPath = path.join(brainDir, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.schema_version = "1.1";
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    const l2v11 = runDoctor({ brainDir, repoRoot: root, now, envVars: {} });
    expect(l2v11.checks.find((c) => c.id === "zone_a0.floor")?.status).toBe("PASS");

    // L3: add active Tier 2 OBSERVED + managed pre-commit hook
    writeObservation({
      claimId: "OBS-VERIFY-test-local",
      env: "local",
      gitSha: "abcdef1234",
      ttlSeconds: 86_400,
      ttlMode: "env-ttl",
      summary: "Unit suite passed.",
      evidenceRef: "verifier:exit=0",
      issuer: "verifier-script",
      brainDir,
      repoRoot: root,
      now,
      envVars: {},
    });
    const l3NoHook = runDoctor({ brainDir, repoRoot: root, now, envVars: {} });
    expect(l3NoHook.maturity.level).toBe("L3");
    expect(l3NoHook.checks.find((c) => c.id === "tier2.observed")?.status).toBe("INFO");

    createFakeGitWithPreCommitHook(root, true);
    const l3WithHook = runDoctor({ brainDir, repoRoot: root, now, envVars: {} });
    expect(l3WithHook.maturity.level).toBe("L3");
    expect(l3WithHook.checks.find((c) => c.id === "tier2.observed")?.status).toBe("PASS");

    // L4: add valid scar with existing regression test + enable telemetry + record 1 compile
    mkdirSync(path.join(root, "tests", "unit"), { recursive: true });
    writeFileSync(path.join(root, "tests", "unit", "scar-lock.test.ts"), "// test\n", "utf8");
    writeFileSync(
      path.join(brainDir, "scars.md"),
      [
        "# Scars",
        "",
        "## SCAR-001",
        "- created_at_utc: 2026-11-27T00:00:00Z",
        "- expires_at_utc: 2026-12-20T00:00:00Z",
        "- regression_test: tests/unit/scar-lock.test.ts#L1",
        "- roles: [*]",
        "- hint: Keep Zone A0 free of role names.",
        "",
      ].join("\n"),
      "utf8",
    );
    runStats({ enable: true, brainDir, repoRoot: root, now, envVars: {} });
    compileContext({
      role: "builder",
      env: "local",
      brainDir,
      repoRoot: root,
      now,
      envVars: {},
    });

    const l4 = runDoctor({ brainDir, repoRoot: root, strict: true, now, envVars: {} });
    expect(l4.ok).toBe(true);
    expect(l4.exit_code).toBe(EXIT_OK);
    expect(l4.maturity.level).toBe("L4");
    expect(l4.counts.fail).toBe(0);
    expect(l4.counts.warn).toBe(0);
    expect(l4.counts.pass).toBe(8);
    expect(formatDoctorText(l4)).toContain("Maturity: L4/4 (Full 3-tier + telemetry)");
  });

  it("covers every check edge case: empty/non-shared decided, budget FAIL, scars budget/missing test/pending proposal, expired hypotheses, mirror drift", () => {
    const root = makeTempDir();
    const brainDir = path.join(root, ".brain");
    const now = new Date("2026-11-28T10:00:00Z");

    // 0 decided rules -> tier1.decided WARN with placeholder DEC-NNN only
    initBrain({ brainDir, repoRoot: root, now, envVars: {} });
    const noDec = runDoctor({ brainDir, repoRoot: root, now, envVars: {} });
    expect(noDec.maturity.level).toBe("L0");
    const t1Empty = noDec.checks.find((c) => c.id === "tier1.decided");
    expect(t1Empty?.status).toBe("WARN");
    expect(t1Empty?.fix[0]).toContain("DEC-NNN");

    // Role-specific decided only (no "*") -> tier1.decided WARN
    decideRule({
      id: "DEC-002",
      priority: "P1",
      roles: ["builder"],
      signedBy: "Ian Mayor",
      body: "Builder-only rule.",
      brainDir,
      repoRoot: root,
      now,
      envVars: {},
    });
    const noShared = runDoctor({ brainDir, repoRoot: root, now, envVars: {} });
    expect(noShared.checks.find((c) => c.id === "tier1.decided")?.status).toBe("WARN");

    // Tight default_max_tokens -> zone_a0.floor FAIL (Exit 3 caught cleanly as FAIL check)
    const cfgPath = path.join(brainDir, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.default_max_tokens = 25;
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    const budgetFail = runDoctor({ brainDir, repoRoot: root, now, envVars: {} });
    expect(budgetFail.ok).toBe(false);
    expect(budgetFail.exit_code).toBe(EXIT_ERROR);
    expect(budgetFail.checks.find((c) => c.id === "zone_a0.floor")?.status).toBe("FAIL");

    // Restore max_tokens, add pending HYP-SCAR proposal, missing scar test, expired hypothesis, and mirror drift
    cfg.default_max_tokens = 8192;
    const mirrorDir = makeTempDir("veribrain-prg4-mirror-");
    cfg.mirror_dirs = [mirrorDir];
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    syncMirrorFiles(brainDir, [mirrorDir], ["config.json", "scars.md"]); // intentionally omit decided/DEC-002.md to trigger drift

    mkdirSync(path.join(root, "tests", "unit"), { recursive: true });
    writeFileSync(path.join(root, "tests", "unit", "ok.test.ts"), "// ok\n", "utf8");
    proposeScar({
      id: "HYP-SCAR-01",
      hint: "Prevent missing scar test links.",
      regressionTest: "tests/unit/ok.test.ts#L1",
      brainDir,
      repoRoot: root,
      now,
    });
    recordHypothesis({
      id: "HYP-EXPIRED-01",
      hint: "Old hypothesis.",
      ttlDays: 1,
      brainDir,
      repoRoot: root,
      now: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
    });
    writeFileSync(
      path.join(brainDir, "scars.md"),
      [
        "# Scars",
        "",
        "## SCAR-MISSING-TEST",
        "- created_at_utc: 2026-11-26T00:00:00Z",
        "- expires_at_utc: 2026-12-20T00:00:00Z",
        "- regression_test: tests/unit/does-not-exist.test.ts#L1",
        "- roles: [*]",
        "- hint: Missing test link.",
        "",
      ].join("\n"),
      "utf8",
    );

    const mixed = runDoctor({ brainDir, repoRoot: root, now, envVars: {} });
    expect(mixed.checks.find((c) => c.id === "eval.strict")?.status).toBe("FAIL");
    expect(mixed.checks.find((c) => c.id === "tier3.scars")?.status).toBe("WARN");
    expect(mixed.checks.find((c) => c.id === "tier3.scars")?.fix).toContain(
      "veribrain promote <HYP-ID> --to scar",
    );
    expect(mixed.checks.find((c) => c.id === "tier3.hypotheses")?.status).toBe("WARN");
    expect(mixed.maturity.level).toBe("L0");

    // Text formatting stays <= 30 lines, <= 80 cols, plain ASCII
    const txt = formatDoctorText(mixed);
    const lines = txt.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(30);
    for (const line of lines) {
      expect(line.length, `Doctor text line > 80 cols: ${line}`).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7E]*$/.test(line), `Non-ASCII doctor line: ${line}`).toBe(true);
    }
  });

  it("enforces confinement (Exit 4/1), raw flag quarantine (Exit 2 zero echo), and help UX limits", () => {
    const root = makeTempDir();
    const brainDir = path.join(root, ".brain");
    const targetDir = makeTempDir("veribrain-prg4-symtarget-");
    initBrain({ brainDir, repoRoot: root, signedBy: "Ian Mayor", envVars: {} });

    // Missing --repo-root -> Exit 1 REPO_ROOT_NOT_FOUND
    try {
      runDoctor({ repoRoot: path.join(root, "does-not-exist") });
      expect.unreachable("missing repoRoot must fail Exit 1");
    } catch (err) {
      const vb = err as VeriBrainError;
      expect(vb.exitCode).toBe(EXIT_ERROR);
      expect(vb.code).toBe("REPO_ROOT_NOT_FOUND");
    }

    // Symlinked --repo-root -> Exit 4
    const linkDir = path.join(root, "sym-link");
    symlinkSync(targetDir, linkDir, process.platform === "win32" ? "junction" : "dir");
    try {
      runDoctor({ repoRoot: linkDir });
      expect.unreachable("symlinked repoRoot must fail Exit 4");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
    }

    // Symlinked ancestor --brain-dir ./sym-link/.brain -> Exit 4
    try {
      runDoctor({ repoRoot: root, brainDir: path.join(linkDir, ".brain") });
      expect.unreachable("symlinked brain ancestor must fail Exit 4");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
    }

    // UNC path -> Exit 4
    try {
      runDoctor({ repoRoot: "\\\\server\\share\\repo" });
      expect.unreachable("UNC path must fail Exit 4");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
    }

    // Secret passed via --role, --env, or --format -> Exit 2 with ZERO prefix echo
    const splitSecret = ["AIza", "SyDoctorSecretFlagNeverEcho123456"].join("");
    for (const flag of ["--role", "--env", "--format"] as const) {
      const qRes = captureCli([
        "doctor",
        flag,
        splitSecret,
        "--brain-dir",
        brainDir,
        "--repo-root",
        root,
      ]);
      expect(qRes.code, `Expected Exit 2 for ${flag}`).toBe(EXIT_QUARANTINE_VIOLATION);
      expect(qRes.stdout).toBe("");
      expect(qRes.stderr).not.toContain("AIza");
      expect(qRes.stderr).not.toContain("DoctorSecretFlag");
    }

    // Invalid non-secret --env / --format / --role / unknown flag -> Exit 1
    expect(
      captureCli(["doctor", "--env", "production", "--brain-dir", brainDir, "--repo-root", root])
        .code,
    ).toBe(EXIT_ERROR);
    expect(
      captureCli(["doctor", "--format", "yaml", "--brain-dir", brainDir, "--repo-root", root]).code,
    ).toBe(EXIT_ERROR);
    expect(
      captureCli(["doctor", "--role", "bad role!", "--brain-dir", brainDir, "--repo-root", root])
        .code,
    ).toBe(EXIT_ERROR);
    expect(captureCli(["doctor", "--unknown-flag"]).code).toBe(EXIT_ERROR);

    // Help budgets: global == 20 lines (<= 20) with exact combined eval / doctor line; doctor <= 12 lines
    const globalHelp = captureCli(["--help"]);
    expect(globalHelp.code).toBe(EXIT_OK);
    const globalLines = globalHelp.stdout.trimEnd().split("\n");
    expect(globalLines.length).toBeLessThanOrEqual(20);
    expect(globalLines).toContain(
      "  eval / doctor    $0 schema/quarantine checks or guided maturity report",
    );
    for (const line of globalLines) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7E]*$/.test(line)).toBe(true);
    }

    const docHelp = captureCli(["doctor", "--help"]);
    expect(docHelp.code).toBe(EXIT_OK);
    expect(docHelp.stdout).toContain(
      "Exits: 0 ok | 1 FAIL (WARN w/ --strict) | 2 quarantine | 4 confinement",
    );
    const docHelpLines = docHelp.stdout.trimEnd().split("\n");
    expect(docHelpLines.length).toBeLessThanOrEqual(12);
    for (const line of docHelpLines) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7E]*$/.test(line)).toBe(true);
    }
  });

  it("PRG-4 Security Hardening (P1-PRG4-1..3, P2-PRG4-1, P3-PRG4-2): tier symlink confinement, depth-0 git/worktree hook verification, ENOTDIR, and flag quarantine precedence", () => {
    const now = new Date("2026-11-28T10:00:00Z");
    const splitSecret = ["AIza", "SyDoctorSymlinkTargetSecret999999"].join("");

    // 1. P1-PRG4-1 & CQE P2-2: symlinked scars.md (whose target contains a secret) MUST fail Exit 4 BEFORE any read (NOT Exit 2!)
    const symBrainRepo = makeTempDir("vb-prg4-symbrain-");
    const symBrain = path.join(symBrainRepo, ".brain");
    const outsideSecretDir = makeTempDir("vb-prg4-outsec-");
    const outsideSecretFile = path.join(outsideSecretDir, "secret-scars.md");
    writeFileSync(outsideSecretFile, `# Secret ${splitSecret}\n`, "utf8");
    initBrain({
      brainDir: symBrain,
      repoRoot: symBrainRepo,
      signedBy: "Ian Mayor",
      now,
      envVars: {},
    });
    rmSync(path.join(symBrain, "scars.md"), { force: true });
    try {
      symlinkSync(outsideSecretFile, path.join(symBrain, "scars.md"), "file");
    } catch {
      symlinkSync(outsideSecretDir, path.join(symBrain, "scars.md"), "junction");
    }
    try {
      runDoctor({ brainDir: symBrain, repoRoot: symBrainRepo, now, envVars: {} });
      expect.unreachable("symlinked scars.md must fail Exit 4 before read");
    } catch (err) {
      const vb = err as VeriBrainError;
      expect(vb.exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
      expect(vb.detail).not.toContain(outsideSecretDir);
    }

    // Symlinked .brain/decided directory -> Exit 4 BEFORE any read
    const symTierRepo = makeTempDir("vb-prg4-symtier-");
    const symTierBrain = path.join(symTierRepo, ".brain");
    initBrain({
      brainDir: symTierBrain,
      repoRoot: symTierRepo,
      signedBy: "Ian Mayor",
      now,
      envVars: {},
    });
    rmSync(path.join(symTierBrain, "decided"), { recursive: true, force: true });
    symlinkSync(
      outsideSecretDir,
      path.join(symTierBrain, "decided"),
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      runDoctor({ brainDir: symTierBrain, repoRoot: symTierRepo, now, envVars: {} });
      expect.unreachable("symlinked .brain/decided must fail Exit 4");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
    }

    // 2. P1-PRG4-2 & P1-PRG4-3: Crafted gitdir:, symlinked gitdir:, and child dir under parent git repo
    const otherGitRepo = makeTempDir("vb-prg4-othergit-");
    initBrain({
      brainDir: path.join(otherGitRepo, ".brain"),
      repoRoot: otherGitRepo,
      signedBy: "Ian Mayor",
      now,
      envVars: {},
    });
    createFakeGitWithPreCommitHook(otherGitRepo, true);

    // 2a. Crafted .git file pointing to another repo's .git (no worktree backlink): hook=false AND does NOT pull other repo's .brain!
    const craftedRepo = makeTempDir("vb-prg4-crafted-");
    writeFileSync(
      path.join(craftedRepo, ".git"),
      `gitdir: ${path.join(otherGitRepo, ".git")}\n`,
      "utf8",
    );
    const craftedUninit = runDoctor({ repoRoot: craftedRepo, now, envVars: {} });
    expect(craftedUninit.maturity.level).toBe("L0");
    expect(craftedUninit.checks.find((c) => c.id === "brain.present")?.status).toBe("FAIL");

    // Even when initialized locally, crafted gitdir: without valid backlink reports hook absent
    initBrain({
      brainDir: path.join(craftedRepo, ".brain"),
      repoRoot: craftedRepo,
      signedBy: "Ian Mayor",
      now,
      envVars: {},
    });
    const craftedInit = runDoctor({ repoRoot: craftedRepo, now, envVars: {} });
    expect(craftedInit.checks.find((c) => c.id === "tier2.observed")?.summary).toContain(
      "hook absent",
    );

    // 2b. gitdir: ./sym/fake-git through a symlinked directory -> returns hook absent
    const symGitRepo = makeTempDir("vb-prg4-symgit-");
    initBrain({
      brainDir: path.join(symGitRepo, ".brain"),
      repoRoot: symGitRepo,
      signedBy: "Ian Mayor",
      now,
      envVars: {},
    });
    const symContainer = path.join(symGitRepo, "sym");
    symlinkSync(
      path.join(otherGitRepo, ".git"),
      symContainer,
      process.platform === "win32" ? "junction" : "dir",
    );
    writeFileSync(path.join(symGitRepo, ".git"), "gitdir: ./sym\n", "utf8");
    const symGitDoc = runDoctor({ repoRoot: symGitRepo, now, envVars: {} });
    expect(symGitDoc.checks.find((c) => c.id === "tier2.observed")?.summary).toContain(
      "hook absent",
    );

    // 2c. Non-git child dir under a parent git repo: must NOT inherit parent's hook OR parent's .brain!
    const childDir = path.join(otherGitRepo, "packages", "subpkg");
    mkdirSync(childDir, { recursive: true });
    const childUninit = runDoctor({ repoRoot: childDir, now, envVars: {} });
    expect(childUninit.maturity.level).toBe("L0");
    expect(childUninit.checks.find((c) => c.id === "brain.present")?.status).toBe("FAIL");
    initBrain({
      brainDir: path.join(childDir, ".brain"),
      repoRoot: childDir,
      signedBy: "Ian Mayor",
      now,
      envVars: {},
    });
    const childInit = runDoctor({ repoRoot: childDir, now, envVars: {} });
    expect(childInit.checks.find((c) => c.id === "tier2.observed")?.summary).toContain(
      "hook absent",
    );

    // 2d. Valid linked worktree with real <commonDir>/worktrees/wt1/gitdir backlink -> managed hook detected!
    const wtRepo = makeTempDir("vb-prg4-validwt-");
    const wtGitDir = path.join(otherGitRepo, ".git", "worktrees", "wt1");
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(path.join(wtGitDir, "commondir"), "../..\n", "utf8");
    writeFileSync(path.join(wtGitDir, "HEAD"), "ref: refs/heads/wt1\n", "utf8");
    writeFileSync(path.join(wtGitDir, "gitdir"), `${path.join(wtRepo, ".git")}\n`, "utf8");
    writeFileSync(path.join(wtRepo, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");
    initBrain({
      brainDir: path.join(wtRepo, ".brain"),
      repoRoot: wtRepo,
      signedBy: "Ian Mayor",
      now,
      envVars: {},
    });
    const wtDoc = runDoctor({ repoRoot: wtRepo, now, envVars: {} });
    expect(wtDoc.checks.find((c) => c.id === "tier2.observed")?.summary).toContain(
      "managed hook ok",
    );

    // 3. P2-PRG4-1: ENOTDIR (--repo-root <file>/sub and --brain-dir <file>/.brain) -> static Exit 4, zero path echo
    const fileHostRepo = makeTempDir("vb-prg4-enotdir-");
    const regularFile = path.join(fileHostRepo, "plain-file.txt");
    writeFileSync(regularFile, "not a dir\n", "utf8");
    const badRepoRes = captureCli(["doctor", "--repo-root", path.join(regularFile, "sub")]);
    expect(badRepoRes.code).toBe(EXIT_PROVENANCE_VIOLATION);
    expect(badRepoRes.stderr).not.toContain("plain-file.txt");

    const badBrainRes = captureCli([
      "doctor",
      "--repo-root",
      fileHostRepo,
      "--brain-dir",
      path.join(regularFile, ".brain"),
    ]);
    expect(badBrainRes.code).toBe(EXIT_PROVENANCE_VIOLATION);
    expect(badBrainRes.stderr).not.toContain("plain-file.txt");

    // 4. P3-PRG4-2: Quarantine precedence — `--format yaml --role <secret>` returns Exit 2 (NOT Exit 1!)
    const precRes = captureCli([
      "doctor",
      "--format",
      "yaml",
      "--role",
      splitSecret,
      "--repo-root",
      craftedRepo,
    ]);
    expect(precRes.code).toBe(EXIT_QUARANTINE_VIOLATION);
    expect(precRes.stdout).toBe("");
    expect(precRes.stderr).not.toContain("AIza");
  });

  it("PRG-4 CQE/Bench/CUDE Regressions: scars 3276/3277/4096 B, malformed scars/config/decided, Exit 4 eval propagation, 1023/1024 A0 boundary, hook-only L3, oversized/corrupt metrics, copy-paste decide & wrapping", () => {
    const now = new Date("2026-11-28T10:00:00Z");

    // 1. Corrupt config.json -> brain.present FAIL, L0, no crash
    const badCfgRepo = makeTempDir("vb-prg4-badcfg-");
    const badCfgBrain = path.join(badCfgRepo, ".brain");
    mkdirSync(badCfgBrain, { recursive: true });
    writeFileSync(path.join(badCfgBrain, "config.json"), "{invalid json", "utf8");
    const badCfgDoc = runDoctor({ brainDir: badCfgBrain, repoRoot: badCfgRepo, now, envVars: {} });
    expect(badCfgDoc.maturity.level).toBe("L0");
    expect(badCfgDoc.exit_code).toBe(EXIT_ERROR);
    expect(badCfgDoc.checks.find((c) => c.id === "brain.present")?.status).toBe("FAIL");

    // 2. Secret inside .brain/config.json -> runDoctor rethrows Exit 2
    const secSecret = ["AIza", "SyDoctorInsideBrainSecret12345678"].join("");
    writeFileSync(
      path.join(badCfgBrain, "config.json"),
      JSON.stringify({ schema_version: "1.0", note: secSecret }),
      "utf8",
    );
    try {
      runDoctor({ brainDir: badCfgBrain, repoRoot: badCfgRepo, now, envVars: {} });
      expect.unreachable("secret in config.json must throw Exit 2");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_QUARANTINE_VIOLATION);
    }

    // 3. Tampered decided/*.md -> eval.strict FAIL + zone_a0.floor FAIL (non-budget) + preserves Exit 4 (CQE P3-1!)
    const badDecRepo = makeTempDir("vb-prg4-baddec-");
    const badDecBrain = path.join(badDecRepo, ".brain");
    initBrain({
      brainDir: badDecBrain,
      repoRoot: badDecRepo,
      signedBy: "Ian Mayor",
      now,
      envVars: {},
    });
    const dec001 = path.join(badDecBrain, "decided", "DEC-001-veribrain-baseline.md");
    writeFileSync(dec001, `${readFileSync(dec001, "utf8")}\nTampered body.\n`, "utf8");
    const badDecDoc = runDoctor({ brainDir: badDecBrain, repoRoot: badDecRepo, now, envVars: {} });
    expect(badDecDoc.ok).toBe(false);
    expect(badDecDoc.exit_code).toBe(EXIT_PROVENANCE_VIOLATION);
    expect(badDecDoc.checks.find((c) => c.id === "eval.strict")?.status).toBe("FAIL");
    expect(badDecDoc.checks.find((c) => c.id === "zone_a0.floor")?.status).toBe("FAIL");

    // Secret inside .brain/decided/*.md -> runDoctor rethrows Exit 2
    writeFileSync(dec001, `${readFileSync(dec001, "utf8")}\n${secSecret}\n`, "utf8");
    try {
      runDoctor({ brainDir: badDecBrain, repoRoot: badDecRepo, now, envVars: {} });
      expect.unreachable("secret in decided file must throw Exit 2");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_QUARANTINE_VIOLATION);
    }

    // 4. Scars exact byte boundaries: 3276 B (PASS), 3277 B (WARN), 4096 B (FAIL), malformed small scars.md (FAIL), healthy + pending HYP-SCAR (INFO)
    const scarRepo = makeTempDir("vb-prg4-scars-");
    const scarBrain = path.join(scarRepo, ".brain");
    initBrain({ brainDir: scarBrain, repoRoot: scarRepo, signedBy: "Ian Mayor", now, envVars: {} });
    mkdirSync(path.join(scarRepo, "tests", "unit"), { recursive: true });
    writeFileSync(path.join(scarRepo, "tests", "unit", "s.test.ts"), "// ok\n", "utf8");

    const buildScarOfExactBytes = (targetBytes: number): string => {
      const base = [
        "# Scars",
        "",
        "## SCAR-001",
        "- created_at_utc: 2026-11-27T00:00:00Z",
        "- expires_at_utc: 2026-12-20T00:00:00Z",
        "- regression_test: tests/unit/s.test.ts#L1",
        "- roles: [*]",
        "- hint: Keep regressions locked.",
        "",
        "<!-- ",
      ].join("\n");
      const suffix = " -->\n";
      const padLen =
        targetBytes - Buffer.byteLength(base, "utf8") - Buffer.byteLength(suffix, "utf8");
      expect(padLen).toBeGreaterThanOrEqual(0);
      const out = `${base}${"a".repeat(padLen)}${suffix}`;
      expect(Buffer.byteLength(out, "utf8")).toBe(targetBytes);
      return out;
    };

    writeFileSync(path.join(scarBrain, "scars.md"), buildScarOfExactBytes(3276), "utf8");
    expect(
      runDoctor({ brainDir: scarBrain, repoRoot: scarRepo, now, envVars: {} }).checks.find(
        (c) => c.id === "tier3.scars",
      )?.status,
    ).toBe("PASS");

    writeFileSync(path.join(scarBrain, "scars.md"), buildScarOfExactBytes(3277), "utf8");
    expect(
      runDoctor({ brainDir: scarBrain, repoRoot: scarRepo, now, envVars: {} }).checks.find(
        (c) => c.id === "tier3.scars",
      )?.status,
    ).toBe("WARN");

    writeFileSync(path.join(scarBrain, "scars.md"), buildScarOfExactBytes(4096), "utf8");
    expect(
      runDoctor({ brainDir: scarBrain, repoRoot: scarRepo, now, envVars: {} }).checks.find(
        (c) => c.id === "tier3.scars",
      )?.status,
    ).toBe("FAIL");

    // Malformed small scars.md -> tier3.scars FAIL (Bench P3-2, NOT INFO)
    writeFileSync(
      path.join(scarBrain, "scars.md"),
      "# Scars\n\n## SCAR-BAD\n- hint: Missing dates and test.\n",
      "utf8",
    );
    expect(
      runDoctor({ brainDir: scarBrain, repoRoot: scarRepo, now, envVars: {} }).checks.find(
        (c) => c.id === "tier3.scars",
      )?.status,
    ).toBe("FAIL");

    // Healthy scars + pending HYP-SCAR-* -> tier3.scars INFO + tier3.hypotheses INFO (0 expired)
    writeFileSync(path.join(scarBrain, "scars.md"), buildScarOfExactBytes(400), "utf8");
    proposeScar({
      id: "HYP-SCAR-PEND",
      hint: "Promote me.",
      regressionTest: "tests/unit/s.test.ts#L1",
      brainDir: scarBrain,
      repoRoot: scarRepo,
      now,
    });
    const pendDoc = runDoctor({ brainDir: scarBrain, repoRoot: scarRepo, now, envVars: {} });
    expect(pendDoc.checks.find((c) => c.id === "tier3.scars")?.status).toBe("INFO");
    expect(pendDoc.checks.find((c) => c.id === "tier3.hypotheses")?.status).toBe("INFO");

    // 5. Exact 1023 vs 1024 Zone A0 boundary + token equality with compileContext + schema 1.1 with zone_a_layout: "legacy" (Bench P3-1) + hook-only L3 + expired OBS excluded from L3 + synced mirror PASS
    const bndRepo = makeTempDir("vb-prg4-a0bnd-");
    const bndBrain = path.join(bndRepo, ".brain");
    const bndMirror = makeTempDir("vb-prg4-bndmirror-");
    initBrain({ brainDir: bndBrain, repoRoot: bndRepo, signedBy: "Ian Mayor", now, envVars: {} });

    // Tune DEC-002 body length to hit exact 1023 and 1024 estimated Zone A0 tokens
    const measureA0ForPad = (padChars: number): number => {
      decideRule({
        id: "DEC-002",
        priority: "P0",
        roles: ["*"],
        signedBy: "Ian Mayor",
        body: `Shared policy text: ${"w ".repeat(padChars)}end.`,
        brainDir: bndBrain,
        repoRoot: bndRepo,
        now,
        envVars: {},
      });
      return compileContext({
        role: "builder",
        env: "local",
        zoneALayout: "split",
        brainDir: bndBrain,
        repoRoot: bndRepo,
        now,
        bypassReadCache: true,
        recordMetrics: false,
      }).zone_a0_tokens_est;
    };
    let low = 800;
    let high = 2200;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (measureA0ForPad(mid) < 1024) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const tokAtHigh = measureA0ForPad(low);
    expect(tokAtHigh).toBeGreaterThanOrEqual(1024);
    const tokBelow = measureA0ForPad(low - 1);
    expect(tokBelow).toBeLessThan(1024);

    // Below 1024 -> WARN, exact token count matches compileContext
    const docBelow = runDoctor({ brainDir: bndBrain, repoRoot: bndRepo, now, envVars: {} });
    expect(docBelow.checks.find((c) => c.id === "zone_a0.floor")?.status).toBe("WARN");
    expect(docBelow.checks.find((c) => c.id === "zone_a0.floor")?.summary).toContain(
      `${tokBelow}/1024`,
    );

    // >= 1024 with schema 1.1 + explicit zone_a_layout: "legacy" -> INFO (Bench P3-1)
    measureA0ForPad(low);
    const bndCfgPath = path.join(bndBrain, "config.json");
    const bndCfg = JSON.parse(readFileSync(bndCfgPath, "utf8")) as Record<string, unknown>;
    bndCfg.schema_version = "1.1";
    bndCfg.zone_a_layout = "legacy";
    bndCfg.mirror_dirs = [bndMirror];
    writeFileSync(bndCfgPath, `${JSON.stringify(bndCfg, null, 2)}\n`, "utf8");
    syncMirrorFiles(
      bndBrain,
      [bndMirror],
      ["config.json", "scars.md", "decided/DEC-001-veribrain-baseline.md", "decided/DEC-002.md"],
    );

    // Expired OBSERVED alone must NOT reach L3 (stays L2!)
    writeObservation({
      claimId: "OBS-EXPIRED-ONLY",
      env: "local",
      gitSha: "abcdef1234",
      ttlSeconds: 60,
      summary: "Old run.",
      evidenceRef: "ci:1",
      issuer: "ci",
      brainDir: bndBrain,
      repoRoot: bndRepo,
      now: new Date(now.getTime() - 120_000),
      envVars: {},
    });
    const docExpiredObs = runDoctor({ brainDir: bndBrain, repoRoot: bndRepo, now, envVars: {} });
    expect(docExpiredObs.checks.find((c) => c.id === "zone_a0.floor")?.status).toBe("INFO");
    expect(docExpiredObs.checks.find((c) => c.id === "zone_a0.floor")?.summary).toContain(
      `${tokAtHigh} tok`,
    );
    expect(docExpiredObs.maturity.level).toBe("L0"); // eval.strict fails on expired OBS

    // Remove expired OBS -> eval.strict + mirror parity PASS, L2; add managed pre-commit hook -> L3 via hook alone AND NO `hooks install` in fix!
    rmSync(path.join(bndBrain, "observed", "OBS-EXPIRED-ONLY.json"), { force: true });
    createFakeGitWithPreCommitHook(bndRepo, true);
    const docHookL3 = runDoctor({ brainDir: bndBrain, repoRoot: bndRepo, now, envVars: {} });
    expect(docHookL3.checks.find((c) => c.id === "eval.strict")?.status).toBe("PASS");
    expect(docHookL3.checks.find((c) => c.id === "eval.strict")?.summary).toContain(
      "mirror parity",
    );
    expect(docHookL3.maturity.level).toBe("L3");
    const t2HookOnly = docHookL3.checks.find((c) => c.id === "tier2.observed");
    expect(t2HookOnly?.status).toBe("WARN");
    expect(t2HookOnly?.fix).not.toContain("veribrain hooks install");
    expect(t2HookOnly?.fix).toContain("veribrain observe --help");

    // 6. Telemetry WARN on corrupt lines & FAIL on oversized .metrics.jsonl (> 20 MiB)
    writeFileSync(path.join(bndBrain, METRICS_FILENAME), "{corrupt json\n", "utf8");
    const corruptMetDoc = runDoctor({ brainDir: bndBrain, repoRoot: bndRepo, now, envVars: {} });
    expect(corruptMetDoc.checks.find((c) => c.id === "telemetry.stats")?.status).toBe("WARN");
    expect(corruptMetDoc.checks.find((c) => c.id === "telemetry.stats")?.fix).toContain(
      "veribrain stats --reset",
    );

    writeFileSync(path.join(bndBrain, METRICS_FILENAME), Buffer.alloc(21 * 1024 * 1024, 65));
    const hugeMetDoc = runDoctor({ brainDir: bndBrain, repoRoot: bndRepo, now, envVars: {} });
    expect(hugeMetDoc.checks.find((c) => c.id === "telemetry.stats")?.status).toBe("FAIL");
    expect(hugeMetDoc.checks.find((c) => c.id === "telemetry.stats")?.fix).toContain(
      "veribrain stats --reset",
    );
    rmSync(path.join(bndBrain, METRICS_FILENAME), { force: true });

    // 7. CUDE P1/P2/P3: copy-paste valid decide fix executes cleanly, (human)/(human/CI) badges rendered, wrapped lines never clip mid-flag, every check summary <= 56 chars
    const freshRepo = makeTempDir("vb-prg4-cude-");
    const freshBrain = path.join(freshRepo, ".brain");
    initBrain({ brainDir: freshBrain, repoRoot: freshRepo, now, envVars: {} });
    const freshDoc = runDoctor({ brainDir: freshBrain, repoRoot: freshRepo, now, envVars: {} });
    const decideFix = freshDoc.checks.find((c) => c.id === "tier1.decided")?.fix[0] ?? "";
    expect(decideFix).toBe(
      'veribrain decide --id DEC-NNN --priority P0 --signed-by "<Your Name>" --body "<rule>"',
    );
    const execDecide = captureCli([
      "decide",
      "--id",
      "DEC-001",
      "--priority",
      "P0",
      "--signed-by",
      "Ian Mayor",
      "--body",
      "Copy-paste fix verified.",
      "--brain-dir",
      freshBrain,
      "--repo-root",
      freshRepo,
    ]);
    expect(execDecide.code, execDecide.stderr).toBe(EXIT_OK);

    const freshText = formatDoctorText(freshDoc);
    expect(freshText).toContain("(human) veribrain decide");
    expect(freshText).toContain("(human/CI) veribrain attest-test");
    expect(freshText).toContain("(human) veribrain stats --enable");
    const freshLines = freshText.trimEnd().split("\n");
    expect(freshLines.length).toBeLessThanOrEqual(30);
    for (const line of freshLines) {
      expect(line.length, `Line > 80 cols: ${line}`).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7E]*$/.test(line)).toBe(true);
    }
    for (const check of freshDoc.checks) {
      expect(check.summary.length, `Summary > 56 chars: ${check.summary}`).toBeLessThanOrEqual(56);
    }
  });
});
