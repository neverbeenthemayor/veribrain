import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.js";
import { initBrain } from "../../src/commands/init.js";
import { computeDecidedBodyHash } from "../../src/normalize.js";
import type {
  BrainConfig,
  DecidedStatus,
  EnvName,
  ExitCode,
  Issuer,
  Priority,
} from "../../src/types.js";

export interface TempWorkspace {
  root: string;
  brainDir: string;
}

export interface CliCapture {
  code: ExitCode;
  stdout: string;
  stderr: string;
}

export interface DecidedFixtureInput {
  id: string;
  priority: Priority;
  roles: string[];
  body: string;
  signedBy?: string;
  signedAtUtc?: string;
  status?: DecidedStatus;
  fileName?: string;
  lineEnding?: "\n" | "\r\n";
  withBom?: boolean;
  reverseFrontmatter?: boolean;
  frontmatterComment?: string;
  sha256Override?: string;
}

export interface ObservedFixtureInput {
  claim_id: string;
  env: EnvName;
  git_sha: string;
  observed_at_utc: string;
  ttl_seconds: number;
  issuer: Issuer | string;
  roles: string[];
  priority?: Priority;
  summary: string;
  evidence_ref: string;
  fileName?: string;
  reverseKeys?: boolean;
  minified?: boolean;
  lineEnding?: "\n" | "\r\n";
}

export interface HypothesisFixtureInput {
  id: string;
  created_at_utc: string;
  expires_at_utc: string;
  roles?: string[];
  proposed_by?: string;
  hint: string;
  fileName?: string;
}

export interface ScarFixtureInput {
  scar_id: string;
  created_at_utc: string;
  expires_at_utc: string;
  regression_test: string;
  hint: string;
  roles?: string[];
}

export class WorkspaceTracker {
  private readonly dirs: string[] = [];

  public create(prefix = "veribrain-golden-", signedBy?: string): TempWorkspace {
    const root = mkdtempSync(path.join(os.tmpdir(), prefix));
    this.dirs.push(root);
    const brainDir = path.join(root, ".brain");
    initBrain({
      brainDir,
      repoRoot: root,
      ...(signedBy !== undefined ? { signedBy } : {}),
      now: new Date("2026-11-28T09:00:00Z"),
    });
    return { root, brainDir };
  }

  public createEmpty(prefix = "veribrain-golden-empty-"): TempWorkspace {
    const root = mkdtempSync(path.join(os.tmpdir(), prefix));
    this.dirs.push(root);
    const brainDir = path.join(root, ".brain");
    return { root, brainDir };
  }

  public cleanupAll(): void {
    while (this.dirs.length > 0) {
      const dir = this.dirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}

export function writeBrainConfig(
  brainDir: string,
  config: BrainConfig,
  options?: { indent?: number; lineEnding?: "\n" | "\r\n" },
): void {
  const indent = options?.indent ?? 2;
  const eol = options?.lineEnding ?? "\n";
  const json = indent === 0 ? JSON.stringify(config) : JSON.stringify(config, null, indent);
  writeFileSync(path.join(brainDir, "config.json"), `${json.replace(/\n/g, eol)}${eol}`, "utf8");
}

export function writeDecidedFixture(brainDir: string, input: DecidedFixtureInput): string {
  const decidedDir = path.join(brainDir, "decided");
  mkdirSync(decidedDir, { recursive: true });

  const eol = input.lineEnding ?? "\n";
  const sha = input.sha256Override ?? computeDecidedBodyHash(input.body);
  const fields: string[] = [
    `id: ${input.id}`,
    `priority: ${input.priority}`,
    `roles: [${input.roles.join(", ")}]`,
    `signed_by: ${input.signedBy ?? "Ian Mayor"}`,
    `signed_at_utc: ${input.signedAtUtc ?? "2026-11-28T09:00:00Z"}`,
    `sha256_body: ${sha}`,
    `status: ${input.status ?? "active"}`,
  ];

  if (input.reverseFrontmatter) {
    fields.reverse();
  }
  if (input.frontmatterComment) {
    fields.splice(2, 0, `# ${input.frontmatterComment}`);
  }

  const normalizedBody = input.body.replace(/\r\n?/g, "\n").replace(/\n/g, eol);
  const raw = ["---", ...fields, "---", normalizedBody, ""].join(eol);
  const content = input.withBom ? `\uFEFF${raw}` : raw;
  const target = path.join(decidedDir, input.fileName ?? `${input.id}.md`);
  writeFileSync(target, content, "utf8");
  return target;
}

export function writeObservedFixture(brainDir: string, input: ObservedFixtureInput): string {
  const observedDir = path.join(brainDir, "observed");
  mkdirSync(observedDir, { recursive: true });

  const entries: Array<[string, unknown]> = [
    ["claim_id", input.claim_id],
    ["env", input.env],
    ["git_sha", input.git_sha],
    ["observed_at_utc", input.observed_at_utc],
    ["ttl_seconds", input.ttl_seconds],
    ["issuer", input.issuer],
    ["roles", input.roles],
    ...(input.priority !== undefined
      ? ([["priority", input.priority]] as [string, unknown][])
      : []),
    ["summary", input.summary],
    ["evidence_ref", input.evidence_ref],
  ];
  if (input.reverseKeys) {
    entries.reverse();
  }

  const obj: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    obj[k] = v;
  }

  const eol = input.lineEnding ?? "\n";
  const json = input.minified ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);
  const target = path.join(observedDir, input.fileName ?? `${input.claim_id}.json`);
  writeFileSync(target, `${json.replace(/\n/g, eol)}${eol}`, "utf8");
  return target;
}

export function writeHypothesisFixture(brainDir: string, input: HypothesisFixtureInput): string {
  const hypDir = path.join(brainDir, "hypotheses");
  mkdirSync(hypDir, { recursive: true });

  const payload = {
    id: input.id,
    created_at_utc: input.created_at_utc,
    expires_at_utc: input.expires_at_utc,
    roles: input.roles ?? ["builder"],
    proposed_by: input.proposed_by ?? "agent-cqe-eval",
    hint: input.hint,
  };
  const target = path.join(hypDir, input.fileName ?? `${input.id}.json`);
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return target;
}

export function writeScarsFixture(
  brainDir: string,
  scars: readonly ScarFixtureInput[],
  options?: { lineEnding?: "\n" | "\r\n"; preambleComment?: string },
): string {
  const eol = options?.lineEnding ?? "\n";
  const lines: string[] = ["# VeriBrain Scars (Max 4,096 B, TTL <= 30d)", ""];
  if (options?.preambleComment) {
    lines.push(`<!-- ${options.preambleComment} -->`, "");
  }
  for (const scar of scars) {
    lines.push(`## ${scar.scar_id}`);
    lines.push(`- created_at_utc: ${scar.created_at_utc}`);
    lines.push(`- expires_at_utc: ${scar.expires_at_utc}`);
    lines.push(`- regression_test: ${scar.regression_test}`);
    if (scar.roles && scar.roles.length > 0) {
      lines.push(`- roles: [${scar.roles.join(", ")}]`);
    }
    lines.push(`- hint: ${scar.hint}`);
    lines.push("");
  }
  const target = path.join(brainDir, "scars.md");
  writeFileSync(target, `${lines.join(eol)}${eol}`, "utf8");
  return target;
}

export function invokeCli(argv: readonly string[], env?: NodeJS.ProcessEnv): CliCapture {
  let stdout = "";
  let stderr = "";
  const code = runCli(argv, {
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    env: env ?? {},
  });
  return { code, stdout, stderr };
}

export function collectLeakSubstrings(secret: string, chunkLen = 8): string[] {
  const trimmed = secret.trim();
  const out = new Set<string>([trimmed]);
  if (trimmed.length >= chunkLen) {
    out.add(trimmed.slice(0, chunkLen));
    out.add(
      trimmed.slice(
        Math.floor(trimmed.length / 2) - Math.floor(chunkLen / 2),
        Math.floor(trimmed.length / 2) + Math.ceil(chunkLen / 2),
      ),
    );
    out.add(trimmed.slice(-chunkLen));
  }
  return [...out];
}
