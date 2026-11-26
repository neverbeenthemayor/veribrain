import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initBrain } from "../../src/commands/init.js";
import { writeObservation } from "../../src/commands/observe.js";
import { compileContext, formatCompiledMarkdown } from "../../src/compiler.js";
import { computeDecidedBodyHash, sha256Hex } from "../../src/normalize.js";
import { clearFileReadCache } from "../../src/schema.js";
import {
  EXIT_BUDGET_INFEASIBLE,
  EXIT_ERROR,
  VeriBrainError,
  ZONE_BOUNDARY_MARKER,
} from "../../src/types.js";

const tempDirs: string[] = [];

function makeTempWorkspace(): { root: string; brainDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "veribrain-compiler-test-"));
  tempDirs.push(root);
  const brainDir = path.join(root, ".brain");
  initBrain({
    brainDir,
    repoRoot: root,
    signedBy: "Ian Mayor",
    now: new Date("2026-11-28T09:00:00Z"),
  });
  return { root, brainDir };
}

function writeDecided(
  brainDir: string,
  id: string,
  priority: "P0" | "P1" | "P2",
  roles: string[],
  body: string,
): void {
  const sha = computeDecidedBodyHash(body);
  const content = [
    "---",
    `id: ${id}`,
    `priority: ${priority}`,
    `roles: [${roles.join(", ")}]`,
    "signed_by: Ian Mayor",
    "signed_at_utc: 2026-11-28T09:00:00Z",
    `sha256_body: ${sha}`,
    "status: active",
    "---",
    body,
    "",
  ].join("\n");
  writeFileSync(path.join(brainDir, "decided", `${id}.md`), content, "utf8");
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

describe("Two-Zone deterministic compiler", () => {
  it("freezes Zone A byte-for-byte without volatile semantic_hash line or non-Zone-A config churn", () => {
    const { root, brainDir } = makeTempWorkspace();
    writeDecided(brainDir, "DEC-010", "P1", ["builder"], "Use ASCII code-point sorting.");
    writeDecided(brainDir, "DEC-002", "P0", ["builder"], "Keep Zone A free of volatile data.");

    const now = new Date("2026-11-28T10:00:00Z");
    const first = compileContext({
      role: "builder",
      env: "staging",
      gitSha: "abcdef1",
      maxTokens: 8192,
      brainDir,
      repoRoot: root,
      now,
    });

    // Zone A purity checks: plain ASCII heading, no semantic_hash in Zone A, ASCII sort
    expect(first.zone_a).toContain("# VeriBrain Context - Zone A (Static Prefix)");
    expect(first.zone_a).not.toContain("semantic_hash:");
    expect(first.zone_a).not.toContain("—");
    expect(first.zone_b).toContain("# VeriBrain Context - Zone B (Dynamic Tail)");
    expect(first.zone_a.indexOf("DEC-001")).toBeLessThan(first.zone_a.indexOf("DEC-002"));
    expect(first.zone_a.indexOf("DEC-002")).toBeLessThan(first.zone_a.indexOf("DEC-010"));
    expect(first.zone_a.endsWith("\n\n")).toBe(true);
    expect(first.zone_a).not.toContain("\r");
    expect(first.zone_a).not.toContain("staging");
    expect(first.zone_a).not.toContain("abcdef1");
    expect(first.zone_a_sha256).toBe(sha256Hex(Buffer.from(first.zone_a, "utf8")));
    expect(first.total_tokens_est).toBe(first.zone_a_tokens_est + first.zone_b_tokens_est);
    expect(first.chars_per_token).toBe(3.5);
    expect(first.safety_margin).toBe(1.15);

    // Mutate observed, reorder config keys, AND change estimator/budget settings -> Zone A & semantic_hash stay IDENTICAL
    writeObservation({
      claimId: "OBS-staging-ci",
      env: "prod",
      gitSha: "1234567",
      ttlSeconds: 3600,
      summary: "Production deploy verified green.",
      evidenceRef: "ci:run/99",
      issuer: "ci",
      roles: ["builder"],
      brainDir,
      repoRoot: root,
      now,
    });

    const tunedConfig = {
      quarantine: { allowed_phones: [], allowed_domains: [], allowed_emails: [] },
      pinned_ids: ["OBS-staging-ci"],
      default_max_tokens: 16384,
      safety_margin: 1.25,
      chars_per_token: 4.0,
      estimator_version: "utf8-4.0x1.25-v2",
      schema_version: "1.0",
    };
    writeFileSync(
      path.join(brainDir, "config.json"),
      `${JSON.stringify(tunedConfig, null, 4)}\n`,
      "utf8",
    );

    const second = compileContext({
      role: "builder",
      env: "prod",
      gitSha: "1234567",
      maxTokens: 4096,
      brainDir,
      repoRoot: root,
      now: new Date("2026-11-28T10:05:00Z"),
      bypassReadCache: true,
    });

    expect(second.zone_a).toBe(first.zone_a);
    expect(second.zone_a_sha256).toBe(first.zone_a_sha256);
    expect(second.semantic_hash).toBe(first.semantic_hash);
    expect(second.chars_per_token).toBe(4.0);
    expect(second.safety_margin).toBe(1.25);
    expect(second.zone_b).toContain("Based on: OBS-staging-ci (prod@1234567)");

    const md = formatCompiledMarkdown(second);
    expect(md).toContain(`\n\n${ZONE_BOUNDARY_MARKER}\n\n`);
    const [prefix] = md.split(`${ZONE_BOUNDARY_MARKER}\n\n`);
    expect(prefix).toBe(second.zone_a);
  });

  it("rejects invalid --role values containing newlines or unsafe characters", () => {
    const { root, brainDir } = makeTempWorkspace();
    try {
      compileContext({
        role: "builder\n## Injected",
        env: "staging",
        brainDir,
        repoRoot: root,
      });
      expect.unreachable("should reject newline in role");
    } catch (err) {
      expect(err).toBeInstanceOf(VeriBrainError);
      expect((err as VeriBrainError).exitCode).toBe(EXIT_ERROR);
    }
  });

  it("excludes expired or env/sha-mismatched observed claims and flags excluded_stale_ids", () => {
    const { root, brainDir } = makeTempWorkspace();
    const baseTime = new Date("2026-11-28T10:00:00Z");

    writeObservation({
      claimId: "OBS-fresh",
      env: "staging",
      gitSha: "aaaa111",
      ttlSeconds: 3600,
      summary: "Staging healthy.",
      evidenceRef: "ci:run/1",
      issuer: "ci",
      roles: ["builder"],
      brainDir,
      repoRoot: root,
      now: baseTime,
    });
    writeObservation({
      claimId: "OBS-expired",
      env: "staging",
      gitSha: "aaaa111",
      ttlSeconds: 60,
      summary: "Old check.",
      evidenceRef: "ci:run/2",
      issuer: "ci",
      roles: ["builder"],
      brainDir,
      repoRoot: root,
      now: new Date("2026-11-28T09:00:00Z"),
    });
    writeObservation({
      claimId: "OBS-wrong-env",
      env: "prod",
      gitSha: "aaaa111",
      ttlSeconds: 3600,
      summary: "Prod only.",
      evidenceRef: "ci:run/3",
      issuer: "ci",
      roles: ["builder"],
      brainDir,
      repoRoot: root,
      now: baseTime,
    });
    writeObservation({
      claimId: "OBS-wrong-sha",
      env: "staging",
      gitSha: "bbbb222",
      ttlSeconds: 3600,
      summary: "Other commit.",
      evidenceRef: "ci:run/4",
      issuer: "ci",
      roles: ["builder"],
      brainDir,
      repoRoot: root,
      now: baseTime,
    });

    const result = compileContext({
      role: "builder",
      env: "staging",
      gitSha: "aaaa111",
      brainDir,
      repoRoot: root,
      now: new Date("2026-11-28T10:10:00Z"),
    });

    expect(result.zone_b).toContain("Based on: OBS-fresh (staging@aaaa111)");
    expect(result.zone_b).not.toContain("OBS-expired");
    expect(result.zone_b).not.toContain("OBS-wrong-env");
    expect(result.zone_b).not.toContain("OBS-wrong-sha");
    expect(result.excluded_stale_ids).toEqual(["OBS-expired", "OBS-wrong-env", "OBS-wrong-sha"]);
  });

  it("evicts Zone B in deterministic order, sorts evicted_ids ASCII, and lists blocking P0/P1 IDs on exit 3", () => {
    const { root, brainDir } = makeTempWorkspace();
    writeDecided(brainDir, "DEC-002", "P1", ["builder"], "Keep P1 invariants pinned.");
    const now = new Date("2026-11-28T10:00:00Z");

    writeObservation({
      claimId: "OBS-p2-item",
      env: "staging",
      gitSha: "abcdef1",
      ttlSeconds: 3600,
      summary:
        "P2 staging check summary with enough padding words to consume measurable token budget.",
      evidenceRef: "ci:run/10",
      issuer: "ci",
      roles: ["builder"],
      priority: "P2",
      brainDir,
      repoRoot: root,
      now,
    });

    writeFileSync(
      path.join(brainDir, "scars.md"),
      [
        "# VeriBrain Scars",
        "## SCAR-001",
        "- created_at_utc: 2026-11-20T09:00:00Z",
        "- expires_at_utc: 2026-12-15T09:00:00Z",
        "- regression_test: tests/unit/compiler.test.ts#L1",
        "- hint: First scar with extra detail words so it occupies meaningful token space in Zone B.",
        "",
      ].join("\n"),
      "utf8",
    );

    mkdirSync(path.join(brainDir, "hypotheses"), { recursive: true });
    writeFileSync(
      path.join(brainDir, "hypotheses", "HYP-z-older.json"),
      JSON.stringify(
        {
          id: "HYP-z-older",
          created_at_utc: "2026-11-26T08:00:00Z",
          expires_at_utc: "2026-12-01T08:00:00Z",
          roles: ["builder"],
          proposed_by: "agent",
          hint: "Older hypothesis with extra words so eviction removes HYP-z-older first.",
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      path.join(brainDir, "hypotheses", "HYP-a-newer.json"),
      JSON.stringify(
        {
          id: "HYP-a-newer",
          created_at_utc: "2026-11-28T08:00:00Z",
          expires_at_utc: "2026-12-02T08:00:00Z",
          roles: ["builder"],
          proposed_by: "agent",
          hint: "Newer hypothesis with extra words so eviction removes HYP-a-newer second.",
        },
        null,
        2,
      ),
      "utf8",
    );

    const full = compileContext({
      role: "builder",
      env: "staging",
      gitSha: "abcdef1",
      maxTokens: 8192,
      brainDir,
      repoRoot: root,
      now,
    });

    // Cap forcing both hypotheses to evict -> evicted_ids MUST be sorted ASCII
    const tightCap = full.total_tokens_est - 55;
    const evicted = compileContext({
      role: "builder",
      env: "staging",
      gitSha: "abcdef1",
      maxTokens: tightCap,
      brainDir,
      repoRoot: root,
      now,
    });

    expect(evicted.evicted_ids).toEqual(["HYP-a-newer", "HYP-z-older"]);
    expect(evicted.zone_b.indexOf("[EVICTED: HYP-a-newer, reason=token_budget]")).toBeLessThan(
      evicted.zone_b.indexOf("[EVICTED: HYP-z-older, reason=token_budget]"),
    );
    expect(evicted.total_tokens_est).toBeLessThanOrEqual(tightCap);
    expect(evicted.zone_a).toBe(full.zone_a);

    // Budget smaller than Zone A lists blocking P0/P1 IDs CSV on Exit 3
    try {
      compileContext({
        role: "builder",
        env: "staging",
        maxTokens: full.zone_a_tokens_est - 1,
        brainDir,
        repoRoot: root,
        now,
      });
      expect.unreachable("expected budget infeasible error");
    } catch (err) {
      expect(err).toBeInstanceOf(VeriBrainError);
      const vb = err as VeriBrainError;
      expect(vb.exitCode).toBe(EXIT_BUDGET_INFEASIBLE);
      expect(vb.claimId).toBe("DEC-001,DEC-002");
    }
  });
});
