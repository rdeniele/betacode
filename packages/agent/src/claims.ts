/**
 * Catches reports that name commands the agent never ran ("I ran `git status`" when no tool call did).
 * Small local models do this often; it is the quickest way to lose a user's trust.
 */

const CMD_START = /^(git|npm|pnpm|yarn|bun|npx|node|python3?|pytest|cargo|go|tsc|make|dotnet|mvn|gradle|ruff|eslint|vitest|jest|pip3?)\b/i;
const EXECUTION_WORDS = /\b(ran|run|running|executed?|executing|checked|verified|passed|passing|confirmed|results?)\b/i;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Commands written in `inline code` that look like shell commands. */
export function mentionedCommands(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`\n]{3,120})`/g)) {
    const span = m[1]!.trim();
    if (CMD_START.test(span) && !out.includes(span)) out.push(span);
  }
  return out;
}

/** Commands the text claims to have used that no executed command accounts for. Empty when the text makes no execution claim. */
export function unverifiedCommandClaims(text: string, executed: string[]): string[] {
  if (!EXECUTION_WORDS.test(text)) return [];
  const ran = executed.map(norm);
  return mentionedCommands(text).filter((span) => {
    const s = norm(span);
    return !ran.some((r) => r.includes(s) || s.includes(r));
  });
}

/** Map a git tool call to the command it corresponds to, so `git status` reports are recognised. */
export function commandForTool(name: string, args: unknown): string | undefined {
  if (name === "run_command") {
    const c = (args as { command?: unknown })?.command;
    return typeof c === "string" ? c : undefined;
  }
  if (name.startsWith("git_")) return `git ${name.slice(4)}`;
  if (name === "get_diagnostics") return "tsc --noEmit";
  return undefined;
}

export function claimCorrection(claims: string[]): string {
  const list = claims.map((c) => `\`${c}\``).join(", ");
  return `Your report mentions ${list}, but no tool call in this run executed ${claims.length > 1 ? "them" : "it"}. Only report checks you actually ran. Either run ${claims.length > 1 ? "them" : "it"} now, or remove the claim, and then give the corrected final report.`;
}
