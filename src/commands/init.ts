import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computeDecidedBodyHash } from "../normalize.js";
import { assertQuarantineClean } from "../quarantine.js";
import { hasControlOrBidiChars } from "../sanitize.js";
import {
  defaultBrainConfig,
  hasForbiddenSignerSyntax,
  invalidateFileReadCache,
  isAgentEnvironment,
  isAgentSigner,
  resolveBrainPaths,
} from "../schema.js";
import {
  EXIT_PROVENANCE_VIOLATION,
  type InitOptions,
  type InitResult,
  VeriBrainError,
} from "../types.js";

const DEFAULT_SCARS_HEADER = [
  "# VeriBrain Scars (Max 4,096 B, TTL <= 30d)",
  "",
  "<!-- Add entries as:",
  "## SCAR-001",
  "- created_at_utc: 2026-11-28T09:00:00Z",
  "- expires_at_utc: 2026-12-28T09:00:00Z",
  "- regression_test: tests/unit/example.test.ts#L1",
  "- hint: Single factual anti-pattern.",
  "-->",
  "",
].join("\n");

const STARTER_DEC_001_BODY =
  "All multi-agent context compiles deterministically with fail-closed provenance. Agents emit HYPOTHESIS only and never self-attest DECIDED or OBSERVED records.";

export function initBrain(options: InitOptions = {}): InitResult {
  const { brainDir } = resolveBrainPaths(options.brainDir, options.repoRoot, {
    allowWorktreeFallback: false,
  });
  const rawSignedBy = options.signedBy;

  let signedBy: string | undefined;
  if (rawSignedBy !== undefined) {
    if (isAgentEnvironment(options.envVars ?? process.env)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "DEC-001",
        rule: "agent_self_attestation_denied",
        detail: "Agents cannot sign DECIDED records via init --signed-by.",
        fix: "Run veribrain init without --signed-by, or have a human run init --signed-by.",
      });
    }
    if (hasControlOrBidiChars(rawSignedBy) || hasForbiddenSignerSyntax(rawSignedBy)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "DEC-001",
        rule: "invalid_signed_by",
        detail: "--signed-by cannot contain control chars, newlines, or colons.",
        fix: 'Run veribrain init --signed-by "Human Owner" using plain ASCII text.',
      });
    }
    const trimmed = rawSignedBy.trim();
    if (!trimmed || isAgentSigner(trimmed)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "DEC-001",
        rule: "agent_signed_decided",
        detail: "--signed-by must be a non-agent human owner name.",
        fix: 'Run veribrain init --signed-by "Human Owner" or omit --signed-by.',
      });
    }
    assertQuarantineClean(trimmed, { claimId: "DEC-001", field: "signed_by" });
    signedBy = trimmed;
  }

  const created: string[] = [];
  const skipped: string[] = [];

  for (const dir of [
    brainDir,
    path.join(brainDir, "decided"),
    path.join(brainDir, "observed"),
    path.join(brainDir, "hypotheses"),
  ]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const configPath = path.join(brainDir, "config.json");
  if (!existsSync(configPath)) {
    const configJson = `${JSON.stringify(defaultBrainConfig(), null, 2)}\n`;
    writeFileSync(configPath, configJson, "utf8");
    invalidateFileReadCache(configPath);
    created.push("config.json");
  } else {
    skipped.push("config.json");
  }

  const scarsPath = path.join(brainDir, "scars.md");
  if (!existsSync(scarsPath)) {
    writeFileSync(scarsPath, DEFAULT_SCARS_HEADER, "utf8");
    invalidateFileReadCache(scarsPath);
    created.push("scars.md");
  } else {
    skipped.push("scars.md");
  }

  if (signedBy) {
    const decPath = path.join(brainDir, "decided", "DEC-001-veribrain-baseline.md");
    if (!existsSync(decPath)) {
      const nowIso = (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
      const sha256Body = computeDecidedBodyHash(STARTER_DEC_001_BODY);
      const decContent = [
        "---",
        "id: DEC-001",
        "priority: P0",
        'roles: ["*", builder, cqe, security, cude, cie, cfoe]',
        `signed_by: ${signedBy}`,
        `signed_at_utc: ${nowIso}`,
        `sha256_body: ${sha256Body}`,
        "status: active",
        "---",
        STARTER_DEC_001_BODY,
        "",
      ].join("\n");
      writeFileSync(decPath, decContent, "utf8");
      invalidateFileReadCache(decPath);
      created.push("decided/DEC-001-veribrain-baseline.md");
    } else {
      skipped.push("decided/DEC-001-veribrain-baseline.md");
    }
  }

  return { brainDir, created, skipped };
}
