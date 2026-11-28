import { execFileSync, spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  compareAscii,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_PROVENANCE_VIOLATION,
  EXIT_QUARANTINE_VIOLATION,
  METRICS_FILENAME,
  sha256Hex,
  VERIBRAIN_HOOK_MARKER,
} from "../../src/index.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");
const DIST_CLI = path.join(REPO_ROOT, "dist", "cli.js");

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
  delete env.VERIBRAIN_METRICS;
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
  while (extraCleanupDirs.length > 0) {
    const dir = extraCleanupDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("PRG-4 (v1.4.0) Golden Acceptance Suite (PM-702 veribrain doctor)", () => {
  it("runs veribrain doctor end-to-end over real dist/cli.js across L0->L4, enforces read-only/agent/strict/quarantine/confinement gates, and verifies v1.4.0 parity", () => {
    // 1. Version & package.json parity (zero new runtime deps)
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      version: string;
      bin: Record<string, string>;
      repository: { url: string };
      dependencies: Record<string, string>;
    };
    expect(pkg.version).toBe("1.4.0");
    expect(pkg.bin.veribrain).toBe("dist/cli.js");
    expect(pkg.repository.url).toBe("git+https://github.com/neverbeenthemayor/veribrain.git");
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@modelcontextprotocol/sdk", "zod"]);

    const verRes = runDistCli(["--version"], REPO_ROOT);
    expect(verRes.status).toBe(EXIT_OK);
    expect(verRes.stdout).toBe("veribrain 1.4.0\n");

    // 2. Empty temp repo -> L0, Exit 1, init fix
    const repo = makeTempDir("vb-prg4-golden-");
    const brainDir = path.join(repo, ".brain");

    const l0Res = runDistCli(["doctor", "--format", "json"], repo);
    expect(l0Res.status).toBe(EXIT_ERROR);
    const l0Json = JSON.parse(l0Res.stdout) as {
      maturity: { level: string };
      checks: Array<{ id: string; status: string; fix: string[] }>;
    };
    expect(l0Json.maturity.level).toBe("L0");
    expect(l0Json.checks.find((c) => c.id === "brain.present")?.status).toBe("FAIL");

    // 3. Init + shared constitutional rule (>= 1024 A0 tokens) + enable metrics -> verify strictly read-only
    expect(runDistCli(["init", "--signed-by", "Ian Mayor"], repo).status).toBe(EXIT_OK);
    const longBody = Array.from(
      { length: 24 },
      (_, idx) =>
        `${idx + 1}. Deterministic context compilation requires byte-frozen Zone A0 headers, verified Tier 1 decisions, and strict zero-secret provenance gates across all roles.`,
    ).join("\n");
    expect(
      runDistCli(
        [
          "decide",
          "--id",
          "DEC-002",
          "--priority",
          "P0",
          "--roles",
          "*",
          "--signed-by",
          "Ian Mayor",
          "--title",
          "Shared Constitutional Floor",
          "--body",
          longBody,
        ],
        repo,
      ).status,
    ).toBe(EXIT_OK);
    expect(runDistCli(["stats", "--enable"], repo).status).toBe(EXIT_OK);

    // Full repo-tree read-only proof with metrics.enabled=true
    const hashBefore = hashDirectoryTree(repo);
    const l2Text1 = runDistCli(["doctor"], repo);
    const l2Text2 = runDistCli(["doctor"], repo);
    const l2Agent = runDistCli(["doctor", "--format", "md"], repo, { VERIBRAIN_AGENT: "1" });
    const hashAfter = hashDirectoryTree(repo);

    expect(hashAfter).toBe(hashBefore);
    expect(existsSync(path.join(brainDir, METRICS_FILENAME))).toBe(false);
    expect(l2Text1.status, l2Text1.stderr).toBe(EXIT_OK);
    expect(l2Text1.stdout).toBe(l2Text2.stdout); // 100% deterministic
    expect(l2Text1.stdout).toContain("Maturity: L2/4 (Tier 1 + shared prefix)");
    expect(l2Text1.stdout).toMatch(/\(human(?:\/CI)?\)/);
    expect(l2Agent.status, l2Agent.stderr).toBe(EXIT_OK);
    expect(l2Agent.stdout).toContain("# VeriBrain Doctor Report");

    const textLines = l2Text1.stdout.trimEnd().split("\n");
    expect(textLines.length).toBeLessThanOrEqual(30);
    for (const line of textLines) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7E]*$/.test(line)).toBe(true);
    }

    // --strict fails on WARN (Tier 2 missing)
    expect(runDistCli(["doctor", "--strict"], repo).status).toBe(EXIT_ERROR);

    // 4. Advance to L4 (schema 1.1 + active Tier 2 OBS + managed pre-commit hook + verified scar + 1 recorded compile)
    const cfgPath = path.join(brainDir, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.schema_version = "1.1";
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

    expect(
      runDistCli(
        [
          "observe",
          "--claim-id",
          "OBS-VERIFY-golden",
          "--env",
          "local",
          "--git-sha",
          "abcdef1234",
          "--ttl",
          "86400",
          "--ttl-mode",
          "env-ttl",
          "--summary",
          "Golden suite passed.",
          "--evidence",
          "verifier:exit=0",
          "--issuer",
          "verifier-script",
        ],
        repo,
      ).status,
    ).toBe(EXIT_OK);

    const gitDir = path.join(repo, ".git");
    mkdirSync(path.join(gitDir, "objects"), { recursive: true });
    mkdirSync(path.join(gitDir, "hooks"), { recursive: true });
    writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
    writeFileSync(path.join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n", "utf8");
    writeFileSync(
      path.join(gitDir, "hooks", "pre-commit"),
      `#!/bin/sh\n${VERIBRAIN_HOOK_MARKER}\nveribrain eval --strict\n`,
      "utf8",
    );

    mkdirSync(path.join(repo, "tests", "unit"), { recursive: true });
    writeFileSync(path.join(repo, "tests", "unit", "lock.test.ts"), "// test\n", "utf8");
    const futureExp = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    const createdIso = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(
      path.join(brainDir, "scars.md"),
      [
        "# Scars",
        "",
        "## SCAR-001",
        `- created_at_utc: ${createdIso}`,
        `- expires_at_utc: ${futureExp}`,
        "- regression_test: tests/unit/lock.test.ts#L1",
        "- roles: [*]",
        "- hint: Lock regression tests.",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(runDistCli(["compile", "--role", "builder", "--env", "local"], repo).status).toBe(
      EXIT_OK,
    );

    const l4Strict = runDistCli(["doctor", "--strict", "--format", "json"], repo);
    expect(l4Strict.status, l4Strict.stderr).toBe(EXIT_OK);
    const l4Json = JSON.parse(l4Strict.stdout) as {
      ok: boolean;
      maturity: { level: string; score: number };
      counts: { pass: number; warn: number; fail: number };
    };
    expect(l4Json.ok).toBe(true);
    expect(l4Json.maturity.level).toBe("L4");
    expect(l4Json.maturity.score).toBe(4);
    expect(l4Json.counts.pass).toBe(8);
    expect(l4Json.counts.warn).toBe(0);
    expect(l4Json.counts.fail).toBe(0);

    // 5. Quarantine Exit 2 & Confinement Exit 4/1 over real dist/cli.js + help contract
    const docHelp = runDistCli(["doctor", "--help"], repo);
    expect(docHelp.status).toBe(EXIT_OK);
    const docHelpLines = docHelp.stdout.trimEnd().split("\n");
    expect(docHelpLines.length).toBeLessThanOrEqual(12);
    for (const line of docHelpLines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    expect(docHelp.stdout).toContain("Exits:");

    const splitSecret = ["AIza", "SyGoldenDoctorSecretNeverLeak123"].join("");
    for (const flag of ["--role", "--env", "--format"] as const) {
      const qRes = runDistCli(["doctor", flag, splitSecret], repo);
      expect(qRes.status).toBe(EXIT_QUARANTINE_VIOLATION);
      expect(qRes.stdout).toBe("");
      expect(qRes.stderr).not.toContain("AIza");
      expect(qRes.stderr).not.toContain("GoldenDoctorSecret");
    }
    // Invalid --format combined with secret in --role MUST still exit 2 (quarantine precedence)
    const qPrecedence = runDistCli(["doctor", "--format", "yaml", "--role", splitSecret], repo);
    expect(qPrecedence.status).toBe(EXIT_QUARANTINE_VIOLATION);
    expect(qPrecedence.stdout).toBe("");
    expect(qPrecedence.stderr).not.toContain("AIza");

    const symTarget = makeTempDir("vb-prg4-symtarget-");
    const symLink = path.join(repo, "bad-link");
    symlinkSync(symTarget, symLink, process.platform === "win32" ? "junction" : "dir");
    expect(runDistCli(["doctor", "--repo-root", symLink], repo).status).toBe(
      EXIT_PROVENANCE_VIOLATION,
    );
    expect(
      runDistCli(["doctor", "--repo-root", path.join(repo, "missing-root")], repo).status,
    ).toBe(EXIT_ERROR);

    // 6. Dogfood check on VeriBrain repo itself exits 0 cleanly
    const ownDoctor = runDistCli(["doctor"], REPO_ROOT);
    expect(ownDoctor.status, ownDoctor.stderr).toBe(EXIT_OK);
    expect(ownDoctor.stdout).toContain("VeriBrain Doctor");
  }, 15_000);
});
