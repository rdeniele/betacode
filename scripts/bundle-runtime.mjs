// Packages the Node runtime for the desktop installer:
//   apps/desktop/src-tauri/runtime/server.mjs            single-file bundle of packages/server
//   apps/desktop/src-tauri/runtime/node_modules/...      Prisma client + native query engine (cannot be bundled)
//   apps/desktop/src-tauri/binaries/node-<triple>.exe    the Node binary, started by the Tauri shell
import { build } from "esbuild";
import { mkdirSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauri = join(root, "apps/desktop/src-tauri");
const out = join(tauri, "runtime");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, "packages/server/src/main.ts")],
  outfile: join(out, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Some bundled CommonJS dependencies call require().
  banner: {
    js: [
      "import { createRequire as __cr } from \"node:module\";",
      "import { fileURLToPath as __fu } from \"node:url\";",
      "import { dirname as __dn, join as __jn } from \"node:path\";",
      "const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);",
      // Prisma finds its native query engine through this variable; the engine ships next to server.mjs.
      "process.env.PRISMA_QUERY_ENGINE_LIBRARY ??= __jn(__dirname, \"engine\", \"query_engine.node\");",
    ].join("\n"),
  },
  logLevel: "info",
  alias: Object.fromEntries(readdirSync(join(root, "packages")).map((p) => [`@betacode/${p}`, join(root, "packages", p, "src/index.ts")])),
});

// Prisma: the JS is bundled into server.mjs; only the native query engine has to ship as a file.
const store = join(root, "node_modules/.pnpm");
const clientDir = readdirSync(store).find((d) => d.startsWith("@prisma+client@"));
if (!clientDir) throw new Error("Prisma client not installed; run pnpm install && pnpm db:generate");
const gen = join(store, clientDir, "node_modules/.prisma/client");
const engine = readdirSync(gen).find((f) => /^query_engine.*\.node$/.test(f));
if (!engine) throw new Error("Generated Prisma client / native engine missing; run pnpm db:generate");
mkdirSync(join(out, "engine"), { recursive: true });
copyFileSync(join(gen, engine), join(out, "engine", "query_engine.node"));

// Node binary used as the sidecar.
const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)?.[1];
if (!triple) throw new Error("Could not determine the Rust target triple");
mkdirSync(join(tauri, "binaries"), { recursive: true });
const ext = process.platform === "win32" ? ".exe" : "";
copyFileSync(process.execPath, join(tauri, "binaries", `node-${triple}${ext}`));
console.log(`runtime bundled → ${out}\nnode sidecar → binaries/node-${triple}${ext}`);
