import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAICompatibleProvider, ProviderError, QwenProvider, collectStream, parseTextToolCalls, ToolTagFilter } from "../src";

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

type Handler = (body: any, res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage) => void;

async function start(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => handler(raw ? JSON.parse(raw) : {}, res, req));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
}

function sse(res: import("node:http").ServerResponse, chunks: unknown[], opts: { raw?: string[] } = {}) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  for (const r of opts.raw ?? []) res.write(r);
  res.write("data: [DONE]\n\n");
  res.end();
}

describe("OpenAICompatibleProvider streaming", () => {
  it("streams text deltas and usage", async () => {
    const baseUrl = await start((_b, res) =>
      sse(res, [
        { choices: [{ delta: { content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      ]),
    );
    const p = new OpenAICompatibleProvider({ baseUrl, model: "m" });
    const deltas: string[] = [];
    let final;
    for await (const ev of p.stream({ messages: [{ role: "user", content: "hi" }] })) {
      if (ev.type === "text") deltas.push(ev.delta);
      if (ev.type === "done") final = ev.response;
    }
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(final).toMatchObject({ content: "Hello", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 2 } });
  });

  it("assembles tool calls split across chunks", async () => {
    const baseUrl = await start((_b, res) =>
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "list_directory", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
      ]),
    );
    const p = new OpenAICompatibleProvider({ baseUrl, model: "m" });
    const r = await collectStream(p.stream({ messages: [{ role: "user", content: "x" }] }));
    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolCalls).toEqual([
      { id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' },
      { id: "c2", name: "list_directory", arguments: "{}" },
    ]);
  });

  it("sends tools, sampling params and the auth header", async () => {
    let seen: any;
    let auth: string | undefined;
    const baseUrl = await start((b, res, req) => {
      seen = b;
      auth = req.headers.authorization;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    });
    const p = new OpenAICompatibleProvider({ baseUrl, model: "m", apiKey: "k" });
    const r = await p.chat({
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }],
      temperature: 0.7,
      topP: 0.8,
      topK: 20,
      repetitionPenalty: 1.05,
    });
    expect(r.content).toBe("ok");
    expect(auth).toBe("Bearer k");
    expect(seen).toMatchObject({ model: "m", temperature: 0.7, top_p: 0.8, top_k: 20, repetition_penalty: 1.05, tool_choice: "auto" });
    expect(seen.tools[0].function.name).toBe("t");
  });

  it("does not require an API key", async () => {
    let auth: string | undefined = "unset";
    const baseUrl = await start((_b, res, req) => {
      auth = req.headers.authorization;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    await new OpenAICompatibleProvider({ baseUrl, model: "m" }).chat({ messages: [] });
    expect(auth).toBeUndefined();
  });

  it("raises ProviderError on malformed stream chunks", async () => {
    const baseUrl = await start((_b, res) => sse(res, [], { raw: ["data: {not json\n\n"] }));
    const p = new OpenAICompatibleProvider({ baseUrl, model: "m" });
    await expect(collectStream(p.stream({ messages: [] }))).rejects.toBeInstanceOf(ProviderError);
  });

  it("raises on a malformed non-stream response", async () => {
    const baseUrl = await start((_b, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ nope: true }));
    });
    await expect(new OpenAICompatibleProvider({ baseUrl, model: "m" }).chat({ messages: [] })).rejects.toThrow(/Malformed/);
  });

  it("retries 503 then succeeds, but does not retry 400", async () => {
    let n = 0;
    const baseUrl = await start((_b, res) => {
      n++;
      if (n < 2) {
        res.writeHead(503);
        return res.end("busy");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    const p = new OpenAICompatibleProvider({ baseUrl, model: "m" });
    expect((await p.chat({ messages: [] })).content).toBe("ok");
    expect(n).toBe(2);

    let m = 0;
    await new Promise<void>((r) => server!.close(() => r()));
    const url2 = await start((_b, res) => {
      m++;
      res.writeHead(400);
      res.end("bad");
    });
    await expect(new OpenAICompatibleProvider({ baseUrl: url2, model: "m" }).chat({ messages: [] })).rejects.toThrow(/HTTP 400/);
    expect(m).toBe(1);
  });

  it("reports unreachable endpoints clearly", async () => {
    const p = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:1/v1", model: "m", maxRetries: 0 });
    await expect(p.chat({ messages: [] })).rejects.toThrow(/Cannot reach model endpoint/);
  });

  it("aborts an in-flight stream", async () => {
    const baseUrl = await start((_b, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }] })}\n\n`);
      // never ends
    });
    const ctrl = new AbortController();
    const p = new OpenAICompatibleProvider({ baseUrl, model: "m" });
    const it = p.stream({ messages: [], signal: ctrl.signal });
    const first = await it.next();
    expect(first.value).toMatchObject({ type: "text" });
    ctrl.abort();
    const r = await Promise.race([
      it.next().then(
        () => "ended",
        () => "threw",
      ),
      new Promise((r) => setTimeout(() => r("hung"), 3000)),
    ]);
    expect(r).not.toBe("hung");
  });

  it("lists models with context length when the server reports it", async () => {
    const baseUrl = await start((_b, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "Qwen/Qwen3-Coder-30B-A3B-Instruct", max_model_len: 32768 }] }));
    });
    const models = await new OpenAICompatibleProvider({ baseUrl, model: "m" }).getModels();
    expect(models).toEqual([{ id: "Qwen/Qwen3-Coder-30B-A3B-Instruct", contextLength: 32768 }]);
  });
});

describe("Qwen text tool-call fallback", () => {
  const xml = `Let me look.\n<tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a.ts\n</parameter>\n</function>\n</tool_call>`;

  it("parses Qwen XML tool calls", () => {
    const { calls } = parseTextToolCalls(xml);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("read_file");
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ path: "src/a.ts" });
  });

  it("parses Hermes JSON tool calls", () => {
    const { calls } = parseTextToolCalls('<tool_call>{"name":"x","arguments":{"a":1}}</tool_call>');
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ a: 1 });
  });

  it("hides tool tags from streamed text, even when split across chunks", () => {
    const f = new ToolTagFilter();
    const out = ["Hi <to", "ol_c", "all>rest"].map((d) => f.feed(d)).join("") + f.flush();
    expect(out).toBe("Hi ");
    expect(f.captured).toBe("<tool_call>rest");
  });

  it("does not swallow text that merely looks like a tag prefix", () => {
    const f = new ToolTagFilter();
    expect(f.feed("a <to") + f.feed("day") + f.flush()).toBe("a <today");
  });

  it("converts text tool calls into structured calls when streaming", async () => {
    const baseUrl = await start((_b, res) =>
      sse(res, [
        { choices: [{ delta: { content: "Checking.\n<tool_call>\n<function=list_directory>\n<param" } }] },
        { choices: [{ delta: { content: "eter=path>\n.\n</parameter>\n</function>\n</tool_call>" }, finish_reason: "stop" }] },
      ]),
    );
    const p = new QwenProvider({ baseUrl });
    const texts: string[] = [];
    let final;
    for await (const ev of p.stream({ messages: [] })) {
      if (ev.type === "text") texts.push(ev.delta);
      if (ev.type === "done") final = ev.response;
    }
    expect(texts.join("")).not.toContain("tool_call");
    expect(final!.toolCalls[0]).toMatchObject({ name: "list_directory" });
    expect(JSON.parse(final!.toolCalls[0]!.arguments)).toEqual({ path: "." });
    expect(final!.finishReason).toBe("tool_calls");
  });
});

describe("createProvider and hosted endpoints", () => {
  it("recognises local and private endpoints", async () => {
    const { isLocalUrl } = await import("../src");
    for (const u of ["http://localhost:8000/v1", "http://127.0.0.1:11434/v1", "http://192.168.1.5:8000/v1", "http://10.0.0.2/v1", "http://172.20.1.1/v1", "http://box.local:8080/v1"]) expect(isLocalUrl(u)).toBe(true);
    for (const u of ["https://api.groq.com/openai/v1", "https://generativelanguage.googleapis.com/v1beta/openai", "http://172.32.0.1/v1", "not a url"]) expect(isLocalUrl(u)).toBe(false);
  });

  it("does not send top_k / repetition_penalty to hosted APIs, but does to local servers", async () => {
    const { createProvider } = await import("../src");
    const seen: any[] = [];
    const baseUrl = await start((b, res) => {
      seen.push(b);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    const req = { messages: [{ role: "user" as const, content: "x" }], topK: 20, repetitionPenalty: 1.05, topP: 0.8 };
    await createProvider({ provider: "qwen", baseUrl, model: "m" }).chat(req); // 127.0.0.1 → local
    expect(seen[0]).toMatchObject({ top_k: 20, repetition_penalty: 1.05, top_p: 0.8 });
    // Same code path with a hosted-looking base URL is checked by building the provider's body directly.
    const hosted = createProvider({ provider: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", model: "m" }) as any;
    const body = hosted.buildBody(req, false);
    expect(body.top_k).toBeUndefined();
    expect(body.repetition_penalty).toBeUndefined();
    expect(body.top_p).toBe(0.8);
  });
});
