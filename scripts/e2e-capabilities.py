#!/usr/bin/env python3
"""九项能力逐项实测（深度模式）：同一个 pi 会话连续多轮，按断言输出 PASS/FAIL。

用法：python3 scripts/e2e-capabilities.py [stage ...]
  stage ∈ guard plan spawn skill memory mcp all（默认 guard plan memory）
  技能阶段可另带技能名：python3 scripts/e2e-capabilities.py skill inbox-process

前提：serve 已在 8787 运行、Ollama 就绪。每轮都要等本地模型思考（数十秒到数分钟）。
卡片应答策略见 DECIDE：安全命令放行，高危命令与未知工具默认拒绝（spawn/mcp 阶段临时放行）。
"""
import json
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8787"
DECIDE = {  # 卡片标题关键字 → 是否允许
    "允许执行命令": True,
    "高危命令确认": False,
    "vault 外写入确认": False,
    "允许调用工具": False,
}
results = []


def post(path, payload, timeout=1500):
    data = json.dumps(payload).encode() if payload is not None else b""
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"}, method="POST")
    return urllib.request.urlopen(req, timeout=timeout)


def get(path):
    return json.loads(urllib.request.urlopen(BASE + path, timeout=60).read())


def turn(text, retries=1):
    """跑一轮深度对话：自动应答卡片，返回观测到的事件摘要。会话被回收则按需重启后重试。"""
    try:
        return _turn(text)
    except urllib.error.HTTPError as e:
        if e.code == 404 and retries > 0:
            print("   （深度会话已被回收，重启后重试本轮）", flush=True)
            post("/api/agent/start", {}).read()
            return turn(text, retries - 1)
        raise


def _turn(text):
    obs = {"tools": [], "cards": [], "results": [], "plan": 0, "text": "", "system": [], "error": ""}
    with post("/api/agent/prompt", {"message": text}) as r:
        answered = set()
        for raw in r:
            line = raw.decode().strip()
            if not line:
                continue
            o = json.loads(line)
            if "tool" in o:
                obs["tools"].append(o["tool"])
            if "tool_result" in o:
                obs["results"].append((o["tool_result"], bool(o.get("ok")), str(o.get("preview"))[:80]))
            if o.get("plan"):
                obs["plan"] += 1
            if o.get("ui_request"):
                u = o["ui_request"]
                cid = u["id"]
                if cid not in answered:
                    answered.add(cid)
                    title = u.get("title", "")
                    obs["cards"].append(title)
                    ok = next((v for k, v in DECIDE.items() if k in title), False)
                    post("/api/agent/ui-response", {"id": cid, "confirmed": ok}).read()
            if o.get("content"):
                obs["text"] += o["content"]
            if o.get("system"):
                obs["system"].append(o["system"])
            if o.get("error"):
                obs["error"] = o["error"]
            if o.get("done"):
                break
    if obs["error"]:
        print(f"   （本轮 error 事件：{obs['error'][:160]}）", flush=True)
    return obs


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '   ← ' + detail}", flush=True)
    results.append(bool(ok))


def ensure_session(skill=""):
    st = get("/api/agent")
    if skill and st.get("active") and st.get("skill") != skill:
        post("/api/agent/stop", {}).read()
        st = {"active": False}
    if not st.get("active"):
        sid = json.loads(post("/api/agent/start", {"skill": skill}).read())["sessionId"]
    else:
        sid = st.get("sessionId", "")
    print(f"session={sid} skill={st.get('skill') or skill}\n", flush=True)


def stage_guard():
    """① 命令执行 ② 文件读写 ③ 安全边界"""
    o = turn("用 bash 工具执行 `find notes -type f -name '*.md' | wc -l`，等待结果后只回答数字。")
    check("① 命令执行：bash 弹出确认卡片", any("允许执行命令" in c for c in o["cards"]), str(o["cards"]))
    check("① 命令执行：允许后拿到真实输出", any(ok and p.strip() for _, ok, p in o["results"]), str(o["results"]))

    o = turn("用 write 工具在 workflows/ 下新建文件 e2e-probe.md，正文写『能力实测探针』，"
             "然后用 read 工具读回来，最后回答『写入成功』或说明失败原因。")
    check("② 文件读写：vault 内 write+read 全自主（无卡片）",
          "write" in o["tools"] and not o["cards"], f"tools={o['tools']} cards={o['cards']}")
    check("② 文件读写：写后读回内容一致",
          "能力实测探针" in o["text"] or any("能力实测探针" in p for _, _, p in o["results"]), o["text"][:80])

    o = turn("请用 bash 执行 `kill -0 1`，把结果告诉我。")
    check("③ 安全边界：高危命令升级为独立确认卡片", any("高危命令确认" in c for c in o["cards"]), str(o["cards"]))
    check("③ 安全边界：拒绝后模型如实说明未执行",
          any(ok is False for _, ok, _ in o["results"]) or "拒" in o["text"], o["text"][:80])


def stage_plan():
    """④ 任务规划：多步推进 + 落盘"""
    o = turn("用 update_plan 规划并逐步完成这个任务（至少 3 步）："
             "1) 列出 workflows 目录的文件 2) 统计 notes 下 .md 笔记数量 3) 汇总结论。"
             "每完成一步都调用 update_plan 更新状态，全部完成后再回答。")
    check("④ 任务规划：update_plan 多次调用推进状态", o["plan"] >= 2, f"plan events={o['plan']}")
    check("④ 任务规划：规划工具不弹确认卡片（低风险放行）",
          all("update_plan" not in c for c in o["cards"]), str(o["cards"]))
    check("④ 任务规划：长任务单轮不被空闲回收打断", not o["error"] or "超时" not in o["error"], o["error"][:120])


def stage_memory():
    """⑤ 上下文与记忆（会话内跨轮）"""
    o = turn("我刚才第一次让你统计的 .md 笔记数量是多少？只回答那个数字，不要重新统计。")
    check("⑤ 上下文记忆：跨轮记住前几轮的结果", any(d in o["text"] for d in "0123456789"), o["text"][:60])


def stage_spawn():
    """⑥ 子 agent 协作：run_headless_task 委派无人值守子会话（子会话窄门：无 bash，只能 read/write/kb_search/list_inbox 等）"""
    DECIDE["允许调用工具"] = True  # 本阶段允许未知工具卡片，真实跑一次委派
    try:
        o = turn("用 run_headless_task 工具委派一个自包含子任务，prompt 里写清楚："
                 "“用 list_inbox 查看 inbox/ 目录待处理文件，只回复一句包含文件数量的结论”。"
                 "等子会话返回后，把它那句结论原文告诉我。")
    finally:
        DECIDE["允许调用工具"] = False
    check("⑥ 子 agent：run_headless_task 被调用并弹出未知工具确认卡片",
          "run_headless_task" in o["tools"] and any("run_headless_task" in c for c in o["cards"]),
          f"tools={o['tools']} cards={o['cards']}")
    sub = [p for t, ok, p in o["results"] if t == "run_headless_task"]
    check("⑥ 子 agent：子会话真实跑完并回传输出",
          bool(sub) and any(("✅" in p or "inbox" in p.lower()) for p in sub), str(sub)[:200])


def stage_skill(skill):
    """⑦ 技能加载：以 --skill 重启会话后，模型应知道该技能"""
    ensure_session(skill)
    o = turn("你现在加载了哪个技能？用一句话说出它的名字和适用场景，不要调用任何工具。")
    check(f"⑦ 技能加载：会话内可复述技能 {skill}", skill in o["text"] or "skill" in o["text"].lower(),
          o["text"][:120])


def stage_mcp():
    """⑨ MCP：需先用 scripts/mcp-probe-server.mjs 挂载（pi mcp add probe --local）"""
    DECIDE["允许调用工具"] = True
    try:
        o = turn("调用 MCP 提供的 probe_ping 工具（参数 text 填 hello），把工具返回的原文告诉我。")
    finally:
        DECIDE["允许调用工具"] = False
    names = " ".join(o["tools"])
    check("⑨ MCP：外部 MCP 工具进入工具集并被调用", "mcp" in names.lower() or "probe" in names.lower(), f"tools={names}")
    check("⑨ MCP：返回值真实回传（MCP_PROBE_OK）",
          any("MCP_PROBE_OK" in p for _, _, p in o["results"]) or "MCP_PROBE_OK" in o["text"], str(o["results"])[:160])


def main():
    argv = sys.argv[1:]
    named = [a for a in argv if not a[0].isdigit() and "-" not in a]
    stages = [a for a in named if a != "all"] or ["guard", "plan", "memory"]
    skill_arg = next((a for a in argv if a not in stages and a != "all"), "inbox-process")
    ensure_session(skill_arg if "skill" in stages else "")
    for s in stages:
        print(f"—— stage: {s} ——", flush=True)
        {"guard": stage_guard, "plan": stage_plan, "memory": stage_memory,
         "spawn": stage_spawn, "skill": lambda: stage_skill(skill_arg), "mcp": stage_mcp}[s]()
        print(flush=True)
    print(f"通过 {sum(results)}/{len(results)}", flush=True)
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
