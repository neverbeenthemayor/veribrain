import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { compareAscii, normalizeLf } from "../normalize.js";
import { assertQuarantineClean } from "../quarantine.js";
import { hasControlOrBidiChars } from "../sanitize.js";
import {
  isBlockedSystemOrIsolationPath,
  isUncOrDevicePath,
  loadBrain,
  parseIsoTimestampMs,
  resolveBrainPaths,
} from "../schema.js";
import {
  type CheckCitationsOptions,
  type CheckCitationsResult,
  type CitationIssue,
  type DecidedRecord,
  EXIT_ERROR,
  EXIT_PROVENANCE_VIOLATION,
  type ObservedRecord,
  VeriBrainError,
} from "../types.js";

const MAX_SCANNED_FILES = 500;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_WALK_DEPTH = 32;
const MAX_VISITED_DIRS = 5_000;
const CITATION_TOKEN_RE = /(?<![A-Za-z0-9_-])((?:DEC|OBS)-[A-Za-z0-9._#-]+)/g;
const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})/;

const PLACEHOLDER_SUFFIXES = new Set(["NNN", "###", "XXX", "000", "ID"]);
const EXCLUDED_TOP_DIRS = new Set(["node_modules", ".git", "dist", ".brain"]);
const EXCLUDED_DOCS_SUBDIRS = new Set(["archive", "feedback", "briefs"]);

function isInsideDir(candidate: string, parentDir: string): boolean {
  const c = path.resolve(candidate);
  const p = path.resolve(parentDir);
  if (process.platform === "win32") {
    return c.toLowerCase().startsWith(`${p.toLowerCase()}${path.sep}`);
  }
  return c.startsWith(`${p}${path.sep}`);
}

function toPosixRelPath(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function isPlaceholderCitation(rawToken: string, claimId: string, nextChar: string): boolean {
  if (nextChar === "*" || rawToken.endsWith("...") || /\.(?:md|json)$/i.test(claimId)) {
    return true;
  }
  const dashIdx = claimId.indexOf("-");
  if (dashIdx === -1) {
    return true;
  }
  const suffix = claimId.slice(dashIdx + 1);
  if (suffix.length === 0 || suffix.endsWith("-") || suffix.includes("#") || suffix.includes("*")) {
    return true;
  }
  const upper = suffix.toUpperCase();
  if (PLACEHOLDER_SUFFIXES.has(upper)) {
    return true;
  }
  if (
    upper.endsWith("-EXAMPLE") ||
    upper.endsWith("-SAMPLE") ||
    upper === "EXAMPLE" ||
    upper === "SAMPLE"
  ) {
    return true;
  }
  return false;
}

function collectDefaultMarkdownFiles(realRepoRoot: string): string[] {
  const results: string[] = [];

  const pushFile = (absPath: string): void => {
    if (results.length >= MAX_SCANNED_FILES) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "check-citations",
        rule: "file_count_limit_exceeded",
        detail: `Citation scan exceeded maximum limit of ${MAX_SCANNED_FILES} files.`,
        fix: "Pass explicit --paths <csv> to narrow the scan scope.",
      });
    }
    const st = lstatSync(absPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      return;
    }
    if (st.size > MAX_FILE_BYTES) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "check-citations",
        rule: "file_size_limit_exceeded",
        detail: `File ${toPosixRelPath(realRepoRoot, absPath)} exceeds ${MAX_FILE_BYTES} bytes.`,
        fix: "Exclude oversized files or scan specific markdown docs via --paths.",
      });
    }
    results.push(absPath);
  };

  // 1. Root *.md files (non-recursive) — pushFile runs OUTSIDE catch so size/count limits fail closed
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
      pushFile(abs);
    }
  }

  // 2. Recursive docs/**/*.md and .agents/**/*.md (depth <= 32, visited dirs <= 5,000)
  let visitedDirs = 0;
  const walkRecursive = (dirPath: string, isDocsRoot: boolean, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "check-citations",
        rule: "walk_depth_limit_exceeded",
        detail: `Citation scan exceeded maximum directory depth of ${MAX_WALK_DEPTH}.`,
        fix: "Pass explicit --paths <csv> to narrow the scan scope.",
      });
    }
    visitedDirs += 1;
    if (visitedDirs > MAX_VISITED_DIRS) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "check-citations",
        rule: "walk_dir_limit_exceeded",
        detail: `Citation scan exceeded maximum limit of ${MAX_VISITED_DIRS} directories.`,
        fix: "Pass explicit --paths <csv> to narrow the scan scope.",
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
        if (EXCLUDED_TOP_DIRS.has(name)) {
          continue;
        }
        if (isDocsRoot && EXCLUDED_DOCS_SUBDIRS.has(name.toLowerCase())) {
          continue;
        }
        walkRecursive(fullPath, false, depth + 1);
      } else if (st.isFile() && name.toLowerCase().endsWith(".md")) {
        pushFile(fullPath);
      }
    }
  };

  for (const sub of ["docs", ".agents"]) {
    const subDir = path.join(realRepoRoot, sub);
    let st: Stats | null = null;
    try {
      st = lstatSync(subDir);
    } catch {
      st = null;
    }
    if (st !== null && !st.isSymbolicLink() && st.isDirectory()) {
      walkRecursive(subDir, sub === "docs", 1);
    }
  }

  return results.sort((a, b) =>
    compareAscii(toPosixRelPath(realRepoRoot, a), toPosixRelPath(realRepoRoot, b)),
  );
}

function resolveExplicitPaths(realRepoRoot: string, rawPaths: readonly string[]): string[] {
  if (rawPaths.length > MAX_SCANNED_FILES) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "check-citations",
      rule: "file_count_limit_exceeded",
      detail: `--paths exceeds maximum limit of ${MAX_SCANNED_FILES} files.`,
      fix: `Pass at most ${MAX_SCANNED_FILES} file paths.`,
    });
  }

  const seen = new Set<string>();
  const resolvedList: string[] = [];

  for (const raw of rawPaths) {
    const trimmed = raw.trim();
    if (
      trimmed.length === 0 ||
      hasControlOrBidiChars(trimmed) ||
      trimmed.includes("\0") ||
      isUncOrDevicePath(trimmed)
    ) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "check-citations",
        rule: "path_confinement_violation",
        detail: "Citation path contains unsafe characters or UNC/device prefix.",
        fix: "Pass repo-relative markdown paths inside the repository root.",
      });
    }

    const candidate = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(realRepoRoot, trimmed);
    if (!isInsideDir(candidate, realRepoRoot)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "check-citations",
        rule: "path_confinement_violation",
        detail: "Citation path escapes repository root.",
        fix: "Pass file paths strictly inside the repository root.",
      });
    }
    if (isBlockedSystemOrIsolationPath(candidate)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "check-citations",
        rule: "path_confinement_violation",
        detail: "Citation path points to a forbidden system or isolated path.",
        fix: "Scan only files inside the current repository root.",
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
          claimId: "check-citations",
          rule: "file_not_found",
          detail: `File not found inside repository: ${relCandidate}.`,
          fix: "Check repo-relative file paths passed to --paths.",
        });
      }
      throw err;
    }

    if (lst.isSymbolicLink()) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "check-citations",
        rule: "path_confinement_violation",
        detail: "Symbolic links are denied in --paths.",
        fix: "Pass regular repo-confined files to --paths.",
      });
    }
    if (!lst.isFile()) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "check-citations",
        rule: "not_a_file",
        detail: `Path is not a regular file: ${relCandidate}.`,
        fix: "Pass regular file paths to --paths.",
      });
    }

    const realTarget = realpathSync(candidate);
    if (!isInsideDir(realTarget, realRepoRoot) || isBlockedSystemOrIsolationPath(realTarget)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "check-citations",
        rule: "path_confinement_violation",
        detail: "Citation path escaped repository root confinement.",
        fix: "Pass file paths strictly inside the repository root.",
      });
    }

    if (lst.size > MAX_FILE_BYTES) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "check-citations",
        rule: "file_size_limit_exceeded",
        detail: `File ${toPosixRelPath(realRepoRoot, realTarget)} exceeds ${MAX_FILE_BYTES} bytes.`,
        fix: "Scan smaller markdown files (<= 512 KB).",
      });
    }

    const key = process.platform === "win32" ? realTarget.toLowerCase() : realTarget;
    if (!seen.has(key)) {
      seen.add(key);
      resolvedList.push(realTarget);
    }
  }

  return resolvedList.sort((a, b) =>
    compareAscii(toPosixRelPath(realRepoRoot, a), toPosixRelPath(realRepoRoot, b)),
  );
}

export function checkCitations(options: CheckCitationsOptions = {}): CheckCitationsResult {
  for (const raw of [options.repoRoot, options.brainDir]) {
    if (raw !== undefined && (isUncOrDevicePath(raw) || isBlockedSystemOrIsolationPath(raw))) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "check-citations",
        rule: "path_confinement_violation",
        detail: "check-citations refuses UNC, device, system, or isolated repository paths.",
        fix: "Run check-citations inside an authorized local repository directory.",
      });
    }
  }

  const { brainDir, repoRoot } = resolveBrainPaths(options.brainDir, options.repoRoot);
  if (
    isUncOrDevicePath(repoRoot) ||
    isUncOrDevicePath(brainDir) ||
    isBlockedSystemOrIsolationPath(repoRoot) ||
    isBlockedSystemOrIsolationPath(brainDir)
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "check-citations",
      rule: "path_confinement_violation",
      detail: "Resolved repository or .brain path points to a forbidden system or isolated path.",
      fix: "Run check-citations inside an authorized local repository directory.",
    });
  }
  const realRepoRoot = realpathSync(repoRoot);
  if (isUncOrDevicePath(realRepoRoot) || isBlockedSystemOrIsolationPath(realRepoRoot)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "check-citations",
      rule: "path_confinement_violation",
      detail: "Resolved repository root points to a forbidden system or isolated path.",
      fix: "Run check-citations inside an authorized local repository directory.",
    });
  }
  if (existsSync(brainDir)) {
    const realBrainDir = realpathSync(brainDir);
    if (isUncOrDevicePath(realBrainDir) || isBlockedSystemOrIsolationPath(realBrainDir)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "check-citations",
        rule: "path_confinement_violation",
        detail: "Resolved .brain directory points to a forbidden system or isolated path.",
        fix: "Use a local repo-confined .brain directory.",
      });
    }
  }

  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const brain = loadBrain(brainDir, repoRoot, { now });

  const decidedById = new Map<string, DecidedRecord>();
  const supersededByMap = new Map<string, string>();
  for (const d of brain.decided) {
    decidedById.set(d.id, d);
    if (d.status === "active" && d.supersedes) {
      supersededByMap.set(d.supersedes, d.id);
    }
  }

  const observedById = new Map<string, ObservedRecord>();
  for (const o of brain.observed) {
    observedById.set(o.claim_id, o);
  }

  const ignoreSet = new Set(
    (options.ignoreIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0),
  );
  const files =
    options.paths !== undefined && options.paths.length > 0
      ? resolveExplicitPaths(realRepoRoot, options.paths)
      : collectDefaultMarkdownFiles(realRepoRoot);

  const includeCodeBlocks = Boolean(options.includeCodeBlocks);
  const decidedOnly = Boolean(options.decidedOnly);
  const issues: CitationIssue[] = [];
  let citationsChecked = 0;

  for (const absFile of files) {
    const relFile = toPosixRelPath(realRepoRoot, absFile);
    const raw = readFileSync(absFile, "utf8");
    const lines = normalizeLf(raw).split("\n");

    let activeFenceChar: string | null = null;
    let activeFenceLen = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const lineNum = i + 1;

      if (!includeCodeBlocks) {
        const fenceMatch = FENCE_OPEN_RE.exec(line);
        if (fenceMatch?.[1]) {
          const fenceToken = fenceMatch[1];
          const ch = fenceToken[0] ?? "`";
          if (activeFenceChar === null) {
            activeFenceChar = ch;
            activeFenceLen = fenceToken.length;
            continue;
          }
          if (activeFenceChar === ch && fenceToken.length >= activeFenceLen) {
            const rest = line.slice(fenceMatch[0].length).trim();
            if (rest.length === 0) {
              activeFenceChar = null;
              activeFenceLen = 0;
              continue;
            }
          }
        }
        if (activeFenceChar !== null) {
          continue;
        }
      }

      CITATION_TOKEN_RE.lastIndex = 0;
      let match = CITATION_TOKEN_RE.exec(line);
      while (match !== null) {
        const rawToken = match[1] ?? "";
        const matchEnd = match.index + match[0].length;
        const nextChar = line[matchEnd] ?? "";
        const claimId = rawToken.replace(/[.,;:!?)]+$/, "");
        if (!ignoreSet.has(claimId) && !isPlaceholderCitation(rawToken, claimId, nextChar)) {
          if (claimId.startsWith("DEC-")) {
            citationsChecked += 1;
            const dec = decidedById.get(claimId);
            if (!dec) {
              issues.push({
                file: relFile,
                line: lineNum,
                claim_id: claimId,
                kind: "missing_decided",
                detail: `${relFile}:${lineNum} cites missing DECIDED rule ${claimId}.`,
              });
            } else if (dec.status === "superseded") {
              const replacement = supersededByMap.get(claimId);
              const hint = replacement ? ` (superseded by ${replacement})` : "";
              const issue: CitationIssue = {
                file: relFile,
                line: lineNum,
                claim_id: claimId,
                kind: "superseded_decided",
                detail: `${relFile}:${lineNum} cites superseded DECIDED rule ${claimId}${hint}.`,
              };
              if (replacement !== undefined) {
                issue.replacement_id = replacement;
              }
              issues.push(issue);
            }
          } else if (claimId.startsWith("OBS-") && !decidedOnly) {
            citationsChecked += 1;
            const obs = observedById.get(claimId);
            if (!obs) {
              issues.push({
                file: relFile,
                line: lineNum,
                claim_id: claimId,
                kind: "missing_observed",
                detail: `${relFile}:${lineNum} cites missing OBSERVED claim ${claimId}.`,
              });
            } else {
              const obsMs = parseIsoTimestampMs(obs.observed_at_utc) ?? 0;
              const expMs = obsMs + obs.ttl_seconds * 1000;
              if (nowMs > expMs) {
                issues.push({
                  file: relFile,
                  line: lineNum,
                  claim_id: claimId,
                  kind: "expired_observed",
                  detail: `${relFile}:${lineNum} cites expired OBSERVED claim ${claimId} (expired ${new Date(expMs).toISOString().slice(0, 10)}).`,
                });
              }
            }
          }
        }
        match = CITATION_TOKEN_RE.exec(line);
      }
    }
  }

  const linesOut: string[] = [];
  if (issues.length === 0) {
    linesOut.push(
      `check-citations ok: ${files.length} files scanned, ${citationsChecked} citations verified, 0 drift issues.`,
    );
  } else {
    linesOut.push(
      `check-citations FAIL: ${issues.length} drift issue(s) across ${files.length} files (${citationsChecked} citations checked):`,
    );
    for (const issue of issues) {
      linesOut.push(`- [${issue.kind}] ${issue.detail}`);
    }
  }
  const rendered = `${linesOut.join("\n")}\n`;

  for (const issue of issues) {
    assertQuarantineClean(issue.claim_id, {
      claimId: "check-citations",
      field: "claim_id",
      config: brain.config.quarantine,
      allowHashRefExemption: false,
    });
    assertQuarantineClean(issue.detail, {
      claimId: "check-citations",
      field: "detail",
      config: brain.config.quarantine,
      allowHashRefExemption: false,
    });
  }
  assertQuarantineClean(rendered, {
    claimId: "check-citations",
    config: brain.config.quarantine,
    allowHashRefExemption: false,
  });

  return {
    ok: issues.length === 0,
    files_scanned: files.length,
    citations_checked: citationsChecked,
    issues,
    rendered,
  };
}
