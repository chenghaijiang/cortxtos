// 票 07 档位路由单测：vision 档解析 + fallback 链降级 + 缺失报错
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CortxtosConfig } from "../src/config.ts";
import { pipelineModel, resolveTierModel, TierResolutionError } from "../src/tier.ts";

function configWith(tiers: Partial<CortxtosConfig["tiers"]>): CortxtosConfig {
  const base: CortxtosConfig["tiers"] = {
    fast: { model: "fast-m" },
    balanced: { model: "bal-m" },
    heavy: { model: "heavy-m" },
    vision: { model: "vision-m", fallback: ["balanced"] },
    embedding: { model: "emb-m" },
  };
  return {
    vaultPath: "~/vault",
    ollama: { baseUrl: "http://x", maxLoadedModels: 1 },
    tiers: { ...base, ...tiers },
    asr: { engine: "whisper.cpp", model: "large-v3" },
  };
}

test("resolveTierModel：默认解析 vision 档", () => {
  assert.equal(resolveTierModel(configWith({}), "vision"), "vision-m");
  assert.equal(pipelineModel(configWith({})), "vision-m");
});

test("档位 model 为空串时沿 fallback 链降级 balanced", () => {
  const c = configWith({ vision: { model: "  ", fallback: ["balanced"] } });
  assert.equal(resolveTierModel(c, "vision"), "bal-m");
});

test("fallback 链全部无模型：抛 TierResolutionError 且带链路径", () => {
  const c = configWith({
    vision: { model: "", fallback: ["balanced"] },
    balanced: { model: "", fallback: ["heavy"] },
    heavy: { model: "", fallback: [] },
  });
  assert.throws(() => resolveTierModel(c, "vision"), TierResolutionError);
  assert.throws(() => resolveTierModel(c, "vision"), /vision → balanced → heavy/);
});

test("fallback 成环不死循环", () => {
  const c = configWith({
    vision: { model: "", fallback: ["balanced"] },
    balanced: { model: "", fallback: ["vision"] },
  });
  assert.throws(() => resolveTierModel(c, "vision"), TierResolutionError);
});
