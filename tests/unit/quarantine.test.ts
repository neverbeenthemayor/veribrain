import { describe, expect, it } from "vitest";
import {
  assertQuarantineClean,
  createQuarantineError,
  isSafeHostnameToken,
  sanitizeQuarantineClaimId,
  sanitizeQuarantineField,
  scanAllTextForQuarantine,
  scanTextForQuarantine,
  shannonEntropy,
} from "../../src/quarantine.js";
import { EXIT_QUARANTINE_VIOLATION, VeriBrainError } from "../../src/types.js";

describe("quarantine scrubber", () => {
  it("blocks all secret regex classes without echoing raw secrets and gives secret-specific fix copy", () => {
    const cases: Array<{ name: string; text: string; expectedRule: string; secretToken: string }> =
      [
        {
          name: "gcp_api_key",
          text: "key=AIzaSyDummyKeyValue1234567890abcdef",
          expectedRule: "gcp_api_key",
          secretToken: "AIzaSyDummyKeyValue1234567890abcdef",
        },
        {
          name: "jwt",
          text: "tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
          expectedRule: "jwt",
          secretToken: "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        },
        {
          name: "jwt_ey_generic",
          text: "tok ey12345678.ey87654321.sig12345678",
          expectedRule: "jwt",
          secretToken: "sig12345678",
        },
        {
          name: "bearer",
          text: "Authorization: Bearer secret_token_value_98765",
          expectedRule: "bearer",
          secretToken: "secret_token_value_98765",
        },
        {
          name: "pem_private",
          text: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
          expectedRule: "pem_private",
          secretToken: "BEGIN RSA PRIVATE KEY",
        },
        {
          name: "provider_sk",
          text: "openai=sk-proj-1234567890abcdefghijklmnop",
          expectedRule: "provider_token",
          secretToken: "sk-proj-1234567890abcdefghijklmnop",
        },
        {
          name: "provider_ghp",
          text: "token ghp_1234567890abcdefghijklmnopQRSTUV",
          expectedRule: "provider_token",
          secretToken: "ghp_1234567890abcdefghijklmnopQRSTUV",
        },
        {
          name: "provider_github_pat",
          text: "pat github_pat_11ABCDEFG0123456789_abcdefghijk",
          expectedRule: "provider_token",
          secretToken: "github_pat_11ABCDEFG0123456789_abcdefghijk",
        },
        {
          name: "provider_slack",
          text: "slack xoxb-1234567890-1234567890-abcdef123456",
          expectedRule: "provider_token",
          secretToken: "xoxb-1234567890-1234567890-abcdef123456",
        },
        {
          name: "provider_aws",
          text: "aws AKIAIOSFODNN7EXAMPLE here",
          expectedRule: "provider_token",
          secretToken: "AKIAIOSFODNN7EXAMPLE",
        },
        {
          name: "provider_ya29",
          text: "google ya29.a0AfH6SMC_fake_access_token_123456",
          expectedRule: "provider_token",
          secretToken: "ya29.a0AfH6SMC_fake_access_token_123456",
        },
        {
          name: "provider_gocspx",
          text: "oauth GOCSPX-fakeClientSecret12345678",
          expectedRule: "provider_token",
          secretToken: "GOCSPX-fakeClientSecret12345678",
        },
        {
          name: "oauth_kv_json",
          text: '{"client_secret": "super_secret_oauth_val"}',
          expectedRule: "oauth_kv",
          secretToken: "super_secret_oauth_val",
        },
        {
          name: "oauth_kv_camel",
          text: 'apiKey: "camel_case_secret_12345"',
          expectedRule: "oauth_kv",
          secretToken: "camel_case_secret_12345",
        },
      ];

    for (const tc of cases) {
      const violation = scanTextForQuarantine(tc.text, { claimId: `OBS-${tc.name}` });
      expect(violation, tc.name).not.toBeNull();
      expect(violation?.rule, tc.name).toBe(tc.expectedRule);

      if (violation) {
        const err = createQuarantineError(violation);
        expect(err.exitCode).toBe(EXIT_QUARANTINE_VIOLATION);
        expect(err.message).not.toContain(tc.secretToken);
        expect(err.detail).not.toContain(tc.secretToken);
        expect(err.fix).not.toContain(tc.secretToken);
        expect(err.fix).not.toContain("whitelist");
        expect(err.fix).toContain("veribrain eval --strict");
      }
    }
  });

  it("blocks NFKC, zero-width, soft-hyphen, and Unicode Tag reassembly bypasses", () => {
    expect(
      scanTextForQuarantine("AIza\u200BSyDummyKeyValue1234567890abcdef", { claimId: "OBS-zw" })
        ?.rule,
    ).toBe("gcp_api_key");
    expect(
      scanTextForQuarantine("AIza\u00ADSyDummyKeyValue1234567890abcdef", { claimId: "OBS-shy" })
        ?.rule,
    ).toBe("gcp_api_key");
    expect(
      scanTextForQuarantine("\uFF21\uFF29\uFF5A\uFF41SyDummyKeyValue1234567890abcdef", {
        claimId: "OBS-fw",
      })?.rule,
    ).toBe("gcp_api_key");
    expect(
      scanTextForQuarantine(`AIza${String.fromCodePoint(0xe0001)}SyDummyKeyValue1234567890abcdef`, {
        claimId: "OBS-tag",
      })?.rule,
    ).toBe("gcp_api_key");
  });

  it("blocks hyphen/underscore-prefixed secrets (RT-EVA-17/18/20) without false-positiving on task-/desk- words", () => {
    expect(scanTextForQuarantine("OBS-AKIAIOSFODNN7EXAMPLE", { claimId: "OBS-pref-1" })?.rule).toBe(
      "provider_token",
    );
    expect(scanTextForQuarantine("DEC-AKIAIOSFODNN7EXAMPLE", { claimId: "DEC-pref-2" })?.rule).toBe(
      "provider_token",
    );
    expect(
      scanTextForQuarantine("DEC-AIzaSyDummyKeyValue1234567890", { claimId: "DEC-pref-3" })?.rule,
    ).toBe("gcp_api_key");
    expect(
      scanTextForQuarantine("HYP-ghp_1234567890abcdefghijklmnop", { claimId: "HYP-pref-4" })?.rule,
    ).toBe("provider_token");
    expect(
      scanTextForQuarantine("prefix_sk-proj-1234567890abcdefghijklmnop", { claimId: "OBS-pref-5" })
        ?.rule,
    ).toBe("provider_token");
    expect(
      scanTextForQuarantine(
        "OBS-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV",
        { claimId: "OBS-pref-6" },
      )?.rule,
    ).toBe("jwt");

    // Non-false-positive on normal English prefixes ending in 'sk-'
    expect(
      scanTextForQuarantine("task-1234567890abcdef and desk-1234567890abcdef", {
        claimId: "OBS-safe-word",
      }),
    ).toBeNull();

    // Redaction on prefixed AWS claim_id and secret field names (RT-EVA-04)
    expect(sanitizeQuarantineClaimId("OBS-AKIAIOSFODNN7EXAMPLE")).toBe("<redacted-claim-id>");
    expect(sanitizeQuarantineField("AIzaSyDummyKeyValue1234567890abcdef")).toBe("<redacted-field>");
    expect(sanitizeQuarantineField("AKIAIOSFODNN7EXAMPLE")).toBe("<redacted-field>");
    expect(sanitizeQuarantineField("json_object_key")).toBe("json_object_key");

    const fieldErr = createQuarantineError({
      claimId: "OBS-clean-1",
      rule: "gcp_api_key",
      line: 1,
      field: "AIzaSyDummyKeyValue1234567890abcdef",
    });
    expect(fieldErr.detail).toContain("field=<redacted-field>");
    expect(fieldErr.detail).not.toContain("AIza");
    expect(fieldErr.message).not.toContain("AIza");
  });

  it("redacts untrusted or poisoned claim_id on Exit 2", () => {
    const poisonedId = "OBS-AIzaSySecretKeyInsideClaimId12345";
    expect(sanitizeQuarantineClaimId(poisonedId)).toBe("<redacted-claim-id>");
    expect(sanitizeQuarantineClaimId("OBS-valid", "claim_id")).toBe("<redacted-claim-id>");
    expect(sanitizeQuarantineClaimId("bad/path/secret")).toBe("<redacted-claim-id>");
    expect(sanitizeQuarantineClaimId("OBS-clean-1")).toBe("OBS-clean-1");

    const err = createQuarantineError({
      claimId: poisonedId,
      rule: "gcp_api_key",
      line: 1,
      field: "claim_id",
    });
    expect(err.claimId).toBe("<redacted-claim-id>");
    expect(err.message).not.toContain("AIza");
  });

  it("allows benign Bearer prose while flagging real Bearer tokens", () => {
    expect(
      scanTextForQuarantine("Never log Bearer authentication headers.", { claimId: "OBS-prose" }),
    ).toBeNull();
    expect(
      scanTextForQuarantine("Use Bearer tok_9876543210abc", { claimId: "OBS-tok" })?.rule,
    ).toBe("bearer");
  });

  it("blocks PII emails and phones with PII-specific remediation copy and honors exact lowercase whitelist", () => {
    const piiViolation = scanTextForQuarantine("Contact alice@example.com.", {
      claimId: "OBS-pii-1",
    });
    expect(piiViolation?.rule).toBe("pii_email");
    if (piiViolation) {
      const piiErr = createQuarantineError(piiViolation);
      expect(piiErr.fix).toContain(".brain/config.json");
      expect(piiErr.fix).toContain("veribrain eval --strict");
    }

    expect(
      scanTextForQuarantine("Call +1-415-555-2671 or (415) 555-2671 or 415-555-2671.", {
        claimId: "OBS-pii-2",
      })?.rule,
    ).toBe("pii_phone");

    const whitelist = {
      allowed_emails: ["alice@example.com"],
      allowed_domains: ["allowed.org"],
      allowed_phones: ["+1-415-555-0100"],
    };
    expect(
      scanTextForQuarantine("Owner ALICE@EXAMPLE.COM, team ops@allowed.org, desk +1-415-555-0100", {
        claimId: "OBS-pii-3",
        config: whitelist,
      }),
    ).toBeNull();

    // Non-whitelisted subdomain does not bypass exact domain whitelist
    expect(
      scanTextForQuarantine("leak@sub.allowed.org", { claimId: "OBS-pii-4", config: whitelist })
        ?.rule,
    ).toBe("pii_email");

    // Never triggers on ISO dates, semver, IPv4, or short citations
    expect(
      scanTextForQuarantine(
        "Date 2026-11-28T09:00:00Z, node 24.13.1, host 127.0.0.1, Based on: OBS-1 (staging@abc1234)",
        { claimId: "OBS-safe-1" },
      ),
    ).toBeNull();
  });

  it("blocks high-entropy secrets, fake repo path smuggling, and scopes hash-ref exemptions to evidence_ref/hash fields", () => {
    const highEntropyMixed = "K9mP2xQ7vL4nR8wT1yB6zC3fH5jD0sA2E8uG4qW9";
    const highEntropyHex = "0123456789abcdef9876543210fedcba";
    expect(shannonEntropy(highEntropyMixed)).toBeGreaterThanOrEqual(4.5);
    expect(shannonEntropy(highEntropyHex)).toBeGreaterThanOrEqual(3.5);

    expect(
      scanTextForQuarantine(`a=1&secret=${highEntropyMixed}&b=2`, { claimId: "OBS-ent-1" })?.rule,
    ).toBe("high_entropy_secret");
    expect(scanTextForQuarantine(`raw_hex ${highEntropyHex}`, { claimId: "OBS-ent-2" })?.rule).toBe(
      "high_entropy_secret",
    );

    // Fake repo paths smuggling secrets MUST be blocked
    expect(
      scanTextForQuarantine("aB3dE5fG7hI9jK1lM3nO5p/qR7sT9uV1wX3yZ5aB7cD9", {
        claimId: "OBS-ent-3",
      })?.rule,
    ).toBe("high_entropy_secret");
    expect(
      scanTextForQuarantine("src/K9mP2xQ7vL4nR8wT1yB6zC3fH5jD.ts", {
        claimId: "OBS-ent-4",
      })?.rule,
    ).toBe("high_entropy_secret");
    expect(
      scanTextForQuarantine("src/aB3dE5fG7hI9jK1lM3nO5p-a/qR7sT9uV1wX3yZ5aB7cD9.ts", {
        claimId: "OBS-ent-5",
      })?.rule,
    ).toBe("high_entropy_secret");

    // Hash refs allowed ONLY in evidence_ref/hash fields, NOT free-text prose
    const digestRef = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const commitRef = "commit/0123456789abcdef0123456789abcdef01234567";
    const envShaRef = "staging@0123456789abcdef0123456789abcdef01234567";
    expect(
      scanTextForQuarantine(digestRef, { claimId: "OBS-ev-1", field: "evidence_ref" }),
    ).toBeNull();
    expect(
      scanTextForQuarantine(commitRef, { claimId: "OBS-ev-2", field: "evidence_ref" }),
    ).toBeNull();
    expect(
      scanTextForQuarantine(envShaRef, { claimId: "OBS-ev-3", field: "evidence_ref" }),
    ).toBeNull();
    expect(
      scanTextForQuarantine(`Leaked ${digestRef} in prose`, {
        claimId: "OBS-prose-1",
        field: "summary",
      })?.rule,
    ).toBe("high_entropy_secret");
    expect(
      scanTextForQuarantine(`Leaked ${commitRef} in hint`, {
        claimId: "SCAR-1",
        field: "hint",
      })?.rule,
    ).toBe("high_entropy_secret");
    expect(
      scanTextForQuarantine(`Leaked ${envShaRef} in summary`, {
        claimId: "OBS-prose-2",
        field: "summary",
      })?.rule,
    ).toBe("high_entropy_secret");

    // Legitimate UUIDs and real repo paths remain clean in prose
    const safeRefs = [
      "uuid 550e8400-e29b-41d4-a716-446655440000",
      "path tests/golden/zone_a_prefix_determinism.test.ts#L42",
      "doc docs/RFC-001-veribrain-architecture.md",
    ].join("\n");
    expect(scanTextForQuarantine(safeRefs, { claimId: "OBS-safe-2" })).toBeNull();

    expect(() =>
      assertQuarantineClean(`tok ${highEntropyMixed}`, { claimId: "OBS-ent-6" }),
    ).toThrow(VeriBrainError);
  });

  it("allows clean 50+ char HTTPS hostnames in isSafeHostnameToken while failing closed on embedded secrets, auth, queries, or high-entropy labels", () => {
    const cleanUrls = [
      "https://app-staging--proj-prod.us-central1.hosted.app",
      "https://web-staging--my-company-platform-prod.us-central1.hosted.app/api/v1/health",
      "https://console.cloud.google.com/run/detail/us-central1/my-service-name",
      "http://staging-api.internal-service.example.org:8443/v2/status",
    ];
    for (const url of cleanUrls) {
      expect(isSafeHostnameToken(url), url).toBe(true);
      expect(
        scanTextForQuarantine(`Deploy URL: ${url}`, { claimId: "DEC-url-ok" }),
        url,
      ).toBeNull();
    }

    const unsafeUrls = [
      "https://user:pass@app-staging--proj-prod.us-central1.hosted.app",
      "https://app-staging--proj-prod.us-central1.hosted.app/api?token=K9mP2xQ7vL4nR8wT1yB6zC3fH5jD0sA2",
      "https://K9mP2xQ7vL4nR8wT1yB6zC3fH5jD0sA2.evil.com",
      "https://a1b2c3d4e5f678901234567890abcdef.evil.com",
      "https://AIzaSyDummyKeyValue1234567890abcdef.evil.com",
      "https://ghp_1234567890abcdefghijklmnopQRSTUV.evil.com",
      "https://sk-proj-1234567890abcdefghijklmnop.evil.com",
      "https://AKIAIOSFODNN7EXAMPLE.evil.com",
      "https://xoxb-1234567890-1234567890-abcdef123456.evil.com",
      "https://eyJhbGciOiJIUzI1NiJ9.evil.com",
      "https://api.example.com/v1/keys/K9mP2xQ7vL4nR8wT1yB6zC3fH5jD0sA2",
      "https://github.com/org/repo/commit/0123456789abcdef0123456789abcdef01234567",
    ];
    for (const bad of unsafeUrls) {
      expect(isSafeHostnameToken(bad), bad).toBe(false);
    }

    // Verify full prose scan catches mixed-case subdomain secret AND query token AND hex path
    expect(
      scanTextForQuarantine("https://K9mP2xQ7vL4nR8wT1yB6zC3fH5jD0sA2.evil.com", {
        claimId: "DEC-sub-ent",
      })?.rule,
    ).toBe("high_entropy_secret");
    expect(
      scanTextForQuarantine(
        "https://app-staging--proj-prod.us-central1.hosted.app/api?token=K9mP2xQ7vL4nR8wT1yB6zC3fH5jD0sA2",
        { claimId: "DEC-q-tok" },
      )?.rule,
    ).toBe("high_entropy_secret");

    // scanAllTextForQuarantine reports all lines/rules cleanly
    const multi = [
      "Line 1 clean: https://app-staging--proj-prod.us-central1.hosted.app",
      "Line 2 email: leak@example.com",
      "Line 3 gcp: AIzaSyDummyKeyValue1234567890abcdef",
      "Line 4 entropy: K9mP2xQ7vL4nR8wT1yB6zC3fH5jD0sA2E8uG4qW9",
    ].join("\n");
    const all = scanAllTextForQuarantine(multi, { claimId: "draft.md" });
    expect(all.map((v) => ({ line: v.line, rule: v.rule }))).toEqual([
      { line: 2, rule: "pii_email" },
      { line: 3, rule: "gcp_api_key" },
      { line: 4, rule: "high_entropy_secret" },
    ]);
  });
});
