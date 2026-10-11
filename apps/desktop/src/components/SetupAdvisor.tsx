import clsx from "clsx";
import { Check, Cpu, Download, ExternalLink, HardDrive, Loader2, MemoryStick, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { setupBus } from "../lib/setup-bus";
import type { Fit, SetupOverview } from "../lib/types";
import { useApp } from "../stores/app";
import { Button, formatTokens, inputClass } from "./ui";

const LEVEL = {
  great: { label: "Great fit", cls: "border-ok/40 bg-ok/10 text-ok" },
  good: { label: "Good fit", cls: "border-ok/30 bg-ok/5 text-ok" },
  slow: { label: "Slow", cls: "border-warn/40 bg-warn/10 text-warn" },
  "too-big": { label: "Too big", cls: "border-bad/40 bg-bad/10 text-bad" },
} as const;

const PLACEMENT = { gpu: "runs on the GPU", split: "split between GPU and CPU", cpu: "runs on the CPU" } as const;

function Badge({ level }: { level: Fit["level"] }) {
  return <span className={clsx("rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide", LEVEL[level].cls)}>{LEVEL[level].label}</span>;
}

/** Hardware-aware model recommendations and the steps to get a local model running (Ollama). */
export function SetupAdvisor() {
  const toast = useApp((s) => s.toast);
  const refreshConfig = useApp((s) => s.refreshConfig);
  const refreshModels = useApp((s) => s.refreshModels);
  const [data, setData] = useState<SetupOverview>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [modelsDir, setModelsDir] = useState("");
  const [busy, setBusy] = useState<string>();
  const [progress, setProgress] = useState<{ status: string; pct?: number }>();
  const [envNote, setEnvNote] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const d = await api.setupOverview();
      setData(d);
      setSelected((s) => s ?? d.recommendation.best?.model.tag ?? d.recommendation.options[0]?.model.tag);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);

  useEffect(
    () =>
      setupBus.subscribe((e) => {
        if (e.kind === "progress") setProgress({ status: e.status, pct: e.total ? Math.round(((e.completed ?? 0) / e.total) * 100) : undefined });
        else if (e.kind === "done") {
          setProgress(undefined);
          setBusy(undefined);
          toast(`Downloaded ${e.tag}`, "success");
          void load();
        } else if (e.kind === "error") {
          setProgress(undefined);
          setBusy(undefined);
          toast(e.message, "error");
        } else if (e.kind === "cancelled") {
          setProgress(undefined);
          setBusy(undefined);
        }
      }),
    [load, toast],
  );

  if (error) return <div className="rounded-md border border-bad/30 bg-bad/5 p-3 text-bad">Could not read this machine: {error}</div>;
  if (!data) return <div className="flex items-center gap-2 text-muted"><Loader2 size={14} className="animate-spin" /> Checking your hardware…</div>;

  const { hardware: hw, recommendation: rec, ollama } = data;
  const fit = rec.options.find((o) => o.model.tag === selected) ?? rec.options[0];
  const installed = !!fit && ollama.models.some((m) => m.name === fit.model.tag || m.name === `${fit.model.tag}:latest`);
  const gpu = hw.gpus[0];

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy((b) => (b === key && key !== "pull" ? undefined : b));
    }
  };

  return (
    <div className="space-y-4">
      <section aria-label="Your machine" className="grid grid-cols-1 gap-2 rounded-lg border border-line p-3 text-[12px] sm:grid-cols-3">
        <div className="flex items-start gap-2"><Cpu size={14} className="mt-0.5 shrink-0 text-muted" /><div><div className="text-faint">Processor</div><div>{hw.cpu}</div><div className="text-faint">{hw.cores} threads</div></div></div>
        <div className="flex items-start gap-2"><MemoryStick size={14} className="mt-0.5 shrink-0 text-muted" /><div><div className="text-faint">Memory</div><div>{hw.ramGB} GB RAM</div></div></div>
        <div className="flex items-start gap-2"><HardDrive size={14} className="mt-0.5 shrink-0 text-muted" /><div><div className="text-faint">Graphics</div><div>{gpu ? `${gpu.name}` : "No dedicated GPU found"}</div>{gpu && <div className="text-faint">{hw.unified ? "unified memory" : `${gpu.vramGB} GB video memory`}</div>}</div></div>
      </section>

      <section aria-label="Recommendation">
        {rec.best ? (
          <div className="rounded-lg border border-accent/40 bg-accent-dim/40 p-3">
            <div className="text-[11px] uppercase tracking-wide text-faint">Recommended for this machine</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-semibold">{rec.best.model.label}</span>
              <Badge level={rec.best.level} />
            </div>
            <div className="mt-1 text-[12px] text-muted">
              About {rec.best.tokensPerSec} tokens/s, needs ~{rec.best.memoryNeededGB} GB, {PLACEMENT[rec.best.placement]}, {formatTokens(rec.best.contextLength)} context. {rec.best.model.note}
            </div>
          </div>
        ) : (
          <div role="alert" className="rounded-lg border border-warn/40 bg-warn/5 p-3 text-warn">
            None of the local models fit comfortably in this machine&apos;s memory. Use a hosted model instead (Settings → AI Models, with an API key).
          </div>
        )}
        <p className="mt-1.5 text-[11px] text-faint">Speeds are estimates from memory size and bandwidth, calibrated on one laptop. Your results will differ.</p>
      </section>

      <section aria-label="Model options">
        <table className="w-full text-left text-[12px]">
          <thead>
            <tr className="text-[10.5px] uppercase tracking-wide text-faint">
              <th className="w-6 py-1" />
              <th className="py-1 font-medium">Model</th>
              <th className="py-1 font-medium">Fit</th>
              <th className="py-1 text-right font-medium">~tok/s</th>
              <th className="py-1 text-right font-medium">Memory</th>
            </tr>
          </thead>
          <tbody>
            {rec.options.map((o) => (
              <tr key={o.model.tag} className={clsx("border-t border-line", o.level === "too-big" && "opacity-50")}>
                <td className="py-1.5">
                  <input type="radio" name="advisor-model" aria-label={`Choose ${o.model.label}`} checked={selected === o.model.tag} onChange={() => setSelected(o.model.tag)} className="accent-[var(--color-accent)]" />
                </td>
                <td className="py-1.5">
                  <div className="font-medium">{o.model.label}</div>
                  <div className="font-mono text-[10.5px] text-faint">{o.model.tag}{ollama.models.some((m) => m.name.startsWith(o.model.tag)) ? " · installed" : ""}</div>
                </td>
                <td className="py-1.5"><Badge level={o.level} /></td>
                <td className="py-1.5 text-right font-mono">{o.level === "too-big" ? "—" : o.tokensPerSec}</td>
                <td className="py-1.5 text-right font-mono">{o.memoryNeededGB} GB</td>
              </tr>
            ))}
          </tbody>
        </table>
        {fit && fit.warnings.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11.5px] text-warn">
            {fit.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}
      </section>

      {fit && fit.level !== "too-big" && (
        <section aria-label="Setup steps" className="space-y-3 rounded-lg border border-line p-3">
          <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Set up {fit.model.label}</h4>

          <Step n={1} done={ollama.running} title="Ollama is running">
            {ollama.running ? (
              <span className="text-muted">Version {ollama.version}{ollama.loadedContext ? ` · loaded context ${formatTokens(ollama.loadedContext)}` : ""}</span>
            ) : ollama.installed ? (
              <span className="text-warn">Installed but not running. Start the Ollama app, or use step 2 to restart it.</span>
            ) : (
              <span className="text-warn">
                Not installed.{" "}
                <a className="inline-flex items-center gap-1 underline" href="https://ollama.com/download" target="_blank" rel="noreferrer">Download Ollama <ExternalLink size={11} /></a>
                {hw.os === "win32" && <> or run <code className="font-mono">winget install Ollama.Ollama</code></>}
              </span>
            )}
            <Button variant="ghost" className="ml-2" onClick={() => void load()}><RefreshCw size={12} /> Re-check</Button>
          </Step>

          <Step n={2} done={ollama.running && !!ollama.loadedContext && ollama.loadedContext >= Math.min(fit.contextLength, 8192)} title="Give the model enough memory for BetaCode’s prompt">
            <p className="text-muted">
              Ollama defaults to a 4096-token window, which silently cuts off BetaCode’s instructions. This saves the recommended settings (context {formatTokens(fit.contextLength)}, flash attention, compact cache)
              {hw.os === "win32" ? " as user environment variables" : ""}.
            </p>
            <label className="mt-2 block text-[11.5px] text-muted">
              Where to store downloaded models (optional, e.g. <span className="font-mono">D:\ollama\models</span> to save space on C:)
              <input className={clsx(inputClass, "mt-1")} value={modelsDir} onChange={(e) => setModelsDir(e.target.value)} placeholder="Leave empty for Ollama’s default folder" aria-label="Models folder" />
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                disabled={!!busy}
                onClick={() =>
                  void run("env", async () => {
                    const r = await api.setupApplyEnv({ contextLength: fit.contextLength, modelsDir: modelsDir.trim() || undefined, restart: false });
                    setEnvNote(r.result.manual.length ? `Run these yourself, then restart Ollama:\n${r.result.manual.join("\n")}` : `Saved: ${r.result.applied.join(", ")}. Restart Ollama to apply.`);
                  })
                }
              >
                Save settings
              </Button>
              <Button
                disabled={!!busy || !ollama.installed}
                onClick={() => {
                  if (!window.confirm("This stops and restarts the local Ollama server. Any model currently loaded will be unloaded. Continue?")) return;
                  void run("restart", async () => {
                    const r = await api.setupApplyEnv({ contextLength: fit.contextLength, modelsDir: modelsDir.trim() || undefined, restart: true });
                    setEnvNote(`Ollama restarted${r.ollama?.version ? ` (v${r.ollama.version})` : ""} with the new settings.`);
                    await load();
                  });
                }}
              >
                {busy === "restart" ? <Loader2 size={12} className="animate-spin" /> : null} Save &amp; restart Ollama
              </Button>
            </div>
            {envNote && <pre className="mt-2 whitespace-pre-wrap rounded-md border border-line bg-bg px-3 py-2 font-mono text-[11.5px] text-muted">{envNote}</pre>}
          </Step>

          <Step n={3} done={installed} title={`Download ${fit.model.tag}`}>
            <p className="text-muted">About {fit.model.sizeGB} GB. BetaCode only downloads when you click.</p>
            <div className="mt-2 flex items-center gap-2">
              {installed ? (
                <span className="text-ok">Already downloaded</span>
              ) : busy === "pull" ? (
                <Button variant="danger" onClick={() => void api.setupCancelPull()}>Cancel download</Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={!ollama.running || !!busy}
                  onClick={() =>
                    void run("pull", async () => {
                      setProgress({ status: "starting…" });
                      await api.setupPull(fit.model.tag);
                    })
                  }
                >
                  <Download size={13} /> Download
                </Button>
              )}
              {!ollama.running && !installed && <span className="text-[11.5px] text-faint">Start Ollama first.</span>}
            </div>
            {progress && (
              <div className="mt-2" role="status">
                <div className="mb-1 flex justify-between text-[11px] text-muted"><span className="truncate">{progress.status}</span><span>{progress.pct !== undefined ? `${progress.pct}%` : ""}</span></div>
                <div className="h-1.5 overflow-hidden rounded bg-raised"><div className="h-full bg-accent transition-all" style={{ width: `${progress.pct ?? 5}%` }} /></div>
              </div>
            )}
          </Step>

          <Step n={4} done={false} title="Use it in BetaCode">
            <Button
              variant="primary"
              disabled={!installed || !!busy}
              onClick={() =>
                void run("use", async () => {
                  await api.setupUse(fit.model.tag, fit.contextLength);
                  await refreshConfig();
                  await refreshModels();
                  toast(`BetaCode now uses ${fit.model.tag}`, "success");
                })
              }
            >
              Use {fit.model.tag}
            </Button>
          </Step>
        </section>
      )}
    </div>
  );
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className={clsx("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px]", done ? "border-ok/50 bg-ok/10 text-ok" : "border-line text-faint")}>{done ? <Check size={12} /> : n}</span>
      <div className="min-w-0 flex-1 text-[12px]">
        <div className="font-medium">{title}</div>
        <div className="mt-1">{children}</div>
      </div>
    </div>
  );
}
