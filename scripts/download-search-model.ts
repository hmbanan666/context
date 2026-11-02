// Build-time only. Runtime loading is local_files_only and cannot fetch models.
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { E5_MODEL, E5_REVISION } from "../src/embedding-model.js";

const root = process.argv[2];
if (!root) throw new Error("Usage: download-search-model DIRECTORY");
for (const file of [
  "README.md",
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx",
]) {
  const response = await fetch(
    `https://huggingface.co/${E5_MODEL}/resolve/${E5_REVISION}/${file}`,
    { signal: AbortSignal.timeout(300_000) },
  );
  if (!response.ok || !response.body) throw new Error("Model download failed");
  const destination = join(root, E5_MODEL, file);
  await mkdir(dirname(destination), { recursive: true });
  await pipeline(response.body, createWriteStream(destination));
  console.log(`Saved ${file}`);
}
