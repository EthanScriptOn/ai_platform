"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  invokeWithLlmTimeoutRetry,
  resolveLlmRetryOptions,
  shouldRetryLlmTimeout,
} = require("./llm_retry");

test("shouldRetryLlmTimeout matches timeout-like transport failures", () => {
  assert.equal(shouldRetryLlmTimeout(new Error("request_timeout")), true);
  assert.equal(shouldRetryLlmTimeout(new Error("socket hang up")), true);
  assert.equal(shouldRetryLlmTimeout(new Error("read ECONNRESET")), true);
  assert.equal(shouldRetryLlmTimeout(new Error("validation_failed")), false);
});

test("resolveLlmRetryOptions applies bounds and defaults", () => {
  const options = resolveLlmRetryOptions({
    maxAttempts: 9,
    baseDelayMs: 50,
    maxDelayMs: 999999,
  });
  assert.deepEqual(options, {
    maxAttempts: 5,
    baseDelayMs: 100,
    maxDelayMs: 60000,
  });
});

test("invokeWithLlmTimeoutRetry retries timeout errors and eventually succeeds", async () => {
  const attempts = [];
  const result = await invokeWithLlmTimeoutRetry(
    async ({ attempt }) => {
      attempts.push(attempt);
      if (attempt < 3) {
        throw new Error("request_timeout");
      }
      return "ok";
    },
    {
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 1,
    },
  );

  assert.equal(result, "ok");
  assert.deepEqual(attempts, [1, 2, 3]);
});

test("invokeWithLlmTimeoutRetry stops on non-retryable errors", async () => {
  await assert.rejects(
    invokeWithLlmTimeoutRetry(
      async () => {
        throw new Error("schema_invalid");
      },
      {
        maxAttempts: 5,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
    ),
    /schema_invalid/,
  );
});
