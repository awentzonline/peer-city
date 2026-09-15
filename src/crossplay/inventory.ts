import type { PickedUp, Tool, Toolbox } from './tool';

/**
 * The tools an avatar carries and their charges. Everyone has the issued tools, which never run out.
 * Others come in ones or twos (up to `Tool.max`), and tools of a kind share their charges (on desktop
 * you only ever hold one of them).
 */
export class Inventory<T extends Tool<any> = Tool<any>> {
  /** What's in hand: the selected tool on desktop, or what's in a tracked hand. */
  current: T | null;
  /** What comes out when nothing else is carried: the first issued tool, if there is one. */
  readonly fallback: T | null;
  private readonly counts = new Map<T, number>();
  private readonly stock = new Map<T, number>();

  constructor(readonly tools: Toolbox<T>) {
    this.fallback = tools.all.find((t) => t.issued > 0) ?? null;
    this.current = this.fallback;
  }

  has(tool: T): boolean {
    return this.count(tool) > 0;
  }

  /** How many of a kind you carry. */
  count(tool: T): number {
    return tool.issued > 0 ? tool.issued : (this.counts.get(tool) ?? 0);
  }

  /** Charges shared by the tools of a kind. Infinity for tools that never run out. */
  charges(tool: T | null = this.current): number {
    if (!tool || !this.has(tool)) return 0;
    return tool.issued > 0 || !tool.charges ? Infinity : (this.stock.get(tool) ?? 0);
  }

  /** Whether picking up this tool would add anything: room for another, or for its charges. */
  wants(tool: T): boolean {
    if (tool.issued > 0 || !this.tools.has(tool)) return false;
    return this.count(tool) < tool.max || (!!tool.charges && this.charges(tool) < tool.charges.max);
  }

  /** Picks up a tool and its charges, switching to it if it's a new kind that wants to be taken out. */
  add(tool: T, charges: number): PickedUp {
    if (!this.wants(tool)) return { kept: false, count: this.count(tool), charges: 0 };
    const had = this.count(tool);
    const kept = had < tool.max;
    if (kept) this.counts.set(tool, had + 1);
    let got = 0;
    if (tool.charges) {
      const before = this.stock.get(tool) ?? 0;
      const total = Math.min(tool.charges.max, before + Math.max(0, charges));
      this.stock.set(tool, total);
      got = total - before;
    }
    if (had === 0 && (tool.selectOnPickup || !this.current)) this.current = tool;
    return { kept, count: this.count(tool), charges: got };
  }

  /** Uses up charges of a kind. True if that ran it out: its tools are gone, and if it was current the fallback comes out. */
  spend(tool: T, n = 1): boolean {
    if (tool.issued > 0 || !tool.charges || !this.has(tool)) return false;
    const left = (this.stock.get(tool) ?? 0) - n;
    if (left > 0) {
      this.stock.set(tool, left);
      return false;
    }
    this.remove(tool);
    return true;
  }

  select(tool: T): boolean {
    if (!this.has(tool)) return false;
    this.current = tool;
    return true;
  }

  /** Switch to the next (+1) or previous (-1) kind carried. */
  cycle(dir: 1 | -1): T | null {
    const { all } = this.tools;
    const n = all.length;
    const from = this.current?.id ?? (dir > 0 ? -1 : n);
    for (let i = 1; i <= n; i++) {
      const tool = all[(((from + dir * i) % n) + n) % n];
      if (this.has(tool)) return (this.current = tool);
    }
    return this.current;
  }

  /** Takes the current kind out of the inventory with its charges, e.g. to drop it. Null for issued tools. */
  takeCurrent(): { tool: T; charges: number } | null {
    const tool = this.current;
    if (!tool || tool.issued > 0) return null;
    const charges = tool.charges ? this.charges(tool) : 0;
    this.remove(tool);
    return { tool, charges };
  }

  /** Back to just the issued tools. Returns the kinds taken away, with their charges. */
  clear(): { tool: T; charges: number }[] {
    const taken = [...this.counts.keys()].map((tool) => ({ tool, charges: tool.charges ? this.charges(tool) : 0 }));
    this.counts.clear();
    this.stock.clear();
    this.current = this.fallback;
    return taken;
  }

  private remove(tool: T): void {
    this.counts.delete(tool);
    this.stock.delete(tool);
    if (this.current === tool) this.current = this.fallback;
  }
}
