/**
 * Model advisor: given the machine's memory, estimate which local coding models will run well and how fast.
 *
 * The speed model is deliberately simple (token generation is memory-bandwidth bound) and its efficiency constants
 * were calibrated against measurements on one laptop (4 GB RTX 3050 + 23 GB RAM under Ollama). Treat results as
 * estimates and say so in the UI.
 */

export interface GpuInfo {
  name: string;
  vramGB: number;
  vendor: "nvidia" | "amd" | "intel" | "apple" | "other";
}

export interface HardwareInfo {
  os: string;
  cpu: string;
  cores: number;
  ramGB: number;
  gpus: GpuInfo[];
  /** Unified memory (Apple Silicon): GPU and CPU share ramGB. */
  unified: boolean;
}

export interface CatalogModel {
  /** Ollama tag. */
  tag: string;
  label: string;
  /** Weights size on disk/in memory at the quantisation Ollama ships (GB). */
  sizeGB: number;
  /** Parameters read per generated token (B). Smaller than total for mixture-of-experts models. */
  activeB: number;
  layers: number;
  kvHeads: number;
  headDim: number;
  /** Always-thinking models spend many tokens reasoning before each answer. */
  thinking: boolean;
  /** 1 (weak) to 10 (strong) for agentic coding with tools. Editorial judgement, not a benchmark. */
  quality: number;
  note: string;
}

export const CATALOG: CatalogModel[] = [
  { tag: "qwen3:4b-instruct", label: "Qwen3 4B Instruct", sizeGB: 2.5, activeB: 4, layers: 36, kvHeads: 8, headDim: 128, thinking: false, quality: 4, note: "Small, fast, no thinking delay. Good for simple fixes." },
  { tag: "qwen2.5-coder:7b", label: "Qwen2.5-Coder 7B", sizeGB: 4.7, activeB: 7, layers: 28, kvHeads: 4, headDim: 128, thinking: false, quality: 4, note: "Code-tuned but weaker at deciding to use tools." },
  { tag: "qwen3:8b", label: "Qwen3 8B (thinking)", sizeGB: 5.2, activeB: 8, layers: 36, kvHeads: 8, headDim: 128, thinking: true, quality: 6, note: "Smarter, but reasons at length before answering." },
  { tag: "qwen3:14b", label: "Qwen3 14B (thinking)", sizeGB: 9.3, activeB: 14, layers: 40, kvHeads: 8, headDim: 128, thinking: true, quality: 7, note: "Needs about 12 GB of fast memory." },
  { tag: "qwen3-coder:30b", label: "Qwen3-Coder 30B-A3B", sizeGB: 19, activeB: 3.3, layers: 48, kvHeads: 4, headDim: 128, thinking: false, quality: 8, note: "BetaCode's default target. Mixture-of-experts: fast per token, but needs about 20+ GB of memory." },
  { tag: "qwen2.5-coder:32b", label: "Qwen2.5-Coder 32B", sizeGB: 20, activeB: 32, layers: 64, kvHeads: 8, headDim: 128, thinking: false, quality: 8, note: "Dense and strong, needs a large GPU (24 GB) to be fast." },
];

export const CONTEXT_CHOICES = [8192, 16384, 32768];

/** Approximate memory bandwidth (GB/s) for common GPUs; unknown GPUs get a vendor default. */
const GPU_BW: Array<[RegExp, number]> = [
  [/5090/i, 1792], [/4090/i, 1008], [/4080/i, 717], [/4070 ti/i, 504], [/4070/i, 504], [/4060 ti/i, 288], [/4060/i, 272],
  [/3090/i, 936], [/3080/i, 760], [/3070/i, 448], [/3060 ti/i, 448], [/3060/i, 360], [/3050 ti/i, 192], [/3050/i, 224],
  [/2080/i, 448], [/2070/i, 448], [/2060/i, 336], [/1660/i, 192], [/1650/i, 128],
  [/7900 xtx/i, 960], [/7900/i, 800], [/7800/i, 624], [/7700/i, 432], [/6800/i, 512], [/6700/i, 384], [/6600/i, 224],
  [/m[1-4] ultra/i, 800], [/m[1-4] max/i, 400], [/m[1-4] pro/i, 200], [/apple m/i, 100],
];

export function gpuBandwidth(g: GpuInfo): number {
  for (const [re, bw] of GPU_BW) if (re.test(g.name)) return bw;
  return g.vendor === "nvidia" ? 250 : g.vendor === "apple" ? 100 : 80;
}

const CPU_RAM_BW = 40; // GB/s, dual-channel DDR4-ish
const EFF_GPU = 0.7;
const EFF_PARTIAL = 0.12; // CPU/GPU split: measured far below the ideal blend
const EFF_CPU = 0.5;
const OS_RESERVE_GB = 5; // memory the OS and other apps keep
const GPU_RESERVE_GB = 0.8; // display and driver overhead

export type FitLevel = "great" | "good" | "slow" | "too-big";

export interface Fit {
  model: CatalogModel;
  contextLength: number;
  memoryNeededGB: number;
  placement: "gpu" | "split" | "cpu";
  gpuFraction: number;
  tokensPerSec: number;
  level: FitLevel;
  /** quality adjusted for speed and thinking; used for ranking */
  score: number;
  warnings: string[];
}

export function kvCacheGB(m: CatalogModel, ctx: number, qBytes = 1): number {
  return (2 * m.layers * m.kvHeads * m.headDim * qBytes * ctx) / 1e9;
}

export function estimateFit(hw: HardwareInfo, m: CatalogModel, ctx: number): Fit {
  const kv = kvCacheGB(m, ctx, 1); // q8 KV cache (BetaCode recommends OLLAMA_KV_CACHE_TYPE=q8_0)
  const need = m.sizeGB + kv + 0.6;
  const best = [...hw.gpus].sort((a, b) => b.vramGB - a.vramGB)[0];
  const vram = hw.unified ? 0 : Math.max(0, (best?.vramGB ?? 0) - GPU_RESERVE_GB);
  const ram = Math.max(0, hw.ramGB - OS_RESERVE_GB);
  const warnings: string[] = [];

  let placement: Fit["placement"];
  let gpuFraction = 0;
  let tps: number;
  // Bytes read per token scale with active parameters (a mixture-of-experts model reads only its active experts).
  const readGB = m.sizeGB * Math.min(1, m.activeB / paramsB(m)) + kv * 0.3;

  if (hw.unified) {
    placement = "gpu";
    gpuFraction = 1;
    tps = ((best ? gpuBandwidth(best) : 100) / Math.max(readGB, 0.1)) * EFF_GPU;
    if (need > hw.ramGB * 0.7) warnings.push("Uses most of your unified memory.");
  } else if (best && need <= vram) {
    placement = "gpu";
    gpuFraction = 1;
    tps = (gpuBandwidth(best) / Math.max(readGB, 0.1)) * EFF_GPU;
  } else if (best && vram > 1) {
    placement = "split";
    gpuFraction = Math.min(1, vram / need);
    const t = (gpuFraction * readGB) / gpuBandwidth(best) + ((1 - gpuFraction) * readGB) / CPU_RAM_BW;
    tps = (1 / t) * EFF_PARTIAL;
    warnings.push("Does not fit entirely in GPU memory; part runs on the CPU, which is much slower.");
  } else {
    placement = "cpu";
    tps = (CPU_RAM_BW / Math.max(readGB, 0.1)) * EFF_CPU;
  }

  const fitsMemory = need <= vram + ram;
  if (m.thinking) {
    warnings.push("Thinking model: spends many tokens reasoning before each answer, so tasks take several times longer.");
  }
  // Filling almost all memory makes the OS swap, which is far worse than the raw numbers suggest.
  const tight = fitsMemory && placement !== "gpu" && need > ram * 0.85;
  if (tight) warnings.push("Leaves very little free memory; expect swapping and a sluggish computer.");

  const effectiveTps = m.thinking ? tps / 4 : tps;
  const level: FitLevel = !fitsMemory ? "too-big" : tight ? "slow" : effectiveTps >= 15 ? "great" : effectiveTps >= 6 ? "good" : "slow";
  // A model that is too slow to use is worth little however smart it is, so the speed term is steep.
  const speedFactor = !fitsMemory ? 0 : Math.min(1, effectiveTps / 15) ** 0.6;
  const score = !fitsMemory ? -1 : m.quality * (0.1 + 0.9 * speedFactor) * (tight ? 0.5 : 1) + (ctx >= 16384 ? 0.2 : 0);
  return { model: m, contextLength: ctx, memoryNeededGB: round1(need), placement, gpuFraction: round2(gpuFraction), tokensPerSec: round1(tps), level, score: round2(score), warnings };
}

function paramsB(m: CatalogModel): number {
  // Total parameters (B) from size at ~4.5 bits/weight: size_GB * 8 / 4.5 ≈ size * 1.78.
  return Math.max(m.activeB, m.sizeGB * 1.78);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface Recommendation {
  best?: Fit;
  options: Fit[];
}

/** Rank every (model, context) pair; `best` is the highest score, preferring the smaller context on ties. */
export function recommend(hw: HardwareInfo, catalog: CatalogModel[] = CATALOG): Recommendation {
  const all: Fit[] = [];
  for (const m of catalog) for (const ctx of CONTEXT_CHOICES) all.push(estimateFit(hw, m, ctx));
  const usable = all.filter((f) => f.level !== "too-big");
  usable.sort((a, b) => b.score - a.score || a.contextLength - b.contextLength);
  // One entry per model: its best context.
  const seen = new Set<string>();
  const options: Fit[] = [];
  for (const f of usable) {
    if (seen.has(f.model.tag)) continue;
    seen.add(f.model.tag);
    options.push(f);
  }
  for (const m of catalog) if (!seen.has(m.tag)) options.push(estimateFit(hw, m, CONTEXT_CHOICES[0]!));
  return { best: options[0] && options[0].level !== "too-big" ? options[0] : undefined, options };
}
