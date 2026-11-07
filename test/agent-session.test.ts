// 深度模式会话管理器：JSONL 严格分帧 + pi 事件翻译表 + 工具参数补齐（全部离线，不启 pi 进程）
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitFrames, translatePiEvent, attachStartArgs, piBinary, shouldRecycle } from "../src/agent-session.ts";

const frames = (s: string): string[] => splitFrames(Buffer.from(s, "utf8"), Buffer.alloc(0)).frames;

test("splitFrames：按 LF 切多条记录，剩余半截留到下轮", () => {
  const buf = Buffer.from('{"a":1}\n{"b":2', "utf8");
  const r = splitFrames(buf, Buffer.alloc(0));
  assert.deepEqual(r.frames, ['{"a":1}']);
  assert.equal(r.rest.toString("utf8"), '{"b":2');
  const r2 = splitFrames(Buffer.from("}\n", "utf8"), r.rest);
  assert.deepEqual(r2.frames, ['{"b":2}']);
  assert.equal(r2.rest.length, 0);
});

test("splitFrames：U+2028/U+2029 是字符串合法字符，不当作记录边界（Node readline 的坑）", () => {
  const payload = JSON.stringify({ text: "第一段\u2028第二段\u2029第三段" });
  const r = splitFrames(Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from("\n", "utf8")]), Buffer.alloc(0));
  assert.equal(r.frames.length, 1);
  assert.deepEqual(JSON.parse(r.frames[0]!), { text: "第一段\u2028第二段\u2029第三段" });
});

test("splitFrames：容忍 CRLF 与空行", () => {
  assert.deepEqual(frames('{"a":1}\r\n\r\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
});

test("translatePiEvent：text_delta → content；非文本增量不透传", () => {
  assert.deepEqual(
    translatePiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好" } }),
    { content: "你好" },
  );
  assert.equal(translatePiEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "x" } }), null);
  assert.equal(translatePiEvent({ type: "agent_start" }), null);
});

test("translatePiEvent：工具生命周期 → tool / tool_result（含 ok 与预览截断）", () => {
  assert.deepEqual(translatePiEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } }), { tool: "bash", args: { command: "ls" } });
  const end = translatePiEvent({
    type: "tool_execution_end",
    toolName: "bash",
    isError: false,
    args: { command: "ls" },
    result: { content: [{ type: "text", text: "x".repeat(5000) }] },
  }) as Record<string, unknown>;
  assert.equal(end.tool_result, "bash");
  assert.equal(end.ok, true);
  assert.equal((end.preview as string).length, 4000);
  const bad = translatePiEvent({ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [] } }) as Record<string, unknown>;
  assert.equal(bad.ok, false);
});

test("translatePiEvent：update_plan 结果附带独立规划事件", () => {
  const ev = translatePiEvent({
    type: "tool_execution_end",
    toolName: "update_plan",
    isError: false,
    args: { goal: "整理发票", steps: [{ text: "列出收件箱", status: "done" }] },
    result: { content: [{ type: "text", text: "计划已更新" }] },
  }) as { plan?: { goal: string; steps: unknown[] } };
  assert.equal(ev.plan?.goal, "整理发票");
  assert.equal(ev.plan?.steps.length, 1);
  // 其他工具即使 args 里有 steps 也不误判
  const other = translatePiEvent({ type: "tool_execution_end", toolName: "read", isError: false, args: { steps: [1] }, result: { content: [] } }) as Record<string, unknown>;
  assert.equal(other.plan, undefined);
});

test("attachStartArgs：end 事件补齐 start 的参数（协议里 end 不带 args）", () => {
  const cache = new Map<string, unknown>();
  const start = { type: "tool_execution_start", toolCallId: "t1", toolName: "update_plan", args: { goal: "G", steps: [] } };
  assert.equal(attachStartArgs(start, cache), start);
  const end = attachStartArgs({ type: "tool_execution_end", toolCallId: "t1", toolName: "update_plan", isError: false, result: { content: [] } }, cache);
  assert.deepEqual((end as Record<string, unknown>).args, { goal: "G", steps: [] });
  assert.equal(cache.size, 0);
  // 未知 id / 已有 args 时不覆盖
  const keep = attachStartArgs({ type: "tool_execution_end", toolCallId: "t9", args: { a: 1 }, isError: false }, cache);
  assert.deepEqual((keep as Record<string, unknown>).args, { a: 1 });
});

test("translatePiEvent：压缩/重试/扩展异常/收尾信号", () => {
  assert.deepEqual(translatePiEvent({ type: "compaction_start", reason: "threshold" }), { system: "上下文压缩中（threshold）…" });
  assert.deepEqual(translatePiEvent({ type: "compaction_end", result: { summary: "s" } }), { system: "上下文压缩完成，历史已摘要保留" });
  assert.equal(translatePiEvent({ type: "compaction_end", aborted: true }), null);
  const fail = translatePiEvent({ type: "compaction_end", errorMessage: "boom" }) as Record<string, unknown>;
  assert.match(String(fail.error), /boom/);
  assert.deepEqual(translatePiEvent({ type: "agent_settled", aborted: false }), { done: true, aborted: false });
  const retry = translatePiEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "529" }) as Record<string, unknown>;
  assert.match(String(retry.system), /重试（1\/3）/);
  const extErr = translatePiEvent({ type: "extension_error", error: "kaboom" }) as Record<string, unknown>;
  assert.match(String(extErr.error), /kaboom/);
});

test("piBinary：CORTXTOS_PI 覆盖优先（测试与异构环境用）", () => {
  const saved = process.env.CORTXTOS_PI;
  process.env.CORTXTOS_PI = "/tmp/pi-fake";
  assert.equal(piBinary(), "/tmp/pi-fake");
  if (saved === undefined) delete process.env.CORTXTOS_PI;
  else process.env.CORTXTOS_PI = saved;
  assert.ok(piBinary().length > 0);
});

test("shouldRecycle：长任务进行中不回收；空闲超 10 分钟回收；静默超 30 分钟视为卡死则兜底回收", () => {
  const MIN = 60_000;
  // 多步任务的单轮可以远超 10 分钟：早期版本正是按“上次 prompt 时间”计时，在规划任务中途误杀了会话
  assert.equal(shouldRecycle(11 * MIN, true), false, "轮次进行中/卡片待应答不能回收");
  assert.equal(shouldRecycle(9 * MIN, false), false, "未到阈值");
  assert.equal(shouldRecycle(11 * MIN, false), true, "空闲超阈值且不在忙");
  assert.equal(shouldRecycle(31 * MIN, true), true, "子进程卡死：无论状态一律回收，不能永久占着本地大模型");
  assert.equal(shouldRecycle(0, false), false, "刚有输出");
});
