import type { Config } from "../../src/config.js";
import { startService } from "../../src/server.js";

// Non-search integration suites exercise model failure without loading weights.
export function startTestService(config: Config) {
  return startService(config, {
    version: "synthetic-unavailable",
    async embed() {
      throw new Error("Synthetic unavailable model");
    },
  });
}
