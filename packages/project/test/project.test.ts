import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProject, findInstructions, formatInstructions, formatProject } from "../src";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bc-detect-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const w = (f: string, c: string) => {
  mkdirSync(join(dir, f, ".."), { recursive: true });
  writeFileSync(join(dir, f), c);
};

describe("detectProject", () => {
  it("detects a Next.js + Prisma + Supabase + pnpm TypeScript app", () => {
    w("package.json", JSON.stringify({ name: "shop", dependencies: { next: "^15.1.0", react: "19.0.0", "@supabase/ssr": "1", "@supabase/supabase-js": "2", "@prisma/client": "6" }, devDependencies: { typescript: "5", vitest: "2", prisma: "6" }, scripts: { dev: "next dev", build: "next build", test: "vitest run", lint: "next lint" } }));
    w("pnpm-lock.yaml", "");
    w("tsconfig.json", "{}");
    w("prisma/schema.prisma", "");
    w("src/app/page.tsx", "");
    const p = detectProject(dir);
    expect(p.name).toBe("shop");
    expect(p.languages).toEqual(["TypeScript"]);
    expect(p.packageManager).toBe("pnpm");
    expect(p.frameworks).toEqual(expect.arrayContaining(["Next.js 15", "React 19"]));
    expect(p.orm).toEqual(["Prisma"]);
    expect(p.database).toContain("Supabase");
    expect(p.auth).toContain("Supabase Auth");
    expect(p.testFrameworks).toContain("Vitest");
    expect(p.entryPoints).toContain("src/app/page.tsx");
    expect(Object.fromEntries(p.commands.map((c) => [c.name, c.command]))).toMatchObject({ dev: "pnpm run dev", build: "pnpm run build", test: "pnpm test", lint: "pnpm run lint", install: "pnpm install" });
    const text = formatProject(p);
    expect(text).toContain("Package manager: pnpm");
    expect(text).toContain("test: pnpm test");
  });

  it("detects Express with npm and plain JavaScript", () => {
    w("package.json", JSON.stringify({ name: "api", dependencies: { express: "^4.19.0" }, scripts: { test: "node --test", start: "node server.js" } }));
    w("package-lock.json", "{}");
    w("server.js", "");
    const p = detectProject(dir);
    expect(p.languages).toEqual(["JavaScript"]);
    expect(p.packageManager).toBe("npm");
    expect(p.frameworks).toContain("Express 4");
    expect(p.entryPoints).toContain("server.js");
  });

  it("detects Python frameworks", () => {
    w("requirements.txt", "fastapi==0.110\npytest\nsqlalchemy\n");
    w("main.py", "");
    const p = detectProject(dir);
    expect(p.languages).toContain("Python");
    expect(p.frameworks).toContain("FastAPI");
    expect(p.orm).toContain("SQLAlchemy");
    expect(p.commands.find((c) => c.name === "test")?.command).toBe("pytest");
  });

  it("detects Rust, Go, PHP/Laravel and Ruby/Rails", () => {
    w("Cargo.toml", '[dependencies]\naxum = "0.7"');
    expect(detectProject(dir).frameworks).toContain("Axum");
    w("go.mod", "module x\nrequire github.com/gin-gonic/gin v1");
    expect(detectProject(dir).languages).toEqual(expect.arrayContaining(["Rust", "Go"]));
    w("composer.json", '{"require":{"laravel/framework":"11"}}');
    w("Gemfile", "gem 'rails'");
    const p = detectProject(dir);
    expect(p.frameworks).toEqual(expect.arrayContaining(["Gin", "Laravel", "Rails"]));
  });

  it("copes with an empty directory and invalid package.json", () => {
    expect(detectProject(dir).languages).toEqual([]);
    w("package.json", "{ nope");
    expect(detectProject(dir).languages).toEqual(["JavaScript"]);
  });
});

describe("BETACODE.md discovery", () => {
  it("loads root, subdirectory, parent and user instructions, skipping ignored dirs", () => {
    const home = mkdtempSync(join(tmpdir(), "bc-uh-"));
    mkdirSync(join(home, ".betacode"));
    writeFileSync(join(home, ".betacode/BETACODE.md"), "USER RULE");
    const parent = dir;
    const root = join(parent, "repo");
    mkdirSync(join(root, "node_modules/x"), { recursive: true });
    mkdirSync(join(root, "packages/api"), { recursive: true });
    writeFileSync(join(parent, "BETACODE.md"), "PARENT RULE");
    writeFileSync(join(root, "BETACODE.md"), "ROOT RULE");
    writeFileSync(join(root, "packages/api/BETACODE.md"), "API RULE");
    writeFileSync(join(root, "node_modules/x/BETACODE.md"), "IGNORED");
    const files = findInstructions(root, { home });
    expect(files.map((f) => f.source)).toEqual(["user", "parent", "root", "subdirectory"]);
    const text = formatInstructions(files);
    expect(text).toContain("ROOT RULE");
    expect(text).toContain("API RULE");
    expect(text).not.toContain("IGNORED");
    rmSync(home, { recursive: true, force: true });
  });

  it("returns nothing when there are no instruction files", () => {
    expect(findInstructions(dir)).toEqual([]);
  });
});
