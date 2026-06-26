"use strict";

function createRouteChain({ handlers, onNotFound }) {
  const routeHandlers = Array.isArray(handlers) ? handlers.filter(Boolean) : [];
  if (typeof onNotFound !== "function") {
    throw new Error("route_chain_not_found_handler_required");
  }

  async function handle(req, res, url) {
    for (const handler of routeHandlers) {
      if (await handler(req, res, url)) {
        return true;
      }
    }
    await onNotFound(req, res, url);
    return false;
  }

  return { handle };
}

module.exports = { createRouteChain };
