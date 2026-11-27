import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import {
  assertMetricsPathConfinement,
  atomicWriteBrainConfig,
  isMetricsEnabled,
  readMetricEvents,
  resetMetricsLedger,
} from "../metrics.js";
import { resolveEffectiveMirrorDirs, syncMirrorFiles } from "../mirror.js";
import { compareAscii, truncateAscii, wrapAsciiLines } from "../normalize.js";
import { assertQuarantineClean } from "../quarantine.js";
import { hasControlOrBidiChars } from "../sanitize.js";
import {
  defaultBrainConfig,
  defaultQuarantineConfig,
  isAgentEnvironment,
  isBlockedSystemOrIsolationPath,
  isUncOrDevicePath,
  loadBrainConfig,
  resolveBrainPaths,
} from "../schema.js";
import {
  type BrainConfig,
  EXIT_ERROR,
  EXIT_PROVENANCE_VIOLATION,
  KV_CACHE_MIN_FLOOR_TOKENS,
  type QuarantineConfig,
  type StatsOptions,
  type StatsResult,
  VeriBrainError,
} from "../types.js";
import { parseSinceWindowMs } from "./diff.js";

const MAX_BASELINE_FILES = 500;
const MAX_BASELINE_FILE_BYTES = 512 * 1024;
const MAX_WALK_DEPTH = 32;
const MAX_VISITED_DIRS = 5_000;
const MAX_TEXT_COLS = 80;
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", ".brain"]);
const EXCLUDED_DEFAULT_DOCS_SUBDIRS = new Set(["archive"]);

const METHODOLOGY_NOTE =
  "Measured: local compile counts, latency, and Zone A0 hash reuse (structural reuse across window; no provider KV-cache TTL modeled) from .brain/.metrics.jsonl. Estimated: ~4 bytes/token baseline docs, utf8-3.5x1.15 compiled tokens, and nominal 90% KV-cache discount on >=1024-token Zone A0 repeat hits; no provider billing telemetry.";

function normalizePathCmp(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideOrEqualDir(candidate: string, parentDir: string): boolean {
  const c = normalizePathCmp(candidate);
  const p = normalizePathCmp(parentDir);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

function toPosixRelPath(repoRoot: string, filePath: string): string {
  const rel = path.relative(repoRoot, filePath).split(path.sep).join("/");
  return rel.length > 0 ? rel : ".";
}

function parseStatsSince(rawSince: string | undefined): {
  sinceLabel: string;
  windowMs: number | null;
} {
  const raw = rawSince ?? "30d";
  const trimmed = raw.trim();
  assertQuarantineClean(trimmed, {
    claimId: "stats",
    field: "since",
    allowHashRefExemption: false,
  });
  if (trimmed.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "stats",
      rule: "invalid_since_window",
      detail: "Invalid --since window (expected 24h, 7d, 30d, or all).",
      fix: "Pass --since 24h|7d|30d|all.",
    });
  }
  if (trimmed.toLowerCase() === "all") {
    return { sinceLabel: "all", windowMs: null };
  }
  try {
    const windowMs = parseSinceWindowMs(trimmed);
    return { sinceLabel: trimmed.toLowerCase(), windowMs };
  } catch {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "stats",
      rule: "invalid_since_window",
      detail: "Invalid --since window (expected 24h, 7d, 30d, or all).",
      fix: "Pass --since 24h|7d|30d|all.",
    });
  }
}

interface BaselineMeasurement {
  pathsUsed: string[];
  files: number;
  bytes: number;
  tokensEst: number;
}

function measureBaselineDocs(
  realRepoRoot: string,
  explicitPaths: readonly string[] | undefined,
): BaselineMeasurement {
  const seenFiles = new Map<string, number>();
  let visitedDirs = 0;

  const recordFile = (absPath: string, size: number): void => {
    const key = normalizePathCmp(absPath);
    if (seenFiles.has(key)) {
      return;
    }
    if (seenFiles.size >= MAX_BASELINE_FILES) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "stats",
        rule: "baseline_file_limit_exceeded",
        detail: `Baseline doc scan exceeded maximum limit of ${MAX_BASELINE_FILES} files.`,
        fix: "Pass narrower repo-relative paths via --baseline-paths <csv>.",
      });
    }
    if (size > MAX_BASELINE_FILE_BYTES) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "stats",
        rule: "baseline_file_size_exceeded",
        detail: `Baseline file ${toPosixRelPath(realRepoRoot, absPath)} exceeds ${MAX_BASELINE_FILE_BYTES} bytes.`,
        fix: "Exclude oversized files (> 512 KB) from --baseline-paths.",
      });
    }
    seenFiles.set(key, size);
  };

  const walkDir = (dirPath: string, isDefaultDocsRoot: boolean, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "stats",
        rule: "baseline_walk_depth_exceeded",
        detail: `Baseline doc scan exceeded maximum depth of ${MAX_WALK_DEPTH}.`,
        fix: "Pass explicit repo-relative paths via --baseline-paths <csv>.",
      });
    }
    visitedDirs += 1;
    if (visitedDirs > MAX_VISITED_DIRS) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "stats",
        rule: "baseline_walk_dir_limit_exceeded",
        detail: `Baseline doc scan exceeded maximum limit of ${MAX_VISITED_DIRS} directories.`,
        fix: "Pass explicit repo-relative paths via --baseline-paths <csv>.",
      });
    }
    let entries: string[];
    try {
      entries = readdirSync(dirPath).sort(compareAscii);
    } catch {
      return;
    }
    for (const name of entries) {
      const fullPath = path.join(dirPath, name);
      let st: Stats;
      try {
        st = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        continue;
      }
      if (st.isDirectory()) {
        if (EXCLUDED_DIRS.has(name)) {
          continue;
        }
        if (isDefaultDocsRoot && EXCLUDED_DEFAULT_DOCS_SUBDIRS.has(name.toLowerCase())) {
          continue;
        }
        walkDir(fullPath, false, depth + 1);
      } else if (st.isFile() && name.toLowerCase().endsWith(".md")) {
        let realFile: string;
        try {
          realFile = realpathSync(fullPath);
        } catch {
          continue;
        }
        if (!isInsideOrEqualDir(realFile, realRepoRoot)) {
          continue;
        }
        recordFile(realFile, st.size);
      }
    }
  };

  let pathsUsed: string[] = [];

  if (explicitPaths !== undefined && explicitPaths.length > 0) {
    if (explicitPaths.length > MAX_BASELINE_FILES) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "stats",
        rule: "baseline_file_limit_exceeded",
        detail: `--baseline-paths exceeds maximum limit of ${MAX_BASELINE_FILES} paths.`,
        fix: `Pass at most ${MAX_BASELINE_FILES} repo-relative paths.`,
      });
    }

    const usedSet = new Set<string>();
    for (const rawEntry of explicitPaths) {
      const trimmed = rawEntry.trim();
      if (
        trimmed.length === 0 ||
        trimmed.includes("\0") ||
        trimmed.includes("\n") ||
        trimmed.includes("\r") ||
        hasControlOrBidiChars(trimmed) ||
        isUncOrDevicePath(trimmed)
      ) {
        throw new VeriBrainError({
          exitCode: EXIT_PROVENANCE_VIOLATION,
          code: "PROVENANCE_VIOLATION",
          claimId: "stats",
          rule: "path_confinement_violation",
          detail: "Baseline path contains unsafe characters or UNC/device prefix.",
          fix: "Pass repo-relative markdown/doc paths inside the repository root.",
        });
      }

      const candidate = path.isAbsolute(trimmed)
        ? path.resolve(trimmed)
        : path.resolve(realRepoRoot, trimmed);

      // Fail closed BEFORE lstatSync so out-of-repo existence is never probed or echoed
      if (!isInsideOrEqualDir(candidate, realRepoRoot)) {
        throw new VeriBrainError({
          exitCode: EXIT_PROVENANCE_VIOLATION,
          code: "PROVENANCE_VIOLATION",
          claimId: "stats",
          rule: "path_confinement_violation",
          detail: "Baseline path escapes repository root.",
          fix: "Pass paths strictly inside the repository root.",
        });
      }
      if (isBlockedSystemOrIsolationPath(candidate)) {
        throw new VeriBrainError({
          exitCode: EXIT_PROVENANCE_VIOLATION,
          code: "PROVENANCE_VIOLATION",
          claimId: "stats",
          rule: "path_confinement_violation",
          detail: "Baseline path points to a forbidden system or isolated path.",
          fix: "Scan only docs inside the current repository root.",
        });
      }

      const relCandidate = toPosixRelPath(realRepoRoot, candidate);
      let lst: Stats;
      try {
        lst = lstatSync(candidate);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: "stats",
            rule: "baseline_path_not_found",
            detail: `Baseline path not found inside repository: ${relCandidate}.`,
            fix: "Check repo-relative paths passed to --baseline-paths.",
          });
        }
        throw err;
      }

      if (lst.isSymbolicLink()) {
        throw new VeriBrainError({
          exitCode: EXIT_PROVENANCE_VIOLATION,
          code: "PROVENANCE_VIOLATION",
          claimId: "stats",
          rule: "path_confinement_violation",
          detail: "Symbolic links are denied in --baseline-paths.",
          fix: "Pass regular repo-confined files or directories to --baseline-paths.",
        });
      }

      const realTarget = realpathSync(candidate);
      if (
        !isInsideOrEqualDir(realTarget, realRepoRoot) ||
        isBlockedSystemOrIsolationPath(realTarget)
      ) {
        throw new VeriBrainError({
          exitCode: EXIT_PROVENANCE_VIOLATION,
          code: "PROVENANCE_VIOLATION",
          claimId: "stats",
          rule: "path_confinement_violation",
          detail: "Baseline path resolved outside repository root confinement.",
          fix: "Pass paths strictly inside the repository root.",
        });
      }

      usedSet.add(toPosixRelPath(realRepoRoot, realTarget));
      if (lst.isFile()) {
        recordFile(realTarget, lst.size);
      } else if (lst.isDirectory()) {
        walkDir(realTarget, false, 1);
      } else {
        throw new VeriBrainError({
          exitCode: EXIT_ERROR,
          code: "CLI_ERROR",
          claimId: "stats",
          rule: "baseline_not_file_or_dir",
          detail: `Baseline path is not a regular file or directory: ${relCandidate}.`,
          fix: "Pass regular files or directories to --baseline-paths.",
        });
      }
    }
    pathsUsed = [...usedSet].sort(compareAscii);
  } else {
    // Safe default scan: top-level repo *.md + docs/**/*.md (skipping docs/archive and excluded dirs)
    let rootEntries: string[] = [];
    try {
      rootEntries = readdirSync(realRepoRoot).sort(compareAscii);
    } catch {
      rootEntries = [];
    }
    for (const name of rootEntries) {
      if (!name.toLowerCase().endsWith(".md")) {
        continue;
      }
      const abs = path.join(realRepoRoot, name);
      let st: Stats;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (!st.isSymbolicLink() && st.isFile()) {
        let realFile: string;
        try {
          realFile = realpathSync(abs);
        } catch {
          continue;
        }
        if (isInsideOrEqualDir(realFile, realRepoRoot)) {
          recordFile(realFile, st.size);
        }
      }
    }

    const docsDir = path.join(realRepoRoot, "docs");
    let docsStat: Stats | null = null;
    try {
      docsStat = lstatSync(docsDir);
    } catch {
      docsStat = null;
    }
    if (docsStat !== null && !docsStat.isSymbolicLink() && docsStat.isDirectory()) {
      let realDocs: string | null = null;
      try {
        realDocs = realpathSync(docsDir);
      } catch {
        realDocs = null;
      }
      if (realDocs !== null && isInsideOrEqualDir(realDocs, realRepoRoot)) {
        walkDir(realDocs, true, 1);
      }
    }

    if (seenFiles.size > 0) {
      pathsUsed = ["*.md", "docs/**/*.md"];
    }
  }

  let totalBytes = 0;
  for (const size of seenFiles.values()) {
    totalBytes += size;
  }
  const tokensEst = totalBytes === 0 ? 0 : Math.ceil(totalBytes / 4);

  return {
    pathsUsed,
    files: seenFiles.size,
    bytes: totalBytes,
    tokensEst,
  };
}

function assertSafeBrainAncestorsBeforeMkdir(brainDir: string, realRepoRoot: string): void {
  const resolvedBrainDir = path.resolve(brainDir);
  const insideRepoRoot = isInsideOrEqualDir(resolvedBrainDir, realRepoRoot);
  const chain: string[] = [];
  let cursor = resolvedBrainDir;
  while (true) {
    chain.push(cursor);
    if (insideRepoRoot && normalizePathCmp(cursor) === normalizePathCmp(realRepoRoot)) {
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  let nearestExistingIdx = -1;
  let nearestStat: Stats | null = null;
  for (let i = 0; i < chain.length; i += 1) {
    const candidate = chain[i];
    if (!candidate) continue;
    try {
      nearestStat = lstatSync(candidate);
      nearestExistingIdx = i;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "stats",
        rule: "path_confinement_violation",
        detail: "Cannot verify ancestor confinement for .brain directory.",
        fix: "Use a local repo-confined .brain directory without symlinks.",
      });
    }
  }

  if (nearestExistingIdx === -1 || nearestStat === null) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "stats",
      rule: "path_confinement_violation",
      detail: "No valid local ancestor directory exists for .brain.",
      fix: "Use a local repo-confined .brain directory.",
    });
  }

  const nearestExisting = chain[nearestExistingIdx] as string;
  if (nearestStat.isSymbolicLink() || !nearestStat.isDirectory()) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "stats",
      rule: "path_confinement_violation",
      detail: ".brain ancestor cannot be a symbolic link or non-directory.",
      fix: "Use a real local directory without symlinks for --brain-dir.",
    });
  }

  // Verify every existing ancestor up to root is not a symlink and not UNC/blocked
  for (let i = nearestExistingIdx; i < chain.length; i += 1) {
    const anc = chain[i];
    if (!anc) continue;
    const isFsRoot = path.dirname(anc) === anc;
    if (!isFsRoot && isBlockedSystemOrIsolationPath(anc)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "stats",
        rule: "path_confinement_violation",
        detail: "Cannot initialize .brain inside a forbidden system or isolated directory.",
        fix: "Run inside an authorized local repository directory.",
      });
    }
    let st: Stats;
    try {
      st = lstatSync(anc);
    } catch {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "stats",
        rule: "path_confinement_violation",
        detail: "Cannot inspect ancestor directory for .brain confinement.",
        fix: "Use an authorized local directory without symlinks.",
      });
    }
    if (st.isSymbolicLink()) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "stats",
        rule: "path_confinement_violation",
        detail: "Symlinked ancestor directories are denied for .brain creation.",
        fix: "Point --brain-dir to a real directory without symlink ancestors.",
      });
    }
  }

  const realNearest = realpathSync(nearestExisting);
  if (isUncOrDevicePath(realNearest) || isBlockedSystemOrIsolationPath(realNearest)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "stats",
      rule: "path_confinement_violation",
      detail: "Resolved .brain ancestor points to a forbidden system or isolated directory.",
      fix: "Run inside an authorized local repository directory.",
    });
  }
}

function toggleMetricsConfig(brainDir: string, repoRoot: string, enabled: boolean): BrainConfig {
  let brainStat: Stats | null = null;
  try {
    brainStat = lstatSync(brainDir);
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
        claimId: "stats",
        rule: "path_confinement_violation",
        detail: ".brain directory cannot be a symbolic link or non-directory.",
        fix: "Replace symlinked .brain with a real directory.",
      });
    }
  } else {
    assertSafeBrainAncestorsBeforeMkdir(brainDir, repoRoot);
    mkdirSync(brainDir, { recursive: true });
  }

  const confinedConfig = assertMetricsPathConfinement(brainDir, repoRoot, "config.json", "stats");
  let rawObj: Record<string, unknown>;
  let quarantineConfig: QuarantineConfig = defaultQuarantineConfig();

  if (confinedConfig.exists) {
    const validated = loadBrainConfig(brainDir, true);
    quarantineConfig = validated.quarantine;
    const rawText = readFileSync(confinedConfig.filePath, "utf8");
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    rawObj = { ...parsed };
    const existingMetrics =
      parsed.metrics !== null &&
      typeof parsed.metrics === "object" &&
      !Array.isArray(parsed.metrics)
        ? { ...(parsed.metrics as Record<string, unknown>) }
        : {};
    rawObj.metrics = { ...existingMetrics, enabled };
  } else {
    rawObj = {
      ...defaultBrainConfig(),
      metrics: { enabled },
    };
  }

  const serialized = `${JSON.stringify(rawObj, null, 2)}\n`;
  assertQuarantineClean(serialized, {
    claimId: "config.json",
    config: quarantineConfig,
  });
  atomicWriteBrainConfig(brainDir, serialized, repoRoot);
  const updatedConfig = loadBrainConfig(brainDir, true);
  if (updatedConfig.mirror_dirs && updatedConfig.mirror_dirs.length > 0) {
    const mirrorDirs = resolveEffectiveMirrorDirs(updatedConfig, undefined, brainDir, repoRoot);
    if (mirrorDirs.length > 0) {
      syncMirrorFiles(brainDir, mirrorDirs, ["config.json"], false);
    }
  }
  return updatedConfig;
}

export function formatStatsText(result: StatsResult): string {
  const lines: string[] = [];
  const statusTag = result.enabled ? "ENABLED" : "DISABLED (opt-in)";
  const actionSuffix = result.action ? ` [${result.action}]` : "";
  lines.push(
    truncateAscii(
      `VeriBrain Local Stats (${result.since}): ${statusTag}${actionSuffix}`,
      MAX_TEXT_COLS,
    ),
  );
  lines.push(
    truncateAscii(
      `Compiles: ${result.compiles_total} total (cli=${result.cli_compiles}, mcp=${result.mcp_compiles}) | avg=${result.avg_compile_ms}ms`,
      MAX_TEXT_COLS,
    ),
  );
  lines.push(
    truncateAscii(
      `Avg Tokens: total=${result.avg_total_tokens} (A0=${result.avg_zone_a0_tokens}, A=${result.avg_zone_a_tokens}, B=${result.avg_zone_b_tokens})`,
      MAX_TEXT_COLS,
    ),
  );
  lines.push(
    truncateAscii(
      `Zone A0 Cache (>=1024t): eligible=${result.zone_a0_eligible_compiles}, hits=${result.zone_a0_repeat_hits}, xrole=${result.zone_a0_cross_role_hits}`,
      MAX_TEXT_COLS,
    ),
  );
  lines.push(
    truncateAscii(
      `Zone A0 Reuse (est): ${result.zone_a0_cacheable_tokens_reused} tok reused | 90% discount=${result.estimated_cache_discount_tokens_at_90pct} tok`,
      MAX_TEXT_COLS,
    ),
  );
  lines.push(
    truncateAscii(
      `Baseline Docs: ${result.baseline_docs_files} files (${result.baseline_docs_bytes} B, ~${result.baseline_docs_tokens_est} tok)`,
      MAX_TEXT_COLS,
    ),
  );
  lines.push(
    truncateAscii(
      `Tokens Avoided vs Baseline (est): ${result.tokens_avoided_vs_baseline_docs} tok (${result.compression_ratio_pct}% reduction)`,
      MAX_TEXT_COLS,
    ),
  );
  if (result.skipped_corrupt_lines > 0) {
    lines.push(
      truncateAscii(
        `Notice: skipped ${result.skipped_corrupt_lines} corrupt JSONL line(s) in .brain/.metrics.jsonl.`,
        MAX_TEXT_COLS,
      ),
    );
  }
  if (!result.enabled && result.compiles_total === 0) {
    lines.push(
      truncateAscii(
        "Tip: run `veribrain stats --enable` (human) or set VERIBRAIN_METRICS=1.",
        MAX_TEXT_COLS,
      ),
    );
  } else if (result.enabled && result.compiles_total === 0) {
    lines.push(
      truncateAscii("Tip: run `veribrain compile` to record local telemetry.", MAX_TEXT_COLS),
    );
  }
  for (const noteLine of wrapAsciiLines(`Note: ${result.methodology_note}`, MAX_TEXT_COLS, "  ")) {
    lines.push(noteLine);
  }
  return `${lines.join("\n")}\n`;
}

export function formatStatsMarkdown(result: StatsResult): string {
  const lines: string[] = [
    `# VeriBrain Local ROI & Telemetry Stats (${result.since})`,
    "",
    `- Telemetry Status: ${result.enabled ? "ENABLED" : "DISABLED (opt-in)"}${result.action ? ` (${result.action})` : ""}`,
    `- Window: ${result.since}`,
    `- Corrupt JSONL Lines Skipped: ${result.skipped_corrupt_lines}`,
    "",
    "## Measured Local Compile Telemetry",
    "| Metric | Value |",
    "| :--- | ---: |",
    `| Compiles Total | ${result.compiles_total} |`,
    `| CLI Compiles | ${result.cli_compiles} |`,
    `| MCP Compiles | ${result.mcp_compiles} |`,
    `| Avg Compile Latency (ms) | ${result.avg_compile_ms} |`,
    `| Avg Zone A0 Tokens (est.) | ${result.avg_zone_a0_tokens} |`,
    `| Avg Zone A Tokens (est.) | ${result.avg_zone_a_tokens} |`,
    `| Avg Zone B Tokens (est.) | ${result.avg_zone_b_tokens} |`,
    `| Avg Total Tokens (est.) | ${result.avg_total_tokens} |`,
    "",
    "## Zone A0 Prefix Reuse & Estimated Cache Savings",
    "| Metric | Value |",
    "| :--- | ---: |",
    `| Zone A0 Eligible Compiles (split & >= 1,024 tok) | ${result.zone_a0_eligible_compiles} |`,
    `| Zone A0 Repeat Hits | ${result.zone_a0_repeat_hits} |`,
    `| Zone A0 Cross-Role Hits | ${result.zone_a0_cross_role_hits} |`,
    `| Zone A0 Cacheable Tokens Reused (est.) | ${result.zone_a0_cacheable_tokens_reused} |`,
    `| Estimated Cache Discount Tokens (nominal 90%) | ${result.estimated_cache_discount_tokens_at_90pct} |`,
    "",
    "## Baseline Docs Comparison (Estimated)",
    `- Baseline Paths: ${result.baseline_paths_used.length > 0 ? result.baseline_paths_used.join(", ") : "none"}`,
    `- Baseline Docs: ${result.baseline_docs_files} files (${result.baseline_docs_bytes} bytes, ~${result.baseline_docs_tokens_est} est. tokens)`,
    `- Tokens Avoided vs Baseline Docs: ${result.tokens_avoided_vs_baseline_docs} (${result.compression_ratio_pct}% compression)`,
    "",
    "## Methodology",
    result.methodology_note,
    "",
  ];
  return lines.join("\n");
}

export function runStats(options: StatsOptions = {}): StatsResult {
  const envVars = options.envVars ?? process.env;
  const mutatorCount =
    (options.enable ? 1 : 0) + (options.disable ? 1 : 0) + (options.reset ? 1 : 0);

  // Fail closed in agent mode BEFORE any mutation or path access
  if (mutatorCount > 0 && isAgentEnvironment(envVars)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "stats",
      rule: "agent_mutator_denied",
      detail: "Agents cannot mutate metrics settings or reset .brain/.metrics.jsonl.",
      fix: "Run read-only `veribrain stats` or ask a human to run --enable/--disable/--reset.",
    });
  }

  if (mutatorCount > 1) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "stats",
      rule: "mutually_exclusive_flags",
      detail: "Flags --enable, --disable, and --reset are mutually exclusive.",
      fix: "Pass at most one of --enable, --disable, or --reset.",
    });
  }

  if (
    options.format !== undefined &&
    options.format !== "text" &&
    options.format !== "md" &&
    options.format !== "json"
  ) {
    assertQuarantineClean(String(options.format), {
      claimId: "stats",
      field: "format",
      allowHashRefExemption: false,
    });
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "stats",
      rule: "invalid_format",
      detail: "--format must be text, md, or json.",
      fix: "Pass --format text|md|json.",
    });
  }

  let explicitBaselinePaths: string[] | undefined;
  if (options.baselinePaths !== undefined) {
    const cleaned = options.baselinePaths.map((p) => p.trim()).filter((p) => p.length > 0);
    if (cleaned.length === 0) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "stats",
        rule: "empty_baseline_paths",
        detail: "--baseline-paths cannot be empty when specified.",
        fix: "Pass comma-separated repo-relative paths or omit --baseline-paths.",
      });
    }
    explicitBaselinePaths = cleaned;
  }

  const { sinceLabel, windowMs } = parseStatsSince(options.since);

  for (const rawPath of [options.repoRoot, options.brainDir]) {
    if (
      rawPath !== undefined &&
      (rawPath.includes("\0") ||
        hasControlOrBidiChars(rawPath) ||
        isUncOrDevicePath(rawPath) ||
        isBlockedSystemOrIsolationPath(rawPath))
    ) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "stats",
        rule: "path_confinement_violation",
        detail: "stats refuses UNC, device, system, or isolated workspace paths.",
        fix: "Run veribrain stats inside an authorized local repository directory.",
      });
    }
  }

  const { brainDir: resolvedBrainDir, repoRoot } = resolveBrainPaths(
    options.brainDir,
    options.repoRoot,
    {
      allowWorktreeFallback: mutatorCount === 0,
    },
  );
  if (
    isUncOrDevicePath(repoRoot) ||
    isUncOrDevicePath(resolvedBrainDir) ||
    isBlockedSystemOrIsolationPath(repoRoot) ||
    isBlockedSystemOrIsolationPath(resolvedBrainDir)
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "stats",
      rule: "path_confinement_violation",
      detail: "Resolved repository or .brain path points to a forbidden system or isolated path.",
      fix: "Run veribrain stats inside an authorized local repository directory.",
    });
  }

  // P2-PRG3-1: lstatSync(repoRoot) BEFORE realpathSync(repoRoot)
  let repoStat: Stats;
  try {
    repoStat = lstatSync(repoRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "REPO_ROOT_NOT_FOUND",
        claimId: "stats",
        rule: "repo_root_not_found",
        detail: "Repository root directory does not exist.",
        fix: "Pass an existing local repository directory to --repo-root.",
      });
    }
    throw err;
  }
  if (repoStat.isSymbolicLink() || !repoStat.isDirectory()) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "stats",
      rule: "path_confinement_violation",
      detail: "Repository root must be a real non-symlink directory.",
      fix: "Pass a real local repository directory to --repo-root.",
    });
  }

  const realRepoRoot = realpathSync(repoRoot);
  if (isUncOrDevicePath(realRepoRoot) || isBlockedSystemOrIsolationPath(realRepoRoot)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "stats",
      rule: "path_confinement_violation",
      detail: "Resolved repository root points to a forbidden system or isolated path.",
      fix: "Run veribrain stats inside an authorized local repository directory.",
    });
  }

  // Rebase brainDir onto canonical realRepoRoot when inside repoRoot so OS temp-dir symlinks do not cause false positives
  const brainDir = isInsideOrEqualDir(resolvedBrainDir, repoRoot)
    ? path.resolve(realRepoRoot, path.relative(repoRoot, resolvedBrainDir))
    : resolvedBrainDir;

  let action: "enabled" | "disabled" | "reset" | undefined;
  let config: BrainConfig | undefined;

  if (options.enable) {
    config = toggleMetricsConfig(brainDir, realRepoRoot, true);
    action = "enabled";
  } else if (options.disable) {
    config = toggleMetricsConfig(brainDir, realRepoRoot, false);
    action = "disabled";
  } else if (options.reset) {
    resetMetricsLedger(brainDir, realRepoRoot);
    action = "reset";
  }

  if (config === undefined) {
    const confinedConfig = assertMetricsPathConfinement(
      brainDir,
      realRepoRoot,
      "config.json",
      "stats",
    );
    if (confinedConfig.exists) {
      config = loadBrainConfig(brainDir, true);
    }
  }

  const enabled = isMetricsEnabled(config, { envVars });
  const nowMs = (options.now ?? new Date()).getTime();
  const { events, skippedCorruptLines } = readMetricEvents(brainDir, {
    repoRoot: realRepoRoot,
    sinceWindowMs: windowMs,
    nowMs,
  });

  let cliCompiles = 0;
  let mcpCompiles = 0;
  let sumA0 = 0;
  let sumA = 0;
  let sumB = 0;
  let sumTotal = 0;
  let sumMs = 0;

  let zoneA0Eligible = 0;
  let zoneA0RepeatHits = 0;
  let zoneA0CrossRoleHits = 0;
  let zoneA0CacheableTokensReused = 0;
  const lastRoleByA0Hash = new Map<string, string>();

  for (const ev of events) {
    if (ev.source === "mcp") {
      mcpCompiles += 1;
    } else {
      cliCompiles += 1;
    }
    sumA0 += ev.zone_a0_tokens;
    sumA += ev.zone_a_tokens;
    sumB += ev.zone_b_tokens;
    sumTotal += ev.total_tokens;
    sumMs += ev.compile_ms;

    if (ev.layout === "split" && ev.zone_a0_tokens >= KV_CACHE_MIN_FLOOR_TOKENS) {
      zoneA0Eligible += 1;
      const lastRole = lastRoleByA0Hash.get(ev.zone_a0_sha256);
      if (lastRole === undefined) {
        lastRoleByA0Hash.set(ev.zone_a0_sha256, ev.role);
      } else {
        zoneA0RepeatHits += 1;
        zoneA0CacheableTokensReused += ev.zone_a0_tokens;
        if (ev.role !== lastRole) {
          zoneA0CrossRoleHits += 1;
        }
        lastRoleByA0Hash.set(ev.zone_a0_sha256, ev.role);
      }
    }
  }

  const compilesTotal = events.length;
  const avgZoneA0Tokens = compilesTotal === 0 ? 0 : Math.round(sumA0 / compilesTotal);
  const avgZoneATokens = compilesTotal === 0 ? 0 : Math.round(sumA / compilesTotal);
  const avgZoneBTokens = compilesTotal === 0 ? 0 : Math.round(sumB / compilesTotal);
  const avgTotalTokens = compilesTotal === 0 ? 0 : Math.round(sumTotal / compilesTotal);
  const avgCompileMs = compilesTotal === 0 ? 0 : Number((sumMs / compilesTotal).toFixed(2));
  const estimatedCacheDiscount = Math.round(zoneA0CacheableTokensReused * 0.9);

  const effectiveBaselinePaths = explicitBaselinePaths ?? config?.metrics?.baseline_paths;
  const baseline = measureBaselineDocs(realRepoRoot, effectiveBaselinePaths);

  let tokensAvoidedVsBaseline = 0;
  let compressionRatioPct = 0;
  if (compilesTotal > 0 && baseline.tokensEst > 0) {
    for (const ev of events) {
      tokensAvoidedVsBaseline += Math.max(0, baseline.tokensEst - ev.total_tokens);
    }
    const meanTotal = sumTotal / compilesTotal;
    const rawPct = ((baseline.tokensEst - meanTotal) / baseline.tokensEst) * 100;
    compressionRatioPct = Number(Math.max(0, Math.min(100, rawPct)).toFixed(1));
  }

  const result: StatsResult = {
    enabled,
    since: sinceLabel,
    ...(action !== undefined ? { action } : {}),
    compiles_total: compilesTotal,
    cli_compiles: cliCompiles,
    mcp_compiles: mcpCompiles,
    zone_a0_eligible_compiles: zoneA0Eligible,
    zone_a0_repeat_hits: zoneA0RepeatHits,
    zone_a0_cross_role_hits: zoneA0CrossRoleHits,
    zone_a0_cacheable_tokens_reused: zoneA0CacheableTokensReused,
    estimated_cache_discount_tokens_at_90pct: estimatedCacheDiscount,
    avg_zone_a0_tokens: avgZoneA0Tokens,
    avg_zone_a_tokens: avgZoneATokens,
    avg_zone_b_tokens: avgZoneBTokens,
    avg_total_tokens: avgTotalTokens,
    avg_compile_ms: avgCompileMs,
    baseline_paths_used: baseline.pathsUsed,
    baseline_docs_files: baseline.files,
    baseline_docs_bytes: baseline.bytes,
    baseline_docs_tokens_est: baseline.tokensEst,
    tokens_avoided_vs_baseline_docs: tokensAvoidedVsBaseline,
    compression_ratio_pct: compressionRatioPct,
    skipped_corrupt_lines: skippedCorruptLines,
    methodology_note: METHODOLOGY_NOTE,
  };

  // Quarantine-scrub all rendered representations fail-closed (Exit 2)
  const quarantineConfig = config?.quarantine;
  assertQuarantineClean(formatStatsText(result), {
    claimId: "stats",
    ...(quarantineConfig !== undefined ? { config: quarantineConfig } : {}),
    allowHashRefExemption: false,
  });
  assertQuarantineClean(formatStatsMarkdown(result), {
    claimId: "stats",
    ...(quarantineConfig !== undefined ? { config: quarantineConfig } : {}),
    allowHashRefExemption: false,
  });
  assertQuarantineClean(JSON.stringify(result), {
    claimId: "stats",
    ...(quarantineConfig !== undefined ? { config: quarantineConfig } : {}),
    allowHashRefExemption: false,
  });

  return result;
}
