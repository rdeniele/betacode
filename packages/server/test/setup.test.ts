import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectHardware, parseNvidiaSmi, parseWindowsGpus } from "../src/hardware";
import { applyOllamaEnv, ollamaStatus, pullModel, recommendedEnv } from "../src/ollama";

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function fakeOllama(handler: (url: string, body: any, res: import("node:http").ServerResponse) => void): Promise<string> {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => handler(req.url ?? "", raw ? JSON.parse(raw) : {}, res));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe("hardware detection", () => {
  it("parses nvidia-smi output", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 3050 Laptop GPU, 4096\nNVIDIA GeForce RTX 4090, 24564\n")).toEqual([
      { name: "NVIDIA GeForce RTX 3050 Laptop GPU", vramGB: 4, vendor: "nvidia" },
      { name: "NVIDIA GeForce RTX 4090", vramGB: 24, vendor: "nvidia" },
    ]);
    expect(parseNvidiaSmi("")).toEqual([]);
  });

  it("parses Windows video controllers and skips virtual adapters", () => {
    const json = JSON.stringify([
      { Name: "AMD Radeon(TM) Graphics", AdapterRAM: 536870912 },
      { Name: "NVIDIA GeForce RTX 3050 Laptop GPU", AdapterRAM: 4293918720 },
      { Name: "Microsoft Basic Display Adapter", AdapterRAM: 0 },
    ]);
    const gpus = parseWindowsGpus(json);
    expect(gpus.map((g) => g.vendor)).toEqual(["amd", "nvidia"]);
    expect(parseWindowsGpus("not json")).toEqual([]);
  });

  it("detects this machine without throwing", () => {
    const hw = detectHardware();
    expect(hw.ramGB).toBeGreaterThan(0.5);
    expect(hw.cores).toBeGreaterThan(0);
    expect(Array.isArray(hw.gpus)).toBe(true);
  });
});

describe("ollama helpers", () => {
  it("reports status, installed models and the loaded context", async () => {
    const origin = await fakeOllama((url, _b, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (url === "/api/version") res.end(JSON.stringify({ version: "0.35.1" }));
      else if (url === "/api/tags") res.end(JSON.stringify({ models: [{ name: "qwen3:4b-instruct", size: 2.5 * 1024 ** 3 }] }));
      else res.end(JSON.stringify({ models: [{ context_length: 8192 }] }));
    });
    const s = await ollamaStatus(origin, "/fake/ollama");
    expect(s).toMatchObject({ installed: true, running: true, version: "0.35.1", loadedContext: 8192 });
    expect(s.models).toEqual([{ name: "qwen3:4b-instruct", sizeGB: 2.5 }]);
  });

  it("reports a stopped server", async () => {
    const s = await ollamaStatus("http://127.0.0.1:1", "");
    expect(s).toMatchObject({ running: false, installed: false, models: [] });
  });

  it("streams download progress and finishes", async () => {
    const origin = await fakeOllama((_u, body, res) => {
      expect(body).toMatchObject({ name: "qwen3:4b-instruct", stream: true });
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
      res.write(JSON.stringify({ status: "pulling abc", total: 100, completed: 40 }) + "\n");
      res.write(JSON.stringify({ status: "pulling abc", total: 100, completed: 100 }).slice(0, 20));
      setTimeout(() => {
        res.write(JSON.stringify({ status: "pulling abc", total: 100, completed: 100 }).slice(20) + "\n" + JSON.stringify({ status: "success" }) + "\n");
        res.end();
      }, 30);
    });
    const seen: Array<{ status: string; completed?: number }> = [];
    await pullModel("qwen3:4b-instruct", (p) => seen.push(p), undefined, origin);
    expect(seen.map((p) => p.status)).toEqual(["pulling manifest", "pulling abc", "pulling abc", "success"]);
    expect(seen[1]).toMatchObject({ completed: 40 });
  });

  it("surfaces download errors and refuses odd model names", async () => {
    const origin = await fakeOllama((_u, _b, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ error: "pull model manifest: file does not exist" }) + "\n");
    });
    await expect(pullModel("nope:1b", () => {}, undefined, origin)).rejects.toThrow(/file does not exist/);
    await expect(pullModel("bad name; rm -rf", () => {}, undefined, origin)).rejects.toThrow(/Invalid model name/);
    await expect(pullModel("x:1", () => {}, undefined, "http://127.0.0.1:1")).rejects.toThrow(/Cannot reach Ollama/);
  });

  it("can cancel a download", async () => {
    const origin = await fakeOllama((_u, _b, res) => {
      res.writeHead(200);
      res.write(JSON.stringify({ status: "pulling" }) + "\n");
    });
    const ctrl = new AbortController();
    const p = pullModel("x:1", () => ctrl.abort(), ctrl.signal, origin);
    await expect(p).rejects.toThrow();
  });
});

describe("applying settings", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("recommends context, flash attention and q8 KV cache", () => {
    expect(recommendedEnv(8192)).toEqual({ OLLAMA_CONTEXT_LENGTH: "8192", OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0" });
    expect(recommendedEnv(8192, "D:\\models").OLLAMA_MODELS).toBe("D:\\models");
  });

  it("writes each variable on Windows through the injected writer, creating the models folder", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "bc-env-")), "ollama", "models");
    dirs.push(join(dir, "..", ".."));
    const written: Array<[string, string]> = [];
    const r = applyOllamaEnv(recommendedEnv(16384, dir), (k, v) => (written.push([k, v]), true), "win32");
    expect(written.map(([k]) => k)).toEqual(["OLLAMA_CONTEXT_LENGTH", "OLLAMA_FLASH_ATTENTION", "OLLAMA_KV_CACHE_TYPE", "OLLAMA_MODELS"]);
    expect(r.applied).toHaveLength(4);
    expect(r.manual).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it("returns manual commands when writing fails or on other systems", () => {
    expect(applyOllamaEnv(recommendedEnv(8192), () => false, "win32").manual[0]).toBe('setx OLLAMA_CONTEXT_LENGTH "8192"');
    const mac = applyOllamaEnv(recommendedEnv(8192), () => true, "darwin");
    expect(mac.applied).toEqual([]);
    expect(mac.manual).toContain("export OLLAMA_CONTEXT_LENGTH=8192");
  });

  it("rejects relative model folders", () => {
    expect(() => applyOllamaEnv(recommendedEnv(8192, "models"), () => true, "win32")).toThrow(/absolute/);
  });
});
