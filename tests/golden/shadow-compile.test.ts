import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compileContext } from "../../src/compiler.js";
import { sha256Hex } from "../../src/normalize.js";
import { defaultBrainConfig, isPathBlockedByIsolationEnv } from "../../src/schema.js";
import {
  type EnvName,
  EXIT_QUARANTINE_VIOLATION,
  KV_CACHE_MIN_FLOOR_TOKENS,
  type Priority,
} from "../../src/types.js";
import {
  collectLeakSubstrings,
  invokeCli,
  WorkspaceTracker,
  writeBrainConfig,
  writeDecidedFixture,
  writeObservedFixture,
} from "./helpers.js";

const tracker = new WorkspaceTracker();

afterEach(() => {
  tracker.cleanupAll();
});

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");

const GOVERNANCE_DOCS: ReadonlyArray<{
  relPath: string;
  id: string;
  priority: Priority;
}> = [
  { relPath: "AGENTS.md", id: "DEC-GOV-001", priority: "P0" },
  { relPath: "PRODUCT.md", id: "DEC-GOV-002", priority: "P0" },
  { relPath: "SECURITY.md", id: "DEC-GOV-003", priority: "P0" },
  { relPath: "QUALITY.md", id: "DEC-GOV-004", priority: "P1" },
  { relPath: "docs/RFC-001-veribrain-architecture.md", id: "DEC-GOV-005", priority: "P1" },
];

interface FileSnapshot {
  absPath: string;
  sha256: string;
  mtimeMs: number;
  size: number;
}

function snapshotFileReadOnly(absPath: string): FileSnapshot {
  const bytes = readFileSync(absPath);
  const st = statSync(absPath);
  return {
    absPath,
    sha256: sha256Hex(bytes),
    mtimeMs: st.mtimeMs,
    size: st.size,
  };
}

function extractDocumentedEmails(text: string): string[] {
  const matches = text.match(/[0-9A-Za-z._%+-]{1,64}@(?:[0-9A-Za-z-]{1,63}\.){1,8}[A-Za-z]{2,24}/g);
  return [...new Set((matches ?? []).map((m) => m.toLowerCase()))];
}

function percentile(sortedAsc: readonly number[], p: number): number {
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx] ?? Number.POSITIVE_INFINITY;
}

describe("Golden Shadow-Compile Gate: Strictly Read-Only Governance Ingestion", () => {
  it("shadow-compiles real repo governance docs into an isolated temp dir with zero source mutation, stable zone_a_sha256 across envs, < 15 ms p95, >= 1024 Zone A tokens, and canary secret exit 2", async () => {
    // 1. Snapshot real governance docs BEFORE any reads/ingestion
    const beforeSnapshots = GOVERNANCE_DOCS.map((doc) =>
      snapshotFileReadOnly(path.join(REPO_ROOT, doc.relPath)),
    );

    // 2. Read real governance docs strictly read-only into memory
    const docBodies = GOVERNANCE_DOCS.map((doc) => ({
      ...doc,
      content: readFileSync(path.join(REPO_ROOT, doc.relPath), "utf8"),
    }));

    // 3. Provision ephemeral temp dir strictly under os.tmpdir() (never repoRoot, never external repositories)
    const { root: shadowRoot, brainDir: shadowBrainDir } = tracker.create("vb-shadow-ro-");
    const resolvedTmp = path.resolve(os.tmpdir()).toLowerCase();
    const resolvedShadow = path.resolve(shadowRoot).toLowerCase();
    expect(resolvedShadow.startsWith(resolvedTmp)).toBe(true);
    expect(resolvedShadow.startsWith(path.resolve(REPO_ROOT).toLowerCase())).toBe(false);
    expect(isPathBlockedByIsolationEnv(resolvedShadow, "external-repo,isolated-app")).toBe(false);

    // 4. Write all 5 governance docs into ephemeral shadow .brain/decided/
    for (const doc of docBodies) {
      writeDecidedFixture(shadowBrainDir, {
        id: doc.id,
        priority: doc.priority,
        roles: ["builder", "cqe", "security"],
        signedBy: "Ian Mayor",
        body: doc.content,
      });
    }

    // Check if any governance doc contains documented owner email(s)
    const documentedEmails = [
      ...new Set(docBodies.flatMap((doc) => extractDocumentedEmails(doc.content))),
    ];
    if (documentedEmails.length > 0) {
      // Without explicit allowlist, quarantine MUST fail closed on real PII email (exit 2)
      const unwhitelistedRes = invokeCli([
        "compile",
        "--role",
        "builder",
        "--env",
        "staging",
        "--max-tokens",
        "16384",
        "--brain-dir",
        shadowBrainDir,
        "--repo-root",
        shadowRoot,
      ]);
      expect(unwhitelistedRes.code).toBe(EXIT_QUARANTINE_VIOLATION);
      expect(unwhitelistedRes.stdout).toBe("");
      expect(unwhitelistedRes.stderr).toContain("rule: pii_email");
    }

    // Configure ephemeral shadow brain with 16k budget & approved repo owner email(s) only
    const shadowCfg = defaultBrainConfig();
    shadowCfg.default_max_tokens = 16384;
    shadowCfg.quarantine = {
      allowed_emails: documentedEmails,
      allowed_domains: [],
      allowed_phones: [],
    };
    writeBrainConfig(shadowBrainDir, shadowCfg);

    // Seed ephemeral environment-specific observed claims
    const envs: readonly EnvName[] = ["local", "pre-staging", "staging", "prod"];
    const now = new Date("2026-11-28T12:00:00Z");
    for (const env of envs) {
      writeObservedFixture(shadowBrainDir, {
        claim_id: `OBS-shadow-${env}`,
        env,
        git_sha: "abcdef123456",
        observed_at_utc: "2026-11-28T11:45:00Z",
        ttl_seconds: 3600,
        issuer: "ci",
        roles: ["builder"],
        summary: `Shadow verification observation for ${env} environment.`,
        evidence_ref: `ci:shadow/${env}`,
      });
    }

    // 5. Verify identical zone_a_sha256 across all 4 env switches AND zone_a_tokens_est >= 1,024
    const hashes = new Set<string>();
    let observedZoneATokens = 0;
    for (const env of envs) {
      const res = compileContext({
        role: "builder",
        env,
        gitSha: "abcdef123456",
        maxTokens: 16384,
        brainDir: shadowBrainDir,
        repoRoot: shadowRoot,
        now,
      });
      hashes.add(res.zone_a_sha256);
      observedZoneATokens = res.zone_a_tokens_est;
      expect(res.zone_a_tokens_est).toBeGreaterThanOrEqual(KV_CACHE_MIN_FLOOR_TOKENS);
      expect(res.kv_cache_floor_advisory).toBeNull();
      expect(res.zone_b).toContain(`OBS-shadow-${env}`);
    }
    expect(hashes.size).toBe(1);
    expect(observedZoneATokens).toBeGreaterThanOrEqual(1024);

    // Allow freshly written ephemeral fixtures to age past the 50ms stat-cache safety guard
    await new Promise((resolve) => setTimeout(resolve, 60));

    // 6. Measure shadow compile latency (10 warmup + 100 timed runs -> p95 < 15.0 ms)
    for (let w = 0; w < 10; w += 1) {
      compileContext({
        role: "builder",
        env: "staging",
        gitSha: "abcdef123456",
        maxTokens: 16384,
        brainDir: shadowBrainDir,
        repoRoot: shadowRoot,
        now,
      });
    }
    const timingsMs: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const t0 = performance.now();
      compileContext({
        role: "builder",
        env: "staging",
        gitSha: "abcdef123456",
        maxTokens: 16384,
        brainDir: shadowBrainDir,
        repoRoot: shadowRoot,
        now,
      });
      timingsMs.push(performance.now() - t0);
    }
    const sorted = [...timingsMs].sort((a, b) => a - b);
    const p95Ms = percentile(sorted, 95);

    // 7. Inject canary secret into ephemeral shadow store -> MUST abort with exit 2 and zero leak
    const canarySecret = ["AIza", "SyShadowCanaryAbortCheck9876543210"].join("");
    writeObservedFixture(shadowBrainDir, {
      claim_id: "OBS-shadow-canary",
      env: "staging",
      git_sha: "abcdef123456",
      observed_at_utc: "2026-11-28T11:50:00Z",
      ttl_seconds: 3600,
      issuer: "ci",
      roles: ["builder"],
      summary: `Canary secret injected into ephemeral shadow dir: ${canarySecret}`,
      evidence_ref: "ci:shadow/canary",
    });
    const canaryRes = invokeCli([
      "compile",
      "--role",
      "builder",
      "--env",
      "staging",
      "--max-tokens",
      "16384",
      "--brain-dir",
      shadowBrainDir,
      "--repo-root",
      shadowRoot,
    ]);
    expect(canaryRes.code).toBe(EXIT_QUARANTINE_VIOLATION);
    expect(canaryRes.stdout).toBe("");
    expect(canaryRes.stderr).toContain("ERROR [EXIT 2] QUARANTINE_VIOLATION");
    for (const frag of collectLeakSubstrings(canarySecret)) {
      expect(canaryRes.stderr).not.toContain(frag);
      expect(canaryRes.stdout).not.toContain(frag);
    }

    // 8. Re-snapshot real repo governance docs AFTER shadow run -> assert ZERO mutation (SHA-256 + mtime + size)
    const afterSnapshots = GOVERNANCE_DOCS.map((doc) =>
      snapshotFileReadOnly(path.join(REPO_ROOT, doc.relPath)),
    );
    expect(afterSnapshots).toEqual(beforeSnapshots);

    // 9. Enforce < 15.0 ms p95 latency gate after security & read-only checks complete
    expect(p95Ms).toBeLessThan(15.0);
  });
});
