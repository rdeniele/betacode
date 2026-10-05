import { useApp } from "../stores/app";
import { OpenProjectForm } from "../components/OpenProjectDialog";

export function Welcome() {
  const connection = useApp((s) => s.connection);
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center">
      <div className="w-full max-w-xl px-6">
        <h1 className="text-[28px] font-bold tracking-tight">
          Beta<span className="text-accent">Code</span>
        </h1>
        <p className="mt-1 text-[14px] text-muted">AI coding agent for your projects.</p>
        {connection !== "online" ? (
          <div role="alert" className="mt-6 rounded-lg border border-warn/30 bg-warn/5 p-4">
            <div className="font-medium text-warn">{connection === "connecting" ? "Connecting to the BetaCode runtime…" : "The BetaCode runtime is not running."}</div>
            <p className="mt-1.5 text-muted">
              The desktop UI talks to a local runtime that owns the agent, tools and database. Start it from the repository root:
            </p>
            <pre className="mt-2 rounded-md border border-line bg-bg px-3 py-2 font-mono text-[12px]">pnpm server</pre>
          </div>
        ) : (
          <div className="mt-6 overflow-hidden rounded-xl border border-line bg-panel">
            <OpenProjectForm />
          </div>
        )}
      </div>
    </main>
  );
}
