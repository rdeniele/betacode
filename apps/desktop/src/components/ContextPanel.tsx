import { useApp } from "../stores/app";
import { formatTokens } from "./ui";

export function estimateCost(usage: { inputTokens: number; outputTokens: number }, pricing?: { inputPerMillion: number; outputPerMillion: number }): string | undefined {
  if (!pricing) return undefined; // never invent pricing
  const usd = (usage.inputTokens / 1e6) * pricing.inputPerMillion + (usage.outputTokens / 1e6) * pricing.outputPerMillion;
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

function Row({ k, v }: { k: string; v?: string | string[] }) {
  const text = Array.isArray(v) ? v.join(", ") : v;
  if (!text) return null;
  return (
    <div className="flex gap-3 py-0.5">
      <dt className="w-24 shrink-0 text-faint">{k}</dt>
      <dd className="min-w-0 flex-1 break-words">{text}</dd>
    </div>
  );
}

export function ContextPanel() {
  const { project, usage, config } = useApp();
  const cost = estimateCost(usage, config?.pricing);
  const limit = usage.contextLimit || config?.contextLength || 0;
  const pct = limit ? Math.min(100, Math.round((usage.contextTokens / limit) * 100)) : 0;
  if (!project) return <div className="p-4 text-faint">No project open.</div>;
  const i = project.info;
  return (
    <div className="space-y-5 overflow-auto p-4">
      <section aria-label="Model usage">
        <h3 className="mb-2 text-[11.5px] uppercase tracking-wide text-faint">Model</h3>
        <div className="font-mono text-[12.5px]">{config?.model}</div>
        <div className="mt-2.5">
          <div className="flex justify-between text-[12px] text-muted">
            <span>Context</span>
            <span data-testid="context-usage">
              {formatTokens(usage.contextTokens)} / {limit ? formatTokens(limit) : "—"}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded bg-raised" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className={pct > 85 ? "h-full bg-bad" : pct > 65 ? "h-full bg-warn" : "h-full bg-accent"} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <dl className="mt-3 text-[12px]">
          <Row k="Input" v={formatTokens(usage.inputTokens)} />
          <Row k="Output" v={formatTokens(usage.outputTokens)} />
          <Row k="Steps" v={String(usage.steps)} />
          <Row k="Est. cost" v={cost} />
        </dl>
        {!cost && config?.provider !== "qwen" && <p className="mt-1 text-[11.5px] text-faint">Set pricing in config to see an estimated cost.</p>}
      </section>
      <section aria-label="Project summary">
        <h3 className="mb-2 text-[11.5px] uppercase tracking-wide text-faint">Project</h3>
        <dl className="text-[12px]">
          <Row k="Name" v={i.name} />
          <Row k="Languages" v={i.languages} />
          <Row k="Frameworks" v={i.frameworks} />
          <Row k="Package mgr" v={i.packageManager} />
          <Row k="Database" v={i.database} />
          <Row k="ORM" v={i.orm} />
          <Row k="Auth" v={i.auth} />
          <Row k="Tests" v={i.testFrameworks} />
          <Row k="Entry points" v={i.entryPoints} />
          <Row k="Git" v={project.git.isRepo ? (project.git.branch ?? "detached") : "not a repository"} />
        </dl>
        {i.commands.length > 0 && (
          <div className="mt-2">
            <div className="mb-1 text-faint">Detected commands</div>
            <ul className="font-mono text-[12px]">
              {i.commands.map((c) => (
                <li key={c.name} className="flex gap-3">
                  <span className="w-20 shrink-0 text-faint">{c.name}</span>
                  <span>{c.command}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <section aria-label="Instructions">
        <h3 className="mb-2 text-[11.5px] uppercase tracking-wide text-faint">Project instructions</h3>
        {project.instructionFiles.length ? (
          <ul className="font-mono text-[12px]">
            {project.instructionFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">No BETACODE.md found. Run <code className="font-mono">/init</code> to create one.</p>
        )}
      </section>
    </div>
  );
}
