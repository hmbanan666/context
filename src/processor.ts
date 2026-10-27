import { z } from "zod";
import {
  type JobStore,
  PROCESSOR_VERSION,
  type ProcessingFailure,
  type ProcessingJob,
  ProcessingLeaseLost,
  type ProcessingOutput,
  ProcessingValidationError,
  processingOutputSchema,
} from "./jobs.js";
import type { KnowledgeStore } from "./knowledge.js";
import type { Source, SourceStore } from "./store.js";

export type Extractor = (input: {
  source: Source;
  processorVersion: string;
}) => Promise<ProcessingOutput>;

export class ModelUnavailableError extends Error {}

function failureReason(error: unknown): ProcessingFailure {
  if (error instanceof ModelUnavailableError) return "model_unavailable";
  if (
    error instanceof z.ZodError ||
    error instanceof ProcessingValidationError
  ) {
    return "invalid_output";
  }
  return "processing_failed";
}

// Each call handles one eligible job. Durable output precedes every derived write.
export async function processNext(
  sources: SourceStore,
  knowledge: KnowledgeStore,
  jobs: JobStore,
  scope: string,
  extractor: Extractor,
): Promise<ProcessingJob | undefined> {
  const claimed = jobs.claim(scope);
  if (!claimed) return undefined;
  const { job, leaseToken } = claimed;
  try {
    const source = sources.find(job.sourceId, scope);
    if (!source) throw new Error("processing_failed");
    const output = processingOutputSchema.parse(
      job.output ??
        (await extractor({ source, processorVersion: PROCESSOR_VERSION })),
    );
    jobs.saveOutput(job.id, scope, leaseToken, output);
    const ids = output.items.map((item, index) => {
      const saved = knowledge.add({
        version: 1,
        scope,
        idempotencyKey: `processing:${job.id}:${index}`,
        kind: item.kind,
        text: item.text,
        sourceRefs: [{ sourceId: source.id, quote: item.quote }],
        creator: {
          kind: "model",
          name: "context-memory-processor",
          version: PROCESSOR_VERSION,
        },
      });
      return saved.item.id;
    });
    return jobs.complete(job.id, scope, leaseToken, ids);
  } catch (error) {
    if (error instanceof ProcessingLeaseLost) return jobs.find(job.id, scope);
    try {
      return jobs.fail(job.id, scope, leaseToken, failureReason(error));
    } catch (failure) {
      if (failure instanceof ProcessingLeaseLost)
        return jobs.find(job.id, scope);
      // Storage errors must not expose source content or model output to an operator.
      throw new Error("processing_failed");
    }
  }
}
