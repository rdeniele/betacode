import { renderTree, isSensitivePath, unifiedDiff } from "@betacode/filesystem";
import { syntaxCheck } from "./syntax";
import { z } from "@betacode/shared";
import type { AgentTool } from "./types";
import { guard, pluralize, truncate } from "./util";
import type { ToolContext } from "./types";

/** Appended to write/edit results so the model learns immediately that a file it wrote does not parse. */
function syntaxNote(ctx: ToolContext, rel: string, content: string): string {
  const problem = syntaxCheck(ctx.workspace.resolve(rel), content, ctx.workspace.root);
  return problem ? `
⚠ Syntax check FAILED for ${rel} — fix this before anything else:
${problem}` : "";
}

const num = z.coerce.number().int().positive();

const listDirectorySchema = z.object({
  path: z.string().default(".").describe("Directory to list, relative to the project root."),
  depth: num.max(6).optional().describe("How many levels to expand (default 2)."),
});

export const listDirectory: AgentTool<z.infer<typeof listDirectorySchema>> = {
  name: "list_directory",
  description: "List a directory as a tree (default depth 2). Respects .gitignore and skips node_modules and build output. Use it to learn the layout of a folder before reading or editing inside it.",
  schema: listDirectorySchema,
  kind: "read",
  readOnly: true,
  assess: (a) => ({ level: "safe", summary: `List ${a.path}` }),
  execute: (a, ctx) =>
    guard(() => {
      const tree = ctx.files.list(a.path, { depth: a.depth ?? 2 });
      const text = renderTree(tree);
      return { ok: true, content: text ? truncate(text) : "(empty directory)", data: tree };
    }),
};

const readFileSchema = z.object({
  path: z.string().describe("File path relative to the project root."),
  offset: num.optional().describe("1-based line to start reading from."),
  limit: num.optional().describe("Maximum number of lines to return (default 2000)."),
});

export const readFile: AgentTool<z.infer<typeof readFileSchema>> = {
  name: "read_file",
  description: "Read a text file. Returns line-numbered contents, total lines, size and language. ALWAYS read a file before editing it. For large files read the relevant part with offset and limit (find it first with search_code). Several independent reads can be requested in one turn. Line numbers are not part of the file; do not include them when editing.",
  schema: readFileSchema,
  kind: "read",
  readOnly: true,
  assess: (a) =>
    isSensitivePath(a.path)
      ? { level: "dangerous", summary: `Read secrets file ${a.path}`, reason: "This file may contain credentials or secrets." }
      : { level: "safe", summary: `Read ${a.path}` },
  execute: (a, ctx) =>
    guard(() => {
      const r = ctx.files.read(a.path, { offset: a.offset, limit: a.limit, allowSensitive: isSensitivePath(a.path) });
      const header = `${r.path} (${r.language}, ${r.size} bytes, lines ${r.startLine}-${r.endLine} of ${r.totalLines}${r.truncated ? ", truncated: use offset to read more" : ""})`;
      return { ok: true, content: truncate(`${header}\n${r.numbered}`), data: { path: r.path, language: r.language, size: r.size, totalLines: r.totalLines } };
    }),
};

const writeFileSchema = z.object({
  path: z.string().describe("File path relative to the project root. Parent directories are created."),
  content: z.string().describe("Complete new file contents."),
});

export const writeFile: AgentTool<z.infer<typeof writeFileSchema>> = {
  name: "write_file",
  description: "Create a NEW file, or completely replace an existing one that you have already read. For changing part of an existing file use edit_file. Parent folders are created automatically. Write the complete file content; never use placeholders like '...rest of file'.",
  schema: writeFileSchema,
  kind: "edit",
  readOnly: false,
  assess: (a, ctx) => {
    try {
      const abs = ctx.workspace.resolve(a.path);
      const rel = ctx.workspace.rel(abs);
      const before = ctx.files.exists(a.path) ? ctx.files.readText(a.path) : null;
      return { level: "confirm", summary: `${before === null ? "Create" : "Overwrite"} ${rel}`, detail: unifiedDiff(rel, before, a.content), grantKey: "write_file" };
    } catch {
      // Invalid path: execution will fail without changing anything.
      return { level: "safe", summary: `Write ${a.path}` };
    }
  },
  execute: (a, ctx) =>
    guard(() => {
      const r = ctx.files.write(a.path, a.content);
      return { ok: true, content: `${r.kind === "added" ? "Created" : "Updated"} ${r.path} (${r.bytes} bytes).\n${truncate(r.diff, 6000)}${syntaxNote(ctx, r.path, a.content)}`, data: r };
    }),
};

const editFileSchema = z.object({
  path: z.string().describe("File path relative to the project root."),
  oldText: z.string().describe("Exact text to replace, including whitespace. Must match exactly once unless replaceAll is true."),
  newText: z.string().describe("Replacement text."),
  replaceAll: z.boolean().optional().describe("Replace every occurrence."),
});

export const editFile: AgentTool<z.infer<typeof editFileSchema>> = {
  name: "edit_file",
  description: "Change part of an existing file by replacing exact text. You must have read the file with read_file first. oldText must be copied from what you read and must identify exactly one place: include a few surrounding lines (including the line before or after) so it is unique, or set replaceAll to replace every occurrence. Keep oldText as small as is still unique. Example: path 'src/app.ts', oldText 'const port = 3000;', newText 'const port = Number(process.env.PORT ?? 3000);'. If it fails, re-read the file and copy the text again; do not resend the same oldText.",
  schema: editFileSchema,
  kind: "edit",
  readOnly: false,
  assess: (a, ctx) => {
    try {
      const p = ctx.files.planEdit(a.path, a.oldText, a.newText, a.replaceAll);
      return { level: "confirm", summary: `Edit ${p.rel}`, detail: unifiedDiff(p.rel, p.before, p.after), grantKey: "edit_file" };
    } catch {
      // The edit cannot be applied; execution will report why and change nothing.
      return { level: "safe", summary: `Edit ${a.path}` };
    }
  },
  execute: (a, ctx) =>
    guard(() => {
      const r = ctx.files.edit(a.path, a.oldText, a.newText, a.replaceAll);
      const fuzz = r.fuzzy ? " Your oldText matched only after ignoring indentation; the replacement was re-indented to fit." : "";
      return { ok: true, content: `Edited ${r.path} (${pluralize(r.replacements, "replacement")}).${fuzz}\n${truncate(r.diff, 6000)}${syntaxNote(ctx, r.path, ctx.files.readText(r.path))}`, data: r };
    }),
};

const deleteFileSchema = z.object({
  path: z.string(),
  recursive: z.boolean().optional().describe("Required to delete a directory."),
});

export const deleteFile: AgentTool<z.infer<typeof deleteFileSchema>> = {
  name: "delete_file",
  description: "Delete a file (or a directory with recursive: true). Always requires user approval.",
  schema: deleteFileSchema,
  kind: "edit",
  readOnly: false,
  assess: (a) => ({ level: "dangerous", summary: `Delete ${a.path}${a.recursive ? " (recursively)" : ""}`, reason: "Deletes files from the project." }),
  execute: (a, ctx) =>
    guard(() => {
      const r = ctx.files.delete(a.path, { recursive: a.recursive });
      return { ok: true, content: `Deleted ${r.path} (${pluralize(r.deleted, "file")}). The original content is kept in the change history and can be reverted.` };
    }),
};

const moveSchema = z.object({ from: z.string(), to: z.string() });

export const moveFile: AgentTool<z.infer<typeof moveSchema>> = {
  name: "move_file",
  description: "Move or rename a file. Fails if the destination exists.",
  schema: moveSchema,
  kind: "edit",
  readOnly: false,
  assess: (a) => ({ level: "confirm", summary: `Move ${a.from} → ${a.to}`, grantKey: "move_file" }),
  execute: (a, ctx) =>
    guard(() => {
      const r = ctx.files.move(a.from, a.to);
      return { ok: true, content: `Moved ${r.from} → ${r.to}.` };
    }),
};

export const copyFile: AgentTool<z.infer<typeof moveSchema>> = {
  name: "copy_file",
  description: "Copy a file. Fails if the destination exists.",
  schema: moveSchema,
  kind: "edit",
  readOnly: false,
  assess: (a) => ({ level: "confirm", summary: `Copy ${a.from} → ${a.to}`, grantKey: "copy_file" }),
  execute: (a, ctx) =>
    guard(() => {
      const r = ctx.files.copy(a.from, a.to);
      return { ok: true, content: `Copied ${r.from} → ${r.to}.` };
    }),
};

const mkdirSchema = z.object({ path: z.string() });

export const createDirectory: AgentTool<z.infer<typeof mkdirSchema>> = {
  name: "create_directory",
  description: "Create a directory (and parents).",
  schema: mkdirSchema,
  kind: "edit",
  readOnly: false,
  assess: (a) => ({ level: "confirm", summary: `Create directory ${a.path}`, grantKey: "create_directory" }),
  execute: (a, ctx) =>
    guard(() => {
      const r = ctx.files.mkdir(a.path);
      return { ok: true, content: `Created directory ${r.path}.` };
    }),
};
