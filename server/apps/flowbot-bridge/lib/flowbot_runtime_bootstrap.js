"use strict";

const os = require("os");
const path = require("path");

const { DEFAULT_AGENT_ID, DEFAULT_STRATEGY } = require("./agent_session_key");
const { normalizeAgentWakeNamesInput } = require("./config_manager");
const { createFlowbotRuntimeConfig } = require("./flowbot_runtime_config");
const {
  DEFAULT_LLM_TIMEOUT_RETRY_ATTEMPTS,
  DEFAULT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS,
  DEFAULT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS,
} = require("./llm_retry");

function createFlowbotRuntimeBootstrap({ baseDir }) {
  return createFlowbotRuntimeConfig({
    DEFAULT_AGENT_ID,
    DEFAULT_LLM_TIMEOUT_RETRY_ATTEMPTS,
    DEFAULT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS,
    DEFAULT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS,
    DEFAULT_STRATEGY,
    baseDir,
    normalizeAgentWakeNamesInput,
    os,
    path,
  });
}

module.exports = {
  createFlowbotRuntimeBootstrap,
};
