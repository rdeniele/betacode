import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OVERVIEW = {
  hardware: { os: "win32", cpu: "AMD Ryzen 7", cores: 16, ramGB: 23.4, gpus: [{ name: "NVIDIA RTX 3050 Laptop", vramGB: 4, vendor: "nvidia" }], unified: false },
  recommendation: {
    best: { model: { tag: "qwen3:4b-instruct", label: "Qwen3 4B Instruct", sizeGB: 2.5, thinking: false, quality: 4, note: "Small and fast." }, contextLength: 8192, memoryNeededGB: 3.7, placement: "split", gpuFraction: 0.86, tokensPerSec: 6.1, level: "good", score: 2.5, warnings: ["Does not fit entirely in GPU memory; part runs on the CPU, which is much slower."] },
    options: [
      { model: { tag: "qwen3:4b-instruct", label: "Qwen3 4B Instruct", sizeGB: 2.5, thinking: false, quality: 4, note: "Small and fast." }, contextLength: 8192, memoryNeededGB: 3.7, placement: "split", gpuFraction: 0.86, tokensPerSec: 6.1, level: "good", score: 2.5, warnings: ["Does not fit entirely in GPU memory; part runs on the CPU, which is much slower."] },
      { model: { tag: "qwen3-coder:30b", label: "Qwen3-Coder 30B-A3B", sizeGB: 19, thinking: false, quality: 8, note: "Big." }, contextLength: 8192, memoryNeededGB: 20, placement: "split", gpuFraction: 0.16, tokensPerSec: 2.5, level: "slow", score: 1.6, warnings: [] },
    ],
  },
  ollama: { installed: true, running: true, version: "0.35.1", models: [], loadedContext: 4096 },
};

vi.mock("../lib/api", () => ({
  api: {
    updateConfig: vi.fn(async () => ({})),
    config: vi.fn(async () => ({})),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 12, models: ["Qwen/Qwen3-Coder-30B-A3B-Instruct"], modelAvailable: true, contextLength: 65536 })),
    permissionRules: vi.fn(async () => [{ tool: "write_file", decision: "allow" }]),
    deletePermissionRule: vi.fn(async () => ({})),
    tree: vi.fn(async () => ({ name: ".", path: ".", type: "dir", children: [] })),
    testTeacher: vi.fn(async () => ({ ok: true, latencyMs: 5, models: ["gem-1", "gem-2"], modelAvailable: false })),
    setupOverview: vi.fn(async () => OVERVIEW),
    setupApplyEnv: vi.fn(async () => ({ result: { applied: ["OLLAMA_CONTEXT_LENGTH=8192"], manual: [] } })),
    setupPull: vi.fn(async () => ({ started: true })),
    setupCancelPull: vi.fn(async () => ({ cancelled: true })),
    setupUse: vi.fn(async () => ({})),
    doctor: vi.fn(async () => ({ checks: [{ name: "Node.js", status: "ok", detail: "v24" }, { name: "AI endpoint", status: "fail", detail: "down" }] })),
    acceptChange: vi.fn(async (_s: string, id: string) => ({ id, path: "src/a.ts", kind: "modified", status: "accepted", turn: 1, additions: 1, deletions: 1, diff: "" })),
    revertChange: vi.fn(async (_s: string, id: string) => ({ id, path: "src/a.ts", kind: "modified", status: "reverted", turn: 1, additions: 1, deletions: 1, diff: "" })),
    changes: vi.fn(async () => []),
    createSession: vi.fn(async () => ({ id: "new", title: "New session", mode: "code", updatedAt: new Date().toISOString() })),
    sessions: vi.fn(async () => []),
    session: vi.fn(async (id: string) => ({ session: { id, title: "New session", mode: "code" }, messages: [], toolCalls: [], changes: [], running: false, plan: [], pendingPermissions: [], usage: { inputTokens: 0, outputTokens: 0 } })),
    renameSession: vi.fn(async () => ({})),
    deleteSession: vi.fn(async () => ({})),
    duplicateSession: vi.fn(),
    gitStatus: vi.fn(async () => ({ status: null })),
  },
  ApiError: class extends Error {},
  subscribeEvents: () => () => {},
}));

import { api } from "../lib/api";
import { useApp } from "../stores/app";
import { ChangesPanel } from "./ChangesPanel";
import { Composer, slashSuggestions } from "./Composer";
import { PermissionCard } from "./PermissionCard";
import { SessionList } from "./SessionList";
import { SettingsDialog } from "./SettingsDialog";
import { ToolCard } from "./ToolCard";
import { Hero } from "./Hero";
import { Sidebar } from "./Sidebar";
import { RightPanel } from "./RightPanel";
import { SetupAdvisor } from "./SetupAdvisor";
import { applyAppearance, DEFAULT_APPEARANCE, loadAppearance, saveAppearance } from "../lib/appearance";
import { formatTokens } from "./ui";

beforeEach(() => {
  useApp.setState({ rightPanelOpen: false, rightTab: "changes" });
  vi.clearAllMocks();
  useApp.setState({ changes: [], sessions: [], activeId: "s1", running: false, dialog: "settings", settingsTab: "models", toasts: [], config: { provider: "qwen", model: "Qwen/Qwen3-Coder-30B-A3B-Instruct", baseUrl: "http://localhost:8000/v1", hasApiKey: false, temperature: 0.7, topP: 0.8, topK: 20, repetitionPenalty: 1.05, contextLength: 32768, maxIterations: 30, maxRetries: 5, autoCompact: true, permissions: {} } });
});

describe("details panel", () => {
  it("gives chat the space by default and closes on request", async () => {
    const user = userEvent.setup();
    const view = render(<RightPanel />);
    expect(screen.queryByRole("complementary", { name: "Details" })).not.toBeInTheDocument();
    act(() => useApp.setState({ rightPanelOpen: true }));
    view.rerender(<RightPanel />);
    expect(screen.getByRole("complementary", { name: "Details" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close details panel" }));
    expect(screen.queryByRole("complementary", { name: "Details" })).not.toBeInTheDocument();
  });

  it("opens details from the sidebar and keeps tab switching available", async () => {
    const user = userEvent.setup();
    useApp.setState({ sidebarOpen: true });
    render(<><Sidebar /><RightPanel /></>);
    await user.click(screen.getByRole("button", { name: "Changes" }));
    expect(useApp.getState().rightPanelOpen).toBe(true);
    await user.click(screen.getByRole("tab", { name: "Context" }));
    expect(useApp.getState().rightTab).toBe("context");
  });
});

describe("PermissionCard", () => {
  const base = { id: "r1", tool: "run_command", summary: "npm install @supabase/ssr", riskLevel: "confirm" as const, grantKey: "k" };

  it("shows what BetaCode wants to do and offers the decisions", async () => {
    const onDecide = vi.fn();
    render(<PermissionCard request={base} onDecide={onDecide} />);
    expect(screen.getByText(/BetaCode wants to run/)).toBeInTheDocument();
    expect(screen.getByText("npm install @supabase/ssr")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Allow once" }));
    await user.click(screen.getByRole("button", { name: "Allow for session" }));
    await user.click(screen.getByRole("button", { name: "Always allow this tool" }));
    await user.click(screen.getByRole("button", { name: "Deny" }));
    await user.click(screen.getByRole("button", { name: "Always deny" }));
    expect(onDecide.mock.calls.map((c) => c[1])).toEqual(["allow_once", "allow_session", "always_allow", "deny", "always_deny"]);
  });

  it("dangerous requests are labelled, show the reason, and cannot be blanket-allowed", () => {
    render(<PermissionCard request={{ ...base, tool: "run_command", summary: "rm -rf node_modules", riskLevel: "dangerous", reason: "recursively/forcibly deletes files" }} onDecide={vi.fn()} />);
    expect(screen.getByText("dangerous")).toBeInTheDocument();
    expect(screen.getByText(/forcibly deletes/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Always allow this tool" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /this exact action/ })).toBeInTheDocument();
  });

  it("renders a diff preview for file changes", () => {
    render(<PermissionCard request={{ ...base, tool: "edit_file", summary: "Edit src/a.ts", detail: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;" }} onDecide={vi.fn()} />);
    const diff = screen.getByTestId("diff");
    expect(within(diff).getByText("-const a = 1;")).toHaveAttribute("data-kind", "del");
    expect(within(diff).getByText("+const a = 2;")).toHaveAttribute("data-kind", "add");
  });
});

describe("ChangesPanel", () => {
  const change = (id: string, path: string, status: "pending" | "accepted" | "reverted" = "pending") => ({ id, path, kind: "modified" as const, status, turn: 1, additions: 2, deletions: 1, diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+y` });

  it("summarises changed files and shows a diff on selection", async () => {
    useApp.setState({ changes: [change("1", "src/a.ts"), change("2", "src/b.ts")] });
    render(<ChangesPanel />);
    expect(screen.getByTestId("changes-summary")).toHaveTextContent("2 files changed");
    await userEvent.setup().click(screen.getByText("src/b.ts"));
    expect(useApp.getState().selectedChange).toBe("2");
  });

  it("accepts and reverts changes through the API", async () => {
    useApp.setState({ changes: [change("1", "src/a.ts")], selectedChange: "1" });
    const user = userEvent.setup();
    render(<ChangesPanel />);
    expect(screen.getByTestId("diff")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept src/a.ts" }));
    await waitFor(() => expect(api.acceptChange).toHaveBeenCalledWith("s1", "1"));
    await waitFor(() => expect(useApp.getState().changes[0]!.status).toBe("accepted"));
  });

  it("rejecting reverts the file; reverted changes are no longer counted", async () => {
    useApp.setState({ changes: [change("1", "src/a.ts")], selectedChange: "1" });
    render(<ChangesPanel />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(api.revertChange).toHaveBeenCalledWith("s1", "1"));
    await waitFor(() => expect(screen.getByTestId("changes-summary")).toHaveTextContent("No changes yet"));
  });

  it("disables revert while the agent is running", () => {
    useApp.setState({ changes: [change("1", "src/a.ts")], running: true });
    render(<ChangesPanel />);
    expect(screen.getByRole("button", { name: "Revert src/a.ts" })).toBeDisabled();
  });
});

describe("Composer", () => {
  it("suggests slash commands and completes them", async () => {
    expect(slashSuggestions("/co").map((c) => c.name)).toEqual(["/compact"]);
    expect(slashSuggestions("hello")).toEqual([]);
    expect(slashSuggestions("/init extra")).toEqual([]);
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer running={false} mode="code" onMode={vi.fn()} onSend={onSend} onStop={vi.fn()} />);
    const box = screen.getByLabelText("Message BetaCode");
    await user.type(box, "/com");
    expect(screen.getByRole("option", { name: /\/compact/ })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(box).toHaveValue("/compact ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends on Enter, keeps newlines on Shift+Enter, and clears the box", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer running={false} mode="code" onMode={vi.fn()} onSend={onSend} onStop={vi.fn()} />);
    const box = screen.getByLabelText("Message BetaCode");
    await user.type(box, "line one{Shift>}{Enter}{/Shift}line two");
    expect(box).toHaveValue("line one\nline two");
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("line one\nline two");
    expect(box).toHaveValue("");
  });

  it("shows Stop while running and Esc stops", async () => {
    const onStop = vi.fn();
    const user = userEvent.setup();
    render(<Composer running mode="code" onMode={vi.fn()} onSend={vi.fn()} onStop={onStop} />);
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await user.type(screen.getByLabelText("Message BetaCode"), "{Escape}");
    expect(onStop).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
  });

  it("switches between Agent and Chat, and reaches the other modes from the menu", async () => {
    const onMode = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Composer running={false} mode="code" onMode={onMode} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(onMode).toHaveBeenLastCalledWith("ask");
    await user.click(screen.getByRole("button", { name: "More modes" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Plan/ }));
    expect(onMode).toHaveBeenLastCalledWith("plan");
    rerender(<Composer running={false} mode="plan" onMode={onMode} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Plan" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the current model and lets you pick another one the endpoint reports", async () => {
    const setModel = vi.fn();
    useApp.setState({ availableModels: ["qwen3:4b-instruct", "qwen3:8b"], setModel: setModel as never, refreshModels: vi.fn(async () => {}) as never });
    const user = userEvent.setup();
    render(<Composer running={false} mode="code" onMode={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Model: Qwen/ }));
    await user.click(screen.getByRole("option", { name: /qwen3:8b/ }));
    expect(setModel).toHaveBeenCalledWith("qwen3:8b");
  });

  it("is disabled without a project", () => {
    render(<Composer running={false} disabled mode="code" onMode={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByLabelText("Message BetaCode")).toBeDisabled();
  });
});

describe("SessionList", () => {
  it("creates a new session", async () => {
    render(<SessionList />);
    await userEvent.setup().click(screen.getByRole("button", { name: "New session" }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalled());
    await waitFor(() => expect(useApp.getState().activeId).toBe("new"));
  });

  it("lists sessions, highlights the active one and renames inline", async () => {
    const now = new Date().toISOString();
    vi.mocked(api.sessions).mockResolvedValue([
      { id: "s1", title: "Fix authentication", updatedAt: now },
      { id: "s2", title: "Build dashboard", updatedAt: now },
    ] as never);
    useApp.setState({ sessions: [{ id: "s1", title: "Fix authentication", updatedAt: now }, { id: "s2", title: "Build dashboard", updatedAt: now }] as never });
    render(<SessionList />);
    expect(screen.getByText("Fix authentication")).toBeInTheDocument();
    expect(screen.getByText("Build dashboard")).toBeInTheDocument();
    const user = userEvent.setup();
    const [rename] = screen.getAllByRole("button", { name: "Rename session" });
    await user.click(rename!);
    const input = screen.getByLabelText("Session title");
    await user.clear(input);
    await user.type(input, "Login bug{Enter}");
    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith("s1", "Login bug"));
  });
});

describe("SettingsDialog: model configuration", () => {
  it("shows the Qwen3-Coder defaults", () => {
    render(<SettingsDialog />);
    expect(screen.getByLabelText("Model")).toHaveValue("Qwen/Qwen3-Coder-30B-A3B-Instruct");
    expect(screen.getByLabelText("Endpoint")).toHaveValue("http://localhost:8000/v1");
    expect(screen.getByLabelText("Temperature")).toHaveValue(0.7);
    expect(screen.getByLabelText("top_k")).toHaveValue(20);
    expect(screen.getByRole("radio", { name: "Local (Qwen3-Coder)" })).toBeChecked();
    expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password");
  });

  it("saves edits (including the API key) and reports a successful connection test", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog />);
    const ep = screen.getByLabelText("Endpoint");
    await user.clear(ep);
    await user.type(ep, "http://localhost:11434/v1");
    await user.type(screen.getByLabelText("API key"), "local-key");
    await user.click(screen.getByRole("button", { name: /Test connection/ }));
    await waitFor(() => expect(api.updateConfig).toHaveBeenCalled());
    const patch = vi.mocked(api.updateConfig).mock.calls[0]![0] as Record<string, unknown>;
    expect(patch).toMatchObject({ baseUrl: "http://localhost:11434/v1", provider: "qwen", apiKey: "local-key", topK: 20 });
    expect(await screen.findByText(/Connected — model available/)).toBeInTheDocument();
  });

  it("shows unreachable endpoints clearly", async () => {
    vi.mocked(api.testConnection).mockResolvedValueOnce({ ok: false, latencyMs: 5, models: [], modelAvailable: false, error: "Cannot reach model endpoint" });
    render(<SettingsDialog />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Test connection/ }));
    expect(await screen.findByText(/Not reachable: Cannot reach model endpoint/)).toBeInTheDocument();
  });

  it("switching provider presets updates provider and endpoint", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog />);
    await user.click(screen.getByRole("radio", { name: "OpenRouter" }));
    expect(screen.getByLabelText("Endpoint")).toHaveValue("https://openrouter.ai/api/v1");
    await user.click(screen.getByRole("radio", { name: "Anthropic" }));
    expect(screen.getByLabelText("Endpoint")).toHaveValue("https://api.anthropic.com/v1");
    expect(screen.getByText(/native Messages API is not implemented/)).toBeInTheDocument();
  });

  it("local AI tab explains setup, runs a check, and configures a runtime", async () => {
    useApp.setState({ settingsTab: "local" });
    const user = userEvent.setup();
    render(<SettingsDialog />);
    expect(screen.getByText(/does not bundle or download model weights/)).toBeInTheDocument();
    expect(await screen.findByText(/Connected — model available/)).toBeInTheDocument();
    expect(screen.getByText(/--tool-call-parser qwen3_coder/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Configure for Ollama" }));
    await waitFor(() => expect(api.updateConfig).toHaveBeenCalledWith({ provider: "qwen", baseUrl: "http://localhost:11434/v1", model: "qwen3-coder:30b" }));
  });

  it("permissions tab edits overrides and forgets remembered choices", async () => {
    useApp.setState({ settingsTab: "permissions" });
    const user = userEvent.setup();
    render(<SettingsDialog />);
    await user.selectOptions(screen.getByLabelText("Permission for delete_file"), "deny");
    await waitFor(() => expect(api.updateConfig).toHaveBeenCalledWith({ permissions: { delete_file: "deny" } }));
    await user.click(await screen.findByRole("button", { name: "Forget write_file" }));
    expect(api.deletePermissionRule).toHaveBeenCalledWith("write_file");
  });

  it("doctor tab lists real check results", async () => {
    useApp.setState({ settingsTab: "doctor" });
    render(<SettingsDialog />);
    expect(await screen.findByText("Node.js")).toBeInTheDocument();
    expect(screen.getByText("down")).toBeInTheDocument();
  });
});

describe("ToolCard", () => {
  it("shows an inline diff for edits and the exit code for failed commands", async () => {
    const user = userEvent.setup();
    const first = render(<ToolCard item={{ kind: "tool", id: "1", name: "edit_file", args: { path: "a.ts" }, status: "ok", output: "", content: "Edited a.ts (1 replacement).\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y", durationMs: 5 }} />);
    await user.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByTestId("diff")).toBeInTheDocument();
    first.unmount();
    render(<ToolCard item={{ kind: "tool", id: "2", name: "run_command", args: { command: "npm test" }, status: "failed", output: "", content: "$ npm test\nexit code: 1  duration: 90ms\n--- stderr ---\nboom", durationMs: 90 }} />);
    expect(screen.getByLabelText("failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/exit code: 1/)).toBeInTheDocument();
  });
});

describe("formatTokens", () => {
  it("formats context sizes the way users expect", () => {
    expect(formatTokens(32768)).toBe("32K");
    expect(formatTokens(262144)).toBe("256K");
    expect(formatTokens(42_000)).toBe("42K");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});

describe("Hero (welcome screen)", () => {
  it("shows the brand, tagline, project chip and quick starts that send a prompt in the right mode", async () => {
    useApp.setState({ project: { info: { name: "demo-api" }, git: { branch: "main" } } as never, activeId: "s1", modelStatus: "connected" });
    const onSend = vi.fn();
    const onMode = vi.fn();
    render(<Hero running={false} mode="code" onMode={onMode} onSend={onSend} onStop={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /Beta\s?Code/ })).toBeInTheDocument();
    expect(screen.getByText("AI coding agent for your projects.")).toBeInTheDocument();
    expect(screen.getByText(/demo-api/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Explain this project" }));
    expect(onMode).toHaveBeenCalledWith("ask");
    expect(onSend).toHaveBeenCalledWith(expect.stringMatching(/tour of this project/));
  });

  it("points to local AI setup when no model is reachable", async () => {
    useApp.setState({ project: { info: { name: "p" }, git: {} } as never, activeId: "s1", modelStatus: "unreachable" });
    render(<Hero running={false} mode="code" onMode={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /No model connected/ }));
    expect(useApp.getState()).toMatchObject({ dialog: "settings", settingsTab: "local" });
  });
});

describe("Sidebar", () => {
  it("collapses to a rail and expands again", async () => {
    useApp.setState({ sidebarOpen: true, project: { info: { name: "demo", root: "/x" }, git: {} } as never, modelStatus: "connected", changes: [] });
    const user = userEvent.setup();
    render(<Sidebar />);
    expect(screen.getByRole("button", { name: /New session/ })).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(useApp.getState().sidebarOpen).toBe(false);
  });

  it("shows the number of pending changes and opens the right panels", async () => {
    useApp.setState({ sidebarOpen: true, project: { info: { name: "demo", root: "/x" }, git: {} } as never, changes: [{ id: "1", path: "a", kind: "modified", status: "pending", turn: 1, additions: 1, deletions: 0, diff: "" }] as never });
    const user = userEvent.setup();
    render(<Sidebar />);
    await user.click(screen.getByRole("button", { name: /^Git/ }));
    expect(useApp.getState().rightTab).toBe("git");
    await user.click(screen.getByRole("button", { name: /Appearance/ }));
    expect(useApp.getState()).toMatchObject({ dialog: "settings", settingsTab: "appearance" });
  });
});

describe("Appearance", () => {
  it("applies and persists theme, font and density", async () => {
    applyAppearance({ theme: "paper", font: "sans", density: "compact" });
    expect(document.documentElement.dataset).toMatchObject({ theme: "paper", font: "sans", density: "compact" });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    saveAppearance({ theme: "slate", font: "mono", density: "spacious" });
    expect(loadAppearance()).toEqual({ theme: "slate", font: "mono", density: "spacious" });
    localStorage.setItem("betacode.appearance", "{ broken");
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE);
    applyAppearance(DEFAULT_APPEARANCE);
  });

  it("the settings tab changes the theme through the store", async () => {
    useApp.setState({ settingsTab: "appearance" });
    const user = userEvent.setup();
    render(<SettingsDialog />);
    await user.click(screen.getByRole("button", { name: /Paper/ }));
    expect(useApp.getState().appearance.theme).toBe("paper");
    await user.click(screen.getByRole("radio", { name: /Sans-serif/ }));
    expect(useApp.getState().appearance.font).toBe("sans");
    useApp.getState().setAppearance(DEFAULT_APPEARANCE);
  });
});

describe("SetupAdvisor", () => {
  it("shows the machine, the recommendation with an honest estimate note, and ranks other models", async () => {
    render(<SetupAdvisor />);
    expect(await screen.findByText("AMD Ryzen 7")).toBeInTheDocument();
    expect(screen.getByText("NVIDIA RTX 3050 Laptop")).toBeInTheDocument();
    const rec = screen.getByRole("region", { name: "Recommendation" });
    expect(within(rec).getByText("Qwen3 4B Instruct")).toBeInTheDocument();
    expect(within(rec).getByText(/estimates/)).toBeInTheDocument();
    expect(screen.getByText("Qwen3-Coder 30B-A3B")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Choose Qwen3 4B Instruct" })).toBeChecked();
  });

  it("saves recommended settings, including a models folder on another drive", async () => {
    const user = userEvent.setup();
    render(<SetupAdvisor />);
    await user.type(await screen.findByLabelText("Models folder"), "D:\\ollama\\models");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(api.setupApplyEnv).toHaveBeenCalledWith({ contextLength: 8192, modelsDir: "D:\\ollama\\models", restart: false }));
    expect(await screen.findByText(/Restart Ollama to apply/)).toBeInTheDocument();
  });

  it("downloads only when asked, and the model must be installed before it can be used", async () => {
    const user = userEvent.setup();
    render(<SetupAdvisor />);
    await screen.findByText("AMD Ryzen 7");
    expect(api.setupPull).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Use qwen3:4b-instruct/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Download/ }));
    await waitFor(() => expect(api.setupPull).toHaveBeenCalledWith("qwen3:4b-instruct"));
  });

  it("says so plainly when nothing fits", async () => {
    vi.mocked(api.setupOverview).mockResolvedValueOnce({ ...OVERVIEW, recommendation: { best: undefined, options: OVERVIEW.recommendation.options.map((o) => ({ ...o, level: "too-big" })) } } as never);
    render(<SetupAdvisor />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/None of the local models fit/);
  });
});

describe("API key section", () => {
  const withKeyCaps = (extra: object) => useApp.setState({ config: { ...useApp.getState().config!, canPersistKey: true, keySource: "none", ...extra } as never });

  it("offers to remember the key (encrypted) and sends that choice with the key", async () => {
    withKeyCaps({});
    const user = userEvent.setup();
    render(<SettingsDialog />);
    expect(screen.getByLabelText(/Remember on this computer/)).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "OpenRouter" }));
    expect(screen.getByLabelText("Model")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(screen.getByLabelText("Model"), "some/free-model:free");
    await user.type(screen.getByLabelText("API key"), "sk-or-test-key");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateConfig).toHaveBeenCalled());
    expect(vi.mocked(api.updateConfig).mock.calls[0]![0]).toMatchObject({ apiKey: "sk-or-test-key", rememberKey: true, baseUrl: "https://openrouter.ai/api/v1", model: "some/free-model:free" });
  });

  it("respects an unchecked box and never claims persistence where it is unsupported", async () => {
    withKeyCaps({});
    const user = userEvent.setup();
    const { unmount } = render(<SettingsDialog />);
    await user.click(screen.getByLabelText(/Remember on this computer/));
    await user.type(screen.getByLabelText("API key"), "temp-key");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateConfig).toHaveBeenCalled());
    expect(vi.mocked(api.updateConfig).mock.calls[0]![0]).toMatchObject({ rememberKey: false });
    unmount();
    vi.clearAllMocks();
    withKeyCaps({ canPersistKey: false });
    render(<SettingsDialog />);
    expect(screen.queryByLabelText(/Remember on this computer/)).not.toBeInTheDocument();
    expect(screen.getByText(/BETA_CODE_API_KEY environment variable/)).toBeInTheDocument();
  });

  it("explains where the key comes from, can forget a saved key, and links to the provider's key page", async () => {
    withKeyCaps({ keySource: "saved", hasApiKey: true });
    const user = userEvent.setup();
    render(<SettingsDialog />);
    expect(screen.getByText(/saved \(encrypted\) key is used/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Gemini" }));
    expect(screen.getByRole("link", { name: /aistudio\.google\.com/ })).toHaveAttribute("href", "https://aistudio.google.com/apikey");
    await user.click(screen.getByRole("button", { name: "Forget saved key" }));
    await waitFor(() => expect(api.updateConfig).toHaveBeenCalledWith({ forgetKey: true }));
  });

  it("lists the free-tier-capable providers as presets", () => {
    withKeyCaps({});
    render(<SettingsDialog />);
    for (const name of ["OpenRouter", "Groq", "Hugging Face", "Gemini", "OpenAI", "Anthropic"]) expect(screen.getByRole("radio", { name })).toBeInTheDocument();
  });
});

describe("Helper model tab", () => {
  const open = () => useApp.setState({ settingsTab: "helper", config: { ...useApp.getState().config!, canPersistKey: true, teacherKeySource: "none", teacherReady: false } as never });

  it("explains the consent and privacy trade-off plainly", () => {
    open();
    render(<SettingsDialog />);
    expect(screen.getByText(/ask you/)).toBeInTheDocument();
    expect(screen.getByText(/sent to that provider/)).toBeInTheDocument();
  });

  it("tests the typed endpoint and key without saving, and offers the models it finds", async () => {
    open();
    const user = userEvent.setup();
    render(<SettingsDialog />);
    await user.click(screen.getByRole("radio", { name: "Gemini" }));
    await user.type(screen.getByLabelText("Helper API key"), "typed-key-123");
    await user.click(screen.getByRole("button", { name: /Test helper/ }));
    await waitFor(() => expect(api.testTeacher).toHaveBeenCalled());
    expect(vi.mocked(api.testTeacher).mock.calls[0]![0]).toMatchObject({ baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "typed-key-123" });
    expect(api.updateConfig).not.toHaveBeenCalled();
    expect(await screen.findByText(/Endpoint reachable/)).toBeInTheDocument();
  });

  it("saves provider, model and the key (remembered by default) in one go; Save needs a model", async () => {
    open();
    const user = userEvent.setup();
    render(<SettingsDialog />);
    await user.click(screen.getByRole("radio", { name: "Groq" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(screen.getByLabelText("Helper model"), "big-model");
    await user.type(screen.getByLabelText("Helper API key"), "gsk-test-key");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateConfig).toHaveBeenCalled());
    expect(vi.mocked(api.updateConfig).mock.calls[0]![0]).toMatchObject({
      teacher: { enabled: true, baseUrl: "https://api.groq.com/openai/v1", model: "big-model" },
      teacherKey: "gsk-test-key",
      rememberTeacherKey: true,
    });
  });

  it("shows readiness and lets you forget a saved key", async () => {
    useApp.setState({ settingsTab: "helper", config: { ...useApp.getState().config!, canPersistKey: true, teacher: { enabled: true, baseUrl: "https://api.groq.com/openai/v1", model: "big" }, teacherKeySource: "saved", teacherReady: true } as never });
    const user = userEvent.setup();
    render(<SettingsDialog />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Forget saved key" }));
    await waitFor(() => expect(api.updateConfig).toHaveBeenCalledWith({ forgetTeacherKey: true }));
  });
});
