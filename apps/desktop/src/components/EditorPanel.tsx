import clsx from "clsx";
import { Lock, X } from "lucide-react";
import { lazy, Suspense } from "react";
import { useApp } from "../stores/app";
import { Kbd } from "./ui";

const MonacoEditor = lazy(async () => {
  await import("../lib/monaco");
  const m = await import("@monaco-editor/react");
  return { default: m.default };
});

export function EditorPanel() {
  const { tabs, activeTab, changes, running } = useApp();
  const { set, closeTab, editTab, saveTab } = useApp.getState();
  const tab = tabs.find((t) => t.path === activeTab);
  // The file is read-only while the agent is actively modifying it.
  const locked = !!tab && running && changes.some((c) => c.path === tab.path && c.status === "pending");

  if (!tabs.length) return <div className="p-4 text-faint">Open a file from the project tree. <Kbd>Ctrl</Kbd>+<Kbd>P</Kbd> finds files by name.</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" className="flex shrink-0 overflow-x-auto border-b border-line bg-panel">
        {tabs.map((t) => (
          <div key={t.path} role="tab" aria-selected={t.path === activeTab} className={clsx("group flex shrink-0 items-center gap-1.5 border-r border-line px-3 py-1.5", t.path === activeTab ? "bg-bg text-text" : "text-muted hover:text-text")}>
            <button className="max-w-[160px] truncate font-mono text-[12px]" onClick={() => set({ activeTab: t.path })} title={t.path}>
              {t.path.split("/").pop()}
              {t.content !== t.saved && <span className="ml-1 text-accent" aria-label="unsaved changes">●</span>}
            </button>
            <button aria-label={`Close ${t.path}`} className="text-faint hover:text-text" onClick={() => closeTab(t.path)}>
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      {tab && (
        <>
          <div className="flex items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-faint">
            <span className="truncate font-mono">{tab.path}</span>
            {locked && (
              <span className="flex items-center gap-1 text-warn">
                <Lock size={11} /> read-only while BetaCode edits
              </span>
            )}
            <span className="ml-auto">{tab.language}</span>
            {tab.content !== tab.saved && (
              <button className="text-accent hover:underline" onClick={() => void saveTab(tab.path)}>
                Save <Kbd>Ctrl+S</Kbd>
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1">
            <Suspense fallback={<div className="p-4 text-faint">Loading editor…</div>}>
              <MonacoEditor
                height="100%"
                path={tab.path}
                language={tab.language === "typescriptreact" ? "typescript" : tab.language === "javascriptreact" ? "javascript" : tab.language}
                value={tab.content}
                theme="betacode-dark"
                onChange={(v) => editTab(tab.path, v ?? "")}
                onMount={(editor, monaco) => editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void useApp.getState().saveTab(tab.path))}
                options={{ readOnly: locked, minimap: { enabled: false }, fontSize: 12.5, fontFamily: "ui-monospace, Cascadia Code, Consolas, monospace", scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, renderWhitespace: "none", padding: { top: 8 } }}
              />
            </Suspense>
          </div>
        </>
      )}
    </div>
  );
}
