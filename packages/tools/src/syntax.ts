import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

/**
 * Fast, local syntax check of a file the agent just wrote. Returns a description of the problem, or undefined when
 * the file is fine or no checker is available. Never throws and never runs project code.
 */
export function syntaxCheck(absPath: string, content: string, projectRoot: string): string | undefined {
  const ext = extname(absPath).toLowerCase();
  try {
    if (ext === ".json") {
      JSON.parse(content);
      return undefined;
    }
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return nodeCheck(absPath);
    if (ext === ".ts" || ext === ".tsx" || ext === ".jsx" || ext === ".mts" || ext === ".cts") return tsCheck(absPath, content, projectRoot);
    if (ext === ".py") return pyCheck(content);
  } catch (e) {
    if (ext === ".json") return `Invalid JSON: ${(e as Error).message}`;
  }
  return undefined;
}

function nodeCheck(absPath: string): string | undefined {
  // The file is already on disk; checking it in place applies the project's module-type rules.
  const r = spawnSync(process.execPath, ["--check", absPath], { encoding: "utf8", timeout: 8000, windowsHide: true });
  if (r.status === 0 || r.error) return undefined;
  const msg = (r.stderr || "").split("\n").filter((l) => l && !l.startsWith("    at ") && !l.startsWith("Node.js v")).slice(0, 6).join("\n");
  return msg.trim() || "Syntax error";
}

function tsCheck(absPath: string, content: string, projectRoot: string): string | undefined {
  let ts: typeof import("typescript");
  try {
    ts = createRequire(join(projectRoot, "package.json"))("typescript");
  } catch {
    return undefined; // the project has no TypeScript installed
  }
  const out = ts.transpileModule(content, {
    fileName: absPath,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const errs = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error).slice(0, 5);
  if (!errs.length) return undefined;
  return errs
    .map((d) => {
      const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
      return `${pos ? `line ${pos.line + 1}, col ${pos.character + 1}: ` : ""}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    })
    .join("\n");
}

function pyCheck(content: string): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), "bc-syntax-"));
  try {
    const f = join(dir, "check.py");
    writeFileSync(f, content);
    for (const py of ["python", "python3"]) {
      const r = spawnSync(py, ["-m", "py_compile", f], { encoding: "utf8", timeout: 8000, windowsHide: true });
      if (r.error) continue;
      if (r.status === 0) return undefined;
      return (r.stderr || "Syntax error").split("\n").filter(Boolean).slice(-4).join("\n").replace(dir, "");
    }
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
