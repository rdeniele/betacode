import clsx from "clsx";
import { Check, Copy, Loader2, Plug, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { THEMES, type DensityId, type FontId } from "../lib/appearance";
import { HelperTab } from "./HelperTab";
import { SetupAdvisor } from "./SetupAdvisor";
import { CONTEXT_OPTIONS, PROVIDER_PRESETS, QWEN_MODEL, RUNTIMES, presetFor, type RuntimeGuide } from "../lib/presets";
import type { ConnectionTest, DoctorCheck } from "../lib/types";
import { useApp, type SettingsTab } from "../stores/app";
import { Button, Dialog, Field, formatTokens, inputClass } from "./ui";

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "models", label: "AI Models" },
  { id: "helper", label: "Helper model" },
  { id: "local", label: "Local AI" },
  { id: "appearance", label: "Appearance" },
  { id: "permissions", label: "Permissions" },
  { id: "doctor", label: "Doctor" },
];

export function SettingsDialog() {
  const tab = useApp((s) => s.settingsTab);
  const set = useApp((s) => s.set);
  return (
    <Dialog title="Settings" onClose={() => set({ dialog: null })} width="max-w-3xl">
      <div className="flex min-h-[420px]">
        <nav className="w-40 shrink-0 border-r border-line p-2" aria-label="Settings sections">
          {TABS.map((t) => (
            <button key={t.id} aria-current={tab === t.id} onClick={() => set({ settingsTab: t.id })} className={clsx("block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px]", tab === t.id ? "bg-hover text-text" : "text-muted hover:text-text")}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 p-4">
          {tab === "models" && <ModelsTab />}
          {tab === "local" && <LocalTab />}
          {tab === "helper" && <HelperTab />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "permissions" && <PermissionsTab />}
          {tab === "doctor" && <DoctorTab />}
        </div>
      </div>
    </Dialog>
  );
}

export function TestResult({ result }: { result?: ConnectionTest }) {
  if (!result) return null;
  if (!result.ok) return <div role="status" className="rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-bad">Not reachable: {result.error}</div>;
  return (
    <div role="status" className={clsx("rounded-md border px-3 py-2", result.modelAvailable ? "border-ok/30 bg-ok/5 text-ok" : "border-warn/30 bg-warn/5 text-warn")}>
      {result.modelAvailable ? "Connected — model available" : "Endpoint reachable, but the configured model was not listed"} ({result.latencyMs} ms
      {result.contextLength ? `, server context ${formatTokens(result.contextLength)}` : ""}).
      {!result.modelAvailable && result.models.length > 0 && <div className="mt-1 text-muted">Available: {result.models.slice(0, 6).join(", ")}</div>}
    </div>
  );
}

function ModelsTab() {
  const config = useApp((s) => s.config);
  const refreshConfig = useApp((s) => s.refreshConfig);
  const toast = useApp((s) => s.toast);
  const [form, setForm] = useState(() => ({
    provider: config?.provider ?? "qwen",
    baseUrl: config?.baseUrl ?? "http://localhost:8000/v1",
    model: config?.model ?? QWEN_MODEL,
    apiKey: "",
    contextLength: config?.contextLength ?? 32768,
    temperature: config?.temperature ?? 0.7,
    topP: config?.topP ?? 0.8,
    topK: config?.topK ?? 20,
    repetitionPenalty: config?.repetitionPenalty ?? 1.05,
    maxIterations: config?.maxIterations ?? 30,
  }));
  const [remember, setRemember] = useState(true);
  const [test, setTest] = useState<ConnectionTest>();
  const [busy, setBusy] = useState(false);
  const preset = presetFor(form.provider, form.baseUrl);
  const num = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: Number(e.target.value) }));

  const save = async (): Promise<boolean> => {
    try {
      await api.updateConfig({ provider: form.provider, baseUrl: form.baseUrl, ...(form.model.trim() ? { model: form.model.trim() } : {}), contextLength: form.contextLength, temperature: form.temperature, topP: form.topP, topK: form.topK, repetitionPenalty: form.repetitionPenalty, maxIterations: form.maxIterations, ...(form.apiKey ? { apiKey: form.apiKey, rememberKey: remember && !!config?.canPersistKey } : {}) });
      await refreshConfig();
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    }
  };

  return (
    <form className="space-y-4" onSubmit={(e) => e.preventDefault()}>
      <fieldset>
        <legend className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-muted">Provider</legend>
        <div className="grid grid-cols-2 gap-1.5">
          {PROVIDER_PRESETS.map((p) => (
            <label key={p.id} className={clsx("flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5", preset.id === p.id ? "border-accent/60 bg-accent-dim" : "border-line hover:bg-hover")}>
              <input type="radio" name="provider" className="accent-[#e3a857]" checked={preset.id === p.id} onChange={() => setForm((f) => ({ ...f, provider: p.provider, baseUrl: p.baseUrl || f.baseUrl, model: p.id === "local" ? QWEN_MODEL : p.id === preset.id ? f.model : "" }))} />
              {p.label}
            </label>
          ))}
        </div>
        {preset.note && <p className="mt-1.5 text-[11.5px] text-faint">{preset.note}</p>}
      </fieldset>
      <Field label="Model">
        <input className={inputClass} list="bc-models" placeholder={preset.id === "local" ? QWEN_MODEL : "Click Test connection, then pick a model from the list"} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} aria-label="Model" />
        <datalist id="bc-models">{test?.models.map((m) => <option key={m} value={m} />)}</datalist>
      </Field>
      <Field label="Endpoint" hint="OpenAI-compatible base URL (it must serve POST /chat/completions).">
        <input className={inputClass} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} aria-label="Endpoint" />
      </Field>
      <div>
        <Field label="API key">
          <input className={inputClass} type="password" autoComplete="off" placeholder={config?.hasApiKey ? "••••••••  (a key is set; type to replace it)" : preset.needsKey ? "paste your key here" : "optional for local servers"} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} aria-label="API key" />
        </Field>
        <div className="mt-1.5 space-y-1 text-[11.5px] text-faint">
          {config?.canPersistKey ? (
            <label className="flex items-center gap-2 text-muted">
              <input type="checkbox" className="accent-[var(--color-accent)]" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember on this computer (encrypted for your Windows account, never saved as plain text)
            </label>
          ) : (
            <div>Keys are kept in memory until BetaCode closes. To keep one, set the BETA_CODE_API_KEY environment variable.</div>
          )}
          <div>
            {config?.keySource === "env" && "Using the BETA_CODE_API_KEY environment variable."}
            {config?.keySource === "saved" && "A saved (encrypted) key is used for this provider."}
            {config?.keySource === "session" && "A key is set for this session only."}
            {(!config?.keySource || config.keySource === "none") && (preset.needsKey ? "This provider needs a key." : "Local servers do not need a key.")}
            {config?.keySource === "saved" && (
              <button
                type="button"
                className="ml-2 text-bad hover:underline"
                onClick={async () => {
                  await api.updateConfig({ forgetKey: true });
                  await refreshConfig();
                  toast("Saved key removed", "success");
                }}
              >
                Forget saved key
              </button>
            )}
          </div>
          {preset.keyUrl && (
            <div>
              Need a key?{" "}
              <a className="text-accent underline" href={preset.keyUrl} target="_blank" rel="noreferrer">
                Create one at {new URL(preset.keyUrl).host}
              </a>
              . You create the account and key yourself. Your prompts and code are sent to this provider.
            </div>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Context" hint={config?.detectedContextLength ? `Server reports ${formatTokens(config.detectedContextLength)}` : undefined}>
          <select className={inputClass} value={form.contextLength} onChange={(e) => setForm({ ...form, contextLength: Number(e.target.value) })} aria-label="Context length">
            {[...new Set([...CONTEXT_OPTIONS, form.contextLength])].sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>
                {formatTokens(n)} ({n})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Temperature">
          <input className={inputClass} type="number" step="0.05" min="0" max="2" value={form.temperature} onChange={num("temperature")} aria-label="Temperature" />
        </Field>
        <Field label="top_p">
          <input className={inputClass} type="number" step="0.05" min="0" max="1" value={form.topP} onChange={num("topP")} aria-label="top_p" />
        </Field>
        <Field label="top_k">
          <input className={inputClass} type="number" step="1" min="0" value={form.topK} onChange={num("topK")} aria-label="top_k" />
        </Field>
        <Field label="Repetition penalty">
          <input className={inputClass} type="number" step="0.01" min="0.5" max="2" value={form.repetitionPenalty} onChange={num("repetitionPenalty")} aria-label="Repetition penalty" />
        </Field>
        <Field label="Max steps">
          <input className={inputClass} type="number" step="1" min="1" max="500" value={form.maxIterations} onChange={num("maxIterations")} aria-label="Max steps" />
        </Field>
      </div>
      <TestResult result={test} />
      <div className="flex gap-2">
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            if (await save()) setTest(await api.testConnection());
            setBusy(false);
          }}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />} Test connection
        </Button>
        <Button
          variant="primary"
          disabled={busy || !form.model.trim()} title={form.model.trim() ? undefined : "Choose a model first"}
          onClick={async () => {
            if (await save()) toast("Model settings saved", "success");
          }}
        >
          Save
        </Button>
      </div>
    </form>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-md border border-line bg-bg px-3 py-2 pr-9 font-mono text-[12px]">{text}</pre>
      <button
        aria-label="Copy command"
        className="absolute right-1.5 top-1.5 rounded p-1 text-faint hover:bg-hover hover:text-text"
        onClick={() => void navigator.clipboard?.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))}
      >
        {done ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
      </button>
    </div>
  );
}

function LocalTab() {
  const toast = useApp((s) => s.toast);
  const refreshConfig = useApp((s) => s.refreshConfig);
  const [status, setStatus] = useState<ConnectionTest>();
  const [checking, setChecking] = useState(true);

  const check = async () => {
    setChecking(true);
    setStatus(await api.testConnection().catch((e: Error) => ({ ok: false, latencyMs: 0, models: [], modelAvailable: false, error: e.message })));
    setChecking(false);
  };
  useEffect(() => void check(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const configure = async (r: RuntimeGuide) => {
    await api.updateConfig({ provider: "qwen", baseUrl: r.baseUrl, model: r.model });
    await refreshConfig();
    toast(`Configured for ${r.name}`, "success");
    void check();
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[14px] font-semibold">Local AI</h3>
        <p className="mt-1 leading-relaxed text-muted">
          BetaCode runs with local coding models through any OpenAI-compatible server. The recommended model is <span className="font-mono text-text">{QWEN_MODEL}</span>. BetaCode does not bundle or download model weights; the weights are available under the model's license, but you need suitable local hardware (or a paid inference provider) to run them.
        </p>
      </div>
      <div className="flex items-center gap-2" aria-live="polite">
        {checking ? <Loader2 size={14} className="animate-spin text-muted" /> : null}
        <TestResult result={status} />
        <Button variant="ghost" onClick={() => void check()} disabled={checking}>
          Check again
        </Button>
      </div>
      <SetupAdvisor />
      <h3 className="pt-2 text-[12px] font-semibold uppercase tracking-wide text-muted">Manual setup by runtime</h3>
      <div className="space-y-3">
        {RUNTIMES.map((r) => (
          <section key={r.id} className="rounded-lg border border-line p-3" aria-label={r.name}>
            <div className="flex items-center gap-2">
              <h4 className="font-semibold">{r.name}</h4>
              <span className="font-mono text-[11.5px] text-faint">{r.baseUrl}</span>
              <Button className="ml-auto" onClick={() => void configure(r)}>
                Configure for {r.name}
              </Button>
            </div>
            {r.steps.map((s) => (
              <p key={s} className="mt-1.5 text-[12px] text-muted">
                {s}
              </p>
            ))}
            <div className="mt-2 space-y-1.5">
              {r.commands.map((c) => (
                <CopyBlock key={c} text={c} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

const TOOL_NAMES = ["read_file", "write_file", "edit_file", "delete_file", "move_file", "copy_file", "create_directory", "run_command", "git_commit", "git_add", "git_checkout", "git_push", "git_pull", "git_branch"];

function PermissionsTab() {
  const config = useApp((s) => s.config);
  const refreshConfig = useApp((s) => s.refreshConfig);
  const toast = useApp((s) => s.toast);
  const [rules, setRules] = useState<Array<{ tool: string; decision: "allow" | "deny" }>>([]);
  const load = () => api.permissionRules().then(setRules, () => setRules([]));
  useEffect(() => void load(), []);

  const setOverride = async (tool: string, value: string) => {
    const perms = { ...(config?.permissions ?? {}) } as Record<string, string>;
    if (value === "default") delete perms[tool];
    else perms[tool] = value;
    try {
      await api.updateConfig({ permissions: perms });
      await refreshConfig();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-[14px] font-semibold">Permissions</h3>
        <p className="mt-1 text-muted">Safe actions run immediately, confirm actions ask first, dangerous actions always ask. Shell commands are classified individually and a dangerous command can never be relaxed here.</p>
      </div>
      <table className="w-full text-left text-[12.5px]">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-faint">
            <th className="py-1 font-medium">Tool</th>
            <th className="py-1 font-medium">Override</th>
          </tr>
        </thead>
        <tbody>
          {TOOL_NAMES.map((t) => (
            <tr key={t} className="border-t border-line">
              <td className="py-1.5 font-mono">{t}</td>
              <td className="py-1.5">
                <select aria-label={`Permission for ${t}`} className="rounded-md border border-line bg-raised px-1.5 py-1" value={config?.permissions?.[t] ?? "default"} onChange={(e) => void setOverride(t, e.target.value)}>
                  <option value="default">default</option>
                  <option value="safe">allow without asking</option>
                  <option value="confirm">ask</option>
                  <option value="dangerous">ask (dangerous)</option>
                  <option value="deny">never allow</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <h4 className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-muted">Remembered choices for this project</h4>
        {rules.length === 0 ? (
          <p className="text-faint">None. "Always allow" / "Always deny" in a permission prompt will appear here.</p>
        ) : (
          <ul>
            {rules.map((r) => (
              <li key={r.tool} className="flex items-center gap-2 border-t border-line py-1.5">
                <span className="font-mono">{r.tool}</span>
                <span className={r.decision === "allow" ? "text-ok" : "text-bad"}>{r.decision === "allow" ? "always allow" : "always deny"}</span>
                <button aria-label={`Forget ${r.tool}`} className="ml-auto text-faint hover:text-bad" onClick={() => void api.deletePermissionRule(r.tool).then(load)}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function DoctorTab() {
  const [checks, setChecks] = useState<DoctorCheck[]>();
  const [err, setErr] = useState<string>();
  const run = () => {
    setChecks(undefined);
    setErr(undefined);
    api.doctor().then((r) => setChecks(r.checks), (e: Error) => setErr(e.message));
  };
  useEffect(run, []);
  const icon = { ok: <Check size={14} className="text-ok" />, warn: <span className="w-3.5 text-center font-bold text-warn">!</span>, fail: <span className="w-3.5 text-center font-bold text-bad">✗</span> };
  return (
    <div className="space-y-3">
      <div className="flex items-center">
        <h3 className="text-[14px] font-semibold">Doctor</h3>
        <Button className="ml-auto" onClick={run}>
          Run again
        </Button>
      </div>
      {err && <p className="text-bad">{err}</p>}
      {!checks && !err && <Loader2 size={16} className="animate-spin text-muted" />}
      <ul>
        {checks?.map((c) => (
          <li key={c.name} className="flex items-start gap-2.5 border-t border-line py-1.5">
            <span className="mt-0.5">{icon[c.status]}</span>
            <span className="w-40 shrink-0 font-medium">{c.name}</span>
            <span className="min-w-0 break-words text-muted">{c.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AppearanceTab() {
  const appearance = useApp((st) => st.appearance);
  const setAppearance = useApp((st) => st.setAppearance);
  const Choice = <T extends string>({ value, current, onPick, label, hint }: { value: T; current: T; onPick: (v: T) => void; label: string; hint?: string }) => (
    <label className={clsx("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2", current === value ? "border-accent/60 bg-accent-dim" : "border-line hover:bg-hover")}>
      <input type="radio" className="accent-[var(--color-accent)]" checked={current === value} onChange={() => onPick(value)} />
      <span>{label}</span>
      {hint && <span className="ml-auto text-[11px] text-faint">{hint}</span>}
    </label>
  );
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-[14px] font-semibold">Appearance</h3>
        <p className="mt-1 text-muted">Saved on this computer. Applies immediately.</p>
      </div>
      <fieldset>
        <legend className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-muted">Theme</legend>
        <div className="grid grid-cols-3 gap-2">
          {THEMES.map((t) => (
            <button key={t.id} aria-pressed={appearance.theme === t.id} onClick={() => setAppearance({ theme: t.id })} className={clsx("rounded-lg border p-2 text-left", appearance.theme === t.id ? "border-accent/70" : "border-line hover:bg-hover")}>
              <span className="mb-2 flex h-10 overflow-hidden rounded-md border border-line">
                <span className="flex-1" style={{ background: t.swatch[0] }} />
                <span className="flex-1" style={{ background: t.swatch[1] }} />
                <span className="w-4" style={{ background: t.swatch[2] }} />
              </span>
              <span className="text-[12.5px]">{t.label}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-muted">Interface font</legend>
        <div className="grid grid-cols-2 gap-2">
          <Choice<FontId> value="mono" current={appearance.font} onPick={(font) => setAppearance({ font })} label="Monospace" hint="code-editor feel" />
          <Choice<FontId> value="sans" current={appearance.font} onPick={(font) => setAppearance({ font })} label="Sans-serif" hint="system font" />
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-muted">Density</legend>
        <div className="grid grid-cols-3 gap-2">
          <Choice<DensityId> value="compact" current={appearance.density} onPick={(density) => setAppearance({ density })} label="Compact" />
          <Choice<DensityId> value="comfortable" current={appearance.density} onPick={(density) => setAppearance({ density })} label="Comfortable" />
          <Choice<DensityId> value="spacious" current={appearance.density} onPick={(density) => setAppearance({ density })} label="Spacious" />
        </div>
      </fieldset>
    </div>
  );
}
