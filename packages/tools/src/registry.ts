import { z, type ToolSpec } from "@betacode/shared";
import type { AgentTool } from "./types";

export type ParseResult = { ok: true; args: unknown } | { ok: false; error: string };

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): this {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  list(filter?: (t: AgentTool) => boolean): AgentTool[] {
    const all = [...this.tools.values()];
    return filter ? all.filter(filter) : all;
  }

  /** Subset of the registry (e.g. read-only tools for a sub-agent). */
  subset(filter: (t: AgentTool) => boolean): ToolRegistry {
    const r = new ToolRegistry();
    for (const t of this.list(filter)) r.register(t);
    return r;
  }

  /** JSON-schema tool descriptions for the model. */
  specs(): ToolSpec[] {
    return this.list().map((t) => {
      const schema = z.toJSONSchema(t.schema) as Record<string, unknown>;
      delete schema.$schema;
      return { name: t.name, description: t.description, parameters: { type: "object", ...schema } as ToolSpec["parameters"] };
    });
  }

  /** Parse the model's raw JSON arguments and validate them. Errors are written for the model to act on. */
  parseArguments(name: string, raw: string): ParseResult {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool "${name}". Available tools: ${this.names().join(", ")}.` };
    let json: unknown;
    try {
      json = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: `Tool arguments for ${name} are not valid JSON (${(e as Error).message}). Send a single valid JSON object.` };
    }
    const parsed = tool.schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ");
      return { ok: false, error: `Invalid arguments for ${name}: ${issues}` };
    }
    return { ok: true, args: parsed.data };
  }
}
