"use strict";

function createBatchPlannerService({
  LLM_MAX_REPAIR_ATTEMPTS,
  buildBatchPlannerOpenCase,
  buildBatchPlannerPendingMessage,
  buildLlmImageParts,
  normalizePriority,
  requestLlmClassify,
  tryParseClassifyJson,
}) {
  function buildBatchPlannerMessages(roomId, pendingMessages, toolResults = []) {
    const pending = pendingMessages.map((item) => buildBatchPlannerPendingMessage(item));
    const schemaText = [
      "{",
      '  "groups": [',
      "    {",
      '      "group_id": "group_1",',
      '      "thread_type": "case_feedback|feature_request|question|chat",',
      '      "message_role": "problem_report|feature_request|question|chitchat|evidence|developer_question|user_reply|troubleshooting_update|diagnosis|workaround|resolution|waiting_upstream|waiting_user|other",',
      '      "action": "ignore|new_case|append_case|append_case_activity|need_review",',
      '      "target_case_id": "CASE-xxxx 或空字符串",',
      '      "category": "case_feedback|feature_request|incident_handling|none",',
      '      "priority": "P0|P1|P2|P3",',
      '      "summary": "一句话摘要",',
      '      "reason": "简短依据",',
      '      "trace_ids": ["必须覆盖全部待处理 trace_id，且每个只出现一次"]',
      "    }",
      "  ]",
      "}",
    ].join("\n");
    const toolCallSchemaText = [
      "{",
      '  "tool_calls": [',
      "    {",
      '      "name": "search_cases_by_day",',
      '      "arguments": {',
      '        "query": "用待处理消息提炼出的关键词，可为空",',
      '        "page": 1,',
      '        "limit": 10',
      "      }",
      "    }",
      "  ]",
      "}",
    ].join("\n");
    return [
      {
        role: "system",
        content: [
          {
            type: "text",
            text: [
              "你是企业微信群 Case 归纳规划器。",
              "你会看到同一个群里一批尚未处理的消息。你不会直接拿到已有 Case；如果需要判断是否并入旧 Case，必须先用工具查询。",
              "请先判断 thread_type，再判断 message_role，最后决定 action。",
              "thread_type 只有四类：case_feedback（反馈故障/异常）、feature_request（功能诉求）、question（普通提问）、chat（闲聊）。",
              "message_role 用来表示消息在 Case 生命周期中的角色，尤其是 developer_question、user_reply、troubleshooting_update、diagnosis、workaround、resolution、waiting_upstream、waiting_user，它们通常属于已归档 Case 的后续活动。",
              "action 只能是：ignore、new_case、append_case、append_case_activity、need_review。",
              "如果消息像问题反馈、补充证据、技术回复、处理进展、历史总结，且你不确定当天是否已有相关 Case，必须先调用 search_cases_by_day。",
              "search_cases_by_day 只会返回当前群、同一天范围内的 Case；一次最多 10 条，最多查 3 页。",
              "如果第一页没有足够证据，但返回 hasMore=true，且消息明显可能是旧 Case 的延续，可以继续查下一页。",
              "如果查到候选 Case，你必须看清 reporters、participants、last_messages，再决定是不是同一个 Case。",
              "如果 pending_messages 的 sender 与候选 Case 的 reporters/participants 明显不是同一拨人，而且消息内容也不是在直接回复该 Case 的上下文，不要并案。",
              "如果新消息是在说另一位用户、另一套对象、另一类故障表现，即使在同一个群、同一个时间段，也优先 new_case 或 need_review。",
              "append_case 只用于：同一问题主题下的继续报障、继续补充证据、继续补充影响范围。",
              "append_case_activity 只用于：研发追问、排查进展、阶段性结论、临时规避、最终解决、等待用户、等待上游等，且它们明确属于某个已有开放 Case。",
              "need_review 用于：你怀疑可能属于某个已有 Case，但证据不足，不能贸然忽略，也不能贸然并案。",
              "question 和 chat 默认不要建 Case；只有它们明显是在跟进某个已有 Case 时，才允许 append_case_activity。",
              "优先拆分，不要贪心合并。只有在你高度确定是同一个问题延续时，才允许 append_case 或 append_case_activity。",
              "如果是新主题、新对象、新报错、新用户诉求，即使发送人相同，也优先 new_case。",
              "纯图片/语音可以附着到最近、最相关的文本问题；不要把隔很久的旧图片强行并入新问题。",
              "如果图片消息带有 transcript_text，它是系统预先识别出的图片说明，请把它当作图片内容来判断。",
              "业务边界按四层理解：上游 -> 端别（微信端/企微端）-> 登录设备（Mac/iPad/AndroidPad/Windows等）-> 能力域（登录/验证码/群消息接收/发图/跟群/视频号/转链/订单等）。",
              "只有关键层级一致时才允许并案。不要因为都叫登录异常就合并；也不要把同一上游但不同端别、不同设备、不同能力域的问题合并。",
              "闲聊、纯语气词、无业务意义的追问，归为 ignore。",
              "必须覆盖全部待处理 trace_id，每个 trace_id 只能出现一次。",
              "你每次必须只输出合法 JSON，不要输出解释、markdown、代码块。",
              "如果还需要查 Case，只输出工具调用 JSON，结构如下：",
              toolCallSchemaText,
              "如果已经可以判断，输出最终规划 JSON，结构如下：",
              "输出结构必须严格符合以下 schema：",
              schemaText,
            ].join("\n"),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              JSON.stringify({
                room_id: roomId,
                pending_messages: pending,
                case_tool_results: toolResults,
              }, null, 2),
              buildLlmImageParts(pendingMessages, {
                heading: "本轮待处理消息里包含以下图片。当前归档规划只按图片链接、文件名和上下文判断；不要要求直接读取图片像素。",
                includeImageContent: false,
              }).map((part) => part?.text || "").filter(Boolean).join("\n"),
            ].filter(Boolean).join("\n\n"),
          },
        ],
      },
    ];
  }

  function normalizeCaseToolCalls(value) {
    if (!value || typeof value !== "object" || !Array.isArray(value.tool_calls)) {
      return [];
    }
    return value.tool_calls
      .map((call) => ({
        name: String(call?.name || "").trim(),
        arguments: call?.arguments && typeof call.arguments === "object" ? call.arguments : {},
      }))
      .filter((call) => call.name === "search_cases_by_day");
  }

  function normalizeBatchPlannerCategory(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) {
      return "none";
    }
    const aliases = {
      case_feedback: "case_feedback",
      feedback: "case_feedback",
      issue: "case_feedback",
      problem: "case_feedback",
      bug: "case_feedback",
      defect: "case_feedback",
      technical_issue: "case_feedback",
      error: "case_feedback",
      feature_request: "feature_request",
      feature: "feature_request",
      request: "feature_request",
      requirement: "feature_request",
      demand: "feature_request",
      incident_handling: "incident_handling",
      incident: "incident_handling",
      outage: "incident_handling",
      emergency: "incident_handling",
      none: "none",
      no_case: "none",
      chat: "none",
      question: "none",
    };
    return aliases[raw] || raw;
  }

  function validateBatchPlannerPayload(value, pendingTraceIds, openCaseIds) {
    if (!value || typeof value !== "object") {
      throw new Error("schema_invalid:not_object");
    }
    if (!Array.isArray(value.groups) || !value.groups.length) {
      throw new Error("schema_invalid:groups");
    }
    const remaining = new Set(pendingTraceIds);
    const allowedThreadType = new Set(["case_feedback", "feature_request", "question", "chat"]);
    const allowedMessageRole = new Set([
      "problem_report",
      "feature_request",
      "question",
      "chitchat",
      "evidence",
      "developer_question",
      "user_reply",
      "troubleshooting_update",
      "diagnosis",
      "workaround",
      "resolution",
      "waiting_upstream",
      "waiting_user",
      "other",
    ]);
    const allowedAction = new Set(["ignore", "new_case", "append_case", "append_case_activity", "need_review"]);
    const allowedCategory = new Set(["case_feedback", "feature_request", "incident_handling", "none"]);
    const allowedPriority = new Set(["P0", "P1", "P2", "P3"]);
    const result = [];
    for (const [index, group] of value.groups.entries()) {
      if (!group || typeof group !== "object") {
        throw new Error(`schema_invalid:group_${index}`);
      }
      const threadType = String(group.thread_type || "").trim();
      const messageRole = String(group.message_role || "").trim();
      const action = String(group.action || "").trim();
      const category = normalizeBatchPlannerCategory(group.category || "");
      const priority = normalizePriority(group.priority || "P2", "P2");
      const targetCaseId = String(group.target_case_id || "").trim();
      const traceIds = Array.isArray(group.trace_ids) ? group.trace_ids.map((item) => String(item || "").trim()).filter(Boolean) : [];
      if (!allowedThreadType.has(threadType)) {
        throw new Error(`schema_invalid:thread_type:${threadType || "empty"}`);
      }
      if (!allowedMessageRole.has(messageRole)) {
        throw new Error(`schema_invalid:message_role:${messageRole || "empty"}`);
      }
      if (!allowedAction.has(action)) {
        throw new Error(`schema_invalid:action:${action || "empty"}`);
      }
      if (!allowedCategory.has(category)) {
        throw new Error(`schema_invalid:category:${category || "empty"}`);
      }
      if (!allowedPriority.has(priority)) {
        throw new Error(`schema_invalid:priority:${priority || "empty"}`);
      }
      if (!traceIds.length) {
        throw new Error(`schema_invalid:trace_ids:${index}`);
      }
      for (const traceId of traceIds) {
        if (!remaining.has(traceId)) {
          throw new Error(`schema_invalid:trace_duplicate_or_unknown:${traceId}`);
        }
        remaining.delete(traceId);
      }
      if (action === "append_case" || action === "append_case_activity") {
        if (targetCaseId && !openCaseIds.has(targetCaseId)) {
          throw new Error(`schema_invalid:append_target_unknown:${targetCaseId}`);
        }
        if (category === "none") {
          throw new Error(`schema_invalid:append_category_none:${index}`);
        }
      }
      if (action === "new_case" && category === "none") {
        throw new Error(`schema_invalid:new_case_category_none:${index}`);
      }
      result.push({
        groupId: String(group.group_id || `group_${index + 1}`).trim() || `group_${index + 1}`,
        threadType,
        messageRole,
        action,
        targetCaseId,
        category,
        priority,
        summary: String(group.summary || "").trim(),
        reason: String(group.reason || "").trim(),
        traceIds,
      });
    }
    if (remaining.size) {
      throw new Error(`schema_invalid:trace_uncovered:${Array.from(remaining).join(",")}`);
    }
    return {
      groups: result,
    };
  }

  async function planPendingGroupsByLlm(roomId, pendingMessages, openCases, options = {}) {
    const pendingTraceIds = pendingMessages.map((item) => item.traceId);
    const knownCaseIds = new Set(openCases.map((item) => item.case_id).filter(Boolean));
    const toolResults = [];
    const lookupCases = typeof options.lookupCases === "function" ? options.lookupCases : null;
    let rawOutput = "";
    try {
      for (let round = 0; round < 4; round += 1) {
        rawOutput = await requestLlmClassify(buildBatchPlannerMessages(roomId, pendingMessages, toolResults));
        const parsed = tryParseClassifyJson(rawOutput);
        const toolCalls = normalizeCaseToolCalls(parsed);
        if (lookupCases && toolCalls.length && !parsed.groups) {
          for (const call of toolCalls.slice(0, 2)) {
            const result = lookupCases({
              query: call.arguments.query,
              page: call.arguments.page,
              limit: call.arguments.limit,
            });
            for (const item of result.cases || []) {
              if (item?.case_id) {
                knownCaseIds.add(item.case_id);
              }
            }
            toolResults.push({
              callIndex: toolResults.length + 1,
              name: call.name,
              arguments: call.arguments,
              result,
            });
          }
          continue;
        }
        return {
          ok: true,
          repaired: false,
          rawOutput,
          toolResults,
          ...validateBatchPlannerPayload(parsed, pendingTraceIds, knownCaseIds),
        };
      }
      throw new Error("schema_invalid:too_many_case_tool_rounds");
    } catch (error) {
      const parseError = String(error?.message || error);
      const canRepair = Boolean(rawOutput)
        && !/^(llm_config_missing|request_timeout|http_\d+:|invalid_json:http_\d+:)/i.test(parseError);
      if (!canRepair) {
        return {
          ok: false,
          reason: "llm_request_failed",
          parseError,
          rawOutput,
        };
      }
      for (let attempt = 0; attempt < LLM_MAX_REPAIR_ATTEMPTS; attempt += 1) {
        const repairMessages = [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: [
                  "你是 JSON 修复器。",
                  "你会收到上一次批处理规划模型的原始输出和解析错误。",
                  "请只返回一个合法 JSON 对象，不要解释。",
                  "groups 数组必须覆盖全部待处理 trace_id，每个 trace_id 只能出现一次。",
                  "thread_type 只能是 case_feedback、feature_request、question、chat。",
                  "message_role 必须是预定义枚举值。",
                  "action 只能是 ignore、new_case、append_case、append_case_activity、need_review。",
                ].join("\n"),
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  parse_error: parseError,
                  raw_output: rawOutput,
                  pending_trace_ids: pendingTraceIds,
                  known_case_ids: Array.from(knownCaseIds),
                  case_tool_results: toolResults,
                }, null, 2),
              },
            ],
          },
        ];
        try {
          const repairedRaw = await requestLlmClassify(repairMessages);
          return {
            ok: true,
            repaired: true,
            rawOutput: repairedRaw,
            previousRawOutput: rawOutput,
            parseError,
            toolResults,
            ...validateBatchPlannerPayload(tryParseClassifyJson(repairedRaw), pendingTraceIds, knownCaseIds),
          };
        } catch (repairError) {
          if (attempt === LLM_MAX_REPAIR_ATTEMPTS - 1) {
            return {
              ok: false,
              reason: "llm_repair_failed",
              parseError: String(repairError?.message || repairError),
              rawOutput,
            };
          }
        }
      }
      return {
        ok: false,
        reason: "llm_repair_failed",
        parseError,
        rawOutput,
      };
    }
  }

  return {
    buildBatchPlannerMessages,
    normalizeBatchPlannerCategory,
    planPendingGroupsByLlm,
    validateBatchPlannerPayload,
  };
}

module.exports = { createBatchPlannerService };
