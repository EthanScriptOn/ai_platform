"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createInstallScriptRenderer } = require("./install_scripts");

function createRenderer(overrides = {}) {
  let wechatTokenCount = 0;
  let contentTokenCount = 0;
  const renderer = createInstallScriptRenderer({
    CONTENT_ASSET_LOCAL_HOST: "douyin.local",
    CONTENT_ASSET_LOCAL_HTTPS_PORT: "8768",
    HOST: "127.0.0.1",
    PORT: 8788,
    WECHAT_COLLECTOR_INSTALL_BASE_URL: "",
    WECHAT_COLLECTOR_LOCAL_HOST: "wechat.local",
    WECHAT_COLLECTOR_LOCAL_HTTPS_PORT: "18766",
    createContentAssetToken: () => {
      contentTokenCount += 1;
      return "content-created";
    },
    createWechatCollectorToken: () => {
      wechatTokenCount += 1;
      return "wechat-created";
    },
    ...overrides,
  });
  return {
    ...renderer,
    counts: () => ({ contentTokenCount, wechatTokenCount }),
  };
}

test("collectorInstallBaseUrl uses configured install base URL when present", () => {
  const renderer = createRenderer({ WECHAT_COLLECTOR_INSTALL_BASE_URL: "https://platform.example///" });

  assert.equal(renderer.collectorInstallBaseUrl(), "https://platform.example");
});

test("wechat install scripts preserve provided token and local host values", () => {
  const renderer = createRenderer();
  const script = renderer.renderWechatCollectorMacInstallScript("wechat-explicit");

  assert.equal(script.includes('CLIENT_TOKEN="${YUEBAI_WECHAT_COLLECTOR_TOKEN:-wechat-explicit}"'), true);
  assert.match(script, /LOCAL_HOST="wechat.local"/);
  assert.equal(script.includes("https://wechat.local:18766/api/status"), true);
  assert.deepEqual(renderer.counts(), { contentTokenCount: 0, wechatTokenCount: 0 });
});

test("douyin install scripts create a content token when omitted", () => {
  const renderer = createRenderer();
  const script = renderer.renderDouyinCollectorWindowsInstallScript("");

  assert.match(script, /content-created/);
  assert.equal(script.includes('Invoke-WebRequest -Uri "$BaseUrl/install/yuebai-douyin-collector-app.tar.gz"'), true);
  assert.deepEqual(renderer.counts(), { contentTokenCount: 1, wechatTokenCount: 0 });
});
