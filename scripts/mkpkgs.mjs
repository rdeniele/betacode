import { writeFileSync } from "node:fs";
const ws = (...n) => Object.fromEntries(n.map((x) => [`@betacode/${x}`, "workspace:*"]));
const pk = {
  shared: { zod: "^4.0.0" },
  ai: { ...ws("shared"), zod: "^4.0.0" },
  filesystem: { ...ws("shared"), diff: "^7.0.0", ignore: "^6.0.0" },
  terminal: { ...ws("shared") },
  git: { ...ws("shared") },
  config: { ...ws("shared"), zod: "^4.0.0" },
  prompts: { ...ws("shared") },
  project: { ...ws("shared", "filesystem") },
  tools: { ...ws("shared", "filesystem", "terminal", "git", "project"), zod: "^4.0.0" },
  agent: { ...ws("shared", "ai", "tools", "prompts", "filesystem", "terminal"), zod: "^4.0.0" },
  database: { ...ws("shared"), "@prisma/client": "^6.0.0" },
  server: { ...ws("shared", "ai", "agent", "tools", "filesystem", "terminal", "git", "project", "config", "database", "prompts"), zod: "^4.0.0" },
};
for (const [name, deps] of Object.entries(pk)) {
  const json = { name: `@betacode/${name}`, version: "0.1.0", private: true, type: "module", main: "src/index.ts", types: "src/index.ts", exports: { ".": "./src/index.ts" }, dependencies: deps };
  if (name === "database") json.scripts = { generate: "prisma generate --schema ../../prisma/schema.prisma" };
  if (name === "server") json.scripts = { start: "tsx src/main.ts", dev: "tsx watch src/main.ts" };
  writeFileSync(`packages/${name}/package.json`, JSON.stringify(json, null, 2) + "\n");
}
writeFileSync("apps/cli/package.json", JSON.stringify({
  name: "@betacode/cli", version: "0.1.0", private: true, type: "module",
  bin: { betacode: "bin/betacode.mjs" },
  scripts: { start: "tsx src/main.ts" },
  dependencies: { ...ws("shared","ai","agent","tools","filesystem","terminal","git","project","config","database","prompts","server"), zod: "^4.0.0" },
}, null, 2) + "\n");
