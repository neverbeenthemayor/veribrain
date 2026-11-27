import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  getBrainStatus,
  getClaimById,
  type ListClaimsTier,
  listClaims,
  printMcpClientConfig,
  proposeScar,
  recordHypothesis,
} from "../commands/mcp.js";
import { formatStatsMarkdown, runStats } from "../commands/stats.js";
import { compileContext, formatCompiledMarkdown } from "../compiler.js";
import {
  sanitizeQuarantineClaimId,
  sanitizeQuarantineField,
  scanTextForQuarantine,
} from "../quarantine.js";
import { resolveBrainPaths } from "../schema.js";
import {
  type CompileOptions,
  type EnvName,
  EXIT_ERROR,
  EXIT_QUARANTINE_VIOLATION,
  VeriBrainError,
  type ZoneALayout,
} from "../types.js";

export { printMcpClientConfig };

const MCP_SERVER_VERSION = "1.3.0";

export interface VeriBrainMcpServerOptions {
  brainDir?: string;
  repoRoot?: string;
}

function toMcpSuccess(payload: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function scrubDetailForMcp(detail: string): string {
  if (scanTextForQuarantine(detail, { claimId: "mcp" }) !== null) {
    return "Error detail redacted for safety (sensitive pattern detected).";
  }
  return detail;
}

function toMcpError(err: unknown): CallToolResult {
  if (err instanceof VeriBrainError) {
    const safeClaimId =
      err.exitCode === EXIT_QUARANTINE_VIOLATION
        ? sanitizeQuarantineClaimId(err.claimId)
        : scanTextForQuarantine(err.claimId, { claimId: "mcp" }) !== null
          ? "<redacted-claim-id>"
          : err.claimId;
    const safeRule = sanitizeQuarantineField(err.rule);
    const safeDetail = scrubDetailForMcp(err.detail);
    const safeFix = scrubDetailForMcp(err.fix);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: err.code,
              exit_code: err.exitCode,
              claim_id: safeClaimId,
              rule: safeRule,
              detail: safeDetail,
              fix: safeFix,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const rawMsg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: "INTERNAL_ERROR",
            exit_code: EXIT_ERROR,
            claim_id: "mcp",
            rule: "internal_error",
            detail: scrubDetailForMcp(rawMsg),
            fix: "Inspect inputs and run veribrain eval --strict.",
          },
          null,
          2,
        ),
      },
    ],
  };
}

export function createVeriBrainMcpServer(options: VeriBrainMcpServerOptions = {}): McpServer {
  const { brainDir, repoRoot } = resolveBrainPaths(options.brainDir, options.repoRoot);

  const server = new McpServer(
    {
      name: "veribrain",
      version: MCP_SERVER_VERSION,
    },
    {
      maxToolInputElements: 1000,
    },
  );

  // 1. veribrain_compile_context (Read-Only)
  server.registerTool(
    "veribrain_compile_context",
    {
      title: "Compile Two-Zone Context",
      description:
        "Read-only deterministic compiler returning byte-frozen Zone A static prefix (with zone_a_sha256), uncached Zone B cited tail, and token/latency telemetry.",
      inputSchema: {
        role: z.string().describe("Target engineering role (e.g. builder, cqe, security)"),
        env: z
          .enum(["local", "pre-staging", "staging", "prod"])
          .describe("Target environment filter"),
        git_sha: z.string().optional().describe("Optional 7-40 hex git commit SHA filter"),
        max_tokens: z
          .number()
          .optional()
          .describe("Optional token budget ceiling (fails closed if pinned P0/P1 infeasible)"),
        format: z
          .enum(["md", "json"])
          .optional()
          .describe('Optional output mode; pass "md" to include rendered markdown'),
        zone_a_layout: z
          .enum(["legacy", "split"])
          .optional()
          .describe('Optional Zone A layout override ("legacy" or "split" for A0+A1)'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => {
      try {
        const compileOpts: CompileOptions = {
          role: args.role,
          env: args.env as EnvName,
          metricSource: "mcp",
          brainDir,
          repoRoot,
        };
        if (args.git_sha !== undefined) {
          compileOpts.gitSha = args.git_sha;
        }
        if (args.max_tokens !== undefined) {
          compileOpts.maxTokens = args.max_tokens;
        }
        if (args.zone_a_layout !== undefined) {
          compileOpts.zoneALayout = args.zone_a_layout as ZoneALayout;
        }
        const result = compileContext(compileOpts);
        const payload =
          args.format === "md" ? { ...result, markdown: formatCompiledMarkdown(result) } : result;
        return toMcpSuccess(payload);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  // 2. veribrain_get_claim (Read-Only)
  server.registerTool(
    "veribrain_get_claim",
    {
      title: "Get Verified Claim Evidence",
      description:
        "Read-only lookup returning full quarantine-verified evidence for a specific DEC-*, OBS-*, SCAR-*, or HYP-* claim ID.",
      inputSchema: {
        claim_id: z.string().describe("Claim identifier (DEC-*, OBS-*, SCAR-*, or HYP-*)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => {
      try {
        const claim = getClaimById(args.claim_id, { brainDir, repoRoot });
        if (claim === null) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: "CLAIM_NOT_FOUND",
                    exit_code: EXIT_ERROR,
                    claim_id: args.claim_id.trim(),
                    rule: "claim_not_found",
                    detail: `No claim found matching ${args.claim_id.trim()}.`,
                    fix: "Check claim ID via veribrain_status or .brain/ directory.",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        return toMcpSuccess(claim);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  // 3. veribrain_record_hypothesis (Tier 3 Only)
  server.registerTool(
    "veribrain_record_hypothesis",
    {
      title: "Record Tier 3 Agent Hypothesis",
      description:
        "Tier 3 write-only intake: validates TTL (<= 7d), scrubs secrets/PII fail-closed, and writes atomically ONLY inside .brain/hypotheses/HYP-*.json. Never writes DECIDED, OBSERVED, or scars.md.",
      inputSchema: {
        hint: z
          .string()
          .max(4096)
          .describe("Non-authoritative hypothesis text (<= 4096 UTF-8 bytes, quarantine-scrubbed)"),
        roles: z
          .array(z.string().max(64))
          .max(32)
          .optional()
          .describe('Optional target roles (max 32; defaults to ["*"])'),
        ttl_days: z.number().optional().describe("TTL in days (integer 1..7, default 7)"),
        id: z
          .string()
          .optional()
          .describe("Optional HYP-* identifier (<= 64 chars; auto-generated if omitted)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) => {
      try {
        const res = recordHypothesis({
          hint: args.hint,
          ...(args.roles !== undefined ? { roles: args.roles } : {}),
          ...(args.ttl_days !== undefined ? { ttlDays: args.ttl_days } : {}),
          ...(args.id !== undefined ? { id: args.id } : {}),
          ...(options.brainDir !== undefined ? { brainDir } : {}),
          repoRoot,
        });
        return toMcpSuccess({
          ok: true,
          tier: "HYPOTHESIS",
          id: res.record.id,
          created_at_utc: res.record.created_at_utc,
          expires_at_utc: res.record.expires_at_utc,
          roles: res.record.roles,
          rendered_hint: res.rendered_hint,
        });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  // 4. veribrain_propose_scar (Tier 3 Proposal Only)
  server.registerTool(
    "veribrain_propose_scar",
    {
      title: "Propose Scar Candidate (Tier 3 Queue)",
      description:
        "Tier 3 scar proposal: validates repo-relative regression_test file existence, verifies scars.md < 4,096 B headroom, scrubs secrets/PII fail-closed, and queues ONLY as .brain/hypotheses/HYP-SCAR-*.json for human veribrain diff approval. Never mutates scars.md directly.",
      inputSchema: {
        hint: z.string().describe("Single factual anti-pattern hint (quarantine-scrubbed)"),
        regression_test: z
          .string()
          .describe("Repo-relative regression test path (e.g. tests/unit/compiler.test.ts#L1)"),
        roles: z.array(z.string()).optional().describe('Optional target roles (defaults to ["*"])'),
        ttl_days: z
          .number()
          .optional()
          .describe("Proposed scar TTL in days (integer 1..30, default 30)"),
        id: z
          .string()
          .optional()
          .describe("Optional HYP-SCAR-* proposal identifier (auto-generated if omitted)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) => {
      try {
        const res = proposeScar({
          hint: args.hint,
          regressionTest: args.regression_test,
          ...(args.roles !== undefined ? { roles: args.roles } : {}),
          ...(args.ttl_days !== undefined ? { ttlDays: args.ttl_days } : {}),
          ...(args.id !== undefined ? { id: args.id } : {}),
          ...(options.brainDir !== undefined ? { brainDir } : {}),
          repoRoot,
        });
        return toMcpSuccess({
          ok: true,
          tier: "HYPOTHESIS",
          kind: "scar_proposal",
          id: res.record.id,
          created_at_utc: res.record.created_at_utc,
          expires_at_utc: res.record.expires_at_utc,
          proposed_ttl_days: res.record.proposed_ttl_days,
          regression_test: res.record.regression_test,
          roles: res.record.roles,
          scars_bytes: res.scars_bytes,
          scars_max_bytes: res.scars_max_bytes,
          queued_for_human_review: res.queued_for_human_review,
          rendered_hint: res.rendered_hint,
        });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  // 5. veribrain_status (Read-Only)
  server.registerTool(
    "veribrain_status",
    {
      title: "Inspect VeriBrain Health & Budgets",
      description:
        "Read-only health report returning .brain/ counts, scars.md byte budget, expired claim counts, pending scar proposals, and eval verdict.",
      inputSchema: {
        env: z
          .enum(["local", "pre-staging", "staging", "prod"])
          .optional()
          .describe("Optional environment filter for observed counts"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => {
      try {
        const status = getBrainStatus({
          ...(args.env !== undefined ? { env: args.env as EnvName } : {}),
          brainDir,
          repoRoot,
        });
        return toMcpSuccess(status);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  // 6. veribrain_list_claims (Read-Only)
  server.registerTool(
    "veribrain_list_claims",
    {
      title: "List Verified Claims & Pending Queues",
      description:
        "Read-only structured claim listing filtered by tier, ID prefix, role, and limit (capped <= 100) with quarantine-scrubbed summaries and total counts.",
      inputSchema: {
        tier: z
          .enum(["all", "decided", "observed", "hypothesis", "scar"])
          .optional()
          .describe('Optional tier filter (default: "all")'),
        prefix: z
          .string()
          .max(64)
          .optional()
          .describe("Optional claim ID prefix filter (e.g. DEC-, OBS-, HYP-FB-)"),
        role: z.string().max(64).optional().describe("Optional target role filter"),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Optional max items returned (default 50, capped at 100)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => {
      try {
        const result = listClaims({
          ...(args.tier !== undefined ? { tier: args.tier as ListClaimsTier } : {}),
          ...(args.prefix !== undefined ? { prefix: args.prefix } : {}),
          ...(args.role !== undefined ? { role: args.role } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          brainDir,
          repoRoot,
        });
        return toMcpSuccess(result);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  // 7. veribrain_stats (Read-Only)
  server.registerTool(
    "veribrain_stats",
    {
      title: "Inspect Local ROI & Token-Savings Telemetry",
      description:
        "Read-only local telemetry report summarizing compile counts, Zone A0 KV-cache reuse, and baseline doc token avoidance from opt-in .brain/.metrics.jsonl.",
      inputSchema: {
        since: z
          .string()
          .max(64)
          .optional()
          .describe('Optional lookback window ("24h", "7d", "30d", or "all"; default: "30d")'),
        format: z
          .enum(["json", "md"])
          .optional()
          .describe('Optional output mode; pass "md" to include rendered markdown'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => {
      try {
        const result = runStats({
          ...(args.since !== undefined ? { since: args.since } : {}),
          brainDir,
          repoRoot,
        });
        const payload =
          args.format === "md" ? { ...result, markdown: formatStatsMarkdown(result) } : result;
        return toMcpSuccess(payload);
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  return server;
}

export async function startMcpStdioServer(options: VeriBrainMcpServerOptions = {}): Promise<void> {
  const server = createVeriBrainMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
