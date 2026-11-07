// 票 09 向量索引单测：切块 / 重建 / KNN / 混合检索 / 无索引退回（假 embedding 注入，不依赖 Ollama）
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CortxtosConfig } from "../src/config.ts";
import { splitChunks, reindexAll, readIndexMeta, semanticSearch, dirtyNoteCount } from "../src/vecstore.ts";
import { searchHybrid } from "../src/search.ts";
import { writeNote } from "../src/vault.ts";
import type { EmbedFn } from "../src/embed.ts";

// 索引库指向本次测试独占的临时路径（indexPath() 调用时读 env）
const sandbox = mkdtempSync(join(tmpdir(), "cortxtos-vec-"));
process.env.CORTXTOS_INDEX_DB = join(sandbox, "index-cache", "vault.db");

const testConfig: CortxtosConfig = {
  vaultPath: join(sandbox, "vault"),
  ollama: { baseUrl: "http://127.0.0.1:9", maxLoadedModels: 1 }, // 单测绝不触网：embed 全部注入假实现
  tiers: {
    fast: { model: "f" },
    balanced: { model: "b" },
    heavy: { model: "h" },
    vision: { model: "v" },
    embedding: { model: "fake-embed" },
  },
  asr: { engine: "whisper.cpp", model: "large-v3" },
};

// 假向量：字符频次归一化——同文本距离 0，共享字多的文本更近
function fakeVector(text: string): number[] {
  const v = new Array(8).fill(0) as number[];
  for (const ch of text) v[ch.codePointAt(0)! % 8] += 1;
  for (let i = 0; i < text.length; i++) v[i % 8] += text.codePointAt(i)! % 3 / 10;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const fakeEmbed: EmbedFn = async (texts) => texts.map(fakeVector);

test("splitChunks：短文本单块且带标题锚", () => {
  const chunks = splitChunks("T1", "第一段。\n\n第二段。");
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]!.startsWith("T1\n"));
});

test("splitChunks：贪心合批不超过上限、覆盖全部字符", () => {
  const paras = Array.from({ length: 20 }, (_, i) => `第${i}段内容。`.repeat(10));
  const chunks = splitChunks("T2", paras.join("\n\n"), 300);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 300 + "T2\n".length + 100, `块超长：${c.length}`);
  assert.ok(chunks.at(-1)!.includes("第19段"));
});

test("splitChunks：超长段落硬切不丢内容", () => {
  const long = "甲".repeat(1300);
  const chunks = splitChunks("T3", long, 600);
  const total = chunks.reduce((n, c) => n + (c.length - "T3\n".length), 0);
  assert.equal(total, 1300);
});

test("reindexAll + semanticSearch 往返：meta/脏标记/KNN", async () => {
  await writeNote(testConfig, { dir: "notes", frontmatter: { title: "上下文压缩策略", tags: ["llm"], created: new Date().toISOString(), source: "manual", type: "note" }, body: "当对话超过窗口限制时进行摘要压缩，保留最近轮次原文。" });
  await writeNote(testConfig, { dir: "notes", frontmatter: { title: "香蕉奶昔配方", tags: ["food"], created: new Date().toISOString(), source: "manual", type: "note" }, body: "香蕉一根牛奶两百毫升打碎即可。" });
  assert.equal(dirtyNoteCount(), 2, "写入后应有 2 条脏标记");

  const s = await reindexAll(testConfig, fakeEmbed);
  assert.equal(s.files, 2);
  assert.ok(s.chunks >= 2);
  assert.equal(s.dim, 8);
  assert.equal(dirtyNoteCount(), 0, "重建成功后脏标记清空");

  const meta = readIndexMeta();
  assert.ok(meta !== null && meta.builtAt.length > 0 && meta.chunkCount === s.chunks);

  const hits = await semanticSearch(testConfig, "香蕉一根牛奶两百毫升打碎即可。", 3, fakeEmbed);
  assert.ok(hits !== null && hits.length >= 1);
  assert.match(hits[0]!.path, /香蕉奶昔配方\.md$/);
  assert.deepEqual(hits[0]!.tags, ["food"]);
});

test("searchHybrid：关键字通道照常、语义补位并标注 via", async () => {
  const r = await searchHybrid(testConfig, { query: "香蕉" }, fakeEmbed);
  assert.equal(r.mode, "hybrid");
  assert.ok(r.hits.length >= 1);
  const banana = r.hits.find((h) => h.title === "香蕉奶昔配方");
  assert.ok(banana !== undefined);
  assert.ok(banana.via.includes("keyword"));

  // 不记得关键词的问法：关键字零命中（生僻字串无任何子串匹配）→ 语义补位
  const r2 = await searchHybrid(testConfig, { query: "璘瑱瑾瑜瑃琸" }, fakeEmbed);
  assert.ok(r2.hits.length > 0, "语义通道应补位");
  assert.ok(r2.hits.every((h) => h.via.length === 1 && h.via[0] === "semantic"), "补位命中应只标注 semantic");
});

test("无索引时 searchHybrid 自动退回文件版关键字", async () => {
  const saved = process.env.CORTXTOS_INDEX_DB;
  process.env.CORTXTOS_INDEX_DB = join(sandbox, "index-cache", "not-exists.db");
  try {
    const r = await searchHybrid(testConfig, { query: "香蕉" }, fakeEmbed);
    assert.equal(r.mode, "keyword-only");
    assert.ok(r.note !== undefined && r.note.includes("向量索引未建"));
    assert.ok(r.hits.some((h) => h.title === "香蕉奶昔配方"));
    assert.ok(existsSync(join(testConfig.vaultPath, "notes")));
  } finally {
    process.env.CORTXTOS_INDEX_DB = saved;
  }
});
