import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileContext, formatCompiledMarkdown } from "../../src/compiler.js";
import { sha256Hex } from "../../src/normalize.js";
import { defaultBrainConfig } from "../../src/schema.js";
import { ZONE_BOUNDARY_MARKER } from "../../src/types.js";
import {
  WorkspaceTracker,
  writeBrainConfig,
  writeDecidedFixture,
  writeHypothesisFixture,
  writeObservedFixture,
  writeScarsFixture,
} from "./helpers.js";

const tracker = new WorkspaceTracker();

afterEach(() => {
  tracker.cleanupAll();
});

describe("Golden Context Eval #1: Byte-Identical Zone A Static Prefix", () => {
  it("preserves byte-identical zone_a_sha256 across observed churn, JSON key reorder, timestamps, CRLF vs LF, and env/git-sha changes", () => {
    const { root, brainDir } = tracker.create("vb-ge1-");

    const baseConfig = defaultBrainConfig();
    baseConfig.pinned_ids = ["DEC-002", "DEC-001"];
    baseConfig.semantic_keys = {
      compiler_mode: "deterministic",
      kv_cache_floor: 1024,
      strict_provenance: true,
    };
    writeBrainConfig(brainDir, baseConfig, { indent: 2, lineEnding: "\n" });

    const bodyDec001 =
      "All production context compiles deterministically with zero runtime LLM calls.\nZone A stays byte-frozen across volatile updates.";
    const bodyDec002 = "Never write to external repositories during shadow verification.";
    const bodyDec010 = "Sort active DECIDED records by priority ascending then ASCII ID ascending.";
    const bodyDec005 = "Emit mandatory Based on citations for every DECIDED and OBSERVED claim.";

    writeDecidedFixture(brainDir, {
      id: "DEC-010",
      priority: "P1",
      roles: ["builder", "cqe"],
      body: bodyDec010,
      signedAtUtc: "2026-11-28T09:00:00Z",
      lineEnding: "\n",
    });
    writeDecidedFixture(brainDir, {
      id: "DEC-002",
      priority: "P0",
      roles: ["builder"],
      body: bodyDec002,
      signedAtUtc: "2026-11-28T09:01:00Z",
      lineEnding: "\n",
    });
    writeDecidedFixture(brainDir, {
      id: "DEC-001",
      priority: "P0",
      roles: ["*"],
      body: bodyDec001,
      signedAtUtc: "2026-11-28T09:02:00Z",
      lineEnding: "\n",
    });
    writeDecidedFixture(brainDir, {
      id: "DEC-005",
      priority: "P2",
      roles: ["builder"],
      body: bodyDec005,
      signedAtUtc: "2026-11-28T09:03:00Z",
      lineEnding: "\n",
    });
    // Superseded and non-matching role records must not perturb Zone A
    writeDecidedFixture(brainDir, {
      id: "DEC-099",
      priority: "P0",
      roles: ["builder"],
      body: "Deprecated v1 nightly LLM sleep bot policy.",
      status: "superseded",
    });
    writeDecidedFixture(brainDir, {
      id: "DEC-098",
      priority: "P0",
      roles: ["cfoe"],
      body: "CFOE-only cost ledger policy.",
    });

    const baseline = compileContext({
      role: "builder",
      env: "local",
      gitSha: "aaaa111",
      maxTokens: 8192,
      brainDir,
      repoRoot: root,
      now: new Date("2026-11-28T10:00:00Z"),
    });

    // Verify Zone A cryptographic hash, exact byte length, canonical sort, and cleanliness
    expect(baseline.zone_a_sha256).toBe(sha256Hex(Buffer.from(baseline.zone_a, "utf8")));
    expect(baseline.zone_a_bytes).toBe(Buffer.byteLength(baseline.zone_a, "utf8"));
    expect(baseline.zone_a).not.toContain("\r");
    expect(baseline.zone_a).not.toContain("local");
    expect(baseline.zone_a).not.toContain("aaaa111");
    expect(baseline.zone_a).not.toContain("2026-11-28");
    expect(baseline.zone_a).not.toContain("DEC-099");
    expect(baseline.zone_a).not.toContain("DEC-098");

    const idx001 = baseline.zone_a.indexOf("### [P0] DEC-001");
    const idx002 = baseline.zone_a.indexOf("### [P0] DEC-002");
    const idx010 = baseline.zone_a.indexOf("### [P1] DEC-010");
    const idx005 = baseline.zone_a.indexOf("### [P2] DEC-005");
    expect(idx001).toBeGreaterThan(-1);
    expect(idx001).toBeLessThan(idx002);
    expect(idx002).toBeLessThan(idx010);
    expect(idx010).toBeLessThan(idx005);

    // Mutate ALL volatile inputs:
    // 1. Reorder config.json keys, nested semantic_keys, pinned_ids order, indentation & CRLF
    const reorderedConfigRaw = [
      "{",
      '  "semantic_keys": {',
      '    "strict_provenance": true,',
      '    "kv_cache_floor": 1024,',
      '    "compiler_mode": "deterministic"',
      "  },",
      '  "quarantine": {',
      '    "allowed_phones": [],',
      '    "allowed_domains": [],',
      '    "allowed_emails": []',
      "  },",
      '  "pinned_ids": ["DEC-001", "DEC-002"],',
      '  "default_max_tokens": 8192,',
      '  "safety_margin": 1.15,',
      '  "chars_per_token": 3.5,',
      '  "estimator_version": "utf8-3.5x1.15-v1",',
      '  "schema_version": "1.0"',
      "}",
      "",
    ].join("\r\n");
    writeFileSync(path.join(brainDir, "config.json"), reorderedConfigRaw, "utf8");

    // 2. Rewrite decided files with CRLF, BOM, trailing spaces, reordered frontmatter, comments, new timestamps
    writeDecidedFixture(brainDir, {
      id: "DEC-001",
      priority: "P0",
      roles: ["*"],
      body: `${bodyDec001}   `,
      signedAtUtc: "2026-12-01T23:59:59Z",
      lineEnding: "\r\n",
      withBom: true,
      reverseFrontmatter: true,
      frontmatterComment: "Non-semantic comment added during review",
    });
    writeDecidedFixture(brainDir, {
      id: "DEC-002",
      priority: "P0",
      roles: ["builder"],
      body: `${bodyDec002}\t  `,
      signedAtUtc: "2026-12-02T12:34:56Z",
      lineEnding: "\r\n",
      reverseFrontmatter: true,
    });

    // 3. Add multiple observed facts (reordered JSON keys + CRLF), scars, and hypotheses
    writeObservedFixture(brainDir, {
      claim_id: "OBS-staging-ci",
      env: "staging",
      git_sha: "bbbb22223333",
      observed_at_utc: "2026-11-28T11:00:00Z",
      ttl_seconds: 7200,
      issuer: "ci",
      roles: ["builder"],
      priority: "P1",
      summary: "Staging test suite passed with zero lint warnings.",
      evidence_ref: "ci:run/20261128-01",
      reverseKeys: true,
      lineEnding: "\r\n",
    });
    writeObservedFixture(brainDir, {
      claim_id: "OBS-prod-deploy",
      env: "prod",
      git_sha: "cccc44445555",
      observed_at_utc: "2026-11-28T11:30:00Z",
      ttl_seconds: 3600,
      issuer: "verifier-script",
      roles: ["builder"],
      priority: "P2",
      summary: "Prod health probe returned 200 OK across all regions.",
      evidence_ref: "ci:probe/88",
      minified: true,
    });
    writeScarsFixture(
      brainDir,
      [
        {
          scar_id: "SCAR-001",
          created_at_utc: "2026-11-25T09:00:00Z",
          expires_at_utc: "2026-12-20T09:00:00Z",
          regression_test: "tests/golden/eval-1-zone-a-identity.test.ts#L1",
          hint: "Do not include timestamps in Zone A header metadata.",
          roles: ["builder"],
        },
      ],
      { lineEnding: "\r\n", preambleComment: "Volatile comment churn" },
    );
    writeHypothesisFixture(brainDir, {
      id: "HYP-001",
      created_at_utc: "2026-11-28T10:00:00Z",
      expires_at_utc: "2026-12-03T10:00:00Z",
      roles: ["builder"],
      hint: "Consider adding a second staging health check.",
    });

    // Compile across all environments, different git SHAs, different timestamps, and different maxTokens
    const scenarios = [
      { env: "local" as const, gitSha: undefined, maxTokens: 4096, now: "2026-11-28T11:15:00Z" },
      {
        env: "pre-staging" as const,
        gitSha: "deadbeef1234",
        maxTokens: 6000,
        now: "2026-11-28T11:20:00Z",
      },
      {
        env: "staging" as const,
        gitSha: "bbbb22223333",
        maxTokens: 8192,
        now: "2026-11-28T11:25:00Z",
      },
      {
        env: "prod" as const,
        gitSha: "cccc44445555",
        maxTokens: 16384,
        now: "2026-11-28T11:45:00Z",
      },
    ];

    for (const sc of scenarios) {
      const compiled = compileContext({
        role: "builder",
        env: sc.env,
        ...(sc.gitSha !== undefined ? { gitSha: sc.gitSha } : {}),
        maxTokens: sc.maxTokens,
        brainDir,
        repoRoot: root,
        now: new Date(sc.now),
      });

      expect(compiled.zone_a_sha256).toBe(baseline.zone_a_sha256);
      expect(compiled.semantic_hash).toBe(baseline.semantic_hash);
      expect(compiled.zone_a_bytes).toBe(baseline.zone_a_bytes);
      expect(compiled.zone_a).toBe(baseline.zone_a);

      const md = formatCompiledMarkdown(compiled);
      const parts = md.split(`${ZONE_BOUNDARY_MARKER}\n\n`);
      expect(parts).toHaveLength(2);
      expect(parts[0]).toBe(baseline.zone_a);
      expect(sha256Hex(Buffer.from(parts[0] ?? "", "utf8"))).toBe(baseline.zone_a_sha256);
    }
  });

  it("changes semantic_hash on semantic_keys mutation while keeping zone_a_sha256 byte-pure, and changes both when an active DECIDED body changes", () => {
    const { root, brainDir } = tracker.create("vb-ge1-sens-");
    const cfg = defaultBrainConfig();
    cfg.semantic_keys = { architecture_rev: "v2" };
    writeBrainConfig(brainDir, cfg);
    writeDecidedFixture(brainDir, {
      id: "DEC-001",
      priority: "P0",
      roles: ["builder"],
      body: "Original signed baseline rule.",
    });

    const first = compileContext({
      role: "builder",
      env: "staging",
      brainDir,
      repoRoot: root,
      now: new Date("2026-11-28T10:00:00Z"),
    });

    // Mutate semantic key: semantic_hash MUST change while zone_a_sha256 stays byte-pure to Zone A text
    cfg.semantic_keys = { architecture_rev: "v3" };
    writeBrainConfig(brainDir, cfg);
    const afterSemanticChange = compileContext({
      role: "builder",
      env: "staging",
      brainDir,
      repoRoot: root,
      now: new Date("2026-11-28T10:00:00Z"),
    });
    expect(afterSemanticChange.semantic_hash).not.toBe(first.semantic_hash);
    expect(afterSemanticChange.zone_a).toBe(first.zone_a);
    expect(afterSemanticChange.zone_a_sha256).toBe(first.zone_a_sha256);

    // Restore semantic key and mutate DECIDED rule body (properly re-signed): BOTH hashes MUST change
    cfg.semantic_keys = { architecture_rev: "v2" };
    writeBrainConfig(brainDir, cfg);
    writeDecidedFixture(brainDir, {
      id: "DEC-001",
      priority: "P0",
      roles: ["builder"],
      body: "Updated human-signed baseline rule with new constraint.",
    });
    const afterBodyChange = compileContext({
      role: "builder",
      env: "staging",
      brainDir,
      repoRoot: root,
      now: new Date("2026-11-28T10:00:00Z"),
    });
    expect(afterBodyChange.semantic_hash).not.toBe(first.semantic_hash);
    expect(afterBodyChange.zone_a_sha256).not.toBe(first.zone_a_sha256);
  });

  it("keeps zone_a_sha256 100% identical across budget-tuning config and non-DEC pinned_ids changes (Bench P1)", () => {
    const { root, brainDir } = tracker.create("vb-ge1-bench-p1-");
    const cfg = defaultBrainConfig();
    writeBrainConfig(brainDir, cfg);
    writeDecidedFixture(brainDir, {
      id: "DEC-001",
      priority: "P0",
      roles: ["builder"],
      body: "Prefix stability must survive estimator and budget retuning without cache invalidation.",
    });

    const now = new Date("2026-11-28T10:00:00Z");
    const baseline = compileContext({
      role: "builder",
      env: "staging",
      brainDir,
      repoRoot: root,
      now,
    });

    // Retune chars_per_token, safety_margin, default_max_tokens, and non-DEC pinned_ids
    const retuned = defaultBrainConfig();
    retuned.chars_per_token = 4.0;
    retuned.safety_margin = 1.25;
    retuned.default_max_tokens = 16384;
    retuned.pinned_ids = ["OBS-critical-health", "OBS-staging-smoke"];
    writeBrainConfig(brainDir, retuned);

    const afterRetune = compileContext({
      role: "builder",
      env: "staging",
      brainDir,
      repoRoot: root,
      now,
    });

    expect(afterRetune.zone_a).toBe(baseline.zone_a);
    expect(afterRetune.zone_a_sha256).toBe(baseline.zone_a_sha256);
    expect(afterRetune.semantic_hash).toBe(baseline.semantic_hash);
    expect(afterRetune.zone_a_bytes).toBe(baseline.zone_a_bytes);
  });
});
