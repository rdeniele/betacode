import { useEffect } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { StatusBar, Toasts, TopBar } from "./components/Chrome";
import { OpenProjectDialog } from "./components/OpenProjectDialog";
import { CommandPalette, QuickOpen, SearchDialog } from "./components/Palettes";
import { RightPanel } from "./components/RightPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { useShortcuts } from "./hooks/useShortcuts";
import { Welcome } from "./pages/Welcome";
import { useApp } from "./stores/app";

export function App() {
  const project = useApp((s) => s.project);
  const dialog = useApp((s) => s.dialog);
  const terminalOpen = useApp((s) => s.terminalOpen);
  useShortcuts();
  useEffect(() => useApp.getState().init(), []);

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      {project ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <Sidebar />
            <ChatPanel />
            <RightPanel />
          </div>
          {terminalOpen && <TerminalPanel />}
        </div>
      ) : (
        <Welcome />
      )}
      <StatusBar />
      {dialog === "open-project" && <OpenProjectDialog />}
      {dialog === "settings" && <SettingsDialog />}
      {dialog === "palette" && <CommandPalette />}
      {dialog === "quick-open" && <QuickOpen />}
      {dialog === "search" && <SearchDialog />}
      <Toasts />
    </div>
  );
}
