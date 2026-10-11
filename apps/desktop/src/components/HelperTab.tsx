import clsx from "clsx";
import { Loader2, LifeBuoy } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { PROVIDER_PRESETS } from "../lib/presets";
import type { ConnectionTest } from "../lib/types";
import { useApp } from "../stores/app";
import { Button, Field, inputClass } from "./ui";
import { TestResult } from "./SettingsDialog";

const HOSTED = PROVIDER_PRESETS.filter((p) => p.id !== "local");

/** Settings for the optional stronger "helper" model that can take over when the local model is stuck. */
export function HelperTab() {
  const config = useApp((s) => s.config);
  const refreshConfig = useApp((s) => s.refreshConfig);
  const toast = useApp((s) => s.toast);
  const t = config?.teacher;
  const initialPreset = HOSTED.find((p) => p.baseUrl === t?.baseUrl) ?? (t ? HOSTED.find((p) => p.id === "custom")! : HOSTED[0]!);
  const [enabled, setEnabled] = useState(t?.enabled ?? true);
  const [presetId, setPresetId] = useState(initialPreset.id);
  const [baseUrl, setBaseUrl] = useState(t?.baseUrl ?? initialPreset.baseUrl);
  const [model, setModel] = useState(t?.model ?? "");
  const [key, setKey] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<ConnectionTest>();
  const preset = HOSTED.find((p) => p.id === presetId) ?? HOSTED[0]!;

  const save = async (): Promise<boolean> => {
    try {
      await api.updateConfig({
        teacher: { enabled, provider: preset.provider === "qwen" ? "openai-compatible" : preset.provider, baseUrl, model: model.trim() },
        ...(key ? { teacherKey: key, rememberTeacherKey: remember && !!config?.canPersistKey } : {}),
      });
      setKey("");
      await refreshConfig();
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    }
  };

  return (
    <form className="space-y-4" onSubmit={(e) => e.preventDefault()}>
      <div>
        <h3 className="flex items-center gap-2 text-[14px] font-semibold">
          <LifeBuoy size={15} className="text-accent" /> Helper model (optional)
        </h3>
        <p className="mt-1 leading-relaxed text-muted">
          A small local model sometimes gets stuck: the same failing step again and again, or checks that keep failing. If you set up a stronger hosted model here, BetaCode can <strong>ask you</strong> whether it should take over for the rest of that task. You approve each time, and the whole conversation, including the contents of files it has read, is sent to that provider.
        </p>
      </div>

      <label className="flex items-center gap-2">
        <input type="checkbox" className="accent-[var(--color-accent)]" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Offer to escalate to the helper when the main model is stuck
      </label>

      <fieldset>
        <legend className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-muted">Provider</legend>
        <div className="grid grid-cols-2 gap-1.5">
          {HOSTED.map((p) => (
            <label key={p.id} className={clsx("flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5", presetId === p.id ? "border-accent/60 bg-accent-dim" : "border-line hover:bg-hover")}>
              <input
                type="radio"
                name="helper-provider"
                className="accent-[var(--color-accent)]"
                checked={presetId === p.id}
                onChange={() => {
                  setPresetId(p.id);
                  if (p.baseUrl) setBaseUrl(p.baseUrl);
                  if (p.id !== presetId) setModel("");
                }}
              />
              {p.label}
            </label>
          ))}
        </div>
        {preset.note && <p className="mt-1.5 text-[11.5px] text-faint">{preset.note}</p>}
      </fieldset>

      <Field label="Endpoint">
        <input className={inputClass} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} aria-label="Helper endpoint" />
      </Field>
      <Field label="Model">
        <input className={inputClass} list="bc-helper-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Click Test, then pick a model from the list" aria-label="Helper model" />
        <datalist id="bc-helper-models">{test?.models.map((m) => <option key={m} value={m} />)}</datalist>
      </Field>

      <div>
        <Field label="API key">
          <input className={inputClass} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Helper API key" placeholder={config?.teacherKeySource && config.teacherKeySource !== "none" ? "••••••••  (a key is set; type to replace it)" : "paste your key here"} />
        </Field>
        <div className="mt-1.5 space-y-1 text-[11.5px] text-faint">
          {config?.canPersistKey && (
            <label className="flex items-center gap-2 text-muted">
              <input type="checkbox" className="accent-[var(--color-accent)]" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember on this computer (encrypted for your Windows account)
            </label>
          )}
          <div>
            {config?.teacherKeySource === "env" && "Using the BETA_CODE_TEACHER_API_KEY environment variable."}
            {config?.teacherKeySource === "saved" && "A saved (encrypted) key is used."}
            {config?.teacherKeySource === "session" && "A key is set for this session only."}
            {(!config?.teacherKeySource || config.teacherKeySource === "none") && "A hosted helper needs a key."}
            {config?.teacherKeySource === "saved" && (
              <button
                type="button"
                className="ml-2 text-bad hover:underline"
                onClick={async () => {
                  await api.updateConfig({ forgetTeacherKey: true });
                  await refreshConfig();
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
              . You create the account and key yourself.
            </div>
          )}
        </div>
      </div>

      <TestResult result={test} />
      <div className="flex items-center gap-2">
        <Button
          disabled={busy || !baseUrl}
          onClick={async () => {
            setBusy(true);
            // Tests what is typed in the form, without saving it.
            setTest(await api.testTeacher({ baseUrl, provider: preset.provider === "qwen" ? "openai-compatible" : preset.provider, model: model.trim() || undefined, apiKey: key || undefined }).catch((e: Error) => ({ ok: false, latencyMs: 0, models: [], modelAvailable: false, error: e.message })));
            setBusy(false);
          }}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : null} Test helper
        </Button>
        <Button
          variant="primary"
          disabled={busy || !model.trim()}
          title={model.trim() ? undefined : "Choose a model first"}
          onClick={async () => {
            if (await save()) toast("Helper model saved", "success");
          }}
        >
          Save
        </Button>
        {config?.teacher && (
          <span className={clsx("ml-auto text-[12px]", config.teacherReady ? "text-ok" : "text-warn")}>{config.teacherReady ? "Ready" : "Not ready: needs a key or is turned off"}</span>
        )}
      </div>
    </form>
  );
}
