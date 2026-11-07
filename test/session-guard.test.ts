// 票 04 单元测试：不依赖 LLM，直接驱动 extension handler 断言行为
import assert from "node:assert/strict";
import { test } from "node:test";
import sessionGuard, { HEADLESS_WHITELIST, isHeadless, isToolAllowed } from "../extensions/session-guard.ts";

type Handler = (event: any, ctx: any) => any;

function makeFakePi() {
  const handlers = new Map<string, Handler>();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    setActiveTools(names: string[]) {
      calls.push({ method: "setActiveTools", args: [names] });
    },
  };
  sessionGuard(pi as never);
  return { pi, handlers, calls };
}

test("isHeadless 判定：print/json 或 env 标记", () => {
  assert.equal(isHeadless({ mode: "print" }), true);
  assert.equal(isHeadless({ mode: "json" }), true);
  assert.equal(isHeadless({ mode: "tui" }), false);
  assert.equal(isHeadless({ mode: "rpc" }), false);
});

test("无人值守 session_start 触发白名单裁剪", async () => {
  const { handlers, calls } = makeFakePi();
  await handlers.get("session_start")!(
    {},
    { mode: "print" },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args[0], [...HEADLESS_WHITELIST]);
});

test("TUI 会话 session_start 不动工具集", async () => {
  const { handlers, calls } = makeFakePi();
  await handlers.get("session_start")!({}, { mode: "tui" });
  assert.equal(calls.length, 0);
});

test("无人值守 tool_call：bash/edit 被拦截，read/write/kb_search 放行", async () => {
  const { handlers } = makeFakePi();
  const toolCall = handlers.get("tool_call")!;
  const ctx = { mode: "print" };

  for (const banned of ["bash", "edit", "grep", "find", "ls"]) {
    const r = await toolCall({ toolName: banned }, ctx);
    assert.equal(r?.block, true, `${banned} 应被拦截`);
    assert.ok(r?.reason?.includes(banned), "拦截理由需点名工具");
  }
  for (const allowed of ["read", "write", "kb_search"]) {
    assert.equal(await toolCall({ toolName: allowed }, ctx), undefined, `${allowed} 应放行`);
  }
});

test("TUI 会话 tool_call 一律放行", async () => {
  const { handlers } = makeFakePi();
  assert.equal(await handlers.get("tool_call")!({ toolName: "bash" }, { mode: "tui" }), undefined);
});

test("CORTXTOS_HEADLESS=1 环境变量兜底（TUI 模式也按无人值守处理）", async () => {
  process.env.CORTXTOS_HEADLESS = "1";
  try {
    const { handlers, calls } = makeFakePi();
    await handlers.get("session_start")!({}, { mode: "tui" });
    assert.equal(calls.length, 1, "env 兜底应触发裁剪");
    assert.equal(isToolAllowed("bash"), false);
  } finally {
    delete process.env.CORTXTOS_HEADLESS;
  }
});
