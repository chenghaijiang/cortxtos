#!/usr/bin/env python3
"""深度模式端到端验收：起会话 -> 发提示词 -> 按策略应答确认卡片 -> 打印完整 NDJSON 事件流。

用法：python3 scripts/e2e-deep.py "<提示词>" [allow|deny|none]
  allow 每个确认卡片都点「允许执行」
  deny  每个都点「拒绝」
  none  不应答（观察 pi 侧 300s 超时自动拒绝）
"""
import json
import sys
import urllib.request

BASE = "http://127.0.0.1:8899"


def post(path: str, payload: dict, timeout: int = 60):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode("utf8"),
        headers={"content-type": "application/json"},
    )
    return urllib.request.urlopen(req, timeout=timeout)


def main() -> int:
    msg = sys.argv[1] if len(sys.argv) > 1 else "统计 notes 目录下 .md 文件数，只回数字"
    answer = sys.argv[2] if len(sys.argv) > 2 else "allow"
    sid = json.load(post("/api/agent/start", {}, 300))["sessionId"]
    print(f"sessionId={sid} answer={answer}")
    stream = post("/api/agent/prompt", {"sessionId": sid, "message": msg}, 1500)
    asked = set()
    plans = 0
    for raw in stream:
        o = json.loads(raw)
        if "content" in o:
            sys.stdout.write(o["content"])
            sys.stdout.flush()
            continue
        print("\n· " + json.dumps(o, ensure_ascii=False)[:400])
        if "plan" in o:
            plans += 1
        req = o.get("ui_request")
        if req and req["id"] not in asked:
            asked.add(req["id"])
            if answer != "none":
                post("/api/agent/ui-response", {
                    "sessionId": sid, "id": req["id"], "confirmed": answer == "allow"
                })
                print(f"· 已应答确认卡片 {req['id'][:8]} -> {answer}")
    print(f"\n== 收尾：确认卡片 {len(asked)} 次，规划事件 {plans} 次 ==")
    print(json.dumps(json.load(post("/api/agent", {}, 30)), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
