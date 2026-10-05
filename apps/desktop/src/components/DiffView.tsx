import clsx from "clsx";

/** Renders a unified diff with +/- colouring. Shows exactly what the runtime produced; nothing is synthesised. */
export function DiffView({ diff, maxHeight = "none" }: { diff: string; maxHeight?: string }) {
  if (!diff.trim()) return <div className="px-3 py-2 text-faint">No textual changes.</div>;
  const lines = diff.split("\n");
  return (
    <pre className="overflow-auto font-mono text-[12px] leading-[1.55]" style={{ maxHeight }} data-testid="diff">
      {lines.map((l, i) => {
        const kind = l.startsWith("@@") ? "hunk" : l.startsWith("+++") || l.startsWith("---") ? "meta" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx";
        return (
          <div
            key={i}
            data-kind={kind}
            className={clsx(
              "whitespace-pre px-3",
              kind === "add" && "bg-ok/10 text-ok",
              kind === "del" && "bg-bad/10 text-bad",
              kind === "hunk" && "bg-info/5 text-info",
              kind === "meta" && "text-faint",
              kind === "ctx" && "text-muted",
            )}
          >
            {l || " "}
          </div>
        );
      })}
    </pre>
  );
}
