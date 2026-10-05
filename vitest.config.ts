import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve workspace packages from source so tests outside a package (tests/) can import them.
const alias = Object.fromEntries(
  readdirSync(fileURLToPath(new URL("./packages", import.meta.url))).map((p) => [`@betacode/${p}`, fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))]),
);

export default defineConfig({
  resolve: { alias },
  test: {
    include: ["packages/*/test/**/*.test.ts", "tests/**/*.test.ts", "apps/cli/test/**/*.test.ts"],
    testTimeout: 20000,
  },
});
