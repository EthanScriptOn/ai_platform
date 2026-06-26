"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createRouteChain } = require("./flowbot_route_chain");

test("route chain stops at the first handler that accepts a request", async () => {
  const calls = [];
  const chain = createRouteChain({
    handlers: [
      async () => {
        calls.push("first");
        return false;
      },
      async () => {
        calls.push("second");
        return true;
      },
      async () => {
        calls.push("third");
        return true;
      },
    ],
    onNotFound: async () => {
      calls.push("not_found");
    },
  });

  const handled = await chain.handle({}, {}, { pathname: "/matched" });

  assert.equal(handled, true);
  assert.deepEqual(calls, ["first", "second"]);
});

test("route chain delegates unmatched requests to not found handler", async () => {
  const calls = [];
  const chain = createRouteChain({
    handlers: [
      async () => {
        calls.push("first");
        return false;
      },
    ],
    onNotFound: async (_req, _res, url) => {
      calls.push(`not_found:${url.pathname}`);
    },
  });

  const handled = await chain.handle({}, {}, { pathname: "/missing" });

  assert.equal(handled, false);
  assert.deepEqual(calls, ["first", "not_found:/missing"]);
});
