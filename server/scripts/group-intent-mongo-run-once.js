#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const DEFAULTS = {
  maxTrainPasses: Number(process.env.GROUP_INTENT_MAX_TRAIN_PASSES || 6),
  recentDocLimit: Number(process.env.GROUP_INTENT_RECENT_DOC_LIMIT || 4000),
  trainStatePath: path.join(process.cwd(), "runtime", "group-intent-mongo-train", "state.json"),
  outputDir: path.join(process.cwd(), "runtime", "group-intent-mongo-run-once"),
};

function timestampLabel(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function readJson(filePath = "") {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function loadTrainState() {
  return (
    readJson(DEFAULTS.trainStatePath) || {
      lastRequestTime: "",
      lastObjectId: "",
      lastRunAt: "",
      lastReportPath: "",
      lastError: null,
    }
  );
}

function ensureDir(dirPath = "") {
  fs.mkdirSync(dirPath, { recursive: true });
}

function didCursorAdvance(before = {}, after = {}) {
  return (
    String(before.lastObjectId || "").trim() !== String(after.lastObjectId || "").trim() ||
    String(before.lastRequestTime || "").trim() !== String(after.lastRequestTime || "").trim()
  );
}

async function runScript(scriptName = "") {
  const scriptPath = path.join(process.cwd(), scriptName);
  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    stdout: String(stdout || "").trim(),
    stderr: String(stderr || "").trim(),
  };
}

async function main() {
  const startedAt = new Date();
  const trainPasses = [];
  let evalResult = null;

  for (let pass = 1; pass <= Math.max(1, DEFAULTS.maxTrainPasses); pass += 1) {
    const beforeState = loadTrainState();
    const execution = await runScript("group-intent-mongo-train.js");
    const afterState = loadTrainState();
    const report = readJson(afterState.lastReportPath);
    const sampling = report?.sampling || {};
    const advanced = didCursorAdvance(beforeState, afterState);

    trainPasses.push({
      pass,
      advanced,
      lastReportPath: afterState.lastReportPath || "",
      lastRunAt: afterState.lastRunAt || "",
      lastError: afterState.lastError || null,
      sampledMessageCount: Number(sampling.sampledMessageCount || 0),
      rawFetchedDocCount: Number(sampling.rawFetchedDocCount || 0),
      candidateLikeCount: Number(sampling.candidateLikeCount || 0),
      labelCounts: report?.labelCounts || null,
      trainResult: report?.trainResult || null,
      stdout: execution.stdout,
    });

    if (report?.status === "failed") break;
    if (!advanced) break;
    if (Number(sampling.rawFetchedDocCount || 0) < DEFAULTS.recentDocLimit) break;
  }

  try {
    const execution = await runScript("group-intent-mongo-eval.js");
    const outputPathMatch = execution.stdout.match(/"outputPath":\s*"([^"]+)"/);
    const reportPath = outputPathMatch ? outputPathMatch[1] : "";
    const report = readJson(reportPath);
    evalResult = {
      outputPath: reportPath,
      metrics: report?.metrics || report?.partialMetrics || null,
      sampling: report?.sampling || null,
      batchErrors: Array.isArray(report?.batchErrors) ? report.batchErrors.length : 0,
      status: report?.status || "ok",
      stdout: execution.stdout,
    };
  } catch (error) {
    evalResult = {
      status: "failed",
      error: String(error.message || error),
    };
  }

  const summary = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    maxTrainPasses: DEFAULTS.maxTrainPasses,
    trainPasses,
    finalTrainState: loadTrainState(),
    evalResult,
  };

  ensureDir(DEFAULTS.outputDir);
  const outputPath = path.join(DEFAULTS.outputDir, `report-${timestampLabel(startedAt)}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), "utf-8");

  console.log(
    JSON.stringify(
      {
        outputPath,
        trainPassCount: trainPasses.length,
        finalTrainState: summary.finalTrainState,
        evalResult,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
