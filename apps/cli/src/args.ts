import type { AgentMode } from "@betacode/shared";

export interface CliArgs {
  command: "chat" | "init" | "config" | "models" | "sessions" | "doctor" | "help" | "version";
  path?: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
  mode?: AgentMode;
  continue: boolean;
  yes: boolean;
  prompt?: string;
  rest: string[];
}

const MODES: AgentMode[] = ["ask", "code", "plan", "review", "debug", "explore"];
const COMMANDS = new Set(["init", "config", "models", "sessions", "doctor", "help", "version"]);

export class UsageError extends Error {}

/** Minimal argv parser (no dependency): `betacode [command] [path] [flags]`. */
export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { command: "chat", continue: false, yes: false, rest: [] };
  const positional: string[] = [];
  const take = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = take(i, flag);
      i++;
      return v;
    };
    switch (flag) {
      case "--model":
      case "-m":
        out.model = value();
        break;
      case "--provider":
        out.provider = value();
        break;
      case "--base-url":
        out.baseUrl = value();
        break;
      case "--mode": {
        const m = value() as AgentMode;
        if (!MODES.includes(m)) throw new UsageError(`--mode must be one of ${MODES.join(", ")}`);
        out.mode = m;
        break;
      }
      case "-p":
      case "--prompt":
        out.prompt = value();
        break;
      case "--continue":
      case "-c":
        out.continue = true;
        break;
      case "--yes":
      case "-y":
        out.yes = true;
        break;
      case "--help":
      case "-h":
        out.command = "help";
        break;
      case "--version":
      case "-v":
        out.command = "version";
        break;
      default:
        if (a.startsWith("-") && a.length > 1) throw new UsageError(`Unknown option ${a}`);
        positional.push(a);
    }
  }
  if (positional[0] && COMMANDS.has(positional[0]) && out.command === "chat") {
    out.command = positional.shift() as CliArgs["command"];
  }
  if (out.command === "config" || out.command === "init" || out.command === "sessions" || out.command === "models" || out.command === "doctor") {
    // `betacode config set key value`, `betacode doctor ./proj`
    if (out.command === "config") out.rest = positional;
    else out.path = positional[0];
  } else if (out.command === "chat") {
    out.path = positional[0];
  }
  return out;
}

export const USAGE = `BetaCode — AI coding agent for your projects.

Usage:
  betacode [path] [options]        Start an interactive session in a project (default: current directory)
  betacode init [path]             Analyse the project and create BETACODE.md (asks permission)
  betacode config [set <key> <value>]   Show or change global configuration
  betacode models                  List models served by the configured endpoint
  betacode sessions [path]         List saved sessions for a project
  betacode doctor [path]           Check Node, Git, database and the model endpoint

Options:
  -m, --model <id>        Model id (default: Qwen/Qwen3-Coder-30B-A3B-Instruct)
      --provider <name>   qwen | openai-compatible | openrouter | openai
      --base-url <url>    OpenAI-compatible endpoint (default: http://localhost:8000/v1)
      --mode <mode>       ask | code | plan | review | debug | explore (default: code)
  -p, --prompt <text>     Run one prompt non-interactively, then exit
  -c, --continue          Resume the most recent session
  -y, --yes               Auto-approve file edits and ordinary commands (dangerous actions still ask)
  -h, --help              Show this help
  -v, --version           Show version

Environment: BETA_CODE_BASE_URL, BETA_CODE_MODEL, BETA_CODE_API_KEY, BETA_CODE_PROVIDER`;
