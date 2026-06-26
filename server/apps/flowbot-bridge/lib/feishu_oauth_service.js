function createFeishuOauthService({
  FEISHU_APP_ACCESS_TOKEN_URL,
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_AUTHORIZE_URL,
  FEISHU_OAUTH_REDIRECT_URI,
  FEISHU_OAUTH_RESULT_PATH,
  FEISHU_OAUTH_SCOPE,
  FEISHU_OAUTH_STATE_PATH,
  FEISHU_USER_ACCESS_TOKEN_URL,
  FEISHU_USER_INFO_URL,
  URL,
  crypto,
  maskSecret,
  readJsonFile,
  requestJson,
  requestJsonWithHeaders,
  writeJsonFile,
}) {
  function readFeishuOauthState() {
    return readJsonFile(FEISHU_OAUTH_STATE_PATH, { latest: null });
  }

  function writeFeishuOauthState(value) {
    writeJsonFile(FEISHU_OAUTH_STATE_PATH, value);
  }

  function readFeishuOauthResult() {
    return readJsonFile(FEISHU_OAUTH_RESULT_PATH, null);
  }

  function writeFeishuOauthResult(value) {
    writeJsonFile(FEISHU_OAUTH_RESULT_PATH, value);
  }

  async function getFeishuAppAccessToken() {
    const response = await requestJson(
      "POST",
      FEISHU_APP_ACCESS_TOKEN_URL,
      {
        app_id: FEISHU_APP_ID,
        app_secret: FEISHU_APP_SECRET,
      },
      30000,
    );
    const token = String(response?.app_access_token || "").trim();
    if (!token) {
      throw new Error(`feishu_app_access_token_missing:${JSON.stringify(response).slice(0, 500)}`);
    }
    return {
      token,
      response,
    };
  }

  function createFeishuOauthState() {
    const state = crypto.randomBytes(16).toString("hex");
    writeFeishuOauthState({
      latest: {
        state,
        createdAt: new Date().toISOString(),
        redirectUri: FEISHU_OAUTH_REDIRECT_URI,
        scope: FEISHU_OAUTH_SCOPE,
      },
    });
    return state;
  }

  function buildFeishuAuthorizeUrl(state) {
    const target = new URL(FEISHU_AUTHORIZE_URL);
    target.searchParams.set("app_id", FEISHU_APP_ID);
    target.searchParams.set("redirect_uri", FEISHU_OAUTH_REDIRECT_URI);
    target.searchParams.set("response_type", "code");
    if (FEISHU_OAUTH_SCOPE) {
      target.searchParams.set("scope", FEISHU_OAUTH_SCOPE);
    }
    if (state) {
      target.searchParams.set("state", state);
    }
    return target.toString();
  }

  async function exchangeFeishuUserAccessToken(code) {
    const appAccess = await getFeishuAppAccessToken();
    const response = await requestJsonWithHeaders(
      "POST",
      FEISHU_USER_ACCESS_TOKEN_URL,
      {
        grant_type: "authorization_code",
        code,
      },
      {
        Authorization: `Bearer ${appAccess.token}`,
      },
      30000,
    );
    return {
      appAccess,
      response,
      data: response?.data || {},
    };
  }

  async function fetchFeishuUserInfo(userAccessToken) {
    const response = await requestJsonWithHeaders(
      "GET",
      FEISHU_USER_INFO_URL,
      null,
      {
        Authorization: `Bearer ${userAccessToken}`,
      },
      30000,
    );
    return response;
  }

  function renderFeishuOauthResultHtml(result) {
    const user = result?.userInfo?.data || {};
    const tokenData = result?.tokenData || {};
    const lines = [
      ["授权结果", "成功拿到飞书用户凭证"],
      ["用户", String(user?.name || user?.en_name || user?.open_id || "未知")],
      ["Open ID", String(user?.open_id || "")],
      ["Union ID", String(user?.union_id || "")],
      ["Access Token", maskSecret(tokenData?.access_token || "")],
      ["Refresh Token", maskSecret(tokenData?.refresh_token || "")],
      ["过期秒数", String(tokenData?.expires_in || "")],
      ["授权时间", String(result?.authorizedAt || "")],
    ];
    const items = lines.map(([label, value]) => `<tr><th>${label}</th><td>${String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</td></tr>`).join("");
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>飞书授权结果</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f6f4ef; color:#1f1a16; padding:32px; }
    .card { max-width:760px; margin:0 auto; background:#fff; border-radius:20px; padding:28px; box-shadow:0 18px 60px rgba(33,24,15,.08); }
    h1 { margin:0 0 12px; font-size:28px; }
    p { color:#665d55; }
    table { width:100%; border-collapse:collapse; margin-top:20px; }
    th,td { text-align:left; padding:12px 0; border-bottom:1px solid #eee2d4; vertical-align:top; }
    th { width:140px; color:#7b6b5c; font-weight:600; }
    .tip { margin-top:20px; padding:14px 16px; border-radius:14px; background:#edf6f0; color:#255b3f; }
  </style>
</head>
<body>
  <div class="card">
    <h1>飞书授权已完成</h1>
    <p>服务端已经收到了你的用户凭证，接下来就可以按你的成员权限去读取私有知识库了。</p>
    <table>${items}</table>
    <div class="tip">现在回到对话里告诉我“已授权”，我就继续拉取飞书知识库内容。</div>
  </div>
</body>
</html>`;
  }

  return {
    buildFeishuAuthorizeUrl,
    createFeishuOauthState,
    exchangeFeishuUserAccessToken,
    fetchFeishuUserInfo,
    getFeishuAppAccessToken,
    readFeishuOauthResult,
    readFeishuOauthState,
    renderFeishuOauthResultHtml,
    writeFeishuOauthResult,
    writeFeishuOauthState,
  };
}

module.exports = { createFeishuOauthService };
