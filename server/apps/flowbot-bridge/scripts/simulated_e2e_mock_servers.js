"use strict";

const { PNG_1X1 } = require("./simulated_e2e_callbacks");
const { collectBody, createServer, sendJson } = require("./simulated_e2e_http");
const {
  buildTextResponse,
  buildToolCallResponse,
  contentHasImageUrl,
  contextContains,
  extractLatestToolPayload,
  extractTriggerPayload,
  normalizeText,
  summarizeContextItems,
} = require("./simulated_e2e_llm_helpers");

async function createSimulatedMockServers(state) {
  const upstream = await createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/msg/send_text") {
      const body = JSON.parse(String(await collectBody(req) || "{}") || "{}");
      state.upstreamSendTextCalls.push({
        at: new Date().toISOString(),
        body,
      });
      sendJson(res, 200, {
        error_code: 0,
        error_message: "",
        data: {
          msg_id: `mock-${state.upstreamSendTextCalls.length}`,
        },
      });
      return;
    }

    if (req.method === "POST" && req.url === "/cloud/cdn_c2c_download") {
      sendJson(res, 200, {
        error_code: 0,
        error_message: "",
        data: {
          url: `${upstream.baseUrl}/mock-image.png`,
        },
      });
      return;
    }

    if (req.method === "GET" && req.url === "/mock-image.png") {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": PNG_1X1.length,
      });
      res.end(PNG_1X1);
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found", url: req.url });
  });

  const llm = await createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/chat/completions") {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    const payload = JSON.parse(String(await collectBody(req) || "{}") || "{}");
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    state.llmRequests.push(payload);

    const hasAnyImage = messages.some((message) => contentHasImageUrl(message?.content));
    const hasToolMessage = messages.some((message) => message?.role === "tool");
    const hasSendGroupReplyToolResult = messages.some(
      (message) => message?.role === "tool"
        && typeof message?.content === "string"
        && message.content.includes("\"sentAt\""),
    );
    const triggerPayload = extractTriggerPayload(messages) || {};
    const triggerMessage = triggerPayload?.message || {};
    const triggerText = normalizeText([
      triggerMessage?.text,
      triggerMessage?.content,
      triggerMessage?.quote,
      triggerMessage?.quote_content,
      triggerMessage?.title,
      triggerMessage?.desc,
    ].filter(Boolean).join("\n"));
    const routeReason = normalizeText(triggerPayload?.trigger?.reason || "");
    const toolPayload = extractLatestToolPayload(messages);
    const contextItems = summarizeContextItems(toolPayload);

    if (hasAnyImage && !hasToolMessage) {
      state.sawTriggerImage = true;
    }
    if (hasAnyImage && hasToolMessage) {
      state.sawToolVisionImage = true;
    }
    if (hasToolMessage) {
      state.toolObservations.push({
        triggerText,
        routeReason,
        contextItems,
        rawPayload: toolPayload,
      });
    }

    if (hasSendGroupReplyToolResult) {
      sendJson(res, 200, buildTextResponse(`stop-${state.llmRequests.length}`, "[[NO_REPLY]]"));
      return;
    }

    if (!hasToolMessage) {
      let limit = 6;
      if (triggerText.includes("回到前面支付回调")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`memory-${state.llmRequests.length}`, "search_room_messages", { query: "支付回调", limit: 6 }),
        );
        return;
      }
      if (triggerText.includes("单说支付回调那条")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`memory-${state.llmRequests.length}`, "search_room_messages", { query: "支付回调", limit: 8 }),
        );
        return;
      }
      if (triggerText.includes("回到刚才那张图对应的问题")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`recent-${state.llmRequests.length}`, "get_recent_room_messages", { limit: 12 }),
        );
        return;
      }
      if (triggerText.includes("我这边那个回调问题") || triggerText.includes("我这个回调问题")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`memory-${state.llmRequests.length}`, "search_room_messages", {
            query: "支付回调",
            senderId: triggerPayload?.trigger?.from_id || "",
            limit: 8,
          }),
        );
        return;
      }
      if (triggerText.includes("回到我前面那个问题") && triggerText.includes("库存同步")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`memory-${state.llmRequests.length}`, "search_room_messages", {
            query: "库存同步",
            senderId: triggerPayload?.trigger?.from_id || "",
            limit: 6,
          }),
        );
        return;
      }
      if (triggerText.includes("回到前面那个问题") && triggerText.includes("根因")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`recent-${state.llmRequests.length}`, "get_recent_room_messages", { limit: 18 }),
        );
        return;
      }
      if (triggerText.includes("第一个")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`recent-${state.llmRequests.length}`, "get_recent_room_messages", { limit: 10 }),
        );
        return;
      }
      if (triggerText.includes("我说的那个素材问题")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`memory-${state.llmRequests.length}`, "search_room_messages", {
            query: "素材",
            senderId: triggerPayload?.trigger?.from_id || "",
            limit: 8,
          }),
        );
        return;
      }
      if (triggerText.includes("我这边那个素材问题") || triggerText.includes("我这个素材问题")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`memory-${state.llmRequests.length}`, "search_room_messages", {
            query: "素材",
            senderId: triggerPayload?.trigger?.from_id || "",
            limit: 8,
          }),
        );
        return;
      }
      if (triggerText.includes("我只记得好像是回不来")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`recent-${state.llmRequests.length}`, "get_recent_room_messages", { limit: 24 }),
        );
        return;
      }
      if (triggerText.includes("这个情况你怎么看")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`search-${state.llmRequests.length}`, "search_room_messages", {
            query: "怪",
            senderId: triggerPayload?.trigger?.from_id || "",
            limit: 6,
          }),
        );
        return;
      }
      if (triggerText.includes("结合我刚补的内容")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`recent-${state.llmRequests.length}`, "get_recent_room_messages", { limit: 8 }),
        );
        return;
      }
      if (triggerText.includes("我刚才语音和截图说的是什么问题")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`recent-${state.llmRequests.length}`, "get_recent_room_messages", { limit: 10 }),
        );
        return;
      }
      if (triggerText.includes("回到我刚才语音那个问题")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`memory-${state.llmRequests.length}`, "search_room_messages", {
            query: "订单页一直转圈",
            senderId: triggerPayload?.trigger?.from_id || "",
            limit: 8,
          }),
        );
        return;
      }
      if (triggerText.includes("补充一点，用户说下单页打不开")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`recent-${state.llmRequests.length}`, "get_recent_room_messages", { limit: 6 }),
        );
        return;
      }
      if (triggerText.includes("再补一条，日志里订单接口超时，页面一直转圈")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`recent-${state.llmRequests.length}`, "get_recent_room_messages", { limit: 8 }),
        );
        return;
      }
      if (triggerText.includes("用户说报错是订单页一直转圈")) {
        sendJson(
          res,
          200,
          buildToolCallResponse(`recent-${state.llmRequests.length}`, "get_recent_room_messages", { limit: 8 }),
        );
        return;
      }
      if (triggerText.includes("四十条消息")) {
        limit = 24;
      } else if (triggerText.includes("二十多条消息")) {
        limit = 14;
      } else if (triggerText.includes("刚才这个问题你怎么看")) {
        limit = 10;
      }
      sendJson(
        res,
        200,
        buildToolCallResponse(`search-${state.llmRequests.length}`, "get_recent_room_messages", { limit }),
      );
      return;
    }

    if (triggerText.includes("机器人说过这个问题") || triggerText.includes("小智这个机器人")) {
      sendJson(res, 200, buildTextResponse(`ignore-${state.llmRequests.length}`, "[[NO_REPLY]]"));
      return;
    }

    let content = "我先看到了你的消息。";
    if (triggerText.includes("这个图在说什么")) {
      content = "我看到了，这是一张模拟测试图片。";
    } else if (triggerText.includes("云发单")) {
      content = "云发单主要是做发圈、发群和转链等场景的业务工具。";
    } else if (triggerText.includes("心情")) {
      content = "你好呀，我今天心情不错。";
    } else if ((triggerText.includes("这个情况你怎么看") || triggerText.includes("结合我刚补的内容")) && contextContains(contextItems, "订单页一直转圈")) {
      content = "结合你刚补的现象，这更像是下单或订单页加载链路卡住了，优先查订单接口耗时、网关超时和前端重试。";
    } else if (triggerText.includes("补充一点，用户说下单页打不开")) {
      if (contextContains(contextItems, "下单页打不开")) {
        content = "我先收敛到下单页加载链路异常了，但还差最直接的报错或现象，比如超时、502 或一直转圈。";
      }
    } else if (triggerText.includes("再补一条，日志里订单接口超时，页面一直转圈")) {
      const sawPageDown = contextContains(contextItems, "下单页打不开");
      const sawTimeout = contextContains(contextItems, "订单接口超时");
      const sawSpin = contextContains(contextItems, "页面一直转圈");
      if (sawPageDown && sawTimeout && sawSpin) {
        content = "结合你这三次补充，问题已经比较明确了：更像订单接口超时把页面加载链路拖住了，所以用户看到一直转圈。";
      }
    } else if (triggerText.includes("支付回调失败这个问题你先给个排查方向")) {
      content = "先查回调网关、超时日志和订单状态回写链路，再确认是否有重试积压。";
    } else if (triggerText.includes("素材群发文字丢失这个问题先看哪里")) {
      content = "先看素材群发任务、文案拼装和发送渲染链路，重点排查图片和文字合并阶段。";
    } else if (triggerText.includes("结合上面看下是什么问题")) {
      const saw502 = contextContains(contextItems, "登录页报 502");
      const sawOrderBlocked = contextContains(contextItems, "下单也卡住");
      if (saw502 && sawOrderBlocked) {
        content = "从上面的群消息看，像是服务异常或停服影响，建议先确认上游服务状态和回调链路。";
      } else {
        content = "我看到了上文，但信息还不够完整，建议再补一条具体报错或截图。";
      }
    } else if (triggerText.includes("回到前面支付回调")) {
      if (Array.isArray(toolPayload?.items) && toolPayload.items.length && !Array.isArray(toolPayload?.matches)) {
        const preferredHit = toolPayload.items.find((item) => {
          const text = `${item?.text || ""} ${item?.quote || ""}`;
          return (
            text.includes("支付回调失败")
            || text.includes("订单状态没更新")
            || text.includes("售后消息也没推送")
          ) && !text.includes("回到前面支付回调");
        }) || toolPayload.items.find((item) => {
          const text = `${item?.text || ""} ${item?.quote || ""}`;
          return !text.includes("回到前面支付回调");
        }) || toolPayload.items[0];
        sendJson(
          res,
          200,
          buildToolCallResponse(`anchor-${state.llmRequests.length}`, "get_anchor_context", {
            traceId: preferredHit.id,
            before: 2,
            after: 8,
          }),
        );
        return;
      }
      const sawCallbackFail = contextContains(contextItems, "支付回调失败");
      const sawOrderNotUpdated = contextContains(contextItems, "订单状态没更新");
      const sawAfterSale = contextContains(contextItems, "售后消息也没推送");
      if (sawCallbackFail && sawOrderNotUpdated && sawAfterSale) {
        content = "回到前面那个支付回调问题，最核心的异常仍然是支付回调失败，并且已经影响订单状态更新和售后消息推送。";
      } else {
        content = "我回查了前面的支付回调问题，但关键信息还不够完整。";
      }
    } else if (triggerText.includes("单说支付回调那条")) {
      if (Array.isArray(toolPayload?.items) && toolPayload.items.length && !Array.isArray(toolPayload?.matches)) {
        const preferredHit = toolPayload.items.find((item) => `${item?.text || ""}`.includes("支付回调失败")) || toolPayload.items[0];
        sendJson(
          res,
          200,
          buildToolCallResponse(`anchor-${state.llmRequests.length}`, "get_anchor_context", {
            traceId: preferredHit.id,
            before: 1,
            after: 6,
          }),
        );
        return;
      }
      const sawCallbackFail = contextContains(contextItems, "支付回调失败");
      const sawOrderNotUpdated = contextContains(contextItems, "订单状态没更新");
      const sawAfterSale = contextContains(contextItems, "售后消息也没推送");
      if (sawCallbackFail && sawOrderNotUpdated && sawAfterSale) {
        content = "单说支付回调这条，根因仍然更像回调链路失败或超时，已经影响订单状态更新和售后消息推送。";
      } else {
        content = "我回查了支付回调那条，但还缺一个更直接的异常点。";
      }
    } else if (triggerText.includes("回到刚才那张图对应的问题")) {
      if (Array.isArray(toolPayload?.items) && toolPayload.items.length && !Array.isArray(toolPayload?.matches)) {
        const preferredHit = toolPayload.items.find((item) => {
          const text = `${item?.text || ""} ${item?.quote || ""}`;
          return text.includes("登录页报 502") || text.includes("订单页一直转圈");
        }) || toolPayload.items[0];
        sendJson(
          res,
          200,
          buildToolCallResponse(`anchor-${state.llmRequests.length}`, "get_anchor_context", {
            traceId: preferredHit.id,
            before: 1,
            after: 5,
          }),
        );
        return;
      }
      const sawLogin502 = contextContains(contextItems, "登录页报 502");
      const sawSpin = contextContains(contextItems, "订单页一直转圈");
      if (sawLogin502 || sawSpin) {
        content = "回到刚才那张图对应的问题，更像是登录或下单页请求异常，优先查网关状态、接口超时和前端重试。";
      } else {
        content = "我回查了刚才那张图对应的问题，但还缺一条更直接的现场现象。";
      }
    } else if (triggerText.includes("我刚才语音和截图说的是什么问题")) {
      const sawTranscript = contextContains(contextItems, "支付成功了，但是订单页一直转圈，回不来");
      const sawImageDesc = contextContains(contextItems, "打开订单详情页时页面一直加载");
      if (sawTranscript && sawImageDesc) {
        content = "我看到你语音里说支付成功后订单页一直转圈，结合截图更像订单页加载或订单接口异常，优先查接口超时和网关。";
      } else {
        content = "我看到了你刚才的语音或截图，但还缺一块关键上下文。";
      }
    } else if (triggerText.includes("回到我刚才语音那个问题")) {
      if (Array.isArray(toolPayload?.items) && toolPayload.items.length && !Array.isArray(toolPayload?.matches)) {
        const preferredHit = toolPayload.items.find((item) => {
          const text = `${item?.text || ""} ${item?.transcript_text || ""} ${item?.desc || ""}`;
          return text.includes("订单页一直转圈") || text.includes("页面一直加载");
        }) || toolPayload.items[0];
        sendJson(
          res,
          200,
          buildToolCallResponse(`anchor-${state.llmRequests.length}`, "get_anchor_context", {
            traceId: preferredHit.id,
            before: 1,
            after: 4,
          }),
        );
        return;
      }
      const sawTranscript = contextContains(contextItems, "支付成功了，但是订单页一直转圈，回不来");
      const sawImageDesc = contextContains(contextItems, "打开订单详情页时页面一直加载");
      if (sawTranscript && sawImageDesc) {
        content = "回到你刚才语音那个问题，更像支付后的订单页加载链路异常，重点查订单接口超时、网关和前端重试。";
      } else {
        content = "我回查了你刚才语音那个问题，但上下文还不够完整。";
      }
    } else if (triggerText.includes("我这边那个回调问题") || triggerText.includes("我这个回调问题")) {
      if (Array.isArray(toolPayload?.items) && toolPayload.items.length && !Array.isArray(toolPayload?.matches)) {
        const preferredHit = toolPayload.items.find((item) => `${item?.text || ""}`.includes("支付回调")) || toolPayload.items[0];
        sendJson(
          res,
          200,
          buildToolCallResponse(`anchor-${state.llmRequests.length}`, "get_anchor_context", {
            traceId: preferredHit.id,
            before: 1,
            after: 5,
          }),
        );
        return;
      }
      const sawPaymentTopic = contextContains(contextItems, "支付回调");
      const sawCallbackFail = contextContains(contextItems, "支付回调失败");
      const sawOrderNotUpdated = contextContains(contextItems, "订单状态没更新");
      const sawAfterSale = contextContains(contextItems, "售后消息也没推送");
      if (sawPaymentTopic || (sawCallbackFail && sawOrderNotUpdated && sawAfterSale)) {
        content = triggerText.includes("一句话说根因")
          ? "你这个回调问题一句话说，还是回调链路失败或超时，已经连带影响订单状态和售后消息。"
          : "你这个回调问题现在优先查回调网关、超时日志和订单状态回写，再看是否有重试积压。";
      } else {
        content = "我回查了你这个回调问题，但还缺少关键上下文。";
      }
    } else if (triggerText.includes("回到我前面那个问题") && triggerText.includes("库存同步")) {
      if (Array.isArray(toolPayload?.items) && toolPayload.items.length && !Array.isArray(toolPayload?.matches)) {
        const preferredHit = toolPayload.items.find((item) => {
          const text = `${item?.text || ""} ${item?.quote || ""}`;
          return text.includes("库存同步失败") || text.includes("ERP 回写延迟");
        }) || toolPayload.items[0];
        sendJson(
          res,
          200,
          buildToolCallResponse(`anchor-${state.llmRequests.length}`, "get_anchor_context", {
            traceId: preferredHit.id,
            before: 2,
            after: 6,
          }),
        );
        return;
      }
      const sawInventoryFail = contextContains(contextItems, "库存同步失败");
      const sawErpDelay = contextContains(contextItems, "ERP 回写延迟");
      const sawQueueBacklog = contextContains(contextItems, "同步队列积压");
      if (sawInventoryFail && sawErpDelay && sawQueueBacklog) {
        content = "回到你前面那个库存同步问题，更像是 ERP 回写或消费链路卡住了，建议先查同步队列和重试日志。";
      } else {
        content = "我回查了你前面的库存同步问题，但还缺少关键链路信息，先补一下队列或回写日志。";
      }
    } else if (triggerText.includes("回到前面那个问题") && triggerText.includes("根因")) {
      const sawCallbackFail = contextContains(contextItems, "支付回调失败");
      const sawMaterialIssue = contextContains(contextItems, "素材群发")
        || contextContains(contextItems, "文字丢失")
        || contextContains(contextItems, "文案丢失");
      if (sawCallbackFail && sawMaterialIssue) {
        content = "我这边看到前面至少有两个问题：1. 支付回调失败，影响订单状态和售后消息；2. 素材群发异常，出现发送失败或文案丢失。你说的是哪一个？";
      } else {
        content = "我回看了前面的记录，但当前还没法唯一定位到你说的是哪一个问题。你可以补一句关键词，或者我给你列两个候选。";
      }
    } else if (triggerText.includes("第一个")) {
      const sawPaymentTopic = contextContains(contextItems, "支付回调失败");
      if (sawPaymentTopic) {
        content = "如果你说的是第一个，也就是支付回调问题，那当前最核心的还是回调链路失败，并且已经影响订单状态更新和售后消息推送。";
      } else {
        content = "我知道你在选候选项了，但我还需要看到上一条候选上下文。";
      }
    } else if (triggerText.includes("我说的那个素材问题")) {
      if (Array.isArray(toolPayload?.items) && toolPayload.items.length && !Array.isArray(toolPayload?.matches)) {
        const preferredHit = toolPayload.items.find((item) => {
          const text = `${item?.text || ""} ${item?.quote || ""}`;
          return text.includes("素材群发") || text.includes("文案丢失") || text.includes("文字丢失");
        }) || toolPayload.items[0];
        sendJson(
          res,
          200,
          buildToolCallResponse(`anchor-${state.llmRequests.length}`, "get_anchor_context", {
            traceId: preferredHit.id,
            before: 1,
            after: 5,
          }),
        );
        return;
      }
      const sawMaterialIssue = contextContains(contextItems, "素材群发")
        || contextContains(contextItems, "文案丢失")
        || contextContains(contextItems, "文字丢失");
      if (sawMaterialIssue) {
        content = "如果回到你说的素材问题，当前更像是素材群发链路或文案拼装异常，优先查群发任务和素材渲染。";
      } else {
        content = "我回查了你说的素材问题，但上下文还不够聚焦。";
      }
    } else if (triggerText.includes("我这边那个素材问题") || triggerText.includes("我这个素材问题")) {
      if (Array.isArray(toolPayload?.items) && toolPayload.items.length && !Array.isArray(toolPayload?.matches)) {
        const preferredHit = toolPayload.items.find((item) => {
          const text = `${item?.text || ""} ${item?.quote || ""}`;
          return text.includes("素材群发") || text.includes("文案丢失") || text.includes("文字丢失");
        }) || toolPayload.items[0];
        sendJson(
          res,
          200,
          buildToolCallResponse(`anchor-${state.llmRequests.length}`, "get_anchor_context", {
            traceId: preferredHit.id,
            before: 1,
            after: 5,
          }),
        );
        return;
      }
      const sawMaterialTopic = contextContains(contextItems, "素材")
        || contextContains(contextItems, "群发");
      const sawMaterialIssue = contextContains(contextItems, "素材群发")
        || contextContains(contextItems, "文案丢失")
        || contextContains(contextItems, "文字丢失");
      if (sawMaterialTopic || sawMaterialIssue) {
        content = triggerText.includes("直接给结论")
          ? "你这个素材问题直接看，还是素材群发链路或文案拼装异常，重点查任务和渲染。"
          : "你这个素材问题现在优先看群发任务、素材渲染和文案拼装链路。";
      } else {
        content = "我回查了你这个素材问题，但上下文还不够聚焦。";
      }
    } else if (triggerText.includes("我只记得好像是回不来")) {
      const sawPaymentTopic = contextContains(contextItems, "订单状态没更新")
        || contextContains(contextItems, "支付回调失败");
      const sawInventoryTopic = contextContains(contextItems, "库存同步")
        || contextContains(contextItems, "ERP 回写延迟");
      const sawMaterialTopic = contextContains(contextItems, "素材群发")
        || contextContains(contextItems, "文案丢失")
        || contextContains(contextItems, "文字丢失");
      if (sawPaymentTopic && sawInventoryTopic && sawMaterialTopic) {
        content = "我现在还不能唯一确定你说的是哪件事。可能是：1. 支付回调/订单未更新；2. 库存同步/ERP 回写延迟；3. 素材群发/文案丢失。你补一个关键词，或者直接选一个。";
      } else {
        content = "我回看了一圈，但你这句还太模糊了。请补一个关键词，比如支付、库存、素材，我再继续。";
      }
    } else if (triggerText.includes("四十条消息")) {
      const sawSignatureFail = contextContains(contextItems, "回调签名校验失败");
      const sawRetryBacklog = contextContains(contextItems, "重试队列积压");
      const sawWecomNotify = contextContains(contextItems, "企微通知没发出");
      if (sawSignatureFail && sawRetryBacklog && sawWecomNotify) {
        content = "综合前面的长链路消息，主问题更像是回调验签失败，已经进一步拖慢重试队列，并导致企微通知发送异常。";
      } else {
        content = "我只抓到了一部分长链路信息，建议再补关键错误点。";
      }
    } else if (triggerText.includes("二十多条消息")) {
      const sawCallbackFail = contextContains(contextItems, "支付回调失败");
      const sawOrderNotUpdated = contextContains(contextItems, "订单状态没更新");
      const sawAfterSale = contextContains(contextItems, "售后消息也没推送");
      if (sawCallbackFail && sawOrderNotUpdated && sawAfterSale) {
        content = "我整理了一下，当前主问题是支付回调异常，已经影响到订单状态更新和售后消息推送。";
      } else {
        content = "我只看到了部分长对话，建议再补几条关键报错。";
      }
    } else if (triggerText.includes("刚才这个问题你怎么看")) {
      const sawMaterial = contextContains(contextItems, "素材群发不出去");
      const sawTextMissing = contextContains(contextItems, "图片发出去了但是文字没带上");
      if (sawMaterial && sawTextMissing) {
        content = "看起来是同一条素材群发链路异常，表现为发送失败或文案丢失，建议优先排查群发任务和素材拼装。";
      } else {
        content = "我看到了追问，但上下文还不够，我需要再看两条更关键的现场描述。";
      }
    } else if (triggerText.includes("这个情况你怎么看")) {
      const sawSpecificError = contextContains(contextItems, "报错")
        || contextContains(contextItems, "失败")
        || contextContains(contextItems, "异常")
        || contextContains(contextItems, "超时");
      if (sawSpecificError) {
        content = "我已经看到一些异常线索了，可以继续判断，不过你最好再补一条最直接的报错现象。";
      } else {
        content = "我先介入，但还缺一个关键信息：请补一下具体报错、影响现象或截图，我再继续判断。";
      }
    } else if (triggerText.includes("是不是停服导致的")) {
      content = "大概率和停服或上游异常有关，建议先核对当时的停服公告和服务状态。";
    }

    sendJson(
      res,
      200,
      buildToolCallResponse(`reply-${state.llmRequests.length}`, "send_group_reply", { content }),
    );
  });


  return { upstream, llm };
}

module.exports = {
  createSimulatedMockServers,
};
