import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { compareAscii, sha256Hex } from "./normalize.js";
import { hasControlOrBidiChars } from "./sanitize.js";
import {
  invalidateFileReadCache,
  isBlockedSystemOrIsolationPath,
  isUncOrDevicePath,
} from "./schema.js";
import {
  type BrainConfig,
  type EvalIssue,
  EXIT_ERROR,
  EXIT_PROVENANCE_VIOLATION,
  VeriBrainError,
} from "./types.js";

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

function isSameOrNestedPath(a: string, b: string): boolean {
  const cmpA = normalizePathCmp(a);
  const cmpB = normalizePathCmp(b);
  return (
    cmpA === cmpB || cmpA.startsWith(`${cmpB}${path.sep}`) || cmpB.startsWith(`${cmpA}${path.sep}`)
  );
}

function resolveMirrorBrainTarget(realMirrorRoot: string): string {
  if (path.basename(realMirrorRoot) === ".brain") {
    return realMirrorRoot;
  }
  const nestedBrain = path.join(realMirrorRoot, ".brain");
  const nestedStat = lstatOrNull(nestedBrain);
  if (
    nestedStat !== null &&
    !existsSync(path.join(realMirrorRoot, "config.json")) &&
    !existsSync(path.join(realMirrorRoot, "decided"))
  ) {
    if (nestedStat.isSymbolicLink() || !nestedStat.isDirectory()) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "mirror",
        rule: "mirror_symlink_denied",
        detail: "Mirror .brain directory cannot be a symlink or non-directory.",
        fix: "Replace symlinked mirror .brain path with a real directory.",
      });
    }
    return realpathSync(nestedBrain);
  }
  return realMirrorRoot;
}

export function validateMirrorDir(rawDir: string, brainDir: string, repoRoot: string): string {
  const trimmed = rawDir.trim();
  if (
    trimmed.length === 0 ||
    hasControlOrBidiChars(trimmed) ||
    trimmed.includes("\n") ||
    trimmed.includes("\r") ||
    trimmed.includes("\0")
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "mirror",
      rule: "invalid_mirror_dir",
      detail: "Mirror directory path must be a non-empty valid path without control characters.",
      fix: "Pass a valid existing directory to --mirror-dir or config.mirror_dirs.",
    });
  }

  // Reject UNC/network/device paths BEFORE any filesystem stat or resolution
  if (isUncOrDevicePath(trimmed)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "mirror",
      rule: "unsafe_mirror_dir",
      detail: "Mirror directory cannot be a UNC, network share, or Windows device path.",
      fix: "Choose a local non-system mirror directory.",
    });
  }

  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(repoRoot, trimmed);

  if (isUncOrDevicePath(resolved) || isBlockedSystemOrIsolationPath(resolved)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "mirror",
      rule: "unsafe_mirror_dir",
      detail: "Mirror directory points to a forbidden system, root, or isolated workspace path.",
      fix: "Choose a dedicated non-system mirror directory.",
    });
  }

  const lst = lstatOrNull(resolved);
  if (lst === null) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "mirror",
      rule: "mirror_dir_not_found",
      detail: `Mirror directory does not exist: ${resolved}.`,
      fix: "Create the mirror directory first or remove stale entry from config.mirror_dirs.",
    });
  }
  if (lst.isSymbolicLink()) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "mirror",
      rule: "mirror_symlink_denied",
      detail: "Mirror directory cannot be a symbolic link.",
      fix: "Point --mirror-dir / config.mirror_dirs to a real directory.",
    });
  }
  if (!lst.isDirectory()) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "mirror",
      rule: "mirror_not_directory",
      detail: "Mirror target must be a directory.",
      fix: "Specify a directory path for --mirror-dir / config.mirror_dirs.",
    });
  }

  const realMirrorRoot = realpathSync(resolved);
  if (isUncOrDevicePath(realMirrorRoot) || isBlockedSystemOrIsolationPath(realMirrorRoot)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "mirror",
      rule: "unsafe_mirror_dir",
      detail: "Resolved mirror directory points to a forbidden system or isolated path.",
      fix: "Choose a dedicated non-system mirror directory.",
    });
  }

  const targetBrainDir = resolveMirrorBrainTarget(realMirrorRoot);

  if (existsSync(brainDir)) {
    const realBrainDir = realpathSync(brainDir);
    if (isSameOrNestedPath(targetBrainDir, realBrainDir)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "mirror",
        rule: "mirror_self_target_denied",
        detail:
          "Mirror directory cannot equal, contain, or be nested inside the active .brain directory.",
        fix: "Specify a separate non-overlapping mirror directory path.",
      });
    }
  }

  return targetBrainDir;
}

export function resolveEffectiveMirrorDirs(
  config: BrainConfig | undefined,
  cliMirrorDirs: readonly string[] | undefined,
  brainDir: string,
  repoRoot: string,
): string[] {
  const rawList = [...(config?.mirror_dirs ?? []), ...(cliMirrorDirs ?? [])];
  const seen = new Set<string>();
  const validated: string[] = [];
  for (const raw of rawList) {
    const target = validateMirrorDir(raw, brainDir, repoRoot);
    const key = normalizePathCmp(target);
    if (!seen.has(key)) {
      seen.add(key);
      validated.push(target);
    }
  }
  return validated;
}

function assertSafeMirrorChild(mirrorBrainDir: string, relPath: string): string {
  const segments = relPath.split("/").filter((s) => s.length > 0);
  if (segments.length === 0 || segments.some((s) => s === "." || s === ".." || s.includes("\\"))) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "mirror",
      rule: "invalid_mirror_relpath",
      detail: "Mirror relative file path contains unsafe segments.",
      fix: "Mirror only canonical .brain/decided/*.md, scars.md, or config.json paths.",
    });
  }

  let current = mirrorBrainDir;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i] ?? "";
    current = path.join(current, seg);
    const st = lstatOrNull(current);
    if (st !== null) {
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new VeriBrainError({
          exitCode: EXIT_PROVENANCE_VIOLATION,
          code: "PROVENANCE_VIOLATION",
          claimId: "mirror",
          rule: "mirror_symlink_denied",
          detail: `Mirror subdirectory ${seg} cannot be a symlink or file.`,
          fix: "Remove symlinked subdirectories inside mirror target.",
        });
      }
    }
  }

  const finalPath = path.resolve(mirrorBrainDir, ...segments);
  const cmpMirror = normalizePathCmp(mirrorBrainDir);
  const cmpFinal = normalizePathCmp(finalPath);
  if (!cmpFinal.startsWith(`${cmpMirror}${path.sep}`)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "mirror",
      rule: "mirror_path_escape",
      detail: "Mirror target file escaped mirror root.",
      fix: "Check mirror_dirs configuration.",
    });
  }
  const finalStat = lstatOrNull(finalPath);
  if (finalStat?.isSymbolicLink()) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "mirror",
      rule: "mirror_symlink_denied",
      detail: `Mirror target file ${relPath} cannot be a symbolic link.`,
      fix: "Remove symlinked file in mirror directory.",
    });
  }
  return finalPath;
}

export function atomicWriteUtf8(finalPath: string, content: string): void {
  const dir = path.dirname(finalPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpName = `.tmp-vb-${process.pid}-${randomBytes(6).toString("hex")}`;
  const tmpPath = path.join(dir, tmpName);
  try {
    writeFileSync(tmpPath, content, { encoding: "utf8", flag: "wx" });
    renameSync(tmpPath, finalPath);
    invalidateFileReadCache(finalPath);
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

export function syncMirrorFiles(
  brainDir: string,
  mirrorDirs: readonly string[],
  relPaths: readonly string[],
  dryRun = false,
): string[] {
  const mirroredTargets: string[] = [];
  for (const mirrorDir of mirrorDirs) {
    for (const relPath of relPaths) {
      const srcPath = path.resolve(brainDir, ...relPath.split("/"));
      const destPath = assertSafeMirrorChild(mirrorDir, relPath);
      if (!dryRun) {
        const bytes = readFileSync(srcPath);
        const dir = path.dirname(destPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        const tmpPath = path.join(
          dir,
          `.tmp-vb-mirror-${process.pid}-${randomBytes(6).toString("hex")}`,
        );
        try {
          writeFileSync(tmpPath, bytes, { flag: "wx" });
          renameSync(tmpPath, destPath);
          invalidateFileReadCache(destPath);
        } catch (err) {
          if (existsSync(tmpPath)) {
            try {
              unlinkSync(tmpPath);
            } catch {
              // Best-effort cleanup.
            }
          }
          throw err;
        }
      }
      mirroredTargets.push(destPath);
    }
  }
  return mirroredTargets;
}

function listRelFilesSorted(dirPath: string, ext: string): string[] {
  if (!existsSync(dirPath)) {
    return [];
  }
  try {
    return readdirSync(dirPath)
      .filter((f) => f.endsWith(ext) && !f.startsWith("."))
      .sort(compareAscii);
  } catch {
    return [];
  }
}

export function checkMirrorDrift(
  brainDir: string,
  repoRoot: string,
  rawMirrorDirs: readonly string[],
): EvalIssue[] {
  const issues: EvalIssue[] = [];
  if (rawMirrorDirs.length === 0) {
    issues.push({
      claimId: "mirror",
      rule: "no_mirror_dirs_configured",
      detail: "eval --check-mirror requested but no mirror_dirs are configured.",
      fix: "Add mirror_dirs in .brain/config.json or pass --mirror-dir <dir>.",
      exitCode: EXIT_ERROR,
    });
    return issues;
  }

  const sourceFiles: string[] = [];
  if (existsSync(path.join(brainDir, "config.json"))) {
    sourceFiles.push("config.json");
  }
  if (existsSync(path.join(brainDir, "scars.md"))) {
    sourceFiles.push("scars.md");
  }
  const sourceDecided = listRelFilesSorted(path.join(brainDir, "decided"), ".md");
  for (const name of sourceDecided) {
    sourceFiles.push(`decided/${name}`);
  }
  const sourceDecidedSet = new Set(sourceDecided);

  const seen = new Set<string>();
  for (const rawDir of rawMirrorDirs) {
    let mirrorTarget: string;
    try {
      mirrorTarget = validateMirrorDir(rawDir, brainDir, repoRoot);
    } catch (err) {
      if (err instanceof VeriBrainError) {
        issues.push({
          claimId: err.claimId,
          rule: err.rule,
          detail: err.detail,
          fix: err.fix,
          exitCode: err.exitCode,
        });
      } else {
        issues.push({
          claimId: "mirror",
          rule: "invalid_mirror_dir",
          detail: err instanceof Error ? err.message : String(err),
          fix: "Fix mirror_dirs path in .brain/config.json.",
          exitCode: EXIT_PROVENANCE_VIOLATION,
        });
      }
      continue;
    }

    const key = normalizePathCmp(mirrorTarget);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    for (const relPath of sourceFiles) {
      const srcPath = path.resolve(brainDir, ...relPath.split("/"));
      let destPath: string;
      try {
        destPath = assertSafeMirrorChild(mirrorTarget, relPath);
      } catch (err) {
        if (err instanceof VeriBrainError) {
          issues.push({
            claimId: relPath,
            rule: err.rule,
            detail: err.detail,
            fix: err.fix,
            exitCode: err.exitCode,
          });
        }
        continue;
      }

      if (!existsSync(destPath)) {
        issues.push({
          claimId: relPath,
          rule: "mirror_file_missing",
          detail: `Mirror is missing ${relPath} in ${mirrorTarget}.`,
          fix: `Sync ${relPath} to mirror directory ${mirrorTarget}.`,
          exitCode: EXIT_ERROR,
        });
        continue;
      }

      const srcHash = sha256Hex(readFileSync(srcPath));
      const destHash = sha256Hex(readFileSync(destPath));
      if (srcHash !== destHash) {
        issues.push({
          claimId: relPath,
          rule: "mirror_sha256_mismatch",
          detail: `Byte-for-byte SHA-256 drift on ${relPath} (source=${srcHash.slice(0, 12)}, mirror=${destHash.slice(0, 12)}).`,
          fix: `Re-sign or re-sync ${relPath} so mirror matches .brain/ byte-for-byte.`,
          exitCode: EXIT_ERROR,
        });
      }
    }

    const mirrorDecided = listRelFilesSorted(path.join(mirrorTarget, "decided"), ".md");
    for (const extraName of mirrorDecided) {
      if (!sourceDecidedSet.has(extraName)) {
        issues.push({
          claimId: `decided/${extraName}`,
          rule: "mirror_extra_file",
          detail: `Mirror contains unexpected decided/${extraName} not present in source .brain/.`,
          fix: `Remove stale decided/${extraName} from mirror ${mirrorTarget} or reconcile.`,
          exitCode: EXIT_ERROR,
        });
      }
    }
  }

  return issues;
}
