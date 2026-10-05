import { runCommandTool } from "./command-tool";
import { copyFile, createDirectory, deleteFile, editFile, listDirectory, moveFile, readFile, writeFile } from "./fs-tools";
import { gitAdd, gitBranch, gitCheckout, gitCommit, gitDiff, gitLog, gitPull, gitPush, gitStatus } from "./git-tools";
import { delegateTask, getDiagnostics, updatePlan } from "./meta-tools";
import { ToolRegistry } from "./registry";
import { findFilesTool, searchCode, searchFiles } from "./search-tools";

export * from "./types";
export * from "./registry";
export * from "./util";
export { parseTscOutput } from "./meta-tools";

/** Registry with every built-in tool. */
export function createDefaultRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of [
    listDirectory, readFile, writeFile, editFile, deleteFile, moveFile, copyFile, createDirectory,
    searchFiles, findFilesTool, searchCode,
    runCommandTool,
    gitStatus, gitDiff, gitLog, gitBranch, gitCheckout, gitAdd, gitCommit, gitPush, gitPull,
    getDiagnostics, updatePlan, delegateTask,
  ]) {
    r.register(t);
  }
  return r;
}
