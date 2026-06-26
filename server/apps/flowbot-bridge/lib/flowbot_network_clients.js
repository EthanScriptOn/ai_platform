"use strict";

const { URL } = require("url");

const {
  downloadBinary: httpDownloadBinary,
  downloadBinaryWithHeaders: httpDownloadBinaryWithHeaders,
  getHttpModule,
  requestJson: httpRequestJson,
  requestJsonWithHeaders: httpRequestJsonWithHeaders,
} = require("./http_client");
const { createStreamingChatClient } = require("./streaming_chat_client");

function createFlowbotNetworkClients({ MEDIA_DOWNLOAD_TIMEOUT_MS }) {
  const requestJson = (method, target, payload, timeoutMs = MEDIA_DOWNLOAD_TIMEOUT_MS) => (
    httpRequestJson(method, target, payload, timeoutMs)
  );
  const requestJsonWithHeaders = (
    method,
    target,
    payload,
    headers = {},
    timeoutMs = MEDIA_DOWNLOAD_TIMEOUT_MS,
  ) => httpRequestJsonWithHeaders(method, target, payload, headers, timeoutMs);
  const downloadBinary = (target, timeoutMs = MEDIA_DOWNLOAD_TIMEOUT_MS) => (
    httpDownloadBinary(target, timeoutMs)
  );
  const downloadBinaryWithHeaders = (target, headers = {}, timeoutMs = MEDIA_DOWNLOAD_TIMEOUT_MS) => (
    httpDownloadBinaryWithHeaders(target, timeoutMs, headers)
  );

  const { requestStreamingChatText } = createStreamingChatClient({
    MEDIA_DOWNLOAD_TIMEOUT_MS,
    URL,
    getHttpModule,
  });

  return {
    downloadBinary,
    downloadBinaryWithHeaders,
    requestJson,
    requestJsonWithHeaders,
    requestStreamingChatText,
  };
}

module.exports = {
  createFlowbotNetworkClients,
};
