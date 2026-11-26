import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { computeDecidedBodyHash } from "../../src/normalize.js";
import { EXIT_ERROR, EXIT_QUARANTINE_VIOLATION } from "../../src/types.js";
import { collectLeakSubstrings, invokeCli, WorkspaceTracker } from "./helpers.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");
const BENCH_DIR = path.join(REPO_ROOT, "benchmarks");

const EXPECTED_FAMILIES = [
  "direct_secrets",
  "quarantine_evasion",
  "entropy_smuggling",
  "pii_boundary",
  "prompt_injection_breakout",
  "provenance_filesystem",
  "budget_exhaustion",
] as const;

const tracker = new WorkspaceTracker();

afterEach(() => {
  tracker.cleanupAll();
});

function readJsonFile<T>(relPathFromRepo: string): T {
  const abs = path.join(REPO_ROOT, relPathFromRepo);
  return JSON.parse(readFileSync(abs, "utf8")) as T;
}

describe("Stage 2 Wind Tunnel: Benchmarks, Colab Notebook, Artifacts & Red-Team Regressions", () => {
  it("validates benchmarks/redteam_corpus.json integrity (>= 110 unique IDs across all 7 families)", () => {
    interface CorpusCase {
      id: string;
      family: string;
      description: string;
      target: string;
    }
    interface RedTeamCorpus {
      schema_version: string;
      cases: CorpusCase[];
    }

    const corpus = readJsonFile<RedTeamCorpus>("benchmarks/redteam_corpus.json");
    expect(corpus.schema_version).toBe("1.0");
    expect(Array.isArray(corpus.cases)).toBe(true);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(110);

    const uniqueIds = new Set<string>();
    const countsByFamily = new Map<string, number>();

    for (const entry of corpus.cases) {
      expect(typeof entry.id).toBe("string");
      expect(entry.id.trim().length).toBeGreaterThan(0);
      expect(uniqueIds.has(entry.id)).toBe(false);
      uniqueIds.add(entry.id);
      countsByFamily.set(entry.family, (countsByFamily.get(entry.family) ?? 0) + 1);
    }

    expect(uniqueIds.size).toBe(corpus.cases.length);
    for (const family of EXPECTED_FAMILIES) {
      expect(countsByFamily.get(family) ?? 0).toBeGreaterThanOrEqual(10);
    }
  });

  it("validates Colab notebook nbformat 4, Gemini 4 / google-genai policy, and zero deprecated model IDs or legacy SDKs", () => {
    interface NotebookCell {
      cell_type: string;
      source: string[] | string;
    }
    interface NotebookDoc {
      nbformat: number;
      nbformat_minor: number;
      cells: NotebookCell[];
    }

    const nb = readJsonFile<NotebookDoc>("benchmarks/notebooks/veribrain_stage2_wind_tunnel.ipynb");
    expect(nb.nbformat).toBe(4);
    expect(Array.isArray(nb.cells)).toBe(true);
    expect(nb.cells.length).toBeGreaterThanOrEqual(5);

    const codeSource = nb.cells
      .filter((c) => c.cell_type === "code")
      .map((c) => (Array.isArray(c.source) ? c.source.join("") : c.source))
      .join("\n");
    const allSource = nb.cells
      .map((c) => (Array.isArray(c.source) ? c.source.join("") : c.source))
      .join("\n");

    // Current Gemini 4 + google-genai SDK + Interactions API required
    expect(codeSource).toContain('MODEL = "gemini-4-hydrogen"');
    expect(allSource).toContain("google-genai");
    expect(codeSource).toContain("interactions");

    // Deprecated SDK, legacy generateContent, and deprecated model IDs strictly forbidden
    expect(/google[-.]generativeai/i.test(allSource)).toBe(false);
    expect(/\bgenerate_content\b|\bgenerateContent\b/.test(codeSource)).toBe(false);
    expect(/gemini-(?:2\.5|2\.0|1\.5)-(?:flash|pro|nano|ultra)/i.test(allSource)).toBe(false);

    // Ensure ALLOWED_MODELS dictionary itself never includes any deprecated 2.5/2.0/1.5 entry
    const allowedMatch = /ALLOWED_MODELS\s*=\s*\{[\s\S]*?\}/m.exec(codeSource);
    expect(allowedMatch).not.toBeNull();
    expect(/gemini-(?:2\.5|2\.0|1\.5)/i.test(allowedMatch?.[0] ?? "")).toBe(false);
  });

  it("validates observed Stage 2 JSON results and generated SVG chart invariants", () => {
    interface RedTeamResult {
      schema_version: string;
      cost_usd: number;
      summary: {
        total_cases: number;
        passed: number;
        failed: number;
        pass_rate_pct: number;
        policy_poisoning_escapes: number;
        policy_poisoning_escape_rate_pct: number;
        secret_canary_leaks: number;
      };
      by_family: Record<
        string,
        {
          total: number;
          passed: number;
          failed: number;
          policy_poisoning_escaped: number;
          secret_canary_leaked: number;
        }
      >;
      failed_case_ids: string[];
    }

    const rt = readJsonFile<RedTeamResult>("benchmarks/results/redteam-observed.json");
    expect(rt.schema_version).toBe("1.0");
    expect(rt.cost_usd).toBe(0);
    expect(rt.summary.total_cases).toBeGreaterThanOrEqual(110);
    expect(rt.summary.passed).toBe(rt.summary.total_cases);
    expect(rt.summary.failed).toBe(0);
    expect(rt.summary.pass_rate_pct).toBe(100);
    expect(rt.summary.policy_poisoning_escapes).toBe(0);
    expect(rt.summary.policy_poisoning_escape_rate_pct).toBe(0);
    expect(rt.summary.secret_canary_leaks).toBe(0);
    expect(rt.failed_case_ids).toEqual([]);
    for (const family of EXPECTED_FAMILIES) {
      const fam = rt.by_family[family];
      expect(fam).toBeDefined();
      expect(fam?.failed).toBe(0);
      expect(fam?.policy_poisoning_escaped).toBe(0);
      expect(fam?.secret_canary_leaked).toBe(0);
    }

    interface LatencyResult {
      schema_version: string;
      cost_usd: number;
      corpus: {
        eval_strict_ok: boolean;
        zone_a_tokens_est: number;
        meets_gemini4_4096_floor: boolean;
      };
      modes: {
        warm_stat_validated: {
          runs: number;
          p95_ms: number;
          unique_zone_a_hashes: number;
          hash_identity: string;
        };
        cold_disk: {
          runs: number;
          unique_zone_a_hashes: number;
          hash_identity: string;
        };
      };
      cross_mode_zone_a_identical: boolean;
      gate: {
        target_p95_ms: number;
        warm_p95_pass: boolean;
      };
    }

    const lat = readJsonFile<LatencyResult>("benchmarks/results/latency-observed.json");
    expect(lat.schema_version).toBe("1.0");
    expect(lat.cost_usd).toBe(0);
    expect(lat.corpus.eval_strict_ok).toBe(true);
    expect(lat.corpus.zone_a_tokens_est).toBeGreaterThanOrEqual(4096);
    expect(lat.corpus.meets_gemini4_4096_floor).toBe(true);
    expect(lat.modes.warm_stat_validated.runs).toBe(100);
    expect(lat.modes.warm_stat_validated.p95_ms).toBeLessThan(15.0);
    expect(lat.modes.warm_stat_validated.unique_zone_a_hashes).toBe(1);
    expect(lat.modes.warm_stat_validated.hash_identity).toBe("100/100");
    expect(lat.modes.cold_disk.unique_zone_a_hashes).toBe(1);
    expect(lat.modes.cold_disk.hash_identity).toBe("100/100");
    expect(lat.cross_mode_zone_a_identical).toBe(true);
    expect(lat.gate.warm_p95_pass).toBe(true);

    interface DryRunResult {
      schema_version: string;
      mode: string;
      model: string;
      budget_gate: {
        actual_spend_usd: number;
        absolute_hard_cap_usd: number;
        within_budget: boolean;
      };
      corpus_zone_a: {
        zone_a_tokens_est: number;
        meets_gemini4_4096_floor: boolean;
      };
      prefix_stability: {
        arm_a_naive_dynamic_header: {
          prefix_identical_turns: number;
          prefix_identical_label: string;
        };
        arm_b_veribrain_two_zone: {
          prefix_identical_turns: number;
          prefix_identical_label: string;
        };
      };
      live_cache_telemetry: unknown;
    }

    const dry = readJsonFile<DryRunResult>("benchmarks/results/ai-studio-dryrun.json");
    expect(dry.schema_version).toBe("1.0");
    expect(dry.mode).toBe("dry-run");
    expect(dry.model).toBe("gemini-4-hydrogen");
    expect(dry.budget_gate.actual_spend_usd).toBe(0);
    expect(dry.budget_gate.absolute_hard_cap_usd).toBeLessThanOrEqual(4);
    expect(dry.budget_gate.within_budget).toBe(true);
    expect(dry.corpus_zone_a.zone_a_tokens_est).toBeGreaterThanOrEqual(4096);
    expect(dry.corpus_zone_a.meets_gemini4_4096_floor).toBe(true);
    expect(dry.prefix_stability.arm_a_naive_dynamic_header.prefix_identical_turns).toBe(0);
    expect(dry.prefix_stability.arm_a_naive_dynamic_header.prefix_identical_label).toBe("0/6");
    expect(dry.prefix_stability.arm_b_veribrain_two_zone.prefix_identical_turns).toBe(6);
    expect(dry.prefix_stability.arm_b_veribrain_two_zone.prefix_identical_label).toBe("6/6");
    expect(dry.live_cache_telemetry).toBeNull();

    // Verify all 3 generated SVG charts exist and are valid self-contained SVGs
    for (const chartName of [
      "chart-1-latency.svg",
      "chart-2-redteam-scorecard.svg",
      "chart-3-prefix-stability.svg",
    ]) {
      const svg = readFileSync(path.join(BENCH_DIR, "charts", chartName), "utf8").trim();
      expect(Buffer.byteLength(svg, "utf8")).toBeGreaterThan(1000);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
    }
  });

  it("enforces live regressions for Stage 2 Red-Team patches: OBS-AKIA claim_id redaction, JSON unicode-escaped object key zero-echo, and duplicate frontmatter exit 1", () => {
    // 1. OBS-AKIA... embedded in claim_id -> exit 2, zero stdout, redacted claim_id, zero key echo
    {
      const { root, brainDir } = tracker.create("vb-s2-akia-");
      const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
      const obsRes = invokeCli([
        "observe",
        "--claim-id",
        `OBS-${awsKey}`,
        "--env",
        "staging",
        "--git-sha",
        "abcdef1234",
        "--ttl",
        "3600",
        "--summary",
        "Clean summary body.",
        "--evidence",
        "ci:run/s2-akia",
        "--issuer",
        "ci",
        "--brain-dir",
        brainDir,
        "--repo-root",
        root,
      ]);
      expect(obsRes.code).toBe(EXIT_QUARANTINE_VIOLATION);
      expect(obsRes.stdout).toBe("");
      expect(obsRes.stderr).toContain("claim_id: <redacted-claim-id>");
      for (const frag of collectLeakSubstrings(awsKey)) {
        expect(obsRes.stderr).not.toContain(frag);
      }
    }

    // 2. JSON \u0041Iza... embedded in an object key -> exit 2, zero stdout, zero raw/decoded echo
    {
      const { root, brainDir } = tracker.create("vb-s2-jsonkey-");
      const tail = "IzaSyObjKeySecret9876543210";
      const decodedKey = `A${tail}`;
      mkdirSync(path.join(brainDir, "observed"), { recursive: true });
      const rawJson = [
        "{",
        '  "claim_id": "OBS-s2-jsonkey",',
        '  "env": "staging",',
        '  "git_sha": "abcdef123456",',
        '  "observed_at_utc": "2026-11-25T07:00:00Z",',
        '  "ttl_seconds": 3600,',
        '  "issuer": "ci",',
        '  "roles": ["builder"],',
        '  "summary": "Normal staging summary.",',
        '  "evidence_ref": "ci:run/s2-jsonkey",',
        `  "\\u0041${tail}": "smuggled-in-object-key"`,
        "}",
        "",
      ].join("\n");
      writeFileSync(path.join(brainDir, "observed", "OBS-s2-jsonkey.json"), rawJson, "utf8");

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
      expect(res.code).toBe(EXIT_QUARANTINE_VIOLATION);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("rule: gcp_api_key");
      for (const frag of collectLeakSubstrings(decodedKey)) {
        expect(res.stderr).not.toContain(frag);
      }
    }

    // 3. Duplicate YAML frontmatter key in decided/*.md -> exit 1 (SCHEMA_ERROR), zero stdout
    {
      const { root, brainDir } = tracker.create("vb-s2-dup-fm-");
      const body = "Duplicate frontmatter key smuggling must fail closed.";
      const sha = computeDecidedBodyHash(body);
      mkdirSync(path.join(brainDir, "decided"), { recursive: true });
      const duplicateFm = [
        "---",
        "id: DEC-DUP-FM",
        "priority: P0",
        "roles: [builder]",
        "signed_by: claude-agent",
        "signed_by: Ian Mayor",
        "signed_at_utc: 2026-11-25T07:00:00Z",
        `sha256_body: ${sha}`,
        "status: active",
        "---",
        body,
        "",
      ].join("\n");
      writeFileSync(path.join(brainDir, "decided", "DEC-DUP-FM.md"), duplicateFm, "utf8");

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
      expect(res.code).toBe(EXIT_ERROR);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("ERROR [EXIT 1] SCHEMA_ERROR");
      expect(res.stderr).toContain("rule: duplicate_frontmatter_key");
    }
  });
});
