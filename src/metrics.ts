import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { normalizeLf } from "./normalize.js";
import { hasControlOrBidiChars } from "./sanitize.js";
import {
  invalidateFileReadCache,
  isBlockedSystemOrIsolationPath,
  isUncOrDevicePath,
  isValidEnv,
  isValidZoneALayout,
  parseIsoTimestampMs,
} from "./schema.js";
import {
  type BrainConfig,
  type CompileMetricEvent,
  DEFAULT_METRICS_MAX_BYTES,
  EXIT_ERROR,
  EXIT_PROVENANCE_VIOLATION,
  MAX_METRICS_MAX_BYTES,
  type MetricSource,
  MIN_METRICS_MAX_BYTES,
  VALID_METRIC_SOURCES,
  VeriBrainError,
} from "./types.js";

export const METRICS_FILENAME = ".metrics.jsonl" as const;
export const LEGACY_METRICS_JSON_FILENAME = ".metrics.json" as const;

const HEX12_RE = /^[0-9a-f]{12}$/;
const SAFE_ROLE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_READ_BYTES = MAX_METRICS_MAX_BYTES * 2;
const MAX_METRIC_TOKENS = 100_000_000;
const MAX_METRIC_COMPILE_MS = 3_600_000;

function normalizePathCmp(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function lstatOrNull(targetPath: string): Stats | null {
  try {
    return lstatSync(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function isValidMetricSource(value: string): value is MetricSource {
  return (VALID_METRIC_SOURCES as readonly string[]).includes(value);
}

export function isMetricsEnvEnabled(envVars: NodeJS.ProcessEnv = process.env): boolean {
  const raw = envVars.VERIBRAIN_METRICS;
  if (typeof raw !== "string") {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function isMetricsEnabled(
  config: BrainConfig | undefined,
  options?: { recordMetrics?: boolean; envVars?: NodeJS.ProcessEnv },
): boolean {
  if (options?.recordMetrics === false) {
    return false;
  }
  return (
    options?.recordMetrics === true ||
    config?.metrics?.enabled === true ||
    isMetricsEnvEnabled(options?.envVars)
  );
}

export function resolveMetricsMaxBytes(config?: BrainConfig, overrideMaxBytes?: number): number {
  const candidate = overrideMaxBytes ?? config?.metrics?.max_bytes ?? DEFAULT_METRICS_MAX_BYTES;
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate < MIN_METRICS_MAX_BYTES ||
    candidate > MAX_METRICS_MAX_BYTES
  ) {
    return DEFAULT_METRICS_MAX_BYTES;
  }
  return candidate;
}

export interface ConfinedBrainFile {
  realBrainDir: string;
  filePath: string;
  exists: boolean;
  size: number;
}

export function assertMetricsPathConfinement(
  brainDir: string,
  repoRoot?: string,
  fileName: string = METRICS_FILENAME,
  claimId = "stats",
): ConfinedBrainFile {
  if (
    fileName.length === 0 ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("..") ||
    fileName.includes("\0") ||
    hasControlOrBidiChars(fileName)
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "path_confinement_violation",
      detail: "Target brain filename contains unsafe path segments or control characters.",
      fix: "Operate only on canonical files directly inside .brain/.",
    });
  }

  for (const rawPath of [brainDir, repoRoot]) {
    if (rawPath === undefined) continue;
    if (
      rawPath.trim().length === 0 ||
      rawPath.includes("\0") ||
      hasControlOrBidiChars(rawPath) ||
      isUncOrDevicePath(rawPath) ||
      isBlockedSystemOrIsolationPath(rawPath)
    ) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId,
        rule: "path_confinement_violation",
        detail: "Path points to a forbidden UNC, device, system, or isolated workspace location.",
        fix: "Run inside an authorized local repository with a non-symlink .brain directory.",
      });
    }
  }

  if (repoRoot !== undefined) {
    const resolvedRepoRoot = path.resolve(repoRoot);
    if (isUncOrDevicePath(resolvedRepoRoot) || isBlockedSystemOrIsolationPath(resolvedRepoRoot)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId,
        rule: "path_confinement_violation",
        detail: "Repository root points to a forbidden system or isolated path.",
        fix: "Use an authorized local repository root.",
      });
    }
    const repoStat = lstatOrNull(resolvedRepoRoot);
    if (repoStat !== null) {
      if (repoStat.isSymbolicLink() || !repoStat.isDirectory()) {
        throw new VeriBrainError({
          exitCode: EXIT_PROVENANCE_VIOLATION,
          code: "PROVENANCE_VIOLATION",
          claimId,
          rule: "path_confinement_violation",
          detail: "Repository root must be a real non-symlink directory.",
          fix: "Pass a real repository directory to --repo-root.",
        });
      }
      const realRepoRoot = realpathSync(resolvedRepoRoot);
      if (isUncOrDevicePath(realRepoRoot) || isBlockedSystemOrIsolationPath(realRepoRoot)) {
        throw new VeriBrainError({
          exitCode: EXIT_PROVENANCE_VIOLATION,
          code: "PROVENANCE_VIOLATION",
          claimId,
          rule: "path_confinement_violation",
          detail: "Resolved repository root points to a forbidden system or isolated path.",
          fix: "Use an authorized local repository root.",
        });
      }
    }
  }

  const resolvedBrainDir = path.resolve(brainDir);
  if (isUncOrDevicePath(resolvedBrainDir) || isBlockedSystemOrIsolationPath(resolvedBrainDir)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "path_confinement_violation",
      detail: ".brain directory points to a forbidden system or isolated path.",
      fix: "Use a local repo-confined .brain directory.",
    });
  }

  const brainStat = lstatOrNull(resolvedBrainDir);
  if (brainStat === null) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "MISSING_BRAIN",
      claimId,
      rule: "missing_brain_dir",
      detail: ".brain directory does not exist.",
      fix: "Run veribrain init to scaffold .brain/.",
    });
  }
  if (brainStat.isSymbolicLink() || !brainStat.isDirectory()) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "path_confinement_violation",
      detail: ".brain directory cannot be a symbolic link or non-directory.",
      fix: "Replace symlinked .brain with a real directory.",
    });
  }

  const realBrainDir = realpathSync(resolvedBrainDir);
  if (isUncOrDevicePath(realBrainDir) || isBlockedSystemOrIsolationPath(realBrainDir)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "path_confinement_violation",
      detail: "Resolved .brain directory points to a forbidden system or isolated path.",
      fix: "Use a local repo-confined .brain directory.",
    });
  }

  const filePath = path.resolve(realBrainDir, fileName);
  if (
    normalizePathCmp(path.dirname(filePath)) !== normalizePathCmp(realBrainDir) ||
    path.basename(filePath) !== fileName
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "path_confinement_violation",
      detail: "Target brain file escaped .brain directory confinement.",
      fix: "Operate only on files directly inside .brain/.",
    });
  }

  const fileStat = lstatOrNull(filePath);
  if (fileStat === null) {
    return { realBrainDir, filePath, exists: false, size: 0 };
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "path_confinement_violation",
      detail: `${fileName} must be a regular non-symlink file inside .brain/.`,
      fix: `Remove symlinked or non-regular .brain/${fileName} before retrying.`,
    });
  }

  const realFile = realpathSync(filePath);
  if (
    normalizePathCmp(realFile) !== normalizePathCmp(filePath) ||
    isBlockedSystemOrIsolationPath(realFile)
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "path_confinement_violation",
      detail: `${fileName} resolved outside .brain/ confinement.`,
      fix: `Replace .brain/${fileName} with a local regular file.`,
    });
  }

  return { realBrainDir, filePath: realFile, exists: true, size: fileStat.size };
}

function sanitizeEvent(raw: CompileMetricEvent): CompileMetricEvent | null {
  if (parseIsoTimestampMs(raw.ts) === null) return null;
  if (!isValidMetricSource(raw.source)) return null;
  if (!SAFE_ROLE_RE.test(raw.role)) return null;
  if (!isValidEnv(raw.env)) return null;
  if (!isValidZoneALayout(raw.layout)) return null;

  const a0Sha = raw.zone_a0_sha256.trim().toLowerCase().slice(0, 12);
  const aSha = raw.zone_a_sha256.trim().toLowerCase().slice(0, 12);
  if (!HEX12_RE.test(a0Sha) || !HEX12_RE.test(aSha)) return null;

  const tokenFields = [raw.zone_a0_tokens, raw.zone_a_tokens, raw.zone_b_tokens, raw.total_tokens];
  if (
    !tokenFields.every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_METRIC_TOKENS,
    )
  ) {
    return null;
  }
  if (
    typeof raw.compile_ms !== "number" ||
    !Number.isFinite(raw.compile_ms) ||
    raw.compile_ms < 0 ||
    raw.compile_ms > MAX_METRIC_COMPILE_MS
  ) {
    return null;
  }

  return {
    ts: raw.ts,
    source: raw.source,
    role: raw.role,
    env: raw.env,
    layout: raw.layout,
    zone_a0_sha256: a0Sha,
    zone_a_sha256: aSha,
    zone_a0_tokens: Math.round(raw.zone_a0_tokens),
    zone_a_tokens: Math.round(raw.zone_a_tokens),
    zone_b_tokens: Math.round(raw.zone_b_tokens),
    total_tokens: Math.round(raw.total_tokens),
    compile_ms: Number(raw.compile_ms.toFixed(3)),
  };
}

function parseMetricLine(line: string): CompileMetricEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.ts !== "string" ||
    typeof obj.source !== "string" ||
    typeof obj.role !== "string" ||
    typeof obj.env !== "string" ||
    typeof obj.layout !== "string" ||
    typeof obj.zone_a0_sha256 !== "string" ||
    typeof obj.zone_a_sha256 !== "string" ||
    typeof obj.zone_a0_tokens !== "number" ||
    typeof obj.zone_a_tokens !== "number" ||
    typeof obj.zone_b_tokens !== "number" ||
    typeof obj.total_tokens !== "number" ||
    typeof obj.compile_ms !== "number"
  ) {
    return null;
  }
  // Enforce exact 12-hex prefix on stored records as well
  if (!HEX12_RE.test(obj.zone_a0_sha256) || !HEX12_RE.test(obj.zone_a_sha256)) {
    return null;
  }
  return sanitizeEvent({
    ts: obj.ts,
    source: obj.source as MetricSource,
    role: obj.role,
    env: obj.env,
    layout: obj.layout as "legacy" | "split",
    zone_a0_sha256: obj.zone_a0_sha256,
    zone_a_sha256: obj.zone_a_sha256,
    zone_a0_tokens: obj.zone_a0_tokens,
    zone_a_tokens: obj.zone_a_tokens,
    zone_b_tokens: obj.zone_b_tokens,
    total_tokens: obj.total_tokens,
    compile_ms: obj.compile_ms,
  });
}

function atomicReplaceConfinedFile(
  realBrainDir: string,
  filePath: string,
  content: string,
  prefix: string,
  claimId: string,
): void {
  const tmpPath = path.join(
    realBrainDir,
    `.tmp-${prefix}-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  try {
    writeFileSync(tmpPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const targetStat = lstatOrNull(filePath);
    if (targetStat !== null && (targetStat.isSymbolicLink() || !targetStat.isFile())) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId,
        rule: "path_confinement_violation",
        detail: "Target file became a symlink or non-regular file during atomic replace.",
        fix: "Remove symlinked file inside .brain/ before retrying.",
      });
    }
    renameSync(tmpPath, filePath);
    invalidateFileReadCache(filePath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Best-effort temp cleanup.
      }
    }
    throw err;
  }
}

export function appendMetricEvent(
  brainDir: string,
  event: CompileMetricEvent,
  options?: { repoRoot?: string; maxBytes?: number },
): void {
  const clean = sanitizeEvent(event);
  if (clean === null) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: "metrics",
      rule: "invalid_metric_event",
      detail: "CompileMetricEvent failed zero-PII schema validation.",
      fix: "Emit only structured token, hash-prefix, and timing fields.",
    });
  }

  const maxBytes = resolveMetricsMaxBytes(undefined, options?.maxBytes);
  const confined = assertMetricsPathConfinement(
    brainDir,
    options?.repoRoot,
    METRICS_FILENAME,
    "metrics",
  );
  const line = `${JSON.stringify(clean)}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");

  if (confined.exists && confined.size + lineBytes > maxBytes) {
    // Atomic 50%-tail compaction keeping newest valid/raw lines within ~50% of maxBytes
    const targetBytes = Math.min(maxBytes, Math.max(Math.floor(maxBytes / 2), lineBytes));
    let existingLines: string[] = [];
    if (confined.size <= MAX_READ_BYTES) {
      const raw = readFileSync(confined.filePath, "utf8");
      existingLines = normalizeLf(raw)
        .split("\n")
        .filter((l) => l.trim().length > 0);
    }

    const keptReversed: string[] = [line.trimEnd()];
    let accBytes = lineBytes;
    for (let i = existingLines.length - 1; i >= 0; i -= 1) {
      const candidate = existingLines[i] ?? "";
      const valid = parseMetricLine(candidate);
      if (valid === null) {
        continue;
      }
      const normalizedLine = JSON.stringify(valid);
      const candidateBytes = Buffer.byteLength(`${normalizedLine}\n`, "utf8");
      if (accBytes + candidateBytes > targetBytes) {
        break;
      }
      keptReversed.push(normalizedLine);
      accBytes += candidateBytes;
    }
    keptReversed.reverse();
    const compacted = `${keptReversed.join("\n")}\n`;
    atomicReplaceConfinedFile(
      confined.realBrainDir,
      confined.filePath,
      compacted,
      "metrics",
      "metrics",
    );
    return;
  }

  const openFlags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_APPEND |
    (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  let fd: number | null = null;
  try {
    fd = openSync(confined.filePath, openFlags, 0o600);
    writeSync(fd, line, null, "utf8");
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

export function recordCompileMetricBestEffort(
  brainDir: string,
  event: CompileMetricEvent,
  options?: { repoRoot?: string; maxBytes?: number },
): boolean {
  try {
    appendMetricEvent(brainDir, event, options);
    return true;
  } catch {
    // Fail-closed: never follow symlinks or crash compileContext on best-effort metrics errors.
    return false;
  }
}

export function readMetricEvents(
  brainDir: string,
  options?: { repoRoot?: string; sinceWindowMs?: number | null; nowMs?: number },
): { events: CompileMetricEvent[]; skippedCorruptLines: number } {
  const confined = assertMetricsPathConfinement(
    brainDir,
    options?.repoRoot,
    METRICS_FILENAME,
    "stats",
  );
  if (!confined.exists) {
    return { events: [], skippedCorruptLines: 0 };
  }
  if (confined.size > MAX_READ_BYTES) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "stats",
      rule: "metrics_file_too_large",
      detail: `.brain/${METRICS_FILENAME} exceeds safety read cap (${MAX_READ_BYTES} bytes).`,
      fix: "Run veribrain stats --reset to clear an oversized metrics ledger.",
    });
  }

  const raw = readFileSync(confined.filePath, "utf8");
  const lines = normalizeLf(raw).split("\n");
  const nowMs = options?.nowMs ?? Date.now();
  const sinceWindowMs = options?.sinceWindowMs ?? null;
  const cutoffMs = sinceWindowMs === null ? null : nowMs - sinceWindowMs;

  const events: CompileMetricEvent[] = [];
  let skippedCorruptLines = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed = parseMetricLine(trimmed);
    if (parsed === null) {
      skippedCorruptLines += 1;
      continue;
    }
    if (cutoffMs !== null) {
      const tsMs = parseIsoTimestampMs(parsed.ts);
      if (tsMs === null || tsMs < cutoffMs) {
        continue;
      }
    }
    events.push(parsed);
  }

  return { events, skippedCorruptLines };
}

export function resetMetricsLedger(brainDir: string, repoRoot?: string): boolean {
  const confined = assertMetricsPathConfinement(brainDir, repoRoot, METRICS_FILENAME, "stats");
  if (!confined.exists) {
    return false;
  }
  unlinkSync(confined.filePath);
  return true;
}

export function atomicWriteBrainConfig(
  brainDir: string,
  content: string,
  repoRoot?: string,
): string {
  const confined = assertMetricsPathConfinement(brainDir, repoRoot, "config.json", "stats");
  atomicReplaceConfinedFile(confined.realBrainDir, confined.filePath, content, "config", "stats");
  return confined.filePath;
}
