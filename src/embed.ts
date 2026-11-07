// Ollama embeddings 客户端（票 09）：/api/embed 批量接口，全本地 loopback，数据不出机器
import type { CortxtosConfig } from "./config.ts";

/** 注入式 embedding 函数：生产走 Ollama，测试给假向量（解耦网络依赖） */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export async function embedTexts(config: CortxtosConfig, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = config.tiers.embedding.model;
  const resp = await fetch(`${config.ollama.baseUrl}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Ollama /api/embed HTTP ${resp.status}：${detail.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { embeddings?: number[][] };
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
    throw new Error("Ollama /api/embed 返回结构异常（embeddings 数量与 input 不一致）");
  }
  return data.embeddings;
}

/** 分批向量化：单次请求过大对 27B 主机不友好，0.6B 也按 16 条一批稳妥 */
export function makeEmbedder(config: CortxtosConfig, batchSize = 16): EmbedFn {
  return async (texts) => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      out.push(...(await embedTexts(config, texts.slice(i, i + batchSize))));
    }
    return out;
  };
}
