import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { normalizeLf } from "../normalize.js";
import { scanAllTextForQuarantine } from "../quarantine.js";
import { defaultQuarantineConfig, loadBrainConfig, resolveBrainPaths } from "../schema.js";
import {
  EXIT_ERROR,
  type LintTextMatch,
  type LintTextOptions,
  type LintTextResult,
  type QuarantineConfig,
  type QuarantineRuleId,
  VeriBrainError,
} from "../types.js";

function explainQuarantineRule(rule: QuarantineRuleId): { detail: string; fix: string } {
  switch (rule) {
    case "gcp_api_key":
      return {
        detail: "Matched GCP API key pattern (AIza..., raw value redacted).",
        fix: "Remove the API key or replace with a placeholder like <GCP_API_KEY>.",
      };
    case "jwt":
      return {
        detail: "Matched 3-part JWT token pattern (ey..., raw value redacted).",
        fix: "Remove the JWT token or replace with <JWT_TOKEN>.",
      };
    case "bearer":
      return {
        detail: "Matched Authorization/Bearer credential pattern (raw value redacted).",
        fix: "Avoid literal 'Bearer <token>' examples in prose; describe auth headers abstractly.",
      };
    case "pem_private":
      return {
        detail: "Matched PEM private key header (raw value redacted).",
        fix: "Never store private key material in prose or .brain/ files.",
      };
    case "provider_token":
      return {
        detail: "Matched provider API token pattern (sk-/ghp_/AKIA/xox..., raw value redacted).",
        fix: "Remove the token or describe secret prefixes without sample payloads.",
      };
    case "oauth_kv":
      return {
        detail:
          "Matched credential key/value assignment (api_key/client_secret/token, raw value redacted).",
        fix: "Avoid 'secret_key=...' or 'api_key: ...' literal assignments in prose.",
      };
    case "pii_email":
      return {
        detail: "Matched non-whitelisted email address (raw value redacted).",
        fix: "Remove email PII or whitelist approved addresses/domains in .brain/config.json.",
      };
    case "pii_phone":
      return {
        detail: "Matched non-whitelisted phone number pattern (raw value redacted).",
        fix: "Remove phone PII or whitelist approved numbers in .brain/config.json.",
      };
    case "high_entropy_secret":
      return {
        detail: "Matched >= 32-char high-entropy token (raw value redacted).",
        fix: "Remove raw secrets/hashes or move commit/sha256 refs into OBSERVED evidence_ref.",
      };
  }
}

export function lintTextFile(options: LintTextOptions): LintTextResult {
  const { brainDir, repoRoot } = resolveBrainPaths(options.brainDir, options.repoRoot);
  const targetPath = path.isAbsolute(options.filePath)
    ? path.resolve(options.filePath)
    : path.resolve(repoRoot, options.filePath);

  if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "lint-text",
      rule: "file_not_found",
      detail: `Target file not found: ${targetPath}.`,
      fix: "Pass a readable text or markdown file to veribrain lint-text <file>.",
    });
  }

  let quarantineConfig: QuarantineConfig = defaultQuarantineConfig();
  if (existsSync(path.join(brainDir, "config.json"))) {
    quarantineConfig = loadBrainConfig(brainDir).quarantine;
  }

  const raw = readFileSync(targetPath, "utf8");
  const lines = normalizeLf(raw).split("\n");
  const allowlistedLineTokens = new Map<number, Set<string>>();
  if ((lines[0] ?? "").trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.trim() === "---") {
        break;
      }
      const m = /^\s*sha256_body\s*:\s*["']?([0-9a-f]{64})["']?\s*$/i.exec(line);
      if (m?.[1]) {
        allowlistedLineTokens.set(i + 1, new Set([m[1].toLowerCase()]));
      }
    }
  }

  const fileName = path.basename(targetPath);
  const violations = scanAllTextForQuarantine(raw, {
    claimId: fileName,
    config: quarantineConfig,
    allowlistedLineTokens,
  });

  const matches: LintTextMatch[] = violations.map((v) => {
    const explanation = explainQuarantineRule(v.rule);
    return {
      line: v.line,
      rule: v.rule,
      detail: explanation.detail,
      fix: explanation.fix,
    };
  });

  return {
    file: targetPath,
    clean: matches.length === 0,
    matchCount: matches.length,
    matches,
  };
}
