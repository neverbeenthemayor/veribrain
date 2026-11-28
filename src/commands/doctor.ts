import { lstatSync, readdirSync, readFileSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { compileContext } from "../compiler.js";
import { isMetricsEnabled, readMetricEvents } from "../metrics.js";
import { compareAscii, toPlainAscii, truncateAscii, wrapAsciiLines } from "../normalize.js";
import { assertQuarantineClean } from "../quarantine.js";
import { hasControlOrBidiChars } from "../sanitize.js";
import {
  INVALID_ENV_FIX_HINT,
  isBlockedSystemOrIsolationPath,
  isUncOrDevicePath,
  isValidEnv,
  loadBrainConfig,
  parseDecidedFile,
  parseHypothesisFile,
  parseIsoTimestampMs,
  parseObservedFile,
  parseScarsFile,
  regressionTestFileExists,
  resolveBrainPaths,
} from "../schema.js";
import {
  type BrainConfig,
  type DecidedRecord,
  type DoctorCheck,
  type DoctorCheckId,
  type DoctorCheckStatus,
  type DoctorCheckTier,
  type DoctorMaturityLevel,
  type DoctorOptions,
  type DoctorResult,
  type EnvName,
  EXIT_BUDGET_INFEASIBLE,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_PROVENANCE_VIOLATION,
  EXIT_QUARANTINE_VIOLATION,
  type ExitCode,
  type HypothesisRecord,
  KV_CACHE_MIN_FLOOR_TOKENS,
  MAX_SCARS_BYTES,
  type ObservedRecord,
  type ScarRecord,
  VeriBrainError,
} from "../types.js";
import { evaluateBrain } from "./eval.js";
import { VERIBRAIN_HOOK_MARKER } from "./hooks.js";

const VALID_ROLE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_TEXT_COLS = 80;
const MAX_TEXT_LINES = 30;
const MAX_HOOK_READ_BYTES = 64 * 1024;
const MAX_GIT_META_READ_BYTES = 8 * 1024;

function normalizePathCmp(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideOrEqualDir(candidate: string, parentDir: string): boolean {
  const c = normalizePathCmp(candidate);
  const p = normalizePathCmp(parentDir);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

function lstatOrNull(targetPath: string): Stats | null {
  try {
    return lstatSync(targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "FS_ERROR",
      claimId: "doctor",
      rule: "fs_inspection_failed",
      detail: "Unable to inspect path inside repository.",
      fix: "Verify filesystem permissions and path length, then re-run veribrain doctor.",
    });
  }
}

function tryLstatQuiet(targetPath: string): Stats | null {
  try {
    return lstatSync(targetPath);
  } catch {
    return null;
  }
}

function tryRealpathQuiet(targetPath: string): string | null {
  try {
    return realpathSync(targetPath);
  } catch {
    return null;
  }
}

function assertNoSymlinkAncestorsTo(targetPath: string, stopAtDir?: string): void {
  const resolvedTarget = path.resolve(targetPath);
  const stopCmp = stopAtDir !== undefined ? normalizePathCmp(stopAtDir) : null;
  const shouldStopInside = stopAtDir !== undefined && isInsideOrEqualDir(resolvedTarget, stopAtDir);
  let cursor = resolvedTarget;
  while (true) {
    const isFsRoot = path.dirname(cursor) === cursor;
    if (!isFsRoot && isBlockedSystemOrIsolationPath(cursor)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "doctor",
        rule: "path_confinement_violation",
        detail: "Path traverses a forbidden system or isolated directory.",
        fix: "Run veribrain doctor inside an authorized local repository directory.",
      });
    }
    const st = lstatOrNull(cursor);
    if (st?.isSymbolicLink()) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "doctor",
        rule: "path_confinement_violation",
        detail: "Symlinked directory or ancestor is denied during .brain inspection.",
        fix: "Use real local directories without symlinks.",
      });
    }
    if (shouldStopInside && stopCmp !== null && normalizePathCmp(cursor) === stopCmp) {
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
}

function hasZeroSymlinkAncestorsQuiet(targetPath: string): boolean {
  if (isUncOrDevicePath(targetPath)) {
    return false;
  }
  let cursor = path.resolve(targetPath);
  while (true) {
    const isFsRoot = path.dirname(cursor) === cursor;
    if (!isFsRoot && isBlockedSystemOrIsolationPath(cursor)) {
      return false;
    }
    const st = tryLstatQuiet(cursor);
    if (st === null || st.isSymbolicLink()) {
      return false;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  const real = tryRealpathQuiet(targetPath);
  if (real === null || isUncOrDevicePath(real) || isBlockedSystemOrIsolationPath(real)) {
    return false;
  }
  return normalizePathCmp(real) === normalizePathCmp(path.resolve(targetPath));
}

function assertConfinedRegularFileIfExists(
  parentRealDir: string,
  fileName: string,
): { exists: boolean; filePath: string; size: number } {
  const filePath = path.join(parentRealDir, fileName);
  const st = lstatOrNull(filePath);
  if (st === null) {
    return { exists: false, filePath, size: 0 };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "doctor",
      rule: "path_confinement_violation",
      detail: "Brain file must be a regular non-symlink file inside .brain/.",
      fix: "Replace symlinked or non-regular files inside .brain/ with regular files.",
    });
  }
  let realFile: string;
  try {
    realFile = realpathSync(filePath);
  } catch {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "doctor",
      rule: "path_confinement_violation",
      detail: "Unable to resolve canonical path for .brain file.",
      fix: "Keep all .brain files as local regular files.",
    });
  }
  if (
    normalizePathCmp(realFile) !== normalizePathCmp(filePath) ||
    isUncOrDevicePath(realFile) ||
    isBlockedSystemOrIsolationPath(realFile)
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "doctor",
      rule: "path_confinement_violation",
      detail: "Brain file resolved outside .brain/ confinement.",
      fix: "Keep all .brain files as local regular files.",
    });
  }
  return { exists: true, filePath: realFile, size: st.size };
}

function assertReadOnlyBrainConfinement(
  brainDir: string,
  realRepoRoot: string,
): {
  brainExists: boolean;
  configExists: boolean;
  realBrainDir: string | null;
} {
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
    const st = lstatOrNull(candidate);
    if (st !== null) {
      nearestStat = st;
      nearestExistingIdx = i;
      break;
    }
  }

  if (nearestExistingIdx === -1 || nearestStat === null) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "doctor",
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
      claimId: "doctor",
      rule: "path_confinement_violation",
      detail: ".brain directory or ancestor cannot be a symbolic link or non-directory.",
      fix: "Use a real local directory without symlinks for --brain-dir.",
    });
  }

  assertNoSymlinkAncestorsTo(nearestExisting, insideRepoRoot ? realRepoRoot : undefined);

  let realNearest: string;
  try {
    realNearest = realpathSync(nearestExisting);
  } catch {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "doctor",
      rule: "path_confinement_violation",
      detail: "Unable to resolve canonical path for .brain ancestor.",
      fix: "Run veribrain doctor inside an authorized local repository directory.",
    });
  }
  if (isUncOrDevicePath(realNearest) || isBlockedSystemOrIsolationPath(realNearest)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "doctor",
      rule: "path_confinement_violation",
      detail: "Resolved .brain ancestor points to a forbidden system or isolated path.",
      fix: "Run veribrain doctor inside an authorized local repository directory.",
    });
  }

  const brainExists = nearestExistingIdx === 0;
  if (!brainExists) {
    return { brainExists: false, configExists: false, realBrainDir: null };
  }

  // P1-PRG4-1: Validate config.json, scars.md, and all tier dirs/files BEFORE any file read!
  const configCheck = assertConfinedRegularFileIfExists(realNearest, "config.json");
  assertConfinedRegularFileIfExists(realNearest, "scars.md");

  const tierSpecs: ReadonlyArray<[string, string]> = [
    ["decided", ".md"],
    ["observed", ".json"],
    ["hypotheses", ".json"],
  ];
  for (const [subDirName, ext] of tierSpecs) {
    const tierPath = path.join(realNearest, subDirName);
    const tierStat = lstatOrNull(tierPath);
    if (tierStat === null) {
      continue;
    }
    if (tierStat.isSymbolicLink() || !tierStat.isDirectory()) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "doctor",
        rule: "path_confinement_violation",
        detail: "Brain tier subdirectory cannot be a symbolic link or non-directory.",
        fix: "Replace symlinked subdirectories inside .brain/ with real directories.",
      });
    }
    let realTierDir: string;
    try {
      realTierDir = realpathSync(tierPath);
    } catch {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "doctor",
        rule: "path_confinement_violation",
        detail: "Unable to resolve canonical path for .brain tier directory.",
        fix: "Keep .brain subdirectories as local real directories.",
      });
    }
    if (
      normalizePathCmp(realTierDir) !== normalizePathCmp(tierPath) ||
      isUncOrDevicePath(realTierDir) ||
      isBlockedSystemOrIsolationPath(realTierDir)
    ) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "doctor",
        rule: "path_confinement_violation",
        detail: "Brain tier directory resolved outside .brain/ confinement.",
        fix: "Keep .brain subdirectories strictly inside .brain/.",
      });
    }

    let entries: string[];
    try {
      entries = readdirSync(realTierDir).sort(compareAscii);
    } catch {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "FS_ERROR",
        claimId: "doctor",
        rule: "fs_inspection_failed",
        detail: "Unable to list entries in .brain tier directory.",
        fix: "Verify filesystem permissions inside .brain/.",
      });
    }

    for (const entryName of entries) {
      if (entryName.startsWith(".") || !entryName.endsWith(ext)) {
        continue;
      }
      assertConfinedRegularFileIfExists(realTierDir, entryName);
    }
  }

  return { brainExists: true, configExists: configCheck.exists, realBrainDir: realNearest };
}

function listTierFilesSorted(dirPath: string, ext: string): string[] {
  const dirStat = tryLstatQuiet(dirPath);
  if (dirStat === null) {
    return [];
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "doctor",
      rule: "path_confinement_violation",
      detail: "Brain tier subdirectory cannot be a symbolic link or non-directory.",
      fix: "Replace symlinked subdirectories inside .brain/ with real directories.",
    });
  }
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of entries.sort(compareAscii)) {
    if (!name.endsWith(ext) || name.startsWith(".")) {
      continue;
    }
    const abs = path.join(dirPath, name);
    const st = tryLstatQuiet(abs);
    if (st === null) {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "doctor",
        rule: "path_confinement_violation",
        detail: "Brain tier file cannot be a symbolic link or non-regular file.",
        fix: "Replace symlinked files inside .brain/ with regular files.",
      });
    }
    files.push(abs);
  }
  return files;
}

// P1-PRG4-2: Strictly depth-0 .git inspection with zero-symlink-ancestor checks & verified worktree backlink
function detectManagedPreCommitHook(realRepoRoot: string): boolean {
  const dotGitPath = path.join(realRepoRoot, ".git");
  const dotGitStat = tryLstatQuiet(dotGitPath);
  if (dotGitStat === null || dotGitStat.isSymbolicLink()) {
    return false;
  }
  if (!hasZeroSymlinkAncestorsQuiet(dotGitPath)) {
    return false;
  }

  let commonDir: string;

  if (dotGitStat.isDirectory()) {
    const objectsStat = tryLstatQuiet(path.join(dotGitPath, "objects"));
    const headStat = tryLstatQuiet(path.join(dotGitPath, "HEAD"));
    const cfgStat = tryLstatQuiet(path.join(dotGitPath, "config"));
    if (
      objectsStat === null ||
      objectsStat.isSymbolicLink() ||
      !objectsStat.isDirectory() ||
      headStat === null ||
      headStat.isSymbolicLink() ||
      !headStat.isFile() ||
      cfgStat === null ||
      cfgStat.isSymbolicLink() ||
      !cfgStat.isFile()
    ) {
      return false;
    }
    commonDir = dotGitPath;
  } else if (dotGitStat.isFile()) {
    if (dotGitStat.size > MAX_GIT_META_READ_BYTES) {
      return false;
    }
    let dotGitContent: string;
    try {
      dotGitContent = readFileSync(dotGitPath, "utf8");
    } catch {
      return false;
    }
    const match = /^gitdir:\s*(.+)$/im.exec(dotGitContent);
    if (!match?.[1]) {
      return false;
    }
    const rawGitDir = match[1].trim();
    if (
      rawGitDir.length === 0 ||
      rawGitDir.includes("\0") ||
      rawGitDir.includes("\r") ||
      rawGitDir.includes("\n") ||
      hasControlOrBidiChars(rawGitDir) ||
      isUncOrDevicePath(rawGitDir)
    ) {
      return false;
    }
    const candidateGitDir = path.isAbsolute(rawGitDir)
      ? path.resolve(rawGitDir)
      : path.resolve(realRepoRoot, rawGitDir);
    if (!hasZeroSymlinkAncestorsQuiet(candidateGitDir)) {
      return false;
    }
    const gitDirStat = tryLstatQuiet(candidateGitDir);
    if (gitDirStat === null || gitDirStat.isSymbolicLink() || !gitDirStat.isDirectory()) {
      return false;
    }

    const commonDirFile = path.join(candidateGitDir, "commondir");
    const commonDirFileStat = tryLstatQuiet(commonDirFile);
    if (
      commonDirFileStat === null ||
      commonDirFileStat.isSymbolicLink() ||
      !commonDirFileStat.isFile() ||
      commonDirFileStat.size > MAX_GIT_META_READ_BYTES
    ) {
      return false;
    }
    let rawCommonDir: string;
    try {
      rawCommonDir = readFileSync(commonDirFile, "utf8").trim();
    } catch {
      return false;
    }
    if (
      rawCommonDir.length === 0 ||
      rawCommonDir.includes("\0") ||
      rawCommonDir.includes("\r") ||
      rawCommonDir.includes("\n") ||
      hasControlOrBidiChars(rawCommonDir) ||
      isUncOrDevicePath(rawCommonDir)
    ) {
      return false;
    }
    const candidateCommonDir = path.isAbsolute(rawCommonDir)
      ? path.resolve(rawCommonDir)
      : path.resolve(candidateGitDir, rawCommonDir);
    if (!hasZeroSymlinkAncestorsQuiet(candidateCommonDir)) {
      return false;
    }
    const commonDirStat = tryLstatQuiet(candidateCommonDir);
    if (commonDirStat === null || commonDirStat.isSymbolicLink() || !commonDirStat.isDirectory()) {
      return false;
    }

    // Verify worktree structural membership (<commonDir>/worktrees/<name>) AND backlink (<gitDir>/gitdir -> <realRepoRoot>/.git)
    const worktreesDir = path.join(candidateCommonDir, "worktrees");
    if (!hasZeroSymlinkAncestorsQuiet(worktreesDir)) {
      return false;
    }
    const worktreesStat = tryLstatQuiet(worktreesDir);
    if (worktreesStat === null || worktreesStat.isSymbolicLink() || !worktreesStat.isDirectory()) {
      return false;
    }
    if (normalizePathCmp(path.dirname(candidateGitDir)) !== normalizePathCmp(worktreesDir)) {
      return false;
    }

    const backlinkFile = path.join(candidateGitDir, "gitdir");
    const backlinkStat = tryLstatQuiet(backlinkFile);
    if (
      backlinkStat === null ||
      backlinkStat.isSymbolicLink() ||
      !backlinkStat.isFile() ||
      backlinkStat.size > MAX_GIT_META_READ_BYTES
    ) {
      return false;
    }
    let rawBacklink: string;
    try {
      rawBacklink = readFileSync(backlinkFile, "utf8").trim();
    } catch {
      return false;
    }
    if (
      rawBacklink.length === 0 ||
      rawBacklink.includes("\0") ||
      rawBacklink.includes("\r") ||
      rawBacklink.includes("\n") ||
      hasControlOrBidiChars(rawBacklink) ||
      isUncOrDevicePath(rawBacklink)
    ) {
      return false;
    }
    const resolvedBacklink = path.isAbsolute(rawBacklink)
      ? path.resolve(rawBacklink)
      : path.resolve(candidateGitDir, rawBacklink);
    const resolvedBacklinkStat = tryLstatQuiet(resolvedBacklink);
    if (
      resolvedBacklinkStat === null ||
      resolvedBacklinkStat.isSymbolicLink() ||
      !resolvedBacklinkStat.isFile()
    ) {
      return false;
    }
    const realBacklink = tryRealpathQuiet(resolvedBacklink);
    if (realBacklink === null || normalizePathCmp(realBacklink) !== normalizePathCmp(dotGitPath)) {
      return false;
    }

    commonDir = candidateCommonDir;
  } else {
    return false;
  }

  const hooksDir = path.join(commonDir, "hooks");
  if (!hasZeroSymlinkAncestorsQuiet(hooksDir)) {
    return false;
  }
  const hooksStat = tryLstatQuiet(hooksDir);
  if (hooksStat === null || hooksStat.isSymbolicLink() || !hooksStat.isDirectory()) {
    return false;
  }

  const preCommitPath = path.join(hooksDir, "pre-commit");
  if (!hasZeroSymlinkAncestorsQuiet(preCommitPath)) {
    return false;
  }
  const hookStat = tryLstatQuiet(preCommitPath);
  if (
    hookStat === null ||
    hookStat.isSymbolicLink() ||
    !hookStat.isFile() ||
    hookStat.size > MAX_HOOK_READ_BYTES
  ) {
    return false;
  }
  try {
    const content = readFileSync(preCommitPath, "utf8");
    return content.includes(VERIBRAIN_HOOK_MARKER);
  } catch {
    return false;
  }
}

function makeSkippedDependentChecks(reason: string): DoctorCheck[] {
  const specs: Array<{ id: DoctorCheckId; tier: DoctorCheckTier }> = [
    { id: "eval.strict", tier: "eval" },
    { id: "tier1.decided", tier: "tier1" },
    { id: "zone_a0.floor", tier: "tier1" },
    { id: "tier2.observed", tier: "tier2" },
    { id: "tier3.scars", tier: "tier3" },
    { id: "tier3.hypotheses", tier: "tier3" },
    { id: "telemetry.stats", tier: "telemetry" },
  ];
  return specs.map((s) => ({
    id: s.id,
    tier: s.tier,
    status: "INFO",
    summary: `skipped (${reason})`,
    fix: [],
  }));
}

function computeMaturity(params: {
  brainPresent: boolean;
  evalPass: boolean;
  activeDecidedCount: number;
  zoneA0MeetsFloor: boolean;
  activeObservedForEnv: number;
  hasManagedPreCommitHook: boolean;
  scarsCount: number;
  missingTestScarsCount: number;
  expiredScarsCount: number;
  scarsWithinBudget: boolean;
  metricsEnabled: boolean;
}): { level: DoctorMaturityLevel; score: 0 | 1 | 2 | 3 | 4; label: string } {
  const l1 = params.brainPresent && params.evalPass && params.activeDecidedCount >= 1;
  if (!l1) {
    const label = !params.brainPresent
      ? "Not initialized"
      : !params.evalPass
        ? "Eval failing"
        : "Needs Tier 1 baseline";
    return { level: "L0", score: 0, label };
  }

  const l2 = params.zoneA0MeetsFloor;
  if (!l2) {
    return { level: "L1", score: 1, label: "Tier 1 verified" };
  }

  const l3 = params.activeObservedForEnv >= 1 || params.hasManagedPreCommitHook;
  if (!l3) {
    return { level: "L2", score: 2, label: "Tier 1 + shared prefix" };
  }

  const l4 =
    params.scarsCount >= 1 &&
    params.missingTestScarsCount === 0 &&
    params.expiredScarsCount === 0 &&
    params.scarsWithinBudget &&
    params.metricsEnabled;
  if (!l4) {
    return { level: "L3", score: 3, label: "Tier 1 + 2 verified" };
  }

  return { level: "L4", score: 4, label: "Full 3-tier + telemetry" };
}

function buildDoctorResult(params: {
  strict: boolean;
  role: string;
  env: EnvName;
  maturity: DoctorResult["maturity"];
  checks: DoctorCheck[];
  quarantineConfig?: BrainConfig["quarantine"];
  evalExitCode?: ExitCode;
}): DoctorResult {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  let info = 0;
  for (const check of params.checks) {
    switch (check.status) {
      case "PASS":
        pass += 1;
        break;
      case "WARN":
        warn += 1;
        break;
      case "FAIL":
        fail += 1;
        break;
      case "INFO":
        info += 1;
        break;
    }
  }

  const provenanceFailed = params.evalExitCode === EXIT_PROVENANCE_VIOLATION;
  const ok = !provenanceFailed && (params.strict ? fail === 0 && warn === 0 : fail === 0);
  const exitCode: ExitCode = provenanceFailed
    ? EXIT_PROVENANCE_VIOLATION
    : ok
      ? EXIT_OK
      : EXIT_ERROR;

  const result: DoctorResult = {
    ok,
    exit_code: exitCode,
    strict: params.strict,
    role: params.role,
    env: params.env,
    maturity: params.maturity,
    counts: { pass, warn, fail, info },
    checks: params.checks,
  };

  assertQuarantineClean(formatDoctorText(result), {
    claimId: "doctor",
    ...(params.quarantineConfig !== undefined ? { config: params.quarantineConfig } : {}),
    allowHashRefExemption: false,
  });
  assertQuarantineClean(formatDoctorMarkdown(result), {
    claimId: "doctor",
    ...(params.quarantineConfig !== undefined ? { config: params.quarantineConfig } : {}),
    allowHashRefExemption: false,
  });
  assertQuarantineClean(JSON.stringify(result), {
    claimId: "doctor",
    ...(params.quarantineConfig !== undefined ? { config: params.quarantineConfig } : {}),
    allowHashRefExemption: false,
  });

  return result;
}

function annotateFixAudience(fix: string): string {
  if (
    fix.startsWith("veribrain init") ||
    fix.startsWith("veribrain decide") ||
    fix.startsWith("veribrain hooks install") ||
    fix.startsWith("veribrain promote") ||
    fix.startsWith("veribrain stats --enable") ||
    fix.startsWith("veribrain stats --reset")
  ) {
    return `(human) ${fix}`;
  }
  if (fix.startsWith("veribrain attest-test") || fix.startsWith("veribrain observe")) {
    return `(human/CI) ${fix}`;
  }
  return fix;
}

function collectOrderedFixes(checks: readonly DoctorCheck[]): string[] {
  const orderedStatuses: DoctorCheckStatus[] = ["FAIL", "WARN", "INFO"];
  const uniqueFixes: string[] = [];
  const seenFixes = new Set<string>();
  for (const status of orderedStatuses) {
    for (const check of checks) {
      if (check.status !== status) continue;
      for (const fix of check.fix) {
        if (!seenFixes.has(fix)) {
          seenFixes.add(fix);
          uniqueFixes.push(fix);
        }
      }
    }
  }
  return uniqueFixes;
}

export function formatDoctorText(result: DoctorResult): string {
  const lines: string[] = [];
  const strictSuffix = result.strict ? ", strict" : "";
  lines.push(
    truncateAscii(
      `VeriBrain Doctor (role=${result.role}, env=${result.env}${strictSuffix})`,
      MAX_TEXT_COLS,
    ),
  );
  lines.push(
    truncateAscii(`Maturity: ${result.maturity.level}/4 (${result.maturity.label})`, MAX_TEXT_COLS),
  );
  lines.push(
    truncateAscii(
      `Checks: ${result.counts.pass} PASS | ${result.counts.warn} WARN | ${result.counts.fail} FAIL | ${result.counts.info} INFO`,
      MAX_TEXT_COLS,
    ),
  );

  for (const check of result.checks) {
    const tag = `[${check.status.padEnd(4, " ")}]`;
    const idCol = check.id.padEnd(16, " ");
    const cleanSummary = toPlainAscii(check.summary).replace(/\s+/g, " ").trim();
    const row = `${tag} ${idCol} ${cleanSummary}`;
    lines.push(row.length <= MAX_TEXT_COLS ? row : `${row.slice(0, MAX_TEXT_COLS - 3)}...`);
  }

  const uniqueFixes = collectOrderedFixes(result.checks);
  if (uniqueFixes.length === 0) {
    lines.push("Next: healthy (no required actions).");
  } else {
    lines.push("Next actions:");
    for (let i = 0; i < uniqueFixes.length; i += 1) {
      const fix = uniqueFixes[i] as string;
      const displayFix = annotateFixAudience(fix);
      const wrapped = wrapAsciiLines(`  - ${displayFix}`, MAX_TEXT_COLS, "    ");
      const remainingAfterThis = uniqueFixes.length - (i + 1);
      const reserveForOverflow = remainingAfterThis > 0 ? 1 : 0;
      if (lines.length + wrapped.length + reserveForOverflow > MAX_TEXT_LINES) {
        const omittedCount = uniqueFixes.length - i;
        if (lines.length < MAX_TEXT_LINES) {
          lines.push(`  +${omittedCount} more (see --format md)`);
        }
        break;
      }
      lines.push(...wrapped);
    }
  }

  return `${lines.slice(0, MAX_TEXT_LINES).join("\n")}\n`;
}

export function formatDoctorMarkdown(result: DoctorResult): string {
  const lines: string[] = [
    `# VeriBrain Doctor Report (role=${result.role}, env=${result.env}${result.strict ? ", strict" : ""})`,
    "",
    `- Maturity: **${result.maturity.level}/4** (${result.maturity.label})`,
    `- Status: ${result.ok ? "OK" : "ACTION REQUIRED"} (exit ${result.exit_code})`,
    `- Checks: ${result.counts.pass} PASS | ${result.counts.warn} WARN | ${result.counts.fail} FAIL | ${result.counts.info} INFO`,
    "",
    "## Diagnostics",
    "| Check | Tier | Status | Summary |",
    "| :--- | :--- | :--- | :--- |",
  ];

  for (const check of result.checks) {
    const safeSummary = check.summary.replace(/\|/g, "/");
    lines.push(`| \`${check.id}\` | ${check.tier} | **${check.status}** | ${safeSummary} |`);
  }

  const uniqueFixes = collectOrderedFixes(result.checks);
  lines.push("", "## Next Actions");
  if (uniqueFixes.length === 0) {
    lines.push("- All checks healthy; no required actions.");
  } else {
    for (const fix of uniqueFixes) {
      const display = annotateFixAudience(fix);
      if (display.startsWith("(human) ") || display.startsWith("(human/CI) ")) {
        const spaceIdx = display.indexOf(" ");
        const badge = display.slice(0, spaceIdx);
        const cmd = display.slice(spaceIdx + 1);
        lines.push(`- ${badge} \`${cmd}\``);
      } else {
        lines.push(`- \`${fix}\``);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function runDoctor(options: DoctorOptions = {}): DoctorResult {
  const envVars = options.envVars ?? process.env;
  const strict = Boolean(options.strict);

  // Quarantine-check ALL raw flag inputs BEFORE validation (Exit 2 always wins, zero echo)
  if (options.format !== undefined) {
    assertQuarantineClean(String(options.format), {
      claimId: "doctor",
      field: "format",
      allowHashRefExemption: false,
    });
  }
  const rawRole = options.role ?? "builder";
  assertQuarantineClean(rawRole, {
    claimId: "doctor",
    field: "role",
    allowHashRefExemption: false,
  });
  const rawEnv = options.env ?? "local";
  assertQuarantineClean(String(rawEnv), {
    claimId: "doctor",
    field: "env",
    allowHashRefExemption: false,
  });

  if (
    options.format !== undefined &&
    options.format !== "text" &&
    options.format !== "md" &&
    options.format !== "json"
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "doctor",
      rule: "invalid_format",
      detail: "--format must be text, md, or json.",
      fix: "Pass --format text|md|json.",
    });
  }

  const role = rawRole.trim();
  if (!VALID_ROLE_RE.test(role)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "doctor",
      rule: "invalid_role",
      detail: "--role must match ^[A-Za-z0-9._-]{1,64}$.",
      fix: "Pass a valid role identifier such as --role builder.",
    });
  }

  const envStr = String(rawEnv).trim();
  if (!isValidEnv(envStr)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "doctor",
      rule: "invalid_env",
      detail: "--env must be local, pre-staging, staging, or prod.",
      fix: INVALID_ENV_FIX_HINT,
    });
  }
  const env: EnvName = envStr;

  // P1-PRG4-3: Validate raw & resolved repoRoot BEFORE resolveBrainPaths!
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
        claimId: "doctor",
        rule: "path_confinement_violation",
        detail: "doctor refuses UNC, device, system, or isolated workspace paths.",
        fix: "Run veribrain doctor inside an authorized local repository directory.",
      });
    }
  }

  const resolvedRepoRoot = path.resolve(options.repoRoot ?? process.cwd());
  if (isUncOrDevicePath(resolvedRepoRoot) || isBlockedSystemOrIsolationPath(resolvedRepoRoot)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "doctor",
      rule: "path_confinement_violation",
      detail: "Resolved repository root points to a forbidden system or isolated path.",
      fix: "Run veribrain doctor inside an authorized local repository directory.",
    });
  }

  // P2-PRG4-1: lstatSync(resolvedRepoRoot) with static error handling for ENOENT / ENOTDIR / OS errors
  let repoStat: Stats;
  try {
    repoStat = lstatSync(resolvedRepoRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "doctor",
        rule: "path_confinement_violation",
        detail: "Repository root path traverses a non-directory component.",
        fix: "Pass a real local repository directory to --repo-root.",
      });
    }
    if (code === "ENOENT") {
      // Cross-platform parity: Windows libuv reports ENOENT (not ENOTDIR) when an ancestor is a regular file.
      let ancestor = path.dirname(resolvedRepoRoot);
      while (true) {
        const ancStat = lstatOrNull(ancestor);
        if (ancStat !== null) {
          if (ancStat.isSymbolicLink() || !ancStat.isDirectory()) {
            throw new VeriBrainError({
              exitCode: EXIT_PROVENANCE_VIOLATION,
              code: "PROVENANCE_VIOLATION",
              claimId: "doctor",
              rule: "path_confinement_violation",
              detail: "Repository root path traverses a symlinked or non-directory component.",
              fix: "Pass a real local repository directory to --repo-root.",
            });
          }
          assertNoSymlinkAncestorsTo(ancestor);
          break;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          break;
        }
        ancestor = parent;
      }
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "REPO_ROOT_NOT_FOUND",
        claimId: "doctor",
        rule: "repo_root_not_found",
        detail: "Repository root directory does not exist.",
        fix: "Pass an existing local repository directory to --repo-root.",
      });
    }
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "FS_ERROR",
      claimId: "doctor",
      rule: "repo_root_unreadable",
      detail: "Unable to inspect repository root directory.",
      fix: "Verify filesystem permissions and pass a valid local directory to --repo-root.",
    });
  }
  if (repoStat.isSymbolicLink() || !repoStat.isDirectory()) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "doctor",
      rule: "path_confinement_violation",
      detail: "Repository root must be a real non-symlink directory.",
      fix: "Pass a real local repository directory to --repo-root.",
    });
  }

  let realRepoRoot: string;
  try {
    realRepoRoot = realpathSync(resolvedRepoRoot);
  } catch {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "FS_ERROR",
      claimId: "doctor",
      rule: "repo_root_unreadable",
      detail: "Unable to resolve canonical repository root path.",
      fix: "Pass an accessible local repository directory to --repo-root.",
    });
  }
  if (isUncOrDevicePath(realRepoRoot) || isBlockedSystemOrIsolationPath(realRepoRoot)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "doctor",
      rule: "path_confinement_violation",
      detail: "Resolved repository root points to a forbidden system or isolated path.",
      fix: "Run veribrain doctor inside an authorized local repository directory.",
    });
  }

  // P1-PRG4-3: Disable worktree fallback so crafted .git / parent repos never pull another repo's .brain/
  const { brainDir: resolvedBrainDir } = resolveBrainPaths(options.brainDir, realRepoRoot, {
    allowWorktreeFallback: false,
  });
  if (isUncOrDevicePath(resolvedBrainDir) || isBlockedSystemOrIsolationPath(resolvedBrainDir)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "doctor",
      rule: "path_confinement_violation",
      detail: "Resolved .brain path points to a forbidden system or isolated path.",
      fix: "Run veribrain doctor inside an authorized local repository directory.",
    });
  }

  const brainDir = isInsideOrEqualDir(resolvedBrainDir, resolvedRepoRoot)
    ? path.resolve(realRepoRoot, path.relative(resolvedRepoRoot, resolvedBrainDir))
    : resolvedBrainDir;

  // P1-PRG4-1: Confine .brain/, config.json, scars.md, and all tier dirs/files BEFORE any read!
  const { brainExists, configExists } = assertReadOnlyBrainConfinement(brainDir, realRepoRoot);
  const now = options.now ?? new Date();
  const nowMs = now.getTime();

  // Check 1: brain.present
  if (!brainExists || !configExists) {
    const checks: DoctorCheck[] = [
      {
        id: "brain.present",
        tier: "brain",
        status: "FAIL",
        summary: ".brain/ or config.json not found.",
        fix: ['veribrain init --signed-by "<Your Name>"'],
      },
      ...makeSkippedDependentChecks("no .brain/config.json"),
    ];
    return buildDoctorResult({
      strict,
      role,
      env,
      maturity: { level: "L0", score: 0, label: "Not initialized" },
      checks,
    });
  }

  let config: BrainConfig;
  try {
    config = loadBrainConfig(brainDir, true);
  } catch (err) {
    if (err instanceof VeriBrainError && err.exitCode === EXIT_QUARANTINE_VIOLATION) {
      throw err;
    }
    const checks: DoctorCheck[] = [
      {
        id: "brain.present",
        tier: "brain",
        status: "FAIL",
        summary: ".brain/config.json failed schema validation.",
        fix: ["veribrain eval --strict"],
      },
      ...makeSkippedDependentChecks("invalid config.json"),
    ];
    return buildDoctorResult({
      strict,
      role,
      env,
      maturity: { level: "L0", score: 0, label: "Config invalid" },
      checks,
    });
  }

  const checks: DoctorCheck[] = [
    {
      id: "brain.present",
      tier: "brain",
      status: "PASS",
      summary: `Brain initialized (schema ${config.schema_version}).`,
      fix: [],
    },
  ];

  // Check 2: eval.strict (including mirror check iff config.mirror_dirs non-empty)
  const checkMirror = Boolean(config.mirror_dirs && config.mirror_dirs.length > 0);
  const evalRes = evaluateBrain({
    brainDir,
    repoRoot: realRepoRoot,
    strict: true,
    checkMirror,
    now,
    bypassReadCache: true,
  });
  const evalPass = evalRes.ok;
  checks.push(
    evalPass
      ? {
          id: "eval.strict",
          tier: "eval",
          status: "PASS",
          summary: checkMirror
            ? "Strict eval + mirror parity passed (0 issues)."
            : "Strict eval passed (0 issues).",
          fix: [],
        }
      : {
          id: "eval.strict",
          tier: "eval",
          status: "FAIL",
          summary: `Strict eval failed (${evalRes.issues.length} issue(s)).`,
          fix: [checkMirror ? "veribrain eval --strict --check-mirror" : "veribrain eval --strict"],
        },
  );

  // Resiliently read tier collections (always rethrowing quarantine Exit 2 / provenance Exit 4)
  const decided: DecidedRecord[] = [];
  for (const file of listTierFilesSorted(path.join(brainDir, "decided"), ".md")) {
    try {
      decided.push(parseDecidedFile(file, config.quarantine, true));
    } catch (err) {
      if (err instanceof VeriBrainError && err.exitCode === EXIT_QUARANTINE_VIOLATION) {
        throw err;
      }
    }
  }

  const observed: ObservedRecord[] = [];
  for (const file of listTierFilesSorted(path.join(brainDir, "observed"), ".json")) {
    try {
      observed.push(parseObservedFile(file, config.quarantine, true));
    } catch (err) {
      if (err instanceof VeriBrainError && err.exitCode === EXIT_QUARANTINE_VIOLATION) {
        throw err;
      }
    }
  }

  const hypotheses: HypothesisRecord[] = [];
  for (const file of listTierFilesSorted(path.join(brainDir, "hypotheses"), ".json")) {
    try {
      hypotheses.push(parseHypothesisFile(file, config.quarantine, { now, bypassReadCache: true }));
    } catch (err) {
      if (err instanceof VeriBrainError && err.exitCode === EXIT_QUARANTINE_VIOLATION) {
        throw err;
      }
    }
  }

  let scars: ScarRecord[] = [];
  let scarsBytes = 0;
  let scarsOverBudget = false;
  let scarsParseFailed = false;
  const scarsPath = path.join(brainDir, "scars.md");
  try {
    const parsedScars = parseScarsFile(brainDir, config.quarantine, { now, bypassReadCache: true });
    scars = parsedScars.scars;
    scarsBytes = parsedScars.scarsBytes;
    scarsOverBudget = scarsBytes >= MAX_SCARS_BYTES;
  } catch (err) {
    if (err instanceof VeriBrainError && err.exitCode === EXIT_QUARANTINE_VIOLATION) {
      throw err;
    }
    const st = tryLstatQuiet(scarsPath);
    if (st?.isFile()) {
      scarsBytes = st.size;
      scarsOverBudget = scarsBytes >= MAX_SCARS_BYTES;
    }
    if (!scarsOverBudget) {
      scarsParseFailed = true;
    }
  }

  // Check 3: tier1.decided (CUDE P1 copy-paste valid decide command)
  const activeDecided = decided.filter((d) => d.status === "active");
  const sharedActiveDecided = activeDecided.filter((d) => d.roles.includes("*"));
  const copyPasteDecideFix =
    'veribrain decide --id DEC-NNN --priority P0 --signed-by "<Your Name>" --body "<rule>"';
  if (activeDecided.length === 0) {
    checks.push({
      id: "tier1.decided",
      tier: "tier1",
      status: "WARN",
      summary: "0 active DECIDED rules (Tier 1 empty).",
      fix: [copyPasteDecideFix],
    });
  } else if (sharedActiveDecided.length === 0) {
    checks.push({
      id: "tier1.decided",
      tier: "tier1",
      status: "WARN",
      summary: `${activeDecided.length} active DECIDED, 0 shared roles: ["*"].`,
      fix: [copyPasteDecideFix],
    });
  } else {
    checks.push({
      id: "tier1.decided",
      tier: "tier1",
      status: "PASS",
      summary: `${activeDecided.length} active DECIDED rule(s) (${sharedActiveDecided.length} shared).`,
      fix: [],
    });
  }

  // Check 4: zone_a0.floor (compile with split layout, strictly recordMetrics: false)
  let zoneA0MeetsFloor = false;
  const effectiveDefaultLayout =
    config.zone_a_layout ?? (config.schema_version === "1.1" ? "split" : "legacy");
  const isLegacyDefault = effectiveDefaultLayout === "legacy";
  try {
    const compiled = compileContext({
      role,
      env,
      zoneALayout: "split",
      brainDir,
      repoRoot: realRepoRoot,
      now,
      bypassReadCache: true,
      recordMetrics: false,
      envVars,
    });
    const a0Tokens = compiled.zone_a0_tokens_est;
    zoneA0MeetsFloor = a0Tokens >= KV_CACHE_MIN_FLOOR_TOKENS;
    if (!zoneA0MeetsFloor) {
      const fixHints = ['Add shared roles: ["*"] DECIDED rules to reach >= 1024 est. tokens'];
      if (isLegacyDefault) {
        fixHints.push('Set "schema_version": "1.1" in .brain/config.json or --zone-a-layout split');
      }
      checks.push({
        id: "zone_a0.floor",
        tier: "tier1",
        status: "WARN",
        summary: `Split Zone A0: ${a0Tokens}/${KV_CACHE_MIN_FLOOR_TOKENS} est. tok (below floor).`,
        fix: fixHints,
      });
    } else if (isLegacyDefault) {
      checks.push({
        id: "zone_a0.floor",
        tier: "tier1",
        status: "INFO",
        summary: `Split Zone A0: ${a0Tokens} tok (>=1024); config legacy.`,
        fix: ['Set "schema_version": "1.1" in .brain/config.json or --zone-a-layout split'],
      });
    } else {
      checks.push({
        id: "zone_a0.floor",
        tier: "tier1",
        status: "PASS",
        summary: `Split Zone A0: ${a0Tokens} est. tok (>=${KV_CACHE_MIN_FLOOR_TOKENS} floor).`,
        fix: [],
      });
    }
  } catch (err) {
    if (err instanceof VeriBrainError && err.exitCode === EXIT_QUARANTINE_VIOLATION) {
      throw err;
    }
    if (err instanceof VeriBrainError && err.exitCode === EXIT_BUDGET_INFEASIBLE) {
      checks.push({
        id: "zone_a0.floor",
        tier: "tier1",
        status: "FAIL",
        summary: `Split compile exceeded max_tokens (${config.default_max_tokens}).`,
        fix: [
          `veribrain compile --role ${role} --env ${env} --zone-a-layout split --max-tokens <n>`,
        ],
      });
    } else {
      checks.push({
        id: "zone_a0.floor",
        tier: "tier1",
        status: "FAIL",
        summary: "Split compile failed (fix eval --strict first).",
        fix: ["veribrain eval --strict"],
      });
    }
  }

  // Check 5: tier2.observed + depth-0 hardened pre-commit hook detection
  const activeObservedForEnv = observed.filter((o) => {
    if (o.env !== env) return false;
    const obsMs = parseIsoTimestampMs(o.observed_at_utc) ?? 0;
    return nowMs <= obsMs + o.ttl_seconds * 1000;
  });
  const hasManagedPreCommitHook = detectManagedPreCommitHook(realRepoRoot);
  if (activeObservedForEnv.length === 0) {
    const tier2Fixes: string[] = [];
    if (!hasManagedPreCommitHook) {
      tier2Fixes.push("veribrain hooks install");
    }
    tier2Fixes.push(`veribrain attest-test --env ${env} -- npm test`, "veribrain observe --help");
    checks.push({
      id: "tier2.observed",
      tier: "tier2",
      status: "WARN",
      summary: hasManagedPreCommitHook
        ? `0 active OBSERVED for ${env} (managed hook ok).`
        : `0 active OBSERVED for ${env}; hook absent.`,
      fix: tier2Fixes,
    });
  } else if (!hasManagedPreCommitHook) {
    checks.push({
      id: "tier2.observed",
      tier: "tier2",
      status: "INFO",
      summary: `${activeObservedForEnv.length} active OBSERVED for ${env}; hook absent.`,
      fix: ["veribrain hooks install"],
    });
  } else {
    checks.push({
      id: "tier2.observed",
      tier: "tier2",
      status: "PASS",
      summary: `${activeObservedForEnv.length} active OBSERVED for ${env}; managed hook ok.`,
      fix: [],
    });
  }

  // Check 6: tier3.scars (strict < 4096 B boundary + malformed scars.md FAIL)
  const expiredScars = scars.filter((s) => nowMs > (parseIsoTimestampMs(s.expires_at_utc) ?? 0));
  const missingTestScars = scars.filter(
    (s) => !regressionTestFileExists(realRepoRoot, s.regression_test),
  );
  const pendingScarProposals = hypotheses.filter((h) => {
    const isScarProp =
      h.kind === "scar_proposal" || h.kind === "hypothesis_scar" || h.id.startsWith("HYP-SCAR-");
    const expMs = parseIsoTimestampMs(h.expires_at_utc) ?? 0;
    return isScarProp && nowMs <= expMs;
  });
  const nearScarsBudget = scarsBytes >= Math.ceil(MAX_SCARS_BYTES * 0.8);

  if (scarsOverBudget || scarsBytes >= MAX_SCARS_BYTES) {
    checks.push({
      id: "tier3.scars",
      tier: "tier3",
      status: "FAIL",
      summary: `scars.md at/over budget (${scarsBytes}/${MAX_SCARS_BYTES} B).`,
      fix: ["Prune .brain/scars.md below 4096 B and run veribrain eval --strict"],
    });
  } else if (scarsParseFailed) {
    checks.push({
      id: "tier3.scars",
      tier: "tier3",
      status: "FAIL",
      summary: "scars.md failed schema validation.",
      fix: ["veribrain eval --strict"],
    });
  } else if (nearScarsBudget || expiredScars.length > 0 || missingTestScars.length > 0) {
    const parts: string[] = [`${scarsBytes}/${MAX_SCARS_BYTES} B`];
    if (expiredScars.length > 0) parts.push(`${expiredScars.length} exp`);
    if (missingTestScars.length > 0) parts.push(`${missingTestScars.length} miss`);
    if (pendingScarProposals.length > 0) parts.push(`${pendingScarProposals.length} pend`);
    const fixes = ["veribrain diff --since 7d"];
    if (pendingScarProposals.length > 0) {
      fixes.push("veribrain promote <HYP-ID> --to scar");
    }
    checks.push({
      id: "tier3.scars",
      tier: "tier3",
      status: "WARN",
      summary: `scars.md attention: ${parts.join(", ")}.`,
      fix: fixes,
    });
  } else if (pendingScarProposals.length > 0) {
    checks.push({
      id: "tier3.scars",
      tier: "tier3",
      status: "INFO",
      summary: `${scars.length} scar(s) (${scarsBytes}/${MAX_SCARS_BYTES} B); ${pendingScarProposals.length} pending.`,
      fix: ["veribrain promote <HYP-ID> --to scar"],
    });
  } else if (scars.length === 0) {
    checks.push({
      id: "tier3.scars",
      tier: "tier3",
      status: "INFO",
      summary: `0 scars (${scarsBytes}/${MAX_SCARS_BYTES} B).`,
      fix: [],
    });
  } else {
    checks.push({
      id: "tier3.scars",
      tier: "tier3",
      status: "PASS",
      summary: `${scars.length} scar(s) verified (${scarsBytes}/${MAX_SCARS_BYTES} B).`,
      fix: [],
    });
  }

  // Check 7: tier3.hypotheses
  const expiredHypotheses = hypotheses.filter(
    (h) => nowMs > (parseIsoTimestampMs(h.expires_at_utc) ?? 0),
  );
  const activeHypothesesCount = hypotheses.length - expiredHypotheses.length;
  if (expiredHypotheses.length > 0) {
    checks.push({
      id: "tier3.hypotheses",
      tier: "tier3",
      status: "WARN",
      summary: `${expiredHypotheses.length} expired hypothesis file(s) (${activeHypothesesCount} active).`,
      fix: ["veribrain diff --since 7d"],
    });
  } else if (activeHypothesesCount > 0) {
    checks.push({
      id: "tier3.hypotheses",
      tier: "tier3",
      status: "INFO",
      summary: `${activeHypothesesCount} active hypothesis file(s) awaiting review.`,
      fix: ["veribrain diff --since 7d"],
    });
  } else {
    checks.push({
      id: "tier3.hypotheses",
      tier: "tier3",
      status: "PASS",
      summary: "0 expired hypotheses (0 pending).",
      fix: [],
    });
  }

  // Check 8: telemetry.stats (read-only, resilient on oversized ledger, warns on corrupt lines)
  const metricsEnabled = isMetricsEnabled(config, { envVars });
  let metricsEventsCount = 0;
  let metricsSkippedCorrupt = 0;
  let metricsReadFailed = false;
  try {
    const readRes = readMetricEvents(brainDir, {
      repoRoot: realRepoRoot,
      sinceWindowMs: null,
      nowMs,
    });
    metricsEventsCount = readRes.events.length;
    metricsSkippedCorrupt = readRes.skippedCorruptLines;
  } catch (err) {
    if (
      err instanceof VeriBrainError &&
      (err.exitCode === EXIT_QUARANTINE_VIOLATION || err.exitCode === EXIT_PROVENANCE_VIOLATION)
    ) {
      throw err;
    }
    metricsReadFailed = true;
  }

  if (metricsReadFailed) {
    checks.push({
      id: "telemetry.stats",
      tier: "telemetry",
      status: "FAIL",
      summary: "Metrics ledger unreadable or oversized.",
      fix: ["veribrain stats --reset"],
    });
  } else if (metricsSkippedCorrupt > 0) {
    checks.push({
      id: "telemetry.stats",
      tier: "telemetry",
      status: "WARN",
      summary: `Telemetry has ${metricsSkippedCorrupt} corrupt JSONL line(s).`,
      fix: ["veribrain stats --reset"],
    });
  } else if (!metricsEnabled) {
    checks.push({
      id: "telemetry.stats",
      tier: "telemetry",
      status: "INFO",
      summary: "Local compile telemetry disabled (opt-in).",
      fix: ["veribrain stats --enable"],
    });
  } else if (metricsEventsCount === 0) {
    checks.push({
      id: "telemetry.stats",
      tier: "telemetry",
      status: "INFO",
      summary: "Telemetry enabled, 0 compiles recorded yet.",
      fix: [`veribrain compile --role ${role} --env ${env}`],
    });
  } else {
    checks.push({
      id: "telemetry.stats",
      tier: "telemetry",
      status: "PASS",
      summary: `Telemetry enabled (${metricsEventsCount} compile(s) recorded).`,
      fix: [],
    });
  }

  const maturity = computeMaturity({
    brainPresent: true,
    evalPass,
    activeDecidedCount: activeDecided.length,
    zoneA0MeetsFloor,
    activeObservedForEnv: activeObservedForEnv.length,
    hasManagedPreCommitHook,
    scarsCount: scars.length,
    missingTestScarsCount: missingTestScars.length,
    expiredScarsCount: expiredScars.length,
    scarsWithinBudget: !scarsParseFailed && !scarsOverBudget && scarsBytes < MAX_SCARS_BYTES,
    metricsEnabled,
  });

  return buildDoctorResult({
    strict,
    role,
    env,
    maturity,
    checks,
    quarantineConfig: config.quarantine,
    evalExitCode: evalRes.exitCode,
  });
}
