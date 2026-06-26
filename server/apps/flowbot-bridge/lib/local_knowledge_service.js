function createLocalKnowledgeService({
  KNOWLEDGE_DIR,
  KNOWLEDGE_SOURCE_VALUES,
  MEMORY_SOURCE_VALUES,
  fs,
  hashText,
  path,
}) {
  function readKnowledgeDocuments() {
    const dir = KNOWLEDGE_DIR;
    if (!fs.existsSync(dir)) {
      return [];
    }
    const files = [];
    const walk = (currentDir) => {
      for (const name of fs.readdirSync(currentDir)) {
        const filePath = path.join(currentDir, name);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          walk(filePath);
        } else if (/\.md$/i.test(name)) {
          files.push(filePath);
        }
      }
    };
    walk(dir);
    return files
      .map((filePath) => {
        const content = fs.readFileSync(filePath, "utf8");
        const relativePath = path.relative(dir, filePath);
        return {
          id: hashText(filePath).slice(0, 12),
          title: path.basename(filePath, path.extname(filePath)),
          fileName: relativePath,
          path: filePath,
          content,
        };
      });
  }

  function tokenizeSearchText(text) {
    return Array.from(new Set(
      String(text || "")
        .toLowerCase()
        .match(/[\u4e00-\u9fff]{1,}|[a-z0-9_]{2,}/g) || [],
    ));
  }

  function computeTokenOverlapScore(queryText, candidateText) {
    const left = tokenizeSearchText(queryText);
    const right = new Set(tokenizeSearchText(candidateText));
    if (!left.length || !right.size) {
      return 0;
    }
    let hit = 0;
    for (const token of left) {
      if (right.has(token)) {
        hit += 1;
      }
    }
    return hit / left.length;
  }

  function summarizeSnippet(text, query = "", maxLength = 220) {
    const raw = String(text || "").replace(/\s+/g, " ").trim();
    if (!raw) {
      return "";
    }
    const queryTokens = tokenizeSearchText(query);
    let start = 0;
    for (const token of queryTokens) {
      const idx = raw.toLowerCase().indexOf(token);
      if (idx >= 0) {
        start = Math.max(0, idx - 50);
        break;
      }
    }
    const snippet = raw.slice(start, start + maxLength);
    return start > 0 ? `...${snippet}` : snippet;
  }

  function normalizeKnowledgeSourceInput(value) {
    const source = String(value || "").trim().toLowerCase();
    return KNOWLEDGE_SOURCE_VALUES.has(source) ? source : "all";
  }

  function normalizeMemorySourceInput(value) {
    const source = String(value || "").trim().toLowerCase();
    return MEMORY_SOURCE_VALUES.has(source) ? source : "all";
  }

  function searchLocalKnowledgeDocuments(query, limit = 5) {
    const docs = readKnowledgeDocuments();
    const normalizedQuery = String(query || "").trim();
    const scored = docs.map((doc) => ({
      ...doc,
      score: computeTokenOverlapScore(normalizedQuery, `${doc.title}\n${doc.content}`),
      snippet: summarizeSnippet(doc.content, normalizedQuery),
    }));
    const filtered = normalizedQuery
      ? scored.filter((item) => item.score > 0)
      : scored;
    return filtered
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        title: item.title,
        fileName: item.fileName,
        path: item.path,
        source: "local",
        sourceLabel: "本地知识",
        score: Number(item.score.toFixed(4)),
        snippet: item.snippet,
      }));
  }

  function findLocalKnowledgeDocument({ id = "", fileName = "" } = {}) {
    const normalizedId = String(id || "").trim();
    const normalizedFileName = String(fileName || "").trim();
    const docs = readKnowledgeDocuments();
    return docs.find((doc) => (
      (normalizedId && String(doc.id || "") === normalizedId)
      || (normalizedFileName && String(doc.fileName || "") === normalizedFileName)
    )) || null;
  }

  function assertSafeLocalKnowledgePath(filePath) {
    const target = path.resolve(String(filePath || ""));
    const root = path.resolve(KNOWLEDGE_DIR);
    if (!target.startsWith(`${root}${path.sep}`) && target !== root) {
      throw new Error("knowledge_path_outside_root");
    }
    if (!/\.md$/i.test(target)) {
      throw new Error("knowledge_target_must_be_markdown");
    }
    return target;
  }

  return {
    assertSafeLocalKnowledgePath,
    computeTokenOverlapScore,
    findLocalKnowledgeDocument,
    normalizeKnowledgeSourceInput,
    normalizeMemorySourceInput,
    readKnowledgeDocuments,
    searchLocalKnowledgeDocuments,
    summarizeSnippet,
    tokenizeSearchText,
  };
}

module.exports = {
  createLocalKnowledgeService,
};
