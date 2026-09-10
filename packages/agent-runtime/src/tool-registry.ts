/**
 * The tool table — names in, schemas out.
 *
 * It is a registry rather than an array because THE NAME IS THE CONTRACT. A skill written on the Mac
 * says `read`, `edit`, `grep`; a moved agent's skills keep working only if the browser answers to the
 * same names with the same argument shapes. So a second registration under an existing name is a
 * bug, not an override, and it throws — the alternative is an embed quietly shadowing `read` with
 * something that reads elsewhere.
 */
import type { ToolSchema } from "@00/agent-models";
import type { Tool } from "./api.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): this {
    const name = tool.schema.name;
    if (this.tools.has(name)) throw new Error(`tool "${name}" is already registered`);
    this.tools.set(name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** The schemas to hand a provider. `only` filters, and silently drops names that do not exist —
   *  a caller's stale list must not cost a run. */
  schemas(only?: string[]): ToolSchema[] {
    const wanted = only ? only.filter((n) => this.tools.has(n)) : this.names();
    return wanted.map((n) => this.tools.get(n)!.schema);
  }
}
