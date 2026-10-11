import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canPersistKeys, defaultEncryptor, deleteSecret, hasSecret, loadSecret, saveSecret, secretId, type Encryptor } from "../src/secrets";

let home: string;
afterEach(() => home && rmSync(home, { recursive: true, force: true }));
const fake: Encryptor = { name: "fake", encrypt: (p) => Buffer.from([...p].reverse().join("")).toString("base64"), decrypt: (c) => [...Buffer.from(c, "base64").toString()].reverse().join("") };
const mk = () => (home = mkdtempSync(join(tmpdir(), "bc-sec-")));

describe("secrets", () => {
  it("identifies providers by endpoint host", () => {
    expect(secretId("https://generativelanguage.googleapis.com/v1beta/openai")).toBe("generativelanguage.googleapis.com");
    expect(secretId("http://localhost:11434/v1")).toBe("localhost:11434");
  });

  it("stores keys encrypted, never in plain text, and reads them back", () => {
    mk();
    saveSecret("api.example.com", "sk-super-secret-value-123456", { home, encryptor: fake });
    const raw = readFileSync(join(home, ".betacode", "secrets.json"), "utf8");
    expect(raw).not.toContain("sk-super-secret-value-123456");
    expect(hasSecret("api.example.com", home)).toBe(true);
    expect(loadSecret("api.example.com", { home, encryptor: fake })).toBe("sk-super-secret-value-123456");
    expect(loadSecret("other.example.com", { home, encryptor: fake })).toBeUndefined();
  });

  it("keeps keys for different providers apart and can forget one", () => {
    mk();
    saveSecret("a.com", "key-a", { home, encryptor: fake });
    saveSecret("b.com", "key-b", { home, encryptor: fake });
    expect(deleteSecret("a.com", home)).toBe(true);
    expect(loadSecret("a.com", { home, encryptor: fake })).toBeUndefined();
    expect(loadSecret("b.com", { home, encryptor: fake })).toBe("key-b");
    expect(deleteSecret("a.com", home)).toBe(false);
  });

  it("refuses to save without an encryption facility or with an empty key", () => {
    mk();
    if (!defaultEncryptor()) expect(() => saveSecret("a.com", "k", { home })).toThrow(/only supported on Windows/);
    expect(() => saveSecret("a.com", "   ", { home, encryptor: fake })).toThrow(/empty/);
    expect(canPersistKeys(fake)).toBe(true);
  });

  it("does not decrypt entries written by a different method", () => {
    mk();
    saveSecret("a.com", "key-a", { home, encryptor: fake });
    expect(loadSecret("a.com", { home, encryptor: { ...fake, name: "other" } })).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("round-trips through real Windows DPAPI", () => {
    mk();
    saveSecret("dpapi.test", "real-secret-ABC123", { home });
    const raw = readFileSync(join(home, ".betacode", "secrets.json"), "utf8");
    expect(raw).not.toContain("real-secret-ABC123");
    expect(loadSecret("dpapi.test", { home })).toBe("real-secret-ABC123");
  }, 60_000);
});
