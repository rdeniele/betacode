import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { BetaCodeError } from "@betacode/shared";

export class PathEscapeError extends BetaCodeError {
  constructor(input: string) {
    super(`Path "${input}" is outside the project workspace and was blocked.`, "OUTSIDE_WORKSPACE");
  }
}

const SENSITIVE_NAMES = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^credentials(\.json)?$/i,
];
const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube"]);
/** `.env.example`-style templates hold no secrets. */
const SAFE_ENV = /^\.env\.(example|sample|template|dist)$/i;

/** Files the agent must not read without explicit approval (secrets, keys, credentials). */
export function isSensitivePath(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  if (SAFE_ENV.test(name)) return false;
  if (parts.some((p) => SENSITIVE_DIRS.has(p))) return true;
  return SENSITIVE_NAMES.some((re) => re.test(name));
}

/**
 * A project directory the agent may operate in. All paths go through {@link Workspace.resolve}, which blocks
 * `..` traversal, absolute paths outside the root, and symlinks that point outside the root.
 */
export class Workspace {
  readonly root: string;
  readonly realRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.realRoot = realpathSync(this.root);
  }

  /** Resolve a user/model supplied path to an absolute path inside the workspace, or throw. */
  resolve(input: string): string {
    if (typeof input !== "string" || input.includes("\0")) throw new PathEscapeError(String(input));
    const abs = resolve(this.root, input || ".");
    if (!this.isInside(abs, this.root)) throw new PathEscapeError(input);
    // Resolve symlinks on the deepest existing ancestor and make sure it is still inside the workspace.
    let probe = abs;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    let real: string;
    try {
      real = realpathSync(probe);
    } catch {
      throw new PathEscapeError(input);
    }
    if (!this.isInside(real, this.realRoot)) throw new PathEscapeError(input);
    return abs;
  }

  /** Workspace-relative path with forward slashes. */
  rel(abs: string): string {
    const r = relative(this.root, abs);
    return r === "" ? "." : r.split(sep).join("/");
  }

  private isInside(abs: string, base: string): boolean {
    const r = relative(base, abs);
    if (r === "") return true;
    if (isAbsolute(r)) return false; // different drive
    return r !== ".." && !r.startsWith(".." + sep);
  }
}
