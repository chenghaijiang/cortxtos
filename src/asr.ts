// whisper 模型文件定位（票 08）：env 显式指定 > ~/.cortxtos/models 下的量化/全量命名
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function whisperModelCandidates(asrModel: string): string[] {
  const env = process.env.CORTXTOS_WHISPER_MODEL;
  if (env !== undefined && env.length > 0) return [env];
  const dir = join(homedir(), ".cortxtos", "models");
  return [
    join(dir, `ggml-${asrModel}-q5_0.bin`),
    join(dir, `ggml-${asrModel}.bin`),
    join(dir, `ggml-${asrModel}-turbo-q5_0.bin`),
    join(dir, `ggml-${asrModel}-turbo.bin`),
  ];
}

export function findWhisperModel(asrModel: string): string | null {
  return whisperModelCandidates(asrModel).find((p) => existsSync(p)) ?? null;
}
