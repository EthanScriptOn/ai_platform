"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { extractJsonFromText, stableId } = require("./data_utils");

const SYSTEM_PROMPT = `你是公司内部知识库治理专家。
你的任务是把输入材料治理成可检索、可问答、可审核的结构化知识。

必须遵守：
1. 只能基于原文和元数据，不要编造。
2. 明确判断每条知识是否可以直接进入 RAGFlow。
3. 可以直接进入 RAGFlow 的内容必须满足：结论明确、证据明确、无敏感外泄风险、可以直接回答用户问题。
4. 不可以直接进入 RAGFlow 的内容也必须输出，并说明需要人工审核的原因。
5. 客服可回复内容和内部说明必须分开。
6. 账号、密码、token、服务器 IP 等敏感信息必须 internal_only，且默认需要人工确认。
7. 每条知识都要有 source_evidence。
8. 输出合法 JSON，不要输出 Markdown。`;

function createKnowledgeGovernanceService({
  REVIEW_RUN_DIR,
  callQwenChat,
  model,
}) {
  function printableFallback(buffer) {
    return buffer.toString("utf8")
      .replace(/[^\x09\x0A\x0D\x20-\x7E\u4e00-\u9fff，。！？；：“”‘’（）【】、￥%…—《》]/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function extractDocxText(buffer) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-docx-"));
    const docxPath = path.join(tmpDir, "upload.docx");
    fs.writeFileSync(docxPath, buffer);
    const script = [
      "import re, sys, zipfile",
      "from xml.etree import ElementTree as ET",
      "path=sys.argv[1]",
      "with zipfile.ZipFile(path) as z:",
      "    xml=z.read('word/document.xml')",
      "root=ET.fromstring(xml)",
      "ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}",
      "paras=[]",
      "for p in root.findall('.//w:p', ns):",
      "    texts=[t.text or '' for t in p.findall('.//w:t', ns)]",
      "    line=''.join(texts).strip()",
      "    if line: paras.append(line)",
      "print('\\n'.join(paras))",
    ].join("\n");
    const result = spawnSync("python3", ["-c", script, docxPath], { encoding: "utf8", timeout: 30000 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (result.status !== 0) throw new Error(result.stderr || "docx 文本提取失败");
    return result.stdout.trim();
  }

  function extractPdfText(buffer) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-pdf-"));
    const pdfPath = path.join(tmpDir, "upload.pdf");
    fs.writeFileSync(pdfPath, buffer);
    const result = spawnSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8", timeout: 30000 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    return printableFallback(buffer);
  }

  function extractTextFromUpload({ fileName = "", content = "", contentBase64 = "" } = {}) {
    const buffer = contentBase64 ? Buffer.from(contentBase64, "base64") : Buffer.from(String(content || ""), "utf8");
    const raw = content || buffer.toString("utf8");
    const ext = path.extname(fileName).toLowerCase();
    if (!buffer.length) throw new Error("上传内容为空，无法治理。");
    if ([".txt", ".md", ".markdown", ".json", ".csv", ".log", ".html", ".htm", ""].includes(ext)) {
      return raw;
    }
    if (ext === ".docx") return extractDocxText(buffer);
    if (ext === ".pdf") return extractPdfText(buffer);
    return printableFallback(buffer);
  }

  async function governMaterial({ sourceKind = "document_upload", title = "", sourcePath = "", sourceUrl = "", content = "" } = {}) {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          metadata: { source_kind: sourceKind, title, source_path: sourcePath, source_url: sourceUrl },
          output_schema: {
            document: {
              title: "文档标题",
              doc_type: "problem_solution|procedure|resource_index|api_doc|meeting_review|technical_note|mixed|empty",
              feishu_url: "来源链接",
              source_path: "来源路径",
              summary: "治理摘要",
            },
            knowledge_units: [
              {
                unit_type: "faq|solution|procedure|resource|fact|risk|meeting_action",
                title: "知识标题",
                user_questions: ["用户可能怎么问"],
                scope: "适用范围",
                answer_for_customer: "客服可回复内容",
                internal_notes: "内部说明",
                steps: ["步骤"],
                source_evidence: ["原文证据"],
                confidence: 0.0,
                visibility: "public_reply|internal_only|needs_review",
                needs_human_review: true,
                review_reason: "为什么需要或不需要人工审核",
              },
            ],
          },
          content: String(content || "").slice(0, 24000),
        }, null, 2),
      },
    ];
    const text = await callQwenChat({
      model,
      messages,
      temperature: 0.1,
      responseFormat: { type: "json_object" },
      timeoutMs: 120000,
    });
    const result = extractJsonFromText(text);
    result.document = {
      ...(result.document || {}),
      title: result.document?.title || title || "上传文档",
      feishu_url: result.document?.feishu_url || sourceUrl || "",
      source_path: result.document?.source_path || sourcePath || "",
    };
    if (!Array.isArray(result.knowledge_units)) result.knowledge_units = [];
    return result;
  }

  function appendGovernedResult(result) {
    fs.mkdirSync(REVIEW_RUN_DIR, { recursive: true });
    const governedPath = path.join(REVIEW_RUN_DIR, "governed_units.jsonl");
    fs.appendFileSync(governedPath, `${JSON.stringify(result)}\n`, "utf8");
    return governedPath;
  }

  async function ingestUploadedDocument(payload = {}) {
    const fileName = String(payload.fileName || payload.name || "上传文档").trim();
    const content = extractTextFromUpload(payload);
    const result = await governMaterial({
      sourceKind: "document_upload",
      title: payload.title || fileName,
      sourcePath: fileName,
      sourceUrl: payload.sourceUrl || "",
      content,
    });
    appendGovernedResult(result);
    const doc = result.document || {};
    const items = result.knowledge_units.map((unit) => ({
      id: stableId(doc.title || "", unit),
      source_kind: "document_upload",
      document_title: doc.title || "",
      feishu_url: doc.feishu_url || "",
      source_path: doc.source_path || fileName,
      unit,
    }));
    return { ok: true, document: doc, count: items.length, items };
  }

  return {
    appendGovernedResult,
    extractTextFromUpload,
    governMaterial,
    ingestUploadedDocument,
  };
}

module.exports = {
  createKnowledgeGovernanceService,
};
