import { spawnSync } from "node:child_process";
import { arch, cpus, platform, totalmem } from "node:os";
import type { GpuInfo, HardwareInfo } from "./advisor";

function run(cmd: string, args: string[], timeout = 6000): string | undefined {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout, windowsHide: true });
    return r.status === 0 ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** Parse `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` output (MiB). */
export function parseNvidiaSmi(out: string): GpuInfo[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.lastIndexOf(",");
      const name = l.slice(0, i).trim();
      const mib = Number(l.slice(i + 1));
      return { name, vramGB: Math.round((mib / 1024) * 10) / 10, vendor: "nvidia" as const };
    })
    .filter((g) => g.name && Number.isFinite(g.vramGB));
}

/** Parse the JSON from `Get-CimInstance Win32_VideoController` (AdapterRAM is 32-bit, so >4 GB cards are under-reported). */
export function parseWindowsGpus(json: string): GpuInfo[] {
  try {
    const raw = JSON.parse(json);
    const list: Array<{ Name?: string; AdapterRAM?: number }> = Array.isArray(raw) ? raw : [raw];
    return list
      .filter((g) => g?.Name && !/microsoft basic|remote|virtual/i.test(g.Name))
      .map((g) => {
        const name = g.Name!;
        const vendor: GpuInfo["vendor"] = /nvidia/i.test(name) ? "nvidia" : /amd|radeon/i.test(name) ? "amd" : /intel/i.test(name) ? "intel" : "other";
        return { name, vramGB: Math.round(((g.AdapterRAM ?? 0) / 1024 ** 3) * 10) / 10, vendor };
      });
  } catch {
    return [];
  }
}

export function detectHardware(): HardwareInfo {
  const os = platform();
  const cpu = cpus();
  const ramGB = Math.round((totalmem() / 1024 ** 3) * 10) / 10;
  const base = { os, cpu: cpu[0]?.model.trim() ?? "unknown CPU", cores: cpu.length, ramGB };

  if (os === "darwin" && arch() === "arm64") {
    return { ...base, gpus: [{ name: "Apple Silicon (unified memory)", vramGB: ramGB, vendor: "apple" }], unified: true };
  }

  let gpus: GpuInfo[] = [];
  const smi = run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  if (smi) gpus = parseNvidiaSmi(smi);
  if (!gpus.length && os === "win32") {
    const j = run("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress"]);
    if (j) gpus = parseWindowsGpus(j);
  }
  // Integrated graphics share system RAM and are not useful for model weights.
  gpus = gpus.filter((g) => !(g.vendor === "intel" || (g.vendor === "amd" && g.vramGB <= 0.6)));
  return { ...base, gpus, unified: false };
}
