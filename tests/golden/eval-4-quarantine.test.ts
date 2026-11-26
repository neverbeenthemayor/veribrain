import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateBrain } from "../../src/commands/eval.js";
import { compileContext } from "../../src/compiler.js";
import { defaultBrainConfig } from "../../src/schema.js";
import { EXIT_OK, EXIT_QUARANTINE_VIOLATION, type QuarantineRuleId } from "../../src/types.js";
import {
  collectLeakSubstrings,
  invokeCli,
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

interface SecretFixtureCase {
  label: string;
  expectedRule: QuarantineRuleId;
  secretValue: string;
  lineText: string;
}

const SECRET_CASES: readonly SecretFixtureCase[] = [
  {
    label: "GCP/Gemini API key (AIza...)",
    expectedRule: "gcp_api_key",
    secretValue: ["AIza", "SyFakeGoldenEvalKey9876543210abcdef"].join(""),
    lineText: `Using key ${["AIza", "SyFakeGoldenEvalKey9876543210abcdef"].join("")} in fixture.`,
  },
  {
    label: "JWT token",
    expectedRule: "jwt",
    secretValue: [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "eyJzdWIiOiJnb2xkZW4tZXZhbCIsInJvbGUiOiJidWlsZGVyIn0",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join("."),
    lineText: `Token=${[
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "eyJzdWIiOiJnb2xkZW4tZXZhbCIsInJvbGUiOiJidWlsZGVyIn0",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join(".")}`,
  },
  {
    label: "Authorization Bearer token",
    expectedRule: "bearer",
    secretValue: "vb_live_bearer_secret_9876543210",
    lineText: "Authorization: Bearer vb_live_bearer_secret_9876543210",
  },
  {
    label: "PEM private key block",
    expectedRule: "pem_private",
    secretValue: ["-----BEGIN ", "RSA PRIVATE KEY-----"].join(""),
    lineText: ["-----BEGIN ", "RSA PRIVATE KEY-----"].join(""),
  },
  {
    label: "OAuth client_secret key-value",
    expectedRule: "oauth_kv",
    secretValue: "vb_oauth_super_secret_val_998877",
    lineText: "client_secret=vb_oauth_super_secret_val_998877",
  },
  {
    label: "Google OAuth provider token (GOCSPX-...)",
    expectedRule: "provider_token",
    secretValue: ["GOCSPX", "-FakeOAuthClientSecretToken123456"].join(""),
    lineText: `OAuth ${["GOCSPX", "-FakeOAuthClientSecretToken123456"].join("")}`,
  },
  {
    label: "Personal email address (unwhitelisted)",
    expectedRule: "pii_email",
    secretValue: "private.person@personal-vault.example",
    lineText: "Escalation contact: private.person@personal-vault.example",
  },
  {
    label: "Personal phone number (E.164)",
    expectedRule: "pii_phone",
    secretValue: "+1 415 555 0199",
    lineText: "On-call cell: +1 415 555 0199",
  },
  {
    label: "High-entropy 32+ char opaque token",
    expectedRule: "high_entropy_secret",
    secretValue: "k9Xm2Qp7Rv4Wz8Yn1Bc6Df3Hj5Ln0Tr8Vs2K",
    lineText: "Raw credential blob: k9Xm2Qp7Rv4Wz8Yn1Bc6Df3Hj5Ln0Tr8Vs2K",
  },
];

describe("Golden Context Eval #4: Fail-Closed PII & Secret Quarantine", () => {
  for (const testCase of SECRET_CASES) {
    it(`aborts compile and eval with exit 2, zero stdout, and zero secret echo for: ${testCase.label}`, () => {
      const { root, brainDir } = tracker.create("vb-ge4-");
      writeDecidedFixture(brainDir, {
        id: "DEC-001",
        priority: "P0",
        roles: ["builder"],
        body: "Zero raw secrets may ever enter compiled context.",
      });
      writeObservedFixture(brainDir, {
        claim_id: "OBS-poisoned",
        env: "staging",
        git_sha: "abcdef1234567890",
        observed_at_utc: "2026-11-25T07:00:00Z",
        ttl_seconds: 3600,
        issuer: "ci",
        roles: ["builder"],
        summary: testCase.lineText,
        evidence_ref: "ci:run/quarantine",
      });

      const compileRes = invokeCli([
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

      expect(compileRes.code).toBe(EXIT_QUARANTINE_VIOLATION);
      expect(compileRes.stdout).toBe("");
      expect(Buffer.byteLength(compileRes.stdout, "utf8")).toBe(0);
      expect(compileRes.stderr).toContain("ERROR [EXIT 2] QUARANTINE_VIOLATION");
      expect(compileRes.stderr).toContain(`rule: ${testCase.expectedRule}`);
      expect(compileRes.stderr).toContain("claim_id: OBS-poisoned");

      for (const fragment of collectLeakSubstrings(testCase.secretValue)) {
        expect(compileRes.stderr).not.toContain(fragment);
        expect(compileRes.stdout).not.toContain(fragment);
      }

      const evalRes = invokeCli(["eval", "--brain-dir", brainDir, "--repo-root", root]);
      expect(evalRes.code).toBe(EXIT_QUARANTINE_VIOLATION);
      expect(evalRes.stdout).toBe("");
      for (const fragment of collectLeakSubstrings(testCase.secretValue)) {
        expect(evalRes.stderr).not.toContain(fragment);
      }
    });
  }

  it("enforces fail-closed quarantine across decided, scars, hypotheses, config, diff, and observe CLI writes", () => {
    const fakeKey = ["AIza", "SySurfaceCheckKey1122334455667788"].join("");
    const leakFragments = collectLeakSubstrings(fakeKey);

    // 1. decided/*.md surface
    {
      const { root, brainDir } = tracker.create("vb-ge4-dec-");
      writeDecidedFixture(brainDir, {
        id: "DEC-LEAK",
        priority: "P0",
        roles: ["builder"],
        body: `Leaked key ${fakeKey} inside decided doc.`,
      });
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
      for (const frag of leakFragments) {
        expect(res.stderr).not.toContain(frag);
      }
    }

    // 2. scars.md surface + diff command
    {
      const { root, brainDir } = tracker.create("vb-ge4-scar-");
      writeScarsFixture(brainDir, [
        {
          scar_id: "SCAR-LEAK",
          created_at_utc: "2026-11-24T00:00:00Z",
          expires_at_utc: "2026-12-20T00:00:00Z",
          regression_test: "tests/golden/eval-4-quarantine.test.ts#L1",
          hint: `Never embed ${fakeKey} in logs.`,
        },
      ]);
      const diffRes = invokeCli([
        "diff",
        "--since",
        "7d",
        "--brain-dir",
        brainDir,
        "--repo-root",
        root,
      ]);
      expect(diffRes.code).toBe(EXIT_QUARANTINE_VIOLATION);
      expect(diffRes.stdout).toBe("");
      for (const frag of leakFragments) {
        expect(diffRes.stderr).not.toContain(frag);
      }
    }

    // 3. hypotheses/*.json surface
    {
      const { root, brainDir } = tracker.create("vb-ge4-hyp-");
      writeHypothesisFixture(brainDir, {
        id: "HYP-LEAK",
        created_at_utc: "2026-11-25T06:00:00Z",
        expires_at_utc: "2026-11-29T06:00:00Z",
        roles: ["builder"],
        hint: `Agent guessed ${fakeKey} from env.`,
      });
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
      for (const frag of leakFragments) {
        expect(res.stderr).not.toContain(frag);
      }
    }

    // 4. observe CLI refuses to write poisoned JSON file to disk
    {
      const { root, brainDir } = tracker.create("vb-ge4-obs-");
      const res = invokeCli([
        "observe",
        "--claim-id",
        "OBS-blocked-write",
        "--env",
        "staging",
        "--git-sha",
        "abcdef1234",
        "--ttl",
        "3600",
        "--summary",
        `Observed leaked ${fakeKey}`,
        "--evidence",
        "ci:run/99",
        "--issuer",
        "ci",
        "--brain-dir",
        brainDir,
        "--repo-root",
        root,
      ]);
      expect(res.code).toBe(EXIT_QUARANTINE_VIOLATION);
      expect(res.stdout).toBe("");
      expect(existsSync(path.join(brainDir, "observed", "OBS-blocked-write.json"))).toBe(false);
      for (const frag of leakFragments) {
        expect(res.stderr).not.toContain(frag);
      }
    }
  });

  it("blocks Security P0/P1 evasion vectors: JSON unicode escapes, scars.md comment splices, NFKC/zero-width reassembly, secret-bearing claim_id redaction, and fake repo path secrets", () => {
    // 1. JSON \uXXXX escape bypass attempt ("\u0041IzaSy...")
    {
      const { root, brainDir } = tracker.create("vb-ge4-json-esc-");
      const tail = "IzaSyJsonEscapeBypassKey9876543210";
      const fullSecret = `A${tail}`;
      mkdirSync(path.join(brainDir, "observed"), { recursive: true });
      const rawJson = [
        "{",
        '  "claim_id": "OBS-json-escape",',
        '  "env": "staging",',
        '  "git_sha": "abcdef123456",',
        '  "observed_at_utc": "2026-11-25T07:00:00Z",',
        '  "ttl_seconds": 3600,',
        '  "issuer": "ci",',
        '  "roles": ["builder"],',
        `  "summary": "\\u0041${tail}",`,
        '  "evidence_ref": "ci:run/json-escape"',
        "}",
        "",
      ].join("\n");
      writeFileSync(path.join(brainDir, "observed", "OBS-json-escape.json"), rawJson, "utf8");

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
      for (const frag of collectLeakSubstrings(fullSecret)) {
        expect(res.stderr).not.toContain(frag);
      }
    }

    // 2. scars.md HTML comment splice (AIza<!--x-->Sy..., < 32 chars so only reassembly catches gcp_api_key)
    {
      const { root, brainDir } = tracker.create("vb-ge4-scar-splice-");
      const suffix = "SySpliceKey123456789";
      const fullSecret = ["AIza", suffix].join("");
      writeScarsFixture(brainDir, [
        {
          scar_id: "SCAR-SPLICE",
          created_at_utc: "2026-11-24T00:00:00Z",
          expires_at_utc: "2026-12-15T00:00:00Z",
          regression_test: "tests/golden/eval-4-quarantine.test.ts#L1",
          hint: ["Splice ", "AIza", "<!--x-->", suffix].join(""),
        },
      ]);
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
      for (const frag of collectLeakSubstrings(fullSecret)) {
        expect(res.stderr).not.toContain(frag);
      }
    }

    // 3a. Zero-width space reassembly (AI\u200BzaSy..., < 32 chars so only reassembly catches gcp_api_key)
    {
      const { root, brainDir } = tracker.create("vb-ge4-zwsp-");
      const suffix = "SyZwspKey12345678901";
      const fullSecret = ["AIza", suffix].join("");
      writeObservedFixture(brainDir, {
        claim_id: "OBS-zwsp",
        env: "staging",
        git_sha: "abcdef123456",
        observed_at_utc: "2026-11-25T07:00:00Z",
        ttl_seconds: 3600,
        issuer: "ci",
        roles: ["builder"],
        summary: ["Hidden ", "AI", "\u200B", "za", suffix].join(""),
        evidence_ref: "ci:run/zwsp",
      });
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
      for (const frag of collectLeakSubstrings(fullSecret)) {
        expect(res.stderr).not.toContain(frag);
      }
    }

    // 3b. Fullwidth Unicode homoglyph reassembly (ＡＩｚａＳｙ..., < 32 chars so only NFKC catches gcp_api_key)
    {
      const { root, brainDir } = tracker.create("vb-ge4-fullwidth-");
      const suffix = "Fullwidth123456789";
      const fullSecret = ["AIzaSy", suffix].join("");
      writeObservedFixture(brainDir, {
        claim_id: "OBS-fullwidth",
        env: "staging",
        git_sha: "abcdef123456",
        observed_at_utc: "2026-11-25T07:00:00Z",
        ttl_seconds: 3600,
        issuer: "ci",
        roles: ["builder"],
        summary: `Fullwidth \uFF21\uFF29\uFF5A\uFF41\uFF33\uFF59${suffix}`,
        evidence_ref: "ci:run/fullwidth",
      });
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
      for (const frag of collectLeakSubstrings(fullSecret)) {
        expect(res.stderr).not.toContain(frag);
      }
    }

    // 4. Secret embedded inside claim_id -> redacted to <redacted-claim-id>, zero secret echo
    {
      const { root, brainDir } = tracker.create("vb-ge4-claimid-");
      const embeddedKey = ["AIza", "SyClaimIdSecretLeak9876543210abc"].join("");
      const obsRes = invokeCli([
        "observe",
        "--claim-id",
        `OBS-${embeddedKey}`,
        "--env",
        "staging",
        "--git-sha",
        "abcdef1234",
        "--ttl",
        "3600",
        "--summary",
        "Clean summary text.",
        "--evidence",
        "ci:run/10",
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
      for (const frag of collectLeakSubstrings(embeddedKey)) {
        expect(obsRes.stderr).not.toContain(frag);
      }
    }

    // 5. Fake repo path disguising a 28-char high-entropy secret (src/<28-char-secret>.ts)
    {
      const { root, brainDir } = tracker.create("vb-ge4-fakepath-");
      const fakeSecretStem = "k9Xm2Qp7Rv4Wz8Yn1Bc6Df3Hj5Ln";
      expect(fakeSecretStem.length).toBe(28);
      writeObservedFixture(brainDir, {
        claim_id: "OBS-fake-path",
        env: "staging",
        git_sha: "abcdef123456",
        observed_at_utc: "2026-11-25T07:00:00Z",
        ttl_seconds: 3600,
        issuer: "ci",
        roles: ["builder"],
        summary: `Disguised secret path src/${fakeSecretStem}.ts must be quarantined.`,
        evidence_ref: "ci:run/fake-path",
      });
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
      expect(res.stderr).toContain("rule: high_entropy_secret");
      for (const frag of collectLeakSubstrings(fakeSecretStem)) {
        expect(res.stderr).not.toContain(frag);
      }
    }
  });

  it("allowlists sha256/commit/env@sha strictly in validated hash/evidence_ref fields and blocks them in prose (Security P1-1)", () => {
    const fullSha40 = "a3f9c2e81b4d70e6f123456789abcdef01234567";
    const fullSha256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const uuidV4 = "550e8400-e29b-41d4-a716-446655440000";

    // A. Legitimate non-secrets in validated fields + UUIDs + safe repo paths + whitelisted contacts PASS
    {
      const { root, brainDir } = tracker.create("vb-ge4-fp-");
      const cfg = defaultBrainConfig();
      cfg.quarantine = {
        allowed_emails: ["maintainer@veribrain.dev"],
        allowed_domains: ["approved-ci.example"],
        allowed_phones: [],
      };
      writeBrainConfig(brainDir, cfg);

      writeDecidedFixture(brainDir, {
        id: "DEC-001",
        priority: "P0",
        roles: ["builder"],
        body: [
          "Reference spec at docs/RFC-001-veribrain-architecture.md and tests/golden/eval-4-quarantine.test.ts#L10.",
          `Correlation UUID ${uuidV4} verified by maintainer@veribrain.dev.`,
          "Build notifications go to release-bot@approved-ci.example.",
        ].join("\n"),
      });

      // Validated git_sha + evidence_ref using commit/<40hex>, sha256:<64hex>, and staging@<40hex>
      writeObservedFixture(brainDir, {
        claim_id: "OBS-legit-commit-ref",
        env: "staging",
        git_sha: fullSha40,
        observed_at_utc: "2026-11-25T07:00:00Z",
        ttl_seconds: 3600,
        issuer: "ci",
        roles: ["builder"],
        summary: `Verified staging build with run UUID ${uuidV4} on src/commands/observe.ts.`,
        evidence_ref: `commit/${fullSha40}`,
      });
      writeObservedFixture(brainDir, {
        claim_id: "OBS-legit-sha256-ref",
        env: "staging",
        git_sha: fullSha40,
        observed_at_utc: "2026-11-25T07:02:00Z",
        ttl_seconds: 3600,
        issuer: "ci",
        roles: ["builder"],
        summary: "Checked .brain/decided/DEC-001.md and src/quarantine.ts cleanly.",
        evidence_ref: `sha256:${fullSha256}`,
      });
      writeObservedFixture(brainDir, {
        claim_id: "OBS-legit-env-sha-ref",
        env: "staging",
        git_sha: fullSha40,
        observed_at_utc: "2026-11-25T07:04:00Z",
        ttl_seconds: 3600,
        issuer: "git-hook",
        roles: ["builder"],
        summary: "Minified staging verification passed cleanly.",
        evidence_ref: `staging@${fullSha40}`,
        minified: true,
      });

      writeScarsFixture(brainDir, [
        {
          scar_id: "SCAR-legit-path",
          created_at_utc: "2026-11-24T00:00:00Z",
          expires_at_utc: "2026-12-20T00:00:00Z",
          regression_test: "tests/golden/eval-4-quarantine.test.ts#L340",
          roles: ["builder"],
          hint: `Keep UUID ${uuidV4} allowlisted and trace checks in src/compiler.ts.`,
        },
      ]);

      const now = new Date("2026-11-25T07:30:00Z");
      const compiled = compileContext({
        role: "builder",
        env: "staging",
        gitSha: fullSha40,
        brainDir,
        repoRoot: root,
        now,
      });
      expect(compiled.zone_a).toContain(uuidV4);
      expect(compiled.zone_b).toContain("OBS-legit-commit-ref");
      expect(compiled.zone_b).toContain("OBS-legit-sha256-ref");
      expect(compiled.zone_b).toContain("OBS-legit-env-sha-ref");
      expect(compiled.zone_b).toContain("SCAR-legit-path");

      const evalRes = evaluateBrain({ brainDir, repoRoot: root, now });
      expect(evalRes.ok).toBe(true);
      expect(evalRes.exitCode).toBe(EXIT_OK);
    }

    // B. sha256:<64hex> in DECIDED prose body MUST be blocked (exit 2)
    {
      const { root, brainDir } = tracker.create("vb-ge4-p1-dec-");
      writeDecidedFixture(brainDir, {
        id: "DEC-PROSE-HASH",
        priority: "P0",
        roles: ["builder"],
        body: `Smuggled hex blob disguised as sha256:${fullSha256} inside prose.`,
      });
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
      expect(res.stderr).toContain("rule: high_entropy_secret");
    }

    // C. commit/<40hex> and staging@<40hex> in OBSERVED summary prose MUST be blocked (exit 2)
    for (const smuggled of [`commit/${fullSha40}`, `staging@${fullSha40}`]) {
      const { root, brainDir } = tracker.create("vb-ge4-p1-obs-");
      writeObservedFixture(brainDir, {
        claim_id: "OBS-prose-smuggle",
        env: "staging",
        git_sha: "abcdef1234",
        observed_at_utc: "2026-11-25T07:00:00Z",
        ttl_seconds: 3600,
        issuer: "ci",
        roles: ["builder"],
        summary: `Smuggled high-entropy hex via ${smuggled} in summary prose.`,
        evidence_ref: "ci:run/p1-1",
      });
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
      expect(res.stderr).toContain("rule: high_entropy_secret");
    }

    // D. sha256:<64hex> in scars.md hint prose MUST be blocked (exit 2)
    {
      const { root, brainDir } = tracker.create("vb-ge4-p1-scar-");
      writeScarsFixture(brainDir, [
        {
          scar_id: "SCAR-PROSE-HASH",
          created_at_utc: "2026-11-24T00:00:00Z",
          expires_at_utc: "2026-12-20T00:00:00Z",
          regression_test: "tests/golden/eval-4-quarantine.test.ts#L1",
          hint: `Do not smuggle sha256:${fullSha256} inside scar prose.`,
        },
      ]);
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
      expect(res.stderr).toContain("rule: high_entropy_secret");
    }
  });
});
