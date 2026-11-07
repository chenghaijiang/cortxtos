// 对话页智能体（方向 2）：/api/chat tool-calling 循环的白名单工具执行器单测
// 不依赖 Ollama：kb_search 在无向量索引时同步退回文件版关键字检索
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { execAgentTool, AGENT_TOOLS, AGENT_TOOL_LABELS } from "../src/server.ts";
import type { CortxtosConfig } from "../src/config.ts";

const vault = mkdtempSync(join(tmpdir(), "cortxtos-agent-"));
const indexDb = join(vault, "index", "vault.db"); // 不存在 → 语义通道直接退回关键字
process.env.CORTXTOS_INDEX_DB = indexDb;

const config: CortxtosConfig = {
  vaultPath: vault,
  ollama: { baseUrl: "http://127.0.0.1:1", maxLoadedModels: 1 },
  tiers: {
    fast: { model: "m" }, balanced: { model: "m" }, heavy: { model: "m" },
    vision: { model: "m" }, embedding: { model: "e" },
  },
  asr: { engine: "whisper.cpp", model: "large-v3" },
};

const NOTE = `---
title: 量子计算入门
tags: [science]
created: "2026-11-01T00:00:00.000Z"
type: note
source: manual
---

# 量子计算入门

正文：量子比特与叠加态。
`;
mkdirSync(join(vault, "notes"), { recursive: true });
mkdirSync(join(vault, "daily"), { recursive: true });
writeFileSync(join(vault, "notes", "量子计算入门.md"), NOTE, "utf8");

after(() => { rmSync(vault, { recursive: true, force: true }); });

test("工具白名单：5 个工具声明齐全且都有中文名", () => {
  const names = AGENT_TOOLS.map((t) => t.function.name);
  assert.deepEqual(names, ["kb_search", "read_note", "list_notes", "list_todos", "save_note"]);
  for (const n of names) assert.ok(AGENT_TOOL_LABELS[n], `${n} 缺少展示标签`);
});

test("未知工具被拒绝并提示允许清单", async () => {
  const r = await execAgentTool(config, "bash", { cmd: "rm -rf /" });
  assert.match(r, /未知工具：bash/);
  assert.match(r, /允许：kb_search\/read_note\/list_notes\/list_todos\/save_note/);
});

test("read_note：路径穿越与 vault 外绝对路径一律拒绝", async () => {
  assert.match(await execAgentTool(config, "read_note", { path: "../../etc/passwd" }), /路径非法/);
  assert.match(await execAgentTool(config, "read_note", { path: "/etc/passwd" }), /路径非法|笔记不存在/);
  assert.match(await execAgentTool(config, "read_note", { path: "notes/秘密.txt" }), /路径非法/); // 只允许 .md
});

test("read_note：vault 内笔记返回全文；不存在的笔记优雅失败", async () => {
  const ok = await execAgentTool(config, "read_note", { path: "notes/量子计算入门.md" });
  assert.match(ok, /量子比特与叠加态/);
  assert.match(await execAgentTool(config, "read_note", { path: "notes/不存在.md" }), /笔记不存在/);
});

test("list_notes 列出标题与路径", async () => {
  const r = await execAgentTool(config, "list_notes", {});
  assert.match(r, /notes\/量子计算入门\.md/);
  assert.match(r, /量子计算入门/);
});

test("kb_search：空 query 报错；命中走关键字退回通道", async () => {
  assert.match(await execAgentTool(config, "kb_search", {}), /需要非空 query/);
  const r = await execAgentTool(config, "kb_search", { query: "量子比特" });
  assert.match(r, /量子计算入门/);
  assert.match(r, /向量索引未建|关键字/); // 无 Ollama/无索引环境下的退回提示
});

test("list_todos：空清单提示；有清单输出 checkbox", async () => {
  assert.match(await execAgentTool(config, "list_todos", {}), /待办清单为空/);
  writeFileSync(join(vault, "todos.md"), "# 任务清单\n\n- [ ] 写完智能体（P1 · 添加 2026-11-07）\n- [x] 读票 09\n", "utf8");
  const r = await execAgentTool(config, "list_todos", {});
  assert.match(r, /- \[ \] 写完智能体（P1）/);
  assert.match(r, /- \[x\] 读票 09/);
});

test("save_note：写入 notes/ 并回路径；空标题拒绝", async () => {
  assert.match(await execAgentTool(config, "save_note", { title: "  ", body: "x" }), /需要非空 title/);
  const r = await execAgentTool(config, "save_note", { title: "智能体草稿", body: "由工具写入", tags: "agent,test" });
  assert.match(r, /已保存笔记：notes\/智能体草稿.*\.md/);
  const file = r.match(/notes\/(\S+\.md)/)![1]!;
  const p = join(vault, "notes", file);
  assert.ok(existsSync(p));
  assert.match(await readFile(p, "utf8"), /由工具写入/);
});
