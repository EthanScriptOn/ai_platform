function createConfigRoutes({
  LOCAL_LAUNCH_AGENT_LABEL,
  SERVICE_FILE_PATH,
  SERVICE_NAME,
  collectBody,
  detectConfigManagerMode,
  getLocalManagedEnvPath,
  listKnowledgeBots,
  maskSecret,
  mergeConfigInput,
  readServiceConfig,
  runLlmConnectivityTest,
  safeParseJson,
  scheduleLocalServiceRestart,
  scheduleServiceRestart,
  sendJson,
  writeLocalServiceConfig,
  writeRuntimeConfig,
  writeServiceConfig,
}) {
  async function handleConfigRoute(req, res, url) {
    if (req.method === "GET" && url.pathname === "/flowbot/config") {
      const serviceConfig = readServiceConfig({ includeSecrets: false });
      sendJson(res, 200, {
        ok: true,
        ...serviceConfig,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/config/ragflow-chats") {
      try {
        const result = listKnowledgeBots
          ? await listKnowledgeBots()
          : { ok: true, provider: "ragflow", enabled: false, bots: [] };
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: String(error?.message || error),
          provider: "ragflow",
          bots: [],
        });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/flowbot/config/test") {
      const rawBody = await collectBody(req);
      const parsedBody = safeParseJson(rawBody) || {};
      const current = readServiceConfig({ includeSecrets: true });
      let merged = null;
      try {
        merged = mergeConfigInput(current.config, parsedBody);
        const testResult = await runLlmConnectivityTest(merged);
        sendJson(res, 200, {
          ok: true,
          config: {
            ...merged,
            llmApiKey: "",
            llmApiKeyConfigured: Boolean(merged.llmApiKey),
            llmApiKeyMasked: maskSecret(merged.llmApiKey),
          },
          testResult,
        });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: String(error?.message || error),
        });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/flowbot/config") {
      const rawBody = await collectBody(req);
      const parsedBody = safeParseJson(rawBody) || {};
      const current = readServiceConfig({ includeSecrets: true });
      try {
        const nextConfig = mergeConfigInput(current.config, parsedBody);
        const managerMode = detectConfigManagerMode();
        if (writeRuntimeConfig) {
          writeRuntimeConfig(nextConfig);
          if (managerMode === "systemd") {
            scheduleServiceRestart();
          } else if (managerMode === "launchagent") {
            scheduleLocalServiceRestart();
          }
        } else if (managerMode === "systemd") {
          writeServiceConfig(nextConfig);
          scheduleServiceRestart();
        } else if (managerMode === "launchagent") {
          writeLocalServiceConfig(nextConfig);
          scheduleLocalServiceRestart();
        } else {
          throw new Error("config_apply_unsupported_in_current_runtime");
        }
        sendJson(res, 200, {
          ok: true,
          message: writeRuntimeConfig
            ? "配置已写入数据库，正在重启服务"
            : (managerMode === "systemd" ? "配置已写入服务文件，正在重启服务" : "本地配置已写入，正在重启 Flowbot"),
          serviceName: managerMode === "systemd" ? SERVICE_NAME : LOCAL_LAUNCH_AGENT_LABEL,
          serviceFilePath: managerMode === "systemd" ? SERVICE_FILE_PATH : getLocalManagedEnvPath(),
          managerMode,
          configStorage: writeRuntimeConfig ? "mysql" : managerMode,
          restarting: true,
          config: {
            ...nextConfig,
            llmApiKey: "",
            llmApiKeyConfigured: Boolean(nextConfig.llmApiKey),
            llmApiKeyMasked: maskSecret(nextConfig.llmApiKey),
          },
        });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: String(error?.message || error),
        });
      }
      return true;
    }

    return false;
  }

  return {
    handleConfigRoute,
  };
}

module.exports = {
  createConfigRoutes,
};
