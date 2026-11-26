import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateBrain } from "../../src/commands/eval.js";
import { initBrain } from "../../src/commands/init.js";
import { writeObservation } from "../../src/commands/observe.js";
import { computeDecidedBodyHash } from "../../src/normalize.js";
import {
  clearFileReadCache,
  loadBrainConfig,
  parseDecidedFile,
  parseHypothesisFile,
  parseObservedFile,
  parseScarsFile,
  regressionTestFileExists,
} from "../../src/schema.js";
import {
  EXIT_ERROR,
  EXIT_PROVENANCE_VIOLATION,
  EXIT_QUARANTINE_VIOLATION,
  VeriBrainError,
} from "../../src/types.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "veribrain-schema-test-"));
  tempDirs.push(dir);
  return dir;
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

describe("schema, provenance, quarantine re-scan, and eval invariants", () => {
  it("initBrain omits DEC-001 without --signed-by, blocks agent envs/signers, and blocks frontmatter injection", () => {
    const root1 = makeTempDir();
    const res1 = initBrain({ repoRoot: root1 });
    expect(res1.created).toContain("config.json");
    expect(res1.created).toContain("scars.md");
    expect(existsSync(path.join(root1, ".brain", "decided", "DEC-001-veribrain-baseline.md"))).toBe(
      false,
    );

    // Block agent signer name
    const root2 = makeTempDir();
    expect(() => initBrain({ repoRoot: root2, signedBy: "coding-agent" })).toThrow(VeriBrainError);
    expect(existsSync(path.join(root2, ".brain"))).toBe(false);

    // Block VERIBRAIN_AGENT_MODE=true / yes and VERIBRAIN_CALLER_ROLE=claude-code on init --signed-by
    for (const envVars of [
      { VERIBRAIN_AGENT_MODE: "1" },
      { VERIBRAIN_AGENT_MODE: "true" },
      { VERIBRAIN_AGENT_MODE: "YES" },
      { VERIBRAIN_CALLER_ROLE: "claude-code" },
    ]) {
      const rootA = makeTempDir();
      try {
        initBrain({ repoRoot: rootA, signedBy: "Ian Mayor", envVars });
        expect.unreachable("should reject agent mode init --signed-by");
      } catch (err) {
        expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
      }
      expect(existsSync(path.join(rootA, ".brain"))).toBe(false);
    }

    // Block newline / colon frontmatter injection in --signed-by
    const root3 = makeTempDir();
    try {
      initBrain({ repoRoot: root3, signedBy: "Ian Mayor\npriority: P0", envVars: {} });
      expect.unreachable("should reject newline in signed-by");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
    }
  });

  it("blocks JSON Unicode-escape secrets and HTML-comment split secrets", () => {
    const root = makeTempDir();
    initBrain({ repoRoot: root, signedBy: "Ian Mayor", now: new Date("2026-11-28T09:00:00Z") });
    const brainDir = path.join(root, ".brain");

    // 1. JSON \u0041 escape hiding AIza... and \u0040 hiding email in observed/*.json
    const obsPath = path.join(brainDir, "observed", "OBS-escape.json");
    writeFileSync(
      obsPath,
      '{"claim_id":"OBS-escape","env":"staging","git_sha":"abcdef1","observed_at_utc":"2026-11-28T09:00:00Z","ttl_seconds":3600,"issuer":"ci","roles":["builder"],"summary":"key \\u0041IzaSyDummyEscapeKey1234567890abcd","evidence_ref":"ci:1"}\n',
      "utf8",
    );
    try {
      parseObservedFile(obsPath, { allowed_emails: [], allowed_domains: [], allowed_phones: [] });
      expect.unreachable("JSON escape secret must fail quarantine");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_QUARANTINE_VIOLATION);
      expect((err as VeriBrainError).rule).toBe("gcp_api_key");
    }
    writeFileSync(
      obsPath,
      '{"claim_id":"OBS-escape","env":"staging","git_sha":"abcdef1","observed_at_utc":"2026-11-28T09:00:00Z","ttl_seconds":3600,"issuer":"ci","roles":["builder"],"summary":"contact john\\u0040personal.com","evidence_ref":"ci:1"}\n',
      "utf8",
    );
    try {
      parseObservedFile(obsPath, { allowed_emails: [], allowed_domains: [], allowed_phones: [] });
      expect.unreachable("JSON escape email must fail quarantine");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_QUARANTINE_VIOLATION);
      expect((err as VeriBrainError).rule).toBe("pii_email");
    }

    // 1b. RT-EVA-04: JSON Unicode-escaped secret inside object KEY must NOT echo key in detail/message
    writeFileSync(
      obsPath,
      '{"claim_id":"OBS-escape","env":"staging","git_sha":"abcdef1","observed_at_utc":"2026-11-28T09:00:00Z","ttl_seconds":3600,"issuer":"ci","roles":["builder"],"summary":"ok","evidence_ref":"ci:1","\\u0041IzaSyKeyLeakZeroEcho1234567890abc":"harmless"}\n',
      "utf8",
    );
    try {
      parseObservedFile(obsPath, { allowed_emails: [], allowed_domains: [], allowed_phones: [] });
      expect.unreachable("JSON escape secret object key must fail quarantine");
    } catch (err) {
      const vbErr = err as VeriBrainError;
      expect(vbErr.exitCode).toBe(EXIT_QUARANTINE_VIOLATION);
      expect(vbErr.rule).toBe("gcp_api_key");
      expect(vbErr.detail).toContain("field=json_object_key");
      expect(vbErr.detail).not.toContain("AIza");
      expect(vbErr.detail).not.toContain("KeyLeakZeroEcho");
      expect(vbErr.message).not.toContain("AIza");
      expect(vbErr.message).not.toContain("KeyLeakZeroEcho");
    }
    rmSync(obsPath);

    // 2. HTML comment splitting AIza<!--x-->Sy... inside scars.md
    writeFileSync(
      path.join(brainDir, "scars.md"),
      [
        "# Scars",
        "## SCAR-001",
        "- created_at_utc: 2026-11-28T09:00:00Z",
        "- expires_at_utc: 2026-12-20T09:00:00Z",
        "- regression_test: tests/unit/schema-provenance.test.ts#L1",
        "- hint: Leaked AIza<!--x-->SySplitAcrossComment1234567890",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      parseScarsFile(
        brainDir,
        { allowed_emails: [], allowed_domains: [], allowed_phones: [] },
        { now: new Date("2026-11-28T10:00:00Z") },
      );
      expect.unreachable("comment-split secret must fail quarantine");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_QUARANTINE_VIOLATION);
      expect((err as VeriBrainError).rule).toBe("gcp_api_key");
    }
  });

  it("writeObservation enforces anti-self-attestation, issuer enum, quarantine, and atomic writes", () => {
    const root = makeTempDir();
    initBrain({ repoRoot: root, signedBy: "Ian Mayor" });
    const brainDir = path.join(root, ".brain");

    for (const envVars of [
      { VERIBRAIN_AGENT_MODE: "1" },
      { VERIBRAIN_AGENT_MODE: "true" },
      { VERIBRAIN_CALLER_ROLE: "agent" },
      { VERIBRAIN_CALLER_ROLE: "codex-agent" },
    ]) {
      try {
        writeObservation({
          claimId: "OBS-agent-attempt",
          env: "staging",
          gitSha: "abcdef1",
          ttlSeconds: 3600,
          summary: "Self attested",
          evidenceRef: "ci:1",
          issuer: "ci",
          brainDir,
          envVars,
        });
        expect.unreachable("agent env must fail");
      } catch (err) {
        expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
      }
    }

    // Reject secret in summary before any file write
    try {
      writeObservation({
        claimId: "OBS-leaked",
        env: "staging",
        gitSha: "abcdef1",
        ttlSeconds: 3600,
        summary: "Found key AIzaSyFakeKey1234567890abcdefghij",
        evidenceRef: "ci:1",
        issuer: "ci",
        brainDir,
        envVars: {},
      });
      expect.unreachable("quarantine must abort");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_QUARANTINE_VIOLATION);
    }
    expect(existsSync(path.join(brainDir, "observed", "OBS-leaked.json"))).toBe(false);

    // Clean observation with commit/<40hex> in evidence_ref succeeds
    const ok = writeObservation({
      claimId: "OBS-valid-1",
      env: "staging",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      ttlSeconds: 3600,
      summary: "All staging checks passed.",
      evidenceRef: "commit/0123456789abcdef0123456789abcdef01234567",
      issuer: "ci",
      brainDir,
      envVars: {},
    });
    expect(existsSync(ok.filePath)).toBe(true);
    expect(evaluateBrain({ brainDir, repoRoot: root, strict: true }).ok).toBe(true);
  });

  it("enforces duplicate frontmatter key rejection, future-date TTL bounds, non-SCAR heading reset, and file-only test links", () => {
    const root = makeTempDir();
    const now = new Date("2026-11-28T09:00:00Z");
    initBrain({ repoRoot: root, signedBy: "Ian Mayor", now });
    const brainDir = path.join(root, ".brain");

    // Duplicate frontmatter key with REAL high-entropy sha256_body returns Exit 1 (RT-PRV-11), not Exit 2
    const dupPath = path.join(brainDir, "decided", "DEC-DUP.md");
    const realBodySha = computeDecidedBodyHash("Body.");
    writeFileSync(
      dupPath,
      [
        "---",
        "id: DEC-DUP",
        "priority: P0",
        "priority: P2",
        "roles: [builder]",
        "signed_by: Ian Mayor",
        "signed_at_utc: 2026-11-28T09:00:00Z",
        `sha256_body: ${realBodySha}`,
        "status: active",
        "---",
        "Body.",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      parseDecidedFile(dupPath, { allowed_emails: [], allowed_domains: [], allowed_phones: [] });
      expect.unreachable("duplicate frontmatter key must fail");
    } catch (err) {
      const vbErr = err as VeriBrainError;
      expect(vbErr.exitCode).toBe(EXIT_ERROR);
      expect(vbErr.rule).toBe("duplicate_frontmatter_key");
    }

    // Duplicate frontmatter that ALSO leaks a secret MUST still fail closed with Exit 2
    writeFileSync(
      dupPath,
      [
        "---",
        "id: DEC-DUP",
        "priority: P0",
        "priority: P2",
        "roles: [builder]",
        "signed_by: Ian Mayor",
        "signed_at_utc: 2026-11-28T09:00:00Z",
        `sha256_body: ${realBodySha}`,
        "status: active",
        "---",
        "Body leaks AIzaSyDupFrontmatterSecret12345678.",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      parseDecidedFile(dupPath, { allowed_emails: [], allowed_domains: [], allowed_phones: [] });
      expect.unreachable("secret inside duplicate frontmatter must fail quarantine");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_QUARANTINE_VIOLATION);
    }
    rmSync(dupPath);

    // Future-dated 2099 hypothesis rejected
    mkdirSync(path.join(brainDir, "hypotheses"), { recursive: true });
    const futHypPath = path.join(brainDir, "hypotheses", "HYP-future.json");
    writeFileSync(
      futHypPath,
      JSON.stringify({
        id: "HYP-future",
        created_at_utc: "2099-01-01T00:00:00Z",
        expires_at_utc: "2099-01-05T00:00:00Z",
        roles: ["builder"],
        proposed_by: "agent",
        hint: "Infinite future pinning attempt.",
      }),
      "utf8",
    );
    const futEval = evaluateBrain({ brainDir, repoRoot: root, now });
    expect(futEval.ok).toBe(false);
    expect(futEval.exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
    rmSync(futHypPath);

    // Non-SCAR heading resets current scar block & directory is rejected by regressionTestFileExists
    mkdirSync(path.join(root, "tests"), { recursive: true });
    writeFileSync(path.join(root, "tests", "real.test.ts"), "// ok\n", "utf8");
    expect(regressionTestFileExists(root, "tests")).toBe(false);
    expect(regressionTestFileExists(root, ".")).toBe(false);
    expect(regressionTestFileExists(root, "tests/real.test.ts#L1")).toBe(true);

    const scarsPath = path.join(brainDir, "scars.md");
    writeFileSync(
      scarsPath,
      [
        "# VeriBrain Scars",
        "## SCAR-001",
        "- created_at_utc: 2026-11-28T09:00:00Z",
        "- expires_at_utc: 2026-12-20T09:00:00Z",
        "- regression_test: tests/real.test.ts#L1",
        "- hint: Real scar.",
        "## Notes",
        "- hint: Should not overwrite SCAR-001 hint.",
        "",
      ].join("\n"),
      "utf8",
    );
    const parsedScars = parseScarsFile(
      brainDir,
      { allowed_emails: [], allowed_domains: [], allowed_phones: [] },
      { now },
    );
    expect(parsedScars.scars).toHaveLength(1);
    expect(parsedScars.scars[0]?.hint).toBe("Real scar.");

    // Tampered DEC-001 body still fails provenance
    const decPath = path.join(brainDir, "decided", "DEC-001-veribrain-baseline.md");
    const orig = readFileSync(decPath, "utf8");
    writeFileSync(decPath, `${orig}\nTampered.\n`, "utf8");
    expect(evaluateBrain({ brainDir, repoRoot: root, now }).exitCode).toBe(
      EXIT_PROVENANCE_VIOLATION,
    );
    writeFileSync(decPath, orig, "utf8");

    // Oversized scars.md >= 4096 B fails
    writeFileSync(scarsPath, `# Scars\n${"a".repeat(4100)}\n`, "utf8");
    expect(evaluateBrain({ brainDir, repoRoot: root, now }).exitCode).toBe(EXIT_ERROR);
  });

  it("closes P2-G2-1: scopes hash-ref entropy exemptions strictly to top-level observed evidence_ref/git_sha", () => {
    const root = makeTempDir();
    const now = new Date("2026-11-28T09:00:00Z");
    initBrain({ repoRoot: root, signedBy: "Ian Mayor", now });
    const brainDir = path.join(root, ".brain");
    const fakeSha256 = "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const fakeCommit = "commit/a3f9c2e81b4d70e6f123456789abcdef01234567";
    const qCfg = { allowed_emails: [], allowed_domains: [], allowed_phones: [] };

    // 1. Nested evidence_ref inside config.json MUST be blocked (Exit 2)
    const cfgPath = path.join(brainDir, "config.json");
    const origCfg = readFileSync(cfgPath, "utf8");
    const poisonedCfg = JSON.parse(origCfg) as Record<string, unknown>;
    poisonedCfg.semantic_keys = { evidence_ref: fakeSha256 };
    writeFileSync(cfgPath, `${JSON.stringify(poisonedCfg, null, 2)}\n`, "utf8");
    try {
      loadBrainConfig(brainDir, true);
      expect.unreachable("nested evidence_ref in config.json must fail quarantine");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_QUARANTINE_VIOLATION);
    }
    writeFileSync(cfgPath, origCfg, "utf8");

    // 2. evidence_ref field inside hypotheses/*.json MUST be blocked (Exit 2)
    mkdirSync(path.join(brainDir, "hypotheses"), { recursive: true });
    const hypPath = path.join(brainDir, "hypotheses", "HYP-p2g21.json");
    writeFileSync(
      hypPath,
      JSON.stringify(
        {
          id: "HYP-p2g21",
          created_at_utc: "2026-11-28T08:00:00Z",
          expires_at_utc: "2026-12-01T08:00:00Z",
          roles: ["builder"],
          proposed_by: "agent",
          hint: "Clean hint",
          evidence_ref: fakeCommit,
        },
        null,
        2,
      ),
      "utf8",
    );
    try {
      parseHypothesisFile(hypPath, qCfg, { now, bypassReadCache: true });
      expect.unreachable("evidence_ref inside hypothesis must fail quarantine");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_QUARANTINE_VIOLATION);
    }
    rmSync(hypPath);

    // 3. Nested evidence_ref inside observed/*.json MUST be blocked (Exit 2)
    const obsPath = path.join(brainDir, "observed", "OBS-nested-ev.json");
    writeFileSync(
      obsPath,
      JSON.stringify(
        {
          claim_id: "OBS-nested-ev",
          env: "staging",
          git_sha: "abcdef1234",
          observed_at_utc: "2026-11-28T08:00:00Z",
          ttl_seconds: 3600,
          issuer: "ci",
          roles: ["builder"],
          summary: "Clean summary",
          evidence_ref: "ci:run/1",
          extra: { evidence_ref: fakeSha256 },
        },
        null,
        2,
      ),
      "utf8",
    );
    try {
      parseObservedFile(obsPath, qCfg, true);
      expect.unreachable("nested evidence_ref inside observed must fail quarantine");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_QUARANTINE_VIOLATION);
    }
    rmSync(obsPath);
  });
});
