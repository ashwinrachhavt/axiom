import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // The shape is declared now so a test lands in the right place rather than
    // the root of the repo; see tests/README.md for what each one proves.
    include: ["tests/{unit,integration,contract,migration}/**/*.test.ts"],
    // All integration files share one test database, and reliability.test.ts
    // truncates every table in its beforeAll. Parallel files race that truncate
    // against concurrent seeds and fail with FK violations and deadlocks, so
    // files run one at a time (within a file, tests still parallelize where
    // independent).
    fileParallelism: false,
  },
});
