import { describe, expect, it } from "vitest";
import { CATALOG, estimateFit, kvCacheGB, recommend, type HardwareInfo } from "../src/advisor";

const laptop: HardwareInfo = { os: "win32", cpu: "AMD Ryzen 7 4800H", cores: 16, ramGB: 23.4, gpus: [{ name: "NVIDIA GeForce RTX 3050 Laptop GPU", vramGB: 4, vendor: "nvidia" }], unified: false };
const big: HardwareInfo = { os: "win32", cpu: "x", cores: 24, ramGB: 64, gpus: [{ name: "NVIDIA GeForce RTX 4090", vramGB: 24, vendor: "nvidia" }], unified: false };
const tiny: HardwareInfo = { os: "win32", cpu: "x", cores: 4, ramGB: 8, gpus: [], unified: false };
const mac: HardwareInfo = { os: "darwin", cpu: "Apple M2", cores: 8, ramGB: 16, gpus: [{ name: "Apple M2", vramGB: 16, vendor: "apple" }], unified: true };
const model = (tag: string) => CATALOG.find((m) => m.tag === tag)!;

describe("advisor", () => {
  it("KV cache grows with context", () => {
    const m = model("qwen3:4b-instruct");
    expect(kvCacheGB(m, 16384)).toBeCloseTo(kvCacheGB(m, 8192) * 2, 5);
    expect(kvCacheGB(m, 8192)).toBeGreaterThan(0.3);
  });

  it("recommends a small non-thinking model for a 4 GB GPU laptop (what we measured)", () => {
    const r = recommend(laptop);
    expect(r.best?.model.tag).toBe("qwen3:4b-instruct");
    expect(r.best?.model.thinking).toBe(false);
    expect(r.best?.placement).toBe("split");
  });

  it("estimates speeds close to the measured ones on that laptop", () => {
    // Measured under Ollama: qwen3:4b 8K ≈ 5.9 tok/s, qwen3:8b 16K ≈ 1.7 tok/s.
    expect(estimateFit(laptop, model("qwen3:4b-instruct"), 8192).tokensPerSec).toBeGreaterThan(3);
    expect(estimateFit(laptop, model("qwen3:4b-instruct"), 8192).tokensPerSec).toBeLessThan(10);
    const eight = estimateFit(laptop, model("qwen3:8b"), 16384);
    expect(eight.tokensPerSec).toBeGreaterThan(0.8);
    expect(eight.tokensPerSec).toBeLessThan(3.5);
    expect(eight.level).toBe("slow");
    expect(eight.warnings.join(" ")).toMatch(/Thinking model/);
  });

  it("flags the 30B model as too tight on 23 GB of RAM", () => {
    const f = estimateFit(laptop, model("qwen3-coder:30b"), 8192);
    expect(f.level).toBe("slow");
    expect(f.warnings.join(" ")).toMatch(/swapping/);
  });

  it("a big GPU runs the 30B MoE model fast and recommends it", () => {
    const f = estimateFit(big, model("qwen3-coder:30b"), 16384);
    expect(f.placement).toBe("gpu");
    expect(f.level).toBe("great");
    expect(recommend(big).best?.model.quality).toBeGreaterThanOrEqual(8);
  });

  it("says nothing fits when memory is too small", () => {
    const r = recommend(tiny);
    expect(r.best).toBeUndefined();
    expect(r.options.every((o) => o.level === "too-big")).toBe(true);
  });

  it("treats Apple Silicon unified memory as GPU memory", () => {
    const f = estimateFit(mac, model("qwen3:8b"), 8192);
    expect(f.placement).toBe("gpu");
    expect(f.level).not.toBe("too-big");
  });

  it("returns one option per model, best first", () => {
    const r = recommend(laptop);
    expect(new Set(r.options.map((o) => o.model.tag)).size).toBe(CATALOG.length);
    expect(r.options[0]!.score).toBeGreaterThanOrEqual(r.options[1]!.score);
  });
});
