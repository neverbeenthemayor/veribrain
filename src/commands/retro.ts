import { compileContext } from "../compiler.js";
import { compareAscii } from "../normalize.js";
import { assertQuarantineClean } from "../quarantine.js";
import {
  INVALID_ENV_FIX_HINT,
  isValidEnv,
  isValidZoneALayout,
  loadBrain,
  parseIsoTimestampMs,
  regressionTestFileExists,
  resolveBrainPaths,
} from "../schema.js";
import {
  type EnvName,
  EXIT_ERROR,
  KV_CACHE_MIN_FLOOR_TOKENS,
  MAX_SCARS_BYTES,
  type RetroExpiringItem,
  type RetroOptions,
  type RetroResult,
  type RetroRoleFloorAudit,
  type RetroScarCheck,
  VeriBrainError,
  type ZoneALayout,
} from "../types.js";
import { parseSinceWindowMs } from "./diff.js";
import { evaluateBrain } from "./eval.js";

export const DEFAULT_RETRO_ROLES = [
  "cpm",
  "builder",
  "cqe",
  "security",
  "cude",
  "cie",
  "cfoe",
  "bench",
] as const;

const EXPIRING_SOON_WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_RETRO_ROLES = 32;

export function generateRetroReport(options: RetroOptions = {}): RetroResult {
  const since = (options.since ?? "7d").trim();
  const windowMs = parseSinceWindowMs(since);
  const env: EnvName = options.env ?? "local";
  if (!isValidEnv(env)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "retro",
      rule: "invalid_env",
      detail: "--env must be local, pre-staging, staging, or prod.",
      fix: INVALID_ENV_FIX_HINT,
    });
  }
  if (options.zoneALayout !== undefined && !isValidZoneALayout(options.zoneALayout)) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "retro",
      rule: "invalid_zone_a_layout",
      detail: "--zone-a-layout must be legacy or split.",
      fix: "Pass --zone-a-layout legacy|split.",
    });
  }

  const { brainDir, repoRoot } = resolveBrainPaths(options.brainDir, options.repoRoot);
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const cutoffMs = nowMs - windowMs;

  const evalRes = evaluateBrain({
    brainDir,
    repoRoot,
    strict: true,
    now,
    bypassReadCache: true,
  });
  const brain = loadBrain(brainDir, repoRoot, { now, bypassReadCache: true });
  const { config } = brain;

  const effectiveLayout: ZoneALayout =
    options.zoneALayout ??
    config.zone_a_layout ??
    (config.schema_version === "1.1" ? "split" : "legacy");

  const targetRoles =
    options.roles && options.roles.length > 0 ? options.roles : [...DEFAULT_RETRO_ROLES];
  if (targetRoles.length > MAX_RETRO_ROLES) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "retro",
      rule: "role_limit_exceeded",
      detail: `--roles exceeds maximum limit of ${MAX_RETRO_ROLES} roles.`,
      fix: `Pass at most ${MAX_RETRO_ROLES} roles to --roles.`,
    });
  }

  // 1. KV-cache >= 1,024-token floor audit across roles
  const roleFloorAudit: RetroRoleFloorAudit[] = [];
  for (const role of targetRoles) {
    const compiled = compileContext({
      role,
      env,
      zoneALayout: effectiveLayout,
      brainDir,
      repoRoot,
      now,
      recordMetrics: false,
    });
    const floorTokens =
      effectiveLayout === "split" ? compiled.zone_a0_tokens_est : compiled.zone_a_tokens_est;
    roleFloorAudit.push({
      role,
      zone_a_layout: compiled.zone_a_layout,
      zone_a_tokens_est: compiled.zone_a_tokens_est,
      zone_a0_tokens_est: compiled.zone_a0_tokens_est,
      zone_a_sha256: compiled.zone_a_sha256,
      zone_a0_sha256: compiled.zone_a0_sha256,
      meets_floor: floorTokens >= KV_CACHE_MIN_FLOOR_TOKENS,
    });
  }

  // 2. Expired & expiring-within-48h OBSERVED / SCAR / HYPOTHESIS
  const expiringItems: RetroExpiringItem[] = [];
  for (const obs of [...brain.observed].sort((a, b) => compareAscii(a.claim_id, b.claim_id))) {
    const obsMs = parseIsoTimestampMs(obs.observed_at_utc) ?? 0;
    const expMs = obsMs + obs.ttl_seconds * 1000;
    const expIso = new Date(expMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    if (nowMs > expMs) {
      expiringItems.push({
        tier: "OBSERVED",
        id: obs.claim_id,
        expires_at_utc: expIso,
        status: "expired",
        detail: `${obs.env}@${obs.git_sha.slice(0, 12)} (${obs.ttl_mode ?? "sha-pinned"})`,
      });
    } else if (expMs - nowMs <= EXPIRING_SOON_WINDOW_MS) {
      expiringItems.push({
        tier: "OBSERVED",
        id: obs.claim_id,
        expires_at_utc: expIso,
        status: "expiring_48h",
        detail: `${obs.env}@${obs.git_sha.slice(0, 12)} (${obs.ttl_mode ?? "sha-pinned"})`,
      });
    }
  }

  const scarChecks: RetroScarCheck[] = [];
  for (const scar of [...brain.scars].sort((a, b) => compareAscii(a.scar_id, b.scar_id))) {
    const expMs = parseIsoTimestampMs(scar.expires_at_utc) ?? 0;
    const expired = nowMs > expMs;
    const testExists = regressionTestFileExists(repoRoot, scar.regression_test);
    scarChecks.push({
      scar_id: scar.scar_id,
      regression_test: scar.regression_test,
      test_exists: testExists,
      expires_at_utc: scar.expires_at_utc,
      expired,
    });
    if (expired) {
      expiringItems.push({
        tier: "SCAR",
        id: scar.scar_id,
        expires_at_utc: scar.expires_at_utc,
        status: "expired",
        detail: `regression_test=${scar.regression_test}`,
      });
    } else if (expMs - nowMs <= EXPIRING_SOON_WINDOW_MS) {
      expiringItems.push({
        tier: "SCAR",
        id: scar.scar_id,
        expires_at_utc: scar.expires_at_utc,
        status: "expiring_48h",
        detail: `regression_test=${scar.regression_test}`,
      });
    }
  }

  const pendingHypotheses: RetroResult["pending_hypotheses"] = [];
  for (const hyp of [...brain.hypotheses].sort((a, b) => compareAscii(a.id, b.id))) {
    const expMs = parseIsoTimestampMs(hyp.expires_at_utc) ?? 0;
    if (nowMs > expMs) {
      expiringItems.push({
        tier: "HYPOTHESIS",
        id: hyp.id,
        expires_at_utc: hyp.expires_at_utc,
        status: "expired",
        detail: `kind=${hyp.kind ?? "hypothesis"}`,
      });
    } else if (expMs - nowMs <= EXPIRING_SOON_WINDOW_MS) {
      expiringItems.push({
        tier: "HYPOTHESIS",
        id: hyp.id,
        expires_at_utc: hyp.expires_at_utc,
        status: "expiring_48h",
        detail: `kind=${hyp.kind ?? "hypothesis"}`,
      });
    }
    const isScar =
      hyp.kind === "scar_proposal" ||
      hyp.kind === "hypothesis_scar" ||
      hyp.id.startsWith("HYP-SCAR-");
    const promoteCmd = isScar
      ? `veribrain promote ${hyp.id} --to scar`
      : `veribrain promote ${hyp.id} --to decided --id DEC-NNN --priority P1 --signed-by "<Human>"`;
    pendingHypotheses.push({
      id: hyp.id,
      kind: hyp.kind ?? "hypothesis",
      expires_at_utc: hyp.expires_at_utc,
      promote_command: promoteCmd,
    });
  }

  // 3. Recent DECIDED edits in window (or superseded)
  const recentDecided: RetroResult["recent_decided"] = [];
  for (const dec of [...brain.decided].sort((a, b) => compareAscii(a.id, b.id))) {
    const signedMs = parseIsoTimestampMs(dec.signed_at_utc) ?? 0;
    if (signedMs >= cutoffMs || dec.status === "superseded") {
      recentDecided.push({
        id: dec.id,
        priority: dec.priority,
        status: dec.status,
        signed_by: dec.signed_by,
        signed_at_utc: dec.signed_at_utc,
      });
    }
  }

  // 4. Render uncapped Markdown report
  const md: string[] = [
    `# VeriBrain Retrospective Report (since: ${since})`,
    "",
    `- **Environment:** \`${env}\` | **Zone A Layout:** \`${effectiveLayout}\` | **Strict Eval:** ${evalRes.ok ? "PASS (exit 0)" : `FAIL (exit ${evalRes.exitCode})`}`,
    `- **Counts:** decided=${evalRes.counts.decided}, observed=${evalRes.counts.observed}, hypotheses=${evalRes.counts.hypotheses}, scars=${evalRes.counts.scars} (${evalRes.counts.scarsBytes}/${MAX_SCARS_BYTES} B)`,
    "",
    "## 1. Strict Eval Issues",
  ];
  if (evalRes.issues.length === 0) {
    md.push("_None - `veribrain eval --strict` passed cleanly._");
  } else {
    for (const issue of evalRes.issues) {
      md.push(`- **${issue.claimId}** (\`${issue.rule}\`): ${issue.detail} - _Fix:_ ${issue.fix}`);
    }
  }

  md.push(
    "",
    `## 2. KV-Cache Floor Audit (>= ${KV_CACHE_MIN_FLOOR_TOKENS} est. tokens)`,
    "",
    "| Role | Layout | Zone A0 Tok | Zone A Tok | Zone A0 SHA (12) | Floor |",
    "| :--- | :--- | ---: | ---: | :--- | :---: |",
  );
  for (const row of roleFloorAudit) {
    md.push(
      `| ${row.role} | ${row.zone_a_layout} | ${row.zone_a0_tokens_est} | ${row.zone_a_tokens_est} | \`${row.zone_a0_sha256.slice(0, 12)}\` | ${row.meets_floor ? "OK" : "BELOW_FLOOR"} |`,
    );
  }

  md.push("", "## 3. Expired & Expiring-Within-48h Claims");
  if (expiringItems.length === 0) {
    md.push("_No expired or expiring-within-48h claims._");
  } else {
    for (const item of expiringItems) {
      md.push(
        `- [${item.tier}] **${item.id}** (${item.status}, expires \`${item.expires_at_utc}\`): ${item.detail}`,
      );
    }
  }

  md.push(
    "",
    `## 4. Scars Budget & Regression-Test Audit (${evalRes.counts.scarsBytes}/${MAX_SCARS_BYTES} B)`,
  );
  if (scarChecks.length === 0) {
    md.push("_No active scars in `.brain/scars.md`._");
  } else {
    md.push(
      "",
      "| Scar ID | Regression Test | On Disk | Expires UTC | Status |",
      "| :--- | :--- | :---: | :--- | :---: |",
    );
    for (const sc of scarChecks) {
      md.push(
        `| ${sc.scar_id} | \`${sc.regression_test}\` | ${sc.test_exists ? "YES" : "MISSING"} | ${sc.expires_at_utc} | ${sc.expired ? "EXPIRED" : "ACTIVE"} |`,
      );
    }
  }

  md.push("", `## 5. Recent DECIDED Rules (window: ${since})`);
  if (recentDecided.length === 0) {
    md.push("_No DECIDED edits in window._");
  } else {
    for (const d of recentDecided) {
      md.push(
        `- **${d.id}** (${d.priority}, ${d.status}, signed \`${d.signed_at_utc}\` by ${d.signed_by})`,
      );
    }
  }

  md.push("", "## 6. Pending Hypotheses & Promotion Commands");
  if (pendingHypotheses.length === 0) {
    md.push("_No pending hypotheses._");
  } else {
    for (const h of pendingHypotheses) {
      md.push(
        `- **${h.id}** (\`${h.kind}\`, expires \`${h.expires_at_utc}\`): \`${h.promote_command}\``,
      );
    }
  }

  const markdown = `${md.join("\n")}\n`;
  assertQuarantineClean(markdown, { claimId: "retro", config: config.quarantine });

  return {
    since,
    env,
    zone_a_layout: effectiveLayout,
    eval_ok: evalRes.ok,
    eval_exit_code: evalRes.exitCode,
    counts: {
      decided: evalRes.counts.decided,
      observed: evalRes.counts.observed,
      hypotheses: evalRes.counts.hypotheses,
      scars: evalRes.counts.scars,
      scars_bytes: evalRes.counts.scarsBytes,
      scars_max_bytes: MAX_SCARS_BYTES,
    },
    eval_issues: evalRes.issues,
    role_floor_audit: roleFloorAudit,
    expiring_items: expiringItems,
    scar_checks: scarChecks,
    recent_decided: recentDecided,
    pending_hypotheses: pendingHypotheses,
    markdown,
  };
}
