// planner（Web 深度模式规划面板）：参数校验 + 计划文件落盘格式
// execute 走 loadConfig，故先把 CORTXTOS_CONFIG 指到临时 vault，再动态导入本扩展（避免写入真实知识库）
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";

const vault = mkdtempSync(join(tmpdir(), "cortxtos-plan-"));
writeFileSync(
  join(vault, "cortxtos.json"),
  JSON.stringify({
    vaultPath: vault,
    ollama: { baseUrl: "http://127.0.0.1:1", maxLoadedModels: 1 },
    tiers: { fast: { model: "m" }, balanced: { model: "m" }, heavy: { model: "m" }, vision: { model: "m" }, embedding: { model: "e" } },
    asr: { engine: "whisper.cpp", model: "large-v3" },
  }),
  "utf8",
);
process.env.CORTXTOS_CONFIG = join(vault, "cortxtos.json");

const { normalizePlan, renderPlan, default: planner } = await import("../extensions/planner.ts");

after(() => { rmSync(vault, { recursive: true, force: true }); });

test("normalizePlan：goal/steps 校验与状态归一", () => {
  assert.match((normalizePlan({ steps: [{ text: "a", status: "done" }] }) as { error: string }).error, /非空 goal/);
  assert.match((normalizePlan({ goal: "G" }) as { error: string }).error, /至少一个 step/);
  assert.match((normalizePlan({ goal: "G", steps: [] }) as { error: string }).error, /至少一个 step/);
  assert.match((normalizePlan({ goal: "G", steps: [{ text: "", status: "done" }] }) as { error: string }).error, /空步骤文本/);
  assert.match((normalizePlan({ goal: "G", steps: Array.from({ length: 31 }, () => ({ text: "x", status: "done" })) }) as { error: string }).error, /拆分任务/);
  // 非法状态退回 pending；首次全 pending 时第一步自动置 doing
  const r = normalizePlan({ goal: "整理发票", steps: [{ text: "列出收件箱", status: "weird" }, { text: "生成笔记" }] }) as { goal: string; steps: Array<{ text: string; status: string }> };
  assert.equal(r.goal, "整理发票");
  assert.equal(r.steps[0]!.status, "doing");
  assert.equal(r.steps[1]!.status, "pending");
});

test("renderPlan：checkbox 正文 + 进度行 + 状态注记", () => {
  const md = renderPlan("整理发票", [
    { text: "列出收件箱", status: "done" },
    { text: "逐篇摘要", status: "doing" },
    { text: "归档原件", status: "skipped" },
  ], "2026-11-07 10:20");
  assert.match(md, /# 任务计划/);
  assert.match(md, /- goal：整理发票/);
  assert.match(md, /- 进度：1\/3/);
  assert.match(md, /- \[x\] 列出收件箱/);
  assert.match(md, /- \[ \] 逐篇摘要（进行中）/);
  assert.match(md, /- \[ \] 归档原件（跳过）/);
});

type Handler = (params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
function toolAt(name: string): Handler {
  const tools = new Map<string, Handler>();
  planner({
    registerTool(def: { name: string; execute: (id: string, p: Record<string, unknown>) => Promise<never> }) {
      tools.set(def.name, (p) => def.execute("tc-1", p));
    },
  } as never);
  const h = tools.get(name);
  assert.ok(h, `未注册工具 ${name}`);
  return h!;
}

test("update_plan 全量写 workflows/plan-*.md（可被 kb 检索、断电可恢复）", async () => {
  const dir = join(vault, "workflows");
  const exec = toolAt("update_plan");
  const r1 = await exec({ goal: "整理发票", steps: [{ text: "列出收件箱", status: "done" }, { text: "逐篇摘要", status: "doing" }] });
  assert.match(r1.content[0]!.text, /计划已更新（1\/2 完成）/);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("plan-") && f.endsWith(".md")) : [];
  assert.equal(files.length, 1, "应落一个 plan 文件");
  assert.match(readFileSync(join(dir, files[0]!), "utf8"), /- \[x\] 列出收件箱/);
  // 非法参数不落新文件
  const bad = await exec({ goal: "", steps: [] });
  assert.match(bad.content[0]!.text, /非空 goal/);
  assert.equal(readdirSync(dir).filter((f) => f.startsWith("plan-")).length, 1);
});
