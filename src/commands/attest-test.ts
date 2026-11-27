import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { normalizeLf, sha256Hex } from "../normalize.js";
import { assertQuarantineClean, scanTextForQuarantine } from "../quarantine.js";
import { hasControlOrBidiChars } from "../sanitize.js";
import {
  INVALID_ENV_FIX_HINT,
  isAgentEnvironment,
  isBlockedSystemOrIsolationPath,
  isUncOrDevicePath,
  isValidEnv,
  isValidGitSha,
  isValidObservedTtlMode,
  isValidPriority,
  resolveBrainPaths,
  resolveWorktreeHeadSha,
} from "../schema.js";
import {
  type AttestTestOptions,
  type AttestTestResult,
  type EnvName,
  EXIT_ERROR,
  EXIT_PROVENANCE_VIOLATION,
  MAX_ENV_TTL_SECONDS,
  MAX_OBSERVED_TTL_SECONDS,
  type ObservedTtlMode,
  type Priority,
  VeriBrainError,
} from "../types.js";
import { writeObservation } from "./observe.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_TTL_SECONDS = 86_400;
const VERIFY_CLAIM_ID_RE = /^OBS-VERIFY-[A-Za-z0-9._-]{1,50}$/;
const SHELL_META_RE = /[;&|<>`$\r\n(){}\\]/;
const SAFE_SUBCOMMAND_ARG_RE =
  /^(?:--?[A-Za-z0-9][A-Za-z0-9-]{0,18}|[A-Za-z0-9][A-Za-z0-9._-]{0,18})$/;

function hasUnsafeTokenChars(token: string): boolean {
  return (
    token.includes("\0") ||
    token.includes("\n") ||
    token.includes("\r") ||
    hasControlOrBidiChars(token)
  );
}

function sanitizeCommandSlug(executable: string, args: readonly string[]): string {
  const base = path
    .basename(executable)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|mjs|cjs|js|sh)$/i, "");
  const parts = [base];
  const firstArg = args[0];
  if (
    firstArg &&
    !firstArg.startsWith("-") &&
    !firstArg.includes("=") &&
    !firstArg.includes("@") &&
    SAFE_SUBCOMMAND_ARG_RE.test(firstArg)
  ) {
    parts.push(path.basename(firstArg).toLowerCase());
  }
  const slug = parts
    .join("-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug.length > 0 ? slug : "cmd";
}

function sanitizeSafeCmdLabel(executable: string, args: readonly string[]): string {
  const base = path
    .basename(executable)
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 24);
  const tokens = [base || "cmd"];
  for (const arg of args.slice(0, 2)) {
    if (arg.includes("=") || arg.includes("@")) {
      tokens.push("redacted-arg");
      continue;
    }
    if (!SAFE_SUBCOMMAND_ARG_RE.test(arg)) {
      continue;
    }
    const cleaned = arg.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 16);
    if (
      cleaned.length > 0 &&
      scanTextForQuarantine(cleaned, { claimId: "attest-test", allowHashRefExemption: false }) ===
        null
    ) {
      tokens.push(cleaned);
    }
  }
  const combined = tokens.join("-").replace(/;/g, "").slice(0, 36);
  if (
    combined.length === 0 ||
    scanTextForQuarantine(combined, { claimId: "attest-test", allowHashRefExemption: false }) !==
      null
  ) {
    return "redacted-cmd";
  }
  return combined;
}

function assertSafeTokenList(executable: string, args: readonly string[]): void {
  if (executable.length === 0 || hasUnsafeTokenChars(executable)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "attest-test",
      rule: "invalid_command",
      detail: "Command executable cannot be empty or contain control/NUL characters.",
      fix: "Pass a valid executable via `-- <executable> [args...]` or `--cmd <command>`.",
    });
  }
  for (const arg of args) {
    if (hasUnsafeTokenChars(arg)) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "attest-test",
        rule: "invalid_command_arg",
        detail: "Command arguments cannot contain NUL, newline, or control/bidi characters.",
        fix: "Remove control characters from command arguments and re-run attest-test.",
      });
    }
  }
}

function parseCommandSpec(options: AttestTestOptions): { executable: string; args: string[] } {
  const hasArgv = options.argv !== undefined && options.argv.length > 0;
  const hasCmd = options.cmd !== undefined && options.cmd.trim().length > 0;
  const hasExtraArgs = options.args !== undefined && options.args.length > 0;

  if (hasArgv && hasCmd) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "attest-test",
      rule: "ambiguous_command",
      detail: "Specify either `-- <executable> [args...]` or `--cmd <command>`, not both.",
      fix: 'Pass either `veribrain attest-test -- npm test` or `veribrain attest-test --cmd "npm test"`.',
    });
  }
  if (hasArgv && hasExtraArgs) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "attest-test",
      rule: "ambiguous_command",
      detail: "Do not combine `-- <executable> [args...]` with `--arg`.",
      fix: "Pass all arguments after `--` or use `--cmd <exe> --arg <val>`.",
    });
  }
  if (!hasArgv && !hasCmd) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "attest-test",
      rule: "missing_command",
      detail:
        "attest-test requires a command via `-- <executable> [args...]` or `--cmd <command>`.",
      fix: "Run `veribrain attest-test -- npm test`.",
    });
  }

  if (hasArgv && options.argv) {
    const [rawExe, ...rest] = options.argv;
    const executable = (rawExe ?? "").trim();
    const args = [...rest];
    assertSafeTokenList(executable, args);
    return { executable, args };
  }

  const rawCmd = (options.cmd ?? "").trim();
  if (SHELL_META_RE.test(rawCmd) || hasUnsafeTokenChars(rawCmd)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "attest-test",
      rule: "unsafe_shell_metacharacters",
      detail:
        "--cmd rejects shell metacharacters (;&|<>$`(){}\\) because attest-test executes with shell: false.",
      fix: "Pass direct executable + arguments via `-- <executable> [args...]` or `--cmd <exe> --arg <val>`.",
    });
  }

  const tokens = rawCmd.split(/\s+/).filter((t) => t.length > 0);
  const executable = tokens[0] ?? "";
  if (executable.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "attest-test",
      rule: "missing_command",
      detail: "--cmd cannot be empty.",
      fix: "Pass a valid command to --cmd.",
    });
  }
  const args = [...tokens.slice(1), ...(options.args ?? [])];
  assertSafeTokenList(executable, args);
  return { executable, args };
}

function resolveWindowsSafeSpawn(
  executable: string,
  args: readonly string[],
): { spawnExe: string; spawnArgs: string[] } {
  if (process.platform === "win32") {
    const baseLower = path
      .basename(executable)
      .toLowerCase()
      .replace(/\.(?:cmd|exe|bat)$/i, "");
    if (baseLower === "npm" || baseLower === "npx") {
      const cliJs = path.join(
        path.dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        baseLower === "npx" ? "npx-cli.js" : "npm-cli.js",
      );
      if (existsSync(cliJs)) {
        return {
          spawnExe: process.execPath,
          spawnArgs: [cliJs, ...args],
        };
      }
    }
  }
  return { spawnExe: executable, spawnArgs: [...args] };
}

function computeGitDiffStatHash(repoRoot: string): string {
  try {
    const out = execFileSync("git", ["diff", "--stat", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return sha256Hex(normalizeLf(out));
  } catch {
    return sha256Hex("no-git");
  }
}

function assertSafeAttestPaths(
  rawBrainDir: string | undefined,
  rawRepoRoot: string | undefined,
  resolvedBrainDir: string,
  resolvedRepoRoot: string,
): string {
  for (const candidate of [rawBrainDir, rawRepoRoot, resolvedBrainDir, resolvedRepoRoot]) {
    if (candidate === undefined) continue;
    if (isUncOrDevicePath(candidate) || isBlockedSystemOrIsolationPath(candidate)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "attest-test",
        rule: "path_confinement_violation",
        detail: "attest-test refuses UNC, device, system, or isolated repository paths.",
        fix: "Run attest-test inside an authorized local repository directory.",
      });
    }
  }
  let realRepoRoot = resolvedRepoRoot;
  if (existsSync(resolvedRepoRoot)) {
    realRepoRoot = realpathSync(resolvedRepoRoot);
    if (isUncOrDevicePath(realRepoRoot) || isBlockedSystemOrIsolationPath(realRepoRoot)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "attest-test",
        rule: "path_confinement_violation",
        detail: "Resolved repository root points to a forbidden system or isolated path.",
        fix: "Run attest-test inside an authorized local repository directory.",
      });
    }
  }
  if (existsSync(resolvedBrainDir)) {
    const realBrainDir = realpathSync(resolvedBrainDir);
    if (isUncOrDevicePath(realBrainDir) || isBlockedSystemOrIsolationPath(realBrainDir)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "attest-test",
        rule: "path_confinement_violation",
        detail: "Resolved .brain directory points to a forbidden system or isolated path.",
        fix: "Use a local repo-confined .brain directory.",
      });
    }
  }
  return realRepoRoot;
}

export function attestTest(options: AttestTestOptions): AttestTestResult {
  const envVars = options.envVars ?? process.env;
  if (isAgentEnvironment(envVars)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: options.claimId || "attest-test",
      rule: "agent_self_attestation_denied",
      detail: "Agents cannot emit Tier 2 OBSERVED verifier receipts via attest-test.",
      fix: "Run veribrain attest-test outside agent mode from CI, hook, or verifier script.",
    });
  }

  const { executable, args } = parseCommandSpec(options);

  // P1-PRG2-1: Quarantine-scan RAW unstripped/untruncated command inputs BEFORE sanitization or execution.
  if (options.cmd !== undefined) {
    assertQuarantineClean(options.cmd, {
      claimId: "attest-test",
      field: "cmd",
      allowHashRefExemption: false,
    });
  }
  assertQuarantineClean(executable, {
    claimId: "attest-test",
    field: "command",
    allowHashRefExemption: false,
  });
  for (const arg of args) {
    assertQuarantineClean(arg, {
      claimId: "attest-test",
      field: "command_arg",
      allowHashRefExemption: false,
    });
  }

  const env: EnvName = options.env ?? "local";
  if (!isValidEnv(env)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "attest-test",
      rule: "invalid_env",
      detail: "--env must be local, pre-staging, staging, or prod.",
      fix: INVALID_ENV_FIX_HINT,
    });
  }

  const ttlMode: ObservedTtlMode = options.ttlMode ?? "sha-pinned";
  if (!isValidObservedTtlMode(ttlMode)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "attest-test",
      rule: "invalid_ttl_mode",
      detail: "--ttl-mode must be sha-pinned or env-ttl.",
      fix: "Pass --ttl-mode sha-pinned|env-ttl.",
    });
  }

  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_OBSERVED_TTL_SECONDS) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "attest-test",
      rule: "invalid_ttl_seconds",
      detail: `--ttl must be an integer between 1 and ${MAX_OBSERVED_TTL_SECONDS}.`,
      fix: `Pass --ttl <seconds> in range 1..${MAX_OBSERVED_TTL_SECONDS}.`,
    });
  }
  if (ttlMode === "env-ttl" && ttlSeconds > MAX_ENV_TTL_SECONDS) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "attest-test",
      rule: "env_ttl_exceeded",
      detail: `env-ttl observations cap --ttl at ${MAX_ENV_TTL_SECONDS}s (7 days).`,
      fix: `Pass --ttl <= ${MAX_ENV_TTL_SECONDS} or use --ttl-mode sha-pinned.`,
    });
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "attest-test",
      rule: "invalid_timeout",
      detail: `--timeout must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms.`,
      fix: `Pass --timeout <ms> in range ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}.`,
    });
  }

  const priority: Priority = options.priority ?? "P1";
  if (!isValidPriority(priority)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "attest-test",
      rule: "invalid_priority",
      detail: "--priority must be P0, P1, or P2.",
      fix: "Pass --priority P0|P1|P2.",
    });
  }

  const roles = (options.roles ?? ["*"]).map((r) => r.trim()).filter((r) => r.length > 0);
  if (roles.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "attest-test",
      rule: "missing_roles",
      detail: "--roles must contain at least one role name.",
      fix: "Pass --roles builder,cqe or omit --roles for wildcard.",
    });
  }

  if (options.brainDir !== undefined) {
    if (isUncOrDevicePath(options.brainDir) || isBlockedSystemOrIsolationPath(options.brainDir)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "attest-test",
        rule: "path_confinement_violation",
        detail: "--brain-dir points to a forbidden UNC, device, system, or isolated path.",
        fix: "Use a local repo-confined .brain directory.",
      });
    }
  }
  if (options.repoRoot !== undefined) {
    if (isUncOrDevicePath(options.repoRoot) || isBlockedSystemOrIsolationPath(options.repoRoot)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "attest-test",
        rule: "path_confinement_violation",
        detail: "--repo-root points to a forbidden UNC, device, system, or isolated path.",
        fix: "Run attest-test inside an authorized local repository directory.",
      });
    }
  }

  const { brainDir, repoRoot } = resolveBrainPaths(options.brainDir, options.repoRoot, {
    allowWorktreeFallback: false,
  });
  const realRepoRoot = assertSafeAttestPaths(
    options.brainDir,
    options.repoRoot,
    brainDir,
    repoRoot,
  );

  let gitSha = (options.gitSha ?? "HEAD").trim();
  if (gitSha.toUpperCase() === "HEAD") {
    const resolvedHead = resolveWorktreeHeadSha(realRepoRoot);
    if (resolvedHead === null) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "attest-test",
        rule: "invalid_git_sha",
        detail: "Could not resolve --git-sha HEAD from .git or worktree HEAD.",
        fix: "Pass an explicit 7-40 hex SHA via --git-sha <hex> or run inside a Git repository.",
      });
    }
    gitSha = resolvedHead;
  }
  if (!isValidGitSha(gitSha)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "attest-test",
      rule: "invalid_git_sha",
      detail: "--git-sha must be 7-40 hex characters.",
      fix: "Pass a valid commit SHA via --git-sha <hex>.",
    });
  }

  let claimId: string;
  if (options.claimId !== undefined) {
    const trimmedId = options.claimId.trim();
    assertQuarantineClean(trimmedId, {
      claimId: trimmedId,
      field: "claim_id",
      allowHashRefExemption: false,
    });
    if (
      !VERIFY_CLAIM_ID_RE.test(trimmedId) ||
      trimmedId.includes("..") ||
      trimmedId.includes("/") ||
      trimmedId.includes("\\")
    ) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "attest-test",
        rule: "invalid_claim_id",
        detail: "--claim-id must match ^OBS-VERIFY-[A-Za-z0-9._-]{1,50}$.",
        fix: "Pass --claim-id OBS-VERIFY-<name> or omit --claim-id to auto-generate.",
      });
    }
    claimId = trimmedId;
  } else {
    const slug = sanitizeCommandSlug(executable, args);
    claimId = `OBS-VERIFY-${slug}-${env}`;
  }

  const { spawnExe, spawnArgs } = resolveWindowsSafeSpawn(executable, args);
  const startMs = performance.now();
  const spawnResult = spawnSync(spawnExe, spawnArgs, {
    cwd: realRepoRoot,
    shell: false,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BUFFER_BYTES,
    env: envVars,
  });
  const durationMs = Math.max(0, Math.round(performance.now() - startMs));

  const errCode = (spawnResult.error as NodeJS.ErrnoException | undefined)?.code;
  const timedOut = errCode === "ETIMEDOUT";
  const exitCode = typeof spawnResult.status === "number" ? spawnResult.status : 1;
  const passed = exitCode === 0 && !spawnResult.error && !spawnResult.signal;

  const stdoutText = typeof spawnResult.stdout === "string" ? spawnResult.stdout : "";
  const stderrText = typeof spawnResult.stderr === "string" ? spawnResult.stderr : "";
  const outputSha256 = sha256Hex(normalizeLf(`${stdoutText}\n${stderrText}`));
  const gitDiffStatSha256 = computeGitDiffStatHash(realRepoRoot);

  const safeCmd = sanitizeSafeCmdLabel(executable, args);
  const evidenceRef = `verifier:exit=${exitCode};cmd=${safeCmd};out=sha256:${outputSha256.slice(0, 16)};diff=sha256:${gitDiffStatSha256.slice(0, 16)}`;
  const outcomeWord = timedOut ? "TIMED_OUT" : passed ? "PASSED" : "FAILED";
  const summary = `Attested ${safeCmd} ${outcomeWord} (exit=${exitCode}, duration=${durationMs}ms, diff=${gitDiffStatSha256.slice(0, 12)}).`;

  // P1-PRG2-1: Unconditionally quarantine-verify all emitted receipt fields before returning (even --dry-run / unrecorded fail).
  assertQuarantineClean(claimId, {
    claimId,
    field: "claim_id",
    allowHashRefExemption: false,
  });
  assertQuarantineClean(safeCmd, {
    claimId,
    field: "command",
    allowHashRefExemption: false,
  });
  assertQuarantineClean(evidenceRef, {
    claimId,
    field: "evidence_ref",
    allowHashRefExemption: false,
  });
  assertQuarantineClean(summary, {
    claimId,
    field: "summary",
    allowHashRefExemption: false,
  });

  const dryRun = Boolean(options.dryRun);
  const shouldRecord = !dryRun && (passed || Boolean(options.recordFailure));
  let filePath: string | null = null;

  if (shouldRecord) {
    const obsRes = writeObservation({
      claimId,
      env,
      gitSha,
      ttlSeconds,
      ttlMode,
      summary,
      evidenceRef,
      issuer: "verifier-script",
      roles,
      priority,
      brainDir,
      repoRoot: realRepoRoot,
      ...(options.now !== undefined ? { now: options.now } : {}),
      envVars,
    });
    filePath = obsRes.filePath;
  }

  return {
    claim_id: claimId,
    passed,
    exit_code: exitCode,
    timed_out: timedOut,
    duration_ms: durationMs,
    env,
    git_sha: gitSha,
    ttl_seconds: ttlSeconds,
    ttl_mode: ttlMode,
    command: safeCmd,
    output_sha256: outputSha256,
    git_diff_stat_sha256: gitDiffStatSha256,
    evidence_ref: evidenceRef,
    summary,
    recorded: shouldRecord,
    dry_run: dryRun,
    file_path: filePath,
  };
}
