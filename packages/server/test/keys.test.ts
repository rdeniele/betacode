import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Encryptor } from "@betacode/config";
import { App } from "../src";

const fake: Encryptor = { name: "fake", encrypt: (p) => Buffer.from(p).toString("base64"), decrypt: (c) => Buffer.from(c, "base64").toString() };
const apps: App[] = [];
let home: string;

async function open(env: Record<string, string> = {}, encryptor: Encryptor | undefined = fake): Promise<App> {
  const a = await App.create({ home, dbFile: join(home, "db", "t.db"), logFile: false, env: env as NodeJS.ProcessEnv, encryptor });
  apps.push(a);
  return a;
}
const fresh = () => (home = mkdtempSync(join(tmpdir(), "bc-keys-")));

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold the SQLite file briefly */
  }
});

describe("API keys", () => {
  it("a key typed in Settings is used for that session but never exposed or written to disk", async () => {
    fresh();
    const app = await open();
    expect(app.publicConfig()).toMatchObject({ hasApiKey: false, keySource: "none" });
    app.updateConfig({ baseUrl: "https://api.example.com/v1", apiKey: "sk-typed-key-0123456789" });
    expect(app.config().apiKey).toBe("sk-typed-key-0123456789");
    const pub = app.publicConfig();
    expect(pub).toMatchObject({ hasApiKey: true, keySource: "session" });
    expect(JSON.stringify(pub)).not.toContain("sk-typed-key");
    expect(readFileSync(join(home, ".betacode", "config.json"), "utf8")).not.toContain("sk-typed-key");
  });

  it("session keys are forgotten on restart; remembered keys come back, encrypted at rest", async () => {
    fresh();
    const a1 = await open();
    a1.updateConfig({ baseUrl: "https://api.example.com/v1", apiKey: "session-only-key-1" });
    a1.updateConfig({ baseUrl: "https://api.other.com/v1", apiKey: "remembered-key-2", rememberKey: true });
    await a1.close();
    apps.length = 0;

    const a2 = await open();
    a2.updateConfig({ baseUrl: "https://api.example.com/v1" });
    expect(a2.publicConfig().keySource).toBe("none");
    a2.updateConfig({ baseUrl: "https://api.other.com/v1" });
    expect(a2.config().apiKey).toBe("remembered-key-2");
    expect(a2.publicConfig()).toMatchObject({ keySource: "saved", hasApiKey: true });
    expect(readFileSync(join(home, ".betacode", "secrets.json"), "utf8")).not.toContain("remembered-key-2");
  });

  it("never sends one provider's key to another provider", async () => {
    fresh();
    const app = await open();
    app.updateConfig({ baseUrl: "https://api.provider-a.com/v1", apiKey: "key-for-a", rememberKey: true });
    app.updateConfig({ baseUrl: "https://api.provider-b.com/v1" });
    expect(app.config().apiKey).toBeUndefined();
    app.updateConfig({ baseUrl: "https://api.provider-a.com/v1" });
    expect(app.config().apiKey).toBe("key-for-a");
  });

  it("the environment variable wins, and the UI is told where the key came from", async () => {
    fresh();
    const app = await open({ BETA_CODE_API_KEY: "env-key-abcdef" });
    app.updateConfig({ apiKey: "typed-key" });
    expect(app.config().apiKey).toBe("env-key-abcdef");
    expect(app.publicConfig().keySource).toBe("env");
  });

  it("can forget a saved key", async () => {
    fresh();
    const app = await open();
    app.updateConfig({ baseUrl: "https://api.example.com/v1", apiKey: "to-forget-key", rememberKey: true });
    app.updateConfig({ forgetKey: true });
    expect(app.config().apiKey).toBeUndefined();
    expect(app.publicConfig().keySource).toBe("none");
  });

  it("if saving fails the key is not left active, so nothing is half-stored", async () => {
    fresh();
    const broken: Encryptor = { name: "broken", encrypt: () => { throw new Error("encryption unavailable"); }, decrypt: () => "" };
    const app = await open({}, broken);
    expect(() => app.updateConfig({ baseUrl: "https://api.example.com/v1", apiKey: "never-stored-key", rememberKey: true })).toThrow(/encryption unavailable/);
    expect(app.config().apiKey).toBeUndefined();
  });

  it("an empty key clears the session key", async () => {
    fresh();
    const app = await open();
    app.updateConfig({ baseUrl: "https://api.example.com/v1", apiKey: "abc-key-123456" });
    app.updateConfig({ apiKey: "" });
    expect(app.config().apiKey).toBeUndefined();
  });
});

describe("helper (teacher) model settings", () => {
  const teacher = { baseUrl: "https://api.helper.com/v1", model: "big-model", provider: "openai-compatible" };

  it("is unavailable until a key is provided for a hosted endpoint, and the key is separate from the main one", async () => {
    fresh();
    const app = await open();
    app.updateConfig({ baseUrl: "http://localhost:11434/v1", teacher });
    expect(app.teacherOptions()).toBeUndefined();
    expect(app.publicConfig()).toMatchObject({ teacherReady: false, teacherKeySource: "none" });
    app.updateConfig({ teacherKey: "helper-key-123456", rememberTeacherKey: true });
    expect(app.teacherOptions()).toMatchObject({ model: "big-model", host: "api.helper.com", label: "big-model" });
    expect(app.publicConfig()).toMatchObject({ teacherReady: true, teacherKeySource: "session" });
    expect(app.config().apiKey).toBeUndefined(); // the main (local) model did not receive the helper's key
    expect(readFileSync(join(home, ".betacode", "secrets.json"), "utf8")).not.toContain("helper-key-123456");
  });

  it("a saved helper key survives restart; the environment variable also works; disabling turns it off", async () => {
    fresh();
    const a1 = await open();
    a1.updateConfig({ baseUrl: "http://localhost:11434/v1", teacher, teacherKey: "saved-helper-key", rememberTeacherKey: true });
    await a1.close();
    apps.length = 0;
    const a2 = await open();
    expect(a2.publicConfig()).toMatchObject({ teacherReady: true, teacherKeySource: "saved" });
    a2.updateConfig({ teacher: { ...teacher, enabled: false } });
    expect(a2.teacherOptions()).toBeUndefined();
    fresh();
    const a3 = await open({ BETA_CODE_TEACHER_API_KEY: "env-helper-key" });
    a3.updateConfig({ teacher });
    expect(a3.publicConfig().teacherKeySource).toBe("env");
    expect(a3.teacherOptions()).toBeDefined();
  });

  it("a helper on your own network needs no key", async () => {
    fresh();
    const app = await open();
    app.updateConfig({ teacher: { baseUrl: "http://192.168.1.50:8000/v1", model: "big-local", provider: "qwen" } });
    expect(app.teacherOptions()).toMatchObject({ host: "192.168.1.50:8000" });
  });

  it("forgetting the helper key disables it again", async () => {
    fresh();
    const app = await open();
    app.updateConfig({ teacher, teacherKey: "k-123456789", rememberTeacherKey: true });
    app.updateConfig({ forgetTeacherKey: true });
    expect(app.teacherOptions()).toBeUndefined();
  });
});

describe("testing the helper endpoint", () => {
  it("uses the typed key without saving anything, and explains a missing key", async () => {
    fresh();
    const calls: any[] = [];
    const a = await App.create({
      home,
      dbFile: join(home, "db", "t.db"),
      logFile: false,
      env: {} as NodeJS.ProcessEnv,
      encryptor: fake,
      providerFactory: (cfg) => (calls.push(cfg), { id: "x", name: "x", chat: async () => ({ content: "", toolCalls: [], finishReason: "stop" as const }), stream: async function* () {}, supportsTools: () => true, getModels: async () => [{ id: "gem-1" }, { id: "models/gem-2" }] }),
    });
    apps.push(a);
    const noKey = await a.testTeacher({ baseUrl: "https://api.helper.com/v1" });
    expect(noKey).toMatchObject({ ok: false });
    expect(noKey.error).toMatch(/needs an API key/);
    const ok = await a.testTeacher({ baseUrl: "https://api.helper.com/v1", model: "gem-2", apiKey: "typed-key-1234" });
    expect(ok).toMatchObject({ ok: true, models: ["gem-1", "models/gem-2"], modelAvailable: true });
    expect(calls.at(-1)).toMatchObject({ baseUrl: "https://api.helper.com/v1", apiKey: "typed-key-1234" });
    expect(a.publicConfig().teacherKeySource).toBe("none"); // nothing was stored by testing
  });
});
