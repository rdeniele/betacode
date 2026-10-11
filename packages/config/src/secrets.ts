import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { BetaCodeError } from "@betacode/shared";

/**
 * Optional at-rest storage for API keys. Keys are never written in plain text: they are encrypted with an
 * operating-system facility tied to the current user (Windows DPAPI). Where no such facility is implemented,
 * persisting is refused and the key stays in memory / BETA_CODE_API_KEY.
 */
export interface Encryptor {
  name: string;
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

function ps(script: string, input: string): string {
  // The secret travels over stdin, never on the command line.
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { input, encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (r.status !== 0) throw new BetaCodeError(`Windows encryption failed${r.stderr ? `: ${r.stderr.trim().split("\n")[0]}` : ""}`, "ENCRYPT_FAILED");
  return r.stdout.trim();
}

/** Windows DPAPI (current-user scope) through PowerShell's SecureString conversion. */
export const dpapiEncryptor: Encryptor = {
  name: "Windows DPAPI",
  encrypt: (plain) => ps("$s = [Console]::In.ReadToEnd(); ConvertTo-SecureString $s.Trim() -AsPlainText -Force | ConvertFrom-SecureString", plain),
  decrypt: (cipher) => ps("$c = [Console]::In.ReadToEnd(); $ss = ConvertTo-SecureString $c.Trim(); [System.Net.NetworkCredential]::new('', $ss).Password", cipher),
};

export function defaultEncryptor(os = platform()): Encryptor | undefined {
  return os === "win32" ? dpapiEncryptor : undefined;
}

export function canPersistKeys(encryptor: Encryptor | undefined = defaultEncryptor()): boolean {
  return !!encryptor;
}

interface SecretFile {
  version: 1;
  keys: Record<string, { method: string; data: string }>;
}

const fileFor = (home: string) => join(home, ".betacode", "secrets.json");

function read(home: string): SecretFile {
  const f = fileFor(home);
  if (!existsSync(f)) return { version: 1, keys: {} };
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as SecretFile;
    return j && typeof j === "object" && j.keys ? j : { version: 1, keys: {} };
  } catch {
    return { version: 1, keys: {} };
  }
}

/** Stable identifier for "which provider is this key for": the endpoint's host (and port). */
export function secretId(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return baseUrl.toLowerCase();
  }
}

export function saveSecret(id: string, value: string, opts: { home?: string; encryptor?: Encryptor } = {}): void {
  const enc = opts.encryptor ?? defaultEncryptor();
  if (!enc) throw new BetaCodeError("Saving keys is only supported on Windows for now. Set the BETA_CODE_API_KEY environment variable instead.", "UNSUPPORTED");
  if (!value.trim()) throw new BetaCodeError("The API key is empty.", "INVALID");
  const home = opts.home ?? homedir();
  const data = read(home);
  data.keys[id] = { method: enc.name, data: enc.encrypt(value.trim()) };
  const f = fileFor(home);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(data, null, 2) + "\n");
  try {
    chmodSync(f, 0o600);
  } catch {
    /* not supported on this filesystem */
  }
}

export function hasSecret(id: string, home = homedir()): boolean {
  return !!read(home).keys[id];
}

/** Returns undefined if no key is stored or it cannot be decrypted (for example it was saved by another Windows user). */
export function loadSecret(id: string, opts: { home?: string; encryptor?: Encryptor } = {}): string | undefined {
  const entry = read(opts.home ?? homedir()).keys[id];
  const enc = opts.encryptor ?? defaultEncryptor();
  if (!entry || !enc || entry.method !== enc.name) return undefined;
  try {
    return enc.decrypt(entry.data) || undefined;
  } catch {
    return undefined;
  }
}

export function deleteSecret(id: string, home = homedir()): boolean {
  const data = read(home);
  if (!data.keys[id]) return false;
  delete data.keys[id];
  writeFileSync(fileFor(home), JSON.stringify(data, null, 2) + "\n");
  return true;
}
