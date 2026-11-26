import { chmodSync, lstatSync, mkdirSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";
import { atomicWriteUtf8 } from "../mirror.js";
import { resolveGitContext } from "../schema.js";
import {
  EXIT_ERROR,
  EXIT_PROVENANCE_VIOLATION,
  type HooksInstallOptions,
  type HooksInstallResult,
  VeriBrainError,
} from "../types.js";

export const VERIBRAIN_HOOK_MARKER = "# veribrain-managed-hook";

const PRE_COMMIT_HOOK = [
  "#!/bin/sh",
  VERIBRAIN_HOOK_MARKER,
  "set -eu",
  "",
  'if [ ! -f ".brain/config.json" ]; then',
  "  exit 0",
  "fi",
  "",
  "if command -v veribrain >/dev/null 2>&1; then",
  '  VB="veribrain"',
  "else",
  '  VB="npx --no-install veribrain"',
  "fi",
  "",
  "$VB eval --strict",
  "",
].join("\n");

function buildObserveGitHook(eventName: "checkout" | "merge"): string {
  const claimId = eventName === "checkout" ? "OBS-git-checkout" : "OBS-git-merge";
  const summaryPrefix =
    eventName === "checkout" ? "Git checkout verified on branch" : "Git merge verified on branch";
  return [
    "#!/bin/sh",
    VERIBRAIN_HOOK_MARKER,
    "set -eu",
    "",
    'if [ ! -f ".brain/config.json" ]; then',
    "  exit 0",
    "fi",
    "",
    'GIT_SHA="$(git rev-parse HEAD 2>/dev/null || true)"',
    'if [ -z "$GIT_SHA" ]; then',
    "  exit 0",
    "fi",
    'BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo local)"',
    'case "$BRANCH" in',
    '  main) ENV_NAME="prod" ;;',
    '  staging) ENV_NAME="staging" ;;',
    '  pre-staging) ENV_NAME="pre-staging" ;;',
    '  *) ENV_NAME="local" ;;',
    "esac",
    "",
    "if command -v veribrain >/dev/null 2>&1; then",
    '  VB="veribrain"',
    "else",
    '  VB="npx --no-install veribrain"',
    "fi",
    "",
    `$VB observe \\`,
    `  --claim-id "${claimId}" \\`,
    '  --env "$ENV_NAME" \\',
    '  --git-sha "$GIT_SHA" \\',
    "  --ttl 86400 \\",
    `  --summary "${summaryPrefix} $BRANCH" \\`,
    `  --evidence "git:${eventName}/$GIT_SHA" \\`,
    "  --issuer git-hook >/dev/null 2>&1 || true",
    "",
  ].join("\n");
}

function ghaExpr(expr: string): string {
  return `$${"{{"} ${expr} ${"}}"}`;
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

export const VERIBRAIN_CI_SNIPPET = [
  "name: VeriBrain Provenance & Observe",
  "",
  "on:",
  "  push:",
  "    branches: [pre-staging, staging, main]",
  "  pull_request:",
  "    branches: [pre-staging, staging, main]",
  "",
  "permissions:",
  "  contents: read",
  "",
  "concurrency:",
  `  group: veribrain-${ghaExpr("github.workflow")}-${ghaExpr("github.ref")}`,
  "  cancel-in-progress: true",
  "",
  "jobs:",
  "  veribrain-gate:",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 5",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - uses: actions/setup-node@v4",
  "        with:",
  "          node-version: 24",
  "      - name: Run $0 VeriBrain strict provenance & quarantine gate",
  "        # Uses locally installed veribrain (or pin: npx --yes veribrain@1.1.0)",
  "        run: npx --no-install veribrain eval --strict",
  "      - name: Record Tier 2 CI observation",
  "        if: github.event_name == 'push'",
  "        env:",
  `          REF_NAME: ${ghaExpr("github.ref_name")}`,
  `          GIT_SHA: ${ghaExpr("github.sha")}`,
  `          RUN_ID: ${ghaExpr("github.run_id")}`,
  "        run: |",
  '          ENV_NAME="local"',
  '          if [ "$REF_NAME" = "main" ]; then ENV_NAME="prod"; fi',
  '          if [ "$REF_NAME" = "staging" ]; then ENV_NAME="staging"; fi',
  '          if [ "$REF_NAME" = "pre-staging" ]; then ENV_NAME="pre-staging"; fi',
  "          npx --no-install veribrain observe \\",
  "            --claim-id OBS-ci-gate \\",
  '            --env "$ENV_NAME" \\',
  '            --git-sha "$GIT_SHA" \\',
  "            --ttl 604800 \\",
  '            --summary "CI provenance gate passed on $REF_NAME." \\',
  '            --evidence "ci:github-actions/run/$RUN_ID" \\',
  "            --issuer ci",
  "",
].join("\n");

export function installGitHooks(options: HooksInstallOptions = {}): HooksInstallResult {
  if (options.printCi) {
    return {
      hooksDir: null,
      installed: [],
      skipped: [],
      ciYaml: VERIBRAIN_CI_SNIPPET,
    };
  }

  const startDir = path.resolve(options.repoRoot ?? process.cwd());
  const gitCtx = resolveGitContext(startDir);
  if (gitCtx === null) {
    throw new VeriBrainError({
      exitCode: EXIT_ERROR,
      code: "CLI_ERROR",
      claimId: "hooks",
      rule: "not_a_git_repo",
      detail: `No .git repository or worktree found from ${startDir}.`,
      fix: "Run veribrain hooks install inside a Git repository, or pass --print-ci for CI YAML.",
    });
  }

  const hooksDir = path.join(gitCtx.commonDir, "hooks");
  const hooksDirStat = lstatOrNull(hooksDir);
  if (hooksDirStat !== null) {
    if (hooksDirStat.isSymbolicLink() || !hooksDirStat.isDirectory()) {
      throw new VeriBrainError({
        exitCode: EXIT_PROVENANCE_VIOLATION,
        code: "PROVENANCE_VIOLATION",
        claimId: "hooks",
        rule: "hooks_symlink_denied",
        detail: "Git hooks directory cannot be a symbolic link or non-directory.",
        fix: "Replace symlinked .git/hooks with a standard directory.",
      });
    }
  } else {
    mkdirSync(hooksDir, { recursive: true });
  }

  const hookSpecs: Array<{ name: string; content: string }> = [
    { name: "pre-commit", content: PRE_COMMIT_HOOK },
    { name: "post-checkout", content: buildObserveGitHook("checkout") },
    { name: "post-merge", content: buildObserveGitHook("merge") },
  ];

  const installed: string[] = [];
  const skipped: string[] = [];
  const force = Boolean(options.force);

  for (const spec of hookSpecs) {
    const hookPath = path.join(hooksDir, spec.name);
    const hookStat = lstatOrNull(hookPath);
    if (hookStat !== null) {
      if (hookStat.isSymbolicLink() || !hookStat.isFile()) {
        throw new VeriBrainError({
          exitCode: EXIT_PROVENANCE_VIOLATION,
          code: "PROVENANCE_VIOLATION",
          claimId: "hooks",
          rule: "hooks_symlink_denied",
          detail: `Existing hook ${spec.name} is a symlink or non-file.`,
          fix: `Remove symlinked ${hookPath} before running veribrain hooks install.`,
        });
      }
      const existingContent = readFileSync(hookPath, "utf8");
      const isManaged = existingContent.includes(VERIBRAIN_HOOK_MARKER);
      if (!isManaged && !force) {
        skipped.push(spec.name);
        continue;
      }
    }

    atomicWriteUtf8(hookPath, spec.content);
    try {
      chmodSync(hookPath, 0o755);
    } catch {
      // Ignore chmod permission errors on filesystems without POSIX mode bits.
    }
    installed.push(spec.name);
  }

  return {
    hooksDir,
    installed,
    skipped,
  };
}
