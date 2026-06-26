"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createWechatCollectorService } = require("./wechat_collector_service");

function createService(overrides = {}) {
  return createWechatCollectorService({
    WECHAT_COLLECTOR_BASE_URL: "",
    WECHAT_COLLECTOR_BIN: "/missing/bin",
    WECHAT_COLLECTOR_HOME: "/tmp/wechat-collector-test",
    WECHAT_COLLECTOR_LABEL: "com.test.collector",
    WECHAT_COLLECTOR_PAC_URL: "http://127.0.0.1/proxy.pac",
    WECHAT_COLLECTOR_PLIST: "/missing/plist",
    sendWechatCollectorCommand: async () => ({ ok: false, message: "not connected" }),
    ...overrides,
  });
}

test("wechat collector service returns not ready status without a base URL", async () => {
  const service = createService();

  assert.deepEqual(await service.getWechatCollectorStatus(), {
    ok: false,
    connected: false,
    installed: false,
    listening: false,
    captures: [],
    message: "悦拜视频号采集服务尚未部署。需要把采集代理核心接入平台后台后，页面才能直接捕获视频号资源。",
  });
});

test("wechat preview content type normalization preserves unknown fallback behavior", () => {
  const service = createService();

  assert.equal(service.normalizeWechatPreviewContentType("image/jpg"), "image/jpeg");
  assert.equal(service.normalizeWechatPreviewContentType(""), "application/octet-stream");
  assert.equal(service.normalizeWechatPreviewContentType("video/mp4"), "video/mp4");
});

test("wechat token preview uses remote command payload", async () => {
  const service = createService({
    sendWechatCollectorCommand: async (token, path, options) => {
      assert.equal(token, "token-1");
      assert.equal(path, "/api/preview-data?id=capture-1");
      assert.deepEqual(options, { method: "GET" });
      return {
        ok: true,
        contentType: "image/jpg",
        base64: Buffer.from("hello", "utf8").toString("base64"),
      };
    },
  });

  const preview = await service.fetchWechatCapturePreviewBufferByToken("token-1", "capture-1");
  assert.equal(preview.contentType, "image/jpeg");
  assert.equal(preview.buffer.toString("utf8"), "hello");
});

test("wechat collector package controls keep platform guard behavior", async () => {
  const service = createService();

  if (process.platform !== "darwin") {
    assert.equal((await service.startWechatCollectorPackage()).ok, false);
    assert.equal((await service.stopWechatCollectorPackage()).ok, false);
  }
});
