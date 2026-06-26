import { describe, expect, it } from "vitest";
import {
  buildGroupIntentSample,
  buildGroupIntentTrainingRecord,
  groupIntentRecordToJsonl,
  groupIntentReviewKey,
  parseGroupIntentConversation,
  parseGroupIntentMessage,
} from "./groupIntentParser";

describe("groupIntentParser", () => {
  it("parses speaker-prefixed messages", () => {
    expect(parseGroupIntentMessage("小雨妈: 有没有纸尿裤推荐？")).toEqual({
      speaker: "小雨妈",
      text: "有没有纸尿裤推荐？",
      raw: "小雨妈: 有没有纸尿裤推荐？",
    });
    expect(parseGroupIntentMessage("团长：发个链接")).toEqual({
      speaker: "团长",
      text: "发个链接",
      raw: "团长：发个链接",
    });
  });

  it("keeps plain messages without a speaker", () => {
    expect(parseGroupIntentMessage("求推荐")).toEqual({
      speaker: "",
      text: "求推荐",
      raw: "求推荐",
    });
    expect(parseGroupIntentMessage("   ")).toBeNull();
  });

  it("parses conversations and preserves original line indexes", () => {
    const rows = parseGroupIntentConversation("小雨妈: 纸尿裤推荐\n\n求链接");
    expect(rows).toEqual([
      { speaker: "小雨妈", text: "纸尿裤推荐", raw: "小雨妈: 纸尿裤推荐", index: 0 },
      { speaker: "", text: "求链接", raw: "求链接", index: 1 },
    ]);
  });

  it("builds a deterministic 100-line sample", () => {
    const rows = buildGroupIntentSample().split("\n");
    expect(rows).toHaveLength(100);
    expect(rows[0]).toContain("宝宝6个月晚上侧漏");
    expect(rows[25]).toContain("小雨妈2");
  });

  it("formats training records and JSONL output", () => {
    const row = {
      index: 2,
      speaker: "晓晓",
      text: "这个有链接吗？",
      raw: "晓晓: 这个有链接吗？",
      context: [{ text: "花王纸尿裤活动价挺好" }],
      label: "ask_link",
      shouldIntervene: true,
      confidence: 0.94,
      signals: ["链接"],
      topics: ["纸尿裤"],
    };
    const review = {
      finalLabel: "clarify_needed",
      status: "approved",
      note: "指代不清",
      reviewedAt: "2026-06-18T00:00:00.000Z",
    };

    expect(groupIntentReviewKey(row)).toBe("2-晓晓: 这个有链接吗？");
    const record = buildGroupIntentTrainingRecord(row, review);
    expect(record).toMatchObject({
      sample_id: 3,
      final_label: "clarify_needed",
      model_label: "ask_link",
      review_status: "approved",
      context: ["花王纸尿裤活动价挺好"],
      source: "group-intent-workbench",
    });
    expect(JSON.parse(groupIntentRecordToJsonl(record))).toEqual(record);
  });
});
