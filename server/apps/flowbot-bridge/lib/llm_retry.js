"use strict";

const DEFAULT_LLM_TIMEOUT_RETRY_ATTEMPTS = 5;
const DEFAULT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS = 16000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveLlmRetryOptions(rawOptions = {}) {
  return {
    maxAttempts: Math.max(
      1,
      Math.min(
        5,
        Number(rawOptions.maxAttempts ?? rawOptions.timeoutRetryAttempts)
          || DEFAULT_LLM_TIMEOUT_RETRY_ATTEMPTS,
      ),
    ),
    baseDelayMs: Math.max(
      100,
      Math.min(
        10000,
        Number(rawOptions.baseDelayMs ?? rawOptions.timeoutRetryBaseDelayMs)
          || DEFAULT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS,
      ),
    ),
    maxDelayMs: Math.max(
      1000,
      Math.min(
        60000,
        Number(rawOptions.maxDelayMs ?? rawOptions.timeoutRetryMaxDelayMs)
          || DEFAULT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS,
      ),
    ),
  };
}

function shouldRetryLlmTimeout(error) {
  const lowered = String(error?.message || error || "").toLowerCase();
  if (!lowered) {
    return false;
  }
  return [
    "request_timeout",
    "timeout",
    "timed out",
    "socket hang up",
    "econnreset",
    "etimedout",
  ].some((keyword) => lowered.includes(keyword));
}

async function invokeWithLlmTimeoutRetry(fn, rawOptions = {}) {
  const retryOptions = resolveLlmRetryOptions(rawOptions);
  const shouldRetry = typeof rawOptions.shouldRetry === "function"
    ? rawOptions.shouldRetry
    : shouldRetryLlmTimeout;
  let lastError = null;
  for (let attempt = 1; attempt <= retryOptions.maxAttempts; attempt += 1) {
    try {
      return await fn({ attempt, retryOptions });
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt >= retryOptions.maxAttempts) {
        throw error;
      }
      const nextDelayMs = Math.min(
        retryOptions.maxDelayMs,
        retryOptions.baseDelayMs * (2 ** (attempt - 1)),
      );
      if (typeof rawOptions.onRetry === "function") {
        rawOptions.onRetry({
          attempt,
          error,
          nextDelayMs,
          retryOptions,
        });
      }
      await sleep(nextDelayMs);
    }
  }
  throw lastError || new Error("llm_retry_exhausted");
}

module.exports = {
  DEFAULT_LLM_TIMEOUT_RETRY_ATTEMPTS,
  DEFAULT_LLM_TIMEOUT_RETRY_BASE_DELAY_MS,
  DEFAULT_LLM_TIMEOUT_RETRY_MAX_DELAY_MS,
  sleep,
  resolveLlmRetryOptions,
  shouldRetryLlmTimeout,
  invokeWithLlmTimeoutRetry,
};
