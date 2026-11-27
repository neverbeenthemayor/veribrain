import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { normalizeLf } from "../normalize.js";
import { assertQuarantineClean } from "../quarantine.js";
import {
  defaultQuarantineConfig,
  INVALID_ENV_FIX_HINT,
  invalidateFileReadCache,
  isAgentEnvironment,
  isBlockedSystemOrIsolationPath,
  isUncOrDevicePath,
  isValidEnv,
  isValidGitSha,
  isValidIssuer,
  isValidObservedTtlMode,
  isValidObsId,
  isValidPriority,
  loadBrainConfig,
  resolveBrainPaths,
  resolveWorktreeHeadSha,
} from "../schema.js";
import {
  EXIT_ERROR,
  EXIT_PROVENANCE_VIOLATION,
  MAX_ENV_TTL_SECONDS,
  MAX_OBSERVED_TTL_SECONDS,
  type ObservedRecord,
  type ObservedTtlMode,
  type ObserveOptions,
  type ObserveResult,
  type Priority,
  type QuarantineConfig,
  VeriBrainError,
} from "../types.js";

function assertObservedDirConfinement(brainDir: string, claimId: string): string {
  const resolvedBrainDir = path.resolve(brainDir);
  if (isUncOrDevicePath(resolvedBrainDir) || isBlockedSystemOrIsolationPath(resolvedBrainDir)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "path_confinement_violation",
      detail: ".brain directory points to a forbidden UNC, device, system, or isolated path.",
      fix: "Use a local repo-confined .brain directory.",
    });
  }

  let brainStat: Stats | null = null;
  try {
    brainStat = lstatSync(resolvedBrainDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  if (brainStat !== null) {
    if (brainStat.isSymbolicLink() || !brainStat.isDirectory()) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId,
        rule: "path_confinement_violation",
        detail: ".brain/ must be a real non-symlink directory.",
        fix: "Replace symlinked .brain with a real directory.",
      });
    }
  } else {
    mkdirSync(resolvedBrainDir, { recursive: true });
  }

  const observedDir = path.resolve(resolvedBrainDir, "observed");
  let obsStat: Stats | null = null;
  try {
    obsStat = lstatSync(observedDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  if (obsStat !== null) {
    if (obsStat.isSymbolicLink() || !obsStat.isDirectory()) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId,
        rule: "path_confinement_violation",
        detail: ".brain/observed/ cannot be a symbolic link.",
        fix: "Replace symlinked .brain/observed with a real directory.",
      });
    }
  } else {
    mkdirSync(observedDir, { recursive: true });
  }

  const realBrain = realpathSync(resolvedBrainDir);
  const realObserved = realpathSync(observedDir);
  if (isBlockedSystemOrIsolationPath(realBrain) || isBlockedSystemOrIsolationPath(realObserved)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "path_confinement_violation",
      detail: ".brain/observed/ resolved to a forbidden system or isolated path.",
      fix: "Use a local repo-confined .brain/observed/ directory.",
    });
  }
  const expected = path.join(realBrain, "observed");
  const isWin = process.platform === "win32";
  if (
    (isWin ? realObserved.toLowerCase() : realObserved) !==
    (isWin ? expected.toLowerCase() : expected)
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "path_confinement_violation",
      detail: ".brain/observed/ must resolve strictly inside .brain/.",
      fix: "Use a local .brain/observed/ directory.",
    });
  }
  return realObserved;
}

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

  let ttlMode: ObservedTtlMode | undefined;
  if (options.ttlMode !== undefined) {
    if (!isValidObservedTtlMode(options.ttlMode)) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId,
        rule: "invalid_ttl_mode",
        detail: "--ttl-mode must be sha-pinned or env-ttl.",
        fix: "Pass --ttl-mode sha-pinned|env-ttl.",
      });
    }
    ttlMode = options.ttlMode;
    if (ttlMode === "env-ttl" && options.ttlSeconds > MAX_ENV_TTL_SECONDS) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId,
        rule: "env_ttl_exceeded",
        detail: `env-ttl observations cap --ttl at ${MAX_ENV_TTL_SECONDS}s (7 days).`,
        fix: `Pass --ttl <= ${MAX_ENV_TTL_SECONDS} or use --ttl-mode sha-pinned.`,
      });
    }
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

  for (const raw of [options.brainDir, options.repoRoot]) {
    if (raw !== undefined && (isUncOrDevicePath(raw) || isBlockedSystemOrIsolationPath(raw))) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId,
        rule: "path_confinement_violation",
        detail:
          "Observation target path points to a forbidden UNC, device, system, or isolated path.",
        fix: "Use a local repo-confined .brain directory.",
      });
    }
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
  const observedDir = assertObservedDirConfinement(brainDir, claimId);
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
  try {
    if (lstatSync(finalPath).isSymbolicLink()) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId,
        rule: "path_confinement_violation",
        detail: "Target observed file cannot be a symbolic link.",
        fix: "Remove symlinked file inside .brain/observed/ before writing.",
      });
    }
  } catch (err) {
    if (err instanceof VeriBrainError) {
      throw err;
    }
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const payloadObj = {
    claim_id: claimId,
    env: options.env,
    git_sha: gitSha,
    observed_at_utc: observedAtUtc,
    ttl_seconds: options.ttlSeconds,
    ...(ttlMode !== undefined ? { ttl_mode: ttlMode } : {}),
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
