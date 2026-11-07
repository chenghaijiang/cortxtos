// 档位路由（票 07）：管道会话模型的静态解析——规则式，禁止模型自评复杂度
// 按 DESIGN §5 档位表：目标档位缺失时沿 fallback 链降级（vision → balanced → heavy）
import type { CortxtosConfig, TierName } from "./config.ts";

export class TierResolutionError extends Error {}

/** 从 start 档出发，广度优先沿 fallback 链找第一个配置了非空 model 的档位 */
export function resolveTierModel(config: CortxtosConfig, start: TierName): string {
  const seen = new Set<TierName>();
  const queue: TierName[] = [start];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const tier = config.tiers[name];
    if (tier !== undefined && tier.model.trim().length > 0) return tier.model;
    if (tier?.fallback) queue.push(...tier.fallback);
  }
  throw new TierResolutionError(
    `档位 ${start} 及其 fallback 链（${[...seen].join(" → ")}）均无可用模型，请检查 cortxtos.json 的 tiers`,
  );
}

/** inbox 混合管道的会话模型：vision 档（原生多模态，同为文本摘要的超集） */
export function pipelineModel(config: CortxtosConfig): string {
  return resolveTierModel(config, "vision");
}
