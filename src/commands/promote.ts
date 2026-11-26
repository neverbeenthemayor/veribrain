import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { atomicWriteUtf8, resolveEffectiveMirrorDirs, syncMirrorFiles } from "../mirror.js";
import { normalizeLf } from "../normalize.js";
import { assertQuarantineClean } from "../quarantine.js";
import { hasControlOrBidiChars, isValidRepoRelativeTestRef } from "../sanitize.js";
import {
  assertHumanProvenance,
  assertValidClaimId,
  defaultQuarantineConfig,
  invalidateFileReadCache,
  loadBrainConfig,
  parseHypothesisFile,
  parseScarsFile,
  regressionTestFileExists,
  resolveBrainPaths,
} from "../schema.js";
import {
  type BrainConfig,
  EXIT_ERROR,
  EXIT_PROVENANCE_VIOLATION,
  MAX_SCARS_BYTES,
  type PromoteOptions,
  type PromoteResult,
  type QuarantineConfig,
  VeriBrainError,
} from "../types.js";
import { decideRule } from "./decide.js";
import { evaluateBrain } from "./eval.js";

const DEFAULT_SCARS_HEADER = "# VeriBrain Scars (Max 4,096 B, TTL <= 30d)\n";
const VALID_ROLE_TOKEN_RE = /^(?:\*|[A-Za-z0-9._-]{1,64})$/;

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

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function loadConfigIfExists(brainDir: string): BrainConfig | undefined {
  if (existsSync(path.join(brainDir, "config.json"))) {
    return loadBrainConfig(brainDir, true);
  }
  return undefined;
}

function resolveHypothesisFileConfined(brainDir: string, hypId: string): string {
  const hypDir = path.resolve(brainDir, "hypotheses");
  const hypDirStat = lstatOrNull(hypDir);
  if (hypDirStat === null || hypDirStat.isSymbolicLink() || !hypDirStat.isDirectory()) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: hypId,
      rule: "path_confinement_violation",
      detail: ".brain/hypotheses/ directory is missing or symlinked.",
      fix: "Ensure .brain/hypotheses/ is a real local directory.",
    });
  }
  const realHypDir = realpathSync(hypDir);
  const candidate = path.resolve(realHypDir, `${hypId}.json`);
  const st = lstatOrNull(candidate);
  if (st === null) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: hypId,
      rule: "hypothesis_not_found",
      detail: `Hypothesis file not found: .brain/hypotheses/${hypId}.json.`,
      fix: "Inspect pending hypotheses with veribrain diff or veribrain_list_claims.",
    });
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: hypId,
      rule: "path_confinement_violation",
      detail: "Hypothesis file cannot be a symbolic link.",
      fix: "Remove symlinked file inside .brain/hypotheses/.",
    });
  }
  const realFile = realpathSync(candidate);
  const isWin = process.platform === "win32";
  const cmpDir = isWin ? realHypDir.toLowerCase() : realHypDir;
  const cmpFile = isWin ? realFile.toLowerCase() : realFile;
  if (path.dirname(cmpFile) !== cmpDir) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: hypId,
      rule: "path_confinement_violation",
      detail: "Hypothesis file escaped .brain/hypotheses/ confinement.",
      fix: "Use a valid HYP-* identifier without path separators.",
    });
  }
  return realFile;
}

function resolveScarsPathConfined(brainDir: string, claimId: string): string {
  const brainStat = lstatOrNull(brainDir);
  if (brainStat === null || brainStat.isSymbolicLink() || !brainStat.isDirectory()) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId,
      rule: "path_confinement_violation",
      detail: ".brain directory is missing or symlinked.",
      fix: "Ensure .brain/ is a real local directory.",
    });
  }
  const realBrainDir = realpathSync(brainDir);
  const scarsPath = path.join(realBrainDir, "scars.md");
  const scarsStat = lstatOrNull(scarsPath);
  if (scarsStat !== null) {
    if (scarsStat.isSymbolicLink() || !scarsStat.isFile()) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "scars.md",
        rule: "path_confinement_violation",
        detail: ".brain/scars.md cannot be a symbolic link or non-file.",
        fix: "Replace symlinked .brain/scars.md with a regular file.",
      });
    }
    const realScars = realpathSync(scarsPath);
    if (!samePath(realScars, scarsPath)) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "scars.md",
        rule: "path_confinement_violation",
        detail: ".brain/scars.md resolved outside .brain/ confinement.",
        fix: "Keep .brain/scars.md as a local file inside .brain/.",
      });
    }
  }
  return scarsPath;
}

function resolveDecidedTargetConfined(brainDir: string, decId: string): string {
  const realBrainDir = realpathSync(brainDir);
  const decidedDir = path.join(realBrainDir, "decided");
  const decidedDirStat = lstatOrNull(decidedDir);
  if (decidedDirStat !== null) {
    if (decidedDirStat.isSymbolicLink() || !decidedDirStat.isDirectory()) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: decId,
        rule: "path_confinement_violation",
        detail: ".brain/decided/ cannot be a symbolic link or non-directory.",
        fix: "Replace symlinked .brain/decided/ with a real directory.",
      });
    }
  }
  const targetPath = path.join(decidedDir, `${decId}.md`);
  const targetStat = lstatOrNull(targetPath);
  if (targetStat !== null) {
    if (targetStat.isSymbolicLink()) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: decId,
        rule: "path_confinement_violation",
        detail: `Target .brain/decided/${decId}.md is a symbolic link.`,
        fix: "Remove symlinked file inside .brain/decided/.",
      });
    }
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: decId,
      rule: "duplicate_decided_id",
      detail: `Decided rule ${decId} already exists at .brain/decided/${decId}.md (overwrite denied).`,
      fix: "Choose a new --id DEC-NNN or update the existing file explicitly via veribrain decide / sign.",
    });
  }
  return targetPath;
}

function validatePromoteRoles(
  rawRoles: readonly string[],
  claimId: string,
  config: QuarantineConfig,
): string[] {
  const roles: string[] = [];
  for (const raw of rawRoles) {
    if (hasControlOrBidiChars(raw) || raw.includes("\n") || raw.includes("\r")) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "SCHEMA_ERROR",
        claimId,
        rule: "invalid_roles",
        detail: "Role entries cannot contain newlines or control characters.",
        fix: 'Pass clean role names like --roles "*,builder".',
      });
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    assertQuarantineClean(trimmed, {
      claimId,
      field: "roles",
      config,
      allowHashRefExemption: false,
    });
    if (!VALID_ROLE_TOKEN_RE.test(trimmed)) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "SCHEMA_ERROR",
        claimId,
        rule: "invalid_roles",
        detail: "Role entries must be '*' or match ^[A-Za-z0-9._-]{1,64}$.",
        fix: 'Pass valid role names like --roles "*,builder".',
      });
    }
    roles.push(trimmed);
  }
  if (roles.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId,
      rule: "missing_roles",
      detail: "At least one valid role entry is required.",
      fix: 'Pass --roles "*" or a valid role name.',
    });
  }
  return roles;
}

function computeNextScarId(existingIds: readonly string[]): string {
  let maxNum = 0;
  for (const id of existingIds) {
    const match = /^SCAR-(\d+)$/.exec(id);
    if (match?.[1]) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isFinite(n) && n > maxNum) {
        maxNum = n;
      }
    }
  }
  return `SCAR-${String(maxNum + 1).padStart(3, "0")}`;
}

function formatRolesYaml(roles: readonly string[]): string {
  return `[${roles.map((r) => (r === "*" ? '"*"' : r)).join(", ")}]`;
}

export function promoteHypothesis(options: PromoteOptions): PromoteResult {
  const { brainDir, repoRoot } = resolveBrainPaths(options.brainDir, options.repoRoot, {
    allowWorktreeFallback: false,
  });
  const config = loadConfigIfExists(brainDir);
  const quarantineConfig: QuarantineConfig = config?.quarantine ?? defaultQuarantineConfig();
  const envVars = options.envVars ?? process.env;
  const now = options.now ?? new Date();
  const dryRun = Boolean(options.dryRun);

  // Human-only gate BEFORE reading or mutating anything
  assertHumanProvenance({
    claimId: options.hypId || "promote",
    ...(options.signedBy !== undefined ? { signedBy: options.signedBy } : {}),
    ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
    envVars,
    config: quarantineConfig,
  });

  const hypId = assertValidClaimId(options.hypId, "HYP", quarantineConfig);
  const hypPath = resolveHypothesisFileConfined(brainDir, hypId);
  const hyp = parseHypothesisFile(hypPath, quarantineConfig, { now, bypassReadCache: true });

  const isScarKind =
    hyp.kind === "scar_proposal" ||
    hyp.kind === "hypothesis_scar" ||
    hyp.id.startsWith("HYP-SCAR-");

  let target: "scar" | "decided";
  if (options.to === "scar" || options.to === "decided") {
    target = options.to;
  } else if (isScarKind) {
    target = "scar";
  } else {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: hypId,
      rule: "missing_promote_target",
      detail: `Specify --to scar or --to decided when promoting ${hypId}.`,
      fix: `Run veribrain promote ${hypId} --to scar --regression-test <path> OR --to decided --id DEC-NNN --priority P1 --signed-by "Human Owner".`,
    });
  }

  if (target === "decided") {
    if (!options.id) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: hypId,
        rule: "missing_id",
        detail: "Promoting to DECIDED requires --id DEC-NNN.",
        fix: `Run veribrain promote ${hypId} --to decided --id DEC-NNN --priority P1 --signed-by "Human Owner".`,
      });
    }
    if (!options.priority) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: hypId,
        rule: "missing_priority",
        detail: "Promoting to DECIDED requires --priority P0|P1|P2.",
        fix: `Pass --priority P0|P1|P2 when promoting ${hypId} to DECIDED.`,
      });
    }
    const targetDecId = assertValidClaimId(options.id, "DEC", quarantineConfig);
    const humanSigner = assertHumanProvenance({
      claimId: targetDecId,
      ...(options.signedBy !== undefined ? { signedBy: options.signedBy } : {}),
      requireSignedBy: true,
      ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
      envVars,
      config: quarantineConfig,
    });
    if (!humanSigner) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: targetDecId,
        rule: "agent_signed_decided",
        detail: "Promoting to DECIDED requires a human --signed-by identity.",
        fix: 'Pass --signed-by "Human Owner".',
      });
    }

    const validatedRoles = validatePromoteRoles(
      options.roles ?? hyp.roles,
      targetDecId,
      quarantineConfig,
    );
    const targetPath = resolveDecidedTargetConfined(brainDir, targetDecId);

    // Dry-run decideRule validates content, hash, quarantine, and mirror dirs without writing
    const decPreview = decideRule({
      id: targetDecId,
      priority: options.priority,
      signedBy: humanSigner,
      roles: validatedRoles,
      ...(options.envs !== undefined ? { envs: options.envs } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
      body: hyp.hint,
      ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
      ...(options.mirrorDirs !== undefined ? { mirrorDirs: options.mirrorDirs } : {}),
      dryRun: true,
      brainDir,
      repoRoot,
      now,
      envVars,
    });

    const mirrorDirs = resolveEffectiveMirrorDirs(config, options.mirrorDirs, brainDir, repoRoot);
    let mirroredTo = decPreview.mirroredTo;

    if (!dryRun) {
      const decidedDir = path.dirname(targetPath);
      if (!existsSync(decidedDir)) {
        mkdirSync(decidedDir, { recursive: true });
      }
      atomicWriteUtf8(targetPath, decPreview.content);
      try {
        const evalRes = evaluateBrain({
          brainDir,
          repoRoot,
          strict: true,
          now,
          bypassReadCache: true,
        });
        if (!evalRes.ok) {
          const first = evalRes.issues[0];
          throw new VeriBrainError({
            exitCode: evalRes.exitCode,
            code: "PROMOTE_EVAL_FAILED",
            claimId: first?.claimId ?? targetDecId,
            rule: first?.rule ?? "eval_failed",
            detail: first?.detail ?? "Post-promotion eval --strict failed.",
            fix: first?.fix ?? "Run veribrain eval --strict to inspect issues.",
          });
        }
      } catch (err) {
        if (existsSync(targetPath)) {
          try {
            unlinkSync(targetPath);
            invalidateFileReadCache(targetPath);
          } catch {
            // Best-effort rollback.
          }
        }
        throw err;
      }

      mirroredTo = syncMirrorFiles(brainDir, mirrorDirs, [`decided/${targetDecId}.md`], false);
      unlinkSync(hypPath);
      invalidateFileReadCache(hypPath);
    }

    return {
      hypId,
      promotedTo: "decided",
      promotedId: targetDecId,
      targetPath,
      mirroredTo,
      dryRun,
      removedHypothesis: !dryRun,
    };
  }

  // Scar promotion
  const regressionTest = (options.regressionTest ?? hyp.regression_test ?? "").trim();
  assertQuarantineClean(regressionTest, {
    claimId: hypId,
    field: "regression_test",
    config: quarantineConfig,
    allowHashRefExemption: false,
  });
  if (!isValidRepoRelativeTestRef(regressionTest)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: hypId,
      rule: "invalid_scar_regression_test",
      detail: "Scar promotion requires a safe repo-relative regression_test path.",
      fix: "Pass --regression-test tests/unit/<file>.test.ts#L1.",
    });
  }
  if (!regressionTestFileExists(repoRoot, regressionTest)) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: hypId,
      rule: "missing_regression_test_file",
      detail: `Regression test file not found inside repo root (${regressionTest}).`,
      fix: "Create the regression test file or pass an existing repo-relative path via --regression-test.",
    });
  }

  const scarsPath = resolveScarsPathConfined(brainDir, hypId);
  const existingScarsParsed = parseScarsFile(brainDir, quarantineConfig, {
    now,
    bypassReadCache: true,
  });
  const scarId = options.id
    ? assertValidClaimId(options.id, "SCAR", quarantineConfig)
    : computeNextScarId(existingScarsParsed.scars.map((s) => s.scar_id));

  if (existingScarsParsed.scars.some((s) => s.scar_id === scarId)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: scarId,
      rule: "duplicate_scar_id",
      detail: `Scar ${scarId} already exists in .brain/scars.md.`,
      fix: "Pass a unique --id SCAR-NNN or omit --id to auto-increment.",
    });
  }

  const roles = validatePromoteRoles(options.roles ?? hyp.roles, scarId, quarantineConfig);
  const singleLineHint = normalizeLf(hyp.hint).replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  assertQuarantineClean(singleLineHint, {
    claimId: scarId,
    field: "hint",
    config: quarantineConfig,
    allowHashRefExemption: false,
  });

  const ttlDays =
    hyp.proposed_ttl_days !== undefined &&
    Number.isInteger(hyp.proposed_ttl_days) &&
    hyp.proposed_ttl_days >= 1 &&
    hyp.proposed_ttl_days <= 30
      ? hyp.proposed_ttl_days
      : 30;
  const createdAtUtc = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const expiresAtUtc = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  const entryBlock = [
    `## ${scarId}`,
    `- created_at_utc: ${createdAtUtc}`,
    `- expires_at_utc: ${expiresAtUtc}`,
    `- regression_test: ${regressionTest}`,
    `- roles: ${formatRolesYaml(roles)}`,
    `- hint: ${singleLineHint}`,
    "",
  ].join("\n");

  const hadScarsFile = lstatOrNull(scarsPath) !== null;
  const previousScarsRaw = hadScarsFile ? readFileSync(scarsPath, "utf8") : null;
  const existingRaw =
    previousScarsRaw !== null ? normalizeLf(previousScarsRaw) : DEFAULT_SCARS_HEADER;
  const trimmedBase = existingRaw.trimEnd();
  const nextScarsContent = `${trimmedBase}\n\n${entryBlock}`;
  const nextBytes = Buffer.byteLength(nextScarsContent, "utf8");
  if (nextBytes >= MAX_SCARS_BYTES) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCARS_BUDGET_EXCEEDED",
      claimId: "scars.md",
      rule: "scars_size_limit_exceeded",
      detail: `Promoting ${hypId} would bring scars.md to ${nextBytes} bytes (must be < ${MAX_SCARS_BYTES} B).`,
      fix: "Prune expired or resolved scars in .brain/scars.md before promoting.",
    });
  }

  assertQuarantineClean(nextScarsContent, {
    claimId: scarId,
    config: quarantineConfig,
    allowHashRefExemption: false,
  });

  const mirrorDirs = resolveEffectiveMirrorDirs(config, options.mirrorDirs, brainDir, repoRoot);

  let mirroredTo: string[] = [];
  if (!dryRun) {
    atomicWriteUtf8(scarsPath, nextScarsContent);
    try {
      const evalRes = evaluateBrain({
        brainDir,
        repoRoot,
        strict: true,
        now,
        bypassReadCache: true,
      });
      if (!evalRes.ok) {
        const first = evalRes.issues[0];
        throw new VeriBrainError({
          exitCode: evalRes.exitCode,
          code: "PROMOTE_EVAL_FAILED",
          claimId: first?.claimId ?? scarId,
          rule: first?.rule ?? "eval_failed",
          detail: first?.detail ?? "Post-promotion eval --strict failed.",
          fix: first?.fix ?? "Run veribrain eval --strict to inspect issues.",
        });
      }
    } catch (err) {
      try {
        if (hadScarsFile && previousScarsRaw !== null) {
          atomicWriteUtf8(scarsPath, previousScarsRaw);
        } else if (existsSync(scarsPath)) {
          unlinkSync(scarsPath);
          invalidateFileReadCache(scarsPath);
        }
      } catch {
        // Best-effort rollback.
      }
      throw err;
    }

    mirroredTo = syncMirrorFiles(brainDir, mirrorDirs, ["scars.md"], false);
    unlinkSync(hypPath);
    invalidateFileReadCache(hypPath);
  } else {
    mirroredTo = syncMirrorFiles(brainDir, mirrorDirs, ["scars.md"], true);
  }

  return {
    hypId,
    promotedTo: "scar",
    promotedId: scarId,
    targetPath: scarsPath,
    mirroredTo,
    dryRun,
    removedHypothesis: !dryRun,
  };
}
