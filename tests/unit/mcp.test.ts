import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateBrainDiff } from "../../src/commands/diff.js";
import { initBrain } from "../../src/commands/init.js";
import { printMcpClientConfig, recordHypothesis } from "../../src/commands/mcp.js";
import { writeObservation } from "../../src/commands/observe.js";
import { createVeriBrainMcpServer } from "../../src/mcp/server.js";
import { clearFileReadCache } from "../../src/schema.js";
import { EXIT_ERROR, EXIT_OK, EXIT_PROVENANCE_VIOLATION, VeriBrainError } from "../../src/types.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");
const DIST_CLI = path.join(REPO_ROOT, "dist", "cli.js");

const tempDirs: string[] = [];

beforeAll(() => {
  if (!existsSync(DIST_CLI)) {
    const tscBin = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tscBin, "-p", "tsconfig.build.json"], { cwd: REPO_ROOT });
  }
});

function makeTempWorkspace(): { root: string; brainDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "veribrain-mcp-unit-"));
  tempDirs.push(root);
  const brainDir = path.join(root, ".brain");
  initBrain({ brainDir, repoRoot: root, signedBy: "Ian Mayor" });
  mkdirSync(path.join(root, "tests", "unit"), { recursive: true });
  writeFileSync(path.join(root, "tests", "unit", "sample.test.ts"), "// regression test\n", "utf8");
  writeObservation({
    claimId: "OBS-mcp-ci",
    env: "staging",
    gitSha: "abcdef1234",
    ttlSeconds: 3600,
    summary: "Staging MCP unit check passed.",
    evidenceRef: "ci:run/500",
    issuer: "ci",
    roles: ["builder"],
    brainDir,
    repoRoot: root,
    envVars: {},
  });
  return { root, brainDir };
}

function parseToolText(result: Record<string, unknown>): Record<string, unknown> {
  const arr = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const first = arr[0];
  expect(first?.type).toBe("text");
  return JSON.parse(first?.text ?? "{}") as Record<string, unknown>;
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

describe("VeriBrain local stdio MCP server & cross-client config", () => {
  it("prints valid JSON/TOML config, escapes TOML control chars, and scrubs invalid client errors", () => {
    for (const client of ["antigravity", "claude-code", "cursor"] as const) {
      const jsonOut = printMcpClientConfig(client, { brainDir: ".brain", repoRoot: "/repo" });
      const parsed = JSON.parse(jsonOut) as {
        mcpServers: { veribrain: { command: string; args: string[] } };
      };
      expect(parsed.mcpServers.veribrain.command).toBe("npx");
      expect(parsed.mcpServers.veribrain.args).toEqual([
        "-y",
        "veribrain",
        "mcp",
        "--brain-dir",
        ".brain",
        "--repo-root",
        "/repo",
      ]);
    }

    const codexOut = printMcpClientConfig("codex", {
      brainDir: 'path\nwith\r\ttabs\x07"and\\slash',
      repoRoot: ".",
    });
    expect(codexOut).toContain("[mcp_servers.veribrain]");
    expect(codexOut).toContain('command = "npx"');
    expect(codexOut).toContain('path\\nwith\\r\\ttabs\\u0007\\"and\\\\slash');
    expect(codexOut.split("\n").length).toBe(4);

    // CUDE P3: do NOT echo raw untrusted invalid client string
    const rawUnknown = "untrusted-evil-ide-999";
    try {
      printMcpClientConfig(rawUnknown);
      expect.unreachable("should reject unsupported client");
    } catch (err) {
      expect(err).toBeInstanceOf(VeriBrainError);
      const vb = err as VeriBrainError;
      expect(vb.exitCode).toBe(EXIT_ERROR);
      expect(vb.detail).toBe(
        "Unsupported MCP client. Expected one of: antigravity, claude-code, cursor, codex.",
      );
      expect(vb.detail).not.toContain(rawUnknown);
      expect(vb.message).not.toContain(rawUnknown);
    }
  });

  it("handles CLI mcp --bad-flag exit 1 and global-flag-first --brain-dir .brain mcp routing cleanly", async () => {
    // 1. node ./dist/cli.js mcp --bad-flag exits non-zero (1) with ERROR [EXIT 1] on stderr
    const badFlagRes = spawnSync(process.execPath, [DIST_CLI, "mcp", "--bad-flag"], {
      encoding: "utf8",
    });
    expect(badFlagRes.status).toBe(EXIT_ERROR);
    expect(badFlagRes.stdout).toBe("");
    expect(badFlagRes.stderr).toContain("ERROR [EXIT 1] CLI_ERROR");

    // 2. Global-flag-first: node ./dist/cli.js --brain-dir .brain mcp --print-config cursor exits 0
    const printFirstRes = spawnSync(
      process.execPath,
      [DIST_CLI, "--brain-dir", ".brain", "mcp", "--print-config", "cursor"],
      { encoding: "utf8" },
    );
    expect(printFirstRes.status).toBe(EXIT_OK);
    const parsed = JSON.parse(printFirstRes.stdout) as {
      mcpServers: { veribrain: { command: string; args: string[] } };
    };
    expect(parsed.mcpServers.veribrain.command).toBe("npx");
    expect(parsed.mcpServers.veribrain.args).toContain(".brain");

    // 3. Global-flag-first MCP server launch works over real StdioClientTransport
    const { root, brainDir } = makeTempWorkspace();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_CLI, "--brain-dir", brainDir, "--repo-root", root, "mcp"],
      stderr: "pipe",
    });
    const client = new Client({ name: "global-flag-mcp-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(7);
    } finally {
      await client.close();
    }
  });

  it("enforces Security P2/P3 bounds: intra-.brain symlink rejection, hint <= 4096 B, roles <= 32, HYP id <= 64 chars", () => {
    const { root, brainDir } = makeTempWorkspace();

    // P3-G3-2: HYP- id > 64 total chars rejected; 64 total chars accepted
    const tooLongId = `HYP-${"a".repeat(61)}`; // 65 chars
    expect(tooLongId.length).toBe(65);
    try {
      recordHypothesis({ id: tooLongId, hint: "valid hint", brainDir, repoRoot: root });
      expect.unreachable("65-char HYP id must fail");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
      expect((err as VeriBrainError).rule).toBe("invalid_hypothesis_id");
    }

    const maxValidId = `HYP-${"a".repeat(60)}`; // 64 chars
    expect(maxValidId.length).toBe(64);
    const okRec = recordHypothesis({
      id: maxValidId,
      hint: "valid max-length id",
      brainDir,
      repoRoot: root,
    });
    expect(okRec.record.id).toBe(maxValidId);

    // P2-G3-2: hint > 4096 UTF-8 bytes rejected (including multi-byte UTF-8)
    try {
      recordHypothesis({
        id: "HYP-big-ascii",
        hint: "a".repeat(4097),
        brainDir,
        repoRoot: root,
      });
      expect.unreachable("> 4096 B hint must fail");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_ERROR);
      expect((err as VeriBrainError).rule).toBe("hint_size_limit_exceeded");
    }

    // 2000 3-byte chars = 6000 UTF-8 bytes (> 4096 B even though string.length < 4096)
    try {
      recordHypothesis({
        id: "HYP-big-utf8",
        hint: "\u20AC".repeat(2000),
        brainDir,
        repoRoot: root,
      });
      expect.unreachable("> 4096 UTF-8 bytes hint must fail");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_ERROR);
      expect((err as VeriBrainError).rule).toBe("hint_size_limit_exceeded");
    }

    // P2-G3-2: roles > 32 items rejected
    const tooManyRoles = Array.from({ length: 33 }, (_, i) => `role-${i}`);
    try {
      recordHypothesis({
        id: "HYP-many-roles",
        hint: "valid hint",
        roles: tooManyRoles,
        brainDir,
        repoRoot: root,
      });
      expect.unreachable("> 32 roles must fail");
    } catch (err) {
      expect((err as VeriBrainError).exitCode).toBe(EXIT_ERROR);
      expect((err as VeriBrainError).rule).toBe("roles_limit_exceeded");
    }

    // P2-G3-1: intra-.brain/ symlink hypotheses -> observed MUST be rejected (runs where OS/sandbox allows symlinks)
    const symWs = makeTempWorkspace();
    const symHypDir = path.join(symWs.brainDir, "hypotheses");
    const symObsDir = path.join(symWs.brainDir, "observed");
    rmSync(symHypDir, { recursive: true, force: true });
    let symlinkCreated = false;
    try {
      symlinkSync(symObsDir, symHypDir, process.platform === "win32" ? "junction" : "dir");
      symlinkCreated = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES") {
        throw err;
      }
    }
    if (symlinkCreated) {
      try {
        recordHypothesis({
          id: "HYP-symlink-escape",
          hint: "Attempt write into observed via intra-brain symlink",
          brainDir: symWs.brainDir,
          repoRoot: symWs.root,
        });
        expect.unreachable("intra-brain symlink hypotheses->observed must fail");
      } catch (err) {
        expect((err as VeriBrainError).exitCode).toBe(EXIT_PROVENANCE_VIOLATION);
        expect((err as VeriBrainError).rule).toBe("path_confinement_violation");
      }
      expect(existsSync(path.join(symObsDir, "HYP-symlink-escape.json"))).toBe(false);
    }
  });

  it("exposes exact 7 tools with read-only / Tier-3 boundaries, veribrain_list_claims, veribrain_stats, and fail-closed quarantine", async () => {
    const { root, brainDir } = makeTempWorkspace();
    const server = createVeriBrainMcpServer({ brainDir, repoRoot: root });
    const client = new Client({ name: "veribrain-unit-test", version: "1.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      // 1. Exact 7 tools registered
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "veribrain_compile_context",
        "veribrain_get_claim",
        "veribrain_list_claims",
        "veribrain_propose_scar",
        "veribrain_record_hypothesis",
        "veribrain_stats",
        "veribrain_status",
      ]);

      const byName = new Map(listed.tools.map((t) => [t.name, t]));
      expect(byName.get("veribrain_compile_context")?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get("veribrain_get_claim")?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get("veribrain_list_claims")?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get("veribrain_list_claims")?.annotations?.idempotentHint).toBe(true);
      expect(byName.get("veribrain_stats")?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get("veribrain_stats")?.annotations?.idempotentHint).toBe(true);
      expect(byName.get("veribrain_status")?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get("veribrain_record_hypothesis")?.annotations?.readOnlyHint).toBe(false);
      expect(byName.get("veribrain_propose_scar")?.annotations?.readOnlyHint).toBe(false);

      // 2. veribrain_compile_context (with markdown + included_*_ids)
      const compileRes = await client.callTool({
        name: "veribrain_compile_context",
        arguments: { role: "builder", env: "staging", git_sha: "abcdef1234", format: "md" },
      });
      expect(compileRes.isError).toBeFalsy();
      const compiled = parseToolText(compileRes);
      expect(compiled.zone_a_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(compiled.included_decided_ids).toEqual(["DEC-001"]);
      expect(compiled.included_observed_ids).toEqual(["OBS-mcp-ci"]);
      expect(String(compiled.zone_b)).toContain("Based on: OBS-mcp-ci (staging@abcdef1234)");
      expect(String(compiled.markdown)).toContain("<!-- VERIBRAIN:ZONE_BOUNDARY:A_END -->");

      // 3. veribrain_get_claim (DEC, OBS, and safe not-found)
      const decRes = await client.callTool({
        name: "veribrain_get_claim",
        arguments: { claim_id: "DEC-001" },
      });
      expect(decRes.isError).toBeFalsy();
      expect(parseToolText(decRes).tier).toBe("DECIDED");

      const obsRes = await client.callTool({
        name: "veribrain_get_claim",
        arguments: { claim_id: "OBS-mcp-ci" },
      });
      expect(obsRes.isError).toBeFalsy();
      expect(parseToolText(obsRes).tier).toBe("OBSERVED");

      const missingRes = await client.callTool({
        name: "veribrain_get_claim",
        arguments: { claim_id: "DEC-999" },
      });
      expect(missingRes.isError).toBe(true);
      expect(parseToolText(missingRes).error).toBe("CLAIM_NOT_FOUND");

      // 4. veribrain_record_hypothesis: rejects secret, oversize hint, oversize roles, traversal & > 7d TTL
      const fakeSecret = "AIzaSyMcpSecretMustNeverEcho1234567";
      const badHyp = await client.callTool({
        name: "veribrain_record_hypothesis",
        arguments: { id: "HYP-secret-test", hint: `Leaked ${fakeSecret}` },
      });
      expect(badHyp.isError).toBe(true);
      const badHypText = JSON.stringify(badHyp.content);
      expect(badHypText).not.toContain(fakeSecret);
      expect(badHypText).not.toContain("AIza");
      expect(existsSync(path.join(brainDir, "hypotheses", "HYP-secret-test.json"))).toBe(false);

      const bigHintHyp = await client.callTool({
        name: "veribrain_record_hypothesis",
        arguments: { id: "HYP-oversize", hint: "x".repeat(4097) },
      });
      expect(bigHintHyp.isError).toBe(true);

      const manyRolesHyp = await client.callTool({
        name: "veribrain_record_hypothesis",
        arguments: {
          id: "HYP-roles",
          hint: "ok",
          roles: Array.from({ length: 33 }, (_, i) => `r${i}`),
        },
      });
      expect(manyRolesHyp.isError).toBe(true);

      const travHyp = await client.callTool({
        name: "veribrain_record_hypothesis",
        arguments: { id: "../decided/DEC-EVIL", hint: "Escape attempt" },
      });
      expect(travHyp.isError).toBe(true);

      const longTtlHyp = await client.callTool({
        name: "veribrain_record_hypothesis",
        arguments: { id: "HYP-long", hint: "Too long", ttl_days: 14 },
      });
      expect(longTtlHyp.isError).toBe(true);

      // Valid Tier 3 hypothesis write
      const goodHyp = await client.callTool({
        name: "veribrain_record_hypothesis",
        arguments: { id: "HYP-unit-01", hint: "Check cache hit floor on staging.", ttl_days: 5 },
      });
      expect(goodHyp.isError).toBeFalsy();
      expect(existsSync(path.join(brainDir, "hypotheses", "HYP-unit-01.json"))).toBe(true);

      // 5. veribrain_propose_scar: NEVER mutates scars.md; validates test file existence
      const scarsBefore = readFileSync(path.join(brainDir, "scars.md"), "utf8");
      const badTestScar = await client.callTool({
        name: "veribrain_propose_scar",
        arguments: {
          hint: "Missing regression test.",
          regression_test: "tests/unit/does-not-exist.test.ts#L1",
        },
      });
      expect(badTestScar.isError).toBe(true);

      const goodScar = await client.callTool({
        name: "veribrain_propose_scar",
        arguments: {
          id: "HYP-SCAR-unit-01",
          hint: "Never mutate Zone A header order.",
          regression_test: "tests/unit/sample.test.ts#L1",
          ttl_days: 30,
        },
      });
      expect(goodScar.isError).toBeFalsy();
      const goodScarData = parseToolText(goodScar);
      expect(goodScarData.kind).toBe("scar_proposal");
      expect(goodScarData.queued_for_human_review).toBe(true);
      expect(existsSync(path.join(brainDir, "hypotheses", "HYP-SCAR-unit-01.json"))).toBe(true);
      expect(readFileSync(path.join(brainDir, "scars.md"), "utf8")).toBe(scarsBefore);

      // Surfaces in veribrain diff and veribrain_get_claim
      const diff = generateBrainDiff({ brainDir, repoRoot: root });
      expect(diff.rendered).toContain("HYP-SCAR-unit-01");

      const scarClaim = await client.callTool({
        name: "veribrain_get_claim",
        arguments: { claim_id: "HYP-SCAR-unit-01" },
      });
      expect(scarClaim.isError).toBeFalsy();
      expect(parseToolText(scarClaim).tier).toBe("HYPOTHESIS");

      // 6. veribrain_status reflects counts, scars_bytes, and pending_scar_proposals
      const statusRes = await client.callTool({
        name: "veribrain_status",
        arguments: { env: "staging" },
      });
      expect(statusRes.isError).toBeFalsy();
      const status = parseToolText(statusRes);
      expect(status.healthy).toBe(true);
      expect((status.counts as Record<string, number>).pending_scar_proposals).toBe(1);
      expect((status.counts as Record<string, number>).hypotheses).toBe(2);
      expect((status.counts as Record<string, number>).decided).toBe(1);
      expect((status.counts as Record<string, number>).observed).toBe(1);
      expect(status.scars_max_bytes).toBe(4096);

      // 7. veribrain_list_claims filters by tier, prefix, role, and caps limit <= 100
      const listAllRes = await client.callTool({
        name: "veribrain_list_claims",
        arguments: { limit: 200 },
      });
      expect(listAllRes.isError).toBeFalsy();
      const listAll = parseToolText(listAllRes);
      expect(listAll.limit).toBe(100);
      expect(listAll.total_matched).toBe(4);
      expect((listAll.counts as Record<string, number>).pending_scar_proposals).toBe(1);

      const listHypRes = await client.callTool({
        name: "veribrain_list_claims",
        arguments: { tier: "hypothesis", prefix: "HYP-SCAR-", role: "cpm", limit: 5 },
      });
      expect(listHypRes.isError).toBeFalsy();
      const listHyp = parseToolText(listHypRes);
      const hypItems = listHyp.claims as Array<Record<string, unknown>>;
      expect(hypItems).toHaveLength(1);
      expect(hypItems[0]?.id).toBe("HYP-SCAR-unit-01");
      expect(hypItems[0]?.kind).toBe("scar_proposal");
      expect(hypItems[0]?.regression_test).toBe("tests/unit/sample.test.ts#L1");

      const listDecRes = await client.callTool({
        name: "veribrain_list_claims",
        arguments: { tier: "decided", role: "cpm" },
      });
      expect(listDecRes.isError).toBeFalsy();
      const decItems = parseToolText(listDecRes).claims as Array<Record<string, unknown>>;
      expect(decItems).toHaveLength(1);
      expect(decItems[0]?.id).toBe("DEC-001");
      expect(String(decItems[0]?.sha256_body)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
