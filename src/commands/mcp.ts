import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { compareAscii, normalizeLf } from "../normalize.js";
import { assertQuarantineClean, scanTextForQuarantine } from "../quarantine.js";
import {
  hasControlOrBidiChars,
  isValidRepoRelativeTestRef,
  renderUntrustedHint,
  stripControlAndBidiChars,
} from "../sanitize.js";
import {
  defaultQuarantineConfig,
  INVALID_ENV_FIX_HINT,
  invalidateFileReadCache,
  isValidEnv,
  loadBrain,
  loadBrainConfig,
  parseHypothesisFile,
  parseIsoTimestampMs,
  parseObservedFile,
  parseScarsFile,
  regressionTestFileExists,
  resolveBrainPaths,
} from "../schema.js";
import {
  type DecidedStatus,
  type EnvName,
  EXIT_ERROR,
  EXIT_PROVENANCE_VIOLATION,
  EXIT_QUARANTINE_VIOLATION,
  type HypothesisRecord,
  MAX_SCARS_BYTES,
  type Priority,
  type QuarantineConfig,
  VeriBrainError,
} from "../types.js";
import { evaluateBrain } from "./eval.js";

export const VALID_MCP_CLIENTS = ["antigravity", "claude-code", "cursor", "codex"] as const;
export type McpClientName = (typeof VALID_MCP_CLIENTS)[number];

const HYP_ID_STRICT_RE = /^HYP-[A-Za-z0-9._-]{1,60}$/;
const CLAIM_ID_LOOKUP_RE = /^(?:DEC|OBS|SCAR|HYP)-[A-Za-z0-9._-]{1,64}$/;
const VALID_ROLE_TOKEN_RE = /^(?:\*|[A-Za-z0-9._-]{1,64})$/;
const MAX_HYPOTHESIS_HINT_BYTES = 4096;
const MAX_ROLES_COUNT = 32;

export interface PrintMcpConfigOptions {
  brainDir?: string;
  repoRoot?: string;
}

export function isValidMcpClient(value: string): value is McpClientName {
  return (VALID_MCP_CLIENTS as readonly string[]).includes(value);
}

function escapeTomlString(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === '"') {
      out += '\\"';
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp < 0x20 || cp === 0x7f) {
        out += `\\u${cp.toString(16).padStart(4, "0")}`;
      } else {
        out += ch;
      }
    }
  }
  return out;
}

export function printMcpClientConfig(client: string, options: PrintMcpConfigOptions = {}): string {
  const normalized = client.trim().toLowerCase();
  if (!isValidMcpClient(normalized)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "mcp",
      rule: "invalid_mcp_client",
      detail: "Unsupported MCP client. Expected one of: antigravity, claude-code, cursor, codex.",
      fix: "Pass --print-config antigravity|claude-code|cursor|codex.",
    });
  }

  const brainDirArg = options.brainDir?.trim() || ".brain";
  const repoRootArg = options.repoRoot?.trim() || ".";
  const args = ["-y", "veribrain", "mcp", "--brain-dir", brainDirArg, "--repo-root", repoRootArg];

  if (normalized === "codex") {
    const tomlArgs = args.map((arg) => `"${escapeTomlString(arg)}"`).join(", ");
    return ["[mcp_servers.veribrain]", 'command = "npx"', `args = [${tomlArgs}]`, ""].join("\n");
  }

  const jsonPayload = {
    mcpServers: {
      veribrain: {
        command: "npx",
        args,
      },
    },
  };
  return `${JSON.stringify(jsonPayload, null, 2)}\n`;
}

function loadQuarantineConfigOrDefault(brainDir: string): QuarantineConfig {
  if (existsSync(path.join(brainDir, "config.json"))) {
    return loadBrainConfig(brainDir).quarantine;
  }
  return defaultQuarantineConfig();
}

function assertConfinementInsideHypotheses(
  brainDir: string,
  fileName: string,
): {
  hypothesesDir: string;
  finalPath: string;
} {
  const resolvedBrainDir = path.resolve(brainDir);
  const hypothesesDir = path.resolve(resolvedBrainDir, "hypotheses");
  if (!existsSync(hypothesesDir)) {
    mkdirSync(hypothesesDir, { recursive: true });
  }
  const realBrain = realpathSync(resolvedBrainDir);
  const realHypDir = realpathSync(hypothesesDir);
  const isWin = process.platform === "win32";
  const expectedHyp = path.join(realBrain, "hypotheses");
  const cmpExpected = isWin ? expectedHyp.toLowerCase() : expectedHyp;
  const cmpHyp = isWin ? realHypDir.toLowerCase() : realHypDir;
  if (cmpHyp !== cmpExpected) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "hypotheses",
      rule: "path_confinement_violation",
      detail: ".brain/hypotheses/ must be the real directory inside .brain/ (symlinks denied).",
      fix: "Replace symlinked .brain/hypotheses with a local directory.",
    });
  }

  const finalPath = path.resolve(realHypDir, fileName);
  if (path.dirname(finalPath) !== realHypDir || path.basename(finalPath) !== fileName) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "hypotheses",
      rule: "path_confinement_violation",
      detail: "Hypothesis write path must stay strictly inside .brain/hypotheses/.",
      fix: "Use a plain HYP-* identifier without path separators.",
    });
  }
  return { hypothesesDir: realHypDir, finalPath };
}

function atomicWriteJson(dir: string, finalPath: string, id: string, serialized: string): void {
  const tmpName = `.tmp-${id}-${process.pid}-${randomBytes(6).toString("hex")}.json`;
  const tmpPath = path.join(dir, tmpName);
  try {
    writeFileSync(tmpPath, serialized, { encoding: "utf8", flag: "wx" });
    renameSync(tmpPath, finalPath);
    invalidateFileReadCache(finalPath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Best-effort cleanup of temp file.
      }
    }
    throw err;
  }
}

export interface RecordHypothesisOptions {
  hint: string;
  roles?: string[];
  ttlDays?: number;
  id?: string;
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
}

export interface RecordHypothesisResult {
  record: HypothesisRecord;
  filePath: string;
  rendered_hint: string;
}

export function recordHypothesis(options: RecordHypothesisOptions): RecordHypothesisResult {
  const { brainDir } = resolveBrainPaths(options.brainDir, options.repoRoot, {
    allowWorktreeFallback: false,
  });
  const quarantineConfig = loadQuarantineConfigOrDefault(brainDir);
  const now = options.now ?? new Date();
  const dateSlug = now.toISOString().slice(0, 10);

  let id: string;
  if (options.id !== undefined) {
    const rawId = options.id.trim();
    assertQuarantineClean(rawId, {
      claimId: rawId,
      field: "claim_id",
      config: quarantineConfig,
      allowHashRefExemption: false,
    });
    if (
      !HYP_ID_STRICT_RE.test(rawId) ||
      rawId.includes("..") ||
      rawId.includes("/") ||
      rawId.includes("\\")
    ) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "hypotheses",
        rule: "invalid_hypothesis_id",
        detail: "Hypothesis id must match ^HYP-[A-Za-z0-9._-]{1,60}$ with no path traversal.",
        fix: "Omit id to auto-generate or pass a safe HYP-* identifier (<= 64 chars).",
      });
    }
    id = rawId;
  } else {
    id = `HYP-${dateSlug}-${randomBytes(3).toString("hex")}`;
  }

  const ttlDays = options.ttlDays ?? 7;
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 7) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: id,
      rule: "hypothesis_ttl_exceeded",
      detail: "Hypothesis ttl_days must be an integer between 1 and 7.",
      fix: "Pass ttl_days in range 1..7.",
    });
  }

  const hint = options.hint.trim();
  if (hint.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "missing_hint",
      detail: "Hypothesis hint must be a non-empty string.",
      fix: "Provide a concise factual hint.",
    });
  }
  if (Buffer.byteLength(hint, "utf8") > MAX_HYPOTHESIS_HINT_BYTES) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "hint_size_limit_exceeded",
      detail: `Hypothesis hint exceeds ${MAX_HYPOTHESIS_HINT_BYTES} UTF-8 bytes.`,
      fix: `Shorten hint to <= ${MAX_HYPOTHESIS_HINT_BYTES} UTF-8 bytes.`,
    });
  }

  if (options.roles !== undefined && options.roles.length > MAX_ROLES_COUNT) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "roles_limit_exceeded",
      detail: `Hypothesis roles cannot exceed ${MAX_ROLES_COUNT} entries.`,
      fix: `Specify at most ${MAX_ROLES_COUNT} role identifiers.`,
    });
  }
  const roles = (options.roles ?? ["*"]).map((r) => r.trim()).filter((r) => r.length > 0);
  if (roles.length === 0 || !roles.every((r) => VALID_ROLE_TOKEN_RE.test(r))) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "invalid_roles",
      detail: "Hypothesis roles must be non-empty role names (<= 64 chars) or '*'.",
      fix: 'Pass roles like ["builder"] or omit roles for wildcard.',
    });
  }

  assertQuarantineClean(hint, {
    claimId: id,
    field: "hint",
    config: quarantineConfig,
    allowHashRefExemption: false,
  });
  for (const role of roles) {
    assertQuarantineClean(role, {
      claimId: id,
      field: "roles",
      config: quarantineConfig,
      allowHashRefExemption: false,
    });
  }

  const renderedHint = renderUntrustedHint({ source: "hypothesis", id, body: hint });
  assertQuarantineClean(renderedHint, {
    claimId: id,
    field: "hint",
    config: quarantineConfig,
    allowHashRefExemption: false,
  });

  const createdAtUtc = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const expiresAtUtc = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  const payload = {
    id,
    kind: "hypothesis" as const,
    issuer: "agent" as const,
    proposed_by: "agent",
    created_at_utc: createdAtUtc,
    expires_at_utc: expiresAtUtc,
    roles,
    hint,
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  assertQuarantineClean(serialized, {
    claimId: id,
    config: quarantineConfig,
    allowHashRefExemption: false,
  });

  const { hypothesesDir, finalPath } = assertConfinementInsideHypotheses(brainDir, `${id}.json`);
  atomicWriteJson(hypothesesDir, finalPath, id, serialized);

  return {
    record: {
      id,
      kind: "hypothesis",
      created_at_utc: createdAtUtc,
      expires_at_utc: expiresAtUtc,
      roles,
      proposed_by: "agent",
      hint,
      source_file: finalPath,
    },
    filePath: finalPath,
    rendered_hint: renderedHint,
  };
}

export interface ProposeScarOptions {
  hint: string;
  regressionTest: string;
  roles?: string[];
  ttlDays?: number;
  id?: string;
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
}

export interface ProposeScarResult {
  record: HypothesisRecord;
  filePath: string;
  rendered_hint: string;
  scars_bytes: number;
  scars_max_bytes: number;
  queued_for_human_review: true;
}

export function proposeScar(options: ProposeScarOptions): ProposeScarResult {
  const { brainDir, repoRoot } = resolveBrainPaths(options.brainDir, options.repoRoot, {
    allowWorktreeFallback: false,
  });
  const quarantineConfig = loadQuarantineConfigOrDefault(brainDir);
  const now = options.now ?? new Date();
  const dateSlug = now.toISOString().slice(0, 10);

  let id: string;
  if (options.id !== undefined) {
    const rawId = options.id.trim();
    assertQuarantineClean(rawId, {
      claimId: rawId,
      field: "claim_id",
      config: quarantineConfig,
      allowHashRefExemption: false,
    });
    if (
      !HYP_ID_STRICT_RE.test(rawId) ||
      rawId.includes("..") ||
      rawId.includes("/") ||
      rawId.includes("\\")
    ) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "hypotheses",
        rule: "invalid_scar_proposal_id",
        detail: "Scar proposal id must match ^HYP-[A-Za-z0-9._-]{1,60}$ with no path traversal.",
        fix: "Omit id to auto-generate or pass a safe HYP-SCAR-* identifier (<= 64 chars).",
      });
    }
    id = rawId.startsWith("HYP-SCAR-") ? rawId : `HYP-SCAR-${rawId.slice(4)}`;
    if (!HYP_ID_STRICT_RE.test(id)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "hypotheses",
        rule: "invalid_scar_proposal_id",
        detail: "Normalized HYP-SCAR-* id exceeds maximum length (64 chars).",
        fix: "Pass a shorter HYP-SCAR-* id.",
      });
    }
  } else {
    id = `HYP-SCAR-${dateSlug}-${randomBytes(3).toString("hex")}`;
  }

  const proposedTtlDays = options.ttlDays ?? 30;
  if (!Number.isInteger(proposedTtlDays) || proposedTtlDays < 1 || proposedTtlDays > 30) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: id,
      rule: "scar_ttl_exceeded",
      detail: "Proposed scar ttl_days must be an integer between 1 and 30.",
      fix: "Pass ttl_days in range 1..30.",
    });
  }

  const hint = options.hint.trim();
  if (hint.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "missing_hint",
      detail: "Scar proposal hint must be a non-empty string.",
      fix: "Provide a factual anti-pattern hint.",
    });
  }

  const regressionTest = options.regressionTest.trim();
  assertQuarantineClean(hint, {
    claimId: id,
    field: "hint",
    config: quarantineConfig,
    allowHashRefExemption: false,
  });
  assertQuarantineClean(regressionTest, {
    claimId: id,
    field: "regression_test",
    config: quarantineConfig,
    allowHashRefExemption: false,
  });

  if (!isValidRepoRelativeTestRef(regressionTest)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: id,
      rule: "invalid_scar_regression_test",
      detail: "Scar regression_test must be a safe repo-relative path.",
      fix: "Pass a repo-relative test file path such as tests/unit/compiler.test.ts#L1.",
    });
  }

  if (!regressionTestFileExists(repoRoot, regressionTest)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: id,
      rule: "missing_regression_test_file",
      detail: `Regression test file not found inside repo root (${regressionTest}).`,
      fix: "Point regression_test to an existing in-repo test file before proposing a scar.",
    });
  }

  if (options.roles !== undefined && options.roles.length > MAX_ROLES_COUNT) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "roles_limit_exceeded",
      detail: `Scar proposal roles cannot exceed ${MAX_ROLES_COUNT} entries.`,
      fix: `Specify at most ${MAX_ROLES_COUNT} role identifiers.`,
    });
  }
  const roles = (options.roles ?? ["*"]).map((r) => r.trim()).filter((r) => r.length > 0);
  if (roles.length === 0 || !roles.every((r) => VALID_ROLE_TOKEN_RE.test(r))) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "invalid_roles",
      detail: "Scar proposal roles must be non-empty role names or '*'.",
      fix: 'Pass roles like ["builder"] or omit roles for wildcard.',
    });
  }
  for (const role of roles) {
    assertQuarantineClean(role, {
      claimId: id,
      field: "roles",
      config: quarantineConfig,
      allowHashRefExemption: false,
    });
  }

  const scarsPath = path.join(brainDir, "scars.md");
  let scarsBytes = 0;
  if (existsSync(scarsPath)) {
    const rawScars = readFileSync(scarsPath, "utf8");
    assertQuarantineClean(rawScars, { claimId: "scars.md", config: quarantineConfig });
    scarsBytes = Buffer.byteLength(rawScars, "utf8");
  }

  const createdAtUtc = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const proposedScarExpIso = new Date(now.getTime() + proposedTtlDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const estimatedScarEntry = [
    "## SCAR-000",
    `- created_at_utc: ${createdAtUtc}`,
    `- expires_at_utc: ${proposedScarExpIso}`,
    `- regression_test: ${regressionTest}`,
    `- hint: ${hint}`,
    "",
  ].join("\n");
  const estimatedEntryBytes = Buffer.byteLength(estimatedScarEntry, "utf8");

  if (scarsBytes >= MAX_SCARS_BYTES || scarsBytes + estimatedEntryBytes >= MAX_SCARS_BYTES) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCARS_BUDGET_EXCEEDED",
      claimId: "scars.md",
      rule: "scars_size_limit_exceeded",
      detail: `scars.md headroom exhausted (${scarsBytes} + ~${estimatedEntryBytes} >= ${MAX_SCARS_BYTES} B).`,
      fix: "Prune expired scars in .brain/scars.md via veribrain diff before proposing new scars.",
    });
  }

  const renderedHint = renderUntrustedHint({ source: "hypothesis", id, body: hint });
  assertQuarantineClean(renderedHint, {
    claimId: id,
    field: "hint",
    config: quarantineConfig,
    allowHashRefExemption: false,
  });

  // Queue strictly as Tier 3 hypothesis with <= 7d review TTL (never mutates scars.md!)
  const reviewTtlDays = Math.min(proposedTtlDays, 7);
  const expiresAtUtc = new Date(now.getTime() + reviewTtlDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  const payload = {
    id,
    kind: "scar_proposal" as const,
    issuer: "agent" as const,
    proposed_by: "agent",
    created_at_utc: createdAtUtc,
    expires_at_utc: expiresAtUtc,
    proposed_ttl_days: proposedTtlDays,
    regression_test: regressionTest,
    roles,
    hint,
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  assertQuarantineClean(serialized, {
    claimId: id,
    config: quarantineConfig,
    allowHashRefExemption: false,
  });

  const { hypothesesDir, finalPath } = assertConfinementInsideHypotheses(brainDir, `${id}.json`);
  atomicWriteJson(hypothesesDir, finalPath, id, serialized);

  return {
    record: {
      id,
      kind: "scar_proposal",
      created_at_utc: createdAtUtc,
      expires_at_utc: expiresAtUtc,
      proposed_ttl_days: proposedTtlDays,
      regression_test: regressionTest,
      roles,
      proposed_by: "agent",
      hint,
      source_file: finalPath,
    },
    filePath: finalPath,
    rendered_hint: renderedHint,
    scars_bytes: scarsBytes,
    scars_max_bytes: MAX_SCARS_BYTES,
    queued_for_human_review: true,
  };
}

export interface GetClaimOptions {
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
}

export interface ClaimEvidenceResult {
  tier: "DECIDED" | "OBSERVED" | "SCAR" | "HYPOTHESIS";
  claim_id: string;
  non_authoritative: boolean;
  citation?: string;
  data: Record<string, unknown>;
}

export function getClaimById(
  claimId: string,
  options: GetClaimOptions = {},
): ClaimEvidenceResult | null {
  const { brainDir, repoRoot } = resolveBrainPaths(options.brainDir, options.repoRoot);
  const quarantineConfig = loadQuarantineConfigOrDefault(brainDir);
  const trimmed = claimId.trim();

  assertQuarantineClean(trimmed, {
    claimId: trimmed,
    field: "claim_id",
    config: quarantineConfig,
    allowHashRefExemption: false,
  });

  if (!CLAIM_ID_LOOKUP_RE.test(trimmed) || trimmed.includes("..")) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "get_claim",
      rule: "invalid_claim_id",
      detail: "claim_id must match ^(DEC|OBS|SCAR|HYP)-[A-Za-z0-9._-]{1,64}$.",
      fix: "Pass a valid DEC-*, OBS-*, SCAR-*, or HYP-* claim_id.",
    });
  }

  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const brain = loadBrain(brainDir, repoRoot, { now });

  if (trimmed.startsWith("DEC-")) {
    const rec = brain.decided.find((d) => d.id === trimmed);
    if (!rec) return null;
    return {
      tier: "DECIDED",
      claim_id: rec.id,
      non_authoritative: false,
      citation: `Based on: ${rec.id} (sha256:${rec.sha256_body.slice(0, 12)})`,
      data: {
        id: rec.id,
        ...(rec.title !== undefined ? { title: rec.title } : {}),
        priority: rec.priority,
        status: rec.status,
        roles: rec.roles,
        ...(rec.envs !== undefined ? { envs: rec.envs } : {}),
        ...(rec.supersedes !== undefined ? { supersedes: rec.supersedes } : {}),
        signed_by: rec.signed_by,
        signed_at_utc: rec.signed_at_utc,
        sha256_body: rec.sha256_body,
        body: rec.body,
      },
    };
  }

  if (trimmed.startsWith("OBS-")) {
    const rec = brain.observed.find((o) => o.claim_id === trimmed);
    if (!rec) return null;
    const obsMs = parseIsoTimestampMs(rec.observed_at_utc) ?? 0;
    const expired = nowMs > obsMs + rec.ttl_seconds * 1000;
    return {
      tier: "OBSERVED",
      claim_id: rec.claim_id,
      non_authoritative: false,
      citation: `Based on: ${rec.claim_id} (${rec.env}@${rec.git_sha})`,
      data: {
        claim_id: rec.claim_id,
        env: rec.env,
        git_sha: rec.git_sha,
        observed_at_utc: rec.observed_at_utc,
        ttl_seconds: rec.ttl_seconds,
        expired,
        issuer: rec.issuer,
        priority: rec.priority,
        roles: rec.roles,
        summary: rec.summary,
        evidence_ref: rec.evidence_ref,
      },
    };
  }

  if (trimmed.startsWith("SCAR-")) {
    const rec = brain.scars.find((s) => s.scar_id === trimmed);
    if (!rec) return null;
    const expMs = parseIsoTimestampMs(rec.expires_at_utc) ?? 0;
    const renderedHint = renderUntrustedHint({
      source: "scar",
      id: rec.scar_id,
      regressionTest: rec.regression_test,
      body: rec.hint,
    });
    assertQuarantineClean(renderedHint, {
      claimId: rec.scar_id,
      config: brain.config.quarantine,
      allowHashRefExemption: false,
    });
    return {
      tier: "SCAR",
      claim_id: rec.scar_id,
      non_authoritative: true,
      data: {
        scar_id: rec.scar_id,
        created_at_utc: rec.created_at_utc,
        expires_at_utc: rec.expires_at_utc,
        expired: nowMs > expMs,
        regression_test: rec.regression_test,
        roles: rec.roles,
        rendered_hint: renderedHint,
      },
    };
  }

  const hyp = brain.hypotheses.find((h) => h.id === trimmed);
  if (!hyp) return null;
  const expMs = parseIsoTimestampMs(hyp.expires_at_utc) ?? 0;
  const renderedHint = renderUntrustedHint({
    source: "hypothesis",
    id: hyp.id,
    body: hyp.hint,
  });
  assertQuarantineClean(renderedHint, {
    claimId: hyp.id,
    config: brain.config.quarantine,
    allowHashRefExemption: false,
  });
  return {
    tier: "HYPOTHESIS",
    claim_id: hyp.id,
    non_authoritative: true,
    data: {
      id: hyp.id,
      kind: hyp.kind ?? "hypothesis",
      created_at_utc: hyp.created_at_utc,
      expires_at_utc: hyp.expires_at_utc,
      expired: nowMs > expMs,
      proposed_by: hyp.proposed_by,
      roles: hyp.roles,
      ...(hyp.regression_test !== undefined ? { regression_test: hyp.regression_test } : {}),
      ...(hyp.proposed_ttl_days !== undefined ? { proposed_ttl_days: hyp.proposed_ttl_days } : {}),
      rendered_hint: renderedHint,
    },
  };
}

export interface BrainStatusOptions {
  env?: EnvName;
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
}

export interface BrainStatusResult {
  healthy: boolean;
  eval_exit_code: number;
  env_filter: EnvName | null;
  counts: {
    decided: number;
    observed: number;
    hypotheses: number;
    scars: number;
    pending_scar_proposals: number;
  };
  scars_bytes: number;
  scars_max_bytes: number;
  scars_remaining_bytes: number;
  expired_counts: {
    observed: number;
    scars: number;
    hypotheses: number;
  };
  issues: Array<{ claim_id: string; rule: string; detail: string }>;
}

function listExtSorted(dirPath: string, ext: string): string[] {
  try {
    return readdirSync(dirPath)
      .filter((f) => f.endsWith(ext) && !f.startsWith("."))
      .sort(compareAscii)
      .map((f) => path.join(dirPath, f));
  } catch {
    return [];
  }
}

export function getBrainStatus(options: BrainStatusOptions = {}): BrainStatusResult {
  const { brainDir, repoRoot } = resolveBrainPaths(options.brainDir, options.repoRoot);
  const now = options.now ?? new Date();
  const nowMs = now.getTime();

  if (options.env !== undefined && !isValidEnv(options.env)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "status",
      rule: "invalid_env",
      detail: "env must be local, pre-staging, staging, or prod.",
      fix: INVALID_ENV_FIX_HINT,
    });
  }

  const evalRes = evaluateBrain({ brainDir, repoRoot, strict: false, now });
  const config = loadBrainConfig(brainDir);

  let expiredObserved = 0;
  let matchedObservedCount = 0;
  for (const file of listExtSorted(path.join(brainDir, "observed"), ".json")) {
    try {
      const obs = parseObservedFile(file, config.quarantine);
      if (options.env !== undefined && obs.env !== options.env) {
        continue;
      }
      matchedObservedCount += 1;
      const obsMs = parseIsoTimestampMs(obs.observed_at_utc) ?? 0;
      if (nowMs > obsMs + obs.ttl_seconds * 1000) {
        expiredObserved += 1;
      }
    } catch (err) {
      if (err instanceof VeriBrainError && err.exitCode === EXIT_QUARANTINE_VIOLATION) {
        throw err;
      }
    }
  }

  let expiredHypotheses = 0;
  let pendingScarProposals = 0;
  for (const file of listExtSorted(path.join(brainDir, "hypotheses"), ".json")) {
    try {
      const hyp = parseHypothesisFile(file, config.quarantine, { now });
      if (
        hyp.kind === "scar_proposal" ||
        hyp.kind === "hypothesis_scar" ||
        hyp.id.startsWith("HYP-SCAR-")
      ) {
        pendingScarProposals += 1;
      }
      const expMs = parseIsoTimestampMs(hyp.expires_at_utc) ?? 0;
      if (nowMs > expMs) {
        expiredHypotheses += 1;
      }
    } catch (err) {
      if (err instanceof VeriBrainError && err.exitCode === EXIT_QUARANTINE_VIOLATION) {
        throw err;
      }
    }
  }

  let expiredScars = 0;
  try {
    const parsedScars = parseScarsFile(brainDir, config.quarantine, { now });
    for (const scar of parsedScars.scars) {
      const expMs = parseIsoTimestampMs(scar.expires_at_utc) ?? 0;
      if (nowMs > expMs) {
        expiredScars += 1;
      }
    }
  } catch (err) {
    if (err instanceof VeriBrainError && err.exitCode === EXIT_QUARANTINE_VIOLATION) {
      throw err;
    }
  }

  return {
    healthy: evalRes.ok,
    eval_exit_code: evalRes.exitCode,
    env_filter: options.env ?? null,
    counts: {
      decided: evalRes.counts.decided,
      observed: options.env !== undefined ? matchedObservedCount : evalRes.counts.observed,
      hypotheses: evalRes.counts.hypotheses,
      scars: evalRes.counts.scars,
      pending_scar_proposals: pendingScarProposals,
    },
    scars_bytes: evalRes.counts.scarsBytes,
    scars_max_bytes: MAX_SCARS_BYTES,
    scars_remaining_bytes: Math.max(0, MAX_SCARS_BYTES - evalRes.counts.scarsBytes),
    expired_counts: {
      observed: expiredObserved,
      scars: expiredScars,
      hypotheses: expiredHypotheses,
    },
    issues: evalRes.issues.map((i) => ({
      claim_id: i.claimId,
      rule: i.rule,
      detail: i.detail,
    })),
  };
}

export const VALID_LIST_CLAIM_TIERS = ["all", "decided", "observed", "hypothesis", "scar"] as const;
export type ListClaimsTier = (typeof VALID_LIST_CLAIM_TIERS)[number];

export interface ListClaimsOptions {
  tier?: ListClaimsTier;
  prefix?: string;
  role?: string;
  limit?: number;
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
}

export interface ClaimListItem {
  id: string;
  tier: "DECIDED" | "OBSERVED" | "HYPOTHESIS" | "SCAR";
  kind: string;
  title?: string;
  summary: string;
  issuer: string;
  roles: string[];
  priority?: Priority;
  status?: DecidedStatus;
  env?: EnvName;
  expires_at_utc?: string;
  expired?: boolean;
  sha256_body?: string;
  regression_test?: string;
  non_authoritative: boolean;
}

export interface ListClaimsResult {
  tier_filter: ListClaimsTier;
  prefix_filter: string | null;
  role_filter: string | null;
  limit: number;
  total_matched: number;
  truncated: boolean;
  counts: {
    total: number;
    decided: number;
    observed: number;
    hypotheses: number;
    scars: number;
    pending_scar_proposals: number;
  };
  claims: ClaimListItem[];
}

const MAX_LIST_CLAIMS_LIMIT = 100;
const DEFAULT_LIST_CLAIMS_LIMIT = 50;
const MAX_SNIPPET_CHARS = 200;

function scrubListSnippet(raw: string, claimId: string, config: QuarantineConfig): string {
  const singleLine = stripControlAndBidiChars(normalizeLf(raw), true)
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    scanTextForQuarantine(singleLine, {
      claimId,
      config,
      allowHashRefExemption: false,
    }) !== null
  ) {
    return "[REDACTED]";
  }
  if (singleLine.length <= MAX_SNIPPET_CHARS) {
    return singleLine;
  }
  return `${singleLine.slice(0, MAX_SNIPPET_CHARS - 3)}...`;
}

function roleFilterMatches(roles: readonly string[], roleFilter: string | null): boolean {
  if (roleFilter === null) {
    return true;
  }
  return roles.includes(roleFilter) || roles.includes("*");
}

export function listClaims(options: ListClaimsOptions = {}): ListClaimsResult {
  const { brainDir, repoRoot } = resolveBrainPaths(options.brainDir, options.repoRoot);
  const now = options.now ?? new Date();
  const nowMs = now.getTime();

  const tier: ListClaimsTier = options.tier ?? "all";
  if (!(VALID_LIST_CLAIM_TIERS as readonly string[]).includes(tier)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "list_claims",
      rule: "invalid_tier",
      detail: "tier must be one of: all, decided, observed, hypothesis, scar.",
      fix: "Pass tier as all|decided|observed|hypothesis|scar.",
    });
  }

  let prefixFilter: string | null = null;
  if (options.prefix !== undefined && options.prefix.trim().length > 0) {
    const rawPrefix = options.prefix.trim();
    if (hasControlOrBidiChars(rawPrefix) || rawPrefix.length > 64) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "list_claims",
        rule: "invalid_prefix",
        detail: "prefix must be <= 64 plain characters without control sequences.",
        fix: "Pass a short claim ID prefix like DEC-, OBS-, SCAR-, or HYP-.",
      });
    }
    assertQuarantineClean(rawPrefix, {
      claimId: "list_claims",
      field: "prefix",
      allowHashRefExemption: false,
    });
    prefixFilter = rawPrefix;
  }

  let roleFilter: string | null = null;
  if (options.role !== undefined && options.role.trim().length > 0) {
    const rawRole = options.role.trim();
    assertQuarantineClean(rawRole, {
      claimId: "list_claims",
      field: "role",
      allowHashRefExemption: false,
    });
    if (!VALID_ROLE_TOKEN_RE.test(rawRole)) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "list_claims",
        rule: "invalid_role",
        detail: "role filter must match ^[A-Za-z0-9._-]{1,64}$ or '*'.",
        fix: "Pass a valid role name such as builder, cqe, or cpm.",
      });
    }
    roleFilter = rawRole;
  }

  let limit = DEFAULT_LIST_CLAIMS_LIMIT;
  if (options.limit !== undefined) {
    if (!Number.isFinite(options.limit) || !Number.isInteger(options.limit) || options.limit < 1) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "list_claims",
        rule: "invalid_limit",
        detail: "limit must be a positive integer (capped at 100).",
        fix: "Pass limit as an integer between 1 and 100.",
      });
    }
    limit = Math.min(options.limit, MAX_LIST_CLAIMS_LIMIT);
  }

  const brain = loadBrain(brainDir, repoRoot, { now });
  const qCfg = brain.config.quarantine;
  const allItems: ClaimListItem[] = [];

  if (tier === "all" || tier === "decided") {
    const sortedDecided = [...brain.decided].sort((a, b) => compareAscii(a.id, b.id));
    for (const d of sortedDecided) {
      if (prefixFilter !== null && !d.id.startsWith(prefixFilter)) continue;
      if (!roleFilterMatches(d.roles, roleFilter)) continue;
      const item: ClaimListItem = {
        id: d.id,
        tier: "DECIDED",
        kind: "decided",
        summary: scrubListSnippet(d.body, d.id, qCfg),
        issuer: d.signed_by,
        roles: d.roles,
        priority: d.priority,
        status: d.status,
        sha256_body: d.sha256_body,
        non_authoritative: false,
      };
      if (d.title !== undefined) {
        item.title = scrubListSnippet(d.title, d.id, qCfg);
      }
      allItems.push(item);
    }
  }

  if (tier === "all" || tier === "observed") {
    const sortedObserved = [...brain.observed].sort((a, b) => compareAscii(a.claim_id, b.claim_id));
    for (const o of sortedObserved) {
      if (prefixFilter !== null && !o.claim_id.startsWith(prefixFilter)) continue;
      if (!roleFilterMatches(o.roles, roleFilter)) continue;
      const obsMs = parseIsoTimestampMs(o.observed_at_utc) ?? 0;
      const expMs = obsMs + o.ttl_seconds * 1000;
      allItems.push({
        id: o.claim_id,
        tier: "OBSERVED",
        kind: "observed",
        summary: scrubListSnippet(o.summary, o.claim_id, qCfg),
        issuer: o.issuer,
        roles: o.roles,
        priority: o.priority,
        env: o.env,
        expires_at_utc: new Date(expMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
        expired: nowMs > expMs,
        non_authoritative: false,
      });
    }
  }

  if (tier === "all" || tier === "scar") {
    const sortedScars = [...brain.scars].sort((a, b) => compareAscii(a.scar_id, b.scar_id));
    for (const s of sortedScars) {
      if (prefixFilter !== null && !s.scar_id.startsWith(prefixFilter)) continue;
      if (!roleFilterMatches(s.roles, roleFilter)) continue;
      const expMs = parseIsoTimestampMs(s.expires_at_utc) ?? 0;
      const snippet = scrubListSnippet(s.hint, s.scar_id, qCfg);
      const renderedSummary = renderUntrustedHint({
        source: "scar",
        id: s.scar_id,
        regressionTest: s.regression_test,
        body: snippet,
      });
      assertQuarantineClean(renderedSummary, {
        claimId: s.scar_id,
        config: qCfg,
        allowHashRefExemption: false,
      });
      allItems.push({
        id: s.scar_id,
        tier: "SCAR",
        kind: "scar",
        summary: renderedSummary,
        issuer: "human",
        roles: s.roles,
        expires_at_utc: s.expires_at_utc,
        expired: nowMs > expMs,
        regression_test: s.regression_test,
        non_authoritative: true,
      });
    }
  }

  if (tier === "all" || tier === "hypothesis") {
    const sortedHyps = [...brain.hypotheses].sort((a, b) => compareAscii(a.id, b.id));
    for (const h of sortedHyps) {
      if (prefixFilter !== null && !h.id.startsWith(prefixFilter)) continue;
      if (!roleFilterMatches(h.roles, roleFilter)) continue;
      const expMs = parseIsoTimestampMs(h.expires_at_utc) ?? 0;
      const snippet = scrubListSnippet(h.hint, h.id, qCfg);
      const renderedSummary = renderUntrustedHint({
        source: "hypothesis",
        id: h.id,
        body: snippet,
      });
      assertQuarantineClean(renderedSummary, {
        claimId: h.id,
        config: qCfg,
        allowHashRefExemption: false,
      });
      const item: ClaimListItem = {
        id: h.id,
        tier: "HYPOTHESIS",
        kind: h.kind ?? "hypothesis",
        summary: renderedSummary,
        issuer: h.proposed_by,
        roles: h.roles,
        expires_at_utc: h.expires_at_utc,
        expired: nowMs > expMs,
        non_authoritative: true,
      };
      if (h.regression_test !== undefined) {
        item.regression_test = h.regression_test;
      }
      allItems.push(item);
    }
  }

  const pendingScarProposals = brain.hypotheses.filter(
    (h) =>
      h.kind === "scar_proposal" || h.kind === "hypothesis_scar" || h.id.startsWith("HYP-SCAR-"),
  ).length;

  const claims = allItems.slice(0, limit);
  return {
    tier_filter: tier,
    prefix_filter: prefixFilter,
    role_filter: roleFilter,
    limit,
    total_matched: allItems.length,
    truncated: allItems.length > limit,
    counts: {
      total:
        brain.decided.length + brain.observed.length + brain.hypotheses.length + brain.scars.length,
      decided: brain.decided.length,
      observed: brain.observed.length,
      hypotheses: brain.hypotheses.length,
      scars: brain.scars.length,
      pending_scar_proposals: pendingScarProposals,
    },
    claims,
  };
}
