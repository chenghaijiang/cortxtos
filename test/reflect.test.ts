// 票 06 单元测试：/reflect 指令构建 + daily 追加语义（不依赖 LLM，tmp vault 隔离）
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CortxtosConfig } from "../src/config.ts";
import { appendDaily, dateKey } from "../src/daily.ts";
import reflectExt, { buildReflectPrompt } from "../extensions/reflect.ts";

function tmpConfig(): CortxtosConfig {
  const vault = mkdtempSync(join(tmpdir(), "cortxtos-test-"));
  return {
    vaultPath: vault,
    ollama: { baseUrl: "http://localhost:11434", maxLoadedModels: 1 },
    tiers: {
      fast: { model: "x" }, balanced: { model: "x" }, heavy: { model: "x" },
      vision: { model: "x" }, embedding: { model: "x" },
    },
    asr: { engine: "whisper.cpp", model: "large-v3" },
  };
}

test("buildReflectPrompt：无 focus 不含聚焦行；有 focus 原样带上", () => {
  const base = buildReflectPrompt("");
  assert.match(base, /\/reflect/);
  assert.match(base, /无可沉淀内容/);
  assert.doesNotMatch(base, /聚焦方向/);
  const focused = buildReflectPrompt("  性能优化  ");
  assert.match(focused, /聚焦方向：性能优化/);
});

test("/reflect 命令已注册，handler 触发 sendUserMessage 注入蒸馏指令", async () => {
  const commands = new Map<string, (args: string) => Promise<void> | void>();
  const sent: string[] = [];
  const pi = {
    registerCommand(name: string, _options: unknown) {
      commands.set(name, (_options as { handler: (args: string) => Promise<void> | void }).handler);
    },
    registerTool(_def: unknown) {},
    sendUserMessage(content: string) {
      sent.push(content);
    },
  };
  reflectExt(pi as never);
  assert.ok(commands.has("reflect"));
  await commands.get("reflect")!("决策记录");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /聚焦方向：决策记录/);
});

test("appendDaily：首次新建带五字段 frontmatter，二次追加不覆盖旧条目", async () => {
  const config = tmpConfig();
  const now = new Date(2026, 10, 5, 20, 30); // 本地 2026-11-05 20:30
  const r1 = await appendDaily(config, "- 结论甲\n- 结论乙", now);
  assert.equal(r1.created, true);
  assert.equal(r1.path, join("daily", "2026-11-05.md"));
  const text1 = await readFile(join(config.vaultPath, r1.path), "utf8");
  for (const field of ["title:", "tags:", "created:", "source: reflect", "type: log"]) {
    assert.match(text1, new RegExp(field));
  }

  const later = new Date(2026, 10, 5, 21, 0);
  const r2 = await appendDaily(config, "- 结论丙", later);
  assert.equal(r2.created, false);
  const text2 = await readFile(join(config.vaultPath, r2.path), "utf8");
  assert.match(text2, /结论甲/); // 旧条目仍在
  assert.match(text2, /结论丙/); // 新条目已追加
  assert.match(text2, /## 21:00 沉淀/);
  assert.equal(text2.match(/source: reflect/g)!.length, 1); // frontmatter 未被重复写
});

test("dateKey 用本地时区而非 UTC", () => {
  assert.equal(dateKey(new Date(2026, 10, 5, 23, 30)), "2026-11-05");
});
