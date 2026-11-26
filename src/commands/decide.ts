import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { atomicWriteUtf8, resolveEffectiveMirrorDirs, syncMirrorFiles } from "../mirror.js";
import { computeDecidedBodyHash, normalizeLf, normalizeText } from "../normalize.js";
import { assertQuarantineClean } from "../quarantine.js";
import { hasControlOrBidiChars } from "../sanitize.js";
import {
  assertHumanProvenance,
  assertValidClaimId,
  defaultQuarantineConfig,
  INVALID_ENV_FIX_HINT,
  isValidDecidedStatus,
  isValidEnv,
  isValidPriority,
  loadBrainConfig,
  parseFrontmatter,
  resolveBrainPaths,
} from "../schema.js";
import {
  type BrainConfig,
  type DecideOptions,
  type DecideResult,
  EXIT_ERROR,
  EXIT_PROVENANCE_VIOLATION,
  type QuarantineConfig,
  type SignOptions,
  type SignResult,
  VeriBrainError,
} from "../types.js";

const VALID_ROLE_TOKEN_RE = /^(?:\*|[A-Za-z0-9._-]{1,64})$/;

function formatYamlToken(token: string): string {
  if (token === "*" || /[:#[\]{},&*?|>!%@`"'\\]/.test(token) || /\s/.test(token)) {
    const safe = token.replace(/"/g, "'");
    return `"${safe}"`;
  }
  return token;
}

function formatYamlArray(items: readonly string[]): string {
  return `[${items.map((item) => formatYamlToken(item)).join(", ")}]`;
}

function formatYamlScalar(value: string): string {
  if (/[:#[\]{},&*?|>!%@`"'\\]/.test(value) || value.startsWith("-") || value.startsWith(" ")) {
    const safe = value.replace(/"/g, "'");
    return `"${safe}"`;
  }
  return value;
}

function loadConfigIfExists(brainDir: string): BrainConfig | undefined {
  if (existsSync(path.join(brainDir, "config.json"))) {
    return loadBrainConfig(brainDir, true);
  }
  return undefined;
}

function assertDecidedDirConfinement(brainDir: string): string {
  const resolvedBrainDir = path.resolve(brainDir);
  if (!existsSync(resolvedBrainDir)) {
    mkdirSync(resolvedBrainDir, { recursive: true });
  }
  const decidedDir = path.resolve(resolvedBrainDir, "decided");
  if (!existsSync(decidedDir)) {
    mkdirSync(decidedDir, { recursive: true });
  }
  if (lstatSync(decidedDir).isSymbolicLink()) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "decided",
      rule: "path_confinement_violation",
      detail: ".brain/decided/ cannot be a symbolic link.",
      fix: "Replace symlinked .brain/decided with a real directory.",
    });
  }
  const realBrain = realpathSync(resolvedBrainDir);
  const realDecided = realpathSync(decidedDir);
  const expected = path.join(realBrain, "decided");
  const isWin = process.platform === "win32";
  if (
    (isWin ? realDecided.toLowerCase() : realDecided) !==
    (isWin ? expected.toLowerCase() : expected)
  ) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "decided",
      rule: "path_confinement_violation",
      detail: ".brain/decided/ must resolve strictly inside .brain/.",
      fix: "Use a local .brain/decided/ directory.",
    });
  }
  return realDecided;
}

function buildDecidedMarkdown(params: {
  id: string;
  priority: string;
  roles: readonly string[];
  envs?: readonly string[];
  title?: string;
  supersedes?: string;
  signedBy: string;
  signedAtUtc: string;
  sha256Body: string;
  status: string;
  body: string;
  extraFields?: ReadonlyArray<[string, string | string[]]>;
}): { content: string; shaLineNum: number } {
  const lines: string[] = ["---", `id: ${params.id}`];
  if (params.title !== undefined) {
    lines.push(`title: ${formatYamlScalar(params.title)}`);
  }
  lines.push(`priority: ${params.priority}`);
  lines.push(`roles: ${formatYamlArray(params.roles)}`);
  if (params.envs !== undefined && params.envs.length > 0) {
    lines.push(`envs: ${formatYamlArray(params.envs)}`);
  }
  lines.push(`signed_by: ${params.signedBy}`);
  lines.push(`signed_at_utc: ${params.signedAtUtc}`);
  const shaLineNum = lines.length + 1;
  lines.push(`sha256_body: ${params.sha256Body}`);
  lines.push(`status: ${params.status}`);
  if (params.supersedes !== undefined) {
    lines.push(`supersedes: ${params.supersedes}`);
  }
  if (params.extraFields) {
    for (const [k, v] of params.extraFields) {
      if (Array.isArray(v)) {
        lines.push(`${k}: ${formatYamlArray(v)}`);
      } else {
        lines.push(`${k}: ${formatYamlScalar(v)}`);
      }
    }
  }
  lines.push("---", params.body, "");
  return { content: lines.join("\n"), shaLineNum };
}

export function decideRule(options: DecideOptions): DecideResult {
  const { brainDir, repoRoot } = resolveBrainPaths(options.brainDir, options.repoRoot, {
    allowWorktreeFallback: false,
  });
  const config = loadConfigIfExists(brainDir);
  const quarantineConfig: QuarantineConfig = config?.quarantine ?? defaultQuarantineConfig();

  const signedBy = assertHumanProvenance({
    claimId: options.id || "decide",
    signedBy: options.signedBy,
    requireSignedBy: true,
    ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
    envVars: options.envVars ?? process.env,
    config: quarantineConfig,
  });
  if (!signedBy) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "decide",
      rule: "agent_signed_decided",
      detail: "--signed-by human owner identity is required.",
      fix: 'Pass --signed-by "Human Owner".',
    });
  }

  const id = assertValidClaimId(options.id, "DEC", quarantineConfig);

  if (!isValidPriority(options.priority)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: id,
      rule: "invalid_priority",
      detail: "--priority must be P0, P1, or P2.",
      fix: "Pass --priority P0|P1|P2.",
    });
  }

  const roles = (options.roles ?? ["*"]).map((r) => r.trim()).filter((r) => r.length > 0);
  if (roles.length === 0 || !roles.every((r) => VALID_ROLE_TOKEN_RE.test(r))) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: id,
      rule: "invalid_roles",
      detail: "--roles must contain valid role tokens or '*'.",
      fix: 'Pass --roles "*,builder" or omit --roles for wildcard.',
    });
  }
  for (const role of roles) {
    assertQuarantineClean(role, {
      claimId: id,
      field: "roles",
      config: quarantineConfig,
      allowHashRefExemption: false,
    });
  }

  const envs = (options.envs ?? ["*"]).map((e) => e.trim()).filter((e) => e.length > 0);
  if (envs.length === 0 || !envs.every((e) => e === "*" || isValidEnv(e))) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: id,
      rule: "invalid_env",
      detail: "--envs entries must be *, local, pre-staging, staging, or prod.",
      fix: INVALID_ENV_FIX_HINT,
    });
  }

  let title: string | undefined;
  if (options.title !== undefined) {
    const rawTitle = options.title;
    if (hasControlOrBidiChars(rawTitle) || rawTitle.includes("\n") || rawTitle.includes("\r")) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: id,
        rule: "invalid_title",
        detail: "--title cannot contain newlines or control characters.",
        fix: "Pass a single-line plain-text --title.",
      });
    }
    const trimmedTitle = rawTitle.trim();
    if (trimmedTitle.length === 0) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: id,
        rule: "invalid_title",
        detail: "--title cannot be empty when specified.",
        fix: "Provide a non-empty --title or omit --title.",
      });
    }
    assertQuarantineClean(trimmedTitle, {
      claimId: id,
      field: "title",
      config: quarantineConfig,
      allowHashRefExemption: false,
    });
    title = trimmedTitle;
  }

  let supersedes: string | undefined;
  if (options.supersedes !== undefined) {
    supersedes = assertValidClaimId(options.supersedes, "DEC", quarantineConfig);
  }

  const hasFile = options.file !== undefined && options.file.trim().length > 0;
  const hasBody = options.body !== undefined;
  if (hasFile === hasBody) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: id,
      rule: "invalid_body_source",
      detail: "Specify exactly one of --file <draft.md> or --body <text>.",
      fix: 'Pass either --file path/to/draft.md or --body "Rule text".',
    });
  }

  let rawBodyText: string;
  if (hasFile && options.file !== undefined) {
    const draftPath = path.isAbsolute(options.file)
      ? path.resolve(options.file)
      : path.resolve(repoRoot, options.file);
    if (!existsSync(draftPath) || !lstatSync(draftPath).isFile()) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: id,
        rule: "draft_file_not_found",
        detail: `Draft file not found: ${draftPath}.`,
        fix: "Pass a readable markdown/text file to --file.",
      });
    }
    rawBodyText = readFileSync(draftPath, "utf8");
  } else {
    rawBodyText = options.body ?? "";
  }

  const normalizedBody = normalizeText(rawBodyText).trim();
  if (normalizedBody.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "empty_decided_body",
      detail: "Decided rule body cannot be empty.",
      fix: "Provide non-empty rule text via --body or --file.",
    });
  }

  assertQuarantineClean(normalizedBody, {
    claimId: id,
    field: "body",
    config: quarantineConfig,
    allowHashRefExemption: false,
  });

  const sha256Body = computeDecidedBodyHash(normalizedBody);
  const signedAtUtc = (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");

  const { content, shaLineNum } = buildDecidedMarkdown({
    id,
    priority: options.priority,
    roles,
    envs,
    ...(title !== undefined ? { title } : {}),
    ...(supersedes !== undefined ? { supersedes } : {}),
    signedBy,
    signedAtUtc,
    sha256Body,
    status: "active",
    body: normalizedBody,
  });

  assertQuarantineClean(content, {
    claimId: id,
    config: quarantineConfig,
    allowlistedLineTokens: new Map([[shaLineNum, new Set([sha256Body.toLowerCase()])]]),
  });

  const mirrorDirs = resolveEffectiveMirrorDirs(config, options.mirrorDirs, brainDir, repoRoot);
  const dryRun = Boolean(options.dryRun);
  const fileName = `${id}.md`;
  const targetPath = dryRun
    ? path.resolve(brainDir, "decided", fileName)
    : path.join(assertDecidedDirConfinement(brainDir), fileName);

  let mirroredTo: string[] = [];
  if (!dryRun) {
    atomicWriteUtf8(targetPath, content);
    mirroredTo = syncMirrorFiles(brainDir, mirrorDirs, [`decided/${fileName}`], false);
  } else {
    mirroredTo = syncMirrorFiles(brainDir, mirrorDirs, [`decided/${fileName}`], true);
  }

  return {
    id,
    filePath: targetPath,
    sha256_body: sha256Body,
    signedBy,
    mirroredTo,
    dryRun,
    content,
  };
}

export function signDecidedFile(options: SignOptions): SignResult {
  const { brainDir, repoRoot } = resolveBrainPaths(options.brainDir, options.repoRoot, {
    allowWorktreeFallback: false,
  });
  const config = loadConfigIfExists(brainDir);
  const quarantineConfig: QuarantineConfig = config?.quarantine ?? defaultQuarantineConfig();

  // Fail closed immediately on agent env or non-human issuer before touching disk
  assertHumanProvenance({
    claimId: "sign",
    ...(options.signedBy !== undefined ? { signedBy: options.signedBy } : {}),
    ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
    envVars: options.envVars ?? process.env,
    config: quarantineConfig,
  });

  const resolvedFile = path.isAbsolute(options.filePath)
    ? path.resolve(options.filePath)
    : path.resolve(repoRoot, options.filePath);

  let lst: Stats;
  try {
    lst = lstatSync(resolvedFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "sign",
        rule: "decided_file_not_found",
        detail: `Decided file not found: ${resolvedFile}.`,
        fix: "Pass an existing .brain/decided/<ID>.md file path.",
      });
    }
    throw err;
  }
  if (lst.isSymbolicLink() || !lst.isFile()) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "sign",
      rule: "path_confinement_violation",
      detail: "Target file for veribrain sign must be a regular non-symlink file.",
      fix: "Point veribrain sign to a regular file inside .brain/decided/.",
    });
  }

  const realDecidedDir = assertDecidedDirConfinement(brainDir);
  const realTarget = realpathSync(resolvedFile);
  const isWin = process.platform === "win32";
  const cmpDir = isWin ? realDecidedDir.toLowerCase() : realDecidedDir;
  const cmpTarget = isWin ? realTarget.toLowerCase() : realTarget;
  if (path.dirname(cmpTarget) !== cmpDir || !realTarget.endsWith(".md")) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: "sign",
      rule: "path_confinement_violation",
      detail:
        "veribrain sign only accepts direct .md children inside .brain/decided/ (subdirectories denied).",
      fix: "Move or specify a direct file inside .brain/decided/*.md.",
    });
  }

  const fileName = path.basename(realTarget);
  const raw = readFileSync(realTarget, "utf8");
  const rawLines = normalizeLf(raw).split("\n");
  const rawAllowLines = new Map<number, Set<string>>();
  if ((rawLines[0] ?? "").trim() === "---") {
    for (let i = 1; i < rawLines.length; i += 1) {
      const line = rawLines[i] ?? "";
      if (line.trim() === "---") {
        break;
      }
      const m = /^\s*sha256_body\s*:\s*["']?([0-9a-f]{64})["']?\s*$/i.exec(line);
      if (m?.[1]) {
        rawAllowLines.set(i + 1, new Set([m[1].toLowerCase()]));
      }
    }
  }
  assertQuarantineClean(raw, {
    claimId: fileName,
    config: quarantineConfig,
    allowlistedLineTokens: rawAllowLines,
  });

  const parsed = parseFrontmatter(raw, fileName);

  const rawId = parsed.fields.get("id");
  if (typeof rawId !== "string" || rawId.trim().length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: fileName,
      rule: "missing_id",
      detail: `Decided frontmatter missing required id field in ${fileName}.`,
      fix: `Add id: DEC-NNN to ${fileName}.`,
    });
  }
  const id = assertValidClaimId(rawId, "DEC", quarantineConfig);

  const rawPriority = parsed.fields.get("priority");
  if (typeof rawPriority !== "string" || !isValidPriority(rawPriority.trim())) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "invalid_priority",
      detail: "Decided priority must be P0, P1, or P2.",
      fix: `Set priority to P0, P1, or P2 in ${fileName}.`,
    });
  }
  const priority = rawPriority.trim();

  const rawRoles = parsed.fields.get("roles");
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
      fix: `Add roles: ["*"] to ${fileName}.`,
    });
  }

  const rawStatus = parsed.fields.get("status");
  const status = typeof rawStatus === "string" ? rawStatus.trim() : "active";
  if (!isValidDecidedStatus(status)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "invalid_status",
      detail: "Decided status must be active or superseded.",
      fix: `Set status to active or superseded in ${fileName}.`,
    });
  }

  const existingSignedBy = parsed.fields.get("signed_by");
  const effectiveSignedByRaw =
    options.signedBy !== undefined
      ? options.signedBy
      : typeof existingSignedBy === "string"
        ? existingSignedBy
        : "";
  const signedBy = assertHumanProvenance({
    claimId: id,
    signedBy: effectiveSignedByRaw,
    requireSignedBy: true,
    ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
    envVars: options.envVars ?? process.env,
    config: quarantineConfig,
  });
  if (!signedBy) {
    throw new VeriBrainError({
      exitCode: EXIT_PROVENANCE_VIOLATION,
      code: "PROVENANCE_VIOLATION",
      claimId: id,
      rule: "agent_signed_decided",
      detail: "DECIDED records require a human signed_by identity.",
      fix: 'Pass --signed-by "Human Owner".',
    });
  }

  const normalizedBody = normalizeText(normalizeLf(parsed.body)).trim();
  if (normalizedBody.length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "SCHEMA_ERROR",
      claimId: id,
      rule: "empty_decided_body",
      detail: "Decided rule body cannot be empty.",
      fix: `Add policy content below frontmatter in ${fileName}.`,
    });
  }

  assertQuarantineClean(normalizedBody, {
    claimId: id,
    field: "body",
    config: quarantineConfig,
    allowHashRefExemption: false,
  });

  const rawEnvs = parsed.fields.get("envs");
  const envs = Array.isArray(rawEnvs)
    ? rawEnvs
    : typeof rawEnvs === "string"
      ? rawEnvs
          .split(",")
          .map((e) => e.trim())
          .filter((e) => e.length > 0)
      : undefined;
  const rawTitle = parsed.fields.get("title");
  const title =
    typeof rawTitle === "string" && rawTitle.trim().length > 0 ? rawTitle.trim() : undefined;
  const rawSupersedes = parsed.fields.get("supersedes");
  const supersedes =
    typeof rawSupersedes === "string" && rawSupersedes.trim().length > 0
      ? assertValidClaimId(rawSupersedes, "DEC", quarantineConfig)
      : undefined;

  const knownKeys = new Set([
    "id",
    "title",
    "priority",
    "roles",
    "envs",
    "signed_by",
    "signed_at_utc",
    "sha256_body",
    "status",
    "supersedes",
  ]);
  const extraFields: Array<[string, string | string[]]> = [];
  for (const [k, v] of parsed.fields.entries()) {
    if (!knownKeys.has(k)) {
      extraFields.push([k, v]);
    }
  }

  const sha256Body = computeDecidedBodyHash(normalizedBody);
  const signedAtUtc = (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");

  const { content, shaLineNum } = buildDecidedMarkdown({
    id,
    priority,
    roles,
    ...(envs !== undefined && envs.length > 0 ? { envs } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(supersedes !== undefined ? { supersedes } : {}),
    signedBy,
    signedAtUtc,
    sha256Body,
    status,
    body: normalizedBody,
    ...(extraFields.length > 0 ? { extraFields } : {}),
  });

  assertQuarantineClean(content, {
    claimId: id,
    config: quarantineConfig,
    allowlistedLineTokens: new Map([[shaLineNum, new Set([sha256Body.toLowerCase()])]]),
  });

  const mirrorDirs = resolveEffectiveMirrorDirs(config, options.mirrorDirs, brainDir, repoRoot);
  const dryRun = Boolean(options.dryRun);

  let mirroredTo: string[] = [];
  if (!dryRun) {
    atomicWriteUtf8(realTarget, content);
    mirroredTo = syncMirrorFiles(brainDir, mirrorDirs, [`decided/${fileName}`], false);
  } else {
    mirroredTo = syncMirrorFiles(brainDir, mirrorDirs, [`decided/${fileName}`], true);
  }

  return {
    id,
    filePath: realTarget,
    signedBy,
    sha256_body: sha256Body,
    mirroredTo,
    dryRun,
    content,
  };
}
