import type { PermissionLevel } from "@betacode/shared";

export interface CommandRisk {
  level: PermissionLevel;
  reason: string;
}

const RANK: Record<PermissionLevel, number> = { safe: 0, confirm: 1, dangerous: 2 };

/** Strip quoted strings so operators/keywords inside quotes do not confuse the checks. */
function stripQuotes(s: string): string {
  return s.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
}

/** Split a command line into simple commands on `&&`, `||`, `;`, `|`, `&` and newlines. */
export function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      cur += c;
      if (c === quote && cmd[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "&" || c === "|" || c === ";" || c === "\n") {
      if ((c === "&" || c === "|") && cmd[i + 1] === c) i++;
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  return tokens;
}

function baseName(cmd: string): string {
  return (cmd.split(/[\\/]/).pop() ?? cmd).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

const SAFE_SIMPLE = new Set([
  "ls", "dir", "pwd", "cd", "cat", "type", "head", "tail", "wc", "echo", "grep", "rg", "tree", "which", "where", "whoami",
  "date", "sort", "uniq", "diff", "stat", "file", "du", "df", "basename", "dirname", "realpath", "true", "false", "sleep",
  "hostname", "uname", "cut", "tr", "less", "more", "jq", "findstr", "get-childitem", "get-content", "select-string",
]);

const SAFE_GIT = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "ls-tree", "cat-file", "diff-tree", "rev-list", "reflog"]);

const JS_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SAFE_JS_SCRIPTS = /^(test|tests|test:.*|lint|lint:.*|typecheck|type-check|check|check:.*|tsc)$/;

function dangerousReason(seg: string, tokens: string[], cmd: string): string | undefined {
  const args = tokens.slice(1);
  const lower = args.map((a) => a.toLowerCase());
  const has = (re: RegExp) => lower.some((a) => re.test(a));

  if (["sudo", "su", "doas", "runas", "pkexec"].includes(cmd)) return "runs with elevated privileges";
  if (cmd === "rm" && (has(/^-[a-z]*[rf]/) || has(/^--(recursive|force)$/))) return "recursively/forcibly deletes files";
  if (["rmdir", "rd"].includes(cmd) && has(/^\/s$/)) return "recursively deletes a directory";
  if (["del", "erase"].includes(cmd) && has(/^\/[sfq]$/)) return "deletes files";
  if (cmd === "remove-item" && (has(/^-recurse$/) || has(/^-force$/))) return "recursively/forcibly deletes files";
  if (["format", "mkfs", "fdisk", "diskpart", "shred", "dd", "parted", "wipefs"].includes(cmd) || cmd.startsWith("mkfs.")) return "performs disk-level operations";
  if (["chmod", "chown", "chgrp", "icacls", "takeown", "attrib"].includes(cmd)) return "changes file permissions or ownership";
  if (["shutdown", "reboot", "halt", "poweroff", "init"].includes(cmd)) return "shuts down or restarts the machine";
  if (["killall", "pkill", "taskkill"].includes(cmd)) return "terminates processes";
  if (cmd === "git") {
    const sub = lower.find((a) => !a.startsWith("-"));
    if (sub === "push") return "pushes to a remote repository";
    if (sub === "reset" && has(/^--hard$/)) return "discards uncommitted work (git reset --hard)";
    if (sub === "clean" && has(/^-[a-z]*f|^--force$/)) return "deletes untracked files (git clean)";
    if (sub === "checkout" && (lower.includes("--") || lower.includes("."))) return "discards working-tree changes";
    if (sub === "restore" && !has(/^--staged$/)) return "discards working-tree changes";
    if (sub === "branch" && args.some((x) => x === "-D" || x === "-d" || x === "--delete")) return "deletes a branch";
    if (sub === "filter-branch" || sub === "filter-repo") return "rewrites repository history";
    if (sub === "stash" && (lower.includes("drop") || lower.includes("clear"))) return "drops stashed work";
  }
  if (cmd === "docker" && (lower.includes("prune") || (lower.includes("rm") && has(/^-f$/)) || (lower.includes("rmi") && has(/^-f$/)))) return "removes docker resources";
  if (cmd === "kubectl" && lower.includes("delete")) return "deletes cluster resources";
  if (/\b(drop\s+(table|database|schema|index)|truncate\s+table|delete\s+from)\b/i.test(seg)) return "contains a destructive SQL statement";
  if (["dropdb", "dropuser"].includes(cmd)) return "drops a database";
  if (/\bprisma\b/i.test(seg) && /(migrate\s+reset|--force-reset|db\s+push.*--accept-data-loss)/i.test(seg)) return "resets or destroys database data";
  if (["vercel", "netlify", "firebase", "fly", "flyctl", "heroku", "wrangler", "serverless", "sls", "railway"].includes(cmd) && (lower.includes("deploy") || has(/^--prod/) || lower.includes("publish"))) return "deploys the application";
  if (cmd === "terraform" && (lower.includes("apply") || lower.includes("destroy"))) return "changes infrastructure";
  if (cmd === "kubectl" && lower.includes("apply")) return "changes cluster resources";
  if (JS_RUNNERS.has(cmd) && lower.includes("publish")) return "publishes a package";
  if ((cmd === "cargo" && lower.includes("publish")) || (cmd === "twine" && lower.includes("upload")) || (cmd === "gh" && lower.includes("release"))) return "publishes a release";
  if (cmd === "aws" && has(/^(rm|delete.*|terminate.*|remove.*)$/)) return "deletes cloud resources";
  if (["invoke-expression", "iex"].includes(cmd)) return "evaluates dynamically built code";
  return undefined;
}

function isSafeSegment(tokens: string[], cmd: string): boolean {
  const args = tokens.slice(1);
  const lower = args.map((a) => a.toLowerCase());
  if (SAFE_SIMPLE.has(cmd)) return true;
  if (cmd === "find") return !lower.some((a) => ["-exec", "-execdir", "-delete", "-ok", "-fprint", "-fls"].includes(a));
  if (cmd === "git") {
    const sub = lower.find((a) => !a.startsWith("-"));
    if (!sub) return false;
    if (SAFE_GIT.has(sub)) return true;
    if (sub === "branch") return lower.slice(lower.indexOf("branch") + 1).every((a) => ["-a", "-v", "-vv", "-r", "--list", "--show-current", "--all"].includes(a));
    if (sub === "remote") return lower.every((a) => ["remote", "-v", "show"].includes(a));
    if (sub === "config") return lower.includes("--get") || lower.includes("--list") || lower.includes("-l");
    return false;
  }
  if (["node", "python", "python3", "npm", "pnpm", "yarn", "bun", "cargo", "go", "rustc", "git", "tsc", "java", "dotnet", "php", "ruby"].includes(cmd) && lower.length === 1 && ["-v", "--version", "version", "-version"].includes(lower[0]!)) return true;
  if (JS_RUNNERS.has(cmd)) {
    const sub = lower[0];
    if (!sub) return false;
    if (SAFE_JS_SCRIPTS.test(sub)) return true;
    if (["ls", "list", "outdated", "view", "why", "audit"].includes(sub) && !lower.includes("fix")) return true;
    if (sub === "run" || sub === "run-script") return !!lower[1] && SAFE_JS_SCRIPTS.test(lower[1]);
    return false;
  }
  if (cmd === "tsc") return lower.includes("--noemit");
  if (["vitest", "jest", "pytest", "mocha", "ava"].includes(cmd)) return !lower.includes("-u") && !lower.includes("--update");
  if (cmd === "eslint" || cmd === "ruff") return !lower.includes("--fix");
  if (cmd === "cargo") return ["test", "check", "clippy", "tree", "metadata"].includes(lower[0] ?? "");
  if (cmd === "go") return ["test", "vet", "list", "version", "env"].includes(lower[0] ?? "");
  if (cmd === "python" || cmd === "python3") return lower[0] === "-m" && ["pytest", "unittest"].includes(lower[1] ?? "");
  if (cmd === "dotnet") return lower[0] === "test";
  return false;
}

/** Classify a shell command line. Conservative: anything not recognised as read-only needs confirmation. */
export function classifyCommand(command: string): CommandRisk {
  const trimmed = command.trim();
  if (!trimmed) return { level: "safe", reason: "empty command" };
  const segments = splitSegments(trimmed);
  let worst: CommandRisk = { level: "safe", reason: "read-only command" };
  const bump = (r: CommandRisk) => {
    if (RANK[r.level] > RANK[worst.level]) worst = r;
  };

  // Pipe-to-shell and download-and-run patterns.
  if (/\b(curl|wget|iwr|invoke-webrequest)\b[^|;&]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|invoke-expression|python3?|node)\b/i.test(trimmed)) {
    return { level: "dangerous", reason: "downloads and executes remote code" };
  }

  const unquoted = stripQuotes(trimmed);
  for (const seg of segments) {
    const tokens = tokenize(seg);
    // Skip leading env assignments (FOO=bar cmd).
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
    if (!tokens.length) continue;
    const cmd = baseName(tokens[0]!);
    const danger = dangerousReason(seg, tokens, cmd);
    if (danger) {
      bump({ level: "dangerous", reason: danger });
      continue;
    }
    if (!isSafeSegment(tokens, cmd)) bump({ level: "confirm", reason: `\`${cmd}\` may modify the project or run arbitrary code` });
  }
  if (worst.level === "safe") {
    if (/[<>]/.test(unquoted)) bump({ level: "confirm", reason: "redirects output to a file" });
    if (/\$\(|`/.test(unquoted)) bump({ level: "confirm", reason: "uses command substitution" });
  }
  return worst;
}

export const DANGEROUS_EXAMPLES = ["rm -rf", "sudo", "chmod", "chown", "git push", "git reset --hard", "docker system prune", "DROP TABLE"];
