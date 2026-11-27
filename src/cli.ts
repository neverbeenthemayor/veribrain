#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attestTest } from "./commands/attest-test.js";
import { checkCitations } from "./commands/check-citations.js";
import { decideRule, signDecidedFile } from "./commands/decide.js";
import { generateBrainDiff } from "./commands/diff.js";
import { evaluateBrain } from "./commands/eval.js";
import { installGitHooks } from "./commands/hooks.js";
import { initBrain } from "./commands/init.js";
import { lintTextFile } from "./commands/lint-text.js";
import { printMcpClientConfig } from "./commands/mcp.js";
import { writeObservation } from "./commands/observe.js";
import { promoteHypothesis } from "./commands/promote.js";
import { generateRetroReport } from "./commands/retro.js";
import { formatStatsMarkdown, formatStatsText, runStats } from "./commands/stats.js";
import { compileContext, formatCompiledMarkdown } from "./compiler.js";
import { truncateAscii, wrapAsciiLines } from "./normalize.js";
import { scanTextForQuarantine } from "./quarantine.js";
import {
  INVALID_ENV_FIX_HINT,
  isAgentEnvironment,
  isValidEnv,
  isValidObservedTtlMode,
  isValidPriority,
  isValidZoneALayout,
} from "./schema.js";
import {
  type AttestTestOptions,
  type CheckCitationsOptions,
  type CompileOptions,
  type DecideOptions,
  type DiffOptions,
  type EnvName,
  type EvalIssue,
  type EvalOptions,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_PROVENANCE_VIOLATION,
  EXIT_QUARANTINE_VIOLATION,
  type ExitCode,
  type HooksInstallOptions,
  type InitOptions,
  type LintTextOptions,
  type ObservedTtlMode,
  type ObserveOptions,
  type Priority,
  type PromoteOptions,
  type RetroOptions,
  type SignOptions,
  type StatsFormat,
  type StatsOptions,
  VeriBrainError,
  type ZoneALayout,
} from "./types.js";

const CLI_VERSION = "1.3.0";
const MAX_COLS = 80;

const HELP_TEXT = [
  `veribrain v${CLI_VERSION} - Deterministic provenance-verified context compiler`,
  "Usage: veribrain <command> [options]   (use `<cmd> --help` for flags)",
  "",
  "Commands:",
  "  init             Scaffold .brain/ store [--signed-by <human>]",
  "  compile          Build Zone A/A0+A1 + Zone B [--role --env --zone-a-layout]",
  "  observe          Record CI/hook fact [--claim-id --env --ttl-mode ...]",
  "  attest-test      Run test command & emit OBS-VERIFY-* [-- <cmd> | --cmd]",
  "  decide / sign    Author or re-sign DEC-* rules & sync mirrors (human)",
  "  promote          Promote HYP-* to scars.md or DEC-* [--to scar|decided]",
  "  eval             Run $0 schema, quarantine & mirror checks [--strict]",
  "  check-citations  Audit docs for missing/superseded DEC-*/OBS-* citations",
  "  diff / retro     Weekly 1-screen diff or uncapped retro digest [--since 7d]",
  "  stats            Local $0 ROI & token-savings telemetry [--since 30d]",
  "  lint-text        Dry-run quarantine check on any file [--format text|json]",
  "  hooks            Install Git hooks or print CI YAML [install --print-ci]",
  "  mcp              Run stdio MCP server (7 tools) [--print-config <client>]",
  "",
  "Options: --brain-dir/--brain <p> | --repo-root <p> | --help | --version",
  "Exits:   0 ok | 1 error/eval | 2 quarantine | 3 budget | 4 provenance",
  "",
].join("\n");

const SUBCOMMAND_HELP: Record<string, string> = {
  init: [
    "Usage: veribrain init [options]",
    "",
    "Scaffold typed .brain/ store (config.json, decided/, observed/, scars.md).",
    "",
    "Options:",
    "  --signed-by <human>  Human owner name to create starter DEC-001",
    "  --brain-dir <path>   Target .brain directory (default: .brain)",
    "  --repo-root <path>   Repository root path (default: cwd)",
    "",
  ].join("\n"),
  compile: [
    "Usage: veribrain compile --role <r> --env <e> [options]",
    "",
    "Compile byte-frozen Zone A/A0+A1 prefix + uncached Zone B cited tail.",
    "",
    "Required:",
    "  --role <role>         Target role id (^[A-Za-z0-9._-]{1,64}$)",
    "  --env <env>           local | pre-staging | staging | prod",
    "Optional:",
    "  --git-sha <hex|HEAD>  Filter observed facts by 7-40 hex SHA or HEAD",
    "  --max-tokens <n>      Token cap (fail closed exit 3 if infeasible)",
    "  --zone-a-layout <m>   legacy | split (Zone A0 shared + Zone A1 delta)",
    "  --format <md|json>    Output format (default: md)",
    "",
  ].join("\n"),
  observe: [
    "Usage: veribrain observe --claim-id <id> --env <e> --git-sha <hex>",
    "                         --ttl <sec> --summary <txt> --evidence <ref>",
    "                         --issuer <ci|git-hook|verifier-script>",
    "",
    "  --claim-id <OBS-*>    Observation identifier (OBS-*)",
    "  --env <env>           local | pre-staging | staging | prod",
    "  --git-sha <hex|HEAD>  Commit hash (7-40 hex chars or HEAD)",
    "  --ttl <sec>           TTL seconds (1..2592000; <= 604800 for env-ttl)",
    "  --ttl-mode <mode>     sha-pinned (default) | env-ttl",
    "  --summary <text>      Factual summary (quarantine-scanned)",
    "  --evidence <ref>      Verifiable CI/hook evidence ref",
    "  --issuer <issuer>     ci | git-hook | verifier-script (agents denied)",
    "",
  ].join("\n"),
  "attest-test": [
    "Usage: veribrain attest-test [options] -- <executable> [args...]",
    "       veribrain attest-test --cmd <cmd> [--arg <val>...] [options]",
    "",
    "Run test command (shell: false) and emit Tier 2 OBS-VERIFY-* receipt.",
    "",
    "Options:",
    "  --claim-id <OBS-*>    OBS-VERIFY-* id (default: auto-generated)",
    "  --env <env>           local (default) | pre-staging | staging | prod",
    "  --git-sha <hex|HEAD>  Commit SHA (default: HEAD); --ttl <sec>",
    "  --ttl-mode <mode>     sha-pinned (default) | env-ttl; --timeout <ms>",
    "  --record-failure      Record OBS-VERIFY-* even on non-zero exit",
    "  --dry-run             Run command without writing; --format text|json",
    "",
  ].join("\n"),
  decide: [
    "Usage: veribrain decide --id <DEC-*> --priority <P0|P1|P2>",
    "                        --signed-by <human> (--file <md> | --body <txt>)",
    "",
    "Author, hash, quarantine-scan, and sign a Tier 1 DECIDED rule (human only).",
    "",
    "Options:",
    "  --roles <csv>         Target roles (default: *)",
    "  --envs <csv>          Target envs (default: *)",
    "  --title <text>        Optional rule title; --supersedes <DEC-*>",
    "  --mirror-dir <dir>    Repeatable mirror root; --dry-run (no writes)",
    "",
  ].join("\n"),
  sign: [
    "Usage: veribrain sign <path> [--signed-by <human>] [options]",
    "",
    "Normalize LF, recompute sha256_body, quarantine-check, and sync mirrors.",
    "",
    "Options:",
    "  --signed-by <human>   Override human signer (agents denied exit 4)",
    "  --mirror-dir <dir>    Repeatable mirror root to sync",
    "  --dry-run             Validate without writing files",
    "",
  ].join("\n"),
  promote: [
    "Usage: veribrain promote <HYP-ID> [--to scar|decided] [options]",
    "",
    "Human-only promotion of .brain/hypotheses/<HYP-ID>.json + eval --strict.",
    "",
    "Options:",
    "  --to <scar|decided>   Target tier (auto-detects scar proposals)",
    "  --id <SCAR-*|DEC-*>   Target ID (required for --to decided)",
    "  --priority <P0|P1|P2> Priority (required for --to decided)",
    "  --signed-by <human>   Human signer (required for --to decided)",
    "  --regression-test <p> Override repo-relative test path for scars",
    "  --mirror-dir <dir>    Repeatable mirror root; --dry-run (no writes)",
    "",
  ].join("\n"),
  eval: [
    "Usage: veribrain eval [--strict] [--check-mirror] [options]",
    "",
    "Run $0 provenance, schema, quarantine, mirror, and scars budget checks.",
    "",
    "Options:",
    "  --strict              Fail on expired claims & missing test files",
    "  --check-mirror        Verify byte-for-byte SHA-256 mirror parity",
    "  --mirror-dir <dir>    Additional mirror directory (repeatable)",
    "  --brain-dir <path>    Path to .brain directory (default: .brain)",
    "",
  ].join("\n"),
  "check-citations": [
    "Usage: veribrain check-citations [options]",
    "",
    "Audit repo Markdown docs for missing, superseded, or expired citations.",
    "",
    "Options:",
    "  --paths <csv>         Explicit repo-relative files to scan",
    "  --decided-only        Check DEC-* citations only (skip OBS-*)",
    "  --include-code-blocks Include fenced code blocks in citation scan",
    "  --ignore-ids <csv>    Comma-separated claim IDs to ignore",
    "  --format <text|json>  Output format (default: text; exits 1 on drift)",
    "  --brain-dir <path>    Path to .brain directory (default: .brain)",
    "",
  ].join("\n"),
  diff: [
    "Usage: veribrain diff [--since <window>] [options]",
    "",
    "Render <= 5-bullet, <= 25-line secret-scrubbed weekly review digest.",
    "",
    "Options:",
    "  --since <Nd|Nh>       Lookback window (default: 7d)",
    "  --brain-dir <path>    Path to .brain directory (default: .brain)",
    "  --repo-root <path>    Repository root path (default: cwd)",
    "",
  ].join("\n"),
  retro: [
    "Usage: veribrain retro [--since <window>] [--format md|json] [options]",
    "",
    "Generate uncapped weekly retro digest (eval, KV floor, expiry, scars).",
    "",
    "Options:",
    "  --since <Nd|Nh>       Lookback window (default: 7d)",
    "  --env <env>           local (default) | pre-staging | staging | prod",
    "  --zone-a-layout <m>   legacy | split (A0+A1 constitutional split)",
    "  --format <md|json>    Output format (default: md)",
    "  --brain-dir <path>    Path to .brain directory (default: .brain)",
    "",
  ].join("\n"),
  stats: [
    "Usage: veribrain stats [options]",
    "",
    "Report local $0 compile telemetry, Zone A0 cache reuse & doc compression.",
    "",
    "Options:",
    "  --since <window>        30d (default) | 7d | 24h | all",
    "  --baseline-paths <csv>  Repo-relative docs for token comparison",
    "  --format <fmt>          text (default) | md | json",
    "  --enable | --disable    Toggle opt-in telemetry in config.json (human)",
    "  --reset                 Delete .brain/.metrics.jsonl (human only)",
    "  --brain-dir <path>      Path to .brain directory (default: .brain)",
    "",
  ].join("\n"),
  "lint-text": [
    "Usage: veribrain lint-text <file> [--format text|json]",
    "",
    "Dry-run quarantine explainer listing rule matches without mutating .brain/.",
    "",
    "Options:",
    "  --format <text|json>  Output format (default: text; exits 2 on matches)",
    "  --brain-dir <path>    Optional .brain dir for quarantine whitelist",
    "",
  ].join("\n"),
  hooks: [
    "Usage: veribrain hooks install [--force] [--print-ci]",
    "",
    "Install portable POSIX pre-commit/post-checkout/post-merge Git hooks.",
    "",
    "Options:",
    "  --force               Overwrite non-VeriBrain existing hooks",
    "  --print-ci            Print $0 GitHub Actions YAML snippet to stdout",
    "  --repo-root <path>    Repository or worktree root path (default: cwd)",
    "",
  ].join("\n"),
  mcp: [
    "Usage: veribrain mcp [options]",
    "",
    "Start local stdio MCP server (7 tools; zero stdout logging).",
    "",
    "Options:",
    "  --print-config <cli>  antigravity | claude-code | cursor | codex",
    "  --brain-dir <path>    Path to .brain directory (default: .brain)",
    "  --repo-root <path>    Repository root path (default: cwd)",
    "",
  ].join("\n"),
};

export interface CliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  env?: NodeJS.ProcessEnv;
}

interface ParsedArgs {
  command: string | null;
  positionals: string[];
  passthroughArgs: string[];
  flags: Map<string, string | boolean>;
  multiFlags: Map<string, string[]>;
}

const VALUE_FLAGS = new Set([
  "brain-dir",
  "brain",
  "repo-root",
  "signed-by",
  "role",
  "env",
  "envs",
  "git-sha",
  "max-tokens",
  "zone-a-layout",
  "format",
  "claim-id",
  "id",
  "title",
  "supersedes",
  "file",
  "body",
  "to",
  "regression-test",
  "mirror-dir",
  "ttl",
  "ttl-mode",
  "cmd",
  "arg",
  "timeout",
  "paths",
  "baseline-paths",
  "ignore-ids",
  "summary",
  "evidence",
  "issuer",
  "roles",
  "priority",
  "since",
  "print-config",
]);

const REPEATABLE_FLAGS = new Set(["mirror-dir", "arg"]);

const BOOLEAN_FLAGS = new Set([
  "strict",
  "help",
  "version",
  "dry-run",
  "check-mirror",
  "force",
  "print-ci",
  "record-failure",
  "include-code-blocks",
  "decided-only",
  "enable",
  "disable",
  "reset",
]);

const COMMANDS_WITH_POSITIONAL = new Set(["sign", "promote", "lint-text", "hooks"]);

function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let command: string | null = null;
  const positionals: string[] = [];
  const passthroughArgs: string[] = [];
  const flags = new Map<string, string | boolean>();
  const multiFlags = new Map<string, string[]>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--") {
      passthroughArgs.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (arg === "-v") {
      flags.set("version", true);
      continue;
    }
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      const rawName = eqIdx === -1 ? arg.slice(2) : arg.slice(2, eqIdx);
      const name = rawName === "brain" ? "brain-dir" : rawName;
      if (BOOLEAN_FLAGS.has(name)) {
        if (eqIdx !== -1) {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: command ?? "cli",
            rule: "unexpected_flag_value",
            detail: `Flag --${rawName} does not accept a value.`,
            fix: `Pass --${rawName} without =value.`,
          });
        }
        flags.set(name, true);
        continue;
      }
      if (!VALUE_FLAGS.has(rawName)) {
        throw new VeriBrainError({
          exitCode: EXIT_ERROR,
          code: "CLI_ERROR",
          claimId: command ?? "cli",
          rule: "unknown_flag",
          detail: `Unknown option --${rawName}.`,
          fix: "Run veribrain --help to see supported options.",
        });
      }
      let value: string;
      if (eqIdx !== -1) {
        value = arg.slice(eqIdx + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: command ?? "cli",
            rule: "missing_flag_value",
            detail: `Option --${rawName} requires a value.`,
            fix: `Provide a value after --${rawName}.`,
          });
        }
        value = next;
        i += 1;
      }
      if (REPEATABLE_FLAGS.has(name)) {
        const existing = multiFlags.get(name) ?? [];
        existing.push(value);
        multiFlags.set(name, existing);
      } else {
        flags.set(name, value);
      }
      continue;
    }

    if (command === null) {
      command = arg;
    } else if (COMMANDS_WITH_POSITIONAL.has(command) && positionals.length === 0) {
      positionals.push(arg);
    } else {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: command,
        rule: "unexpected_positional_arg",
        detail: `Unexpected positional argument "${arg}".`,
        fix: "Run veribrain --help to check command syntax.",
      });
    }
  }

  return { command, positionals, passthroughArgs, flags, multiFlags };
}

function getMultiFlag(
  multiFlags: ReadonlyMap<string, string[]>,
  name: string,
): string[] | undefined {
  const vals = multiFlags.get(name);
  return vals && vals.length > 0 ? vals : undefined;
}

function splitCsvFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function getStringFlag(
  flags: ReadonlyMap<string, string | boolean>,
  name: string,
): string | undefined {
  const val = flags.get(name);
  return typeof val === "string" ? val : undefined;
}

function requireStringFlag(
  flags: ReadonlyMap<string, string | boolean>,
  name: string,
  command: string,
): string {
  const val = getStringFlag(flags, name);
  if (val === undefined || val.trim().length === 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: command,
      rule: `missing_${name.replace(/-/g, "_")}`,
      detail: `Command ${command} requires --${name} <value>.`,
      fix: `Re-run veribrain ${command} --help to view required flags.`,
    });
  }
  return val;
}

function parseStrictPositiveInt(raw: string, flagName: string, command: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: command,
      rule: `invalid_${flagName.replace(/-/g, "_")}`,
      detail: `--${flagName} must be a positive base-10 integer.`,
      fix: `Pass a valid integer to --${flagName}.`,
    });
  }
  const num = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: command,
      rule: `invalid_${flagName.replace(/-/g, "_")}`,
      detail: `--${flagName} must be a positive integer.`,
      fix: `Pass a positive integer to --${flagName}.`,
    });
  }
  return num;
}

function scrubCliField(value: string, fallback: string): string {
  if (scanTextForQuarantine(value, { claimId: "cli", allowHashRefExemption: false }) !== null) {
    return fallback;
  }
  return value;
}

export function formatCliError(err: VeriBrainError): string {
  const safeClaimId = scrubCliField(err.claimId, "<redacted-claim-id>");
  const safeRule = scrubCliField(err.rule, "<redacted-rule>");
  const safeDetail = scrubCliField(
    err.detail,
    "Error detail redacted for safety (sensitive pattern detected).",
  );
  const safeFix = scrubCliField(
    err.fix,
    "Remove sensitive values and re-run veribrain eval --strict.",
  );
  const lines: string[] = [
    ...wrapAsciiLines(`ERROR [EXIT ${err.exitCode}] ${err.code}`, MAX_COLS),
    ...wrapAsciiLines(`claim_id: ${safeClaimId}`, MAX_COLS, "  "),
    ...wrapAsciiLines(`rule: ${safeRule}`, MAX_COLS, "  "),
    ...wrapAsciiLines(`detail: ${safeDetail}`, MAX_COLS, "  "),
    ...wrapAsciiLines(`fix: ${safeFix}`, MAX_COLS, "  "),
  ];
  return `${lines.join("\n")}\n`;
}

function formatEvalIssue(issue: EvalIssue): string {
  const safeClaimId = scrubCliField(issue.claimId, "<redacted-claim-id>");
  const safeRule = scrubCliField(issue.rule, "<redacted-rule>");
  const safeDetail = scrubCliField(
    issue.detail,
    "Issue detail redacted for safety (sensitive pattern detected).",
  );
  const safeFix = scrubCliField(
    issue.fix,
    "Remove sensitive values and re-run veribrain eval --strict.",
  );
  const lines: string[] = [
    ...wrapAsciiLines(`FAIL [EXIT ${issue.exitCode}] ${safeClaimId} (${safeRule})`, MAX_COLS),
    ...wrapAsciiLines(`detail: ${safeDetail}`, MAX_COLS, "  "),
    ...wrapAsciiLines(`fix: ${safeFix}`, MAX_COLS, "  "),
  ];
  return `${lines.join("\n")}\n`;
}

function formatCompileReceipt(
  role: string,
  env: EnvName,
  zoneASha256: string,
  totalTokens: number,
  maxTokens: number,
  evictedCount: number,
  compileMs: number,
): string {
  const msText = `${Math.round(compileMs * 10) / 10}ms`;
  const shaShort = zoneASha256.slice(0, 12);
  const full = `compile ok: ${role}/${env} sha=${shaShort} tok=${totalTokens}/${maxTokens} evicted=${evictedCount} ${msText}`;
  if (full.length <= MAX_COLS) {
    return full;
  }
  const compact = `compile ok: ${env} sha=${shaShort} tok=${totalTokens}/${maxTokens} evicted=${evictedCount} ${msText}`;
  return truncateAscii(compact, MAX_COLS);
}

function peekCliCommand(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--") break;
    if (arg === "-h" || arg === "-v" || arg === "--help" || arg === "--version") continue;
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      const rawName = eqIdx === -1 ? arg.slice(2) : arg.slice(2, eqIdx);
      if (eqIdx === -1 && VALUE_FLAGS.has(rawName)) {
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

export function runCli(argv: readonly string[], customIo?: Partial<CliIo>): ExitCode {
  const io: CliIo = {
    stdout: customIo?.stdout ?? ((chunk) => process.stdout.write(chunk)),
    stderr: customIo?.stderr ?? ((chunk) => process.stderr.write(chunk)),
    env: customIo?.env ?? process.env,
  };

  try {
    const envVars = io.env ?? process.env;
    const dashDashIdx = argv.indexOf("--");
    const preDashArgs = dashDashIdx === -1 ? argv : argv.slice(0, dashDashIdx);
    const hasHelpOrVersion = preDashArgs.some(
      (a) => a === "--help" || a === "-h" || a === "--version" || a === "-v",
    );
    if (
      !hasHelpOrVersion &&
      isAgentEnvironment(envVars) &&
      peekCliCommand(argv) === "attest-test"
    ) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "attest-test",
        rule: "agent_self_attestation_denied",
        detail: "Agents cannot emit Tier 2 OBSERVED verifier receipts via attest-test.",
        fix: "Run veribrain attest-test outside agent mode from CI, hook, or verifier script.",
      });
    }
    const hasStatsMutatorFlag = preDashArgs.some(
      (a) =>
        a === "--enable" ||
        a === "--disable" ||
        a === "--reset" ||
        a.startsWith("--enable=") ||
        a.startsWith("--disable=") ||
        a.startsWith("--reset="),
    );
    if (
      !hasHelpOrVersion &&
      isAgentEnvironment(envVars) &&
      peekCliCommand(argv) === "stats" &&
      hasStatsMutatorFlag
    ) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "stats",
        rule: "agent_mutator_denied",
        detail: "Agents cannot mutate metrics settings or reset .brain/.metrics.jsonl.",
        fix: "Run read-only `veribrain stats` or ask a human to run --enable/--disable/--reset.",
      });
    }

    const { command, positionals, passthroughArgs, flags, multiFlags } = parseCliArgs(argv);

    if (flags.get("help") === true) {
      if (command !== null && SUBCOMMAND_HELP[command] !== undefined) {
        io.stdout(SUBCOMMAND_HELP[command]);
      } else {
        io.stdout(HELP_TEXT);
      }
      return EXIT_OK;
    }

    if (flags.get("version") === true) {
      io.stdout(`veribrain ${CLI_VERSION}\n`);
      return EXIT_OK;
    }

    if (command === null || command === "help") {
      io.stdout(HELP_TEXT);
      return EXIT_OK;
    }

    if (passthroughArgs.length > 0 && command !== "attest-test") {
      throw new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "CLI_ERROR",
        claimId: command,
        rule: "unexpected_positional_arg",
        detail: `Command ${command} does not accept '--' passthrough arguments.`,
        fix: "Use '-- <cmd> [args...]' only with veribrain attest-test.",
      });
    }

    const brainDir = getStringFlag(flags, "brain-dir");
    const repoRoot = getStringFlag(flags, "repo-root");
    const mirrorDirs = getMultiFlag(multiFlags, "mirror-dir");

    switch (command) {
      case "init": {
        const initOpts: InitOptions = {
          envVars,
        };
        if (brainDir !== undefined) initOpts.brainDir = brainDir;
        if (repoRoot !== undefined) initOpts.repoRoot = repoRoot;
        const signedBy = getStringFlag(flags, "signed-by");
        if (signedBy !== undefined) initOpts.signedBy = signedBy;

        const res = initBrain(initOpts);
        const outLines: string[] = [];
        for (const item of res.created) {
          outLines.push(truncateAscii(`  created: ${item}`, MAX_COLS));
        }
        for (const item of res.skipped) {
          outLines.push(truncateAscii(`  skipped: ${item}`, MAX_COLS));
        }
        outLines.push(
          truncateAscii(
            `Initialized .brain/ (${res.created.length} created, ${res.skipped.length} skipped). Next: run veribrain eval.`,
            MAX_COLS,
          ),
        );
        io.stdout(`${outLines.join("\n")}\n`);
        return EXIT_OK;
      }

      case "compile": {
        const role = requireStringFlag(flags, "role", "compile");
        const envRaw = requireStringFlag(flags, "env", "compile");
        if (!isValidEnv(envRaw)) {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: "compile",
            rule: "invalid_env",
            detail: "--env must be local, pre-staging, staging, or prod.",
            fix: INVALID_ENV_FIX_HINT,
          });
        }
        const format = (getStringFlag(flags, "format") ?? "md").trim().toLowerCase();
        if (format !== "md" && format !== "json") {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: "compile",
            rule: "invalid_format",
            detail: "--format must be md or json.",
            fix: "Pass --format md or --format json.",
          });
        }

        const compileOpts: CompileOptions = {
          role,
          env: envRaw as EnvName,
          metricSource: "cli",
          envVars,
        };
        if (brainDir !== undefined) compileOpts.brainDir = brainDir;
        if (repoRoot !== undefined) compileOpts.repoRoot = repoRoot;
        const gitSha = getStringFlag(flags, "git-sha");
        if (gitSha !== undefined) compileOpts.gitSha = gitSha;
        const maxTokensRaw = getStringFlag(flags, "max-tokens");
        if (maxTokensRaw !== undefined) {
          compileOpts.maxTokens = parseStrictPositiveInt(maxTokensRaw, "max-tokens", "compile");
        }
        const layoutRaw = getStringFlag(flags, "zone-a-layout");
        if (layoutRaw !== undefined) {
          if (!isValidZoneALayout(layoutRaw)) {
            throw new VeriBrainError({
              exitCode: EXIT_ERROR,
              code: "CLI_ERROR",
              claimId: "compile",
              rule: "invalid_zone_a_layout",
              detail: "--zone-a-layout must be legacy or split.",
              fix: "Pass --zone-a-layout legacy|split.",
            });
          }
          compileOpts.zoneALayout = layoutRaw as ZoneALayout;
        }

        const result = compileContext(compileOpts);
        if (format === "json") {
          io.stdout(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          io.stdout(formatCompiledMarkdown(result));
        }

        const receipt = formatCompileReceipt(
          result.role,
          result.env,
          result.zone_a_sha256,
          result.total_tokens_est,
          result.max_tokens,
          result.evicted_ids.length,
          result.compile_ms,
        );
        io.stderr(`${receipt}\n`);
        return EXIT_OK;
      }

      case "observe": {
        if (isAgentEnvironment(envVars)) {
          throw new VeriBrainError({
            exitCode: EXIT_PROVENANCE_VIOLATION,
            code: "PROVENANCE_VIOLATION",
            claimId: "observe",
            rule: "agent_self_attestation_denied",
            detail: "Agents cannot write OBSERVED claims (fail-closed provenance).",
            fix: "Run veribrain observe from CI, git hook, or a verifier script.",
          });
        }
        const claimId = requireStringFlag(flags, "claim-id", "observe");
        const envRaw = requireStringFlag(flags, "env", "observe");
        const gitSha = requireStringFlag(flags, "git-sha", "observe");
        const ttlRaw = requireStringFlag(flags, "ttl", "observe");
        const summary = requireStringFlag(flags, "summary", "observe");
        const evidenceRef = requireStringFlag(flags, "evidence", "observe");
        const issuer = getStringFlag(flags, "issuer") ?? "";

        const ttlSeconds = parseStrictPositiveInt(ttlRaw, "ttl", "observe");
        const observeOpts: ObserveOptions = {
          claimId,
          env: envRaw as EnvName,
          gitSha,
          ttlSeconds,
          summary,
          evidenceRef,
          issuer,
          envVars,
        };
        if (brainDir !== undefined) observeOpts.brainDir = brainDir;
        if (repoRoot !== undefined) observeOpts.repoRoot = repoRoot;

        const roles = splitCsvFlag(getStringFlag(flags, "roles"));
        if (roles !== undefined) {
          observeOpts.roles = roles;
        }
        const priorityRaw = getStringFlag(flags, "priority");
        if (priorityRaw !== undefined) {
          if (!isValidPriority(priorityRaw)) {
            throw new VeriBrainError({
              exitCode: EXIT_ERROR,
              code: "CLI_ERROR",
              claimId,
              rule: "invalid_priority",
              detail: "--priority must be P0, P1, or P2.",
              fix: "Pass --priority P0|P1|P2.",
            });
          }
          observeOpts.priority = priorityRaw as Priority;
        }
        const ttlModeRaw = getStringFlag(flags, "ttl-mode");
        if (ttlModeRaw !== undefined) {
          if (!isValidObservedTtlMode(ttlModeRaw)) {
            throw new VeriBrainError({
              exitCode: EXIT_ERROR,
              code: "CLI_ERROR",
              claimId,
              rule: "invalid_ttl_mode",
              detail: "--ttl-mode must be sha-pinned or env-ttl.",
              fix: "Pass --ttl-mode sha-pinned|env-ttl.",
            });
          }
          observeOpts.ttlMode = ttlModeRaw as ObservedTtlMode;
        }

        const res = writeObservation(observeOpts);
        const receipt = truncateAscii(
          `observe ok: ${res.record.claim_id} (${res.record.env}@${res.record.git_sha.slice(0, 12)}) ttl=${res.record.ttl_seconds}s issuer=${res.record.issuer}`,
          MAX_COLS,
        );
        io.stdout(`${receipt}\n`);
        return EXIT_OK;
      }

      case "attest-test": {
        if (isAgentEnvironment(envVars)) {
          throw new VeriBrainError({
            exitCode: EXIT_PROVENANCE_VIOLATION,
            code: "PROVENANCE_VIOLATION",
            claimId: "attest-test",
            rule: "agent_self_attestation_denied",
            detail: "Agents cannot emit Tier 2 OBSERVED verifier receipts via attest-test.",
            fix: "Run veribrain attest-test outside agent mode from CI, hook, or verifier script.",
          });
        }
        const format = (getStringFlag(flags, "format") ?? "text").trim().toLowerCase();
        if (format !== "text" && format !== "json") {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: "attest-test",
            rule: "invalid_format",
            detail: "--format must be text or json.",
            fix: "Pass --format text or --format json.",
          });
        }
        const attestOpts: AttestTestOptions = {
          dryRun: flags.get("dry-run") === true,
          recordFailure: flags.get("record-failure") === true,
          envVars,
        };
        if (brainDir !== undefined) attestOpts.brainDir = brainDir;
        if (repoRoot !== undefined) attestOpts.repoRoot = repoRoot;
        if (passthroughArgs.length > 0) attestOpts.argv = passthroughArgs;
        const cmd = getStringFlag(flags, "cmd");
        if (cmd !== undefined) attestOpts.cmd = cmd;
        const extraArgs = getMultiFlag(multiFlags, "arg");
        if (extraArgs !== undefined) attestOpts.args = extraArgs;
        const claimId = getStringFlag(flags, "claim-id");
        if (claimId !== undefined) attestOpts.claimId = claimId;
        const envRaw = getStringFlag(flags, "env");
        if (envRaw !== undefined) {
          if (!isValidEnv(envRaw)) {
            throw new VeriBrainError({
              exitCode: EXIT_ERROR,
              code: "CLI_ERROR",
              claimId: "attest-test",
              rule: "invalid_env",
              detail: "--env must be local, pre-staging, staging, or prod.",
              fix: INVALID_ENV_FIX_HINT,
            });
          }
          attestOpts.env = envRaw as EnvName;
        }
        const gitSha = getStringFlag(flags, "git-sha");
        if (gitSha !== undefined) attestOpts.gitSha = gitSha;
        const ttlRaw = getStringFlag(flags, "ttl");
        if (ttlRaw !== undefined) {
          attestOpts.ttlSeconds = parseStrictPositiveInt(ttlRaw, "ttl", "attest-test");
        }
        const ttlModeRaw = getStringFlag(flags, "ttl-mode");
        if (ttlModeRaw !== undefined) {
          if (!isValidObservedTtlMode(ttlModeRaw)) {
            throw new VeriBrainError({
              exitCode: EXIT_ERROR,
              code: "CLI_ERROR",
              claimId: "attest-test",
              rule: "invalid_ttl_mode",
              detail: "--ttl-mode must be sha-pinned or env-ttl.",
              fix: "Pass --ttl-mode sha-pinned|env-ttl.",
            });
          }
          attestOpts.ttlMode = ttlModeRaw as ObservedTtlMode;
        }
        const timeoutRaw = getStringFlag(flags, "timeout");
        if (timeoutRaw !== undefined) {
          attestOpts.timeoutMs = parseStrictPositiveInt(timeoutRaw, "timeout", "attest-test");
        }
        const roles = splitCsvFlag(getStringFlag(flags, "roles"));
        if (roles !== undefined) attestOpts.roles = roles;
        const priorityRaw = getStringFlag(flags, "priority");
        if (priorityRaw !== undefined) {
          if (!isValidPriority(priorityRaw)) {
            throw new VeriBrainError({
              exitCode: EXIT_ERROR,
              code: "CLI_ERROR",
              claimId: "attest-test",
              rule: "invalid_priority",
              detail: "--priority must be P0, P1, or P2.",
              fix: "Pass --priority P0|P1|P2.",
            });
          }
          attestOpts.priority = priorityRaw as Priority;
        }

        const res = attestTest(attestOpts);
        if (format === "json") {
          io.stdout(`${JSON.stringify(res, null, 2)}\n`);
        } else {
          const modeTag = res.dry_run ? " [dry-run]" : res.recorded ? " [recorded]" : "";
          const statusWord = res.passed ? "ok" : "FAIL";
          const line = truncateAscii(
            `attest-test ${statusWord}: ${res.claim_id} exit=${res.exit_code} ${res.duration_ms}ms out=${res.output_sha256.slice(0, 12)}${modeTag}`,
            MAX_COLS,
          );
          if (res.passed) {
            io.stdout(`${line}\n`);
          } else {
            io.stderr(`${line}\n`);
          }
        }
        return res.passed ? EXIT_OK : EXIT_ERROR;
      }

      case "decide": {
        if (isAgentEnvironment(envVars)) {
          throw new VeriBrainError({
            exitCode: EXIT_PROVENANCE_VIOLATION,
            code: "PROVENANCE_VIOLATION",
            claimId: "decide",
            rule: "agent_self_attestation_denied",
            detail: "Agents cannot author or sign DECIDED rules (fail-closed provenance).",
            fix: "Have a human owner run veribrain decide outside agent mode.",
          });
        }
        const issuer = getStringFlag(flags, "issuer");
        if (issuer !== undefined && issuer.trim().toLowerCase() !== "human") {
          throw new VeriBrainError({
            exitCode: EXIT_PROVENANCE_VIOLATION,
            code: "PROVENANCE_VIOLATION",
            claimId: "decide",
            rule: "non_human_issuer_denied",
            detail: "veribrain decide requires --issuer human (non-human issuers denied).",
            fix: "Omit --issuer or pass --issuer human.",
          });
        }
        const id = requireStringFlag(flags, "id", "decide");
        const priorityRaw = requireStringFlag(flags, "priority", "decide");
        if (!isValidPriority(priorityRaw)) {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: id,
            rule: "invalid_priority",
            detail: "--priority must be P0, P1, or P2.",
            fix: "Pass --priority P0|P1|P2.",
          });
        }
        const signedBy = getStringFlag(flags, "signed-by") ?? "";
        const decideOpts: DecideOptions = {
          id,
          priority: priorityRaw as Priority,
          signedBy,
          dryRun: flags.get("dry-run") === true,
          envVars,
        };
        if (brainDir !== undefined) decideOpts.brainDir = brainDir;
        if (repoRoot !== undefined) decideOpts.repoRoot = repoRoot;
        if (issuer !== undefined) decideOpts.issuer = issuer;
        const roles = splitCsvFlag(getStringFlag(flags, "roles"));
        if (roles !== undefined) decideOpts.roles = roles;
        const envs = splitCsvFlag(getStringFlag(flags, "envs"));
        if (envs !== undefined) decideOpts.envs = envs;
        const title = getStringFlag(flags, "title");
        if (title !== undefined) decideOpts.title = title;
        const supersedes = getStringFlag(flags, "supersedes");
        if (supersedes !== undefined) decideOpts.supersedes = supersedes;
        const file = getStringFlag(flags, "file");
        if (file !== undefined) decideOpts.file = file;
        const body = getStringFlag(flags, "body");
        if (body !== undefined) decideOpts.body = body;
        if (mirrorDirs !== undefined) decideOpts.mirrorDirs = mirrorDirs;

        const res = decideRule(decideOpts);
        const modeTag = res.dryRun ? " [dry-run]" : "";
        const receipt = truncateAscii(
          `decide ok: ${res.id} sha=${res.sha256_body.slice(0, 12)} mirrors=${res.mirroredTo.length}${modeTag}`,
          MAX_COLS,
        );
        io.stdout(`${receipt}\n`);
        return EXIT_OK;
      }

      case "sign": {
        if (isAgentEnvironment(envVars)) {
          throw new VeriBrainError({
            exitCode: EXIT_PROVENANCE_VIOLATION,
            code: "PROVENANCE_VIOLATION",
            claimId: "sign",
            rule: "agent_self_attestation_denied",
            detail: "Agents cannot sign DECIDED rules (fail-closed provenance).",
            fix: "Have a human owner run veribrain sign outside agent mode.",
          });
        }
        const targetPath = positionals[0] ?? getStringFlag(flags, "file");
        if (!targetPath) {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: "sign",
            rule: "missing_file_path",
            detail: "Command sign requires a .brain/decided/<file>.md path.",
            fix: "Run veribrain sign .brain/decided/DEC-001.md.",
          });
        }
        const signOpts: SignOptions = {
          filePath: targetPath,
          dryRun: flags.get("dry-run") === true,
          envVars,
        };
        if (brainDir !== undefined) signOpts.brainDir = brainDir;
        if (repoRoot !== undefined) signOpts.repoRoot = repoRoot;
        const signedBy = getStringFlag(flags, "signed-by");
        if (signedBy !== undefined) signOpts.signedBy = signedBy;
        const issuer = getStringFlag(flags, "issuer");
        if (issuer !== undefined) signOpts.issuer = issuer;
        if (mirrorDirs !== undefined) signOpts.mirrorDirs = mirrorDirs;

        const res = signDecidedFile(signOpts);
        const modeTag = res.dryRun ? " [dry-run]" : "";
        const receipt = truncateAscii(
          `sign ok: ${res.id} sha=${res.sha256_body.slice(0, 12)} mirrors=${res.mirroredTo.length}${modeTag}`,
          MAX_COLS,
        );
        io.stdout(`${receipt}\n`);
        return EXIT_OK;
      }

      case "promote": {
        if (isAgentEnvironment(envVars)) {
          throw new VeriBrainError({
            exitCode: EXIT_PROVENANCE_VIOLATION,
            code: "PROVENANCE_VIOLATION",
            claimId: "promote",
            rule: "agent_self_attestation_denied",
            detail: "Agents cannot promote hypotheses to scars or DECIDED rules.",
            fix: "Have a human owner run veribrain promote outside agent mode.",
          });
        }
        const hypId = positionals[0];
        if (!hypId) {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: "promote",
            rule: "missing_hyp_id",
            detail: "Command promote requires a HYP-* identifier.",
            fix: "Run veribrain promote HYP-<id> [--to scar|decided].",
          });
        }
        const toRaw = getStringFlag(flags, "to");
        if (toRaw !== undefined && toRaw !== "scar" && toRaw !== "decided") {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: hypId,
            rule: "invalid_promote_target",
            detail: "--to must be scar or decided.",
            fix: "Pass --to scar or --to decided.",
          });
        }
        const priorityRaw = getStringFlag(flags, "priority");
        if (priorityRaw !== undefined && !isValidPriority(priorityRaw)) {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: hypId,
            rule: "invalid_priority",
            detail: "--priority must be P0, P1, or P2.",
            fix: "Pass --priority P0|P1|P2.",
          });
        }

        const promoteOpts: PromoteOptions = {
          hypId,
          dryRun: flags.get("dry-run") === true,
          envVars,
        };
        if (toRaw === "scar" || toRaw === "decided") promoteOpts.to = toRaw;
        if (brainDir !== undefined) promoteOpts.brainDir = brainDir;
        if (repoRoot !== undefined) promoteOpts.repoRoot = repoRoot;
        const targetId = getStringFlag(flags, "id");
        if (targetId !== undefined) promoteOpts.id = targetId;
        if (priorityRaw !== undefined) promoteOpts.priority = priorityRaw as Priority;
        const roles = splitCsvFlag(getStringFlag(flags, "roles"));
        if (roles !== undefined) promoteOpts.roles = roles;
        const envs = splitCsvFlag(getStringFlag(flags, "envs"));
        if (envs !== undefined) promoteOpts.envs = envs;
        const signedBy = getStringFlag(flags, "signed-by");
        if (signedBy !== undefined) promoteOpts.signedBy = signedBy;
        const title = getStringFlag(flags, "title");
        if (title !== undefined) promoteOpts.title = title;
        const regressionTest = getStringFlag(flags, "regression-test");
        if (regressionTest !== undefined) promoteOpts.regressionTest = regressionTest;
        const issuer = getStringFlag(flags, "issuer");
        if (issuer !== undefined) promoteOpts.issuer = issuer;
        if (mirrorDirs !== undefined) promoteOpts.mirrorDirs = mirrorDirs;

        const res = promoteHypothesis(promoteOpts);
        const modeTag = res.dryRun ? " [dry-run]" : "";
        const receipt = truncateAscii(
          `promote ok: ${res.hypId} -> ${res.promotedId} (${res.promotedTo}, mirrors=${res.mirroredTo.length})${modeTag}`,
          MAX_COLS,
        );
        io.stdout(`${receipt}\n`);
        return EXIT_OK;
      }

      case "eval": {
        const evalOpts: EvalOptions = {
          strict: flags.get("strict") === true,
          checkMirror: flags.get("check-mirror") === true,
        };
        if (brainDir !== undefined) evalOpts.brainDir = brainDir;
        if (repoRoot !== undefined) evalOpts.repoRoot = repoRoot;
        if (mirrorDirs !== undefined) evalOpts.mirrorDirs = mirrorDirs;

        const res = evaluateBrain(evalOpts);
        if (res.ok) {
          const mirrorNote = evalOpts.checkMirror ? " mirror=ok" : "";
          const receipt = truncateAscii(
            `eval ok: decided=${res.counts.decided} observed=${res.counts.observed} hyp=${res.counts.hypotheses} scars=${res.counts.scars} (${res.counts.scarsBytes}/4096 B)${mirrorNote}`,
            MAX_COLS,
          );
          io.stdout(`${receipt}\n`);
          return EXIT_OK;
        }
        for (const issue of res.issues) {
          io.stderr(formatEvalIssue(issue));
        }
        return res.exitCode;
      }

      case "diff": {
        const diffOpts: DiffOptions = {};
        if (brainDir !== undefined) diffOpts.brainDir = brainDir;
        if (repoRoot !== undefined) diffOpts.repoRoot = repoRoot;
        const since = getStringFlag(flags, "since");
        if (since !== undefined) diffOpts.since = since;

        const res = generateBrainDiff(diffOpts);
        io.stdout(res.rendered);
        return EXIT_OK;
      }

      case "check-citations": {
        const format = (getStringFlag(flags, "format") ?? "text").trim().toLowerCase();
        if (format !== "text" && format !== "json") {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: "check-citations",
            rule: "invalid_format",
            detail: "--format must be text or json.",
            fix: "Pass --format text or --format json.",
          });
        }
        const checkOpts: CheckCitationsOptions = {
          includeCodeBlocks: flags.get("include-code-blocks") === true,
          decidedOnly: flags.get("decided-only") === true,
        };
        if (brainDir !== undefined) checkOpts.brainDir = brainDir;
        if (repoRoot !== undefined) checkOpts.repoRoot = repoRoot;
        const paths = splitCsvFlag(getStringFlag(flags, "paths"));
        if (paths !== undefined) checkOpts.paths = paths;
        const ignoreIds = splitCsvFlag(getStringFlag(flags, "ignore-ids"));
        if (ignoreIds !== undefined) checkOpts.ignoreIds = ignoreIds;

        const res = checkCitations(checkOpts);
        if (format === "json") {
          io.stdout(`${JSON.stringify(res, null, 2)}\n`);
        } else if (res.ok) {
          io.stdout(res.rendered);
        } else {
          io.stderr(res.rendered);
        }
        return res.ok ? EXIT_OK : EXIT_ERROR;
      }

      case "retro": {
        const format = (getStringFlag(flags, "format") ?? "md").trim().toLowerCase();
        if (format !== "md" && format !== "json") {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: "retro",
            rule: "invalid_format",
            detail: "--format must be md or json.",
            fix: "Pass --format md or --format json.",
          });
        }
        const retroOpts: RetroOptions = {};
        if (brainDir !== undefined) retroOpts.brainDir = brainDir;
        if (repoRoot !== undefined) retroOpts.repoRoot = repoRoot;
        const since = getStringFlag(flags, "since");
        if (since !== undefined) retroOpts.since = since;
        const envRaw = getStringFlag(flags, "env");
        if (envRaw !== undefined) {
          if (!isValidEnv(envRaw)) {
            throw new VeriBrainError({
              exitCode: EXIT_ERROR,
              code: "CLI_ERROR",
              claimId: "retro",
              rule: "invalid_env",
              detail: "--env must be local, pre-staging, staging, or prod.",
              fix: INVALID_ENV_FIX_HINT,
            });
          }
          retroOpts.env = envRaw as EnvName;
        }
        const layoutRaw = getStringFlag(flags, "zone-a-layout");
        if (layoutRaw !== undefined) {
          if (!isValidZoneALayout(layoutRaw)) {
            throw new VeriBrainError({
              exitCode: EXIT_ERROR,
              code: "CLI_ERROR",
              claimId: "retro",
              rule: "invalid_zone_a_layout",
              detail: "--zone-a-layout must be legacy or split.",
              fix: "Pass --zone-a-layout legacy|split.",
            });
          }
          retroOpts.zoneALayout = layoutRaw as ZoneALayout;
        }
        const roles = splitCsvFlag(getStringFlag(flags, "roles"));
        if (roles !== undefined) retroOpts.roles = roles;

        const res = generateRetroReport(retroOpts);
        if (format === "json") {
          io.stdout(`${JSON.stringify(res, null, 2)}\n`);
        } else {
          io.stdout(res.markdown);
        }
        return EXIT_OK;
      }

      case "stats": {
        const enable = flags.get("enable") === true;
        const disable = flags.get("disable") === true;
        const reset = flags.get("reset") === true;
        if ((enable || disable || reset) && isAgentEnvironment(envVars)) {
          throw new VeriBrainError({
            exitCode: EXIT_PROVENANCE_VIOLATION,
            code: "PROVENANCE_VIOLATION",
            claimId: "stats",
            rule: "agent_mutator_denied",
            detail: "Agents cannot mutate metrics settings or reset .brain/.metrics.jsonl.",
            fix: "Run read-only `veribrain stats` or ask a human to run --enable/--disable/--reset.",
          });
        }

        const rawFormatFlag = getStringFlag(flags, "format");
        const formatRaw = (rawFormatFlag ?? "text").trim().toLowerCase();
        if (formatRaw !== "text" && formatRaw !== "md" && formatRaw !== "json") {
          if (
            rawFormatFlag !== undefined &&
            scanTextForQuarantine(rawFormatFlag, {
              claimId: "stats",
              field: "format",
              allowHashRefExemption: false,
            }) !== null
          ) {
            throw new VeriBrainError({
              exitCode: EXIT_QUARANTINE_VIOLATION,
              code: "QUARANTINE_VIOLATION",
              claimId: "stats",
              rule: "quarantine_flag_value",
              detail: "Sensitive pattern detected in --format value (redacted).",
              fix: "Pass --format text|md|json without secrets or PII.",
            });
          }
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: "stats",
            rule: "invalid_format",
            detail: "--format must be text, md, or json.",
            fix: "Pass --format text|md|json.",
          });
        }

        const statsOpts: StatsOptions = {
          format: formatRaw as StatsFormat,
          enable,
          disable,
          reset,
          envVars,
        };
        if (brainDir !== undefined) statsOpts.brainDir = brainDir;
        if (repoRoot !== undefined) statsOpts.repoRoot = repoRoot;
        const since = getStringFlag(flags, "since");
        if (since !== undefined) statsOpts.since = since;
        const rawBaselinePaths = getStringFlag(flags, "baseline-paths");
        if (rawBaselinePaths !== undefined) {
          const parsedBaseline = rawBaselinePaths
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part.length > 0);
          if (parsedBaseline.length === 0) {
            throw new VeriBrainError({
              exitCode: EXIT_ERROR,
              code: "CLI_ERROR",
              claimId: "stats",
              rule: "empty_baseline_paths",
              detail: "--baseline-paths cannot be empty when specified.",
              fix: "Pass comma-separated repo-relative paths or omit --baseline-paths.",
            });
          }
          statsOpts.baselinePaths = parsedBaseline;
        }

        const res = runStats(statsOpts);
        if (formatRaw === "json") {
          io.stdout(`${JSON.stringify(res, null, 2)}\n`);
        } else if (formatRaw === "md") {
          io.stdout(formatStatsMarkdown(res));
        } else {
          io.stdout(formatStatsText(res));
        }
        return EXIT_OK;
      }

      case "lint-text": {
        const targetFile = positionals[0] ?? getStringFlag(flags, "file");
        if (!targetFile) {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: "lint-text",
            rule: "missing_file_path",
            detail: "Command lint-text requires a <file> path.",
            fix: "Run veribrain lint-text path/to/file.md [--format text|json].",
          });
        }
        const format = (getStringFlag(flags, "format") ?? "text").trim().toLowerCase();
        if (format !== "text" && format !== "json") {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: "lint-text",
            rule: "invalid_format",
            detail: "--format must be text or json.",
            fix: "Pass --format text or --format json.",
          });
        }
        const lintOpts: LintTextOptions = {
          filePath: targetFile,
        };
        if (brainDir !== undefined) lintOpts.brainDir = brainDir;
        if (repoRoot !== undefined) lintOpts.repoRoot = repoRoot;

        const res = lintTextFile(lintOpts);
        if (format === "json") {
          io.stdout(`${JSON.stringify(res, null, 2)}\n`);
          return res.clean ? EXIT_OK : EXIT_QUARANTINE_VIOLATION;
        }
        if (res.clean) {
          const receipt = truncateAscii(
            `lint-text ok: 0 quarantine violations (${path.basename(res.file)})`,
            MAX_COLS,
          );
          io.stdout(`${receipt}\n`);
          return EXIT_OK;
        }
        for (const m of res.matches) {
          const lines = [
            ...wrapAsciiLines(`FAIL [EXIT 2] line ${m.line} (${m.rule})`, MAX_COLS),
            ...wrapAsciiLines(`detail: ${m.detail}`, MAX_COLS, "  "),
            ...wrapAsciiLines(`fix: ${m.fix}`, MAX_COLS, "  "),
          ];
          io.stderr(`${lines.join("\n")}\n`);
        }
        return EXIT_QUARANTINE_VIOLATION;
      }

      case "hooks": {
        const subCmd = positionals[0];
        const printCi = flags.get("print-ci") === true;
        if (subCmd !== undefined && subCmd !== "install") {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: "hooks",
            rule: "unknown_hooks_subcommand",
            detail: `Unknown hooks subcommand "${subCmd}".`,
            fix: "Run veribrain hooks install [--force] [--print-ci].",
          });
        }
        if (subCmd === undefined && !printCi) {
          throw new VeriBrainError({
            exitCode: EXIT_ERROR,
            code: "CLI_ERROR",
            claimId: "hooks",
            rule: "missing_hooks_subcommand",
            detail: "Command hooks requires 'install' or --print-ci.",
            fix: "Run veribrain hooks install [--force] [--print-ci].",
          });
        }
        const hooksOpts: HooksInstallOptions = {
          force: flags.get("force") === true,
          printCi,
        };
        if (repoRoot !== undefined) hooksOpts.repoRoot = repoRoot;

        const res = installGitHooks(hooksOpts);
        if (res.ciYaml !== undefined) {
          io.stdout(res.ciYaml);
          return EXIT_OK;
        }
        const installedList = res.installed.length > 0 ? res.installed.join(",") : "none";
        const skippedList = res.skipped.length > 0 ? res.skipped.join(",") : "none";
        const receipt = truncateAscii(
          `hooks ok: installed=${installedList} skipped=${skippedList}`,
          MAX_COLS,
        );
        io.stdout(`${receipt}\n`);
        return EXIT_OK;
      }

      case "mcp": {
        const printConfigClient = getStringFlag(flags, "print-config");
        if (printConfigClient !== undefined) {
          const rendered = printMcpClientConfig(printConfigClient, {
            ...(brainDir !== undefined ? { brainDir } : {}),
            ...(repoRoot !== undefined ? { repoRoot } : {}),
          });
          io.stdout(rendered);
          return EXIT_OK;
        }
        throw new VeriBrainError({
          exitCode: EXIT_ERROR,
          code: "CLI_ERROR",
          claimId: "mcp",
          rule: "async_mcp_server_required",
          detail: "Starting stdio MCP server requires the async CLI entrypoint.",
          fix: "Invoke veribrain mcp directly or pass --print-config <client>.",
        });
      }

      default: {
        throw new VeriBrainError({
          exitCode: EXIT_ERROR,
          code: "CLI_ERROR",
          claimId: "cli",
          rule: "unknown_command",
          detail: `Unknown command "${command}".`,
          fix: "Run veribrain --help to list valid commands.",
        });
      }
    }
  } catch (err) {
    if (err instanceof VeriBrainError) {
      io.stderr(formatCliError(err));
      return err.exitCode;
    }
    const rawDetail = err instanceof Error ? err.message : String(err);
    const hasSensitive = scanTextForQuarantine(rawDetail, { claimId: "cli" }) !== null;
    const safeDetail = hasSensitive
      ? "Unexpected internal error (raw message redacted for safety)."
      : rawDetail;
    const fallback = new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "UNEXPECTED_ERROR",
      claimId: "cli",
      rule: "internal_error",
      detail: safeDetail,
      fix: "Inspect inputs and re-run veribrain eval.",
    });
    io.stderr(formatCliError(fallback));
    return EXIT_ERROR;
  }
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    const selfPath = realpathSync(fileURLToPath(import.meta.url));
    const argPath = realpathSync(path.resolve(entry));
    if (process.platform === "win32") {
      return selfPath.toLowerCase() === argPath.toLowerCase();
    }
    return selfPath === argPath;
  } catch {
    return false;
  }
}

export async function runCliAsync(
  argv: readonly string[],
  customIo?: Partial<CliIo>,
): Promise<ExitCode> {
  const io: CliIo = {
    stdout: customIo?.stdout ?? ((chunk) => process.stdout.write(chunk)),
    stderr: customIo?.stderr ?? ((chunk) => process.stderr.write(chunk)),
    env: customIo?.env ?? process.env,
  };

  if (peekCliCommand(argv) === "mcp") {
    try {
      const { command, flags } = parseCliArgs(argv);
      if (
        command === "mcp" &&
        flags.get("help") !== true &&
        flags.get("version") !== true &&
        getStringFlag(flags, "print-config") === undefined
      ) {
        const brainDir = getStringFlag(flags, "brain-dir");
        const repoRoot = getStringFlag(flags, "repo-root");
        const { startMcpStdioServer } = await import("./mcp/server.js");
        await startMcpStdioServer({
          ...(brainDir !== undefined ? { brainDir } : {}),
          ...(repoRoot !== undefined ? { repoRoot } : {}),
        });
        return EXIT_OK;
      }
    } catch (err) {
      if (err instanceof VeriBrainError) {
        io.stderr(formatCliError(err));
        return err.exitCode;
      }
      const rawDetail = err instanceof Error ? err.message : String(err);
      const hasSensitive = scanTextForQuarantine(rawDetail, { claimId: "mcp" }) !== null;
      const safeDetail = hasSensitive
        ? "Unexpected internal error (raw message redacted for safety)."
        : rawDetail;
      const fallback = new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "UNEXPECTED_ERROR",
        claimId: "mcp",
        rule: "internal_error",
        detail: safeDetail,
        fix: "Inspect inputs and re-run veribrain eval.",
      });
      io.stderr(formatCliError(fallback));
      return EXIT_ERROR;
    }
  }

  return runCli(argv, io);
}

async function runCliEntrypoint(argv: readonly string[]): Promise<void> {
  if (peekCliCommand(argv) === "mcp") {
    try {
      const { command, flags } = parseCliArgs(argv);
      if (
        command === "mcp" &&
        flags.get("help") !== true &&
        flags.get("version") !== true &&
        getStringFlag(flags, "print-config") === undefined
      ) {
        const brainDir = getStringFlag(flags, "brain-dir");
        const repoRoot = getStringFlag(flags, "repo-root");
        const { startMcpStdioServer } = await import("./mcp/server.js");
        await startMcpStdioServer({
          ...(brainDir !== undefined ? { brainDir } : {}),
          ...(repoRoot !== undefined ? { repoRoot } : {}),
        });
        return;
      }
    } catch (err) {
      if (err instanceof VeriBrainError) {
        process.stderr.write(formatCliError(err));
        process.exit(err.exitCode);
      }
      const rawDetail = err instanceof Error ? err.message : String(err);
      const hasSensitive = scanTextForQuarantine(rawDetail, { claimId: "mcp" }) !== null;
      const safeDetail = hasSensitive
        ? "Unexpected internal error (raw message redacted for safety)."
        : rawDetail;
      const fallback = new VeriBrainError({
        exitCode: EXIT_ERROR,
        code: "UNEXPECTED_ERROR",
        claimId: "mcp",
        rule: "internal_error",
        detail: safeDetail,
        fix: "Inspect inputs and re-run veribrain eval.",
      });
      process.stderr.write(formatCliError(fallback));
      process.exit(EXIT_ERROR);
    }
  }

  const code = runCli(argv);
  process.exit(code);
}

if (isExecutedDirectly()) {
  void runCliEntrypoint(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    const safe =
      scanTextForQuarantine(msg, { claimId: "mcp" }) !== null
        ? "Fatal MCP server error (redacted)."
        : msg;
    process.stderr.write(`ERROR [EXIT 1] MCP_FATAL: ${safe}\n`);
    process.exit(EXIT_ERROR);
  });
}
