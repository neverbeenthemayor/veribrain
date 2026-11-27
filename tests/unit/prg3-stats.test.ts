import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { checkCitations } from "../../src/commands/check-citations.js";
import { decideRule } from "../../src/commands/decide.js";
import { generateBrainDiff } from "../../src/commands/diff.js";
import { evaluateBrain } from "../../src/commands/eval.js";
import { initBrain } from "../../src/commands/init.js";
import { generateRetroReport } from "../../src/commands/retro.js";
import { formatStatsMarkdown, formatStatsText, runStats } from "../../src/commands/stats.js";
import { compileContext } from "../../src/compiler.js";
import {
  appendMetricEvent,
  LEGACY_METRICS_JSON_FILENAME,
  METRICS_FILENAME,
  readMetricEvents,
} from "../../src/metrics.js";
import { checkMirrorDrift, syncMirrorFiles } from "../../src/mirror.js";
import { clearFileReadCache, loadBrainConfig } from "../../src/schema.js";
import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_PROVENANCE_VIOLATION,
  EXIT_QUARANTINE_VIOLATION,
  KV_CACHE_MIN_FLOOR_TOKENS,
  type VeriBrainError,
} from "../../src/types.js";

const tempDirs: string[] = [];

function makeTempDir(prefix = "veribrain-prg3-unit-"): string {
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

function buildLongConstitutionalBody(): string {
  const paragraph =
    "All engineers and agents must enforce deterministic context compilation, strict two-zone cache boundaries, fail-closed human provenance, and zero secret persistence across all repositories and environments.";
  return Array.from({ length: 24 }, (_, idx) => `${idx + 1}. ${paragraph}`).join("\n");
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

describe("PRG-3 (v1.3.0) PM-701 Unit Suite: Opt-in Metrics & veribrain stats", () => {
  it("stays disabled by default, keeps compile outputs byte-identical when enabled, and logs strict zero-PII 12-hex JSONL", () => {
    const root = makeTempDir();
    const brainDir = path.join(root, ".brain");
    const now = new Date("2026-11-28T02:00:00Z");
    initBrain({ brainDir, repoRoot: root, signedBy: "Ian Mayor", now, envVars: {} });

    const metricsPath = path.join(brainDir, METRICS_FILENAME);

    // 1. Default compile does NOT create .brain/.metrics.jsonl
    const baselineCompile = compileContext({
      role: "builder",
      env: "local",
      gitSha: "abcdef1234",
      zoneALayout: "split",
      brainDir,
      repoRoot: root,
      now,
      envVars: {},
    });
    expect(existsSync(metricsPath)).toBe(false);

    // 2. Opt-in via recordMetrics: true produces 100% identical outputs & hashes
    const optInCompile = compileContext({
      role: "builder",
      env: "local",
      gitSha: "abcdef1234",
      zoneALayout: "split",
      brainDir,
      repoRoot: root,
      now,
      recordMetrics: true,
      metricSource: "cli",
      envVars: {},
    });
    expect(optInCompile.zone_a).toBe(baselineCompile.zone_a);
    expect(optInCompile.zone_a0).toBe(baselineCompile.zone_a0);
    expect(optInCompile.zone_a1).toBe(baselineCompile.zone_a1);
    expect(optInCompile.zone_b).toBe(baselineCompile.zone_b);
    expect(optInCompile.zone_a_sha256).toBe(baselineCompile.zone_a_sha256);
    expect(optInCompile.zone_a0_sha256).toBe(baselineCompile.zone_a0_sha256);
    expect(optInCompile.semantic_hash).toBe(baselineCompile.semantic_hash);

    expect(existsSync(metricsPath)).toBe(true);
    const rawLine = readFileSync(metricsPath, "utf8").trim();
    const parsed = JSON.parse(rawLine) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "compile_ms",
      "env",
      "layout",
      "role",
      "source",
      "total_tokens",
      "ts",
      "zone_a0_sha256",
      "zone_a0_tokens",
      "zone_a_sha256",
      "zone_a_tokens",
      "zone_b_tokens",
    ]);
    expect(parsed.zone_a0_sha256).toBe(optInCompile.zone_a0_sha256.slice(0, 12));
    expect(parsed.zone_a_sha256).toBe(optInCompile.zone_a_sha256.slice(0, 12));
    expect(rawLine).not.toContain("Ian Mayor");
    expect(rawLine).not.toContain("DEC-001");
    expect(rawLine).not.toContain("HYPOTHESIS");
    expect(rawLine).not.toContain(root);

    // 3. Opt-in via VERIBRAIN_METRICS=1 also appends cleanly
    compileContext({
      role: "cqe",
      env: "local",
      gitSha: "abcdef1234",
      zoneALayout: "split",
      brainDir,
      repoRoot: root,
      now,
      metricSource: "mcp",
      envVars: { VERIBRAIN_METRICS: "1" },
    });
    const { events } = readMetricEvents(brainDir, { repoRoot: root, nowMs: now.getTime() });
    expect(events).toHaveLength(2);
    expect(events[0]?.source).toBe("cli");
    expect(events[1]?.source).toBe("mcp");
  });

  it("validates optional config.metrics cleanly while preserving v1.0/v1.1 backwards compatibility", () => {
    const root = makeTempDir();
    const brainDir = path.join(root, ".brain");
    initBrain({ brainDir, repoRoot: root, signedBy: "Ian Mayor", envVars: {} });
    const cfgPath = path.join(brainDir, "config.json");

    // Existing v1.0 config without metrics remains valid
    expect(loadBrainConfig(brainDir, true).metrics).toBeUndefined();

    // Valid metrics config parses cleanly
    const baseCfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      cfgPath,
      `${JSON.stringify(
        {
          ...baseCfg,
          metrics: {
            enabled: true,
            baseline_paths: ["README.md", "docs"],
            max_bytes: 4096,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const loaded = loadBrainConfig(brainDir, true);
    expect(loaded.metrics).toEqual({
      enabled: true,
      baseline_paths: ["README.md", "docs"],
      max_bytes: 4096,
    });

    // Rejects invalid max_bytes (< 1024)
    writeFileSync(
      cfgPath,
      `${JSON.stringify({ ...baseCfg, metrics: { enabled: true, max_bytes: 512 } }, null, 2)}\n`,
      "utf8",
    );
    try {
      loadBrainConfig(brainDir, true);
      expect.unreachable("max_bytes < 1024 must fail");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_ERROR);
      expect((err as VeriBrainError).rule).toBe("invalid_metrics_max_bytes");
    }

    // Rejects traversal in config.metrics.baseline_paths with Exit 4
    writeFileSync(
      cfgPath,
      `${JSON.stringify(
        { ...baseCfg, metrics: { enabled: true, baseline_paths: ["../secret.md"] } },
        null,
        2,
      )}\n`,
      "utf8",
    );
    try {
      loadBrainConfig(brainDir, true);
      expect.unreachable("traversal baseline_paths must fail Exit 4");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
    }
  });

  it("computes exact Zone A0 repeat/cross-role hits, baseline compression, corrupt-line resilience, window filtering, and atomic 50% compaction", () => {
    const root = makeTempDir();
    const brainDir = path.join(root, ".brain");
    const now = new Date("2026-11-28T02:00:00Z");
    initBrain({ brainDir, repoRoot: root, signedBy: "Ian Mayor", now, envVars: {} });

    // Create a shared constitutional rule large enough to clear >= 1024 Zone A0 tokens
    decideRule({
      id: "DEC-002",
      priority: "P0",
      roles: ["*"],
      signedBy: "Ian Mayor",
      title: "Constitutional Policy Floor",
      body: buildLongConstitutionalBody(),
      brainDir,
      repoRoot: root,
      now,
      envVars: {},
    });

    // Create baseline docs (20 KB -> ~5,120 est. tokens)
    mkdirSync(path.join(root, "docs", "archive"), { recursive: true });
    writeFileSync(path.join(root, "README.md"), `${"R".repeat(12_000)}\n`, "utf8");
    writeFileSync(path.join(root, "docs", "guide.md"), `${"G".repeat(8_000)}\n`, "utf8");
    // Archived doc must be excluded from default baseline scan
    writeFileSync(path.join(root, "docs", "archive", "old.md"), `${"A".repeat(40_000)}\n`, "utf8");

    // Enable metrics via runStats({ enable: true })
    const enabledRes = runStats({ enable: true, brainDir, repoRoot: root, now, envVars: {} });
    expect(enabledRes.enabled).toBe(true);
    expect(enabledRes.action).toBe("enabled");

    // 4 eligible split compiles (>= 1024 A0 tokens): builder x2 (CLI), cqe x1 (MCP), security x1 (MCP)
    const c1 = compileContext({
      role: "builder",
      env: "local",
      zoneALayout: "split",
      brainDir,
      repoRoot: root,
      now,
      metricSource: "cli",
      envVars: {},
    });
    expect(c1.zone_a0_tokens_est).toBeGreaterThanOrEqual(KV_CACHE_MIN_FLOOR_TOKENS);

    compileContext({
      role: "builder",
      env: "local",
      zoneALayout: "split",
      brainDir,
      repoRoot: root,
      now,
      metricSource: "cli",
      envVars: {},
    });
    compileContext({
      role: "cqe",
      env: "local",
      zoneALayout: "split",
      brainDir,
      repoRoot: root,
      now,
      metricSource: "mcp",
      envVars: {},
    });
    compileContext({
      role: "security",
      env: "local",
      zoneALayout: "split",
      brainDir,
      repoRoot: root,
      now,
      metricSource: "mcp",
      envVars: {},
    });
    // 1 legacy compile (not Zone A0 split eligible)
    compileContext({
      role: "builder",
      env: "local",
      zoneALayout: "legacy",
      brainDir,
      repoRoot: root,
      now,
      metricSource: "cli",
      envVars: {},
    });

    // Inject 2 corrupt lines + 1 old event (45d ago) directly into .metrics.jsonl
    const metricsPath = path.join(brainDir, METRICS_FILENAME);
    const oldEvent = {
      ts: "2026-10-10T00:00:00Z",
      source: "cli",
      role: "cpm",
      env: "local",
      layout: "split",
      zone_a0_sha256: c1.zone_a0_sha256.slice(0, 12),
      zone_a_sha256: c1.zone_a_sha256.slice(0, 12),
      zone_a0_tokens: c1.zone_a0_tokens_est,
      zone_a_tokens: c1.zone_a_tokens_est,
      zone_b_tokens: 100,
      total_tokens: c1.zone_a_tokens_est + 100,
      compile_ms: 2.5,
    };
    const currentRaw = readFileSync(metricsPath, "utf8");
    writeFileSync(
      metricsPath,
      `${JSON.stringify(oldEvent)}\n{broken json\n{"ts":"bad","source":"cli"}\n${currentRaw}`,
      "utf8",
    );

    const stats30d = runStats({ since: "30d", brainDir, repoRoot: root, now, envVars: {} });
    expect(stats30d.compiles_total).toBe(5);
    expect(stats30d.cli_compiles).toBe(3);
    expect(stats30d.mcp_compiles).toBe(2);
    expect(stats30d.zone_a0_eligible_compiles).toBe(4);
    expect(stats30d.zone_a0_repeat_hits).toBe(3);
    expect(stats30d.zone_a0_cross_role_hits).toBe(2);
    expect(stats30d.zone_a0_cacheable_tokens_reused).toBe(3 * c1.zone_a0_tokens_est);
    expect(stats30d.estimated_cache_discount_tokens_at_90pct).toBe(
      Math.round(3 * c1.zone_a0_tokens_est * 0.9),
    );
    expect(stats30d.skipped_corrupt_lines).toBe(2);
    expect(stats30d.baseline_docs_files).toBe(2);
    expect(stats30d.baseline_docs_bytes).toBe(20_002);
    expect(stats30d.baseline_docs_tokens_est).toBe(Math.ceil(20_002 / 4));
    expect(stats30d.tokens_avoided_vs_baseline_docs).toBeGreaterThan(0);
    expect(stats30d.compression_ratio_pct).toBeGreaterThan(0);
    expect(stats30d.methodology_note).toContain("Measured:");
    expect(stats30d.methodology_note).toContain("Estimated:");

    // Plain ASCII <= 80 cols text formatting
    const renderedText = formatStatsText(stats30d);
    for (const line of renderedText.trimEnd().split("\n")) {
      expect(line.length, `Stats text exceeded 80 cols: ${line}`).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7E]*$/.test(line), `Non-ASCII line: ${line}`).toBe(true);
    }
    const renderedMd = formatStatsMarkdown(stats30d);
    expect(renderedMd).toContain("# VeriBrain Local ROI & Telemetry Stats");
    expect(renderedMd).not.toContain("—");

    // --since all includes the 45-day-old event
    const statsAll = runStats({ since: "all", brainDir, repoRoot: root, now, envVars: {} });
    expect(statsAll.compiles_total).toBe(6);
    expect(statsAll.skipped_corrupt_lines).toBe(2);

    // retro must NOT inflate .metrics.jsonl even when metrics.enabled=true
    const beforeRetroCount = readMetricEvents(brainDir, { repoRoot: root }).events.length;
    generateRetroReport({ since: "7d", brainDir, repoRoot: root, now });
    expect(readMetricEvents(brainDir, { repoRoot: root }).events.length).toBe(beforeRetroCount);

    // .metrics.jsonl and .metrics.json are ignored by eval, diff, check-citations, and mirror checks
    writeFileSync(path.join(brainDir, LEGACY_METRICS_JSON_FILENAME), "{}\n", "utf8");
    const mirrorDir = makeTempDir("veribrain-prg3-mirror-");
    syncMirrorFiles(
      brainDir,
      [mirrorDir],
      ["config.json", "scars.md", "decided/DEC-001-veribrain-baseline.md", "decided/DEC-002.md"],
    );
    expect(evaluateBrain({ brainDir, repoRoot: root, strict: true, now }).ok).toBe(true);
    expect(checkMirrorDrift(brainDir, root, [mirrorDir])).toEqual([]);
    expect(generateBrainDiff({ brainDir, repoRoot: root, now }).rendered).not.toContain(".metrics");
    expect(checkCitations({ brainDir, repoRoot: root, now }).ok).toBe(true);

    // Atomic 50%-tail compaction when exceeding max_bytes = 1024
    const compactRoot = makeTempDir("veribrain-prg3-compact-");
    const compactBrain = path.join(compactRoot, ".brain");
    initBrain({
      brainDir: compactBrain,
      repoRoot: compactRoot,
      signedBy: "Ian Mayor",
      envVars: {},
    });
    for (let i = 0; i < 15; i += 1) {
      appendMetricEvent(
        compactBrain,
        {
          ts: `2026-11-28T02:00:${String(i).padStart(2, "0")}Z`,
          source: "cli",
          role: `role-${i}`,
          env: "local",
          layout: "split",
          zone_a0_sha256: "a".repeat(12),
          zone_a_sha256: "b".repeat(12),
          zone_a0_tokens: 1200,
          zone_a_tokens: 1400,
          zone_b_tokens: 200,
          total_tokens: 1600,
          compile_ms: 1.2,
        },
        { repoRoot: compactRoot, maxBytes: 1024 },
      );
    }
    const compactPath = path.join(compactBrain, METRICS_FILENAME);
    expect(statSync(compactPath).size).toBeLessThanOrEqual(1024);
    const compactedEvents = readMetricEvents(compactBrain, { repoRoot: compactRoot }).events;
    expect(compactedEvents.length).toBeGreaterThan(0);
    expect(compactedEvents.length).toBeLessThan(15);
    expect(compactedEvents[compactedEvents.length - 1]?.role).toBe("role-14");
    expect(readdirSync(compactBrain).filter((f) => f.startsWith(".tmp-"))).toEqual([]);
  });

  it("enforces agent mutator Exit 4 refusal, mutual exclusion, symlink confinement, baseline escape denial, and oversized baseline failure", () => {
    const root = makeTempDir();
    const brainDir = path.join(root, ".brain");
    const now = new Date("2026-11-28T02:00:00Z");
    initBrain({ brainDir, repoRoot: root, signedBy: "Ian Mayor", now, envVars: {} });

    // Preserve custom config keys across --enable / --disable
    const cfgPath = path.join(brainDir, "config.json");
    const cfgObj = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfgObj.pinned_ids = ["DEC-001"];
    cfgObj.semantic_keys = { team: "core" };
    writeFileSync(cfgPath, `${JSON.stringify(cfgObj, null, 2)}\n`, "utf8");

    expect(runStats({ enable: true, brainDir, repoRoot: root, now, envVars: {} }).enabled).toBe(
      true,
    );
    expect(loadBrainConfig(brainDir, true).pinned_ids).toEqual(["DEC-001"]);
    expect(loadBrainConfig(brainDir, true).semantic_keys).toEqual({ team: "core" });

    expect(runStats({ disable: true, brainDir, repoRoot: root, now, envVars: {} }).enabled).toBe(
      false,
    );
    expect(loadBrainConfig(brainDir, true).pinned_ids).toEqual(["DEC-001"]);

    // Agent mode refuses --enable, --disable, --reset (even with unknown flag!) with Exit 4
    for (const argv of [
      ["stats", "--enable", "--brain-dir", brainDir, "--repo-root", root],
      ["stats", "--disable", "--brain-dir", brainDir, "--repo-root", root],
      ["stats", "--reset", "--brain-dir", brainDir, "--repo-root", root],
      ["stats", "--enable", "--unknown-flag"],
    ]) {
      const res = captureCli(argv, { VERIBRAIN_AGENT: "1" });
      expect(res.code, `Expected Exit 4 for ${argv.join(" ")}`).toBe(EXIT_PROVENANCE_VIOLATION);
      expect(res.stdout).toBe("");
    }

    // Read-only stats WORKS in agent mode
    const agentRead = captureCli(["stats", "--brain-dir", brainDir, "--repo-root", root], {
      VERIBRAIN_AGENT: "1",
    });
    expect(agentRead.code).toBe(EXIT_OK);
    expect(agentRead.stdout).toContain("VeriBrain Local Stats");

    // Mutually-exclusive flags & invalid since/format -> Exit 1
    expect(
      captureCli(["stats", "--enable", "--disable", "--brain-dir", brainDir, "--repo-root", root])
        .code,
    ).toBe(EXIT_ERROR);
    expect(
      captureCli(["stats", "--enable", "--reset", "--brain-dir", brainDir, "--repo-root", root])
        .code,
    ).toBe(EXIT_ERROR);
    expect(
      captureCli(["stats", "--since", "badwin", "--brain-dir", brainDir, "--repo-root", root]).code,
    ).toBe(EXIT_ERROR);
    expect(
      captureCli(["stats", "--format", "xml", "--brain-dir", brainDir, "--repo-root", root]).code,
    ).toBe(EXIT_ERROR);

    // Baseline path escape fails Exit 4 BEFORE lstatSync & never echoes out-of-repo path
    const secretDirName = "vb-prg3-outside-secret-doc";
    const outsideDir = path.resolve(root, "..", secretDirName);
    mkdirSync(outsideDir, { recursive: true });
    tempDirs.push(outsideDir);
    try {
      runStats({
        baselinePaths: [`../${secretDirName}`],
        brainDir,
        repoRoot: root,
        now,
        envVars: {},
      });
      expect.unreachable("out-of-repo baseline path must fail Exit 4");
    } catch (err) {
      const vb = err as VeriBrainError;
      expect(vb.exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
      expect(vb.detail).not.toContain(secretDirName);
      expect(vb.fix).not.toContain(secretDirName);
    }

    // UNC path denied with Exit 4
    try {
      runStats({ repoRoot: "\\\\server\\share\\repo", brainDir, envVars: {} });
      expect.unreachable("UNC path must fail Exit 4");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
    }

    // Oversized baseline file (> 512 KB) fails closed Exit 1
    writeFileSync(path.join(root, "OVERSIZED.md"), `${"x".repeat(512 * 1024 + 16)}\n`, "utf8");
    try {
      runStats({ baselinePaths: ["OVERSIZED.md"], brainDir, repoRoot: root, now, envVars: {} });
      expect.unreachable("oversized baseline doc must fail Exit 1");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_ERROR);
      expect((err as VeriBrainError).rule).toBe("baseline_file_size_exceeded");
    }
    rmSync(path.join(root, "OVERSIZED.md"), { force: true });

    // Symlinked .brain/.metrics.jsonl: stats/reset fail closed Exit 4 AND best-effort compile never writes outside target!
    const symRoot = makeTempDir("veribrain-prg3-sym-");
    const symBrain = path.join(symRoot, ".brain");
    const outsideTargetDir = makeTempDir("veribrain-prg3-symtarget-");
    const outsideFile = path.join(outsideTargetDir, "victim.jsonl");
    writeFileSync(outsideFile, "DO_NOT_TOUCH\n", "utf8");
    initBrain({ brainDir: symBrain, repoRoot: symRoot, signedBy: "Ian Mayor", now, envVars: {} });

    const metricsLink = path.join(symBrain, METRICS_FILENAME);
    let createdFileSymlink = false;
    try {
      symlinkSync(outsideFile, metricsLink, "file");
      createdFileSymlink = true;
    } catch {
      // Non-elevated Windows may deny file symlinks; fall back to directory junction at .metrics.jsonl
      symlinkSync(outsideTargetDir, metricsLink, "junction");
      createdFileSymlink = true;
    }
    expect(createdFileSymlink).toBe(true);

    try {
      runStats({ brainDir: symBrain, repoRoot: symRoot, now, envVars: {} });
      expect.unreachable("symlinked .metrics.jsonl must fail Exit 4 in stats");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
    }
    try {
      runStats({ reset: true, brainDir: symBrain, repoRoot: symRoot, now, envVars: {} });
      expect.unreachable("symlinked .metrics.jsonl must fail Exit 4 in stats --reset");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
    }

    // Best-effort compile recording refuses symlink without throwing or mutating outside target
    const compiled = compileContext({
      role: "builder",
      env: "local",
      brainDir: symBrain,
      repoRoot: symRoot,
      now,
      recordMetrics: true,
      envVars: {},
    });
    expect(compiled.zone_a_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(outsideFile, "utf8")).toBe("DO_NOT_TOUCH\n");
  });

  it("PRG-3 Remediation Regressions: symlink ancestors, repo-root checks, mirror sync, secret --since quarantine, adjacent cross-role hits, numeric bounds & self-healing compaction", () => {
    const now = new Date("2026-11-28T03:00:00Z");

    // 1. P1-PRG3-1: Symlink ancestor `--brain-dir ./link/.brain --enable` fails Exit 4 with ZERO .brain created inside target
    const ancRepo = makeTempDir("veribrain-prg3-anc-repo-");
    const ancTarget = makeTempDir("veribrain-prg3-anc-target-");
    const linkDir = path.join(ancRepo, "link");
    symlinkSync(ancTarget, linkDir, process.platform === "win32" ? "junction" : "dir");
    const ancRes = captureCli([
      "stats",
      "--enable",
      "--repo-root",
      ancRepo,
      "--brain-dir",
      path.join(linkDir, ".brain"),
    ]);
    expect(ancRes.code).toBe(EXIT_PROVENANCE_VIOLATION);
    expect(ancRes.stdout).toBe("");
    expect(existsSync(path.join(ancTarget, ".brain"))).toBe(false);

    // 2. P2-PRG3-1: Missing --repo-root -> structured Exit 1; symlinked --repo-root -> Exit 4
    const missingRoot = path.join(ancRepo, "does-not-exist-root");
    try {
      runStats({ repoRoot: missingRoot, envVars: {} });
      expect.unreachable("missing repoRoot must throw structured Exit 1");
    } catch (err) {
      const vb = err as VeriBrainError;
      expect(vb.exitCode).toBe(EXIT_ERROR);
      expect(vb.code).toBe("REPO_ROOT_NOT_FOUND");
    }
    try {
      runStats({ repoRoot: linkDir, envVars: {} });
      expect.unreachable("symlinked repoRoot must fail Exit 4");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
    }

    // 3. P2-PRG3-2: stats --enable & --disable sync config.json to configured mirror_dirs so eval --strict --check-mirror stays green
    const mirrorRepo = makeTempDir("veribrain-prg3-mrepo-");
    const mirrorBrain = path.join(mirrorRepo, ".brain");
    const mirrorTarget = makeTempDir("veribrain-prg3-mtarget-");
    initBrain({
      brainDir: mirrorBrain,
      repoRoot: mirrorRepo,
      signedBy: "Ian Mayor",
      now,
      envVars: {},
    });
    const cfgPath = path.join(mirrorBrain, "config.json");
    const cfgData = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfgData.mirror_dirs = [mirrorTarget];
    writeFileSync(cfgPath, `${JSON.stringify(cfgData, null, 2)}\n`, "utf8");
    syncMirrorFiles(
      mirrorBrain,
      [mirrorTarget],
      ["config.json", "scars.md", "decided/DEC-001-veribrain-baseline.md"],
    );
    expect(
      evaluateBrain({
        brainDir: mirrorBrain,
        repoRoot: mirrorRepo,
        strict: true,
        checkMirror: true,
        now,
      }).ok,
    ).toBe(true);

    const enabledMirror = runStats({
      enable: true,
      brainDir: mirrorBrain,
      repoRoot: mirrorRepo,
      now,
      envVars: {},
    });
    expect(enabledMirror.enabled).toBe(true);
    expect(
      evaluateBrain({
        brainDir: mirrorBrain,
        repoRoot: mirrorRepo,
        strict: true,
        checkMirror: true,
        now,
      }).ok,
    ).toBe(true);
    // Enabled with 0 compiles shows compile tip in text format & (est.) labels in md
    const enabledZeroText = formatStatsText(enabledMirror);
    expect(enabledZeroText).toContain("Tip: run `veribrain compile` to record local telemetry.");
    for (const line of enabledZeroText.trimEnd().split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7E]*$/.test(line)).toBe(true);
    }
    const enabledMd = formatStatsMarkdown(enabledMirror);
    expect(enabledMd).toContain("Avg Zone A0 Tokens (est.)");
    expect(enabledMd).toContain("Zone A0 Cacheable Tokens Reused (est.)");
    expect(enabledMirror.methodology_note).toContain("structural reuse across window");

    runStats({
      disable: true,
      brainDir: mirrorBrain,
      repoRoot: mirrorRepo,
      now,
      envVars: {},
    });
    expect(
      evaluateBrain({
        brainDir: mirrorBrain,
        repoRoot: mirrorRepo,
        strict: true,
        checkMirror: true,
        now,
      }).ok,
    ).toBe(true);

    // 4. P2-PRG3-3: Secret passed via --since quarantines Exit 2 with ZERO prefix leak
    const splitSecret = ["AIza", "SyStatsSinceSecretNeverReflect1234"].join("");
    const secretSince = captureCli([
      "stats",
      "--since",
      splitSecret,
      "--brain-dir",
      mirrorBrain,
      "--repo-root",
      mirrorRepo,
    ]);
    expect(secretSince.code).toBe(EXIT_QUARANTINE_VIOLATION);
    expect(secretSince.stdout).toBe("");
    expect(secretSince.stderr).not.toContain("AIza");
    expect(secretSince.stderr).not.toContain("StatsSinceSecret");

    // 5. P2-PRG3-4: Adjacent zone_a0_cross_role_hits sequences
    const seqRepo = makeTempDir("veribrain-prg3-seq-");
    const seqBrain = path.join(seqRepo, ".brain");
    initBrain({ brainDir: seqBrain, repoRoot: seqRepo, signedBy: "Ian Mayor", now, envVars: {} });
    const writeSeq = (roles: string[]): void => {
      const lines = roles.map((role, idx) =>
        JSON.stringify({
          ts: `2026-11-28T02:00:${String(idx).padStart(2, "0")}Z`,
          source: "cli",
          role,
          env: "local",
          layout: "split",
          zone_a0_sha256: "a".repeat(12),
          zone_a_sha256: "b".repeat(12),
          zone_a0_tokens: 1200,
          zone_a_tokens: 1400,
          zone_b_tokens: 100,
          total_tokens: 1500,
          compile_ms: 1.5,
        }),
      );
      writeFileSync(path.join(seqBrain, METRICS_FILENAME), `${lines.join("\n")}\n`, "utf8");
    };

    writeSeq(["cpm", "builder", "builder", "builder"]);
    const seq1 = runStats({ brainDir: seqBrain, repoRoot: seqRepo, now, envVars: {} });
    expect(seq1.zone_a0_repeat_hits).toBe(3);
    expect(seq1.zone_a0_cross_role_hits).toBe(1);

    writeSeq(["builder", "cqe", "builder", "cqe"]);
    const seq2 = runStats({ brainDir: seqBrain, repoRoot: seqRepo, now, envVars: {} });
    expect(seq2.zone_a0_repeat_hits).toBe(3);
    expect(seq2.zone_a0_cross_role_hits).toBe(3);

    // 6. P3: Empty --baseline-paths "" & " , " -> Exit 1; --disable --reset -> Exit 1
    expect(
      captureCli(["stats", "--baseline-paths", "", "--brain-dir", seqBrain, "--repo-root", seqRepo])
        .code,
    ).toBe(EXIT_ERROR);
    expect(
      captureCli([
        "stats",
        "--baseline-paths",
        " , ",
        "--brain-dir",
        seqBrain,
        "--repo-root",
        seqRepo,
      ]).code,
    ).toBe(EXIT_ERROR);
    expect(
      captureCli(["stats", "--disable", "--reset", "--brain-dir", seqBrain, "--repo-root", seqRepo])
        .code,
    ).toBe(EXIT_ERROR);

    // Leading slash/backslash in config.metrics.baseline_paths -> Exit 4
    for (const badPath of ["/etc/passwd", "\\docs\\spec.md"]) {
      const badCfg = JSON.parse(readFileSync(path.join(seqBrain, "config.json"), "utf8")) as Record<
        string,
        unknown
      >;
      writeFileSync(
        path.join(seqBrain, "config.json"),
        `${JSON.stringify({ ...badCfg, metrics: { enabled: false, baseline_paths: [badPath] } }, null, 2)}\n`,
        "utf8",
      );
      try {
        loadBrainConfig(seqBrain, true);
        expect.unreachable(`leading slash baseline_paths must fail: ${badPath}`);
      } catch (err) {
        expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
      }
    }

    // 7. P3: Numeric overflow rejection (1e308) & self-healing compaction purging corrupt lines
    const ovfRepo = makeTempDir("veribrain-prg3-ovf-");
    const ovfBrain = path.join(ovfRepo, ".brain");
    initBrain({ brainDir: ovfBrain, repoRoot: ovfRepo, signedBy: "Ian Mayor", now, envVars: {} });
    try {
      appendMetricEvent(
        ovfBrain,
        {
          ts: "2026-11-28T02:00:00Z",
          source: "cli",
          role: "builder",
          env: "local",
          layout: "split",
          zone_a0_sha256: "a".repeat(12),
          zone_a_sha256: "b".repeat(12),
          zone_a0_tokens: 1e308,
          zone_a_tokens: 1200,
          zone_b_tokens: 100,
          total_tokens: 1300,
          compile_ms: 1.0,
        },
        { repoRoot: ovfRepo },
      );
      expect.unreachable("1e308 token count must be rejected");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_ERROR);
      expect((err as VeriBrainError).rule).toBe("invalid_metric_event");
    }

    // Seed corrupt lines + overflow values into .metrics.jsonl and trigger 1024-byte compaction -> self-heals!
    const validSeedLine = JSON.stringify({
      ts: "2026-11-28T02:00:01Z",
      source: "cli",
      role: "builder",
      env: "local",
      layout: "split",
      zone_a0_sha256: "a".repeat(12),
      zone_a_sha256: "b".repeat(12),
      zone_a0_tokens: 1200,
      zone_a_tokens: 1400,
      zone_b_tokens: 100,
      total_tokens: 1500,
      compile_ms: 1.0,
    });
    const ovfMetricsPath = path.join(ovfBrain, METRICS_FILENAME);
    writeFileSync(
      ovfMetricsPath,
      [
        "{corrupt line 1",
        `${"x".repeat(450)}`,
        validSeedLine,
        `${"y".repeat(450)}`,
        JSON.stringify({
          ts: "2026-11-28T02:00:02Z",
          source: "cli",
          role: "builder",
          env: "local",
          layout: "split",
          zone_a0_sha256: "a".repeat(12),
          zone_a_sha256: "b".repeat(12),
          zone_a0_tokens: 1e308,
          zone_a_tokens: 1400,
          zone_b_tokens: 100,
          total_tokens: 1500,
          compile_ms: 1.0,
        }),
        "",
      ].join("\n"),
      "utf8",
    );
    appendMetricEvent(
      ovfBrain,
      {
        ts: "2026-11-28T02:00:05Z",
        source: "mcp",
        role: "cqe",
        env: "local",
        layout: "split",
        zone_a0_sha256: "a".repeat(12),
        zone_a_sha256: "b".repeat(12),
        zone_a0_tokens: 1200,
        zone_a_tokens: 1400,
        zone_b_tokens: 100,
        total_tokens: 1500,
        compile_ms: 1.1,
      },
      { repoRoot: ovfRepo, maxBytes: 1024 },
    );
    const healed = readMetricEvents(ovfBrain, { repoRoot: ovfRepo });
    expect(healed.skippedCorruptLines).toBe(0);
    expect(healed.events.length).toBeGreaterThanOrEqual(1);
    expect(healed.events[healed.events.length - 1]?.role).toBe("cqe");
  });
});
