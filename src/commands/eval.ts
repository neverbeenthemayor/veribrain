import { readdirSync } from "node:fs";
import path from "node:path";
import { checkMirrorDrift } from "../mirror.js";
import { compareAscii } from "../normalize.js";
import { renderUntrustedHint } from "../sanitize.js";
import {
  type LoadBrainOptions,
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
  type EvalIssue,
  type EvalOptions,
  type EvalResult,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_PROVENANCE_VIOLATION,
  EXIT_QUARANTINE_VIOLATION,
  type ExitCode,
  VeriBrainError,
} from "../types.js";

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

function recordErrorAsIssue(issues: EvalIssue[], err: unknown, fallbackClaimId: string): void {
  if (err instanceof VeriBrainError) {
    if (err.exitCode === EXIT_QUARANTINE_VIOLATION) {
      throw err;
    }
    const issue: EvalIssue = {
      claimId: err.claimId,
      rule: err.rule,
      detail: err.detail,
      fix: err.fix,
      exitCode: err.exitCode,
    };
    if (err.line !== undefined) {
      issue.line = err.line;
    }
    issues.push(issue);
    return;
  }
  issues.push({
    claimId: fallbackClaimId,
    rule: "unexpected_error",
    detail: err instanceof Error ? err.message : String(err),
    fix: `Inspect ${fallbackClaimId} and fix syntax or schema errors.`,
    exitCode: EXIT_ERROR,
  });
}

export function evaluateBrain(options: EvalOptions = {}): EvalResult {
  const { brainDir, repoRoot } = resolveBrainPaths(options.brainDir, options.repoRoot);
  const strict = Boolean(options.strict);
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const bypassReadCache = Boolean(options.bypassReadCache);
  const loadOpts: LoadBrainOptions = { now, bypassReadCache };
  const issues: EvalIssue[] = [];

  const config = loadBrainConfig(brainDir, bypassReadCache);

  const decidedFiles = listSorted(path.join(brainDir, "decided"), ".md");
  const observedFiles = listSorted(path.join(brainDir, "observed"), ".json");
  const hypothesisFiles = listSorted(path.join(brainDir, "hypotheses"), ".json");

  let decidedCount = 0;
  for (const file of decidedFiles) {
    try {
      parseDecidedFile(file, config.quarantine, bypassReadCache);
      decidedCount += 1;
    } catch (err) {
      recordErrorAsIssue(issues, err, path.basename(file));
    }
  }

  let observedCount = 0;
  for (const file of observedFiles) {
    try {
      const obs = parseObservedFile(file, config.quarantine, bypassReadCache);
      observedCount += 1;
      const observedMs = parseIsoTimestampMs(obs.observed_at_utc) ?? 0;
      if (strict && nowMs > observedMs + obs.ttl_seconds * 1000) {
        issues.push({
          claimId: obs.claim_id,
          rule: "observed_expired",
          detail: `Observed claim ${obs.claim_id} expired at ${new Date(observedMs + obs.ttl_seconds * 1000).toISOString()}.`,
          fix: `Refresh ${obs.claim_id} with veribrain observe or remove the stale JSON file.`,
          exitCode: EXIT_ERROR,
        });
      }
    } catch (err) {
      recordErrorAsIssue(issues, err, path.basename(file));
    }
  }

  let hypothesisCount = 0;
  for (const file of hypothesisFiles) {
    try {
      const hyp = parseHypothesisFile(file, config.quarantine, loadOpts);
      hypothesisCount += 1;
      renderUntrustedHint({ source: "hypothesis", id: hyp.id, body: hyp.hint });
      const expiresMs = parseIsoTimestampMs(hyp.expires_at_utc) ?? 0;
      if (strict && nowMs > expiresMs) {
        issues.push({
          claimId: hyp.id,
          rule: "hypothesis_expired",
          detail: `Hypothesis ${hyp.id} expired at ${hyp.expires_at_utc}.`,
          fix: `Review ${hyp.id} in veribrain diff and promote or remove it.`,
          exitCode: EXIT_ERROR,
        });
      }
    } catch (err) {
      recordErrorAsIssue(issues, err, path.basename(file));
    }
  }

  let scarsCount = 0;
  let scarsBytes = 0;
  try {
    const parsedScars = parseScarsFile(brainDir, config.quarantine, loadOpts);
    scarsCount = parsedScars.scars.length;
    scarsBytes = parsedScars.scarsBytes;
    for (const scar of parsedScars.scars) {
      renderUntrustedHint({
        source: "scar",
        id: scar.scar_id,
        regressionTest: scar.regression_test,
        body: scar.hint,
      });
      const expiresMs = parseIsoTimestampMs(scar.expires_at_utc) ?? 0;
      if (nowMs > expiresMs) {
        issues.push({
          claimId: scar.scar_id,
          rule: "scar_expired",
          line: scar.line_number,
          detail: `Scar ${scar.scar_id} expired at ${scar.expires_at_utc}.`,
          fix: `Prune or renew ${scar.scar_id} in .brain/scars.md via veribrain diff.`,
          exitCode: EXIT_ERROR,
        });
      }
      if (strict && !regressionTestFileExists(repoRoot, scar.regression_test)) {
        issues.push({
          claimId: scar.scar_id,
          rule: "missing_regression_test_file",
          line: scar.line_number,
          detail: `Regression test file not found for ${scar.scar_id} (${scar.regression_test}).`,
          fix: `Create ${scar.regression_test} or update the link in .brain/scars.md.`,
          exitCode: EXIT_ERROR,
        });
      }
    }
  } catch (err) {
    recordErrorAsIssue(issues, err, "scars.md");
  }

  if (options.checkMirror) {
    const rawMirrorDirs = [...(config.mirror_dirs ?? []), ...(options.mirrorDirs ?? [])];
    const mirrorIssues = checkMirrorDrift(brainDir, repoRoot, rawMirrorDirs);
    for (const issue of mirrorIssues) {
      issues.push(issue);
    }
  }

  let exitCode: ExitCode = EXIT_OK;
  if (issues.some((i) => i.exitCode === EXIT_QUARANTINE_VIOLATION)) {
    exitCode = EXIT_QUARANTINE_VIOLATION;
  } else if (issues.some((i) => i.exitCode === EXIT_PROVENANCE_VIOLATION)) {
    exitCode = EXIT_PROVENANCE_VIOLATION;
  } else if (issues.length > 0) {
    exitCode = EXIT_ERROR;
  }

  return {
    ok: issues.length === 0,
    exitCode,
    issues,
    counts: {
      decided: decidedCount,
      observed: observedCount,
      hypotheses: hypothesisCount,
      scars: scarsCount,
      scarsBytes,
    },
  };
}
