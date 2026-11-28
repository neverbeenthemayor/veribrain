import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_PROVENANCE_VIOLATION,
  METRICS_FILENAME,
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

describe("PRG-3 (v1.3.0) Golden Acceptance Suite (PM-701)", () => {
  it("tracks opt-in CLI + stdio MCP compile telemetry end-to-end, enforces agent Exit 4 mutator refusal, resets cleanly, and verifies v1.3.0 package/gitignore parity", async () => {
    // 1. Package, CLI version, help budgets, and .gitignore parity
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

    const gitignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
    expect(gitignore).toContain(".brain/.metrics.jsonl");
    expect(gitignore).toContain(".brain/.metrics.json");

    const verRes = runDistCli(["--version"], REPO_ROOT);
    expect(verRes.status).toBe(EXIT_OK);
    expect(verRes.stdout).toBe(`veribrain ${pkg.version}\n`);

    const helpRes = runDistCli(["--help"], REPO_ROOT);
    expect(helpRes.status).toBe(EXIT_OK);
    const helpLines = helpRes.stdout.trimEnd().split("\n");
    expect(helpLines.length).toBeLessThanOrEqual(20);
    for (const line of helpLines) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7E]*$/.test(line)).toBe(true);
    }

    const statsHelp = runDistCli(["stats", "--help"], REPO_ROOT);
    expect(statsHelp.status).toBe(EXIT_OK);
    const statsHelpLines = statsHelp.stdout.trimEnd().split("\n");
    expect(statsHelpLines.length).toBeLessThanOrEqual(12);
    for (const line of statsHelpLines) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7E]*$/.test(line)).toBe(true);
    }

    // 2. Initialize isolated temp workspace with >= 1024-token shared constitutional policy + baseline docs
    const repo = makeTempDir("vb-prg3-golden-");
    const brainDir = path.join(repo, ".brain");
    const metricsFile = path.join(brainDir, METRICS_FILENAME);
    expect(runDistCli(["init", "--signed-by", "Ian Mayor"], repo).status).toBe(EXIT_OK);

    const longBody = Array.from(
      { length: 24 },
      (_, i) =>
        `${i + 1}. Deterministic compilation requires byte-frozen Zone A0 constitutional headers, verified Tier 1 decisions, and strict zero-PII provenance gates across every role.`,
    ).join("\n");
    const decRes = runDistCli(
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
    );
    expect(decRes.status, decRes.stderr).toBe(EXIT_OK);

    mkdirSync(path.join(repo, "docs"), { recursive: true });
    writeFileSync(path.join(repo, "README.md"), `${"M".repeat(16_000)}\n`, "utf8");
    writeFileSync(path.join(repo, "docs", "spec.md"), `${"S".repeat(12_000)}\n`, "utf8");

    // 3. Disabled by default: compile does NOT write .brain/.metrics.jsonl
    const sha = "a".repeat(40);
    const preOptIn = runDistCli(
      [
        "compile",
        "--role",
        "builder",
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
    expect(preOptIn.status, preOptIn.stderr).toBe(EXIT_OK);
    expect(existsSync(metricsFile)).toBe(false);

    // 4. Agent mode refuses --enable / --disable / --reset (even with unknown flag!) with Exit 4
    for (const argv of [
      ["stats", "--enable"],
      ["stats", "--disable"],
      ["stats", "--reset"],
      ["stats", "--enable", "--bogus-flag"],
    ]) {
      const denied = runDistCli(argv, repo, { VERIBRAIN_AGENT: "1" });
      expect(denied.status, `Expected Exit 4 for ${argv.join(" ")}`).toBe(
        EXIT_PROVENANCE_VIOLATION,
      );
      expect(denied.stdout).toBe("");
    }

    // Read-only stats works in agent mode
    const agentRead = runDistCli(["stats", "--format", "json"], repo, { VERIBRAIN_AGENT: "1" });
    expect(agentRead.status, agentRead.stderr).toBe(EXIT_OK);
    expect((JSON.parse(agentRead.stdout) as { enabled: boolean }).enabled).toBe(false);

    // 5. Human enables telemetry via CLI, compiles via CLI, then compiles & queries stats via real stdio MCP
    const enableRes = runDistCli(["stats", "--enable", "--format", "json"], repo);
    expect(enableRes.status, enableRes.stderr).toBe(EXIT_OK);
    const enableJson = JSON.parse(enableRes.stdout) as { enabled: boolean; action: string };
    expect(enableJson.enabled).toBe(true);
    expect(enableJson.action).toBe("enabled");

    const cliCompile1 = runDistCli(
      [
        "compile",
        "--role",
        "builder",
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
    expect(cliCompile1.status, cliCompile1.stderr).toBe(EXIT_OK);
    expect(existsSync(metricsFile)).toBe(true);

    // Real stdio MCP server: 7 tools, v1.3.0, tags MCP compiles as source="mcp", serves veribrain_stats
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_CLI, "mcp", "--brain-dir", brainDir, "--repo-root", repo],
      cwd: repo,
      stderr: "pipe",
    });
    const client = new Client({ name: "prg3-golden-client", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.version).toBe(pkg.version);

      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual([
        "veribrain_compile_context",
        "veribrain_get_claim",
        "veribrain_list_claims",
        "veribrain_propose_scar",
        "veribrain_record_hypothesis",
        "veribrain_stats",
        "veribrain_status",
      ]);

      for (const role of ["cqe", "security"]) {
        const res = await client.callTool({
          name: "veribrain_compile_context",
          arguments: { role, env: "local", git_sha: sha, zone_a_layout: "split" },
        });
        expect(res.isError).toBeFalsy();
      }

      const mcpStatsMd = parseMcpJson(
        (await client.callTool({
          name: "veribrain_stats",
          arguments: { since: "30d", format: "md" },
        })) as Record<string, unknown>,
      );
      expect(mcpStatsMd.enabled).toBe(true);
      expect(mcpStatsMd.compiles_total).toBe(3);
      expect(mcpStatsMd.cli_compiles).toBe(1);
      expect(mcpStatsMd.mcp_compiles).toBe(2);
      expect(mcpStatsMd.zone_a0_eligible_compiles).toBe(3);
      expect(mcpStatsMd.zone_a0_repeat_hits).toBe(2);
      expect(mcpStatsMd.zone_a0_cross_role_hits).toBe(2);
      expect(Number(mcpStatsMd.estimated_cache_discount_tokens_at_90pct)).toBeGreaterThan(0);
      expect(String(mcpStatsMd.markdown)).toContain("# VeriBrain Local ROI & Telemetry Stats");

      // Secret passed via MCP veribrain_stats.since returns quarantined error with zero prefix leak
      const splitSecret = ["AIza", "SyMcpStatsSecretNoLeak123456"].join("");
      const badMcpStats = (await client.callTool({
        name: "veribrain_stats",
        arguments: { since: splitSecret },
      })) as Record<string, unknown>;
      expect(badMcpStats.isError).toBe(true);
      const badMcpJson = parseMcpJson(badMcpStats);
      expect(badMcpJson.exit_code).toBe(2);
      expect(JSON.stringify(badMcpJson)).not.toContain("AIza");
      expect(JSON.stringify(badMcpJson)).not.toContain("McpStatsSecret");
    } finally {
      await client.close();
    }

    // 6. CLI text / md / baseline-paths / eval --strict / check-citations parity
    const textStats = runDistCli(
      ["stats", "--since", "7d", "--baseline-paths", "README.md,docs", "--format", "text"],
      repo,
    );
    expect(textStats.status, textStats.stderr).toBe(EXIT_OK);
    for (const line of textStats.stdout.trimEnd().split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7E]*$/.test(line)).toBe(true);
    }

    // Baseline path escape -> Exit 4 with zero out-of-repo path echo
    const escapeStats = runDistCli(["stats", "--baseline-paths", "../outside-forbidden.md"], repo);
    expect(escapeStats.status).toBe(EXIT_PROVENANCE_VIOLATION);
    expect(escapeStats.stderr).not.toContain("outside-forbidden.md");

    // Mutually-exclusive flags -> Exit 1
    expect(runDistCli(["stats", "--enable", "--disable"], repo).status).toBe(EXIT_ERROR);

    // eval --strict and check-citations stay green while .brain/.metrics.jsonl exists
    expect(runDistCli(["eval", "--strict"], repo).status).toBe(EXIT_OK);
    expect(runDistCli(["check-citations"], repo).status).toBe(EXIT_OK);

    // 7. --reset deletes .brain/.metrics.jsonl and --disable turns off recording
    const resetRes = runDistCli(["stats", "--reset", "--format", "json"], repo);
    expect(resetRes.status, resetRes.stderr).toBe(EXIT_OK);
    expect(existsSync(metricsFile)).toBe(false);
    expect((JSON.parse(resetRes.stdout) as { compiles_total: number }).compiles_total).toBe(0);

    const disableRes = runDistCli(["stats", "--disable", "--format", "json"], repo);
    expect(disableRes.status, disableRes.stderr).toBe(EXIT_OK);
    expect((JSON.parse(disableRes.stdout) as { enabled: boolean }).enabled).toBe(false);

    // Subsequent compile does NOT recreate .metrics.jsonl
    expect(
      runDistCli(["compile", "--role", "builder", "--env", "local", "--git-sha", sha], repo).status,
    ).toBe(EXIT_OK);
    expect(existsSync(metricsFile)).toBe(false);
  }, 15_000);
});
