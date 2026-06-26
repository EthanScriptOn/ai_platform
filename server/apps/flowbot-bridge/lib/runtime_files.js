const fs = require("fs");

function createRuntimeFileStore({
  DATA_DIR,
  DASHBOARD_DEFAULT_LIMIT,
  mysqlRuntimeStore,
  onInvalidate = () => {},
}) {
  const localJsonFileCache = new Map();
  const localJsonlFileCache = new Map();

  function getLocalFileVersion(filePath) {
    try {
      const stat = fs.statSync(filePath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  function invalidateLocalFileCaches(filePath = "") {
    const target = String(filePath || "").trim();
    if (!target) {
      return;
    }
    localJsonFileCache.delete(target);
    localJsonlFileCache.delete(target);
    onInvalidate(target);
  }

  function writeJsonFile(filePath, value) {
    if (mysqlRuntimeStore.isEnabled()) {
      mysqlRuntimeStore.writeJson(DATA_DIR, filePath, value);
      return;
    }
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    invalidateLocalFileCaches(filePath);
  }

  function readJsonFile(filePath, fallback) {
    if (mysqlRuntimeStore.isEnabled()) {
      const value = mysqlRuntimeStore.readJson(DATA_DIR, filePath, undefined);
      if (value !== undefined) {
        return value;
      }
      if (fs.existsSync(filePath)) {
        try {
          const fileValue = JSON.parse(fs.readFileSync(filePath, "utf8"));
          mysqlRuntimeStore.writeJson(DATA_DIR, filePath, fileValue);
          return fileValue;
        } catch {
          return fallback;
        }
      }
      return fallback;
    }
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    try {
      const version = getLocalFileVersion(filePath);
      const cached = localJsonFileCache.get(filePath);
      if (cached && cached.version === version) {
        return cached.value;
      }
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      localJsonFileCache.set(filePath, { version, value });
      return value;
    } catch {
      return fallback;
    }
  }

  function readJsonlFileFromDisk(filePath, limit = DASHBOARD_DEFAULT_LIMIT) {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const version = getLocalFileVersion(filePath);
    const cached = localJsonlFileCache.get(filePath);
    let parsed = cached && cached.version === version ? cached.items : null;
    if (!parsed) {
      const raw = fs.readFileSync(filePath, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      parsed = [];
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line));
        } catch {
          continue;
        }
      }
      localJsonlFileCache.set(filePath, { version, items: parsed });
    }
    const sliced = parsed.slice(-limit);
    const result = [];
    for (const item of sliced) {
      try {
        result.push(item);
      } catch {
        continue;
      }
    }
    return result;
  }

  function readJsonlFile(filePath, limit = DASHBOARD_DEFAULT_LIMIT) {
    if (mysqlRuntimeStore.isEnabled()) {
      const items = mysqlRuntimeStore.readJsonl(DATA_DIR, filePath, limit);
      if (items.length || !fs.existsSync(filePath)) {
        return items;
      }
      const fallbackItems = readJsonlFileFromDisk(filePath, limit);
      if (fallbackItems.length) {
        mysqlRuntimeStore.rewriteJsonl(DATA_DIR, filePath, readJsonlFileFromDisk(filePath, Number.MAX_SAFE_INTEGER));
      }
      return fallbackItems;
    }
    return readJsonlFileFromDisk(filePath, limit);
  }

  function rewriteJsonlFile(filePath, keepItem) {
    const items = readJsonlFile(filePath, Number.MAX_SAFE_INTEGER);
    const kept = [];
    let removedCount = 0;
    for (const item of items) {
      if (keepItem(item)) {
        kept.push(item);
      } else {
        removedCount += 1;
      }
    }
    const nextText = kept.length ? `${kept.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
    if (mysqlRuntimeStore.isEnabled()) {
      mysqlRuntimeStore.rewriteJsonl(DATA_DIR, filePath, kept);
      return {
        removedCount,
        remainingCount: kept.length,
      };
    }
    fs.writeFileSync(filePath, nextText, "utf8");
    invalidateLocalFileCaches(filePath);
    return {
      removedCount,
      remainingCount: kept.length,
    };
  }

  function unlinkIfExists(filePath) {
    const target = String(filePath || "").trim();
    if (mysqlRuntimeStore.isEnabled()) {
      mysqlRuntimeStore.deleteJson(DATA_DIR, target);
    }
    if (!target || !fs.existsSync(target)) {
      return false;
    }
    fs.unlinkSync(target);
    invalidateLocalFileCaches(target);
    return true;
  }

  function countJsonlFile(filePath) {
    if (mysqlRuntimeStore.isEnabled()) {
      return readJsonlFile(filePath, Number.MAX_SAFE_INTEGER).length;
    }
    if (!fs.existsSync(filePath)) {
      return 0;
    }
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      return 0;
    }
    return raw.split("\n").length;
  }

  return {
    countJsonlFile,
    getLocalFileVersion,
    invalidateLocalFileCaches,
    readJsonFile,
    readJsonlFile,
    readJsonlFileFromDisk,
    rewriteJsonlFile,
    unlinkIfExists,
    writeJsonFile,
  };
}

module.exports = { createRuntimeFileStore };
