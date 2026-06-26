"use strict";

const fs = require("fs");
const path = require("path");

function handleSimulatedE2eError(error, debug) {
  const taskStatePath = debug.dataDir
    ? path.join(debug.dataDir, "flowbot-agent-task-state.json")
    : "";
  let taskStateText = "";
  let indexText = "";
  try {
    if (taskStatePath && fs.existsSync(taskStatePath)) {
      taskStateText = fs.readFileSync(taskStatePath, "utf8");
    }
  } catch {}
  try {
    const indexPath = debug.dataDir
      ? path.join(debug.dataDir, "flowbot-message-search-index.jsonl")
      : "";
    if (indexPath && fs.existsSync(indexPath)) {
      indexText = fs.readFileSync(indexPath, "utf8");
    }
  } catch {}
  console.error(JSON.stringify({
    sandboxRoot: debug.sandboxRoot || "",
    callbackUrl: debug.callbackUrl || "",
    sendTextCalls: debug.state?.upstreamSendTextCalls || [],
    llmRequestCount: Array.isArray(debug.state?.llmRequests) ? debug.state.llmRequests.length : 0,
    toolObservations: Array.isArray(debug.state?.toolObservations) ? debug.state.toolObservations : [],
    flowbotLogs: Array.isArray(debug.flowbotLogs) ? debug.flowbotLogs.slice(-120) : [],
    workerLogs: Array.isArray(debug.workerLogs) ? debug.workerLogs.slice(-120) : [],
    taskState: taskStateText,
    messageIndex: indexText,
  }, null, 2));
  console.error(String(error?.stack || error));
}

module.exports = { handleSimulatedE2eError };
