import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ProjectCommand {
  name: "install" | "dev" | "build" | "test" | "lint" | "typecheck" | "start";
  command: string;
}

export interface ProjectInfo {
  name: string;
  root: string;
  languages: string[];
  frameworks: string[];
  packageManager?: string;
  database: string[];
  orm: string[];
  auth: string[];
  testFrameworks: string[];
  commands: ProjectCommand[];
  detectedFiles: string[];
  entryPoints: string[];
  importantDirs: string[];
  isGitRepo: boolean;
  readmeExcerpt?: string;
}

const MARKER_FILES = [
  "package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "requirements.txt", "pyproject.toml",
  "Pipfile", "Cargo.toml", "go.mod", "composer.json", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts", "docker-compose.yml",
  "docker-compose.yaml", "Dockerfile", "tsconfig.json", "CMakeLists.txt", "Makefile", "app.json", "BETACODE.md",
];

const ENTRY_CANDIDATES = [
  "src/index.ts", "src/main.ts", "src/index.tsx", "src/main.tsx", "src/index.js", "src/app/page.tsx", "app/page.tsx", "src/pages/index.tsx",
  "pages/index.tsx", "pages/index.js", "index.js", "index.ts", "server.js", "server.ts", "app.py", "main.py", "manage.py", "src/main.rs",
  "src/lib.rs", "main.go", "cmd/main.go", "artisan", "config/routes.rb", "App.tsx", "App.js",
];

const DIR_CANDIDATES = ["src", "app", "pages", "components", "lib", "api", "routes", "server", "prisma", "migrations", "tests", "test", "__tests__", "public", "docs", "scripts", "packages", "apps", "cmd", "internal"];

function readText(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

function add(list: string[], v: string): void {
  if (!list.includes(v)) list.push(v);
}

/** Inspect a directory and describe the project. Pure filesystem reads; never executes anything. */
export function detectProject(root: string): ProjectInfo {
  const has = (f: string) => existsSync(join(root, f));
  const info: ProjectInfo = {
    name: root.split(/[\\/]/).filter(Boolean).pop() ?? "project",
    root,
    languages: [],
    frameworks: [],
    database: [],
    orm: [],
    auth: [],
    testFrameworks: [],
    commands: [],
    detectedFiles: MARKER_FILES.filter(has),
    entryPoints: ENTRY_CANDIDATES.filter(has).slice(0, 6),
    importantDirs: DIR_CANDIDATES.filter((d) => {
      try {
        return statSync(join(root, d)).isDirectory();
      } catch {
        return false;
      }
    }),
    isGitRepo: has(".git"),
  };

  const pkgText = readText(join(root, "package.json"));
  if (pkgText) detectNode(root, pkgText, info, has);

  const pyproject = readText(join(root, "pyproject.toml")) ?? "";
  const requirements = readText(join(root, "requirements.txt")) ?? "";
  const pipfile = readText(join(root, "Pipfile")) ?? "";
  if (pyproject || requirements || pipfile || has("manage.py")) {
    add(info.languages, "Python");
    const text = `${pyproject}\n${requirements}\n${pipfile}`.toLowerCase();
    if (/\bdjango\b/.test(text) || has("manage.py")) add(info.frameworks, "Django");
    if (/\bfastapi\b/.test(text)) add(info.frameworks, "FastAPI");
    if (/\bflask\b/.test(text)) add(info.frameworks, "Flask");
    if (/\bsqlalchemy\b/.test(text)) add(info.orm, "SQLAlchemy");
    if (/\bpytest\b/.test(text) || has("pytest.ini") || has("tests")) {
      add(info.testFrameworks, "pytest");
      info.commands.push({ name: "test", command: "pytest" });
    }
    info.packageManager ??= pyproject.includes("[tool.poetry]") ? "poetry" : pipfile ? "pipenv" : pyproject.includes("[tool.uv") ? "uv" : "pip";
  }

  const cargo = readText(join(root, "Cargo.toml"));
  if (cargo) {
    add(info.languages, "Rust");
    info.packageManager ??= "cargo";
    if (/\btauri\b/.test(cargo)) add(info.frameworks, "Tauri");
    if (/\baxum\b/.test(cargo)) add(info.frameworks, "Axum");
    if (/actix-web/.test(cargo)) add(info.frameworks, "Actix");
    info.commands.push({ name: "build", command: "cargo build" }, { name: "test", command: "cargo test" });
  }

  const gomod = readText(join(root, "go.mod"));
  if (gomod) {
    add(info.languages, "Go");
    info.packageManager ??= "go modules";
    if (/gin-gonic\/gin/.test(gomod)) add(info.frameworks, "Gin");
    if (/labstack\/echo/.test(gomod)) add(info.frameworks, "Echo");
    info.commands.push({ name: "build", command: "go build ./..." }, { name: "test", command: "go test ./..." });
  }

  const composer = readText(join(root, "composer.json"));
  if (composer) {
    add(info.languages, "PHP");
    info.packageManager ??= "composer";
    if (/laravel\/framework/.test(composer)) {
      add(info.frameworks, "Laravel");
      info.commands.push({ name: "test", command: "php artisan test" });
    }
  }

  const gemfile = readText(join(root, "Gemfile"));
  if (gemfile) {
    add(info.languages, "Ruby");
    info.packageManager ??= "bundler";
    if (/\brails\b/.test(gemfile)) add(info.frameworks, "Rails");
  }

  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) {
    const gradle = (readText(join(root, "build.gradle.kts")) ?? "") + (readText(join(root, "build.gradle")) ?? "");
    add(info.languages, /kotlin/i.test(gradle) ? "Kotlin" : "Java");
    info.packageManager ??= has("pom.xml") ? "maven" : "gradle";
    if (/spring/i.test(gradle + (readText(join(root, "pom.xml")) ?? ""))) add(info.frameworks, "Spring");
    info.commands.push(has("pom.xml") ? { name: "test", command: "mvn test" } : { name: "test", command: "gradle test" });
  }

  try {
    const names = readdirSync(root);
    if (names.some((n) => n.endsWith(".csproj") || n.endsWith(".sln"))) {
      add(info.languages, "C#");
      info.packageManager ??= "dotnet";
      info.commands.push({ name: "build", command: "dotnet build" }, { name: "test", command: "dotnet test" });
    }
  } catch {
    /* unreadable root */
  }
  if (has("CMakeLists.txt") || has("Makefile")) add(info.languages, "C/C++");

  if (has("prisma/schema.prisma")) add(info.orm, "Prisma");
  if (has("docker-compose.yml") || has("docker-compose.yaml") || has("Dockerfile")) add(info.frameworks, "Docker");

  const readme = readText(join(root, "README.md")) ?? readText(join(root, "readme.md"));
  if (readme) info.readmeExcerpt = readme.replace(/\r/g, "").slice(0, 1200);

  // De-duplicate commands, keep first.
  const seen = new Set<string>();
  info.commands = info.commands.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
  return info;
}

function detectNode(root: string, pkgText: string, info: ProjectInfo, has: (f: string) => boolean): void {
  let pkg: any;
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    add(info.languages, "JavaScript");
    return;
  }
  if (typeof pkg.name === "string") info.name = pkg.name;
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
  const dep = (n: string) => n in deps;
  const ver = (n: string) => String(deps[n] ?? "").replace(/^[\^~>=<\s]+/, "");

  add(info.languages, has("tsconfig.json") || dep("typescript") ? "TypeScript" : "JavaScript");

  // Package manager
  const pmField = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  info.packageManager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : has("package-lock.json") ? "npm" : (pmField ?? "npm");

  const fw: Array<[string, string, string?]> = [
    ["next", "Next.js"], ["react-native", "React Native"], ["expo", "Expo"], ["react", "React"], ["vue", "Vue"], ["nuxt", "Nuxt"],
    ["@sveltejs/kit", "SvelteKit"], ["svelte", "Svelte"], ["@angular/core", "Angular"], ["express", "Express"], ["@nestjs/core", "NestJS"],
    ["fastify", "Fastify"], ["hono", "Hono"], ["vite", "Vite"], ["electron", "Electron"], ["@tauri-apps/api", "Tauri"], ["@remix-run/react", "Remix"],
    ["astro", "Astro"], ["tailwindcss", "Tailwind CSS"],
  ];
  for (const [d, label] of fw) if (dep(d)) add(info.frameworks, dep(d) && ver(d) && ["next", "react", "vue", "nuxt", "express"].includes(d) ? `${label} ${ver(d).split(".")[0]}` : label);

  for (const [d, label] of [["prisma", "Prisma"], ["@prisma/client", "Prisma"], ["drizzle-orm", "Drizzle"], ["typeorm", "TypeORM"], ["sequelize", "Sequelize"], ["mongoose", "Mongoose"], ["knex", "Knex"]] as const) {
    if (dep(d)) add(info.orm, label);
  }
  for (const [d, label] of [["@supabase/supabase-js", "Supabase"], ["pg", "PostgreSQL"], ["mysql2", "MySQL"], ["mongodb", "MongoDB"], ["better-sqlite3", "SQLite"], ["sqlite3", "SQLite"], ["firebase", "Firebase"], ["redis", "Redis"]] as const) {
    if (dep(d)) add(info.database, label);
  }
  for (const [d, label] of [["next-auth", "NextAuth"], ["@supabase/ssr", "Supabase Auth"], ["@clerk/nextjs", "Clerk"], ["passport", "Passport"], ["lucia", "Lucia"], ["better-auth", "Better Auth"], ["@auth/core", "Auth.js"]] as const) {
    if (dep(d)) add(info.auth, label);
  }
  for (const [d, label] of [["vitest", "Vitest"], ["jest", "Jest"], ["mocha", "Mocha"], ["@playwright/test", "Playwright"], ["cypress", "Cypress"]] as const) {
    if (dep(d)) add(info.testFrameworks, label);
  }

  const pm = info.packageManager;
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const run = (s: string) => (s === "test" || s === "start" ? `${pm} ${s}` : `${pm} run ${s}`);
  info.commands.push({ name: "install", command: `${pm} install` });
  const pick: Array<[ProjectCommand["name"], string[]]> = [
    ["dev", ["dev", "develop", "serve"]], ["build", ["build"]], ["test", ["test"]], ["lint", ["lint"]],
    ["typecheck", ["typecheck", "type-check", "tsc", "check"]], ["start", ["start"]],
  ];
  for (const [name, candidates] of pick) {
    const s = candidates.find((c) => scripts[c]);
    if (s) info.commands.push({ name, command: run(s) });
  }
}

export function formatProject(info: ProjectInfo): string {
  const lines: string[] = [`Name: ${info.name}`];
  const row = (label: string, v: string[] | string | undefined) => {
    if (Array.isArray(v) ? v.length : v) lines.push(`${label}: ${Array.isArray(v) ? v.join(", ") : v}`);
  };
  row("Languages", info.languages);
  row("Frameworks", info.frameworks);
  row("Package manager", info.packageManager);
  row("Database", info.database);
  row("ORM", info.orm);
  row("Authentication", info.auth);
  row("Test frameworks", info.testFrameworks);
  row("Entry points", info.entryPoints);
  row("Important directories", info.importantDirs);
  row("Config files", info.detectedFiles);
  lines.push(`Git repository: ${info.isGitRepo ? "yes" : "no"}`);
  if (info.commands.length) lines.push("Detected commands:", ...info.commands.map((c) => `  ${c.name}: ${c.command}`));
  return lines.join("\n");
}
