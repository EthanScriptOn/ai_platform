function createBridgeManagementRoutes({
  ARCHIVE_MODE,
  BATCH_LOG_PATH,
  BATCH_MODE_ENABLED,
  DASHBOARD_DEFAULT_LIMIT,
  DEFAULT_LOGIN_REGION,
  FEISHU_APP_ID,
  FEISHU_OAUTH_REDIRECT_URI,
  FEISHU_OAUTH_SCOPE,
  FEISHU_TARGET_CHAT_IDS,
  FILTER_LOG_PATH,
  LOCAL_MANAGED_CONFIG_PATH,
  LOG_PATH,
  LOGIN_REGION_OPTIONS,
  MEDIA_DIR,
  MESSAGE_POOL_STATE_PATH,
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  NORMALIZED_LOG_PATH,
  PORT,
  TARGET_ROOM_IDS,
  buildDashboardData,
  buildFeishuAuthorizeUrl,
  buildProxyProviderUrl,
  cleanupDashboardNoise,
  clearRoomArchive,
  clearRoomMemory,
  clearRoomSession,
  collectBody,
  compactRoomAgentState,
  createFeishuOauthState,
  exchangeFeishuUserAccessToken,
  fetchFeishuUserInfo,
  fetchUpstreamRoomDetails,
  fetchUpstreamProxy,
  fs,
  getFeishuAppAccessToken,
  getMediaContentType,
  getUpstreamLoginQrcode,
  maskSecret,
  parseProxyProviderInput,
  path,
  readFeishuOauthResult,
  readFeishuOauthState,
  readMessagePoolState,
  requestJsonWithHeaders,
  renderDashboardHtml,
  renderFeishuOauthResultHtml,
  renderProxyHelperHtml,
  runPendingBatchProcessor,
  safeParseJson,
  sendFile,
  sendHtml,
  sendJson,
  sendRedirect,
  setUpstreamClientProxy,
  setUpstreamNotifyUrl,
  toQrcodeDataUri,
  verifyUpstreamLoginQrcode,
  writeFeishuOauthResult,
}) {
  const roomNameCache = new Map();

  function collectRoomDetailRows(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (Array.isArray(value.data)) return value.data;
    if (Array.isArray(value.rooms)) return value.rooms;
    if (Array.isArray(value.room_list)) return value.room_list;
    if (Array.isArray(value.detail)) return value.detail;
    if (value.data && typeof value.data === "object") {
      if (Array.isArray(value.data.rooms)) return value.data.rooms;
      if (Array.isArray(value.data.room_list)) return value.data.room_list;
      if (Array.isArray(value.data.list)) return value.data.list;
      if (Array.isArray(value.data.roominfos)) return value.data.roominfos;
    }
    return [];
  }

  function pickRoomDetailId(row) {
    const info = row?.info && typeof row.info === "object" ? row.info : {};
    return String(row?.roomid || row?.room_id || row?.roomId || row?.chat_id || row?.id || info.roomid || info.room_id || "").trim();
  }

  function pickRoomDetailName(row) {
    const info = row?.info && typeof row.info === "object" ? row.info : {};
    return String(row?.room_name || row?.chat_name || row?.roomName || row?.chatName || row?.name || row?.nickname || info.roomname || info.room_name || info.name || "").trim();
  }

  function normalizeRoomPlatform(value, roomId = "") {
    const platform = String(value || "").trim().toLowerCase();
    if (platform === "feishu" || platform === "lark") return "feishu";
    if (platform === "wecom" || platform === "wework" || platform === "wechat_work") return "wecom";
    return String(roomId || "").startsWith("oc_") ? "feishu" : "wecom";
  }

  function getCurrentWecomGuid() {
    try {
      const dashboardData = buildDashboardData(1);
      const guid = String(dashboardData?.filters?.currentWecomGuid || "").trim();
      if (guid) {
        return guid;
      }
    } catch {}
    try {
      const text = fs.readFileSync(LOG_PATH, "utf8");
      const lines = text.split(/\r?\n/).filter(Boolean).reverse();
      for (const line of lines) {
        const item = safeParseJson(line);
        const guid = String(item?.jsonBody?.guid || "").trim();
        if (guid) {
          return guid;
        }
      }
    } catch {}
    return "";
  }

  async function mapWithConcurrency(items, concurrency, iterator) {
    const list = Array.isArray(items) ? items : [];
    const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
    let nextIndex = 0;
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < list.length) {
        const index = nextIndex;
        nextIndex += 1;
        await iterator(list[index], index);
      }
    }));
  }

  async function fetchRoomNamesByCurrentGuid(roomIds, preferredGuid = "") {
    const currentGuid = String(preferredGuid || getCurrentWecomGuid()).trim();
    const ids = Array.from(new Set(
      (Array.isArray(roomIds) ? roomIds : [])
        .map((roomId) => String(roomId || "").trim())
        .filter(Boolean),
    ));
    const roomNames = {};
    if (!ids.length) {
      return roomNames;
    }
    for (const roomId of ids) {
      const cached = roomNameCache.get(roomId);
      if (cached) {
        roomNames[roomId] = cached;
      }
    }
    const missingIds = ids.filter((roomId) => !roomNames[roomId]);
    if (!currentGuid || !missingIds.length) {
      return roomNames;
    }
    const chunks = [];
    for (let index = 0; index < missingIds.length; index += 20) {
      chunks.push(missingIds.slice(index, index + 20));
    }
    await mapWithConcurrency(chunks, 4, async (chunk) => {
      try {
        const result = await fetchUpstreamRoomDetails(currentGuid, chunk);
        for (const row of collectRoomDetailRows(result)) {
          const roomId = pickRoomDetailId(row);
          const roomName = pickRoomDetailName(row);
          if (roomId && roomName && roomName !== roomId) {
            roomNameCache.set(roomId, roomName);
            roomNames[roomId] = roomName;
          }
        }
      } catch {}
    });
    const fallbackIds = missingIds.filter((id) => !roomNames[id]);
    await mapWithConcurrency(fallbackIds, 8, async (roomId) => {
      try {
        const result = await fetchUpstreamRoomDetails(currentGuid, [roomId]);
        for (const row of collectRoomDetailRows(result)) {
          const rowRoomId = pickRoomDetailId(row) || roomId;
          const roomName = pickRoomDetailName(row);
          if (rowRoomId === roomId && roomName && roomName !== roomId) {
            roomNameCache.set(roomId, roomName);
            roomNames[roomId] = roomName;
            break;
          }
        }
      } catch {}
    });
    return roomNames;
  }

  async function fetchFeishuChatNames(chatIds) {
    const ids = Array.from(new Set(
      (Array.isArray(chatIds) ? chatIds : [])
        .map((chatId) => String(chatId || "").trim())
        .filter(Boolean),
    ));
    const roomNames = {};
    if (!ids.length) {
      return roomNames;
    }
    for (const chatId of ids) {
      const cached = roomNameCache.get(chatId);
      if (cached) {
        roomNames[chatId] = cached;
      }
    }
    const missingIds = ids.filter((chatId) => !roomNames[chatId]);
    if (!missingIds.length) {
      return roomNames;
    }
    let token = null;
    try {
      token = await getFeishuAppAccessToken();
    } catch {
      return roomNames;
    }
    await mapWithConcurrency(missingIds, 6, async (chatId) => {
      try {
        const response = await requestJsonWithHeaders(
          "GET",
          `https://open.feishu.cn/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
          null,
          { Authorization: `Bearer ${token.token}` },
          MEDIA_DOWNLOAD_TIMEOUT_MS || 30000,
        );
        const chat = response?.data || {};
        const chatName = String(chat.name || chat.chat_name || chat.avatar?.name || "").trim();
        if (chatName && chatName !== chatId) {
          roomNameCache.set(chatId, chatName);
          roomNames[chatId] = chatName;
        }
      } catch {}
    });
    return roomNames;
  }

  async function fetchRoomNamesByPlatform(rooms, preferredGuid = "") {
    const items = Array.isArray(rooms) ? rooms : [];
    const wecomIds = [];
    const feishuIds = [];
    for (const item of items) {
      const roomId = String(item?.roomId || item?.id || "").trim();
      if (!roomId) continue;
      const platform = normalizeRoomPlatform(item?.platform, roomId);
      if (platform === "feishu") {
        feishuIds.push(roomId);
      } else {
        wecomIds.push(roomId);
      }
    }
    return {
      ...(await fetchRoomNamesByCurrentGuid(wecomIds, preferredGuid)),
      ...(await fetchFeishuChatNames(feishuIds)),
    };
  }

  async function enrichDashboardDataRoomNames(dashboardData) {
    const rooms = Array.isArray(dashboardData?.filters?.availableRooms)
      ? dashboardData.filters.availableRooms
      : [];
    const selectedRoomId = String(dashboardData?.scope?.selectedRoomId || "").trim();
      const missingRooms = rooms
      .filter((room) => {
        const roomId = String(room?.id || "").trim();
        const roomName = String(room?.name || "").trim();
        return roomId && (!roomName || roomName === roomId);
      });
    if (!missingRooms.length) {
      return dashboardData;
    }
    if (!selectedRoomId) {
      return dashboardData;
    }
    try {
      const currentGuid = String(dashboardData?.filters?.currentWecomGuid || getCurrentWecomGuid()).trim();
      const roomNames = {};
      if (selectedRoomId && missingRooms.some((room) => String(room.id || "") === selectedRoomId)) {
        const selectedRoom = rooms.find((room) => String(room.id || "") === selectedRoomId) || {};
        if (normalizeRoomPlatform(selectedRoom.platform, selectedRoomId) === "feishu") {
          Object.assign(roomNames, await fetchFeishuChatNames([selectedRoomId]));
        } else if (currentGuid) {
        const result = await fetchUpstreamRoomDetails(currentGuid, [selectedRoomId]);
        for (const row of collectRoomDetailRows(result)) {
          const roomId = pickRoomDetailId(row);
          const roomName = pickRoomDetailName(row);
          if (roomId && roomName && roomName !== roomId) {
            roomNameCache.set(roomId, roomName);
            roomNames[roomId] = roomName;
          }
        }
        }
      }
      const remainingRooms = selectedRoomId
        ? []
        : missingRooms;
      Object.assign(roomNames, await fetchRoomNamesByPlatform(remainingRooms, currentGuid));
      if (!Object.keys(roomNames).length) {
        return dashboardData;
      }
      dashboardData.filters.availableRooms = rooms.map((room) => {
        const name = roomNames[String(room.id || "")];
        return name ? { ...room, name } : room;
      });
      if (selectedRoomId && roomNames[selectedRoomId]) {
        dashboardData.scope.selectedRoomLabel = roomNames[selectedRoomId];
      }
    } catch {}
    return dashboardData;
  }

  async function handleBridgeManagementRoute(req, res, url) {
    if (req.method === "GET" && url.pathname === "/feishu/oauth/start") {
      try {
        const state = createFeishuOauthState();
        sendRedirect(res, 302, buildFeishuAuthorizeUrl(state));
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: String(error?.message || error),
        });
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/feishu/oauth/status") {
      const state = readFeishuOauthState();
      const result = readFeishuOauthResult();
      const safeResult = result ? {
        ...result,
        tokenData: result.tokenData ? {
          ...result.tokenData,
          access_token: maskSecret(result.tokenData.access_token),
          refresh_token: maskSecret(result.tokenData.refresh_token),
        } : null,
      } : null;
      sendJson(res, 200, {
        ok: true,
        configured: {
          appId: FEISHU_APP_ID,
          redirectUri: FEISHU_OAUTH_REDIRECT_URI,
          scope: FEISHU_OAUTH_SCOPE,
        },
        latestState: state?.latest || null,
        latestResult: safeResult,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/feishu/oauth/callback") {
      const code = String(url.searchParams.get("code") || "").trim();
      const state = String(url.searchParams.get("state") || "").trim();
      const errorText = String(url.searchParams.get("error") || "").trim();
      const latestState = readFeishuOauthState()?.latest || null;
      if (errorText) {
        sendJson(res, 400, {
          ok: false,
          error: errorText,
          details: Object.fromEntries(url.searchParams.entries()),
        });
        return true;
      }
      if (!code) {
        sendJson(res, 400, {
          ok: false,
          error: "code_missing",
          details: Object.fromEntries(url.searchParams.entries()),
        });
        return true;
      }
      if (!latestState || !latestState.state || state !== String(latestState.state)) {
        sendJson(res, 400, {
          ok: false,
          error: "state_mismatch",
          expected: latestState?.state || "",
          received: state,
        });
        return true;
      }
      try {
        const exchanged = await exchangeFeishuUserAccessToken(code);
        const tokenData = exchanged.data || {};
        const userAccessToken = String(tokenData.access_token || "").trim();
        if (!userAccessToken) {
          throw new Error(`feishu_user_access_token_missing:${JSON.stringify(exchanged.response).slice(0, 1000)}`);
        }
        const userInfo = await fetchFeishuUserInfo(userAccessToken);
        const result = {
          authorizedAt: new Date().toISOString(),
          code,
          state,
          tokenData,
          userInfo,
          appId: FEISHU_APP_ID,
          redirectUri: FEISHU_OAUTH_REDIRECT_URI,
          scope: FEISHU_OAUTH_SCOPE,
        };
        writeFeishuOauthResult(result);
        sendHtml(res, 200, renderFeishuOauthResultHtml(result));
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: String(error?.message || error),
        });
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      const poolState = readMessagePoolState();
      const poolEntries = Object.values(poolState.messages || {});
      sendJson(res, 200, {
        ok: true,
        service: "flowbot-bridge",
        port: PORT,
        logPath: LOG_PATH,
        normalizedLogPath: NORMALIZED_LOG_PATH,
        filterLogPath: FILTER_LOG_PATH,
        batchLogPath: BATCH_LOG_PATH,
        messagePoolStatePath: MESSAGE_POOL_STATE_PATH,
        archiveMode: ARCHIVE_MODE,
        targetRoomIds: Array.from(TARGET_ROOM_IDS),
        feishuTargetChatIds: Array.from(FEISHU_TARGET_CHAT_IDS),
        batchModeEnabled: BATCH_MODE_ENABLED,
        pendingCount: poolEntries.filter((item) => String(item?.status || "") === "pending").length,
        processingCount: poolEntries.filter((item) => String(item?.status || "") === "processing").length,
        now: new Date().toISOString(),
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/") {
      sendJson(res, 200, {
        ok: true,
        message: "flowbot bridge is running",
        archiveMode: ARCHIVE_MODE,
        callbackUrl: "/flowbot/callback",
        healthUrl: "/health",
        logPath: LOG_PATH,
        normalizedLogPath: NORMALIZED_LOG_PATH,
        filterLogPath: FILTER_LOG_PATH,
        batchLogPath: BATCH_LOG_PATH,
        messagePoolStatePath: MESSAGE_POOL_STATE_PATH,
        targetRoomIds: Array.from(TARGET_ROOM_IDS),
        feishuTargetChatIds: Array.from(FEISHU_TARGET_CHAT_IDS),
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/flowbot/process-pending") {
      try {
        const result = await runPendingBatchProcessor({ manual: true });
        sendJson(res, 200, {
          ok: true,
          result,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: String(error?.message || error),
        });
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/wecom-login/regions") {
      sendJson(res, 200, {
        ok: true,
        defaultRegion: DEFAULT_LOGIN_REGION,
        options: LOGIN_REGION_OPTIONS,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/wecom-login/helper") {
      sendHtml(res, 200, renderProxyHelperHtml());
      return true;
    }

    if (req.method === "GET" && url.pathname === "/flowbot/wecom-login/proxy-provider") {
      const region = String(url.searchParams.get("region") || DEFAULT_LOGIN_REGION).trim() || DEFAULT_LOGIN_REGION;
      try {
        const proxyInfo = await fetchUpstreamProxy(region);
        sendJson(res, 200, {
          ok: true,
          region: proxyInfo.region,
          providerUrl: proxyInfo.providerUrl,
          proxy: proxyInfo.proxy,
          raw: proxyInfo.raw,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: String(error?.message || error),
        });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/flowbot/wecom-login/room-details") {
      const rawBody = await collectBody(req);
      const parsedBody = safeParseJson(rawBody) || {};
      const rooms = Array.isArray(parsedBody.rooms) ? parsedBody.rooms : [];
      const currentGuid = getCurrentWecomGuid();
      try {
        const roomIds = rooms
          .map((item) => String(item?.roomId || item?.id || "").trim())
          .filter(Boolean);
        const roomNames = await fetchRoomNamesByPlatform(rooms, currentGuid);
        sendJson(res, 200, {
          ok: true,
          roomNames,
          resultSummary: [{
            guid: currentGuid,
            requested: roomIds.length,
            count: Object.keys(roomNames).length,
          }],
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: String(error?.message || error),
          roomNames: {},
        });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/flowbot/wecom-login/set-notify") {
      const rawBody = await collectBody(req);
      const parsedBody = safeParseJson(rawBody) || {};
      const guid = String(parsedBody.guid || "").trim();
      const notifyUrl = String(parsedBody.notifyUrl || parsedBody.notify_url || "").trim();
      if (!guid) {
        sendJson(res, 400, {
          ok: false,
          error: "guid_required",
        });
        return true;
      }
      if (!notifyUrl) {
        sendJson(res, 400, {
          ok: false,
          error: "notify_url_required",
        });
        return true;
      }
      try {
        const notifyResponse = await setUpstreamNotifyUrl(guid, notifyUrl);
        if (Object.prototype.hasOwnProperty.call(notifyResponse || {}, "error_code") && Number(notifyResponse?.error_code) !== 0) {
          throw new Error(`set_notify_url_failed:${JSON.stringify(notifyResponse).slice(0, 500)}`);
        }
        sendJson(res, 200, {
          ok: true,
          guid,
          notifyUrl,
          notifyResponse,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: String(error?.message || error),
        });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/flowbot/wecom-login/start") {
      const rawBody = await collectBody(req);
      const parsedBody = safeParseJson(rawBody) || {};
      const guid = String(parsedBody.guid || "").trim();
      const region = String(parsedBody.region || DEFAULT_LOGIN_REGION).trim() || DEFAULT_LOGIN_REGION;
      const manualProxy = String(parsedBody.proxy || "").trim();
      const proxyFetchResult = String(parsedBody.proxyFetchResult || "").trim();
      const notifyUrl = String(parsedBody.notifyUrl || parsedBody.notify_url || "").trim();
      if (!guid) {
        sendJson(res, 400, {
          ok: false,
          error: "guid_required",
        });
        return true;
      }
      if (!notifyUrl) {
        sendJson(res, 400, {
          ok: false,
          error: "notify_url_required",
        });
        return true;
      }
      try {
        const notifyResponse = await setUpstreamNotifyUrl(guid, notifyUrl);
        if (Object.prototype.hasOwnProperty.call(notifyResponse || {}, "error_code") && Number(notifyResponse?.error_code) !== 0) {
          throw new Error(`set_notify_url_failed:${JSON.stringify(notifyResponse).slice(0, 500)}`);
        }
        const proxyInfo = manualProxy
          ? {
              proxy: manualProxy,
              ip: "",
              port: "",
              region,
              source: "manual",
            }
          : proxyFetchResult
            ? parseProxyProviderInput(proxyFetchResult, region)
            : await fetchUpstreamProxy(region);
        const setProxyResponse = await setUpstreamClientProxy(guid, proxyInfo.proxy);
        if (Object.prototype.hasOwnProperty.call(setProxyResponse || {}, "error_code") && Number(setProxyResponse?.error_code) !== 0) {
          throw new Error(`set_proxy_failed:${JSON.stringify(setProxyResponse).slice(0, 500)}`);
        }
        const qrcodeResponse = await getUpstreamLoginQrcode(guid);
        const qrcodeBase64 =
          qrcodeResponse?.data?.qrcode
          || qrcodeResponse?.qrcode
          || "";
        if (Object.prototype.hasOwnProperty.call(qrcodeResponse || {}, "error_code") && Number(qrcodeResponse?.error_code) !== 0) {
          throw new Error(`get_login_qrcode_failed:${JSON.stringify(qrcodeResponse).slice(0, 500)}`);
        }
        if (!qrcodeBase64) {
          throw new Error(`qrcode_missing:${JSON.stringify(qrcodeResponse).slice(0, 500)}`);
        }
        sendJson(res, 200, {
          ok: true,
          guid,
          region,
          notifyUrl,
          notifyResponse,
          proxyInfo,
          setProxyResponse,
          qrcodeResponse,
          qrcodeDataUri: toQrcodeDataUri(qrcodeBase64),
          qrcodeKey: String(qrcodeResponse?.data?.key || qrcodeResponse?.key || "").trim(),
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: String(error?.message || error),
        });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/flowbot/wecom-login/verify") {
      const rawBody = await collectBody(req);
      const parsedBody = safeParseJson(rawBody) || {};
      const guid = String(parsedBody.guid || "").trim();
      const code = String(parsedBody.code || "").trim();
      if (!guid) {
        sendJson(res, 400, {
          ok: false,
          error: "guid_required",
        });
        return true;
      }
      if (!code) {
        sendJson(res, 400, {
          ok: false,
          error: "code_required",
        });
        return true;
      }
      try {
        const verifyResponse = await verifyUpstreamLoginQrcode(guid, code);
        sendJson(res, 200, {
          ok: true,
          guid,
          code,
          verifyResponse,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: String(error?.message || error),
        });
      }
      return true;
    }

    if (
      (req.method === "GET" || req.method === "HEAD")
      && (
        url.pathname === "/dashboard"
        || url.pathname === "/dashboard/"
        || url.pathname === "/flowbot/dashboard"
        || url.pathname === "/flowbot/dashboard/"
      )
    ) {
      sendHtml(res, 200, renderDashboardHtml());
      return true;
    }

    if (req.method === "POST" && (url.pathname === "/dashboard/room-action" || url.pathname === "/flowbot/dashboard/room-action")) {
      const rawBody = await collectBody(req);
      const body = safeParseJson(rawBody) || {};
      const roomId = String(body.roomId || "").trim();
      const action = String(body.action || "").trim();
      const allowAllScope = action === "cleanup_noise";
      if ((!roomId || roomId === "__all__") && !allowAllScope) {
        sendJson(res, 400, {
          ok: false,
          error: "room_id_required",
        });
        return true;
      }
      const dashboardData = buildDashboardData(DASHBOARD_DEFAULT_LIMIT);
      const availableRoomIds = new Set(
        (dashboardData?.filters?.availableRooms || [])
          .map((item) => String(item?.id || "").trim())
          .filter(Boolean),
      );
      if (roomId !== "__all__" && !availableRoomIds.has(roomId)) {
        sendJson(res, 404, {
          ok: false,
          error: "room_not_found",
          roomId,
        });
        return true;
      }
      try {
        let result = null;
        if (action === "compact_messages") {
          result = compactRoomAgentState(roomId);
        } else if (action === "clear_session") {
          result = clearRoomSession(roomId);
        } else if (action === "clear_memory") {
          result = clearRoomMemory(roomId);
        } else if (action === "clear_archive") {
          result = clearRoomArchive(roomId);
        } else if (action === "cleanup_noise") {
          result = cleanupDashboardNoise(roomId);
        } else {
          sendJson(res, 400, {
            ok: false,
            error: "invalid_action",
            action,
          });
          return true;
        }
        sendJson(res, 200, {
          ok: true,
          roomId,
          action,
          result,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          roomId,
          action,
          error: String(error?.message || error),
        });
      }
      return true;
    }

    if (
      (req.method === "GET" || req.method === "HEAD")
      && (
        url.pathname === "/dashboard/data"
        || url.pathname === "/dashboard/data/"
        || url.pathname === "/flowbot/dashboard/data"
        || url.pathname === "/flowbot/dashboard/data/"
      )
    ) {
      const dashboardData = buildDashboardData(url.searchParams.get("limit"), url.searchParams.get("roomId"));
      sendJson(res, 200, await enrichDashboardDataRoomNames(dashboardData));
      return true;
    }

    if (req.method === "GET" && url.pathname.startsWith("/flowbot/media/")) {
      const fileName = path.basename(decodeURIComponent(url.pathname.slice("/flowbot/media/".length)));
      if (!fileName || fileName === "." || fileName === "..") {
        sendJson(res, 400, { ok: false, error: "invalid_media_path" });
        return true;
      }
      const mediaPath = path.join(MEDIA_DIR, fileName);
      if (!fs.existsSync(mediaPath)) {
        sendJson(res, 404, { ok: false, error: "media_not_found", fileName });
        return true;
      }
      sendFile(res, 200, mediaPath, getMediaContentType(mediaPath));
      return true;
    }

    return false;
  }

  return {
    handleBridgeManagementRoute,
  };
}

module.exports = {
  createBridgeManagementRoutes,
};
