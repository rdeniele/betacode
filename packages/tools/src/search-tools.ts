import { findFiles, formatMatches, searchText } from "@betacode/filesystem";
import { z } from "@betacode/shared";
import type { AgentTool } from "./types";
import { guard, pluralize, truncate } from "./util";

const searchSchema = z.object({
  query: z.string().min(1).describe("Text to search for (or a regular expression when regex is true)."),
  path: z.string().optional().describe("Directory or file to search in, relative to the project root. Default: whole project."),
  regex: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts" or "src/**/*.tsx".'),
  maxResults: z.coerce.number().int().positive().max(500).optional(),
});

export const searchFiles: AgentTool<z.infer<typeof searchSchema>> = {
  name: "search_files",
  description: "Search file contents. Returns path:line:text for each match. Uses ripgrep when installed. Respects .gitignore and skips secrets files.",
  schema: searchSchema,
  kind: "search",
  readOnly: true,
  assess: (a) => ({ level: "safe", summary: `Search "${a.query}"${a.path ? ` in ${a.path}` : ""}` }),
  execute: (a, ctx) =>
    guard(async () => {
      const r = await searchText(ctx.files, { ...a, signal: ctx.signal });
      if (!r.matches.length) return { ok: true, content: `No matches for "${a.query}".` };
      const note = r.truncated ? `\n(results truncated at ${r.matches.length})` : "";
      return { ok: true, content: truncate(`${pluralize(r.matches.length, "match")}:\n${formatMatches(r.matches)}${note}`), data: r.matches };
    }),
};

const findSchema = z.object({
  pattern: z.string().min(1).describe('Glob (e.g. "**/*.test.ts", "*.json") or a filename fragment.'),
  path: z.string().optional(),
});

export const findFilesTool: AgentTool<z.infer<typeof findSchema>> = {
  name: "find_files",
  description: "Find files by name or glob pattern. Respects .gitignore.",
  schema: findSchema,
  kind: "search",
  readOnly: true,
  assess: (a) => ({ level: "safe", summary: `Find files "${a.pattern}"` }),
  execute: (a, ctx) =>
    guard(() => {
      const r = findFiles(ctx.files, a.pattern, { path: a.path });
      if (!r.files.length) return { ok: true, content: `No files match "${a.pattern}".` };
      return { ok: true, content: truncate(`${pluralize(r.files.length, "file")}:\n${r.files.join("\n")}${r.truncated ? "\n(truncated)" : ""}`), data: r.files };
    }),
};

const codeSchema = z.object({
  pattern: z.string().min(1).describe("Regular expression, e.g. 'function\\s+handleLogin' or 'class \\w+Service'."),
  path: z.string().optional(),
  glob: z.string().optional(),
  context: z.coerce.number().int().min(0).max(10).optional().describe("Lines of context around each match (default 2)."),
});

export const searchCode: AgentTool<z.infer<typeof codeSchema>> = {
  name: "search_code",
  description: "Regex search over source code with surrounding context lines. Use it to find definitions, usages and patterns.",
  schema: codeSchema,
  kind: "search",
  readOnly: true,
  assess: (a) => ({ level: "safe", summary: `Search code /${a.pattern}/` }),
  execute: (a, ctx) =>
    guard(async () => {
      const r = await searchText(ctx.files, { query: a.pattern, regex: true, path: a.path, glob: a.glob, context: a.context ?? 2, maxResults: 60, signal: ctx.signal });
      if (!r.matches.length) return { ok: true, content: `No matches for /${a.pattern}/.` };
      return { ok: true, content: truncate(`${pluralize(r.matches.length, "match")}:\n${formatMatches(r.matches)}${r.truncated ? "\n(results truncated)" : ""}`), data: r.matches };
    }),
};
