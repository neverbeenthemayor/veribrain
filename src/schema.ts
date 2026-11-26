import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import path from "node:path";
import { compareAscii, normalizeLf, normalizeText, sha256Hex } from "./normalize.js";
import {
  assertQuarantineClean,
  createQuarantineError,
  scanTextForQuarantine,
} from "./quarantine.js";
import { hasControlOrBidiChars, isValidRepoRelativeTestRef } from "./sanitize.js";
import {
  type BrainConfig,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_MAX_TOKENS,
  DEFAULT_SAFETY_MARGIN,
  type DecidedRecord,
  type DecidedStatus,
  type EnvName,
  ESTIMATOR_VERSION,
  EXIT_ERROR,
  EXIT_PROVENANCE_VIOLATION,
  EXIT_QUARANTINE_VIOLATION,
  type HypothesisRecord,
  type Issuer,
  type LoadedBrain,
  MAX_HYPOTHESIS_TTL_SECONDS,
  MAX_OBSERVED_TTL_SECONDS,
  MAX_SCAR_TTL_SECONDS,
  MAX_SCARS_BYTES,
  type ObservedRecord,
  type Priority,
  type QuarantineConfig,
  SCHEMA_VERSION,
  type ScarRecord,
  VALID_DECIDED_STATUSES,
  VALID_ENVS,
  VALID_ISSUERS,
  VALID_PRIORITIES,
  VeriBrainError,
} from "./types.js";

const DEC_ID_RE = /^DEC-[A-Za-z0-9._-]+$/;
const OBS_ID_RE = /^OBS-[A-Za-z0-9._-]+$/;
const HYP_ID_RE = /^HYP-[A-Za-z0-9._-]+$/;
const SCAR_ID_RE = /^SCAR-[A-Za-z0-9._-]+$/;
const GIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
const SHA256_LOWER_RE = /^[0-9a-f]{64}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_FUTURE_CREATED_SKEW_MS = 86_400_000;

const AGENT_SIGNER_RE =
  /(?:^|[^A-Za-z0-9])(?:agent|bot|llm|ai|claude|gpt|chatgpt|openai|anthropic|gemini|codex|copilot|cursor|antigravity|assistant|auto|automated|ci|github-actions|veribrain|mcp|unknown|anonymous|null|none)(?:$|[^A-Za-z]|(?=[0-9]))|\[bot\]$/i;
const FORBIDDEN_SIGNER_CHAR_RE = /["'()[\]]/;
const VALID_ROLE_TOKEN_RE = /^(?:\*|[A-Za-z0-9._-]{1,64})$/;

const BLOCKED_POSIX_PREFIXES = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/root",
  "/var/log",
  "/var/lib",
  "/var/run",
];

const BLOCKED_WIN_SEGMENTS = [
  "\\windows",
  "\\program files",
  "\\program files (x86)",
  "\\programdata",
  "\\system volume information",
];

export function parseBlockedIsolationSegments(
  envValue: string | undefined = process.env.VERIBRAIN_ISOLATION_SEGMENTS,
): string[] {
  if (!envValue || envValue.trim().length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of envValue.split(",")) {
    const normalized = part
      .trim()
      .toLowerCase()
      .replace(/[\s._-]+/g, "");
    if (normalized.length >= 2 && !seen.has(normalized)) {
      seen.add(normalized);
      tokens.push(normalized);
    }
  }
  return tokens;
}

export function isPathBlockedByIsolationEnv(
  rawOrResolvedPath: string,
  envValue: string | undefined = process.env.VERIBRAIN_ISOLATION_SEGMENTS,
): boolean {
  const tokens = parseBlockedIsolationSegments(envValue);
  if (tokens.length === 0) {
    return false;
  }
  const resolved = path.resolve(rawOrResolvedPath);
  for (const segment of resolved.split(/[\\/]+/)) {
    if (segment.length === 0) {
      continue;
    }
    const normSeg = segment.toLowerCase().replace(/[\s._-]+/g, "");
    if (normSeg.length === 0) {
      continue;
    }
    for (const token of tokens) {
      if (normSeg.startsWith(token)) {
        return true;
      }
    }
  }
  return false;
}

export function isUncOrDevicePath(rawPath: string): boolean {
  const trimmed = rawPath.trim();
  return trimmed.startsWith("\\\\") || trimmed.startsWith("//");
}

export function isBlockedSystemOrIsolationPath(rawOrResolvedPath: string): boolean {
  if (isUncOrDevicePath(rawOrResolvedPath)) {
    return true;
  }
  const normalized = path.resolve(rawOrResolvedPath);
  if (isUncOrDevicePath(normalized)) {
    return true;
  }
  const parsed = path.parse(normalized);
  if (parsed.root === normalized) {
    return true;
  }

  if (isPathBlockedByIsolationEnv(normalized)) {
    return true;
  }

  if (process.platform === "win32") {
    const lower = normalized.toLowerCase();
    const afterDrive = lower.replace(/^[a-z]:/, "");
    for (const seg of BLOCKED_WIN_SEGMENTS) {
      if (afterDrive === seg || afterDrive.startsWith(`${seg}\\`)) {
        return true;
      }
    }
  } else {
    for (const prefix of BLOCKED_POSIX_PREFIXES) {
      if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
        return true;
      }
    }
  }

  return false;
}

interface RawReadCacheEntry {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  content: string;
}

const MAX_READ_CACHE_ENTRIES = 512;
const STAT_CACHE_MIN_AGE_MS = 50;
const rawFileReadCache = new Map<string, RawReadCacheEntry>();

export const INVALID_ENV_FIX_HINT =
  "Accepted envs: local, pre-staging, staging, prod. Map production -> prod, development -> local.";

export interface LoadBrainOptions {
  now?: Date;
  bypassReadCache?: boolean;
  allowWorktreeFallback?: boolean;
}

export interface ResolveBrainPathsOptions {
  allowWorktreeFallback?: boolean;
}

export interface GitContext {
  worktreeRoot: string;
  gitDir: string;
  commonDir: string;
  mainRepoRoot: string;
  isWorktree: boolean;
}

const MAX_GIT_ANCESTOR_DEPTH = 8;

function pathsEqual(a: string, b: string): boolean {
  const pa = path.resolve(a);
  const pb = path.resolve(b);
  return process.platform === "win32" ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

function isPathWithinOrEqual(candidate: string, parentDir: string): boolean {
  const c = path.resolve(candidate);
  const p = path.resolve(parentDir);
  if (process.platform === "win32") {
    const cl = c.toLowerCase();
    const pl = p.toLowerCase();
    return cl === pl || cl.startsWith(`${pl}${path.sep}`);
  }
  return c === p || c.startsWith(`${p}${path.sep}`);
}

function isRegularNonSymlinkFile(filePath: string): boolean {
  try {
    const st = lstatSync(filePath);
    return !st.isSymbolicLink() && st.isFile();
  } catch {
    return false;
  }
}

function isRealNonSymlinkDir(dirPath: string): boolean {
  try {
    const st = lstatSync(dirPath);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch {
    return false;
  }
}

function hasValidGitCommonMetadata(commonDir: string): boolean {
  return (
    isRealNonSymlinkDir(path.join(commonDir, "objects")) &&
    isRegularNonSymlinkFile(path.join(commonDir, "config"))
  );
}

export function resolveGitContext(startDir: string): GitContext | null {
  if (isUncOrDevicePath(startDir)) {
    return null;
  }
  let current = path.resolve(startDir);
  if (isBlockedSystemOrIsolationPath(current)) {
    return null;
  }

  for (let depth = 0; depth <= MAX_GIT_ANCESTOR_DEPTH; depth += 1) {
    if (isBlockedSystemOrIsolationPath(current)) {
      return null;
    }
    const dotGit = path.join(current, ".git");
    try {
      const st = lstatSync(dotGit);
      if (st.isSymbolicLink()) {
        return null;
      }
      if (st.isDirectory()) {
        if (
          !isRegularNonSymlinkFile(path.join(dotGit, "HEAD")) ||
          !hasValidGitCommonMetadata(dotGit)
        ) {
          return null;
        }
        return {
          worktreeRoot: current,
          gitDir: dotGit,
          commonDir: dotGit,
          mainRepoRoot: current,
          isWorktree: false,
        };
      }
      if (st.isFile()) {
        const raw = readFileSync(dotGit, "utf8");
        const match = /^gitdir:\s*(.+)$/im.exec(raw);
        if (!match?.[1]) {
          return null;
        }
        const rawGitDir = match[1].trim();
        if (
          rawGitDir.length === 0 ||
          hasControlOrBidiChars(rawGitDir) ||
          isUncOrDevicePath(rawGitDir)
        ) {
          return null;
        }
        const gitDir = path.isAbsolute(rawGitDir)
          ? path.resolve(rawGitDir)
          : path.resolve(current, rawGitDir);
        if (isBlockedSystemOrIsolationPath(gitDir) || !isRealNonSymlinkDir(gitDir)) {
          return null;
        }
        const realGitDir = realpathSync(gitDir);
        if (isBlockedSystemOrIsolationPath(realGitDir)) {
          return null;
        }
        if (!isRegularNonSymlinkFile(path.join(gitDir, "HEAD"))) {
          return null;
        }

        let commonDir = gitDir;
        const commonDirFile = path.join(gitDir, "commondir");
        let commonDirFileStat: Stats | null = null;
        try {
          commonDirFileStat = lstatSync(commonDirFile);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            return null;
          }
        }
        if (commonDirFileStat !== null) {
          if (commonDirFileStat.isSymbolicLink() || !commonDirFileStat.isFile()) {
            return null;
          }
          const rawCommon = readFileSync(commonDirFile, "utf8").trim();
          if (
            rawCommon.length === 0 ||
            hasControlOrBidiChars(rawCommon) ||
            isUncOrDevicePath(rawCommon) ||
            path.isAbsolute(rawCommon) ||
            rawCommon.startsWith("/") ||
            rawCommon.startsWith("\\") ||
            /^[A-Za-z]:/.test(rawCommon)
          ) {
            return null;
          }
          const candidateCommon = path.resolve(gitDir, rawCommon);
          if (
            isBlockedSystemOrIsolationPath(candidateCommon) ||
            !isRealNonSymlinkDir(candidateCommon)
          ) {
            return null;
          }
          const realCommon = realpathSync(candidateCommon);
          const expectedRealCommon = path.resolve(realGitDir, rawCommon);
          if (
            isBlockedSystemOrIsolationPath(realCommon) ||
            !pathsEqual(realCommon, expectedRealCommon)
          ) {
            return null;
          }
          commonDir = candidateCommon;
        } else if (path.basename(path.dirname(gitDir)).toLowerCase() === "worktrees") {
          const candidateCommon = path.resolve(gitDir, "..", "..");
          if (
            isBlockedSystemOrIsolationPath(candidateCommon) ||
            !isRealNonSymlinkDir(candidateCommon)
          ) {
            return null;
          }
          const realCommon = realpathSync(candidateCommon);
          const expectedRealCommon = path.resolve(realGitDir, "..", "..");
          if (
            isBlockedSystemOrIsolationPath(realCommon) ||
            !pathsEqual(realCommon, expectedRealCommon)
          ) {
            return null;
          }
          commonDir = candidateCommon;
        }

        if (!hasValidGitCommonMetadata(commonDir)) {
          return null;
        }
        const mainRepoRoot =
          path.basename(commonDir).toLowerCase() === ".git" ? path.dirname(commonDir) : commonDir;
        if (isBlockedSystemOrIsolationPath(mainRepoRoot)) {
          return null;
        }
        return {
          worktreeRoot: current,
          gitDir,
          commonDir,
          mainRepoRoot,
          isWorktree: !pathsEqual(mainRepoRoot, current),
        };
      }
    } catch {
      // No .git at this ancestor or unreadable; walk upward.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

export function resolveWorktreeHeadSha(startDir: string): string | null {
  const ctx = resolveGitContext(startDir);
  if (ctx === null) {
    return null;
  }
  const headCandidates = [path.join(ctx.gitDir, "HEAD"), path.join(ctx.commonDir, "HEAD")];
  let headRaw: string | null = null;
  for (const candidate of headCandidates) {
    if (isRegularNonSymlinkFile(candidate)) {
      try {
        headRaw = readFileSync(candidate, "utf8").trim();
        break;
      } catch {
        // Try next candidate.
      }
    }
  }
  if (headRaw === null || headRaw.length === 0) {
    return null;
  }
  if (GIT_SHA_RE.test(headRaw)) {
    return headRaw.toLowerCase();
  }
  if (!headRaw.toLowerCase().startsWith("ref:")) {
    return null;
  }
  const refName = headRaw.slice(4).trim();
  if (
    refName.length === 0 ||
    refName.includes("..") ||
    refName.includes("\\") ||
    refName.startsWith("/") ||
    hasControlOrBidiChars(refName)
  ) {
    return null;
  }

  for (const baseDir of [ctx.gitDir, ctx.commonDir]) {
    const looseRefPath = path.resolve(baseDir, refName);
    if (!isPathWithinOrEqual(looseRefPath, baseDir)) {
      continue;
    }
    if (isRegularNonSymlinkFile(looseRefPath)) {
      try {
        const refVal = readFileSync(looseRefPath, "utf8").trim();
        if (GIT_SHA_RE.test(refVal)) {
          return refVal.toLowerCase();
        }
      } catch {
        // Continue to packed-refs fallback.
      }
    }
  }

  const packedRefsPath = path.join(ctx.commonDir, "packed-refs");
  if (isRegularNonSymlinkFile(packedRefsPath)) {
    try {
      const lines = normalizeLf(readFileSync(packedRefsPath, "utf8")).split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("^")) {
          continue;
        }
        const spaceIdx = trimmed.indexOf(" ");
        if (spaceIdx <= 0) {
          continue;
        }
        const sha = trimmed.slice(0, spaceIdx).trim();
        const ref = trimmed.slice(spaceIdx + 1).trim();
        if (ref === refName && GIT_SHA_RE.test(sha)) {
          return sha.toLowerCase();
        }
      }
    } catch {
      // No readable packed-refs.
    }
  }

  return null;
}

export function clearFileReadCache(): void {
  rawFileReadCache.clear();
}

export function invalidateFileReadCache(filePath: string): void {
  rawFileReadCache.delete(path.resolve(filePath));
}

export function readFileUtf8Cached(filePath: string, bypassReadCache = false): string {
  const absPath = path.resolve(filePath);
  if (bypassReadCache) {
    return readFileSync(absPath, "utf8");
  }
  const st = statSync(absPath);
  const ageMs = Date.now() - st.mtimeMs;
  const cached = rawFileReadCache.get(absPath);
  if (
    cached !== undefined &&
    ageMs >= STAT_CACHE_MIN_AGE_MS &&
    cached.dev === st.dev &&
    cached.ino === st.ino &&
    cached.size === st.size &&
    cached.mtimeMs === st.mtimeMs &&
    cached.ctimeMs === st.ctimeMs
  ) {
    return cached.content;
  }

  const content = readFileSync(absPath, "utf8");
  if (ageMs >= STAT_CACHE_MIN_AGE_MS) {
    if (rawFileReadCache.size >= MAX_READ_CACHE_ENTRIES) {
      const oldestKey = rawFileReadCache.keys().next().value;
      if (oldestKey !== undefined) {
        rawFileReadCache.delete(oldestKey);
      }
    }
    rawFileReadCache.set(absPath, {
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
      content,
    });
  }
  return content;
}

export function resolveBrainPaths(
  brainDir?: string,
  repoRoot?: string,
  options?: ResolveBrainPathsOptions,
): {
  repoRoot: string;
  brainDir: string;
} {
  const resolvedRepoRoot = path.resolve(repoRoot ?? process.cwd());
  if (brainDir) {
    const resolvedBrainDir = path.isAbsolute(brainDir)
      ? path.resolve(brainDir)
      : path.resolve(resolvedRepoRoot, brainDir);
    return { repoRoot: resolvedRepoRoot, brainDir: resolvedBrainDir };
  }

  const localBrainDir = path.resolve(resolvedRepoRoot, ".brain");
  if (existsSync(localBrainDir) || options?.allowWorktreeFallback === false) {
    return { repoRoot: resolvedRepoRoot, brainDir: localBrainDir };
  }

  const gitCtx = resolveGitContext(resolvedRepoRoot);
  if (gitCtx?.isWorktree) {
    const primaryBrain = path.resolve(gitCtx.mainRepoRoot, ".brain");
    try {
      if (existsSync(primaryBrain) && statSync(primaryBrain).isDirectory()) {
        const realMain = realpathSync(gitCtx.mainRepoRoot);
        const realBrain = realpathSync(primaryBrain);
        const expectedBrain = path.join(realMain, ".brain");
        if (pathsEqual(realBrain, expectedBrain)) {
          return { repoRoot: resolvedRepoRoot, brainDir: realBrain };
        }
      }
    } catch {
      // Fall through to default local .brain path.
    }
  }

  return { repoRoot: resolvedRepoRoot, brainDir: localBrainDir };
}

export function hasForbiddenSignerSyntax(raw: string): boolean {
  return (
    hasControlOrBidiChars(raw) ||
    raw.includes("\n") ||
    raw.includes("\r") ||
    raw.includes(":") ||
    FORBIDDEN_SIGNER_CHAR_RE.test(raw) ||
    raw.normalize("NFKC") !== raw
  );
}

export function isAgentSigner(signedBy: string): boolean {
  const normalized = signedBy.normalize("NFKC").trim();
  if (normalized.length === 0) {
    return true;
  }
  return AGENT_SIGNER_RE.test(normalized);
}

export function isAgentEnvironment(envVars: NodeJS.ProcessEnv = process.env): boolean {
  const agentFlag = (envVars.VERIBRAIN_AGENT ?? "").trim().toLowerCase();
  if (agentFlag === "1" || agentFlag === "true" || agentFlag === "yes") {
    return true;
  }
  const mode = (envVars.VERIBRAIN_AGENT_MODE ?? "").trim().toLowerCase();
  if (mode === "1" || mode === "true" || mode === "yes") {
    return true;
  }
  const callerRole = (envVars.VERIBRAIN_CALLER_ROLE ?? "").trim();
  if (
    callerRole.length > 0 &&
    (callerRole.toLowerCase() === "agent" || isAgentSigner(callerRole))
  ) {
    return true;
  }
  return false;
}

export interface AssertHumanProvenanceOptions {
  claimId: string;
  signedBy?: string;
  requireSignedBy?: boolean;
  issuer?: string;
  envVars?: NodeJS.ProcessEnv;
  config?: QuarantineConfig;
}

export function assertHumanProvenance(options: AssertHumanProvenanceOptions): string | undefined {
  const envVars = options.envVars ?? process.env;
  if (isAgentEnvironment(envVars)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: options.claimId,
      rule: "agent_self_attestation_denied",
      detail: "Agents cannot perform human-only governance actions (fail-closed provenance).",
      fix: "Have a human owner run this command outside agent mode.",
    });
  }

  if (options.issuer !== undefined) {
    if (options.issuer.trim().toLowerCase() !== "human") {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: options.claimId,
        rule: "non_human_issuer_denied",
        detail:
          "This governance command requires --issuer human (non-human or empty issuers denied).",
        fix: "Omit --issuer or pass --issuer human as a human reviewer.",
      });
    }
  }

  if (options.signedBy !== undefined || options.requireSignedBy) {
    const raw = options.signedBy ?? "";
    if (hasForbiddenSignerSyntax(raw)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: options.claimId,
        rule: "invalid_signed_by",
        detail:
          "--signed-by cannot contain control chars, quotes, brackets, colons, or NFKC-unstable characters.",
        fix: 'Pass a plain human name via --signed-by "Human Owner".',
      });
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0 || isAgentSigner(trimmed)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: options.claimId,
        rule: "agent_signed_decided",
        detail: "--signed-by must be a non-empty human owner name (agent/unknown names denied).",
        fix: 'Pass a human reviewer name via --signed-by "Human Owner".',
      });
    }
    assertQuarantineClean(trimmed, {
      claimId: options.claimId,
      field: "signed_by",
      ...(options.config !== undefined ? { config: options.config } : {}),
      allowHashRefExemption: false,
    });
    return trimmed;
  }

  return undefined;
}

export type ClaimIdPrefix = "DEC" | "OBS" | "SCAR" | "HYP";

const STRICT_CLAIM_ID_RE = /^(?:DEC|OBS|SCAR|HYP)-[A-Za-z0-9._-]{1,60}$/;

export function assertValidClaimId(
  claimId: string,
  expectedPrefix?: ClaimIdPrefix,
  config?: QuarantineConfig,
): string {
  const trimmed = claimId.trim();
  assertQuarantineClean(trimmed, {
    claimId: trimmed,
    field: "claim_id",
    ...(config !== undefined ? { config } : {}),
    allowHashRefExemption: false,
  });

  if (
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    hasControlOrBidiChars(trimmed)
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: expectedPrefix ? `${expectedPrefix}-invalid` : "claim_id",
      rule: "invalid_claim_id",
      detail: "Claim ID must not contain path traversal characters or control sequences.",
      fix: `Pass a valid ${expectedPrefix ?? "DEC|OBS|SCAR|HYP"}-* identifier (<= 64 chars).`,
    });
  }

  const prefixOk =
    expectedPrefix === undefined
      ? STRICT_CLAIM_ID_RE.test(trimmed)
      : trimmed.startsWith(`${expectedPrefix}-`) &&
        STRICT_CLAIM_ID_RE.test(trimmed) &&
        trimmed.length <= expectedPrefix.length + 1 + 60;

  if (!prefixOk) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: expectedPrefix ? `${expectedPrefix}-invalid` : "claim_id",
      rule: "invalid_claim_id",
      detail: `Claim ID must match ^${expectedPrefix ?? "(?:DEC|OBS|SCAR|HYP)"}-[A-Za-z0-9._-]{1,60}$.`,
      fix: `Pass a valid ${expectedPrefix ?? "DEC|OBS|SCAR|HYP"}-* identifier.`,
    });
  }

  return trimmed;
}

export function parseIsoTimestampMs(value: string): number | null {
  if (!ISO_UTC_RE.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function isValidEnv(value: string): value is EnvName {
  return (VALID_ENVS as readonly string[]).includes(value);
}

export function isValidPriority(value: string): value is Priority {
  return (VALID_PRIORITIES as readonly string[]).includes(value);
}

export function isValidIssuer(value: string): value is Issuer {
  return (VALID_ISSUERS as readonly string[]).includes(value);
}

export function isValidDecidedStatus(value: string): value is DecidedStatus {
  return (VALID_DECIDED_STATUSES as readonly string[]).includes(value);
}

export function isValidGitSha(value: string): boolean {
  return GIT_SHA_RE.test(value);
}

export function isValidObsId(value: string): boolean {
  return OBS_ID_RE.test(value);
}

export function defaultQuarantineConfig(): QuarantineConfig {
  return {
    allowed_emails: [],
    allowed_domains: [],
    allowed_phones: [],
  };
}

export function defaultBrainConfig(): BrainConfig {
  return {
    schema_version: SCHEMA_VERSION,
    estimator_version: ESTIMATOR_VERSION,
    chars_per_token: DEFAULT_CHARS_PER_TOKEN,
    safety_margin: DEFAULT_SAFETY_MARGIN,
    default_max_tokens: DEFAULT_MAX_TOKENS,
    pinned_ids: [],
    quarantine: defaultQuarantineConfig(),
  };
}

function asStringArray(value: unknown, claimId: string, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId,
      rule: `invalid_${field}`,
      detail: `Field ${field} must be an array of strings.`,
      fix: `Fix ${field} in ${claimId}.`,
    });
  }
  return value.map((v) => v.trim()).filter((v) => v.length > 0);
}

const SAFE_JSON_FIELD_KEY_RE = /^[A-Za-z0-9_-]{1,48}$/;

function scanDecodedJsonStrings(
  value: unknown,
  claimId: string,
  config: QuarantineConfig,
  field?: string,
  validatedGitSha?: string,
  isObservedRecord = false,
  depth = 0,
): void {
  if (typeof value === "string") {
    const isTopLevelObserved = isObservedRecord && depth === 1;
    const isValidatedGitSha =
      isTopLevelObserved &&
      field === "git_sha" &&
      validatedGitSha !== undefined &&
      value.trim().toLowerCase() === validatedGitSha.toLowerCase();
    const allowHashRefExemption = isTopLevelObserved && field === "evidence_ref";
    assertQuarantineClean(value, {
      claimId,
      ...(field !== undefined ? { field } : {}),
      config,
      allowHashRefExemption,
      ...(isValidatedGitSha
        ? { allowlistedHashTokens: new Set([validatedGitSha.toLowerCase()]) }
        : {}),
    });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      scanDecodedJsonStrings(
        item,
        claimId,
        config,
        field,
        validatedGitSha,
        isObservedRecord,
        depth + 1,
      );
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      assertQuarantineClean(key, {
        claimId,
        field: "json_object_key",
        config,
        allowHashRefExemption: false,
      });
      const safeChildField = SAFE_JSON_FIELD_KEY_RE.test(key) ? key : "<redacted-key>";
      scanDecodedJsonStrings(
        nested,
        claimId,
        config,
        safeChildField,
        validatedGitSha,
        isObservedRecord,
        depth + 1,
      );
    }
  }
}

export function loadBrainConfig(brainDir: string, bypassReadCache = false): BrainConfig {
  const configPath = path.join(brainDir, "config.json");
  let raw: string;
  try {
    raw = readFileUtf8Cached(configPath, bypassReadCache);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "MISSING_BRAIN",
        claimId: "config.json",
        rule: "missing_config",
        detail: `Brain config not found at ${configPath}.`,
        fix: "Run veribrain init to scaffold .brain/config.json.",
      });
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    assertQuarantineClean(raw, { claimId: "config.json" });
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: "config.json",
      rule: "invalid_json",
      detail: "Failed to parse .brain/config.json as valid JSON.",
      fix: "Fix JSON syntax in .brain/config.json.",
    });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    assertQuarantineClean(raw, { claimId: "config.json" });
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: "config.json",
      rule: "invalid_config_root",
      detail: ".brain/config.json root must be a JSON object.",
      fix: "Run veribrain init to regenerate .brain/config.json.",
    });
  }

  const obj = parsed as Record<string, unknown>;
  const rawQuarantine = obj.quarantine;
  let quarantine: QuarantineConfig = defaultQuarantineConfig();
  if (rawQuarantine !== undefined) {
    if (
      rawQuarantine === null ||
      typeof rawQuarantine !== "object" ||
      Array.isArray(rawQuarantine)
    ) {
      assertQuarantineClean(raw, { claimId: "config.json" });
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "SCHEMA_ERROR",
        claimId: "config.json",
        rule: "invalid_quarantine_config",
        detail: "config.quarantine must be an object.",
        fix: "Set quarantine to { allowed_emails, allowed_domains, allowed_phones }.",
      });
    }
    const qObj = rawQuarantine as Record<string, unknown>;
    quarantine = {
      allowed_emails:
        qObj.allowed_emails === undefined
          ? []
          : asStringArray(qObj.allowed_emails, "config.json", "allowed_emails").map((s) =>
              s.toLowerCase(),
            ),
      allowed_domains:
        qObj.allowed_domains === undefined
          ? []
          : asStringArray(qObj.allowed_domains, "config.json", "allowed_domains").map((s) =>
              s.toLowerCase(),
            ),
      allowed_phones:
        qObj.allowed_phones === undefined
          ? []
          : asStringArray(qObj.allowed_phones, "config.json", "allowed_phones").map((s) =>
              s.toLowerCase(),
            ),
    };
  }

  scanDecodedJsonStrings(parsed, "config.json", quarantine);
  assertQuarantineClean(raw, { claimId: "config.json", config: quarantine });

  if (obj.schema_version !== SCHEMA_VERSION) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: "config.json",
      rule: "invalid_schema_version",
      detail: `Unsupported schema_version (expected ${SCHEMA_VERSION}).`,
      fix: `Set "schema_version": "${SCHEMA_VERSION}" in .brain/config.json.`,
    });
  }

  const estimatorVersion =
    typeof obj.estimator_version === "string" && obj.estimator_version.trim().length > 0
      ? obj.estimator_version.trim()
      : ESTIMATOR_VERSION;

  const charsPerToken =
    obj.chars_per_token === undefined ? DEFAULT_CHARS_PER_TOKEN : obj.chars_per_token;
  if (typeof charsPerToken !== "number" || !Number.isFinite(charsPerToken) || charsPerToken <= 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: "config.json",
      rule: "invalid_chars_per_token",
      detail: "chars_per_token must be a positive finite number.",
      fix: "Set chars_per_token to 3.5 in .brain/config.json.",
    });
  }

  const safetyMargin = obj.safety_margin === undefined ? DEFAULT_SAFETY_MARGIN : obj.safety_margin;
  if (typeof safetyMargin !== "number" || !Number.isFinite(safetyMargin) || safetyMargin < 1.0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: "config.json",
      rule: "invalid_safety_margin",
      detail: "safety_margin must be a finite number >= 1.0.",
      fix: "Set safety_margin to 1.15 in .brain/config.json.",
    });
  }

  const defaultMaxTokens =
    obj.default_max_tokens === undefined ? DEFAULT_MAX_TOKENS : obj.default_max_tokens;
  if (
    typeof defaultMaxTokens !== "number" ||
    !Number.isInteger(defaultMaxTokens) ||
    defaultMaxTokens <= 0
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: "config.json",
      rule: "invalid_default_max_tokens",
      detail: "default_max_tokens must be a positive integer.",
      fix: "Set default_max_tokens to 8192 in .brain/config.json.",
    });
  }

  const pinnedIds =
    obj.pinned_ids === undefined ? [] : asStringArray(obj.pinned_ids, "config.json", "pinned_ids");

  let semanticKeys: Record<string, string | number | boolean> | undefined;
  if (obj.semantic_keys !== undefined) {
    if (
      obj.semantic_keys === null ||
      typeof obj.semantic_keys !== "object" ||
      Array.isArray(obj.semantic_keys)
    ) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "SCHEMA_ERROR",
        claimId: "config.json",
        rule: "invalid_semantic_keys",
        detail: "semantic_keys must be a flat primitive map.",
        fix: "Use string, number, or boolean values in semantic_keys.",
      });
    }
    semanticKeys = {};
    for (const [k, v] of Object.entries(obj.semantic_keys as Record<string, unknown>)) {
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        throw new VeriBrainError({
          exitCode: EXIT_ERROR,
          code: "SCHEMA_ERROR",
          claimId: "config.json",
          rule: "invalid_semantic_keys",
          detail: `semantic_keys.${k} must be a string, number, or boolean.`,
          fix: "Use primitive values in semantic_keys.",
        });
      }
      semanticKeys[k] = v;
    }
  }

  const mirrorDirs =
    obj.mirror_dirs === undefined
      ? undefined
      : asStringArray(obj.mirror_dirs, "config.json", "mirror_dirs");

  const cfg: BrainConfig = {
    schema_version: SCHEMA_VERSION,
    estimator_version: estimatorVersion,
    chars_per_token: charsPerToken,
    safety_margin: safetyMargin,
    default_max_tokens: defaultMaxTokens,
    pinned_ids: pinnedIds,
    quarantine,
  };
  if (semanticKeys !== undefined) {
    cfg.semantic_keys = semanticKeys;
  }
  if (mirrorDirs !== undefined) {
    cfg.mirror_dirs = mirrorDirs;
  }
  return cfg;
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export interface ParsedFrontmatter {
  fields: Map<string, string | string[]>;
  fieldLines: Map<string, number>;
  body: string;
  bodyStartLine: number;
}

export function parseFrontmatter(raw: string, claimId: string): ParsedFrontmatter {
  const lf = normalizeLf(raw);
  const lines = lf.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId,
      rule: "missing_frontmatter",
      detail: "Decided file must start with YAML frontmatter delimiter ---.",
      fix: `Add valid frontmatter header to ${claimId}.`,
    });
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId,
      rule: "unterminated_frontmatter",
      detail: "Decided frontmatter missing closing --- delimiter.",
      fix: `Close YAML frontmatter with --- in ${claimId}.`,
    });
  }

  const fields = new Map<string, string | string[]>();
  const fieldLines = new Map<string, number>();
  let activeArrayKey: string | null = null;

  for (let i = 1; i < endIdx; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    if (activeArrayKey !== null && /^\s+-\s+/.test(line)) {
      const item = unquoteYamlScalar(trimmed.slice(1).trim());
      const existing = fields.get(activeArrayKey);
      if (Array.isArray(existing) && item.length > 0) {
        existing.push(item);
      }
      continue;
    }
    activeArrayKey = null;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "SCHEMA_ERROR",
        claimId,
        rule: "invalid_frontmatter_line",
        line: i + 1,
        detail: `Invalid frontmatter entry at line ${i + 1}.`,
        fix: `Use key: value syntax at line ${i + 1} in ${claimId}.`,
      });
    }
    const key = trimmed.slice(0, colonIdx).trim();
    if (fields.has(key)) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "SCHEMA_ERROR",
        claimId,
        rule: "duplicate_frontmatter_key",
        line: i + 1,
        detail: `Duplicate frontmatter key "${key}" at line ${i + 1}.`,
        fix: `Remove duplicate "${key}" entry in ${claimId}.`,
      });
    }
    const rest = trimmed.slice(colonIdx + 1).trim();
    fieldLines.set(key, i + 1);
    if (rest.length === 0) {
      fields.set(key, []);
      activeArrayKey = key;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim();
      const items =
        inner.length === 0
          ? []
          : inner
              .split(",")
              .map((part) => unquoteYamlScalar(part))
              .filter((part) => part.length > 0);
      fields.set(key, items);
    } else {
      fields.set(key, unquoteYamlScalar(rest));
    }
  }

  const body = lines.slice(endIdx + 1).join("\n");
  return { fields, fieldLines, body, bodyStartLine: endIdx + 2 };
}

const FRONTMATTER_SHA256_LINE_RE = /^\s*sha256_body\s*:\s*["']?([0-9a-f]{64})["']?\s*$/i;
const FRONTMATTER_ID_LINE_RE = /^\s*id\s*:\s*["']?([^"'\s#]+)["']?\s*$/i;

function extractFrontmatterFallbackHints(
  raw: string,
  allowlistedLineTokens: Map<number, Set<string>>,
): string | null {
  const lines = normalizeLf(raw).split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    return null;
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return null;
  }
  let idHint: string | null = null;
  for (let i = 1; i < endIdx; i += 1) {
    const line = lines[i] ?? "";
    const shaMatch = FRONTMATTER_SHA256_LINE_RE.exec(line);
    if (shaMatch?.[1]) {
      const existing = allowlistedLineTokens.get(i + 1) ?? new Set<string>();
      existing.add(shaMatch[1].toLowerCase());
      allowlistedLineTokens.set(i + 1, existing);
    }
    if (idHint === null) {
      const idMatch = FRONTMATTER_ID_LINE_RE.exec(line);
      if (idMatch?.[1]) {
        idHint = idMatch[1];
      }
    }
  }
  return idHint;
}

export function parseDecidedFile(
  filePath: string,
  config: QuarantineConfig,
  bypassReadCache = false,
): DecidedRecord {
  const fileName = path.basename(filePath);
  const raw = readFileUtf8Cached(filePath, bypassReadCache);

  let claimIdHint = fileName;
  const allowlistedLineTokens = new Map<number, Set<string>>();
  let parsedFrontmatter: ParsedFrontmatter | null = null;
  let frontmatterError: unknown = null;

  try {
    parsedFrontmatter = parseFrontmatter(raw, fileName);
    const rawId = parsedFrontmatter.fields.get("id");
    if (typeof rawId === "string" && rawId.length > 0) {
      claimIdHint = rawId;
    }
    const rawSha = parsedFrontmatter.fields.get("sha256_body");
    const shaLine = parsedFrontmatter.fieldLines.get("sha256_body");
    if (typeof rawSha === "string" && SHA256_LOWER_RE.test(rawSha) && shaLine !== undefined) {
      allowlistedLineTokens.set(shaLine, new Set([rawSha.toLowerCase()]));
    }
  } catch (err) {
    frontmatterError = err;
    const fallbackId = extractFrontmatterFallbackHints(raw, allowlistedLineTokens);
    if (fallbackId !== null) {
      claimIdHint = fallbackId;
    }
  }

  const qViolation = scanTextForQuarantine(raw, {
    claimId: claimIdHint,
    config,
    allowlistedLineTokens,
  });
  if (qViolation !== null) {
    throw createQuarantineError(qViolation, config);
  }

  if (frontmatterError !== null || parsedFrontmatter === null) {
    throw frontmatterError;
  }

  const { fields, body } = parsedFrontmatter;
  const getString = (key: string): string => {
    const val = fields.get(key);
    if (typeof val !== "string" || val.trim().length === 0) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "SCHEMA_ERROR",
        claimId: claimIdHint,
        rule: `missing_${key}`,
        detail: `Decided frontmatter missing required string field ${key}.`,
        fix: `Add ${key} to frontmatter in ${fileName}.`,
      });
    }
    return val.trim();
  };

  const id = getString("id");
  if (!DEC_ID_RE.test(id)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "invalid_decided_id",
      detail: "Decided id must match ^DEC-[A-Za-z0-9._-]+$.",
      fix: `Rename id in ${fileName} to start with DEC-.`,
    });
  }

  const priorityStr = getString("priority");
  if (!isValidPriority(priorityStr)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "invalid_priority",
      detail: "Decided priority must be P0, P1, or P2.",
      fix: `Set priority to P0, P1, or P2 in ${fileName}.`,
    });
  }

  const rawRoles = fields.get("roles");
  const roles = Array.isArray(rawRoles)
    ? rawRoles
    : typeof rawRoles === "string"
      ? rawRoles
          .split(",")
          .map((r) => r.trim())
          .filter((r) => r.length > 0)
      : [];
  if (roles.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "missing_roles",
      detail: "Decided frontmatter requires a non-empty roles list.",
      fix: `Add roles: [builder] to ${fileName}.`,
    });
  }

  const signedBy = getString("signed_by");
  if (hasForbiddenSignerSyntax(signedBy) || isAgentSigner(signedBy)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: id,
      rule: "agent_signed_decided",
      detail: "DECIDED records require a human signed_by identity (agents denied).",
      fix: `Have a human owner review and sign ${fileName} with a human signed_by.`,
    });
  }

  const signedAtUtc = getString("signed_at_utc");
  if (parseIsoTimestampMs(signedAtUtc) === null) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "invalid_signed_at_utc",
      detail: "signed_at_utc must be a valid ISO-8601 UTC timestamp.",
      fix: `Set signed_at_utc to YYYY-MM-DDTHH:MM:SSZ in ${fileName}.`,
    });
  }

  const sha256Body = getString("sha256_body");
  if (!SHA256_LOWER_RE.test(sha256Body)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: id,
      rule: "invalid_sha256_body_format",
      detail: "sha256_body must be a 64-character lowercase hex SHA-256 digest.",
      fix: `Recompute sha256_body for ${fileName} after human review.`,
    });
  }

  const statusStr = getString("status");
  if (!isValidDecidedStatus(statusStr)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "invalid_status",
      detail: "Decided status must be active or superseded.",
      fix: `Set status to active or superseded in ${fileName}.`,
    });
  }

  const normalizedRawBody = normalizeText(body);
  const normalizedTrimmedBody = normalizedRawBody.trim();
  if (normalizedTrimmedBody.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "empty_decided_body",
      detail: "Decided rule body cannot be empty.",
      fix: `Add policy content below frontmatter in ${fileName}.`,
    });
  }

  const validHashes = new Set([
    sha256Hex(normalizedTrimmedBody),
    sha256Hex(normalizedRawBody),
    sha256Hex(`${normalizedTrimmedBody}\n`),
  ]);
  if (!validHashes.has(sha256Body)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: id,
      rule: "sha256_body_mismatch",
      detail: "Decided body hash does not match signed sha256_body frontmatter.",
      fix: `Restore original body or re-sign ${fileName} with updated sha256_body.`,
    });
  }

  const rawEnvs = fields.get("envs");
  const envs = Array.isArray(rawEnvs)
    ? rawEnvs
    : typeof rawEnvs === "string"
      ? rawEnvs
          .split(",")
          .map((e) => e.trim())
          .filter((e) => e.length > 0)
      : undefined;
  const rawTitle = fields.get("title");
  const title =
    typeof rawTitle === "string" && rawTitle.trim().length > 0 ? rawTitle.trim() : undefined;
  const rawSupersedes = fields.get("supersedes");
  const supersedes =
    typeof rawSupersedes === "string" && rawSupersedes.trim().length > 0
      ? rawSupersedes.trim()
      : undefined;

  const decidedRecord: DecidedRecord = {
    id,
    priority: priorityStr,
    roles,
    signed_by: signedBy,
    signed_at_utc: signedAtUtc,
    sha256_body: sha256Body,
    status: statusStr,
    body: normalizedTrimmedBody,
    source_file: filePath,
  };
  if (envs !== undefined && envs.length > 0) {
    decidedRecord.envs = envs;
  }
  if (title !== undefined) {
    decidedRecord.title = title;
  }
  if (supersedes !== undefined) {
    decidedRecord.supersedes = supersedes;
  }
  return decidedRecord;
}

export function parseObservedFile(
  filePath: string,
  config: QuarantineConfig,
  bypassReadCache = false,
): ObservedRecord {
  const fileName = path.basename(filePath);
  const raw = readFileUtf8Cached(filePath, bypassReadCache);

  let parsed: unknown;
  let claimIdHint = fileName;
  let validatedGitSha: string | undefined;
  const allowlistedLineTokens = new Map<number, Set<string>>();
  const allowHashRefLineNumbers = new Set<number>();

  try {
    parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.claim_id === "string" && obj.claim_id.length > 0) {
        claimIdHint = obj.claim_id;
      }
      if (typeof obj.git_sha === "string" && GIT_SHA_RE.test(obj.git_sha)) {
        validatedGitSha = obj.git_sha;
      }
      const lines = normalizeLf(raw).split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (validatedGitSha !== undefined && line.includes('"git_sha"')) {
          allowlistedLineTokens.set(i + 1, new Set([validatedGitSha.toLowerCase()]));
        }
        if (line.includes('"evidence_ref"')) {
          allowHashRefLineNumbers.add(i + 1);
        }
      }
    }
  } catch {
    parsed = undefined;
  }

  if (parsed !== undefined) {
    scanDecodedJsonStrings(parsed, claimIdHint, config, undefined, validatedGitSha, true, 0);
  }

  const qViolation = scanTextForQuarantine(raw, {
    claimId: claimIdHint,
    config,
    allowlistedLineTokens,
    allowHashRefLineNumbers,
  });
  if (qViolation !== null) {
    throw createQuarantineError(qViolation, config);
  }

  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: claimIdHint,
      rule: "invalid_observed_json",
      detail: `Observed record ${fileName} must be a valid JSON object.`,
      fix: `Regenerate ${fileName} using veribrain observe.`,
    });
  }

  const obj = parsed as Record<string, unknown>;
  const claimId = typeof obj.claim_id === "string" ? obj.claim_id.trim() : "";
  if (!OBS_ID_RE.test(claimId)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: claimId || fileName,
      rule: "invalid_claim_id",
      detail: "Observed claim_id must match ^OBS-[A-Za-z0-9._-]+$.",
      fix: "Use veribrain observe --claim-id OBS-<name>.",
    });
  }

  const issuer = typeof obj.issuer === "string" ? obj.issuer.trim() : "";
  if (!isValidIssuer(issuer)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "invalid_observed_issuer",
      detail: "Observed issuer must be ci, git-hook, or verifier-script.",
      fix: "Record observations via CI or hook using --issuer ci|git-hook|verifier-script.",
    });
  }

  const env = typeof obj.env === "string" ? obj.env.trim() : "";
  if (!isValidEnv(env)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId,
      rule: "invalid_env",
      detail: "Observed env must be local, pre-staging, staging, or prod.",
      fix: INVALID_ENV_FIX_HINT,
    });
  }

  const gitSha = typeof obj.git_sha === "string" ? obj.git_sha.trim() : "";
  if (!GIT_SHA_RE.test(gitSha)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId,
      rule: "invalid_git_sha",
      detail: "Observed git_sha must be 7-40 hex characters.",
      fix: `Provide a valid git commit SHA in ${fileName}.`,
    });
  }

  const observedAtUtc = typeof obj.observed_at_utc === "string" ? obj.observed_at_utc.trim() : "";
  if (parseIsoTimestampMs(observedAtUtc) === null) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId,
      rule: "invalid_observed_at_utc",
      detail: "observed_at_utc must be a valid ISO-8601 UTC timestamp.",
      fix: `Set ISO-8601 UTC timestamp in ${fileName}.`,
    });
  }

  const ttlSeconds = obj.ttl_seconds;
  if (
    typeof ttlSeconds !== "number" ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > MAX_OBSERVED_TTL_SECONDS
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId,
      rule: "invalid_ttl_seconds",
      detail: `ttl_seconds must be an integer between 1 and ${MAX_OBSERVED_TTL_SECONDS}.`,
      fix: `Set ttl_seconds in range 1..${MAX_OBSERVED_TTL_SECONDS} in ${fileName}.`,
    });
  }

  const roles = asStringArray(obj.roles, claimId, "roles");
  if (roles.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId,
      rule: "missing_roles",
      detail: "Observed record requires a non-empty roles array.",
      fix: `Add roles array in ${fileName}.`,
    });
  }

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (summary.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId,
      rule: "missing_summary",
      detail: "Observed summary must be a non-empty string.",
      fix: `Provide a factual summary in ${fileName}.`,
    });
  }

  const evidenceRef = typeof obj.evidence_ref === "string" ? obj.evidence_ref.trim() : "";
  if (evidenceRef.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId,
      rule: "missing_evidence_ref",
      detail: "Observed evidence_ref must be a non-empty string.",
      fix: `Provide a verifiable evidence_ref in ${fileName}.`,
    });
  }

  let priority: Priority = "P2";
  if (obj.priority !== undefined) {
    if (typeof obj.priority !== "string" || !isValidPriority(obj.priority)) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "SCHEMA_ERROR",
        claimId,
        rule: "invalid_priority",
        detail: "Observed priority must be P0, P1, or P2 when specified.",
        fix: `Set priority to P0, P1, or P2 in ${fileName}.`,
      });
    }
    priority = obj.priority;
  }

  return {
    claim_id: claimId,
    env,
    git_sha: gitSha,
    observed_at_utc: observedAtUtc,
    ttl_seconds: ttlSeconds,
    issuer,
    roles,
    summary,
    evidence_ref: evidenceRef,
    priority,
    source_file: filePath,
  };
}

export function parseHypothesisFile(
  filePath: string,
  config: QuarantineConfig,
  options?: LoadBrainOptions,
): HypothesisRecord {
  const fileName = path.basename(filePath);
  const raw = readFileUtf8Cached(filePath, Boolean(options?.bypassReadCache));
  const nowMs = (options?.now ?? new Date()).getTime();

  let parsed: unknown;
  let claimIdHint = fileName;
  try {
    parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const rawId =
        typeof obj.id === "string" ? obj.id : typeof obj.claim_id === "string" ? obj.claim_id : "";
      if (rawId.length > 0) {
        claimIdHint = rawId;
      }
    }
  } catch {
    parsed = undefined;
  }

  if (parsed !== undefined) {
    scanDecodedJsonStrings(parsed, claimIdHint, config);
  }
  assertQuarantineClean(raw, { claimId: claimIdHint, config });

  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: claimIdHint,
      rule: "invalid_hypothesis_json",
      detail: `Hypothesis ${fileName} must be a valid JSON object.`,
      fix: `Fix JSON syntax in ${fileName}.`,
    });
  }

  const obj = parsed as Record<string, unknown>;
  const id =
    typeof obj.id === "string"
      ? obj.id.trim()
      : typeof obj.claim_id === "string"
        ? obj.claim_id.trim()
        : "";
  if (!HYP_ID_RE.test(id)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id || fileName,
      rule: "invalid_hypothesis_id",
      detail: "Hypothesis id must match ^HYP-[A-Za-z0-9._-]+$.",
      fix: `Set id starting with HYP- in ${fileName}.`,
    });
  }

  const createdAtUtc = typeof obj.created_at_utc === "string" ? obj.created_at_utc.trim() : "";
  const createdMs = parseIsoTimestampMs(createdAtUtc);
  if (createdMs === null) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "invalid_created_at_utc",
      detail: "Hypothesis created_at_utc must be a valid ISO-8601 UTC timestamp.",
      fix: `Set created_at_utc in ${fileName}.`,
    });
  }

  let expiresAtUtc = typeof obj.expires_at_utc === "string" ? obj.expires_at_utc.trim() : "";
  if (expiresAtUtc.length === 0 && obj.ttl_seconds !== undefined) {
    const ttlSec = obj.ttl_seconds;
    if (
      typeof ttlSec !== "number" ||
      !Number.isFinite(ttlSec) ||
      !Number.isInteger(ttlSec) ||
      ttlSec < 1 ||
      ttlSec > MAX_HYPOTHESIS_TTL_SECONDS
    ) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: id,
        rule: "hypothesis_ttl_exceeded",
        detail: `Hypothesis ttl_seconds must be an integer in 1..${MAX_HYPOTHESIS_TTL_SECONDS}.`,
        fix: `Set ttl_seconds <= ${MAX_HYPOTHESIS_TTL_SECONDS} in ${fileName}.`,
      });
    }
    expiresAtUtc = new Date(createdMs + ttlSec * 1000).toISOString();
  }
  const expiresMs = parseIsoTimestampMs(expiresAtUtc);
  if (expiresMs === null) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "invalid_expires_at_utc",
      detail: "Hypothesis expires_at_utc must be a valid ISO-8601 UTC timestamp.",
      fix: `Set expires_at_utc (<= 7d after created_at_utc) in ${fileName}.`,
    });
  }

  const ttlMs = expiresMs - createdMs;
  if (ttlMs <= 0 || ttlMs > MAX_HYPOTHESIS_TTL_SECONDS * 1000) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: id,
      rule: "hypothesis_ttl_exceeded",
      detail: "Hypothesis TTL must be > 0 and <= 7 days (604800 seconds).",
      fix: `Shorten expires_at_utc in ${fileName} to <= 7 days from created_at_utc.`,
    });
  }

  if (createdMs > nowMs + MAX_FUTURE_CREATED_SKEW_MS) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: id,
      rule: "hypothesis_future_created_at",
      detail: "Hypothesis created_at_utc cannot be more than 24h in the future.",
      fix: `Set created_at_utc to current UTC time in ${fileName}.`,
    });
  }

  if (expiresMs > nowMs + MAX_HYPOTHESIS_TTL_SECONDS * 1000) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: id,
      rule: "hypothesis_future_expires_at",
      detail: "Hypothesis expires_at_utc cannot exceed 7 days from current time.",
      fix: `Cap expires_at_utc within 7 days of now in ${fileName}.`,
    });
  }

  const roles = obj.roles === undefined ? ["*"] : asStringArray(obj.roles, id, "roles");
  if (roles.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "missing_roles",
      detail: "Hypothesis roles array cannot be empty.",
      fix: `Add at least one role or "*" in ${fileName}.`,
    });
  }
  for (const role of roles) {
    if (
      hasControlOrBidiChars(role) ||
      role.includes("\n") ||
      role.includes("\r") ||
      !VALID_ROLE_TOKEN_RE.test(role)
    ) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "SCHEMA_ERROR",
        claimId: id,
        rule: "invalid_roles",
        detail: "Hypothesis roles entries must be '*' or match ^[A-Za-z0-9._-]{1,64}$.",
        fix: `Sanitize roles array in ${fileName}.`,
      });
    }
    assertQuarantineClean(role, {
      claimId: id,
      field: "roles",
      config,
      allowHashRefExemption: false,
    });
  }

  const proposedBy =
    typeof obj.proposed_by === "string" && obj.proposed_by.trim().length > 0
      ? obj.proposed_by.trim()
      : "agent";

  const hintRaw =
    typeof obj.hint === "string" ? obj.hint : typeof obj.summary === "string" ? obj.summary : "";
  const hint = hintRaw.trim();
  if (hint.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "missing_hint",
      detail: "Hypothesis requires a non-empty hint or summary field.",
      fix: `Add hint text in ${fileName}.`,
    });
  }

  const record: HypothesisRecord = {
    id,
    created_at_utc: createdAtUtc,
    expires_at_utc: expiresAtUtc,
    roles,
    proposed_by: proposedBy,
    hint,
    source_file: filePath,
  };
  if (obj.kind === "scar_proposal" || obj.kind === "hypothesis" || obj.kind === "hypothesis_scar") {
    record.kind = obj.kind;
  }
  if (typeof obj.regression_test === "string" && obj.regression_test.trim().length > 0) {
    record.regression_test = obj.regression_test.trim();
  }
  if (
    typeof obj.proposed_ttl_days === "number" &&
    Number.isInteger(obj.proposed_ttl_days) &&
    obj.proposed_ttl_days >= 1 &&
    obj.proposed_ttl_days <= 30
  ) {
    record.proposed_ttl_days = obj.proposed_ttl_days;
  }
  return record;
}

interface RawScarDraft {
  scar_id: string;
  line_number: number;
  fields: Map<string, string>;
}

export function stripHtmlCommentsPreservingLines(input: string): string {
  return normalizeLf(input).replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ""));
}

export function parseScarsFile(
  brainDir: string,
  config: QuarantineConfig,
  options?: LoadBrainOptions,
): { scars: ScarRecord[]; scarsBytes: number } {
  const scarsPath = path.join(brainDir, "scars.md");
  const nowMs = (options?.now ?? new Date()).getTime();
  let raw: string;
  try {
    raw = readFileUtf8Cached(scarsPath, Boolean(options?.bypassReadCache));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { scars: [], scarsBytes: 0 };
    }
    throw err;
  }

  assertQuarantineClean(raw, { claimId: "scars.md", config });

  const strippedComments = stripHtmlCommentsPreservingLines(raw);
  if (strippedComments !== normalizeLf(raw)) {
    assertQuarantineClean(strippedComments, { claimId: "scars.md", config });
  }

  const scarsBytes = Buffer.byteLength(raw, "utf8");
  if (scarsBytes >= MAX_SCARS_BYTES) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: "scars.md",
      rule: "scars_size_limit_exceeded",
      detail: `scars.md is ${scarsBytes} bytes (must be strictly < ${MAX_SCARS_BYTES} bytes).`,
      fix: "Prune expired or resolved scars in .brain/scars.md using veribrain diff.",
    });
  }

  const lines = strippedComments.split("\n");
  const drafts: RawScarDraft[] = [];
  let current: RawScarDraft | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNum = i + 1;
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed.length === 0) {
      continue;
    }

    const headingMatch = /^#{2,3}\s+(SCAR-[A-Za-z0-9._-]+)\s*$/.exec(trimmed);
    if (headingMatch?.[1]) {
      current = {
        scar_id: headingMatch[1],
        line_number: lineNum,
        fields: new Map(),
      };
      drafts.push(current);
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      current = null;
      continue;
    }

    const fieldLine = trimmed.startsWith("- ") ? trimmed.slice(2).trim() : trimmed;
    const colonIdx = fieldLine.indexOf(":");
    if (colonIdx > 0) {
      const key = fieldLine.slice(0, colonIdx).trim().toLowerCase();
      const value = fieldLine.slice(colonIdx + 1).trim();
      if (key === "scar_id") {
        current = {
          scar_id: unquoteYamlScalar(value),
          line_number: lineNum,
          fields: new Map(),
        };
        drafts.push(current);
        continue;
      }
      if (
        current !== null &&
        (key === "created_at_utc" ||
          key === "expires_at_utc" ||
          key === "regression_test" ||
          key === "hint" ||
          key === "roles")
      ) {
        current.fields.set(key, unquoteYamlScalar(value));
      }
    }
  }

  const scars: ScarRecord[] = [];
  for (const draft of drafts) {
    const scarId = draft.scar_id.trim();
    if (!SCAR_ID_RE.test(scarId)) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "SCHEMA_ERROR",
        claimId: scarId || "scars.md",
        rule: "invalid_scar_id",
        line: draft.line_number,
        detail: `Invalid scar_id at line ${draft.line_number} (must match ^SCAR-[A-Za-z0-9._-]+$).`,
        fix: "Fix scar_id format in .brain/scars.md.",
      });
    }

    const createdAtUtc = draft.fields.get("created_at_utc") ?? "";
    const createdMs = parseIsoTimestampMs(createdAtUtc);
    if (createdMs === null) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "SCHEMA_ERROR",
        claimId: scarId,
        rule: "invalid_scar_created_at",
        line: draft.line_number,
        detail: `Scar ${scarId} missing valid created_at_utc timestamp.`,
        fix: `Add created_at_utc to ${scarId} in .brain/scars.md.`,
      });
    }

    const expiresAtUtc = draft.fields.get("expires_at_utc") ?? "";
    const expiresMs = parseIsoTimestampMs(expiresAtUtc);
    if (expiresMs === null) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "SCHEMA_ERROR",
        claimId: scarId,
        rule: "invalid_scar_expires_at",
        line: draft.line_number,
        detail: `Scar ${scarId} missing valid expires_at_utc timestamp.`,
        fix: `Add expires_at_utc (<= 30d) to ${scarId} in .brain/scars.md.`,
      });
    }

    const ttlMs = expiresMs - createdMs;
    if (ttlMs <= 0 || ttlMs > MAX_SCAR_TTL_SECONDS * 1000) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: scarId,
        rule: "scar_ttl_exceeded",
        line: draft.line_number,
        detail: `Scar ${scarId} TTL must be > 0 and <= 30 days.`,
        fix: `Set expires_at_utc <= 30 days after created_at_utc for ${scarId}.`,
      });
    }

    if (createdMs > nowMs + MAX_FUTURE_CREATED_SKEW_MS) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: scarId,
        rule: "scar_future_created_at",
        line: draft.line_number,
        detail: `Scar ${scarId} created_at_utc cannot be more than 24h in the future.`,
        fix: `Set created_at_utc to current UTC time for ${scarId}.`,
      });
    }

    if (expiresMs > nowMs + MAX_SCAR_TTL_SECONDS * 1000) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: scarId,
        rule: "scar_future_expires_at",
        line: draft.line_number,
        detail: `Scar ${scarId} expires_at_utc cannot exceed 30 days from current time.`,
        fix: `Cap expires_at_utc within 30 days of now for ${scarId}.`,
      });
    }

    const regressionTest = (draft.fields.get("regression_test") ?? "").trim();
    if (!isValidRepoRelativeTestRef(regressionTest)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: scarId,
        rule: "invalid_scar_regression_test",
        line: draft.line_number,
        detail: `Scar ${scarId} requires a safe repo-relative regression_test path.`,
        fix: `Link ${scarId} to a repo-relative regression test in .brain/scars.md.`,
      });
    }

    const hint = (draft.fields.get("hint") ?? "").trim();
    if (hint.length === 0) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "SCHEMA_ERROR",
        claimId: scarId,
        rule: "missing_scar_hint",
        line: draft.line_number,
        detail: `Scar ${scarId} requires a non-empty hint.`,
        fix: `Add a factual hint line to ${scarId} in .brain/scars.md.`,
      });
    }

    assertQuarantineClean(scarId, { claimId: scarId, field: "claim_id", config });
    assertQuarantineClean(regressionTest, { claimId: scarId, field: "regression_test", config });
    assertQuarantineClean(hint, { claimId: scarId, field: "hint", config });

    const rolesRaw = draft.fields.get("roles");
    const roles = rolesRaw
      ? rolesRaw
          .replace(/^\[/, "")
          .replace(/\]$/, "")
          .split(",")
          .map((r) => unquoteYamlScalar(r))
          .filter((r) => r.length > 0)
      : ["*"];

    scars.push({
      scar_id: scarId,
      created_at_utc: createdAtUtc,
      expires_at_utc: expiresAtUtc,
      regression_test: regressionTest,
      hint,
      roles: roles.length > 0 ? roles : ["*"],
      line_number: draft.line_number,
    });
  }

  return { scars, scarsBytes };
}

function listFilesSorted(dirPath: string, ext: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return [];
    }
    throw err;
  }
  return entries
    .filter((name) => name.endsWith(ext) && !name.startsWith("."))
    .sort(compareAscii)
    .map((name) => path.join(dirPath, name));
}

export function loadBrain(
  brainDir?: string,
  repoRoot?: string,
  options?: LoadBrainOptions,
): LoadedBrain {
  const paths = resolveBrainPaths(brainDir, repoRoot, {
    ...(options?.allowWorktreeFallback !== undefined
      ? { allowWorktreeFallback: options.allowWorktreeFallback }
      : {}),
  });
  const bypassReadCache = Boolean(options?.bypassReadCache);
  const config = loadBrainConfig(paths.brainDir, bypassReadCache);

  const decidedFiles = listFilesSorted(path.join(paths.brainDir, "decided"), ".md");
  const observedFiles = listFilesSorted(path.join(paths.brainDir, "observed"), ".json");
  const hypothesisFiles = listFilesSorted(path.join(paths.brainDir, "hypotheses"), ".json");

  const decided: DecidedRecord[] = [];
  const observed: ObservedRecord[] = [];
  const hypotheses: HypothesisRecord[] = [];
  let scars: ScarRecord[] = [];
  let scarsBytes = 0;
  let firstNonQuarantineError: unknown = null;

  const captureOrRethrowQuarantine = (err: unknown): void => {
    if (err instanceof VeriBrainError && err.exitCode === EXIT_QUARANTINE_VIOLATION) {
      throw err;
    }
    if (firstNonQuarantineError === null) {
      firstNonQuarantineError = err;
    }
  };

  for (const f of decidedFiles) {
    try {
      decided.push(parseDecidedFile(f, config.quarantine, bypassReadCache));
    } catch (err) {
      captureOrRethrowQuarantine(err);
    }
  }
  for (const f of observedFiles) {
    try {
      observed.push(parseObservedFile(f, config.quarantine, bypassReadCache));
    } catch (err) {
      captureOrRethrowQuarantine(err);
    }
  }
  for (const f of hypothesisFiles) {
    try {
      hypotheses.push(parseHypothesisFile(f, config.quarantine, options));
    } catch (err) {
      captureOrRethrowQuarantine(err);
    }
  }
  try {
    const parsedScars = parseScarsFile(paths.brainDir, config.quarantine, options);
    scars = parsedScars.scars;
    scarsBytes = parsedScars.scarsBytes;
  } catch (err) {
    captureOrRethrowQuarantine(err);
  }

  if (firstNonQuarantineError !== null) {
    throw firstNonQuarantineError;
  }

  return {
    brainDir: paths.brainDir,
    repoRoot: paths.repoRoot,
    config,
    decided,
    observed,
    hypotheses,
    scars,
    scarsBytes,
  };
}

export function regressionTestFileExists(repoRoot: string, regressionTest: string): boolean {
  if (!isValidRepoRelativeTestRef(regressionTest)) {
    return false;
  }
  const filePart = regressionTest.split("#")[0]?.split("::")[0]?.trim() ?? "";
  if (filePart.length === 0) {
    return false;
  }
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedTarget = path.resolve(resolvedRoot, filePart);
  if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    return false;
  }
  try {
    const st = statSync(resolvedTarget);
    if (!st.isFile()) {
      return false;
    }
    const realRoot = realpathSync(resolvedRoot);
    const realTarget = realpathSync(resolvedTarget);
    if (process.platform === "win32") {
      return realTarget.toLowerCase().startsWith(`${realRoot.toLowerCase()}${path.sep}`);
    }
    return realTarget.startsWith(`${realRoot}${path.sep}`);
  } catch {
    return false;
  }
}
