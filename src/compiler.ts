import { performance } from "node:perf_hooks";
import {
  isMetricsEnabled,
  recordCompileMetricBestEffort,
  resolveMetricsMaxBytes,
} from "./metrics.js";
import {
  canonicalJsonStringify,
  compareAscii,
  estimateTokens,
  normalizeText,
  sha256Hex,
} from "./normalize.js";
import { assertQuarantineClean } from "./quarantine.js";
import { renderUntrustedHint } from "./sanitize.js";
import {
  INVALID_ENV_FIX_HINT,
  isValidEnv,
  isValidGitSha,
  isValidZoneALayout,
  loadBrain,
  parseIsoTimestampMs,
  resolveWorktreeHeadSha,
} from "./schema.js";
import {
  type BrainConfig,
  type CompileOptions,
  type CompileResult,
  type DecidedRecord,
  EXIT_BUDGET_INFEASIBLE,
  EXIT_ERROR,
  type HypothesisRecord,
  KV_CACHE_MIN_FLOOR_TOKENS,
  type ObservedRecord,
  priorityRank,
  type QuarantineConfig,
  type ScarRecord,
  type SchemaVersion,
  VeriBrainError,
  ZONE_A0_BOUNDARY_MARKER,
  ZONE_BOUNDARY_MARKER,
  type ZoneALayout,
} from "./types.js";

const VALID_ROLE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const BOUNDARY_OVERHEAD = `${ZONE_BOUNDARY_MARKER}\n\n`;
const ZONE_A0_BOUNDARY_OVERHEAD = `${ZONE_A0_BOUNDARY_MARKER}\n\n`;

function matchesRole(roles: readonly string[], role: string): boolean {
  return roles.includes(role) || roles.includes("*");
}

function buildSemanticHash(
  config: BrainConfig,
  role: string,
  activeDecided: readonly DecidedRecord[],
  zoneALayout: ZoneALayout,
): string {
  const payload =
    zoneALayout === "split"
      ? {
          schema_version: config.schema_version,
          zone_a_layout: "split" as const,
          role,
          semantic_keys: config.semantic_keys ?? {},
          decided: activeDecided.map((record) => ({
            id: record.id,
            priority: record.priority,
            sha256_body: record.sha256_body,
          })),
        }
      : {
          schema_version: config.schema_version,
          role,
          semantic_keys: config.semantic_keys ?? {},
          decided: activeDecided.map((record) => ({
            id: record.id,
            priority: record.priority,
            sha256_body: record.sha256_body,
          })),
        };
  return sha256Hex(canonicalJsonStringify(payload));
}

function renderZoneA(
  schemaVersion: SchemaVersion,
  role: string,
  activeDecided: readonly DecidedRecord[],
): string {
  const lines: string[] = [
    "# VeriBrain Context - Zone A (Static Prefix)",
    `schema_version: ${schemaVersion}`,
    `role: ${role}`,
    "",
    "## Role Contract",
    `Role: ${role}`,
    "Trust Hierarchy: DECIDED (Tier 1) > OBSERVED (Tier 2) > untrusted_hint (Tier 3, non-authoritative).",
    "",
    "## Decided Rules",
  ];

  if (activeDecided.length === 0) {
    lines.push("_No active DECIDED rules for this role._");
  } else {
    for (const record of activeDecided) {
      lines.push(`### [${record.priority}] ${record.id}`);
      lines.push(record.body);
      lines.push(`Based on: ${record.id} (sha256:${record.sha256_body.slice(0, 12)})`);
      lines.push("");
    }
  }

  return `${normalizeText(lines.join("\n")).trimEnd()}\n\n`;
}

function renderZoneA0(
  schemaVersion: SchemaVersion,
  sharedDecided: readonly DecidedRecord[],
): string {
  const lines: string[] = [
    "# VeriBrain Context - Zone A0 (Shared Constitutional Prefix)",
    `schema_version: ${schemaVersion}`,
    "Trust Hierarchy: DECIDED (Tier 1) > OBSERVED (Tier 2) > untrusted_hint (Tier 3, non-authoritative).",
    "",
    "## Shared Decided Rules (All Roles)",
  ];

  if (sharedDecided.length === 0) {
    lines.push("_No shared DECIDED rules._");
  } else {
    for (const record of sharedDecided) {
      lines.push(`### [${record.priority}] ${record.id}`);
      lines.push(record.body);
      lines.push(`Based on: ${record.id} (sha256:${record.sha256_body.slice(0, 12)})`);
      lines.push("");
    }
  }

  return `${normalizeText(lines.join("\n")).trimEnd()}\n\n`;
}

function renderZoneA1(role: string, roleDecided: readonly DecidedRecord[]): string {
  const lines: string[] = [
    "# VeriBrain Context - Zone A1 (Role Delta)",
    `role: ${role}`,
    "",
    "## Role Contract",
    `Role: ${role}`,
    "",
    "## Role-Specific Decided Rules",
  ];

  if (roleDecided.length === 0) {
    lines.push("_No role-specific DECIDED rules._");
  } else {
    for (const record of roleDecided) {
      lines.push(`### [${record.priority}] ${record.id}`);
      lines.push(record.body);
      lines.push(`Based on: ${record.id} (sha256:${record.sha256_body.slice(0, 12)})`);
      lines.push("");
    }
  }

  return `${normalizeText(lines.join("\n")).trimEnd()}\n\n`;
}

function renderZoneB(
  env: string,
  gitSha: string | null,
  observed: readonly ObservedRecord[],
  scars: readonly ScarRecord[],
  hypotheses: readonly HypothesisRecord[],
  evictedIds: readonly string[],
  quarantineConfig: QuarantineConfig,
): { text: string; blocks: number } {
  const lines: string[] = [
    "# VeriBrain Context - Zone B (Dynamic Tail)",
    `env: ${env}`,
    `git_sha: ${gitSha ?? "any"}`,
  ];
  let blocks = 1;

  if (observed.length > 0) {
    lines.push("", "## Observed Facts");
    for (const item of observed) {
      lines.push(`### ${item.claim_id}`);
      lines.push(item.summary);
      lines.push(`Evidence: ${item.evidence_ref}`);
      const citationScope =
        (item.ttl_mode ?? "sha-pinned") === "env-ttl"
          ? `${item.env}@${item.git_sha}, env-ttl`
          : `${item.env}@${item.git_sha}`;
      lines.push(`Based on: ${item.claim_id} (${citationScope})`);
      lines.push("");
      blocks += 1;
    }
  }

  if (scars.length > 0 || hypotheses.length > 0) {
    lines.push("", "## Untrusted Hints (Non-Authoritative)");
    for (const scar of scars) {
      const renderedHint = renderUntrustedHint({
        source: "scar",
        id: scar.scar_id,
        regressionTest: scar.regression_test,
        body: scar.hint,
      });
      assertQuarantineClean(renderedHint, { claimId: scar.scar_id, config: quarantineConfig });
      lines.push(renderedHint);
      lines.push("");
      blocks += 1;
    }
    for (const hyp of hypotheses) {
      const renderedHint = renderUntrustedHint({
        source: "hypothesis",
        id: hyp.id,
        body: hyp.hint,
      });
      assertQuarantineClean(renderedHint, { claimId: hyp.id, config: quarantineConfig });
      lines.push(renderedHint);
      lines.push("");
      blocks += 1;
    }
  }

  if (evictedIds.length > 0) {
    const sortedEvicted = [...evictedIds].sort(compareAscii);
    lines.push("", "## Evicted (Token Budget)");
    for (const id of sortedEvicted) {
      lines.push(`[EVICTED: ${id}, reason=token_budget]`);
    }
    blocks += 1;
  }

  const text = `${normalizeText(lines.join("\n")).trimEnd()}\n`;
  return { text, blocks };
}

function formatBlockingClaimIds(ids: readonly string[], fallback: string): string {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return fallback;
  }
  const visible = unique.slice(0, 5);
  const extra = unique.length - visible.length;
  return extra > 0 ? `${visible.join(",")}(+${extra})` : visible.join(",");
}

export function formatCompiledMarkdown(result: CompileResult): string {
  return `${result.zone_a}${BOUNDARY_OVERHEAD}${result.zone_b}`;
}

export function compileContext(options: CompileOptions): CompileResult {
  const startMs = performance.now();

  const role = options.role.trim();
  assertQuarantineClean(role, {
    claimId: "compile",
    field: "role",
    allowHashRefExemption: false,
  });
  if (!VALID_ROLE_RE.test(role)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "compile",
      rule: "invalid_role",
      detail: "Compile --role must match ^[A-Za-z0-9._-]{1,64}$.",
      fix: "Run veribrain compile --role builder --env staging.",
    });
  }

  if (!isValidEnv(options.env)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "compile",
      rule: "invalid_env",
      detail: "Compile --env must be local, pre-staging, staging, or prod.",
      fix: INVALID_ENV_FIX_HINT,
    });
  }

  let gitSha: string | null = options.gitSha !== undefined ? options.gitSha.trim() : null;
  if (gitSha !== null && gitSha.toUpperCase() === "HEAD") {
    const resolvedHead = resolveWorktreeHeadSha(options.repoRoot ?? process.cwd());
    if (resolvedHead === null) {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: "compile",
        rule: "invalid_git_sha",
        detail: "Could not resolve --git-sha HEAD from .git or worktree HEAD.",
        fix: "Pass an explicit 7-40 hex SHA via --git-sha <hex> or run inside a Git repository.",
      });
    }
    gitSha = resolvedHead;
  }
  if (gitSha !== null && !isValidGitSha(gitSha)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "compile",
      rule: "invalid_git_sha",
      detail: "Compile --git-sha must be 7-40 hex characters (or HEAD inside a git repo).",
      fix: "Pass a valid commit hash via --git-sha <hex>.",
    });
  }

  if (options.zoneALayout !== undefined && !isValidZoneALayout(options.zoneALayout)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "compile",
      rule: "invalid_zone_a_layout",
      detail: "Compile --zone-a-layout must be legacy or split.",
      fix: "Pass --zone-a-layout legacy|split.",
    });
  }

  const now = options.now ?? new Date();
  const brain = loadBrain(options.brainDir, options.repoRoot, {
    now,
    ...(options.bypassReadCache !== undefined ? { bypassReadCache: options.bypassReadCache } : {}),
    ...(options.allowWorktreeFallback !== undefined
      ? { allowWorktreeFallback: options.allowWorktreeFallback }
      : {}),
  });
  const { config } = brain;
  const zoneALayout: ZoneALayout =
    options.zoneALayout ??
    config.zone_a_layout ??
    (config.schema_version === "1.1" ? "split" : "legacy");

  const maxTokens = options.maxTokens ?? config.default_max_tokens;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "compile",
      rule: "invalid_max_tokens",
      detail: "--max-tokens must be a positive integer.",
      fix: "Pass a positive integer to --max-tokens (e.g. --max-tokens 8192).",
    });
  }

  const nowMs = now.getTime();
  const pinnedSet = new Set(config.pinned_ids);

  const activeDecided = brain.decided
    .filter((d) => d.status === "active" && matchesRole(d.roles, role))
    .sort((a, b) => {
      const pDiff = priorityRank(a.priority) - priorityRank(b.priority);
      if (pDiff !== 0) {
        return pDiff;
      }
      return compareAscii(a.id, b.id);
    });

  const semanticHash = buildSemanticHash(config, role, activeDecided, zoneALayout);

  let zoneA: string;
  let zoneA0: string;
  let zoneA1: string;
  let zoneABytes: number;
  let zoneA0Bytes: number;
  let zoneA1Bytes: number;
  let zoneASha256: string;
  let zoneA0Sha256: string;
  let zoneATokensEst: number;
  let zoneA0TokensEst: number;
  let zoneA1TokensEst: number;

  if (zoneALayout === "split") {
    const sharedDecided = activeDecided.filter((d) => d.roles.includes("*"));
    const roleDecided = activeDecided.filter((d) => !d.roles.includes("*"));
    zoneA0 = renderZoneA0(config.schema_version, sharedDecided);
    zoneA1 = renderZoneA1(role, roleDecided);
    zoneA = `${zoneA0}${ZONE_A0_BOUNDARY_OVERHEAD}${zoneA1}`;
    zoneA0Bytes = Buffer.byteLength(zoneA0, "utf8");
    zoneA1Bytes = Buffer.byteLength(zoneA1, "utf8");
    zoneABytes = Buffer.byteLength(zoneA, "utf8");
    zoneA0Sha256 = sha256Hex(Buffer.from(zoneA0, "utf8"));
    zoneASha256 = sha256Hex(Buffer.from(zoneA, "utf8"));
    const zoneA0Blocks = 1 + sharedDecided.length;
    const zoneA1Blocks = 1 + roleDecided.length;
    zoneA0TokensEst = estimateTokens(
      zoneA0,
      zoneA0Blocks,
      config.chars_per_token,
      config.safety_margin,
    );
    zoneA1TokensEst = estimateTokens(
      zoneA1,
      zoneA1Blocks,
      config.chars_per_token,
      config.safety_margin,
    );
    zoneATokensEst = estimateTokens(
      zoneA,
      zoneA0Blocks + zoneA1Blocks,
      config.chars_per_token,
      config.safety_margin,
    );
  } else {
    zoneA = renderZoneA(config.schema_version, role, activeDecided);
    zoneABytes = Buffer.byteLength(zoneA, "utf8");
    zoneASha256 = sha256Hex(Buffer.from(zoneA, "utf8"));
    const zoneABlocks = 1 + activeDecided.length;
    zoneATokensEst = estimateTokens(
      zoneA,
      zoneABlocks,
      config.chars_per_token,
      config.safety_margin,
    );
    zoneA0 = zoneA;
    zoneA1 = "";
    zoneA0Bytes = zoneABytes;
    zoneA1Bytes = 0;
    zoneA0Sha256 = zoneASha256;
    zoneA0TokensEst = zoneATokensEst;
    zoneA1TokensEst = 0;
  }

  const blockingDecidedIds = activeDecided
    .filter((d) => d.priority === "P0" || d.priority === "P1" || pinnedSet.has(d.id))
    .map((d) => d.id);

  if (zoneATokensEst > maxTokens) {
    const blockingLabel = formatBlockingClaimIds(
      blockingDecidedIds.length > 0 ? blockingDecidedIds : activeDecided.map((d) => d.id),
      "zone_a",
    );
    throw new VeriBrainError({
      exitCode: EXIT_BUDGET_INFEASIBLE,
      code: "BUDGET_INFEASIBLE",
      claimId: blockingLabel,
      rule: "pinned_budget_infeasible",
      detail: `Zone A (${zoneATokensEst} est. tokens) exceeds --max-tokens (${maxTokens}).`,
      fix: `veribrain compile --role ${role} --env ${options.env} --max-tokens ${zoneATokensEst}`,
    });
  }

  const excludedStaleSet = new Set<string>();
  const keptObserved: ObservedRecord[] = [];
  for (const obs of brain.observed) {
    if (!matchesRole(obs.roles, role)) {
      continue;
    }
    const observedMs = parseIsoTimestampMs(obs.observed_at_utc) ?? 0;
    const isExpired = nowMs > observedMs + obs.ttl_seconds * 1000;
    const envMismatch = obs.env !== options.env;
    const isEnvTtl = (obs.ttl_mode ?? "sha-pinned") === "env-ttl";
    const shaMismatch =
      !isEnvTtl && gitSha !== null && obs.git_sha.toLowerCase() !== gitSha.toLowerCase();
    if (isExpired || envMismatch || shaMismatch) {
      excludedStaleSet.add(obs.claim_id);
      continue;
    }
    keptObserved.push(obs);
  }
  keptObserved.sort((a, b) => compareAscii(a.claim_id, b.claim_id));

  const keptScars: ScarRecord[] = [];
  for (const scar of brain.scars) {
    if (!matchesRole(scar.roles, role)) {
      continue;
    }
    const expiresMs = parseIsoTimestampMs(scar.expires_at_utc) ?? 0;
    if (nowMs > expiresMs) {
      excludedStaleSet.add(scar.scar_id);
      continue;
    }
    keptScars.push(scar);
  }
  keptScars.sort((a, b) => compareAscii(a.scar_id, b.scar_id));

  const keptHypotheses: HypothesisRecord[] = [];
  for (const hyp of brain.hypotheses) {
    if (!matchesRole(hyp.roles, role)) {
      continue;
    }
    const expiresMs = parseIsoTimestampMs(hyp.expires_at_utc) ?? 0;
    if (nowMs > expiresMs) {
      excludedStaleSet.add(hyp.id);
      continue;
    }
    keptHypotheses.push(hyp);
  }
  keptHypotheses.sort((a, b) => compareAscii(a.id, b.id));

  const evictedIds: string[] = [];
  let zoneBRendered = renderZoneB(
    options.env,
    gitSha,
    keptObserved,
    keptScars,
    keptHypotheses,
    evictedIds,
    config.quarantine,
  );
  let zoneBTokensEst = estimateTokens(
    `${BOUNDARY_OVERHEAD}${zoneBRendered.text}`,
    zoneBRendered.blocks,
    config.chars_per_token,
    config.safety_margin,
  );

  while (zoneATokensEst + zoneBTokensEst > maxTokens) {
    let evicted = false;

    if (keptHypotheses.length > 0) {
      let victimIdx = 0;
      for (let i = 1; i < keptHypotheses.length; i += 1) {
        const cur = keptHypotheses[i];
        const best = keptHypotheses[victimIdx];
        if (!cur || !best) continue;
        const curMs = parseIsoTimestampMs(cur.created_at_utc) ?? 0;
        const bestMs = parseIsoTimestampMs(best.created_at_utc) ?? 0;
        if (curMs < bestMs || (curMs === bestMs && compareAscii(cur.id, best.id) < 0)) {
          victimIdx = i;
        }
      }
      const [victim] = keptHypotheses.splice(victimIdx, 1);
      if (victim) {
        evictedIds.push(victim.id);
        evicted = true;
      }
    } else if (keptScars.length > 0) {
      let victimIdx = 0;
      for (let i = 1; i < keptScars.length; i += 1) {
        const cur = keptScars[i];
        const best = keptScars[victimIdx];
        if (!cur || !best) continue;
        const curMs = parseIsoTimestampMs(cur.created_at_utc) ?? 0;
        const bestMs = parseIsoTimestampMs(best.created_at_utc) ?? 0;
        if (curMs < bestMs || (curMs === bestMs && compareAscii(cur.scar_id, best.scar_id) < 0)) {
          victimIdx = i;
        }
      }
      const [victim] = keptScars.splice(victimIdx, 1);
      if (victim) {
        evictedIds.push(victim.scar_id);
        evicted = true;
      }
    } else {
      let victimIdx = -1;
      for (let i = 0; i < keptObserved.length; i += 1) {
        const cur = keptObserved[i];
        if (!cur) continue;
        if (cur.priority === "P0" || cur.priority === "P1" || pinnedSet.has(cur.claim_id)) {
          continue;
        }
        if (victimIdx === -1) {
          victimIdx = i;
          continue;
        }
        const best = keptObserved[victimIdx];
        if (!best) continue;
        const rankDiff = priorityRank(cur.priority) - priorityRank(best.priority);
        if (rankDiff > 0) {
          victimIdx = i;
          continue;
        }
        if (rankDiff === 0) {
          const curMs = parseIsoTimestampMs(cur.observed_at_utc) ?? 0;
          const bestMs = parseIsoTimestampMs(best.observed_at_utc) ?? 0;
          if (
            curMs < bestMs ||
            (curMs === bestMs && compareAscii(cur.claim_id, best.claim_id) < 0)
          ) {
            victimIdx = i;
          }
        }
      }
      if (victimIdx !== -1) {
        const [victim] = keptObserved.splice(victimIdx, 1);
        if (victim) {
          evictedIds.push(victim.claim_id);
          evicted = true;
        }
      }
    }

    if (!evicted) {
      const requiredTokens = zoneATokensEst + zoneBTokensEst;
      const blockingObsIds = keptObserved.map((o) => o.claim_id);
      const blockingLabel = formatBlockingClaimIds(
        [...blockingDecidedIds, ...blockingObsIds],
        activeDecided[0]?.id ?? "zone_a",
      );
      throw new VeriBrainError({
        exitCode: EXIT_BUDGET_INFEASIBLE,
        code: "BUDGET_INFEASIBLE",
        claimId: blockingLabel,
        rule: "pinned_budget_infeasible",
        detail: `Required context (${requiredTokens} est. tokens) exceeds --max-tokens (${maxTokens}).`,
        fix: `veribrain compile --role ${role} --env ${options.env} --max-tokens ${requiredTokens}`,
      });
    }

    zoneBRendered = renderZoneB(
      options.env,
      gitSha,
      keptObserved,
      keptScars,
      keptHypotheses,
      evictedIds,
      config.quarantine,
    );
    zoneBTokensEst = estimateTokens(
      `${BOUNDARY_OVERHEAD}${zoneBRendered.text}`,
      zoneBRendered.blocks,
      config.chars_per_token,
      config.safety_margin,
    );
  }

  const zoneBBytes = Buffer.byteLength(zoneBRendered.text, "utf8");
  const totalTokensEst = zoneATokensEst + zoneBTokensEst;
  const sortedEvictedIds = [...evictedIds].sort(compareAscii);
  const excludedStaleIds = [...excludedStaleSet].sort(compareAscii);
  const kvCacheFloorAdvisory =
    zoneALayout === "split"
      ? zoneA0TokensEst < KV_CACHE_MIN_FLOOR_TOKENS
        ? `Zone A0 (${zoneA0TokensEst} est. tokens) is below ${KV_CACHE_MIN_FLOOR_TOKENS}-token provider KV-cache floor.`
        : null
      : zoneATokensEst < KV_CACHE_MIN_FLOOR_TOKENS
        ? `Zone A (${zoneATokensEst} est. tokens) is below ${KV_CACHE_MIN_FLOOR_TOKENS}-token provider KV-cache floor.`
        : null;
  const compileMs = Number((performance.now() - startMs).toFixed(3));

  if (
    isMetricsEnabled(config, {
      ...(options.recordMetrics !== undefined ? { recordMetrics: options.recordMetrics } : {}),
      ...(options.envVars !== undefined ? { envVars: options.envVars } : {}),
    })
  ) {
    recordCompileMetricBestEffort(
      brain.brainDir,
      {
        ts: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
        source: options.metricSource ?? "cli",
        role,
        env: options.env,
        layout: zoneALayout,
        zone_a0_sha256: zoneA0Sha256.slice(0, 12),
        zone_a_sha256: zoneASha256.slice(0, 12),
        zone_a0_tokens: zoneA0TokensEst,
        zone_a_tokens: zoneATokensEst,
        zone_b_tokens: zoneBTokensEst,
        total_tokens: totalTokensEst,
        compile_ms: compileMs,
      },
      {
        repoRoot: brain.repoRoot,
        maxBytes: resolveMetricsMaxBytes(config),
      },
    );
  }

  return {
    schema_version: config.schema_version,
    estimator_version: config.estimator_version,
    chars_per_token: config.chars_per_token,
    safety_margin: config.safety_margin,
    role,
    env: options.env,
    git_sha: gitSha,
    zone_a_layout: zoneALayout,
    zone_a: zoneA,
    zone_a0: zoneA0,
    zone_a1: zoneA1,
    zone_b: zoneBRendered.text,
    zone_a_sha256: zoneASha256,
    zone_a0_sha256: zoneA0Sha256,
    semantic_hash: semanticHash,
    zone_a_bytes: zoneABytes,
    zone_a0_bytes: zoneA0Bytes,
    zone_a1_bytes: zoneA1Bytes,
    zone_b_bytes: zoneBBytes,
    zone_a_tokens_est: zoneATokensEst,
    zone_a0_tokens_est: zoneA0TokensEst,
    zone_a1_tokens_est: zoneA1TokensEst,
    zone_b_tokens_est: zoneBTokensEst,
    total_tokens_est: totalTokensEst,
    max_tokens: maxTokens,
    compile_ms: compileMs,
    included_decided_ids: activeDecided.map((d) => d.id),
    included_observed_ids: keptObserved.map((o) => o.claim_id),
    evicted_ids: sortedEvictedIds,
    excluded_stale_ids: excludedStaleIds,
    kv_cache_floor_advisory: kvCacheFloorAdvisory,
  };
}
