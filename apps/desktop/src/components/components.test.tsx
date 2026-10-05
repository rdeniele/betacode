import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  api: {
    updateConfig: vi.fn(async () => ({})),
    config: vi.fn(async () => ({})),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 12, models: ["Qwen/Qwen3-Coder-30B-A3B-Instruct"], modelAvailable: true, contextLength: 65536 })),
    permissionRules: vi.fn(async () => [{ tool: "write_file", decision: "allow" }]),
    deletePermissionRule: vi.fn(async () => ({})),
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
import { formatTokens } from "./ui";

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ changes: [], sessions: [], activeId: "s1", running: false, dialog: "settings", settingsTab: "models", toasts: [], config: { provider: "qwen", model: "Qwen/Qwen3-Coder-30B-A3B-Instruct", baseUrl: "http://localhost:8000/v1", hasApiKey: false, temperature: 0.7, topP: 0.8, topK: 20, repetitionPenalty: 1.05, contextLength: 32768, maxIterations: 30, maxRetries: 5, autoCompact: true, permissions: {} } });
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

  it("changes the agent mode", async () => {
    const onMode = vi.fn();
    render(<Composer running={false} mode="code" onMode={onMode} onSend={vi.fn()} onStop={vi.fn()} />);
    await userEvent.setup().selectOptions(screen.getByLabelText("Mode"), "plan");
    expect(onMode).toHaveBeenCalledWith("plan");
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
