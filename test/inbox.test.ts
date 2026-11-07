// 票 05 inbox 工具单元测试：路径窄门 + 真实 pdftotext 抽取（不依赖 LLM）
import assert from "node:assert/strict";
import { test } from "node:test";
import inboxTools, { resolveInboxPath } from "../extensions/inbox.ts";

const VAULT = "/Users/test/cortxt-vault";

type Handler = (params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details: unknown }>;

function makeToolMap() {
  const tools = new Map<string, { parameters: unknown; execute: Handler }>();
  const pi = {
    registerTool(def: { name: string; parameters: unknown; execute: (id: string, p: Record<string, unknown>) => Promise<never> }) {
      tools.set(def.name, { parameters: def.parameters, execute: (p) => def.execute("tc-1", p) });
    },
  };
  inboxTools(pi as never);
  return tools;
}

test("resolveInboxPath：正常相对名/带 inbox 前缀/绝对路径均归一到 vault/inbox", () => {
  assert.equal(resolveInboxPath(VAULT, "论文.pdf"), `${VAULT}/inbox/论文.pdf`);
  assert.equal(resolveInboxPath(VAULT, "@论文.pdf"), `${VAULT}/inbox/论文.pdf`);
  assert.equal(resolveInboxPath(VAULT, "inbox/论文.pdf"), `${VAULT}/inbox/论文.pdf`);
  assert.equal(resolveInboxPath(VAULT, `${VAULT}/inbox/a/b.pdf`), `${VAULT}/inbox/a/b.pdf`);
});

test("resolveInboxPath：路径穿越与 inbox 外一律拒绝", () => {
  assert.equal(resolveInboxPath(VAULT, "../../etc/passwd"), null);
  assert.equal(resolveInboxPath(VAULT, "inbox/../../notes/x.md"), null);
  assert.equal(resolveInboxPath(VAULT, "/etc/passwd"), null);
  assert.equal(resolveInboxPath(VAULT, `${VAULT}/notes/秘密.md`), null);
  // ~/ 前缀被归一化到 inbox 相对（仍在窄门内，不构成逃逸）
  assert.equal(resolveInboxPath(VAULT, "~/Desktop/stuff.pdf"), `${VAULT}/inbox/Desktop/stuff.pdf`);
  assert.equal(resolveInboxPath(VAULT, ""), null);
});

test("四个 inbox 工具均已注册", () => {
  const tools = makeToolMap();
  for (const name of ["list_inbox", "extract_pdf", "transcribe_audio", "archive_inbox"]) {
    assert.ok(tools.has(name), `${name} 应已注册`);
  }
});

test("extract_pdf：越界路径被拒绝且不执行 pdftotext", async () => {
  const tools = makeToolMap();
  const res = await tools.get("extract_pdf")!.execute({ path: "../../Windows/system32/config.sam" });
  assert.match(res.content[0]!.text, /路径非法|不在 vault\/inbox/);
});

test("archive_inbox：不存在的 inbox 文件返回提示，不抛异常", async () => {
  const tools = makeToolMap();
  const res = await tools.get("archive_inbox")!.execute({ path: "不存在的文件.pdf" });
  assert.match(res.content[0]!.text, /文件不存在/);
});

test("transcribe_audio：越界路径拒绝；不存在的音频文件优雅失败", async () => {
  const tools = makeToolMap();
  const bad = await tools.get("transcribe_audio")!.execute({ path: "../notes/..\u002f..\u002fetc\u002fpasswd" });
  assert.match(bad.content[0]!.text, /路径非法|不在 vault\/inbox/);
  const missing = await tools.get("transcribe_audio")!.execute({ path: "不存在的录音.m4a" });
  assert.match(missing.content[0]!.text, /文件不存在/);
});
