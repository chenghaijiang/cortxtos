#!/usr/bin/env node
/**
 * mcp-probe-server.mjs —— 能力实测用的最小 MCP 服务器（stdio，零依赖）。
 *
 * 用途：验证深度模式的「MCP 插件扩展」能力真的通到底——pi 把这里的工具挂成
 * mcp__probe__*，Web 侧按「未知外部能力」弹确认卡片，允许后拿到真实返回值。
 *
 * 挂载（项目级配置，写 .pi/mcp.json）：
 *   pi mcp add probe --local -- node scripts/mcp-probe-server.mjs
 * 摘除：
 *   pi mcp remove probe --local
 *
 * 协议：JSON-RPC 2.0 over stdio，按行分帧；实现 initialize / tools/list / tools/call / ping。
 */
import { createInterface } from "node:readline";

const SERVER = { name: "cortxtos-probe", version: "0.1.0" };
const TOOLS = [
  {
    name: "probe_ping",
    description: "MCP 通路自检：返回固定标记字符串 MCP_PROBE_OK 与收到的文本",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "任意回显文本" } },
      required: ["text"],
    },
  },
];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32601, message } });
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // 非 JSON 行忽略
  }
  const { id, method, params } = req;
  if (method === "initialize") {
    reply(id, { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: SERVER });
  } else if (method === "ping") {
    reply(id, {});
  } else if (method === "tools/list") {
    reply(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const text = String(params?.arguments?.text ?? "");
    if (params?.name !== "probe_ping") {
      replyError(id, `unknown tool: ${String(params?.name)}`);
      return;
    }
    reply(id, { content: [{ type: "text", text: `MCP_PROBE_OK echo=${text || "(空)"}` }], isError: false });
  } else if (id !== undefined) {
    replyError(id, `unknown method: ${String(method)}`);
  }
  // 通知（无 id）不需要应答，如 notifications/initialized
});
