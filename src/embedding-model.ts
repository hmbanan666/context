import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ADR 0014. intfloat/multilingual-e5-small via the pinned Xenova ONNX build.
// multilingual-e5-base (q8 ONNX 278,647,662 bytes, 768-d) was measured against
// this 118,308,185-byte 384-d file and rejected for a 1.5 GiB VPS: a reindex
// loads a second copy beside the server. The id below is stored with every
// vector; a different id is never compared.
export const E5_MODEL = "Xenova/multilingual-e5-small";
export const E5_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
export const E5_DIMENSIONS = 384;
export const E5_VERSION = `${E5_MODEL}@${E5_REVISION}:q8:mean:${E5_DIMENSIONS}:chunks-v2`;

/** E5 requires this prefix, including the space, on queries and passages. */
export function e5Prefixed(purpose: "query" | "passage", text: string): string {
  return `${purpose}: ${text}`;
}
export interface Embedder {
  readonly version: string;
  embed(text: string, purpose: "query" | "passage"): Promise<Float32Array>;
  load?(): Promise<void>;
  close?(): Promise<void>;
}
// No import, model load or inference is performed on the capture path.
export function localEmbedder(
  directory = fileURLToPath(new URL("../../models/", import.meta.url)),
): Embedder {
  async function load() {
    const { env, pipeline } = await import("@huggingface/transformers");
    env.allowRemoteModels = false;
    env.useFSCache = false;
    return pipeline("feature-extraction", join(resolve(directory), E5_MODEL), {
      local_files_only: true,
      dtype: "q8",
      device: "cpu",
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    });
  }
  let model: ReturnType<typeof load> | undefined;
  let retryAt = 0;
  const getModel = () => {
    if (Date.now() < retryAt)
      return Promise.reject(new Error("Local embedding model unavailable"));
    model ??= load().catch((error) => {
      model = undefined;
      retryAt = Date.now() + 60_000;
      console.error(
        JSON.stringify({
          event: "embeddings_unavailable",
          fallback: "lexical_and_stemmed",
        }),
      );
      throw error;
    });
    return model;
  };
  return {
    version: E5_VERSION,
    async load() {
      await getModel();
    },
    async embed(text, purpose) {
      const extractor = await getModel();
      const output = await extractor(e5Prefixed(purpose, text), {
        pooling: "mean",
        normalize: true,
      });
      if (output.data.length !== E5_DIMENSIONS)
        throw new Error("Unexpected embedding dimensions");
      return Float32Array.from(output.data as Float32Array);
    },
    async close() {
      if (model) await (await model).dispose();
    },
  };
}

// Small overlapping passages stay below E5's token window and fit source
// excerpts. Offsets are UTF-16 positions in the indexed text. For sources that
// is the original with a Cursor pull-request footer removed, and the original
// itself when there is no footer. Prose before and after the footer stays.
export function textChunks(text: string) {
  const chunks: { text: string; offset: number }[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 256, text.length);
    if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end] ?? "")) end--;
    chunks.push({ text: text.slice(start, end), offset: start });
    if (end === text.length) break;
    start = end - 64;
    if (/[\uDC00-\uDFFF]/u.test(text[start] ?? "")) start--;
  }
  return chunks;
}
