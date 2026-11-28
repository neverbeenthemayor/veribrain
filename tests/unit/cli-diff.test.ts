import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { generateBrainDiff } from "../../src/commands/diff.js";
import { initBrain } from "../../src/commands/init.js";
import { writeObservation } from "../../src/commands/observe.js";
import { clearFileReadCache } from "../../src/schema.js";
import {
  EXIT_BUDGET_INFEASIBLE,
  EXIT_OK,
  EXIT_PROVENANCE_VIOLATION,
  EXIT_QUARANTINE_VIOLATION,
} from "../../src/types.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "veribrain-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

function captureCli(
  argv: string[],
  env?: NodeJS.ProcessEnv,
): {
  code: number;
  stdout: string;
  stderr: string;
} {
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

afterEach(() => {
  clearFileReadCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("CLI ergonomics and weekly 1-screen diff", () => {
  it("renders concise plain-ASCII global --help (<= 20 lines) and per-command <cmd> --help (<= 12 lines, <= 80 cols)", () => {
    const verRes = captureCli(["--version"]);
    expect(verRes.code).toBe(EXIT_OK);
    expect(verRes.stdout).toBe("veribrain 1.4.0\n");

    const res = captureCli(["--help"]);
    expect(res.code).toBe(EXIT_OK);
    expect(res.stderr).toBe("");
    const lines = res.stdout.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(20);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7E]*$/.test(line)).toBe(true);
    }

    for (const cmd of [
      "init",
      "compile",
      "observe",
      "attest-test",
      "decide",
      "sign",
      "promote",
      "eval",
      "doctor",
      "check-citations",
      "diff",
      "retro",
      "stats",
      "lint-text",
      "hooks",
      "mcp",
    ]) {
      const sub = captureCli([cmd, "--help"]);
      expect(sub.code).toBe(EXIT_OK);
      const subLines = sub.stdout.trimEnd().split("\n");
      expect(subLines.length).toBeLessThanOrEqual(12);
      for (const line of subLines) {
        expect(line.length).toBeLessThanOrEqual(80);
        expect(/^[\x20-\x7E]*$/.test(line)).toBe(true);
      }
    }

    const mcpPrint = captureCli(["mcp", "--print-config", "codex"]);
    expect(mcpPrint.code).toBe(EXIT_OK);
    expect(mcpPrint.stdout).toContain("[mcp_servers.veribrain]");

    const obsHelp = captureCli(["observe", "--help"]).stdout;
    expect(obsHelp).toContain("--issuer");
    expect(obsHelp).toContain("--summary");
    expect(obsHelp).toContain("--evidence");
  });

  it("renders 3-line clean empty diff and active diff with Delta header and Next footer <= 25 lines / <= 80 cols", () => {
    const root = makeTempDir();
    initBrain({ repoRoot: root });
    const brainDir = path.join(root, ".brain");

    const clean = generateBrainDiff({ brainDir, repoRoot: root, since: "7d" });
    const cleanLines = clean.rendered.trimEnd().split("\n");
    expect(cleanLines.length).toBe(3);
    for (const line of cleanLines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }

    writeFileSync(
      path.join(brainDir, "scars.md"),
      [
        "# Scars",
        "## SCAR-001",
        "- created_at_utc: 2026-10-01T00:00:00Z",
        "- expires_at_utc: 2026-10-20T00:00:00Z",
        "- regression_test: tests/missing.test.ts#L1",
        "- hint: Expired scar.",
        "## SCAR-002",
        "- created_at_utc: 2026-10-02T00:00:00Z",
        "- expires_at_utc: 2026-10-21T00:00:00Z",
        "- regression_test: tests/missing2.test.ts#L1",
        "- hint: Expired scar 2.",
        "",
      ].join("\n"),
      "utf8",
    );

    mkdirSync(path.join(brainDir, "hypotheses"), { recursive: true });
    for (const hypId of ["HYP-001", "HYP-002"]) {
      writeFileSync(
        path.join(brainDir, "hypotheses", `${hypId}.json`),
        JSON.stringify({
          id: hypId,
          created_at_utc: "2026-11-27T09:00:00Z",
          expires_at_utc: "2026-12-01T09:00:00Z",
          roles: ["builder"],
          proposed_by: "agent",
          hint: "Investigate flaky cache boundary.",
        }),
        "utf8",
      );
    }

    for (const obsId of ["OBS-exp-1", "OBS-exp-2", "OBS-exp-3"]) {
      writeObservation({
        claimId: obsId,
        env: "staging",
        gitSha: "abcdef1",
        ttlSeconds: 60,
        summary: "Expired observation.",
        evidenceRef: "ci:run/5",
        issuer: "ci",
        brainDir,
        repoRoot: root,
        now: new Date("2026-11-20T09:00:00Z"),
        envVars: {},
      });
    }

    const crowded = generateBrainDiff({
      brainDir,
      repoRoot: root,
      since: "7d",
      now: new Date("2026-11-28T09:00:00Z"),
    });
    expect(crowded.totalCount).toBe(7);
    expect(crowded.items.length).toBe(5);
    expect(crowded.items.map((i) => i.id)).toEqual([
      "SCAR-001",
      "SCAR-002",
      "HYP-001",
      "HYP-002",
      "OBS-exp-1",
    ]);

    const lines = crowded.rendered.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(25);
    expect(lines[1]).toBe("Delta: 3 expired observed | 2 aging/unlinked scars | 2 pending hyp");
    expect(lines[lines.length - 1]).toBe("Next: edit .brain/ then run veribrain eval --strict.");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7E]*$/.test(line)).toBe(true);
    }
    expect(crowded.rendered).toContain("   Action: [Keep] [Renew] [Prune]");
    expect(crowded.rendered).toContain(
      "   Action: [Promote to DECIDED] [Promote to SCAR] [Discard]",
    );
    expect(crowded.rendered).toContain("   Action: [Re-verify] [Prune]");

    // Verify [DEC] filename slug and decided tier-aware action line
    const decRoot = makeTempDir();
    initBrain({
      repoRoot: decRoot,
      signedBy: "Ian Mayor",
      now: new Date("2026-11-27T09:00:00Z"),
      envVars: {},
    });
    const decDiff = generateBrainDiff({
      brainDir: path.join(decRoot, ".brain"),
      repoRoot: decRoot,
      since: "7d",
      now: new Date("2026-11-28T09:00:00Z"),
    });
    expect(decDiff.rendered).toContain("[DEC] DEC-001 veribrain-baseline");
    expect(decDiff.rendered).toContain("   Action: [Keep] [Revise] [Deprecate/Revert]");
    for (const line of decDiff.rendered.trimEnd().split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
      expect(/^[\x20-\x7E]*$/.test(line)).toBe(true);
    }
  });

  it("enforces CUDE init receipt, pre-staging compile receipt, and redacted Exit 2/3/4 templates", () => {
    const root = makeTempDir();
    const brainDir = path.join(root, ".brain");

    const initRes = captureCli(["init", "--signed-by", "Ian Mayor", "--brain-dir", brainDir]);
    expect(initRes.code).toBe(EXIT_OK);
    expect(initRes.stdout).toContain("created: decided/DEC-001-veribrain-baseline.md");
    expect(initRes.stdout).toContain(
      "Initialized .brain/ (3 created, 0 skipped). Next: run veribrain eval.",
    );
    for (const line of initRes.stdout.trimEnd().split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }

    const obsRes = captureCli([
      "observe",
      "--claim-id",
      "OBS-ci-green",
      "--env",
      "pre-staging",
      "--git-sha",
      "abcdef1",
      "--ttl",
      "3600",
      "--summary",
      "Unit tests passed.",
      "--evidence",
      "ci:run/42",
      "--issuer",
      "ci",
      "--brain-dir",
      brainDir,
    ]);
    expect(obsRes.code).toBe(EXIT_OK);

    const jsonRes = captureCli([
      "compile",
      "--role",
      "builder",
      "--env",
      "pre-staging",
      "--format",
      "json",
      "--brain-dir",
      brainDir,
    ]);
    expect(jsonRes.code).toBe(EXIT_OK);
    const parsed = JSON.parse(jsonRes.stdout) as {
      zone_a_sha256: string;
      total_tokens_est: number;
    };
    expect(parsed.zone_a_sha256).toMatch(/^[0-9a-f]{64}$/);
    const receiptLine = jsonRes.stderr.trim();
    expect(receiptLine.length).toBeLessThanOrEqual(80);
    expect(receiptLine).toContain("evicted=0");
    expect(receiptLine).toMatch(/\dms$/);

    // Exit 3 (budget infeasible): zero stdout, blocking claim_id, actionable stderr
    const budgetRes = captureCli([
      "compile",
      "--role",
      "builder",
      "--env",
      "pre-staging",
      "--max-tokens",
      "5",
      "--brain-dir",
      brainDir,
    ]);
    expect(budgetRes.code).toBe(EXIT_BUDGET_INFEASIBLE);
    expect(budgetRes.stdout).toBe("");
    expect(budgetRes.stderr).toContain("ERROR [EXIT 3] BUDGET_INFEASIBLE");
    expect(budgetRes.stderr).toContain("claim_id: DEC-001");
    expect(budgetRes.stderr).toContain("fix:");

    // Exit 4 (agent observe denied): zero stdout
    const agentRes = captureCli(
      [
        "observe",
        "--claim-id",
        "OBS-denied",
        "--env",
        "staging",
        "--git-sha",
        "abcdef1",
        "--ttl",
        "60",
        "--summary",
        "Denied.",
        "--evidence",
        "ci:1",
        "--issuer",
        "ci",
        "--brain-dir",
        brainDir,
      ],
      { VERIBRAIN_AGENT_MODE: "true" },
    );
    expect(agentRes.code).toBe(EXIT_PROVENANCE_VIOLATION);
    expect(agentRes.stdout).toBe("");
    expect(agentRes.stderr).toContain("ERROR [EXIT 4] PROVENANCE_VIOLATION");

    // Exit 2 (quarantine): zero stdout, zero raw secret echo even when secret is in --claim-id
    const fakeSecret = "AIzaSySecretTokenShouldNeverEcho12345";
    const qRes = captureCli([
      "observe",
      "--claim-id",
      `OBS-${fakeSecret}`,
      "--env",
      "staging",
      "--git-sha",
      "abcdef1",
      "--ttl",
      "60",
      "--summary",
      "Clean summary",
      "--evidence",
      "ci:1",
      "--issuer",
      "ci",
      "--brain-dir",
      brainDir,
    ]);
    expect(qRes.code).toBe(EXIT_QUARANTINE_VIOLATION);
    expect(qRes.stdout).toBe("");
    expect(qRes.stderr).toContain("ERROR [EXIT 2] QUARANTINE_VIOLATION");
    expect(qRes.stderr).toContain("claim_id: <redacted-claim-id>");
    expect(qRes.stderr).not.toContain(fakeSecret);
    expect(qRes.stderr).not.toContain("AIza");
    expect(qRes.stderr).not.toContain("whitelist");
  });
});
