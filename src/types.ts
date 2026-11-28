export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_QUARANTINE_VIOLATION = 2;
export const EXIT_BUDGET_INFEASIBLE = 3;
export const EXIT_PROVENANCE_VIOLATION = 4;
export const EXIT_PROVENANCE = EXIT_PROVENANCE_VIOLATION;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_ERROR
  | typeof EXIT_QUARANTINE_VIOLATION
  | typeof EXIT_BUDGET_INFEASIBLE
  | typeof EXIT_PROVENANCE_VIOLATION;

export const SCHEMA_VERSION = "1.0" as const;
export const VALID_SCHEMA_VERSIONS = ["1.0", "1.1"] as const;
export type SchemaVersion = (typeof VALID_SCHEMA_VERSIONS)[number];
export const ESTIMATOR_VERSION = "utf8-3.5x1.15-v1" as const;
export const ZONE_BOUNDARY_MARKER = "<!-- VERIBRAIN:ZONE_BOUNDARY:A_END -->" as const;
export const ZONE_A0_BOUNDARY_MARKER = "<!-- VERIBRAIN:ZONE_BOUNDARY:A0_END -->" as const;

export const VALID_ZONE_A_LAYOUTS = ["legacy", "split"] as const;
export type ZoneALayout = (typeof VALID_ZONE_A_LAYOUTS)[number];

export const VALID_OBSERVED_TTL_MODES = ["sha-pinned", "env-ttl"] as const;
export type ObservedTtlMode = (typeof VALID_OBSERVED_TTL_MODES)[number];

export const DEFAULT_CHARS_PER_TOKEN = 3.5;
export const DEFAULT_SAFETY_MARGIN = 1.15;
export const DEFAULT_MAX_TOKENS = 8192;
export const MAX_SCARS_BYTES = 4096;
export const MAX_SCAR_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MAX_HYPOTHESIS_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MAX_OBSERVED_TTL_SECONDS = 2_592_000;
export const MAX_ENV_TTL_SECONDS = 7 * 24 * 60 * 60;
export const KV_CACHE_MIN_FLOOR_TOKENS = 1024;
export const DEFAULT_METRICS_MAX_BYTES = 2_097_152;
export const MIN_METRICS_MAX_BYTES = 1024;
export const MAX_METRICS_MAX_BYTES = 10_485_760;

export const VALID_METRIC_SOURCES = ["cli", "mcp"] as const;
export type MetricSource = (typeof VALID_METRIC_SOURCES)[number];

export const VALID_PRIORITIES = ["P0", "P1", "P2"] as const;
export type Priority = (typeof VALID_PRIORITIES)[number];

export const VALID_ENVS = ["local", "pre-staging", "staging", "prod"] as const;
export type EnvName = (typeof VALID_ENVS)[number];

export const VALID_ISSUERS = ["ci", "git-hook", "verifier-script"] as const;
export type Issuer = (typeof VALID_ISSUERS)[number];

export const VALID_DECIDED_STATUSES = ["active", "superseded"] as const;
export type DecidedStatus = (typeof VALID_DECIDED_STATUSES)[number];

export type HintSource = "scar" | "hypothesis";

export type QuarantineRuleId =
  | "gcp_api_key"
  | "jwt"
  | "bearer"
  | "pem_private"
  | "provider_token"
  | "oauth_kv"
  | "pii_email"
  | "pii_phone"
  | "high_entropy_secret";

export interface QuarantineConfig {
  allowed_emails: string[];
  allowed_domains: string[];
  allowed_phones: string[];
}

export interface MetricsConfig {
  enabled: boolean;
  baseline_paths?: string[];
  max_bytes?: number;
}

export interface BrainConfig {
  schema_version: SchemaVersion;
  estimator_version: string;
  chars_per_token: number;
  safety_margin: number;
  default_max_tokens: number;
  pinned_ids: string[];
  quarantine: QuarantineConfig;
  semantic_keys?: Record<string, string | number | boolean>;
  mirror_dirs?: string[];
  zone_a_layout?: ZoneALayout;
  metrics?: MetricsConfig;
}

export interface DecidedRecord {
  id: string;
  priority: Priority;
  roles: string[];
  signed_by: string;
  signed_at_utc: string;
  sha256_body: string;
  status: DecidedStatus;
  body: string;
  envs?: string[];
  title?: string;
  supersedes?: string;
  source_file: string;
}

export interface ObservedRecord {
  claim_id: string;
  env: EnvName;
  git_sha: string;
  observed_at_utc: string;
  ttl_seconds: number;
  ttl_mode?: ObservedTtlMode;
  issuer: Issuer;
  roles: string[];
  summary: string;
  evidence_ref: string;
  priority: Priority;
  source_file: string;
}

export interface HypothesisRecord {
  id: string;
  created_at_utc: string;
  expires_at_utc: string;
  roles: string[];
  proposed_by: string;
  hint: string;
  kind?: "hypothesis" | "scar_proposal" | "hypothesis_scar";
  regression_test?: string;
  proposed_ttl_days?: number;
  source_file: string;
}

export interface ScarRecord {
  scar_id: string;
  created_at_utc: string;
  expires_at_utc: string;
  regression_test: string;
  hint: string;
  roles: string[];
  line_number: number;
}

export interface LoadedBrain {
  brainDir: string;
  repoRoot: string;
  config: BrainConfig;
  decided: DecidedRecord[];
  observed: ObservedRecord[];
  hypotheses: HypothesisRecord[];
  scars: ScarRecord[];
  scarsBytes: number;
}

export interface CompileOptions {
  role: string;
  env: EnvName;
  gitSha?: string;
  maxTokens?: number;
  zoneALayout?: ZoneALayout;
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
  bypassReadCache?: boolean;
  allowWorktreeFallback?: boolean;
  recordMetrics?: boolean;
  metricSource?: MetricSource;
  envVars?: NodeJS.ProcessEnv;
}

export interface CompileResult {
  schema_version: SchemaVersion;
  estimator_version: string;
  chars_per_token: number;
  safety_margin: number;
  role: string;
  env: EnvName;
  git_sha: string | null;
  zone_a_layout: ZoneALayout;
  zone_a: string;
  zone_a0: string;
  zone_a1: string;
  zone_b: string;
  zone_a_sha256: string;
  zone_a0_sha256: string;
  semantic_hash: string;
  zone_a_bytes: number;
  zone_a0_bytes: number;
  zone_a1_bytes: number;
  zone_b_bytes: number;
  zone_a_tokens_est: number;
  zone_a0_tokens_est: number;
  zone_a1_tokens_est: number;
  zone_b_tokens_est: number;
  total_tokens_est: number;
  max_tokens: number;
  compile_ms: number;
  included_decided_ids: string[];
  included_observed_ids: string[];
  evicted_ids: string[];
  excluded_stale_ids: string[];
  kv_cache_floor_advisory: string | null;
}

export interface InitOptions {
  brainDir?: string;
  repoRoot?: string;
  signedBy?: string;
  now?: Date;
  envVars?: NodeJS.ProcessEnv;
}

export interface InitResult {
  brainDir: string;
  created: string[];
  skipped: string[];
}

export interface ObserveOptions {
  claimId: string;
  env: EnvName;
  gitSha: string;
  ttlSeconds: number;
  ttlMode?: ObservedTtlMode;
  summary: string;
  evidenceRef: string;
  issuer: string;
  roles?: string[];
  priority?: Priority;
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
  envVars?: NodeJS.ProcessEnv;
}

export interface ObserveResult {
  record: ObservedRecord;
  filePath: string;
}

export interface EvalIssue {
  claimId: string;
  rule: string;
  detail: string;
  fix: string;
  exitCode: ExitCode;
  line?: number;
}

export interface EvalOptions {
  strict?: boolean;
  checkMirror?: boolean;
  mirrorDirs?: string[];
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
  bypassReadCache?: boolean;
}

export interface EvalResult {
  ok: boolean;
  exitCode: ExitCode;
  issues: EvalIssue[];
  counts: {
    decided: number;
    observed: number;
    hypotheses: number;
    scars: number;
    scarsBytes: number;
  };
}

export interface DiffOptions {
  since?: string;
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
}

export type DiffCategory = "scar" | "hypothesis" | "observed" | "decided";

export interface DiffItem {
  category: DiffCategory;
  rank: number;
  id: string;
  summary: string;
}

export interface DiffResult {
  since: string;
  items: DiffItem[];
  totalCount: number;
  rendered: string;
}

export interface DecideOptions {
  id: string;
  priority: Priority;
  signedBy: string;
  roles?: string[];
  envs?: string[];
  title?: string;
  supersedes?: string;
  body?: string;
  file?: string;
  issuer?: string;
  mirrorDirs?: string[];
  dryRun?: boolean;
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
  envVars?: NodeJS.ProcessEnv;
}

export interface DecideResult {
  id: string;
  filePath: string;
  sha256_body: string;
  signedBy: string;
  mirroredTo: string[];
  dryRun: boolean;
  content: string;
}

export interface SignOptions {
  filePath: string;
  signedBy?: string;
  issuer?: string;
  mirrorDirs?: string[];
  dryRun?: boolean;
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
  envVars?: NodeJS.ProcessEnv;
}

export interface SignResult {
  id: string;
  filePath: string;
  signedBy: string;
  sha256_body: string;
  mirroredTo: string[];
  dryRun: boolean;
  content: string;
}

export interface PromoteOptions {
  hypId: string;
  to?: "scar" | "decided";
  id?: string;
  priority?: Priority;
  roles?: string[];
  envs?: string[];
  signedBy?: string;
  title?: string;
  regressionTest?: string;
  issuer?: string;
  mirrorDirs?: string[];
  dryRun?: boolean;
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
  envVars?: NodeJS.ProcessEnv;
}

export interface PromoteResult {
  hypId: string;
  promotedTo: "scar" | "decided";
  promotedId: string;
  targetPath: string;
  mirroredTo: string[];
  dryRun: boolean;
  removedHypothesis: boolean;
}

export interface LintTextOptions {
  filePath: string;
  brainDir?: string;
  repoRoot?: string;
}

export interface LintTextMatch {
  line: number;
  rule: QuarantineRuleId;
  detail: string;
  fix: string;
}

export interface LintTextResult {
  file: string;
  clean: boolean;
  matchCount: number;
  matches: LintTextMatch[];
}

export interface HooksInstallOptions {
  repoRoot?: string;
  force?: boolean;
  printCi?: boolean;
}

export interface HooksInstallResult {
  hooksDir: string | null;
  installed: string[];
  skipped: string[];
  ciYaml?: string;
}

export interface AttestTestOptions {
  argv?: string[];
  cmd?: string;
  args?: string[];
  claimId?: string;
  env?: EnvName;
  gitSha?: string;
  ttlSeconds?: number;
  ttlMode?: ObservedTtlMode;
  roles?: string[];
  priority?: Priority;
  timeoutMs?: number;
  dryRun?: boolean;
  recordFailure?: boolean;
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
  envVars?: NodeJS.ProcessEnv;
}

export interface AttestTestResult {
  claim_id: string;
  passed: boolean;
  exit_code: number;
  timed_out: boolean;
  duration_ms: number;
  env: EnvName;
  git_sha: string;
  ttl_seconds: number;
  ttl_mode: ObservedTtlMode;
  command: string;
  output_sha256: string;
  git_diff_stat_sha256: string;
  evidence_ref: string;
  summary: string;
  recorded: boolean;
  dry_run: boolean;
  file_path: string | null;
}

export type CitationIssueKind =
  | "missing_decided"
  | "superseded_decided"
  | "missing_observed"
  | "expired_observed";

export interface CitationIssue {
  file: string;
  line: number;
  claim_id: string;
  kind: CitationIssueKind;
  detail: string;
  replacement_id?: string;
}

export interface CheckCitationsOptions {
  paths?: string[];
  includeCodeBlocks?: boolean;
  decidedOnly?: boolean;
  ignoreIds?: string[];
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
}

export interface CheckCitationsResult {
  ok: boolean;
  files_scanned: number;
  citations_checked: number;
  issues: CitationIssue[];
  rendered: string;
}

export interface RetroRoleFloorAudit {
  role: string;
  zone_a_layout: ZoneALayout;
  zone_a_tokens_est: number;
  zone_a0_tokens_est: number;
  zone_a_sha256: string;
  zone_a0_sha256: string;
  meets_floor: boolean;
}

export interface RetroExpiringItem {
  tier: "OBSERVED" | "SCAR" | "HYPOTHESIS";
  id: string;
  expires_at_utc: string;
  status: "expired" | "expiring_48h";
  detail: string;
}

export interface RetroScarCheck {
  scar_id: string;
  regression_test: string;
  test_exists: boolean;
  expires_at_utc: string;
  expired: boolean;
}

export interface RetroOptions {
  since?: string;
  env?: EnvName;
  zoneALayout?: ZoneALayout;
  roles?: string[];
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
}

export interface RetroResult {
  since: string;
  env: EnvName;
  zone_a_layout: ZoneALayout;
  eval_ok: boolean;
  eval_exit_code: ExitCode;
  counts: {
    decided: number;
    observed: number;
    hypotheses: number;
    scars: number;
    scars_bytes: number;
    scars_max_bytes: number;
  };
  eval_issues: EvalIssue[];
  role_floor_audit: RetroRoleFloorAudit[];
  expiring_items: RetroExpiringItem[];
  scar_checks: RetroScarCheck[];
  recent_decided: Array<{
    id: string;
    priority: Priority;
    status: DecidedStatus;
    signed_by: string;
    signed_at_utc: string;
  }>;
  pending_hypotheses: Array<{
    id: string;
    kind: string;
    expires_at_utc: string;
    promote_command: string;
  }>;
  markdown: string;
}

export interface CompileMetricEvent {
  ts: string;
  source: MetricSource;
  role: string;
  env: string;
  layout: ZoneALayout;
  zone_a0_sha256: string;
  zone_a_sha256: string;
  zone_a0_tokens: number;
  zone_a_tokens: number;
  zone_b_tokens: number;
  total_tokens: number;
  compile_ms: number;
}

export type StatsFormat = "text" | "md" | "json";

export interface StatsOptions {
  since?: string;
  baselinePaths?: string[];
  format?: StatsFormat;
  enable?: boolean;
  disable?: boolean;
  reset?: boolean;
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
  envVars?: NodeJS.ProcessEnv;
}

export interface StatsResult {
  enabled: boolean;
  since: string;
  action?: "enabled" | "disabled" | "reset";
  compiles_total: number;
  cli_compiles: number;
  mcp_compiles: number;
  zone_a0_eligible_compiles: number;
  zone_a0_repeat_hits: number;
  zone_a0_cross_role_hits: number;
  zone_a0_cacheable_tokens_reused: number;
  estimated_cache_discount_tokens_at_90pct: number;
  avg_zone_a0_tokens: number;
  avg_zone_a_tokens: number;
  avg_zone_b_tokens: number;
  avg_total_tokens: number;
  avg_compile_ms: number;
  baseline_paths_used: string[];
  baseline_docs_files: number;
  baseline_docs_bytes: number;
  baseline_docs_tokens_est: number;
  tokens_avoided_vs_baseline_docs: number;
  compression_ratio_pct: number;
  skipped_corrupt_lines: number;
  methodology_note: string;
}

export type DoctorCheckStatus = "PASS" | "WARN" | "FAIL" | "INFO";
export type DoctorFormat = "text" | "md" | "json";
export type DoctorMaturityLevel = "L0" | "L1" | "L2" | "L3" | "L4";
export type DoctorCheckTier = "brain" | "eval" | "tier1" | "tier2" | "tier3" | "telemetry";

export type DoctorCheckId =
  | "brain.present"
  | "eval.strict"
  | "tier1.decided"
  | "zone_a0.floor"
  | "tier2.observed"
  | "tier3.scars"
  | "tier3.hypotheses"
  | "telemetry.stats";

export interface DoctorCheck {
  id: DoctorCheckId;
  tier: DoctorCheckTier;
  status: DoctorCheckStatus;
  summary: string;
  fix: string[];
}

export interface DoctorOptions {
  format?: DoctorFormat;
  role?: string;
  env?: EnvName;
  strict?: boolean;
  brainDir?: string;
  repoRoot?: string;
  now?: Date;
  envVars?: NodeJS.ProcessEnv;
}

export interface DoctorResult {
  ok: boolean;
  exit_code: ExitCode;
  strict: boolean;
  role: string;
  env: EnvName;
  maturity: {
    level: DoctorMaturityLevel;
    score: 0 | 1 | 2 | 3 | 4;
    label: string;
  };
  counts: {
    pass: number;
    warn: number;
    fail: number;
    info: number;
  };
  checks: DoctorCheck[];
}

export interface VeriBrainErrorInit {
  exitCode: ExitCode;
  code: string;
  claimId: string;
  rule: string;
  detail: string;
  fix: string;
  line?: number;
}

export class VeriBrainError extends Error {
  public readonly exitCode: ExitCode;
  public readonly code: string;
  public readonly claimId: string;
  public readonly rule: string;
  public readonly detail: string;
  public readonly fix: string;
  public readonly line?: number;

  public constructor(init: VeriBrainErrorInit) {
    super(`${init.code}: ${init.claimId} (${init.rule}) - ${init.detail}`);
    this.name = "VeriBrainError";
    this.exitCode = init.exitCode;
    this.code = init.code;
    this.claimId = init.claimId;
    this.rule = init.rule;
    this.detail = init.detail;
    this.fix = init.fix;
    if (init.line !== undefined) {
      this.line = init.line;
    }
  }
}

export function priorityRank(priority: Priority): number {
  switch (priority) {
    case "P0":
      return 0;
    case "P1":
      return 1;
    case "P2":
      return 2;
  }
}
