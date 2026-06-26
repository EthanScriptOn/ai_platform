"use strict";

function createQwenChatClient({
  defaultModel,
  errorContext = "人物蒸馏",
  fetchImpl = fetch,
  qwenApiKey,
  qwenApiUrl,
}) {
  async function callQwenChat({ model, messages, temperature = 0.2, responseFormat, timeoutMs = 120000 } = {}) {
    if (!qwenApiKey) throw new Error(`缺少 QWEN_API_KEY 或 DASHSCOPE_API_KEY，无法执行${errorContext}。`);
    const body = {
      model: model || defaultModel,
      messages,
      temperature,
    };
    if (responseFormat) body.response_format = responseFormat;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(10000, Number(timeoutMs || 120000)));
    try {
      const response = await fetchImpl(qwenApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${qwenApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(payload?.error?.message || payload?.message || text || `千问 HTTP ${response.status}`);
      }
      return payload?.choices?.[0]?.message?.content || "";
    } finally {
      clearTimeout(timer);
    }
  }

  return { callQwenChat };
}

module.exports = {
  createQwenChatClient,
};
