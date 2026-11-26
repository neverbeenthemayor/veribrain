import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeLf } from "../normalize.js";
import { assertQuarantineClean } from "../quarantine.js";
import {
  defaultQuarantineConfig,
  INVALID_ENV_FIX_HINT,
  invalidateFileReadCache,
  isAgentEnvironment,
  isValidEnv,
  isValidGitSha,
  isValidIssuer,
  isValidObsId,
  isValidPriority,
  loadBrainConfig,
  resolveBrainPaths,
  resolveWorktreeHeadSha,
} from "../schema.js";
import {
  EXIT_ERROR,
  EXIT_PROVENANCE_VIOLATION,
  MAX_OBSERVED_TTL_SECONDS,
  type ObservedRecord,
  type ObserveOptions,
  type ObserveResult,
  type Priority,
  type QuarantineConfig,
  VeriBrainError,
} from "../types.js";

export function writeObservation(options: ObserveOptions): ObserveResult {
  const envVars = options.envVars ?? process.env;

  if (isAgentEnvironment(envVars)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: options.claimId || "observe",
      rule: "agent_self_attestation_denied",
      detail: "Agents cannot write OBSERVED claims (fail-closed provenance).",
      fix: "Run veribrain observe from CI, git hook, or a verifier script.",
    });
  }

  const issuer = options.issuer.trim();
  if (!isValidIssuer(issuer)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: options.claimId || "observe",
      rule: "invalid_observed_issuer",
      detail: "Observed --issuer must be ci, git-hook, or verifier-script.",
      fix: "Pass --issuer ci|git-hook|verifier-script.",
    });
  }

  const claimId = options.claimId.trim();
  if (
    !isValidObsId(claimId) ||
    claimId.includes("/") ||
    claimId.includes("\\") ||
    claimId.includes("..")
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "observe",
      rule: "invalid_claim_id",
      detail: "--claim-id must match ^OBS-[A-Za-z0-9._-]+$.",
      fix: "Pass --claim-id OBS-<identifier>.",
    });
  }

  if (!isValidEnv(options.env)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId,
      rule: "invalid_env",
      detail: "--env must be local, pre-staging, staging, or prod.",
      fix: INVALID_ENV_FIX_HINT,
    });
  }

  let gitSha = options.gitSha.trim();
  if (gitSha.toUpperCase() === "HEAD") {
    const resolvedHead = resolveWorktreeHeadSha(options.repoRoot ?? process.cwd());
    if (resolvedHead === null) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId,
        rule: "invalid_git_sha",
        detail: "Could not resolve --git-sha HEAD from .git or worktree HEAD.",
        fix: "Pass an explicit 7-40 hex SHA via --git-sha <hex>.",
      });
    }
    gitSha = resolvedHead;
  }
  if (!isValidGitSha(gitSha)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId,
      rule: "invalid_git_sha",
      detail: "--git-sha must be 7-40 hex characters.",
      fix: "Pass a valid git SHA via --git-sha <hex>.",
    });
  }

  if (
    !Number.isInteger(options.ttlSeconds) ||
    options.ttlSeconds < 1 ||
    options.ttlSeconds > MAX_OBSERVED_TTL_SECONDS
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId,
      rule: "invalid_ttl_seconds",
      detail: `--ttl must be an integer between 1 and ${MAX_OBSERVED_TTL_SECONDS}.`,
      fix: `Pass --ttl <seconds> in range 1..${MAX_OBSERVED_TTL_SECONDS}.`,
    });
  }

  const summary = options.summary.trim();
  if (summary.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId,
      rule: "missing_summary",
      detail: "--summary must be a non-empty factual description.",
      fix: 'Pass --summary "<verified fact>".',
    });
  }

  const evidenceRef = options.evidenceRef.trim();
  if (evidenceRef.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId,
      rule: "missing_evidence_ref",
      detail: "--evidence must be a non-empty verifiable reference.",
      fix: 'Pass --evidence "<ci-run-or-log-ref>".',
    });
  }

  const roles = (options.roles ?? ["*"]).map((r) => r.trim()).filter((r) => r.length > 0);
  if (roles.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId,
      rule: "missing_roles",
      detail: "--roles must contain at least one role name.",
      fix: "Pass --roles builder,cqe or omit --roles for wildcard.",
    });
  }

  const priority: Priority = options.priority ?? "P2";
  if (!isValidPriority(priority)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId,
      rule: "invalid_priority",
      detail: "--priority must be P0, P1, or P2.",
      fix: "Pass --priority P0|P1|P2.",
    });
  }

  const { brainDir } = resolveBrainPaths(options.brainDir, options.repoRoot, {
    allowWorktreeFallback: false,
  });
  let quarantineConfig: QuarantineConfig = defaultQuarantineConfig();
  if (existsSync(path.join(brainDir, "config.json"))) {
    quarantineConfig = loadBrainConfig(brainDir).quarantine;
  }

  assertQuarantineClean(claimId, { claimId, field: "claim_id", config: quarantineConfig });
  assertQuarantineClean(summary, { claimId, field: "summary", config: quarantineConfig });
  assertQuarantineClean(evidenceRef, {
    claimId,
    field: "evidence_ref",
    config: quarantineConfig,
  });
  for (const role of roles) {
    assertQuarantineClean(role, { claimId, field: "roles", config: quarantineConfig });
  }

  const observedAtUtc = (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const observedDir = path.resolve(brainDir, "observed");
  const finalPath = path.resolve(observedDir, `${claimId}.json`);
  if (path.dirname(finalPath) !== observedDir || path.basename(finalPath) !== `${claimId}.json`) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "path_confinement_violation",
      detail: "Observed write path must stay strictly inside .brain/observed/.",
      fix: "Use a plain OBS-* claim_id without path separators.",
    });
  }

  const payloadObj = {
    claim_id: claimId,
    env: options.env,
    git_sha: gitSha,
    observed_at_utc: observedAtUtc,
    ttl_seconds: options.ttlSeconds,
    issuer,
    roles,
    priority,
    summary,
    evidence_ref: evidenceRef,
  };
  const serialized = `${JSON.stringify(payloadObj, null, 2)}\n`;
  const allowlistedLineTokens = new Map<number, Set<string>>();
  const allowHashRefLineNumbers = new Set<number>();
  const lines = normalizeLf(serialized).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.includes('"git_sha"')) {
      allowlistedLineTokens.set(i + 1, new Set([gitSha.toLowerCase()]));
    }
    if (line.includes('"evidence_ref"')) {
      allowHashRefLineNumbers.add(i + 1);
    }
  }
  assertQuarantineClean(serialized, {
    claimId,
    config: quarantineConfig,
    allowlistedLineTokens,
    allowHashRefLineNumbers,
  });

  if (!existsSync(observedDir)) {
    mkdirSync(observedDir, { recursive: true });
  }

  const tmpName = `.tmp-${claimId}-${process.pid}-${randomBytes(6).toString("hex")}.json`;
  const tmpPath = path.join(observedDir, tmpName);
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

  const record: ObservedRecord = {
    ...payloadObj,
    source_file: finalPath,
  };
  return { record, filePath: finalPath };
}
