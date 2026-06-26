function createConfigConnectivityService({
  CONFIG_TEST_PATH,
  SERVICE_FILE_PATH,
  SERVICE_NAME,
  TRANSCRIBE_SCRIPT_PATH,
  extractLlmResponseText,
  fs,
  requestJsonWithHeaders,
  spawnSync,
  writeJsonFile,
}) {
  function summarizeConfigTestError(error) {
    const raw = String(error?.message || error || "").trim();
    const lowered = raw.toLowerCase();
    if (!raw) {
      return {
        status: "unknown",
        summary: "未知错误",
        detail: "",
      };
    }
    if (lowered.includes("usage_limit_reached") || lowered.includes("http_429")) {
      return {
        status: "rate_limited",
        summary: "模型入口已通，但当前配额已用尽",
        detail: raw,
      };
    }
    if (lowered.includes("http_403")) {
      return {
        status: "forbidden",
        summary: "请求被上游拒绝，可能是鉴权或网关策略问题",
        detail: raw,
      };
    }
    if (lowered.includes("http_401")) {
      return {
        status: "unauthorized",
        summary: "鉴权失败，请检查 API Key",
        detail: raw,
      };
    }
    if (lowered.includes("request_timeout") || lowered.includes("timeout")) {
      return {
        status: "timeout",
        summary: "请求超时，请检查网络或代理",
        detail: raw,
      };
    }
    if (lowered.includes("enotfound") || lowered.includes("eai_again")) {
      return {
        status: "dns_error",
        summary: "域名解析失败",
        detail: raw,
      };
    }
    return {
      status: "error",
      summary: "请求失败",
      detail: raw,
    };
  }

  async function runLlmConnectivityTest(config) {
    const result = {
      checkedAt: new Date().toISOString(),
      serviceName: SERVICE_NAME,
      serviceFilePath: SERVICE_FILE_PATH,
      config: {
        llmApiUrl: config.llmApiUrl,
        llmModel: config.llmModel,
        llmClassifyEnabled: config.llmClassifyEnabled,
        transcribeEnabled: config.transcribeEnabled,
        transcribePython: config.transcribePython,
        transcribeModel: config.transcribeModel,
        transcribeLanguage: config.transcribeLanguage,
        targetRoomIds: config.targetRoomIds,
        feishuTargetChatIds: config.feishuTargetChatIds,
        knowledgeHarvestEnabled: config.knowledgeHarvestEnabled,
        knowledgeHarvestRoomIds: config.knowledgeHarvestRoomIds,
      },
      llm: {
        models: {
          ok: false,
          status: "pending",
          summary: "未检测",
        },
        chat: {
          ok: false,
          status: "pending",
          summary: "未检测",
        },
      },
      transcription: {
        enabled: config.transcribeEnabled,
        ready: false,
        status: "pending",
        summary: config.transcribeEnabled ? "未检测" : "语音转写已关闭",
      },
    };

    try {
      const modelsResponse = await requestJsonWithHeaders(
        "GET",
        `${config.llmApiUrl.replace(/\/$/, "")}/models`,
        null,
        {
          Authorization: `Bearer ${config.llmApiKey}`,
        },
        config.llmTimeoutMs,
      );
      const models = Array.isArray(modelsResponse?.data) ? modelsResponse.data : [];
      result.llm.models = {
        ok: true,
        status: "ok",
        summary: `模型列表已返回，共 ${models.length} 个模型`,
        detail: models.slice(0, 20).map((item) => item?.id).filter(Boolean),
      };
    } catch (error) {
      const summary = summarizeConfigTestError(error);
      result.llm.models = {
        ok: summary.status === "rate_limited",
        ...summary,
      };
    }

    try {
      const chatResponse = await requestJsonWithHeaders(
        "POST",
        `${config.llmApiUrl.replace(/\/$/, "")}/chat/completions`,
        {
          model: config.llmModel,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: "请只回复 OK",
            },
          ],
        },
        {
          Authorization: `Bearer ${config.llmApiKey}`,
        },
        config.llmTimeoutMs,
      );
      const text = extractLlmResponseText(chatResponse);
      result.llm.chat = {
        ok: true,
        status: "ok",
        summary: text ? `chat/completions 已返回：${text.slice(0, 80)}` : "chat/completions 已返回，但内容为空",
        detail: {
          id: chatResponse?.id || "",
          model: chatResponse?.model || config.llmModel,
          content: text || "",
        },
      };
    } catch (error) {
      const summary = summarizeConfigTestError(error);
      result.llm.chat = {
        ok: summary.status === "rate_limited",
        ...summary,
      };
    }

    if (!config.transcribeEnabled) {
      result.transcription = {
        enabled: false,
        ready: false,
        status: "disabled",
        summary: "语音转写已关闭",
      };
    } else {
      const pythonCheck = spawnSync(config.transcribePython, ["--version"], {
        encoding: "utf8",
        timeout: Math.min(config.transcribeTimeoutMs, 15000),
      });
      const scriptExists = fs.existsSync(TRANSCRIBE_SCRIPT_PATH);
      if (!pythonCheck.error && pythonCheck.status === 0 && scriptExists) {
        result.transcription = {
          enabled: true,
          ready: true,
          status: "ok",
          summary: `语音转写运行环境可用（${config.transcribeModel}/${config.transcribeLanguage}）`,
          detail: String(pythonCheck.stdout || pythonCheck.stderr || "").trim(),
        };
      } else {
        result.transcription = {
          enabled: true,
          ready: false,
          status: "error",
          summary: "语音转写环境异常",
          detail: String(
            pythonCheck.error
            || pythonCheck.stderr
            || pythonCheck.stdout
            || (scriptExists ? "python_check_failed" : "transcribe_script_missing"),
          ).trim(),
        };
      }
    }

    result.overall = {
      llmConnected: Boolean(result.llm.models.ok || result.llm.chat.ok),
      llmStatus: result.llm.chat.status === "ok"
        ? "可用"
        : (result.llm.chat.status === "rate_limited" ? "已接通但配额耗尽" : "异常"),
      transcriptionReady: Boolean(result.transcription.ready),
    };

    writeJsonFile(CONFIG_TEST_PATH, result);
    return result;
  }

  return {
    runLlmConnectivityTest,
    summarizeConfigTestError,
  };
}

module.exports = { createConfigConnectivityService };
