import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { compareAscii, normalizeLf, truncateAscii } from "../normalize.js";
import {
  assertQuarantineClean,
  createQuarantineError,
  scanTextForQuarantine,
} from "../quarantine.js";
import { isValidRepoRelativeTestRef } from "../sanitize.js";
import {
  loadBrainConfig,
  parseDecidedFile,
  parseHypothesisFile,
  parseIsoTimestampMs,
  parseObservedFile,
  regressionTestFileExists,
  resolveBrainPaths,
  stripHtmlCommentsPreservingLines,
} from "../schema.js";
import {
  type DiffItem,
  type DiffOptions,
  type DiffResult,
  EXIT_ERROR,
  EXIT_QUARANTINE_VIOLATION,
  type QuarantineConfig,
  VeriBrainError,
} from "../types.js";

const SINCE_RE = /^(\d+)([dh])$/i;
const MAX_DIFF_BULLETS = 5;
const MAX_DIFF_LINES = 25;
const MAX_COLS = 80;
const ACTION_LINE = "   Action: [Keep] [Revert] [Promote to DECIDED]";
const NEXT_LINE = "Next: edit .brain/ then run veribrain eval --strict.";

export function parseSinceWindowMs(since: string): number {
  const trimmed = since.trim();
  const match = SINCE_RE.exec(trimmed);
  if (!match?.[1] || !match[2]) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "diff",
      rule: "invalid_since_window",
      detail: `Invalid --since window "${trimmed}" (expected e.g. 7d or 24h).`,
      fix: "Pass --since 7d or --since 48h.",
    });
  }
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "diff",
      rule: "invalid_since_window",
      detail: "--since value must be a positive duration.",
      fix: "Pass --since 7d.",
    });
  }
  const unit = match[2].toLowerCase();
  return unit === "d" ? amount * 24 * 60 * 60 * 1000 : amount * 60 * 60 * 1000;
}

function listSorted(dirPath: string, ext: string): string[] {
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
    .filter((f) => f.endsWith(ext) && !f.startsWith("."))
    .sort(compareAscii)
    .map((f) => path.join(dirPath, f));
}

function getGitModifiedDecidedFiles(
  repoRoot: string,
  brainDir: string,
  sinceIso: string,
): Set<string> {
  const modified = new Set<string>();
  if (!existsSync(path.join(repoRoot, ".git"))) {
    return modified;
  }
  const relDecided = path.relative(repoRoot, path.join(brainDir, "decided"));
  if (relDecided.startsWith("..") || path.isAbsolute(relDecided)) {
    return modified;
  }
  try {
    const out = execFileSync(
      "git",
      ["log", `--since=${sinceIso}`, "--name-only", "--pretty=format:", "--", relDecided],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      },
    );
    for (const line of normalizeLf(out).split("\n")) {
      const trimmed = line.trim();
      if (trimmed.endsWith(".md")) {
        modified.add(path.resolve(repoRoot, trimmed));
      }
    }
  } catch {
    // Non-git workspace or no commit history: rely on frontmatter timestamps.
  }
  return modified;
}

interface RawScarCandidate {
  id: string;
  expiresAtUtc?: string;
  regressionTest?: string;
}

function inspectScarsForDiff(
  brainDir: string,
  repoRoot: string,
  config: QuarantineConfig,
  nowMs: number,
): DiffItem[] {
  const scarsPath = path.join(brainDir, "scars.md");
  if (!existsSync(scarsPath)) {
    return [];
  }
  const raw = readFileSync(scarsPath, "utf8");
  assertQuarantineClean(raw, { claimId: "scars.md", config });

  const strippedComments = stripHtmlCommentsPreservingLines(raw);
  if (strippedComments !== normalizeLf(raw)) {
    assertQuarantineClean(strippedComments, { claimId: "scars.md", config });
  }

  const lines = strippedComments.split("\n");
  const candidates: RawScarCandidate[] = [];
  let current: RawScarCandidate | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const heading = /^#{2,3}\s+(SCAR-[A-Za-z0-9._-]+)\s*$/.exec(trimmed);
    if (heading?.[1]) {
      current = { id: heading[1] };
      candidates.push(current);
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
      const val = fieldLine.slice(colonIdx + 1).trim();
      if (key === "scar_id") {
        current = { id: val };
        candidates.push(current);
      } else if (current !== null && key === "expires_at_utc") {
        current.expiresAtUtc = val;
      } else if (current !== null && key === "regression_test") {
        current.regressionTest = val;
      }
    }
  }

  const items: DiffItem[] = [];
  for (const scar of candidates) {
    const reasons: string[] = [];
    const expMs = scar.expiresAtUtc ? parseIsoTimestampMs(scar.expiresAtUtc) : null;
    if (expMs === null) {
      reasons.push("missing/invalid expiry");
    } else if (nowMs > expMs) {
      reasons.push(`expired ${scar.expiresAtUtc?.slice(0, 10) ?? ""}`);
    }
    if (!scar.regressionTest || !isValidRepoRelativeTestRef(scar.regressionTest)) {
      reasons.push("unlinked regression_test");
    } else if (!regressionTestFileExists(repoRoot, scar.regressionTest)) {
      reasons.push("missing test file");
    }

    if (reasons.length > 0) {
      items.push({
        category: "scar",
        rank: 1,
        id: scar.id,
        summary: `[SCAR] ${scar.id}: ${reasons.join(", ")}`,
      });
    }
  }
  return items;
}

function quarantineCheckRawFallback(filePath: string, config: QuarantineConfig): void {
  const raw = readFileSync(filePath, "utf8");
  const violation = scanTextForQuarantine(raw, {
    claimId: path.basename(filePath),
    config,
  });
  if (violation !== null) {
    throw createQuarantineError(violation, config);
  }
}

export function generateBrainDiff(options: DiffOptions = {}): DiffResult {
  const since = (options.since ?? "7d").trim();
  const windowMs = parseSinceWindowMs(since);
  const { brainDir, repoRoot } = resolveBrainPaths(options.brainDir, options.repoRoot);
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const cutoffMs = nowMs - windowMs;
  const sinceIso = new Date(cutoffMs).toISOString();

  const config = loadBrainConfig(brainDir);
  const items: DiffItem[] = [];

  const scarItems = inspectScarsForDiff(brainDir, repoRoot, config.quarantine, nowMs);
  items.push(...scarItems);

  const hypothesisFiles = listSorted(path.join(brainDir, "hypotheses"), ".json");
  let pendingHypCount = 0;
  for (const file of hypothesisFiles) {
    const hyp = parseHypothesisFile(file, config.quarantine, { now });
    pendingHypCount += 1;
    const expMs = parseIsoTimestampMs(hyp.expires_at_utc) ?? 0;
    const statusLabel = nowMs > expMs ? "expired" : `expires ${hyp.expires_at_utc.slice(0, 10)}`;
    const tag = hyp.kind === "scar_proposal" ? "[HYP/SCAR]" : "[HYP]";
    items.push({
      category: "hypothesis",
      rank: 2,
      id: hyp.id,
      summary: `${tag} ${hyp.id} (${statusLabel}): ${hyp.hint}`,
    });
  }

  const observedFiles = listSorted(path.join(brainDir, "observed"), ".json");
  let expiredObservedCount = 0;
  for (const file of observedFiles) {
    const obs = parseObservedFile(file, config.quarantine);
    const obsMs = parseIsoTimestampMs(obs.observed_at_utc) ?? 0;
    const expMs = obsMs + obs.ttl_seconds * 1000;
    if (nowMs > expMs) {
      expiredObservedCount += 1;
      const expDate = new Date(expMs).toISOString().slice(0, 10);
      items.push({
        category: "observed",
        rank: 3,
        id: obs.claim_id,
        summary: `[OBS] ${obs.claim_id} (${obs.env}) expired ${expDate}`,
      });
    }
  }

  const gitModifiedDecided = getGitModifiedDecidedFiles(repoRoot, brainDir, sinceIso);
  const decidedFiles = listSorted(path.join(brainDir, "decided"), ".md");
  for (const file of decidedFiles) {
    try {
      const dec = parseDecidedFile(file, config.quarantine);
      const signedMs = parseIsoTimestampMs(dec.signed_at_utc) ?? 0;
      const inWindow = signedMs >= cutoffMs || gitModifiedDecided.has(path.resolve(file));
      if (inWindow || dec.status === "superseded") {
        const tag =
          dec.status === "superseded" ? "superseded" : `signed ${dec.signed_at_utc.slice(0, 10)}`;
        items.push({
          category: "decided",
          rank: 4,
          id: dec.id,
          summary: `[DEC] ${dec.id} (${dec.priority}, ${tag}) by ${dec.signed_by}`,
        });
      }
    } catch (err) {
      if (err instanceof VeriBrainError && err.exitCode === EXIT_QUARANTINE_VIOLATION) {
        throw err;
      }
      quarantineCheckRawFallback(file, config.quarantine);
      const fallbackId = path.basename(file, ".md");
      items.push({
        category: "decided",
        rank: 4,
        id: fallbackId,
        summary: `[DEC] ${fallbackId}: integrity or signature requires review`,
      });
    }
  }

  items.sort((a, b) => {
    if (a.rank !== b.rank) {
      return a.rank - b.rank;
    }
    return compareAscii(a.id, b.id);
  });

  const totalCount = items.length;
  const visible = items.slice(0, MAX_DIFF_BULLETS);

  let renderedLines: string[];
  if (visible.length === 0) {
    renderedLines = [
      truncateAscii(`VeriBrain Weekly Diff (window: ${since})`, MAX_COLS),
      "No expired claims, unlinked scars, pending hypotheses, or decided edits.",
      "Status: CLEAN (0 items require review).",
    ];
  } else {
    renderedLines = [
      truncateAscii(
        `VeriBrain Weekly Diff (window: ${since}, showing ${visible.length} of ${totalCount})`,
        MAX_COLS,
      ),
      truncateAscii(
        `Delta: ${expiredObservedCount} expired observed | ${scarItems.length} aging/unlinked scars | ${pendingHypCount} pending hyp`,
        MAX_COLS,
      ),
    ];
    for (let i = 0; i < visible.length; i += 1) {
      const item = visible[i];
      if (!item) continue;
      const prefix = `${i + 1}. `;
      const headline = `${prefix}${truncateAscii(item.summary, MAX_COLS - prefix.length)}`;
      renderedLines.push(headline);
      renderedLines.push(ACTION_LINE);
    }
    if (totalCount > visible.length) {
      const hidden = totalCount - visible.length;
      renderedLines.push(
        truncateAscii(
          `(+${hidden} more item${hidden === 1 ? "" : "s"} omitted; resolve top 5 first.)`,
          MAX_COLS,
        ),
      );
    }
    renderedLines.push(NEXT_LINE);
  }

  if (renderedLines.length > MAX_DIFF_LINES) {
    renderedLines = renderedLines.slice(0, MAX_DIFF_LINES);
  }

  const rendered = `${renderedLines.join("\n")}\n`;
  assertQuarantineClean(rendered, { claimId: "diff", config: config.quarantine });

  return {
    since,
    items: visible,
    totalCount,
    rendered,
  };
}
