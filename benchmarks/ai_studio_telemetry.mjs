import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearFileReadCache,
  compileContext,
  estimateTokens,
  evaluateBrain,
  formatCompiledMarkdown,
  renderUntrustedHint,
  ZONE_BOUNDARY_MARKER,
} from "../dist/index.js";
import { applyTurnZoneBDelta, CANONICAL_NOW_ISO, createBenchmarkWorkspace } from "./corpus.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "results");
const DRYRUN_OUTPUT_PATH = path.join(RESULTS_DIR, "ai-studio-dryrun.json");
const LIVE_OUTPUT_PATH = path.join(RESULTS_DIR, "ai-studio-live.json");

const DEFAULT_MODEL = "gemini-4-hydrogen";
const DEFAULT_MAX_USD = 1.0;
const ABSOLUTE_HARD_CAP_USD = 4.0;
const INTER_TURN_DELAY_MS = 2000;
const MAX_OUTPUT_TOKENS = 512;
const COUNT_TOKENS_API_REVISION = "2026-05-20";

function thinkingLevelForModel(model) {
  return model === "gemini-3.5-flash-lite" ? "minimal" : "low";
}

/**
 * Current Gemini 4 / 3.5 allowlist with conservative upper-bound USD per 1M tokens
 * used strictly for fail-closed pre-flight budget gating (never presented as invoiced cost).
 */
const ALLOWED_MODELS = {
  "gemini-4-hydrogen": { maxInputUsdPer1M: 1.5, maxOutputUsdPer1M: 6.0 },
  "gemini-3.5-flash-lite": { maxInputUsdPer1M: 0.5, maxOutputUsdPer1M: 2.0 },
  "gemini-4-argon": { maxInputUsdPer1M: 2.5, maxOutputUsdPer1M: 10.0 },
  "gemini-4-neon": { maxInputUsdPer1M: 4.0, maxOutputUsdPer1M: 16.0 },
  "gemini-4-carbon": { maxInputUsdPer1M: 6.0, maxOutputUsdPer1M: 24.0 },
};

const DEPRECATED_MODEL_RE = /^gemini-(?:2\.5|2\.0|1\.5|1\.0)(?:[-.]|$)/i;

const TURN_QUESTIONS = [
  "Turn 1: Which exit code must VeriBrain emit when a DECIDED rule sha256_body is tampered, and which policy governs it? Cite claim IDs in <= 25 words.",
  "Turn 2: What exact eviction order applies when total tokens exceed --max-tokens, and can P0/P1 DECIDED rules be evicted? Cite claim IDs in <= 25 words.",
  "Turn 3: Based on staging OBSERVED records, did Golden Context Evals pass, and which env observations were excluded? Cite claim IDs in <= 25 words.",
  "Turn 4: How must Tier 3 scars and hypotheses be wrapped before emission, and may they override DECIDED rules? Cite claim IDs in <= 25 words.",
  "Turn 5: What are the strict byte ceiling and maximum TTL for .brain/scars.md, and how is regression_test validated? Cite claim IDs in <= 25 words.",
  "Turn 6: Summarize the zero-custody credential rule and runtime dependency requirement for VeriBrain. Cite claim IDs in <= 25 words.",
];

function sha256(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function round4(n) {
  return Number(n.toFixed(4));
}

function round6(n) {
  return Number(n.toFixed(6));
}

function firstByteDivergence(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  const len = Math.min(bufA.length, bufB.length);
  for (let i = 0; i < len; i += 1) {
    if (bufA[i] !== bufB[i]) {
      return i;
    }
  }
  return bufA.length === bufB.length ? -1 : len;
}

function parseArgs(argv) {
  let mode = "dry-run";
  let model = DEFAULT_MODEL;
  let maxUsd = DEFAULT_MAX_USD;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--dry-run") {
      mode = "dry-run";
    } else if (arg === "--live") {
      mode = "live";
    } else if (arg === "--model") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("Missing value after --model.");
      }
      model = next.trim();
      i += 1;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length).trim();
    } else if (arg === "--max-usd") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("Missing value after --max-usd.");
      }
      maxUsd = Number(next);
      i += 1;
    } else if (arg.startsWith("--max-usd=")) {
      maxUsd = Number(arg.slice("--max-usd=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}. Run with --help for usage.`);
    }
  }

  return { mode, model, maxUsd, help };
}

function printHelp() {
  console.log(
    [
      "VeriBrain Stage 2 Gemini 4 AI Studio Telemetry Runner (Zero-Dep Node 24 fetch)",
      "",
      "Usage:",
      "  node benchmarks/ai_studio_telemetry.mjs [--dry-run] [--model <id>] [--max-usd <n>]",
      "  ./scripts/run_with_key.ps1 GEMINI_API_KEY node benchmarks/ai_studio_telemetry.mjs --live [--model <id>] [--max-usd <n>]",
      "",
      "Options:",
      `  --dry-run          Default ($0.00). Compiles payloads, verifies 6/6 vs 0/6 prefix stability, estimates max spend.`,
      `  --live             Calls Gemini 4 countTokens + Interactions API using process.env.GEMINI_API_KEY only.`,
      `  --model <id>       Allowed: ${Object.keys(ALLOWED_MODELS).join(", ")} (default: ${DEFAULT_MODEL}).`,
      `                     Deprecated gemini-2.5/2.0/1.5 models are strictly rejected.`,
      `  --max-usd <n>      Pre-flight hard spend ceiling in USD (default: ${DEFAULT_MAX_USD.toFixed(2)}, absolute cap: ${ABSOLUTE_HARD_CAP_USD.toFixed(2)}).`,
      "",
    ].join("\n"),
  );
}

function validateModelAndBudget(model, maxUsd) {
  if (DEPRECATED_MODEL_RE.test(model)) {
    throw new Error(
      `Rejected deprecated model "${model}". Legacy gemini-2.5/2.0/1.5 models are forbidden; use one of: ${Object.keys(ALLOWED_MODELS).join(", ")}.`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_MODELS, model)) {
    throw new Error(
      `Unsupported model "${model}". Allowed Gemini 4 / 3.5 models: ${Object.keys(ALLOWED_MODELS).join(", ")}.`,
    );
  }
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
    throw new Error(`--max-usd must be a positive finite number (received ${maxUsd}).`);
  }
  if (maxUsd > ABSOLUTE_HARD_CAP_USD) {
    throw new Error(
      `--max-usd (${maxUsd.toFixed(2)}) exceeds absolute Stage 2 safety cap ($${ABSOLUTE_HARD_CAP_USD.toFixed(2)} < $5.00). Aborting fail-closed.`,
    );
  }
}

function buildCalibrationPayloads(canonicalWs, canonicalCompile, cacheWs, cacheCompile) {
  const decidedDir = path.join(canonicalWs.brainDir, "decided");
  const decidedFiles = readdirSync(decidedDir).filter((f) => f.endsWith(".md")).sort();
  const observedDir = path.join(canonicalWs.brainDir, "observed");
  const observedFiles = readdirSync(observedDir)
    .filter((f) => f.endsWith(".json") && f.startsWith("OBS-1"))
    .sort();

  // Extract individual decided sections from compiled Zone A for exact sub-slices
  const decidedSections = canonicalCompile.zone_a.split("\n### [");
  const zoneAHeader = decidedSections[0];
  const ruleBlocks = decidedSections.slice(1).map((s) => `### [${s}`);

  const zoneASmall = `${zoneAHeader}\n${ruleBlocks.slice(0, 4).join("\n")}\n`;
  const zoneAMedium = `${zoneAHeader}\n${ruleBlocks.slice(0, 10).join("\n")}\n`;
  const zoneALarge = canonicalCompile.zone_a;

  // Zone B observed-only slice
  const hintsIdx = canonicalCompile.zone_b.indexOf("\n## Untrusted Hints");
  const zoneBObservedOnly =
    hintsIdx === -1
      ? canonicalCompile.zone_b
      : `${canonicalCompile.zone_b.slice(0, hintsIdx).trimEnd()}\n`;

  // Zone B untrusted_hint XML slice
  const zoneBHintsXml =
    hintsIdx === -1
      ? renderUntrustedHint({ source: "hypothesis", id: "HYP-EMPTY", body: "No hints." })
      : `${canonicalCompile.zone_b.slice(hintsIdx).trim()}\n`;

  // Dense YAML frontmatter concatenation
  const yamlFrontmatters = decidedFiles
    .map((f) => {
      const raw = readFileSync(path.join(decidedDir, f), "utf8");
      const end = raw.indexOf("\n---", 3);
      return end === -1 ? raw : raw.slice(0, end + 4);
    })
    .join("\n\n");

  // Dense JSON observed concatenation
  const denseJsonObserved = observedFiles
    .map((f) => readFileSync(path.join(observedDir, f), "utf8").trim())
    .join("\n");

  const fullCompiledTwoZone = formatCompiledMarkdown(canonicalCompile);

  const specs = [
    { id: "zone_a_small", label: "Zone A Small (4 DECIDED)", text: zoneASmall, blocks: 5 },
    { id: "zone_a_medium", label: "Zone A Medium (10 DECIDED)", text: zoneAMedium, blocks: 11 },
    {
      id: "zone_a_canonical_large",
      label: "Zone A Canonical (18 DECIDED >= 4,096 tok)",
      text: zoneALarge,
      blocks: 1 + canonicalWs.counts.decided,
    },
    {
      id: "zone_a_gemini4_cache_profile",
      label: "Zone A Gemini 4 Cache Profile (32 DECIDED, clears 6,146 tail window)",
      text: cacheCompile.zone_a,
      blocks: 1 + cacheWs.counts.decided,
    },
    {
      id: "zone_b_observed_citations",
      label: "Zone B Observed Facts + Citations",
      text: zoneBObservedOnly,
      blocks: 1 + canonicalWs.counts.observed_fresh,
    },
    {
      id: "zone_b_untrusted_hints_xml",
      label: "Zone B <untrusted_hint> XML Blocks",
      text: zoneBHintsXml,
      blocks: canonicalWs.counts.scars + canonicalWs.counts.hypotheses,
    },
    {
      id: "dense_yaml_frontmatter",
      label: "Dense YAML Frontmatter Headers",
      text: yamlFrontmatters,
      blocks: decidedFiles.length,
    },
    {
      id: "dense_json_observed",
      label: "Dense JSON Observed Payloads",
      text: denseJsonObserved,
      blocks: observedFiles.length,
    },
    {
      id: "full_compiled_two_zone",
      label: "Full Compiled Two-Zone (Zone A + Boundary + Zone B)",
      text: fullCompiledTwoZone,
      blocks:
        2 +
        canonicalWs.counts.decided +
        canonicalWs.counts.observed_fresh +
        canonicalWs.counts.scars +
        canonicalWs.counts.hypotheses,
    },
  ];

  return specs.map((spec) => {
    const utf8Bytes = Buffer.byteLength(spec.text, "utf8");
    const estTokens = estimateTokens(
      spec.text,
      spec.blocks,
      canonicalCompile.chars_per_token,
      canonicalCompile.safety_margin,
    );
    return {
      ...spec,
      utf8_bytes: utf8Bytes,
      chars: spec.text.length,
      est_tokens: estTokens,
      sha256: sha256(spec.text),
    };
  });
}

function buildNaiveArmASystemInstruction(turnIndex, deltaIso, latestObsId, compileRes) {
  // Fair controlled A/B baseline: exact same policies, but prepends volatile dynamic metadata
  // at byte 0 of system_instruction, busting implicit prefix KV caching every turn.
  return [
    "# Naive Dynamic Context",
    `turn_index: ${turnIndex}`,
    `compiled_at_utc: ${deltaIso}`,
    `env: ${compileRes.env}`,
    `git_sha: ${compileRes.git_sha}`,
    `latest_observation: ${latestObsId}`,
    "",
    compileRes.zone_a,
  ].join("\n");
}

function buildDynamicInputTail(compileRes, question) {
  return `${ZONE_BOUNDARY_MARKER}\n\n${compileRes.zone_b}\n## Task\n${question}\n`;
}

function buildCompactTurnDeltaInput(turnIndex, obsId, gitSha, question) {
  return [
    "# VeriBrain Context - Zone B Turn Delta",
    `### ${obsId}`,
    `Turn ${turnIndex} staging telemetry check green: deterministic compile hash verified and zero quarantine issues recorded.`,
    `Evidence: ci:staging/turn-delta-${String(turnIndex).padStart(2, "0")}`,
    `Based on: ${obsId} (staging@${gitSha})`,
    "",
    "## Task",
    question,
    "",
  ].join("\n");
}

function buildExperimentTurns(cacheWs) {
  const armA = [];
  const armB = [];
  let cumulativeHistoryEstTokens = 0;

  for (let turn = 1; turn <= TURN_QUESTIONS.length; turn += 1) {
    const { obsId, deltaNow } = applyTurnZoneBDelta(
      cacheWs.brainDir,
      turn,
      new Date(CANONICAL_NOW_ISO),
    );
    clearFileReadCache();
    const res = compileContext({
      role: "builder",
      env: "staging",
      gitSha: cacheWs.targetGitSha,
      maxTokens: 16384,
      brainDir: cacheWs.brainDir,
      repoRoot: cacheWs.repoRoot,
      now: deltaNow,
      bypassReadCache: true,
    });

    const deltaIso = deltaNow.toISOString().replace(/\.\d{3}Z$/, "Z");
    const question = TURN_QUESTIONS[turn - 1];
    const sysA = buildNaiveArmASystemInstruction(turn, deltaIso, obsId, res);
    const sysB = res.zone_a;
    const sharedInput =
      turn === 1
        ? buildDynamicInputTail(res, question)
        : buildCompactTurnDeltaInput(turn, obsId, cacheWs.targetGitSha, question);

    const combinedA = `${sysA}\n${sharedInput}`;
    const combinedB = `${sysB}\n${sharedInput}`;
    const prefixByteLen = res.zone_a_bytes;

    const prefixSliceA = Buffer.from(sysA, "utf8").subarray(0, prefixByteLen).toString("utf8");
    const prefixSliceB = Buffer.from(sysB, "utf8").subarray(0, prefixByteLen).toString("utf8");

    const sysBytesA = Buffer.byteLength(sysA, "utf8");
    const sysBytesB = Buffer.byteLength(sysB, "utf8");
    const inputBytes = Buffer.byteLength(sharedInput, "utf8");
    const turnInputOnlyEst = estimateTokens(sharedInput, 8, res.chars_per_token, res.safety_margin);
    const sysEstA = estimateTokens(sysA, 34, res.chars_per_token, res.safety_margin);
    const sysEstB = estimateTokens(sysB, 33, res.chars_per_token, res.safety_margin);

    // Conservative cumulative input token estimate accounting for server-side history chained via previous_interaction_id
    const estInputTokensA = sysEstA + cumulativeHistoryEstTokens + turnInputOnlyEst;
    const estInputTokensB = sysEstB + cumulativeHistoryEstTokens + turnInputOnlyEst;
    cumulativeHistoryEstTokens += turnInputOnlyEst + 180;

    armA.push({
      turn,
      obs_delta_id: obsId,
      previous_interaction_id_used: turn > 1,
      system_instruction: sysA,
      input: sharedInput,
      prompt: combinedA,
      system_instruction_bytes: sysBytesA,
      input_bytes: inputBytes,
      prompt_bytes: sysBytesA + inputBytes,
      est_input_tokens: estInputTokensA,
      prefix_bytes_checked: prefixByteLen,
      prefix_sha256: sha256(prefixSliceA),
    });

    armB.push({
      turn,
      obs_delta_id: obsId,
      previous_interaction_id_used: turn > 1,
      system_instruction: sysB,
      input: sharedInput,
      prompt: combinedB,
      system_instruction_bytes: sysBytesB,
      input_bytes: inputBytes,
      prompt_bytes: sysBytesB + inputBytes,
      est_input_tokens: estInputTokensB,
      prefix_bytes_checked: prefixByteLen,
      prefix_sha256: sha256(prefixSliceB),
      zone_a_sha256: res.zone_a_sha256,
      zone_a_tokens_est: res.zone_a_tokens_est,
      zone_a_byte_share_pct: round4((sysBytesB / (sysBytesB + inputBytes)) * 100),
      starts_with_exact_zone_a: sysB === res.zone_a,
    });
  }

  return { armA, armB };
}

function analyzePrefixStability(turns) {
  const uniqueHashes = new Set(turns.map((t) => t.prefix_sha256));
  const baselineHash = turns[0]?.prefix_sha256 ?? "";
  const allMatchBaseline = uniqueHashes.size === 1 && turns.length > 0;
  let consecutiveMatches = 0;
  const divergenceOffsets = [];

  for (let i = 1; i < turns.length; i += 1) {
    if (turns[i].prefix_sha256 === turns[i - 1].prefix_sha256) {
      consecutiveMatches += 1;
    }
    divergenceOffsets.push(firstByteDivergence(turns[i - 1].prompt, turns[i].prompt));
  }

  const identicalTurnsCount = allMatchBaseline ? turns.length : 0;
  const minDivergenceByte =
    divergenceOffsets.length > 0 ? Math.min(...divergenceOffsets) : 0;

  return {
    total_turns: turns.length,
    unique_prefix_hashes: uniqueHashes.size,
    baseline_prefix_sha256: baselineHash,
    prefix_identical_turns: identicalTurnsCount,
    prefix_identical_label: `${identicalTurnsCount}/${turns.length}`,
    reusable_follow_up_turns: `${consecutiveMatches}/${Math.max(0, turns.length - 1)}`,
    prefix_stability_ratio: round4(identicalTurnsCount / Math.max(1, turns.length)),
    min_first_divergence_byte_offset: minDivergenceByte,
    per_turn_prefix_sha256: turns.map((t) => ({
      turn: t.turn,
      obs_delta_id: t.obs_delta_id,
      previous_interaction_id_used: Boolean(t.previous_interaction_id_used),
      prompt_bytes: t.prompt_bytes,
      est_input_tokens: t.est_input_tokens,
      prefix_sha256: t.prefix_sha256,
      matches_turn_1_prefix: t.turn === 1 ? allMatchBaseline : t.prefix_sha256 === baselineHash,
    })),
  };
}

function estimateWorstCaseUsd(model, armATurns, armBTurns, countTokensCount) {
  const pricing = ALLOWED_MODELS[model];
  const totalEstInputTokens =
    armATurns.reduce((s, t) => s + t.est_input_tokens, 0) +
    armBTurns.reduce((s, t) => s + t.est_input_tokens, 0);
  const totalMaxOutputTokens = (armATurns.length + armBTurns.length) * MAX_OUTPUT_TOKENS;
  // Assume 0% cache discount in worst-case ceiling so budget gate is strictly conservative.
  const inputUsd = (totalEstInputTokens / 1_000_000) * pricing.maxInputUsdPer1M;
  const outputUsd = (totalMaxOutputTokens / 1_000_000) * pricing.maxOutputUsdPer1M;
  return {
    count_tokens_calls: countTokensCount,
    count_tokens_cost_usd: 0,
    interaction_calls: armATurns.length + armBTurns.length,
    total_requests: countTokensCount + armATurns.length + armBTurns.length,
    total_est_input_tokens: totalEstInputTokens,
    total_max_output_tokens: totalMaxOutputTokens,
    pricing_ceiling_assumed: pricing,
    worst_case_input_usd: round6(inputUsd),
    worst_case_output_usd: round6(outputUsd),
    worst_case_total_usd: round6(inputUsd + outputUsd),
  };
}

const GCP_KEY_SCRUB_RE = /AIza[0-9A-Za-z_-]{16,}/g;

function redactSecrets(text, explicitKey) {
  let out = String(text ?? "");
  const envKey = (process.env.GEMINI_API_KEY ?? "").trim();
  for (const candidate of [explicitKey, envKey]) {
    if (candidate && candidate.length > 0 && out.includes(candidate)) {
      out = out.split(candidate).join("<REDACTED_KEY>");
    }
  }
  return out.replace(GCP_KEY_SCRUB_RE, "<REDACTED_KEY>");
}

function sanitizeHttpError(status, rawBody, apiKey) {
  const clean = redactSecrets(rawBody, apiKey).slice(0, 300).replace(/\s+/g, " ").trim();
  return `HTTP ${status}: ${clean || "upstream error"}`;
}

async function callCountTokens(model, text, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:countTokens`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
      "Api-Revision": COUNT_TOKENS_API_REVISION,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
    }),
  });
  const bodyText = await resp.text();
  if (!resp.ok) {
    throw new Error(`countTokens failed: ${sanitizeHttpError(resp.status, bodyText, apiKey)}`);
  }
  const parsed = JSON.parse(bodyText);
  if (typeof parsed.totalTokens !== "number") {
    throw new Error("countTokens response missing numeric totalTokens field.");
  }
  return parsed.totalTokens;
}

async function callInteraction(model, systemInstruction, inputText, apiKey, previousInteractionId = null) {
  const url = "https://generativelanguage.googleapis.com/v1/interactions";
  const thinkingLevel = thinkingLevelForModel(model);
  const payload = {
    model,
    system_instruction: systemInstruction,
    input: inputText,
    store: true,
    generation_config: {
      max_output_tokens: MAX_OUTPUT_TOKENS,
      thinking_level: thinkingLevel,
    },
  };
  if (previousInteractionId) {
    payload.previous_interaction_id = previousInteractionId;
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const bodyText = await resp.text();
  if (!resp.ok) {
    throw new Error(`Interactions API failed: ${sanitizeHttpError(resp.status, bodyText, apiKey)}`);
  }
  const parsed = JSON.parse(bodyText);
  const usage = parsed.usage ?? {};
  const totalInput = Number(usage.total_input_tokens ?? 0);
  const totalCached = Number(usage.total_cached_tokens ?? 0);
  const totalOutput = Number(usage.total_output_tokens ?? 0);
  const totalThought = Number(usage.total_thought_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? totalInput + totalOutput + totalThought);
  return {
    interaction_id: typeof parsed.id === "string" ? parsed.id : null,
    previous_interaction_id_used: Boolean(previousInteractionId),
    status: typeof parsed.status === "string" ? parsed.status : "unknown",
    total_input_tokens: totalInput,
    total_cached_tokens: totalCached,
    total_output_tokens: totalOutput,
    total_thought_tokens: totalThought,
    total_tokens: totalTokens,
    cached_ratio: totalInput > 0 ? round4(totalCached / totalInput) : 0,
  };
}

async function main() {
  const { mode, model, maxUsd, help } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }

  validateModelAndBudget(model, maxUsd);

  const canonicalWs = createBenchmarkWorkspace({
    prefix: "veribrain-aistudio-cal-",
    profile: "canonical",
  });
  const cacheWs = createBenchmarkWorkspace({
    prefix: "veribrain-aistudio-cache-",
    profile: "gemini4-cache",
  });
  try {
    const cacheEval = evaluateBrain({
      brainDir: cacheWs.brainDir,
      repoRoot: cacheWs.repoRoot,
      now: cacheWs.now,
      strict: true,
      bypassReadCache: true,
    });
    if (!cacheEval.ok) {
      throw new Error(
        `gemini4-cache corpus failed eval --strict: ${JSON.stringify(cacheEval.issues)}`,
      );
    }

    const canonicalCompile = compileContext({
      role: "builder",
      env: "staging",
      gitSha: canonicalWs.targetGitSha,
      maxTokens: 16384,
      brainDir: canonicalWs.brainDir,
      repoRoot: canonicalWs.repoRoot,
      now: canonicalWs.now,
      bypassReadCache: true,
    });
    const cacheCompile = compileContext({
      role: "builder",
      env: "staging",
      gitSha: cacheWs.targetGitSha,
      maxTokens: 16384,
      brainDir: cacheWs.brainDir,
      repoRoot: cacheWs.repoRoot,
      now: cacheWs.now,
      bypassReadCache: true,
    });

    const calibrationPayloads = buildCalibrationPayloads(
      canonicalWs,
      canonicalCompile,
      cacheWs,
      cacheCompile,
    );
    const { armA, armB } = buildExperimentTurns(cacheWs);

    const armAStability = analyzePrefixStability(armA);
    const armBStability = analyzePrefixStability(armB);

    if (armBStability.prefix_identical_turns !== armB.length) {
      throw new Error(
        `Invariant broken: Arm B Zone A prefix drifted (${armBStability.prefix_identical_label}).`,
      );
    }
    if (armAStability.prefix_identical_turns !== 0) {
      throw new Error(
        `Unexpected baseline: Arm A should have 0/6 identical prefix turns (got ${armAStability.prefix_identical_label}).`,
      );
    }
    if (cacheCompile.zone_a_tokens_est < 8000) {
      throw new Error(
        `gemini4-cache Zone A (${cacheCompile.zone_a_tokens_est} est. tokens) is below 8,000 est. tokens (~6,146 tail window safety margin).`,
      );
    }

    const spendEstimate = estimateWorstCaseUsd(model, armA, armB, calibrationPayloads.length);
    if (spendEstimate.worst_case_total_usd > maxUsd) {
      throw new Error(
        `Pre-flight spend gate ABORTED: estimated worst-case spend $${spendEstimate.worst_case_total_usd.toFixed(4)} exceeds --max-usd $${maxUsd.toFixed(2)}.`,
      );
    }

    const thinkingLevel = thinkingLevelForModel(model);
    const interactionConfig = {
      corpus_profile: "gemini4-cache",
      session_mode: "stateful_previous_interaction_id",
      zone_a_placement: "system_instruction",
      zone_b_placement: "input",
      store: true,
      previous_interaction_id_used: true,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      thinking_level: thinkingLevel,
      inter_turn_delay_ms: INTER_TURN_DELAY_MS,
    };

    const avgZoneASharePct = round4(
      armB.reduce((s, t) => s + t.zone_a_byte_share_pct, 0) / armB.length,
    );
    const expectedActualZoneATokens = Math.round(cacheCompile.zone_a_bytes / 4.0813);

    mkdirSync(RESULTS_DIR, { recursive: true });

    if (mode === "dry-run") {
      const dryRunReport = {
        schema_version: "1.0",
        benchmark: "ai-studio-gemini4-telemetry",
        mode: "dry-run",
        provenance: "OBSERVED_LOCAL_DRY_RUN",
        live_api_status: "PENDING_OWNER_RUN",
        live_run_command: `./scripts/run_with_key.ps1 GEMINI_API_KEY node benchmarks/ai_studio_telemetry.mjs --live --model ${model}`,
        recorded_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        model,
        allowed_models: Object.keys(ALLOWED_MODELS),
        endpoints: {
          count_tokens: `https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`,
          interactions: "https://generativelanguage.googleapis.com/v1/interactions",
          api_revision_header: COUNT_TOKENS_API_REVISION,
        },
        interaction_config: interactionConfig,
        budget_gate: {
          max_usd: maxUsd,
          absolute_hard_cap_usd: ABSOLUTE_HARD_CAP_USD,
          actual_spend_usd: 0,
          ...spendEstimate,
          within_budget: spendEstimate.worst_case_total_usd <= maxUsd,
        },
        corpus_zone_a: {
          profile: "gemini4-cache",
          decided_count: cacheWs.counts.decided,
          zone_a_bytes: cacheCompile.zone_a_bytes,
          zone_a_tokens_est: cacheCompile.zone_a_tokens_est,
          expected_actual_tokens_at_4_08_bpt: expectedActualZoneATokens,
          zone_a_sha256: cacheCompile.zone_a_sha256,
          mean_zone_a_byte_share_pct: avgZoneASharePct,
          meets_gemini4_4096_floor: cacheCompile.zone_a_tokens_est >= 4096,
          clears_6146_tail_window_est: expectedActualZoneATokens > 6146,
          canonical_zone_a_bytes: canonicalCompile.zone_a_bytes,
          canonical_zone_a_tokens_est: canonicalCompile.zone_a_tokens_est,
          canonical_zone_a_sha256: canonicalCompile.zone_a_sha256,
        },
        count_tokens_calibration_plan: calibrationPayloads.map((p) => ({
          id: p.id,
          label: p.label,
          utf8_bytes: p.utf8_bytes,
          chars: p.chars,
          blocks: p.blocks,
          est_tokens: p.est_tokens,
          sha256: p.sha256,
          actual_tokens: null,
        })),
        prefix_stability: {
          arm_a_naive_dynamic_header: armAStability,
          arm_b_veribrain_two_zone: armBStability,
        },
        live_cache_telemetry: null,
      };

      writeFileSync(DRYRUN_OUTPUT_PATH, `${JSON.stringify(dryRunReport, null, 2)}\n`, "utf8");
      console.log(
        [
          `AI Studio telemetry DRY-RUN ($0.00) complete -> ${path.relative(process.cwd(), DRYRUN_OUTPUT_PATH)}`,
          `  Model: ${model} | session_mode=stateful_previous_interaction_id | thinking_level=${thinkingLevel} | max_output_tokens=${MAX_OUTPUT_TOKENS} | store=true`,
          `  Requests planned: ${spendEstimate.total_requests} (${calibrationPayloads.length} countTokens + 12 Interactions)`,
          `  Worst-case spend ceiling: $${spendEstimate.worst_case_total_usd.toFixed(4)} <= $${maxUsd.toFixed(2)} (--max-usd)`,
          `  Zone A (gemini4-cache): ${cacheCompile.zone_a_tokens_est} est. tok (${cacheCompile.zone_a_bytes} B, ~${expectedActualZoneATokens} expected actual tok > 6,146 window, ${avgZoneASharePct}% mean prefix share)`,
          `  Arm A (Naive dynamic system_instruction): ${armAStability.prefix_identical_label} identical prefixes (min divergence @ byte ${armAStability.min_first_divergence_byte_offset})`,
          `  Arm B (VeriBrain frozen system_instruction): ${armBStability.prefix_identical_label} identical prefixes (min divergence @ byte ${armBStability.min_first_divergence_byte_offset})`,
          `  Live run: ./scripts/run_with_key.ps1 GEMINI_API_KEY node benchmarks/ai_studio_telemetry.mjs --live`,
        ].join("\n"),
      );
      return;
    }

    // LIVE MODE — Zero-Custody: read strictly from process.env.GEMINI_API_KEY (never .env, never log key).
    const apiKey = (process.env.GEMINI_API_KEY ?? "").trim();
    if (apiKey.length === 0) {
      console.error(
        [
          "ERROR [EXIT 2] MISSING_API_KEY: process.env.GEMINI_API_KEY is not set.",
          "Zero-custody policy forbids reading .env files or hardcoding credentials.",
          `Run via masked stdin launcher: ./scripts/run_with_key.ps1 GEMINI_API_KEY node benchmarks/ai_studio_telemetry.mjs --live --model ${model}`,
        ].join("\n"),
      );
      process.exit(2);
    }

    const pricing = ALLOWED_MODELS[model];
    let cumulativeWorstCaseUsd = 0;

    // Step 1: countTokens calibration calls ($0.00)
    const calibrationResults = [];
    for (const payload of calibrationPayloads) {
      const actualTokens = await callCountTokens(model, payload.text, apiKey);
      const ratio = actualTokens / payload.est_tokens;
      const bytesPerActualToken = payload.utf8_bytes / actualTokens;
      calibrationResults.push({
        id: payload.id,
        label: payload.label,
        utf8_bytes: payload.utf8_bytes,
        chars: payload.chars,
        blocks: payload.blocks,
        est_tokens: payload.est_tokens,
        actual_tokens: actualTokens,
        actual_over_est_ratio: round4(ratio),
        utf8_bytes_per_actual_token: round4(bytesPerActualToken),
        est_over_actual_headroom_pct: round4(((payload.est_tokens - actualTokens) / actualTokens) * 100),
      });
    }

    const ratios = calibrationResults.map((r) => r.actual_over_est_ratio);
    const bytesPerTok = calibrationResults.map((r) => r.utf8_bytes_per_actual_token);
    const meanRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const maxRatio = Math.max(...ratios);
    const minBytesPerTok = Math.min(...bytesPerTok);
    const meanBytesPerTok = bytesPerTok.reduce((a, b) => a + b, 0) / bytesPerTok.length;
    const recommendedCharsPerToken = Number(Math.max(3.0, Math.min(4.5, meanBytesPerTok)).toFixed(2));
    const recommendedSafetyMargin = Number(
      Math.max(1.05, (recommendedCharsPerToken / minBytesPerTok) * 1.05).toFixed(2),
    );

    const canonicalZoneACal = calibrationResults.find((r) => r.id === "zone_a_canonical_large");
    const cacheZoneACal = calibrationResults.find((r) => r.id === "zone_a_gemini4_cache_profile");

    // Step 2: 6 turns Arm A + 6 turns Arm B via stateful Interactions API (previous_interaction_id chaining)
    async function runArmLive(armName, turns) {
      const out = [];
      let prevInteractionId = null;
      for (let i = 0; i < turns.length; i += 1) {
        const turn = turns[i];
        if (i > 0 && !prevInteractionId) {
          throw new Error(
            `${armName} turn ${turn.turn}: previous turn did not return an interaction id; cannot chain previous_interaction_id.`,
          );
        }
        const projectedTurnUsd =
          (turn.est_input_tokens / 1_000_000) * pricing.maxInputUsdPer1M +
          (MAX_OUTPUT_TOKENS / 1_000_000) * pricing.maxOutputUsdPer1M;
        if (cumulativeWorstCaseUsd + projectedTurnUsd > maxUsd) {
          throw new Error(
            `Runtime spend ceiling reached before ${armName} turn ${turn.turn} ($${(cumulativeWorstCaseUsd + projectedTurnUsd).toFixed(4)} > $${maxUsd.toFixed(2)}). Aborting cleanly.`,
          );
        }

        const t0 = performance.now();
        const usage = await callInteraction(
          model,
          turn.system_instruction,
          turn.input,
          apiKey,
          prevInteractionId,
        );
        const latencyMs = Number((performance.now() - t0).toFixed(1));
        prevInteractionId = usage.interaction_id;

        const turnActualCeilingUsd =
          (usage.total_input_tokens / 1_000_000) * pricing.maxInputUsdPer1M +
          ((usage.total_output_tokens + usage.total_thought_tokens) / 1_000_000) *
            pricing.maxOutputUsdPer1M;
        cumulativeWorstCaseUsd += turnActualCeilingUsd;

        out.push({
          turn: turn.turn,
          obs_delta_id: turn.obs_delta_id,
          prefix_sha256: turn.prefix_sha256,
          est_input_tokens: turn.est_input_tokens,
          latency_ms: latencyMs,
          ...usage,
        });

        if (i < turns.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, INTER_TURN_DELAY_MS));
        }
      }
      return out;
    }

    const armALive = await runArmLive("arm_a_naive", armA);
    const armBLive = await runArmLive("arm_b_veribrain", armB);

    function summarizeLiveArm(liveTurns) {
      const followUps = liveTurns.slice(1);
      const totalInputAll = liveTurns.reduce((s, t) => s + t.total_input_tokens, 0);
      const totalCachedAll = liveTurns.reduce((s, t) => s + t.total_cached_tokens, 0);
      const totalThoughtAll = liveTurns.reduce((s, t) => s + t.total_thought_tokens, 0);
      const totalInputFollowUp = followUps.reduce((s, t) => s + t.total_input_tokens, 0);
      const totalCachedFollowUp = followUps.reduce((s, t) => s + t.total_cached_tokens, 0);
      const peakCachedRatio = Math.max(...liveTurns.map((t) => t.cached_ratio));
      const completedCount = liveTurns.filter((t) => t.status === "completed").length;
      return {
        turns: liveTurns,
        completed_turns_count: completedCount,
        all_turns_completed: completedCount === liveTurns.length,
        total_input_tokens_all_turns: totalInputAll,
        total_cached_tokens_all_turns: totalCachedAll,
        total_thought_tokens_all_turns: totalThoughtAll,
        overall_cached_ratio: totalInputAll > 0 ? round4(totalCachedAll / totalInputAll) : 0,
        follow_up_turns_cached_ratio:
          totalInputFollowUp > 0 ? round4(totalCachedFollowUp / totalInputFollowUp) : 0,
        peak_cached_ratio: round4(peakCachedRatio),
      };
    }

    const armASummary = summarizeLiveArm(armALive);
    const armBSummary = summarizeLiveArm(armBLive);
    const allTurnsCompleted = armASummary.all_turns_completed && armBSummary.all_turns_completed;

    const liveReport = {
      schema_version: "1.0",
      benchmark: "ai-studio-gemini4-telemetry",
      mode: "live",
      provenance: "OBSERVED_LIVE_AI_STUDIO",
      recorded_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      model,
      endpoints: {
        count_tokens: `https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`,
        interactions: "https://generativelanguage.googleapis.com/v1/interactions",
        api_revision_header: COUNT_TOKENS_API_REVISION,
      },
      interaction_config: interactionConfig,
      budget_gate: {
        max_usd: maxUsd,
        absolute_hard_cap_usd: ABSOLUTE_HARD_CAP_USD,
        estimated_upper_bound_spend_usd: round6(cumulativeWorstCaseUsd),
      },
      count_tokens_calibration: {
        payloads: calibrationResults,
        summary: {
          mean_actual_over_est_ratio: round4(meanRatio),
          max_actual_over_est_ratio: round4(maxRatio),
          min_utf8_bytes_per_actual_token: round4(minBytesPerTok),
          mean_utf8_bytes_per_actual_token: round4(meanBytesPerTok),
          canonical_zone_a_actual_tokens: canonicalZoneACal?.actual_tokens ?? null,
          canonical_zone_a_meets_4096_floor: (canonicalZoneACal?.actual_tokens ?? 0) >= 4096,
          gemini4_cache_zone_a_actual_tokens: cacheZoneACal?.actual_tokens ?? null,
          gemini4_cache_zone_a_clears_6146_window: (cacheZoneACal?.actual_tokens ?? 0) > 6146,
          recommended_chars_per_token: recommendedCharsPerToken,
          recommended_safety_margin: recommendedSafetyMargin,
        },
      },
      prefix_stability: {
        arm_a_naive_dynamic_header: armAStability,
        arm_b_veribrain_two_zone: armBStability,
      },
      live_cache_telemetry: {
        all_turns_completed: allTurnsCompleted,
        arm_a_naive_dynamic_header: armASummary,
        arm_b_veribrain_two_zone: armBSummary,
      },
    };

    writeFileSync(LIVE_OUTPUT_PATH, `${JSON.stringify(liveReport, null, 2)}\n`, "utf8");
    console.log(
      [
        `AI Studio LIVE telemetry complete -> ${path.relative(process.cwd(), LIVE_OUTPUT_PATH)}`,
        `  Model: ${model} | all_turns_completed=${allTurnsCompleted} | Upper-bound spend est: $${cumulativeWorstCaseUsd.toFixed(4)} <= $${maxUsd.toFixed(2)}`,
        `  Zone A actual tokens: canonical=${liveReport.count_tokens_calibration.summary.canonical_zone_a_actual_tokens}, gemini4-cache=${liveReport.count_tokens_calibration.summary.gemini4_cache_zone_a_actual_tokens}`,
        `  Arm A follow-up cached ratio: ${(armASummary.follow_up_turns_cached_ratio * 100).toFixed(1)}% (peak ${(armASummary.peak_cached_ratio * 100).toFixed(1)}%)`,
        `  Arm B follow-up cached ratio: ${(armBSummary.follow_up_turns_cached_ratio * 100).toFixed(1)}% (peak ${(armBSummary.peak_cached_ratio * 100).toFixed(1)}%)`,
      ].join("\n"),
    );
  } finally {
    canonicalWs.cleanup();
    cacheWs.cleanup();
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(redactSecrets(msg));
  process.exit(1);
});
