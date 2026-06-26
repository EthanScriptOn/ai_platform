"use strict";

function createToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "get_recent_room_messages",
        description: "Get the latest messages in the current room. Use this first when you need the nearby room context.",
        parameters: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 30,
              description: "How many latest messages to fetch. Default 12.",
            },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_anchor_context",
        description: "Get nearby context around a message in the current room. If traceId is omitted, use the current trigger message; if traceId is provided, inspect that historical message and its nearby context. This is the preferred second step after search_room_messages hits an older topic.",
        parameters: {
          type: "object",
          properties: {
            traceId: {
              type: "string",
              description: "Optional trace id from a previous search result when you need historical context.",
            },
            before: {
              type: "integer",
              minimum: 0,
              maximum: 12,
              description: "How many previous messages to include. Default 4.",
            },
            after: {
              type: "integer",
              minimum: 0,
              maximum: 12,
              description: "How many following messages to include. Default 2.",
            },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_room_messages",
        description: "Search processed messages in the current room by keyword, sender, or time range. Prefer this as the first step when the user is referring back to an older topic in the same room. Use concise keywords.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keyword query." },
            senderId: { type: "string", description: "Optional exact sender id." },
            fromTime: { type: "string", description: "Optional lower bound time." },
            toTime: { type: "string", description: "Optional upper bound time." },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 30,
              description: "How many matched messages to fetch. Default 10.",
            },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_memory",
        description: "Search message memory and archived cases for similar information. Use this after room search when you need wider recall than recent room messages, but keep the query concise.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for." },
            source: {
              type: "string",
              enum: ["all", "messages", "cases"],
              description: "Memory source. Default all.",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 20,
              description: "How many results to fetch. Default 8.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_knowledge",
        description: "Ask the configured knowledge-base bot for business or product questions. It returns a direct answer when the knowledge bot can answer, and falls back to retrieved knowledge snippets otherwise.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for." },
            source: {
              type: "string",
              enum: ["all", "local", "maxkb"],
              description: "Knowledge source. Default all.",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 10,
              description: "How many docs to fetch. Default 5.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "send_group_reply",
        description: "Send the final reply text back to the current WeCom room for this task.",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The exact text that should be sent to the room.",
            },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
    },
  ];
}

module.exports = {
  createToolDefinitions,
};
