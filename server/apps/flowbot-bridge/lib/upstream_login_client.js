function createUpstreamLoginClient({
  DEFAULT_LOGIN_REGION,
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  PROXY_PROVIDER_ACCOUNT,
  PROXY_PROVIDER_BASE_URL,
  PROXY_PROVIDER_PASSWORD,
  PROXY_PROVIDER_SECRET,
  PROXY_PROVIDER_SIGN,
  UPSTREAM_WECOM_API_BASE,
  requestJson,
  safeParseJson,
}) {
  function buildProxyProviderUrl(region) {
    const target = new URL(PROXY_PROVIDER_BASE_URL);
    target.searchParams.set("mr", "1");
    target.searchParams.set("num", "1");
    target.searchParams.set("port", "3");
    target.searchParams.set("region", String(region || DEFAULT_LOGIN_REGION).trim() || DEFAULT_LOGIN_REGION);
    target.searchParams.set("secret", PROXY_PROVIDER_SECRET);
    target.searchParams.set("sign", PROXY_PROVIDER_SIGN);
    target.searchParams.set("time", "3");
    target.searchParams.set("type", "json");
    return target.toString();
  }

  function buildSocksProxyUrl(ip, port) {
    return `socks5://${PROXY_PROVIDER_ACCOUNT}:${PROXY_PROVIDER_PASSWORD}@${ip}:${port}`;
  }

  function parseProxyProviderInput(rawInput, region) {
    const text = String(rawInput || "").trim();
    if (!text) {
      throw new Error("proxy_input_required");
    }

    if (/^socks5:\/\//i.test(text)) {
      return {
        region: String(region || DEFAULT_LOGIN_REGION).trim() || DEFAULT_LOGIN_REGION,
        ip: "",
        port: "",
        proxy: text,
        raw: text,
        source: "manual",
      };
    }

    const parsed = safeParseJson(text);
    const row = Array.isArray(parsed?.data) ? parsed.data[0] : (parsed || null);
    if (row?.ip && row?.port) {
      return {
        region: String(region || DEFAULT_LOGIN_REGION).trim() || DEFAULT_LOGIN_REGION,
        ip: String(row.ip),
        port: Number(row.port),
        proxy: buildSocksProxyUrl(row.ip, row.port),
        raw: parsed,
        source: "provider_result",
      };
    }

    const matched = text.match(/(\d{1,3}(?:\.\d{1,3}){3})\s*[:：]\s*(\d{2,5})/);
    if (matched) {
      return {
        region: String(region || DEFAULT_LOGIN_REGION).trim() || DEFAULT_LOGIN_REGION,
        ip: matched[1],
        port: Number(matched[2]),
        proxy: buildSocksProxyUrl(matched[1], matched[2]),
        raw: text,
        source: "provider_result",
      };
    }

    throw new Error("proxy_input_invalid");
  }

  function toQrcodeDataUri(raw) {
    const text = String(raw || "").trim();
    if (!text) {
      return "";
    }
    if (text.startsWith("data:image/")) {
      return text;
    }
    return `data:image/jpeg;base64,${text}`;
  }

  async function fetchUpstreamProxy(region) {
    const url = buildProxyProviderUrl(region);
    const response = await requestJson("GET", url, null, MEDIA_DOWNLOAD_TIMEOUT_MS);
    const row = Array.isArray(response?.data) ? response.data[0] : null;
    if (Number(response?.code) !== 1000 || !row?.ip || !row?.port) {
      throw new Error(`proxy_provider_failed:${JSON.stringify(response).slice(0, 500)}`);
    }
    return {
      providerUrl: url,
      region: String(region || DEFAULT_LOGIN_REGION).trim() || DEFAULT_LOGIN_REGION,
      ip: String(row.ip),
      port: Number(row.port),
      proxy: buildSocksProxyUrl(row.ip, row.port),
      raw: response,
    };
  }

  async function setUpstreamClientProxy(guid, proxy) {
    return requestJson(
      "POST",
      `${UPSTREAM_WECOM_API_BASE}/client/set_proxy`,
      {
        guid,
        proxy,
      },
      MEDIA_DOWNLOAD_TIMEOUT_MS,
    );
  }

  async function setUpstreamNotifyUrl(guid, notifyUrl) {
    return requestJson(
      "POST",
      `${UPSTREAM_WECOM_API_BASE}/client/set_notify_url`,
      {
        guid,
        notify_url: notifyUrl,
      },
      MEDIA_DOWNLOAD_TIMEOUT_MS,
    );
  }

  async function getUpstreamLoginQrcode(guid) {
    return requestJson(
      "POST",
      `${UPSTREAM_WECOM_API_BASE}/login/get_login_qrcode`,
      {
        guid,
        verify_login: false,
      },
      MEDIA_DOWNLOAD_TIMEOUT_MS,
    );
  }

  async function verifyUpstreamLoginQrcode(guid, code) {
    return requestJson(
      "POST",
      `${UPSTREAM_WECOM_API_BASE}/login/verify_login_qrcode`,
      {
        guid,
        code,
      },
      MEDIA_DOWNLOAD_TIMEOUT_MS,
    );
  }

  async function fetchUpstreamRoomDetails(guid, roomList) {
    const normalizedGuid = String(guid || "").trim();
    const rooms = Array.from(new Set(
      (Array.isArray(roomList) ? roomList : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ));
    if (!normalizedGuid || !rooms.length) {
      return null;
    }
    return requestJson(
      "POST",
      `${UPSTREAM_WECOM_API_BASE}/room/batch_get_room_detail`,
      {
        guid: normalizedGuid,
        room_list: rooms,
      },
      MEDIA_DOWNLOAD_TIMEOUT_MS,
    );
  }

  return {
    buildProxyProviderUrl,
    fetchUpstreamRoomDetails,
    fetchUpstreamProxy,
    getUpstreamLoginQrcode,
    parseProxyProviderInput,
    setUpstreamClientProxy,
    setUpstreamNotifyUrl,
    toQrcodeDataUri,
    verifyUpstreamLoginQrcode,
  };
}

module.exports = { createUpstreamLoginClient };
