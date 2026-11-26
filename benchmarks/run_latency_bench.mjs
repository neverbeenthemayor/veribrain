import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { clearFileReadCache, compileContext, evaluateBrain } from "../dist/index.js";
import { createBenchmarkWorkspace } from "./corpus.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "results");
const OUTPUT_PATH = path.join(RESULTS_DIR, "latency-observed.json");

const WARMUP_RUNS = 10;
const TIMED_RUNS = 100;
const GATE_TARGET_P95_MS = 15.0;
const MAX_TOKENS = 16384;

function round3(n) {
  return Number(n.toFixed(3));
}

function percentile(sortedAsc, p) {
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx] ?? Number.POSITIVE_INFINITY;
}

function summarizeTimings(timingsMs) {
  const sorted = [...timingsMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length;
  const stddev = Math.sqrt(variance);

  return {
    runs: sorted.length,
    warmup_runs: WARMUP_RUNS,
    min_ms: round3(sorted[0]),
    p50_ms: round3(percentile(sorted, 50)),
    p95_ms: round3(percentile(sorted, 95)),
    p99_ms: round3(percentile(sorted, 99)),
    max_ms: round3(sorted[sorted.length - 1]),
    mean_ms: round3(mean),
    stddev_ms: round3(stddev),
  };
}

function runSuite(ws, bypassReadCache) {
  clearFileReadCache();

  const opts = {
    role: "builder",
    env: "staging",
    gitSha: ws.targetGitSha,
    maxTokens: MAX_TOKENS,
    brainDir: ws.brainDir,
    repoRoot: ws.repoRoot,
    now: ws.now,
    bypassReadCache,
  };

  for (let w = 0; w < WARMUP_RUNS; w += 1) {
    compileContext(opts);
  }

  const timingsMs = [];
  const zoneAHashes = new Set();
  const zoneBOutputs = new Set();
  let lastResult = null;

  for (let r = 0; r < TIMED_RUNS; r += 1) {
    const t0 = performance.now();
    const res = compileContext(opts);
    const elapsed = performance.now() - t0;
    timingsMs.push(elapsed);
    zoneAHashes.add(res.zone_a_sha256);
    zoneBOutputs.add(res.zone_b);
    lastResult = res;
  }

  const stats = summarizeTimings(timingsMs);
  return {
    bypass_read_cache: bypassReadCache,
    ...stats,
    unique_zone_a_hashes: zoneAHashes.size,
    unique_zone_b_outputs: zoneBOutputs.size,
    hash_identity: zoneAHashes.size === 1 ? `${TIMED_RUNS}/${TIMED_RUNS}` : `DRIFT(${zoneAHashes.size})`,
    lastResult,
  };
}

async function main() {
  const ws = createBenchmarkWorkspace({ prefix: "veribrain-latency-bench-" });
  try {
    const strictEval = evaluateBrain({
      brainDir: ws.brainDir,
      repoRoot: ws.repoRoot,
      now: ws.now,
      strict: true,
      bypassReadCache: true,
    });
    if (!strictEval.ok) {
      throw new Error(
        `Canonical benchmark corpus failed eval --strict: ${JSON.stringify(strictEval.issues)}`,
      );
    }

    // Age freshly written temp files past the 50 ms stat-cache guard so warm mode exercises stat validation authentically.
    await new Promise((resolve) => setTimeout(resolve, 75));

    const warm = runSuite(ws, false);
    const cold = runSuite(ws, true);

    if (!warm.lastResult || !cold.lastResult) {
      throw new Error("Benchmark produced no compile result.");
    }
    if (warm.lastResult.zone_a_sha256 !== cold.lastResult.zone_a_sha256) {
      throw new Error("Warm and cold modes produced different zone_a_sha256 digests.");
    }
    if (warm.lastResult.zone_a_tokens_est < 4096) {
      throw new Error(
        `Zone A (${warm.lastResult.zone_a_tokens_est} est. tokens) fell below 4,096-token Gemini 4 implicit caching floor.`,
      );
    }

    const cpus = os.cpus();
    const report = {
      schema_version: "1.0",
      benchmark: "local-compile-latency",
      provenance: "OBSERVED_LOCAL",
      cost_usd: 0,
      recorded_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      environment: {
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        os_release: os.release(),
        cpu_model: cpus[0]?.model?.trim() ?? "unknown",
        cpu_count: cpus.length,
      },
      corpus: {
        eval_strict_ok: strictEval.ok,
        brain_files: ws.counts.brain_files,
        brain_bytes: ws.counts.brain_bytes,
        decided_count: ws.counts.decided,
        observed_total: ws.counts.observed_total,
        observed_fresh: ws.counts.observed_fresh,
        observed_excluded_stale: warm.lastResult.excluded_stale_ids.length,
        scars_count: ws.counts.scars,
        scars_bytes: ws.counts.scars_bytes,
        hypotheses_count: ws.counts.hypotheses,
        zone_a_bytes: warm.lastResult.zone_a_bytes,
        zone_b_bytes: warm.lastResult.zone_b_bytes,
        zone_a_tokens_est: warm.lastResult.zone_a_tokens_est,
        zone_b_tokens_est: warm.lastResult.zone_b_tokens_est,
        total_tokens_est: warm.lastResult.total_tokens_est,
        zone_a_sha256: warm.lastResult.zone_a_sha256,
        semantic_hash: warm.lastResult.semantic_hash,
        estimator_version: warm.lastResult.estimator_version,
        evicted_count: warm.lastResult.evicted_ids.length,
        meets_gemini4_4096_floor: warm.lastResult.zone_a_tokens_est >= 4096,
      },
      modes: {
        warm_stat_validated: {
          bypass_read_cache: warm.bypass_read_cache,
          runs: warm.runs,
          warmup_runs: warm.warmup_runs,
          min_ms: warm.min_ms,
          p50_ms: warm.p50_ms,
          p95_ms: warm.p95_ms,
          p99_ms: warm.p99_ms,
          max_ms: warm.max_ms,
          mean_ms: warm.mean_ms,
          stddev_ms: warm.stddev_ms,
          unique_zone_a_hashes: warm.unique_zone_a_hashes,
          unique_zone_b_outputs: warm.unique_zone_b_outputs,
          hash_identity: warm.hash_identity,
        },
        cold_disk: {
          bypass_read_cache: cold.bypass_read_cache,
          runs: cold.runs,
          warmup_runs: cold.warmup_runs,
          min_ms: cold.min_ms,
          p50_ms: cold.p50_ms,
          p95_ms: cold.p95_ms,
          p99_ms: cold.p99_ms,
          max_ms: cold.max_ms,
          mean_ms: cold.mean_ms,
          stddev_ms: cold.stddev_ms,
          unique_zone_a_hashes: cold.unique_zone_a_hashes,
          unique_zone_b_outputs: cold.unique_zone_b_outputs,
          hash_identity: cold.hash_identity,
        },
      },
      cross_mode_zone_a_identical: warm.lastResult.zone_a_sha256 === cold.lastResult.zone_a_sha256,
      gate: {
        target_p95_ms: GATE_TARGET_P95_MS,
        warm_p95_pass: warm.p95_ms < GATE_TARGET_P95_MS,
        cold_p95_pass: cold.p95_ms < GATE_TARGET_P95_MS,
      },
    };

    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    console.log(
      [
        `Latency benchmark complete -> ${path.relative(process.cwd(), OUTPUT_PATH)}`,
        `  Corpus: ${report.corpus.brain_files} files (${report.corpus.brain_bytes} B), Zone A = ${report.corpus.zone_a_tokens_est} est. tok (${report.corpus.zone_a_bytes} B), Zone B = ${report.corpus.zone_b_tokens_est} est. tok`,
        `  Warm (stat-validated): p50=${warm.p50_ms} ms | p95=${warm.p95_ms} ms | p99=${warm.p99_ms} ms | hash=${warm.hash_identity}`,
        `  Cold (disk reads):     p50=${cold.p50_ms} ms | p95=${cold.p95_ms} ms | p99=${cold.p99_ms} ms | hash=${cold.hash_identity}`,
      ].join("\n"),
    );
  } finally {
    ws.cleanup();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
