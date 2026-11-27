import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_RETRO_ROLES,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_PROVENANCE_VIOLATION,
  ZONE_A0_BOUNDARY_MARKER,
} from "../../src/index.js";
import { sha256Hex } from "../../src/normalize.js";
import {
  writeDecidedFixture,
  writeHypothesisFixture,
  writeObservedFixture,
  writeScarsFixture,
} from "./helpers.js";

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

function initGitRepo(dir: string): string {
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "golden@example.test"], {
    cwd: dir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Golden Tester"], {
    cwd: dir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "commit.gpgsign", "false"], {
    cwd: dir,
    stdio: "pipe",
  });
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "--no-gpg-sign", "-q", "-m", "baseline"], {
    cwd: dir,
    stdio: "pipe",
  });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

function parseMcpJson(result: Record<string, unknown>): Record<string, unknown> {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  expect(content.length).toBeGreaterThan(0);
  const first = content[0];
  expect(first?.type).toBe("text");
  return JSON.parse(first?.text ?? "{}") as Record<string, unknown>;
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

describe("PRG-2 (v1.2.0) Golden Acceptance Suite (PM-601..PM-605)", () => {
  it("PM-601: produces byte-identical Zone A0 across all 8 Chief roles over CLI and stdio MCP, preserves 1.0 legacy hashes, and defaults 1.1 to split", async () => {
    const repo = makeTempDir("vb-prg2-pm601-");
    const brainDir = path.join(repo, ".brain");

    expect(runDistCli(["init", "--signed-by", "Ian Mayor"], repo).status).toBe(EXIT_OK);

    writeDecidedFixture(brainDir, {
      id: "DEC-002",
      fileName: "DEC-002-builder-only.md",
      status: "active",
      priority: "P1",
      roles: ["builder"],
      signedBy: "Ian Mayor",
      signedAtUtc: "2026-11-27T00:00:00Z",
      body: "# Builder Rule\nKeep compiler strictly deterministic and zero-LLM.",
    });
    writeDecidedFixture(brainDir, {
      id: "DEC-003",
      fileName: "DEC-003-security-cqe.md",
      status: "active",
      priority: "P1",
      roles: ["security", "cqe"],
      signedBy: "Ian Mayor",
      signedAtUtc: "2026-11-27T00:00:00Z",
      body: "# Verification Rule\nEnforce Author != Verifier across all gates.",
    });

    const sha = "a".repeat(40);
    const a0Hashes = new Set<string>();
    const a0Texts = new Set<string>();
    const byRole = new Map<string, Record<string, unknown>>();

    for (const role of DEFAULT_RETRO_ROLES) {
      const res = runDistCli(
        [
          "compile",
          "--role",
          role,
          "--env",
          "local",
          "--git-sha",
          sha,
          "--zone-a-layout",
          "split",
          "--format",
          "json",
        ],
        repo,
      );
      expect(res.status, res.stderr).toBe(EXIT_OK);
      const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(parsed.zone_a_layout).toBe("split");
      const zoneA0 = String(parsed.zone_a0);
      const zoneA1 = String(parsed.zone_a1);
      const zoneA = String(parsed.zone_a);

      expect(zoneA0).not.toContain(`Role: ${role}`);
      expect(zoneA0).toContain("DEC-001");
      expect(zoneA0).not.toContain("DEC-002");
      expect(zoneA0).not.toContain("DEC-003");
      expect(zoneA).toBe(`${zoneA0}${ZONE_A0_BOUNDARY_MARKER}\n\n${zoneA1}`);
      expect(parsed.zone_a_sha256).toBe(sha256Hex(Buffer.from(zoneA, "utf8")));
      expect(parsed.zone_a0_sha256).toBe(sha256Hex(Buffer.from(zoneA0, "utf8")));
      expect(String(parsed.kv_cache_floor_advisory)).toContain("Zone A0");

      a0Hashes.add(String(parsed.zone_a0_sha256));
      a0Texts.add(zoneA0);
      byRole.set(role, parsed);
    }

    expect(a0Hashes.size).toBe(1);
    expect(a0Texts.size).toBe(1);
    expect(String(byRole.get("builder")?.zone_a1)).toContain("DEC-002");
    expect(String(byRole.get("builder")?.zone_a1)).not.toContain("DEC-003");
    expect(String(byRole.get("security")?.zone_a1)).toContain("DEC-003");
    expect(String(byRole.get("security")?.zone_a1)).not.toContain("DEC-002");

    const sharedA0Hash = [...a0Hashes][0] as string;

    // Legacy 1.0 default preserves exact non-split layout
    const legacyRes = runDistCli(
      ["compile", "--role", "builder", "--env", "local", "--git-sha", sha, "--format", "json"],
      repo,
    );
    expect(legacyRes.status, legacyRes.stderr).toBe(EXIT_OK);
    const legacy = JSON.parse(legacyRes.stdout) as Record<string, unknown>;
    expect(legacy.zone_a_layout).toBe("legacy");
    expect(legacy.zone_a0).toBe(legacy.zone_a);
    expect(legacy.zone_a1).toBe("");
    expect(String(legacy.zone_a)).not.toContain(ZONE_A0_BOUNDARY_MARKER);
    expect(legacy.semantic_hash).not.toBe(byRole.get("builder")?.semantic_hash);

    // Real stdio MCP server exposes zone_a_layout="split" and current package version
    const pkgVersion = (
      JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string }
    ).version;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_CLI, "mcp", "--brain-dir", brainDir, "--repo-root", repo],
      cwd: repo,
      stderr: "pipe",
    });
    const client = new Client({ name: "prg2-golden-client", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.version).toBe(pkgVersion);

      const mcpBuilder = parseMcpJson(
        (await client.callTool({
          name: "veribrain_compile_context",
          arguments: {
            role: "builder",
            env: "local",
            git_sha: sha,
            zone_a_layout: "split",
          },
        })) as Record<string, unknown>,
      );
      const mcpCqe = parseMcpJson(
        (await client.callTool({
          name: "veribrain_compile_context",
          arguments: {
            role: "cqe",
            env: "local",
            git_sha: sha,
            zone_a_layout: "split",
          },
        })) as Record<string, unknown>,
      );

      expect(mcpBuilder.zone_a_layout).toBe("split");
      expect(mcpBuilder.zone_a0_sha256).toBe(sharedA0Hash);
      expect(mcpCqe.zone_a0_sha256).toBe(sharedA0Hash);
      expect(mcpBuilder.zone_a0).toBe(mcpCqe.zone_a0);
    } finally {
      await client.close();
    }

    // Schema 1.1 auto-defaults to split layout when flag is omitted
    const cfgPath = path.join(brainDir, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.schema_version = "1.1";
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

    const v11BuilderRes = runDistCli(
      ["compile", "--role", "builder", "--env", "local", "--git-sha", sha, "--format", "json"],
      repo,
    );
    expect(v11BuilderRes.status, v11BuilderRes.stderr).toBe(EXIT_OK);
    const v11Builder = JSON.parse(v11BuilderRes.stdout) as Record<string, unknown>;
    expect(v11Builder.zone_a_layout).toBe("split");
    expect(String(v11Builder.zone_a0)).toContain("schema_version: 1.1");

    const v11CqeRes = runDistCli(
      ["compile", "--role", "cqe", "--env", "local", "--git-sha", sha, "--format", "json"],
      repo,
    );
    expect(v11CqeRes.status, v11CqeRes.stderr).toBe(EXIT_OK);
    const v11Cqe = JSON.parse(v11CqeRes.stdout) as Record<string, unknown>;
    expect(v11Cqe.zone_a_layout).toBe("split");
    expect(v11Cqe.zone_a0_sha256).toBe(v11Builder.zone_a0_sha256);
  });

  it("PM-602: attest-test runs npm safely on Windows without shell:true, enforces Exit 4 agent guard, hashes output with zero canary echo, and supports --record-failure / --dry-run", () => {
    const repo = makeTempDir("vb-prg2-pm602-");
    const brainDir = path.join(repo, ".brain");

    expect(runDistCli(["init", "--signed-by", "Ian Mayor"], repo).status).toBe(EXIT_OK);
    const headSha = initGitRepo(repo);

    // 1. Agent mode refusal -> Exit 4 (even with unknown/invalid flag!)
    const agentRes = runDistCli(
      ["attest-test", "--env", "local", "--", process.execPath, "--version"],
      repo,
      { VERIBRAIN_AGENT: "1" },
    );
    expect(agentRes.status).toBe(EXIT_PROVENANCE_VIOLATION);
    const agentInvalidRes = runDistCli(["attest-test", "--invalid"], repo, {
      VERIBRAIN_AGENT: "1",
    });
    expect(agentInvalidRes.status).toBe(EXIT_PROVENANCE_VIOLATION);

    // 1b. Raw secret in argv fails closed with Exit 2 even with --dry-run
    const splitKey = ["AIza", "SyGoldenArgQuarantineCheck123456789"].join("");
    const argSecretRes = runDistCli(
      ["attest-test", "--env", "local", "--dry-run", "--", process.execPath, `--token=${splitKey}`],
      repo,
    );
    expect(argSecretRes.status).toBe(2);

    // 2. Shell metacharacter rejection in --cmd -> Exit 1
    const metaRes = runDistCli(
      ["attest-test", "--env", "local", "--cmd", "npm --version && echo pwned"],
      repo,
    );
    expect(metaRes.status).toBe(EXIT_ERROR);

    // 3. Real Windows-safe npm --version via passthrough
    const npmPassthrough = runDistCli(
      [
        "attest-test",
        "--env",
        "local",
        "--claim-id",
        "OBS-VERIFY-NPM-PASS",
        "--format",
        "json",
        "--",
        "npm",
        "--version",
      ],
      repo,
    );
    expect(npmPassthrough.status, npmPassthrough.stderr).toBe(EXIT_OK);
    const npmPassJson = JSON.parse(npmPassthrough.stdout) as Record<string, unknown>;
    expect(npmPassJson.passed).toBe(true);
    expect(npmPassJson.git_sha).toBe(headSha);
    expect(String(npmPassJson.output_sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(npmPassJson.git_diff_stat_sha256)).toMatch(/^[0-9a-f]{64}$/);

    const receiptPath = path.join(brainDir, "observed", "OBS-VERIFY-NPM-PASS.json");
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    expect(receipt.issuer).toBe("verifier-script");
    expect(String(receipt.summary)).toContain("PASSED");
    expect(String(receipt.evidence_ref)).toContain("verifier:exit=0;");

    // eval --strict MUST pass cleanly on the attest-test-generated receipt
    const evalAfterAttest = runDistCli(["eval", "--strict"], repo);
    expect(evalAfterAttest.status, evalAfterAttest.stderr).toBe(EXIT_OK);

    // 4. --cmd with npm --version + --dry-run writes nothing
    const dryRunRes = runDistCli(
      [
        "attest-test",
        "--env",
        "local",
        "--claim-id",
        "OBS-VERIFY-DRYRUN",
        "--cmd",
        "npm --version",
        "--dry-run",
        "--format",
        "json",
      ],
      repo,
    );
    expect(dryRunRes.status, dryRunRes.stderr).toBe(EXIT_OK);
    expect(existsSync(path.join(brainDir, "observed", "OBS-VERIFY-DRYRUN.json"))).toBe(false);

    // 5. Secret canary in child stdout/stderr must NEVER be echoed into receipt or stdout
    const canary = "CANARY_VERIBRAIN_RAW_STDOUT_DO_NOT_ECHO_999";
    const canaryRes = runDistCli(
      [
        "attest-test",
        "--env",
        "local",
        "--claim-id",
        "OBS-VERIFY-CANARY",
        "--format",
        "json",
        "--",
        process.execPath,
        "-e",
        `console.log(${JSON.stringify(canary)}); console.error(${JSON.stringify(canary)});`,
      ],
      repo,
    );
    expect(canaryRes.status, canaryRes.stderr).toBe(EXIT_OK);
    expect(canaryRes.stdout).not.toContain(canary);
    const canaryFile = readFileSync(
      path.join(brainDir, "observed", "OBS-VERIFY-CANARY.json"),
      "utf8",
    );
    expect(canaryFile).not.toContain(canary);

    // 6. Failing command without --record-failure writes nothing; with --record-failure writes failed receipt and still exits 1
    const failNoRecord = runDistCli(
      [
        "attest-test",
        "--env",
        "local",
        "--claim-id",
        "OBS-VERIFY-FAIL-SKIP",
        "--",
        process.execPath,
        "-e",
        "process.exit(1)",
      ],
      repo,
    );
    expect(failNoRecord.status).toBe(EXIT_ERROR);
    expect(existsSync(path.join(brainDir, "observed", "OBS-VERIFY-FAIL-SKIP.json"))).toBe(false);

    const failWithRecord = runDistCli(
      [
        "attest-test",
        "--env",
        "local",
        "--claim-id",
        "OBS-VERIFY-FAIL-REC",
        "--record-failure",
        "--format",
        "json",
        "--",
        process.execPath,
        "-e",
        "process.exit(2)",
      ],
      repo,
    );
    expect(failWithRecord.status).toBe(EXIT_ERROR);
    const failPath = path.join(brainDir, "observed", "OBS-VERIFY-FAIL-REC.json");
    expect(existsSync(failPath)).toBe(true);
    const failRec = JSON.parse(readFileSync(failPath, "utf8")) as Record<string, unknown>;
    expect(String(failRec.summary)).toContain("FAILED");
    expect(String(failRec.evidence_ref)).toContain("verifier:exit=2;");
  });

  it("PM-603: check-citations detects all 4 drift classes, skips fenced blocks & placeholders, blocks path escape (Exit 4), and passes cleanly on VeriBrain repo", () => {
    const repo = makeTempDir("vb-prg2-pm603-");
    const brainDir = path.join(repo, ".brain");

    expect(runDistCli(["init", "--signed-by", "Ian Mayor"], repo).status).toBe(EXIT_OK);
    writeDecidedFixture(brainDir, {
      id: "DEC-002",
      fileName: "DEC-002-old.md",
      status: "superseded",
      priority: "P1",
      roles: ["*"],
      signedBy: "Ian Mayor",
      signedAtUtc: "2026-11-26T00:00:00Z",
      body: "# Old Rule\nOriginal rule.",
    });
    const dec003Res = runDistCli(
      [
        "decide",
        "--id",
        "DEC-003",
        "--priority",
        "P1",
        "--roles",
        "*",
        "--signed-by",
        "Ian Mayor",
        "--supersedes",
        "DEC-002",
        "--title",
        "New Rule",
        "--body",
        "Active replacement.",
      ],
      repo,
    );
    expect(dec003Res.status, dec003Res.stderr).toBe(EXIT_OK);
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const pastIso = new Date(Date.now() - 7_200_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const sha = "b".repeat(40);
    writeObservedFixture(brainDir, {
      claim_id: "OBS-ALIVE",
      env: "local",
      git_sha: sha,
      observed_at_utc: nowIso,
      ttl_seconds: 3600,
      issuer: "verifier-script",
      roles: ["*"],
      summary: "Active test receipt.",
      evidence_ref: `local@${sha}`,
    });
    writeObservedFixture(brainDir, {
      claim_id: "OBS-EXPIRED",
      env: "local",
      git_sha: sha,
      observed_at_utc: pastIso,
      ttl_seconds: 60,
      issuer: "verifier-script",
      roles: ["*"],
      summary: "Expired test receipt.",
      evidence_ref: `local@${sha}`,
    });

    mkdirSync(path.join(repo, "docs"), { recursive: true });
    writeFileSync(
      path.join(repo, "docs", "clean.md"),
      [
        "# Clean Doc",
        "Valid refs: DEC-001, DEC-003, OBS-ALIVE.",
        "Placeholders: DEC-NNN, DEC-###, DEC-XXX, DEC-000, OBS-NNN, OBS-000, DEC-EXAMPLE, OBS-DEMO..., .brain/decided/DEC-404-sample.md.",
        "```md",
        "Inside fence: DEC-999 and OBS-999",
        "```",
        "",
      ].join("\n"),
      "utf8",
    );

    const cleanRes = runDistCli(["check-citations", "--format", "json"], repo);
    expect(cleanRes.status, cleanRes.stderr).toBe(EXIT_OK);
    const cleanJson = JSON.parse(cleanRes.stdout) as { issues: unknown[] };
    expect(cleanJson.issues).toHaveLength(0);

    // --include-code-blocks catches DEC-999 / OBS-999 inside fences
    const includeFences = runDistCli(
      ["check-citations", "--include-code-blocks", "--format", "json"],
      repo,
    );
    expect(includeFences.status).toBe(EXIT_ERROR);
    const fenceJson = JSON.parse(includeFences.stdout) as {
      issues: Array<{ claim_id: string }>;
    };
    expect(fenceJson.issues.map((i) => i.claim_id)).toContain("DEC-999");

    // All 4 drift kinds
    writeFileSync(
      path.join(repo, "docs", "drift.md"),
      "Broken: DEC-404, DEC-002, OBS-MISSING, OBS-EXPIRED.\n",
      "utf8",
    );
    const driftRes = runDistCli(["check-citations", "--format", "json"], repo);
    expect(driftRes.status).toBe(EXIT_ERROR);
    const driftJson = JSON.parse(driftRes.stdout) as {
      issues: Array<{ claim_id: string; kind: string; replacement_id?: string }>;
    };
    const byId = new Map(driftJson.issues.map((i) => [i.claim_id, i]));
    expect(byId.get("DEC-404")?.kind).toBe("missing_decided");
    expect(byId.get("DEC-002")?.kind).toBe("superseded_decided");
    expect(byId.get("DEC-002")?.replacement_id).toBe("DEC-003");
    expect(byId.get("OBS-MISSING")?.kind).toBe("missing_observed");
    expect(byId.get("OBS-EXPIRED")?.kind).toBe("expired_observed");

    // --decided-only + --ignore-ids clears drift
    const filtered = runDistCli(
      ["check-citations", "--decided-only", "--ignore-ids", "DEC-404,DEC-002", "--format", "json"],
      repo,
    );
    expect(filtered.status, filtered.stderr).toBe(EXIT_OK);

    // Path escape -> Exit 4
    const escapeRes = runDistCli(["check-citations", "--paths", "../outside.md"], repo);
    expect(escapeRes.status).toBe(EXIT_PROVENANCE_VIOLATION);

    // Dogfood on the actual VeriBrain repo -> 0 drift issues
    const ownRepoRes = runDistCli(["check-citations", "--format", "json"], REPO_ROOT);
    expect(ownRepoRes.status, ownRepoRes.stdout || ownRepoRes.stderr).toBe(EXIT_OK);
    const ownRepoJson = JSON.parse(ownRepoRes.stdout) as {
      files_scanned: number;
      issues: unknown[];
    };
    expect(ownRepoJson.files_scanned).toBeGreaterThan(0);
    expect(ownRepoJson.issues).toHaveLength(0);
  });

  it("PM-604: env-ttl survives cross-commit compile within env+TTL, rejects > 7d TTL, and retro generates uncapped weekly digest", () => {
    const repo = makeTempDir("vb-prg2-pm604-");
    const brainDir = path.join(repo, ".brain");

    expect(runDistCli(["init", "--signed-by", "Ian Mayor"], repo).status).toBe(EXIT_OK);

    const shaA = "1".repeat(40);
    const shaB = "2".repeat(40);

    // > 7d env-ttl rejected
    const tooLong = runDistCli(
      [
        "observe",
        "--claim-id",
        "OBS-ENV-TOOLONG",
        "--env",
        "staging",
        "--git-sha",
        shaA,
        "--ttl-mode",
        "env-ttl",
        "--ttl",
        "604801",
        "--issuer",
        "verifier-script",
        "--summary",
        "Staging soak healthy.",
        "--evidence",
        `staging@${shaA}`,
      ],
      repo,
    );
    expect(tooLong.status).toBe(EXIT_ERROR);

    // Valid env-ttl persists and survives across commit shaB in staging, but NOT in prod
    const okObs = runDistCli(
      [
        "observe",
        "--claim-id",
        "OBS-ENV-STAGE",
        "--env",
        "staging",
        "--git-sha",
        shaA,
        "--ttl-mode",
        "env-ttl",
        "--ttl",
        "3600",
        "--issuer",
        "verifier-script",
        "--summary",
        "Staging soak healthy.",
        "--evidence",
        `staging@${shaA}`,
      ],
      repo,
    );
    expect(okObs.status, okObs.stderr).toBe(EXIT_OK);

    const stagingCompile = runDistCli(
      ["compile", "--role", "builder", "--env", "staging", "--git-sha", shaB, "--format", "json"],
      repo,
    );
    expect(stagingCompile.status, stagingCompile.stderr).toBe(EXIT_OK);
    const stagingJson = JSON.parse(stagingCompile.stdout) as {
      zone_b: string;
      included_observed_ids: string[];
    };
    expect(stagingJson.included_observed_ids).toContain("OBS-ENV-STAGE");
    expect(stagingJson.zone_b).toContain(`(staging@${shaA}, env-ttl)`);

    const prodCompile = runDistCli(
      ["compile", "--role", "builder", "--env", "prod", "--git-sha", shaB, "--format", "json"],
      repo,
    );
    expect(prodCompile.status, prodCompile.stderr).toBe(EXIT_OK);
    const prodJson = JSON.parse(prodCompile.stdout) as { included_observed_ids: string[] };
    expect(prodJson.included_observed_ids).not.toContain("OBS-ENV-STAGE");

    // Add a pending hypothesis so retro surfaces promote command
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const expiresIso = new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    writeHypothesisFixture(brainDir, {
      id: "HYP-RETRO-01",
      created_at_utc: nowIso,
      expires_at_utc: expiresIso,
      roles: ["builder"],
      proposed_by: "agent:builder",
      hint: "Consider caching tokenizer calibration tables.",
    });

    const retroJsonRes = runDistCli(
      [
        "retro",
        "--since",
        "7d",
        "--env",
        "staging",
        "--zone-a-layout",
        "split",
        "--format",
        "json",
      ],
      repo,
    );
    expect(retroJsonRes.status, retroJsonRes.stderr).toBe(EXIT_OK);
    const retroJson = JSON.parse(retroJsonRes.stdout) as {
      zone_a_layout: string;
      role_floor_audit: Array<{ role: string }>;
      pending_hypotheses: Array<{ id: string; promote_command: string }>;
    };
    expect(retroJson.zone_a_layout).toBe("split");
    expect(retroJson.role_floor_audit).toHaveLength(DEFAULT_RETRO_ROLES.length);
    expect(retroJson.pending_hypotheses.some((h) => h.id === "HYP-RETRO-01")).toBe(true);
    expect(retroJson.pending_hypotheses[0]?.promote_command).toContain("veribrain promote");

    const retroMdRes = runDistCli(
      ["retro", "--since", "7d", "--env", "staging", "--zone-a-layout", "split", "--format", "md"],
      repo,
    );
    expect(retroMdRes.status, retroMdRes.stderr).toBe(EXIT_OK);
    expect(retroMdRes.stdout).toContain("# VeriBrain Retrospective");
    expect(retroMdRes.stdout).toContain("HYP-RETRO-01");
    expect(retroMdRes.stdout).not.toContain("—");
  });

  it("PM-605: diff emits tier-aware actions and [DEC] slugs within 80 cols / 25 lines ASCII, and package/CLI versions align", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      version: string;
      bin: Record<string, string>;
      repository: { url: string };
      dependencies: Record<string, string>;
    };
    const verRes = runDistCli(["--version"], REPO_ROOT);
    expect(verRes.status).toBe(EXIT_OK);
    expect(verRes.stdout).toBe(`veribrain ${pkg.version}\n`);
    expect(pkg.version).toBe("1.3.0");
    expect(pkg.bin.veribrain).toBe("dist/cli.js");
    expect(pkg.repository.url).toBe("git+https://github.com/neverbeenthemayor/veribrain.git");
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@modelcontextprotocol/sdk", "zod"]);

    const repo = makeTempDir("vb-prg2-pm605-");
    const brainDir = path.join(repo, ".brain");
    expect(runDistCli(["init", "--signed-by", "Ian Mayor"], repo).status).toBe(EXIT_OK);
    const headSha = initGitRepo(repo);

    // Stage 1 change per tier: DEC, HYP, expired OBS, aging SCAR
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const pastIso = new Date(Date.now() - 7_200_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const expiresIso = new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    writeDecidedFixture(brainDir, {
      id: "DEC-009",
      fileName: "DEC-009-cache-prefix-split.md",
      status: "active",
      priority: "P1",
      roles: ["*"],
      signedBy: "Ian Mayor",
      signedAtUtc: "2026-11-27T00:00:00Z",
      body: "# Cache Prefix Split\nSeparate shared constitutional prefix.",
    });
    writeHypothesisFixture(brainDir, {
      id: "HYP-009",
      created_at_utc: nowIso,
      expires_at_utc: expiresIso,
      roles: ["builder"],
      proposed_by: "agent:builder",
      hint: "Evaluate prefix split hit rates.",
    });
    writeObservedFixture(brainDir, {
      claim_id: "OBS-009",
      env: "local",
      git_sha: headSha,
      observed_at_utc: pastIso,
      ttl_seconds: 60,
      issuer: "verifier-script",
      roles: ["*"],
      summary: "Expired local check.",
      evidence_ref: `local@${headSha}`,
    });
    writeScarsFixture(brainDir, [
      {
        scar_id: "SCAR-001",
        created_at_utc: pastIso,
        expires_at_utc: expiresIso,
        regression_test: "tests/unit/missing-scar-test.ts#L1",
        roles: ["builder"],
        hint: "Keep regressions locked.",
      },
    ]);

    const diffRes = runDistCli(["diff"], repo);
    expect(diffRes.status, diffRes.stderr).toBe(EXIT_OK);
    const out = diffRes.stdout;

    expect(out).toContain("[DEC] DEC-009 cache-prefix-split");
    expect(out).toContain("[Keep] [Revise] [Deprecate/Revert]");
    expect(out).toContain("[HYP] HYP-009");
    expect(out).toContain("[Promote to DECIDED] [Promote to SCAR] [Discard]");
    expect(out).toContain("[OBS] OBS-009");
    expect(out).toContain("[Re-verify] [Prune]");
    expect(out).toContain("[SCAR] SCAR-001");
    expect(out).toContain("[Keep] [Renew] [Prune]");

    const lines = out.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(25);
    for (const line of lines) {
      expect(line.length, `Line exceeds 80 cols: ${line}`).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7e]*$/.test(line), `Non-ASCII line: ${line}`).toBe(true);
    }
  });
});
