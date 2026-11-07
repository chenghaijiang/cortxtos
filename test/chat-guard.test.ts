// chat-guard（Web 深度模式确认闸门）：needsApproval 判定矩阵 + 扩展拦截链路（mock ctx.ui.confirm）
import assert from "node:assert/strict";
import { test } from "node:test";
import chatGuard, { needsApproval } from "../extensions/chat-guard.ts";

const VAULT = "/Users/test/cortxt-vault";

test("read/ls/glob/grep 只读低危，不弹确认", () => {
  for (const name of ["read", "ls", "glob", "grep"]) {
    assert.equal(needsApproval(name, { path: `${VAULT}/notes/a.md` }, VAULT), null);
    assert.equal(needsApproval(name, { command: "cat x" }, VAULT), null);
  }
});

test("bash 一律确认；危险命令用高危标题", () => {
  const plain = needsApproval("bash", { command: "ls notes | wc -l" }, VAULT);
  assert.equal(plain?.need, true);
  assert.equal(plain?.title, "允许执行命令？");
  assert.match(plain!.message, /命令：ls notes \| wc -l/);
  for (const cmd of ["rm -rf notes", "sudo tee x", "mkfs /dev/disk9", "dd if=/dev/zero", "chmod -R 777 ~", ":(){ :|:& };:", "kill -9 4321"]) {
    assert.equal(needsApproval("bash", { command: cmd }, VAULT)?.title, "⚠ 高危命令确认", cmd);
  }
  // 大小写与子串边界：rm 作为单词才触发，format/confirm 这类词不误报
  assert.equal(needsApproval("bash", { command: "RM file" }, VAULT)?.title, "⚠ 高危命令确认");
  assert.equal(needsApproval("bash", { command: "pdftotext a.pdf out.txt" }, VAULT)?.title, "允许执行命令？");
});

test("write/edit：vault 内自主放行，越界才确认", () => {
  assert.equal(needsApproval("write", { path: `${VAULT}/notes/新笔记.md`, content: "x" }, VAULT), null);
  assert.equal(needsApproval("edit", { path: "notes/相对.md" }, VAULT), null);
  assert.equal(needsApproval("edit", { path: "notes/../notes/a.md" }, VAULT), null); // 归一后仍在界内
  const out = needsApproval("write", { path: "~/Desktop/x.md" }, VAULT);
  assert.equal(out?.title, "⚠ vault 外写入确认");
  assert.match(out!.message, /路径：/);
  assert.equal(needsApproval("write", { path: "/etc/hosts" }, VAULT)?.need, true);
  assert.equal(needsApproval("edit", { path: `${VAULT}-backup/a.md` }, VAULT)?.need, true); // 前缀相似不算界内
});

test("本仓库自带的低风险工具不弹卡片（否则多步任务会被规划确认刷屏）", () => {
  assert.equal(needsApproval("update_plan", { goal: "G", steps: [{ text: "a", status: "doing" }] }, VAULT), null);
  assert.equal(needsApproval("kb_search", { query: "上下文压缩" }, VAULT), null);
  assert.equal(needsApproval("archive_inbox", { file: "inbox/a.pdf" }, VAULT), null);
});

test("未知工具（含 MCP 外部能力）默认确认", () => {
  const d = needsApproval("mcp__notion__create", { page: "x" }, VAULT);
  assert.equal(d?.need, true);
  assert.match(d!.title, /mcp__notion__create/);
});

test("pi codemode（MCP 聚合工具）使用可读标题并展示待执行代码", () => {
  const d = needsApproval("codemode", { code: "mcp__github__get_me()" }, VAULT);
  assert.equal(d?.need, true);
  assert.match(d!.title, /MCP 外部能力/);
  assert.match(d!.message, /get_me/);
});

type ConfirmFn = (title: string, message: string, opts?: { timeout?: number }) => Promise<boolean>;
function makeHarness(confirm: ConfirmFn) {
  let handler: ((event: { toolName: string; input: Record<string, unknown> }, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>) | null = null;
  const pi = {
    on(_e: string, h: NonNullable<typeof handler>) { handler = h; },
  };
  chatGuard(pi as never);
  const call = (toolName: string, input: Record<string, unknown>) =>
    handler!({ toolName, input }, { cwd: VAULT, ui: { confirm } });
  return { call, called: () => handler !== null };
}

test("拦截链路：只读直接放行且不打扰用户", async () => {
  let asks = 0;
  const { call, called } = makeHarness(async () => { asks++; return true; });
  assert.ok(called());
  assert.equal(await call("read", { path: `${VAULT}/notes/a.md` }), undefined);
  assert.equal(asks, 0);
});

test("拦截链路：允许则放行，拒绝则 block 并给出原因", async () => {
  const allow = makeHarness(async () => true);
  assert.equal(await allow.call("bash", { command: "ls" }), undefined);
  const deny = makeHarness(async () => false);
  const r = await deny.call("bash", { command: "rm -rf notes" });
  assert.equal(r?.block, true);
  assert.match(r!.reason, /用户|未确认/);
  assert.match(r!.reason, /高危命令确认/);
});

test("拦截链路：vault 外写入被拒时，原因里带上工具名对应的确认标题", async () => {
  const h = makeHarness(async () => false);
  const r = await h.call("write", { path: "/tmp/evil.md", content: "x" });
  assert.equal(r?.block, true);
  assert.match(r!.reason, /vault 外写入确认/);
});
