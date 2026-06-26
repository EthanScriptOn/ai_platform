"use strict";

const fs = require("fs");
const path = require("path");

function readTaskState(dataDir) {
  const taskStatePath = path.join(dataDir, "flowbot-agent-task-state.json");
  if (!fs.existsSync(taskStatePath)) {
    return { tasks: {}, traceToTaskId: {} };
  }
  return JSON.parse(fs.readFileSync(taskStatePath, "utf8"));
}

function countTasksByStatus(taskState, status) {
  return Object.values(taskState?.tasks || {}).filter((item) => String(item?.status || "") === status).length;
}

module.exports = {
  countTasksByStatus,
  readTaskState,
};
