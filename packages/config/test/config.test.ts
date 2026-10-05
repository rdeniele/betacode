import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, loadConfig, saveConfig } from "../src";

let home: string;
let proj: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bc-home-"));
  proj = mkdtempSync(join(tmpdir(), "bc-proj-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

describe("config", () => {
  it("defaults to local Qwen3-Coder with the recommended sampling parameters", () => {
    const c = loadConfig({ home, env: {} });
    expect(c).toMatchObject({ provider: "qwen", model: DEFAULT_MODEL, baseUrl: DEFAULT_BASE_URL, temperature: 0.7, topP: 0.8, topK: 20, repetitionPenalty: 1.05, maxIterations: 30, maxRetries: 5 });
    expect(c.model).toBe("Qwen/Qwen3-Coder-30B-A3B-Instruct");
    expect(c.apiKey).toBeUndefined();
  });

  it("layers global < project < environment", () => {
    mkdirSync(join(home, ".betacode"), { recursive: true });
    writeFileSync(join(home, ".betacode/config.json"), JSON.stringify({ temperature: 0.1, topK: 5, permissions: { write_file: "safe" } }));
    mkdirSync(join(proj, ".betacode"));
    writeFileSync(join(proj, ".betacode/config.json"), JSON.stringify({ temperature: 0.2, permissions: { delete_file: "deny" } }));
    const c = loadConfig({ home, projectRoot: proj, env: { BETA_CODE_TEMPERATURE: "0.9", BETA_CODE_MODEL: "x", BETA_CODE_BASE_URL: "http://h:1/v1", BETA_CODE_API_KEY: "k" } });
    expect(c).toMatchObject({ temperature: 0.9, topK: 5, model: "x", baseUrl: "http://h:1/v1", apiKey: "k" });
    expect(c.permissions).toEqual({ write_file: "safe", delete_file: "deny" });
  });

  it("rejects invalid values with a readable error", () => {
    expect(() => loadConfig({ home, env: { BETA_CODE_TEMPERATURE: "9" } })).toThrow(/temperature/);
    expect(() => loadConfig({ home, env: { BETA_CODE_BASE_URL: "nope" } })).toThrow(/baseUrl/);
    mkdirSync(join(home, ".betacode"), { recursive: true });
    writeFileSync(join(home, ".betacode/config.json"), "{ bad json");
    expect(() => loadConfig({ home, env: {} })).toThrow(/Invalid JSON/);
  });

  it("never persists the API key unless explicitly allowed", () => {
    const file = saveConfig({ model: "m", apiKey: "secret-key-123" }, { scope: "global", home });
    expect(readFileSync(file, "utf8")).not.toContain("secret-key-123");
    expect(JSON.parse(readFileSync(file, "utf8")).model).toBe("m");
    saveConfig({ apiKey: "secret-key-123" }, { scope: "global", home, persistApiKeyInsecurely: true });
    expect(readFileSync(file, "utf8")).toContain("secret-key-123");
  });

  it("validates before saving", () => {
    expect(() => saveConfig({ temperature: 5 }, { scope: "global", home })).toThrow(/Invalid configuration/);
    expect(existsSync(join(home, ".betacode/config.json"))).toBe(false);
  });
});
