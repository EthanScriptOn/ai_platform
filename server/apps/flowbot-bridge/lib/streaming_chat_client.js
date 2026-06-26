function createStreamingChatClient({
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  URL,
  getHttpModule,
}) {
  function extractTextDelta(value) {
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => extractTextDelta(item)).join("");
    }
    if (value && typeof value === "object") {
      if (typeof value.text === "string") {
        return value.text;
      }
      if (typeof value.content === "string") {
        return value.content;
      }
    }
    return "";
  }

  function requestStreamingChatText(target, payload, headers = {}, timeoutMs = MEDIA_DOWNLOAD_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const targetUrl = new URL(target);
      const body = JSON.stringify({
        ...payload,
        stream: true,
      });
      const transport = getHttpModule(targetUrl);
      let resolved = false;
      let buffer = "";
      let aggregated = "";

      const req = transport.request(
        {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port || undefined,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method: "POST",
          timeout: timeoutMs,
          headers: {
            Accept: "text/event-stream",
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            ...headers,
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => reject(new Error(`http_${res.statusCode}:${Buffer.concat(chunks).toString("utf8").slice(0, 1000)}`)));
            return;
          }
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            buffer += chunk;
            const blocks = buffer.split(/\n\n/);
            buffer = blocks.pop() || "";
            for (const block of blocks) {
              const lines = block
                .split(/\r?\n/g)
                .map((line) => line.trim())
                .filter(Boolean);
              for (const line of lines) {
                if (!line.startsWith("data:")) {
                  continue;
                }
                const data = line.slice(5).trim();
                if (!data || data === "[DONE]") {
                  continue;
                }
                try {
                  const parsed = JSON.parse(data);
                  const choiceDelta = parsed?.choices?.[0]?.delta?.content;
                  const responseDelta = parsed?.delta;
                  const responseDone = parsed?.text;
                  aggregated += extractTextDelta(choiceDelta);
                  aggregated += extractTextDelta(responseDelta);
                  if (parsed?.type === "response.output_text.done") {
                    aggregated += extractTextDelta(responseDone);
                  }
                } catch {
                  continue;
                }
              }
            }
          });
          res.on("end", () => {
            if (resolved) {
              return;
            }
            resolved = true;
            resolve(aggregated.trim());
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("request_timeout")));
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  return {
    extractTextDelta,
    requestStreamingChatText,
  };
}

module.exports = { createStreamingChatClient };
