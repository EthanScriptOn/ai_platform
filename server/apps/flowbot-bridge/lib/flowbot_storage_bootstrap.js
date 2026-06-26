"use strict";

const { createRuntimeFileStore } = require("./runtime_files");

function createFlowbotStorageBootstrap({
  DASHBOARD_DEFAULT_LIMIT,
  DATA_DIR,
  MEDIA_DIR,
  fs,
  mysqlRuntimeStore,
}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  const dashboardDataCache = new Map();
  const runtimeFileStore = createRuntimeFileStore({
    DATA_DIR,
    DASHBOARD_DEFAULT_LIMIT,
    mysqlRuntimeStore,
    onInvalidate: () => dashboardDataCache.clear(),
  });

  return {
    dashboardDataCache,
    ...runtimeFileStore,
  };
}

module.exports = {
  createFlowbotStorageBootstrap,
};
