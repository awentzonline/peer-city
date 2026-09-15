import type { PickedUp, Tool, Toolbox } from './tool';

/**
 * The tools an avatar carries and their charges. Everyone has the issued tools, which never run out.
 * Others come in ones or twos (up to `Tool.max`), and tools of a kind share their charges (on desktop
 * you only ever hold one of them).
 *
 * A kind that `stows` can be put away in a pack rather than kept to hand, which is the difference between
 * what you can reach (the number keys, or your body in VR) and what you're merely carrying. Stowed kinds
 * are still carried: their charges keep going up as you gather more, and they're lost with everything else
 * when you die. Games without a pack never stow anything and don't notice any of this.
 */
export class Inventory<T extends Tool<any> = Tool<any>> {
  /** What's in hand: the selected tool on desktop, or what's in a tracked hand. */
  current: T | null;
  /** What comes out when nothing else is carried: the first issued tool, if there is one. */
  readonly fallback: T | null;
  private readonly counts = new Map<T, number>();
  private readonly stock = new Map<T, number>();
  private readonly stowed = new Set<T>();

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

  /** Whether a kind you carry is put away in the pack rather than to hand. */
  inPack(tool: T): boolean {
    return this.stowed.has(tool);
  }

  /** The kinds you carry and keep to hand, in slot order. */
  toHand(): T[] {
    return this.tools.all.filter((tool) => this.has(tool) && !this.stowed.has(tool));
  }

  /** The kinds you carry in the pack, in slot order. */
  packed(): T[] {
    return this.tools.all.filter((tool) => this.has(tool) && this.stowed.has(tool));
  }

  /** Put a kind away in the pack. False if it isn't carried, or never leaves your hands. */
  stow(tool: T): boolean {
    if (!this.has(tool) || !tool.stows || this.stowed.has(tool)) return false;
    this.stowed.add(tool);
    if (this.current === tool) {
      this.current = null;
      this.cycle(1);
      this.current ??= this.fallback;
    }
    return true;
  }

  /** Take a kind out of the pack, back to hand. False if it wasn't in there. */
  takeOut(tool: T): boolean {
    return this.stowed.delete(tool);
  }

  /** Whether picking up this tool would add anything: room for another, or for its charges. */
  wants(tool: T): boolean {
    if (tool.issued > 0 || !this.tools.has(tool)) return false;
    return this.count(tool) < tool.max || (!!tool.charges && this.charges(tool) < tool.charges.max);
  }

  /** Picks up a tool and its charges. A new kind that stows goes into the pack; one that doesn't comes to hand. */
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
    if (had === 0 && tool.stows && !tool.selectOnPickup) this.stowed.add(tool);
    if (had === 0 && (tool.selectOnPickup || !this.current) && !this.stowed.has(tool)) this.current = tool;
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

  /** Take out a kind you keep to hand. False for one you don't carry, or that's in the pack. */
  select(tool: T): boolean {
    if (!this.has(tool) || this.stowed.has(tool)) return false;
    this.current = tool;
    return true;
  }

  /** Switch to the next (+1) or previous (-1) kind kept to hand. */
  cycle(dir: 1 | -1): T | null {
    const { all } = this.tools;
    const n = all.length;
    const from = this.current?.id ?? (dir > 0 ? -1 : n);
    for (let i = 1; i <= n; i++) {
      const tool = all[(((from + dir * i) % n) + n) % n];
      if (this.has(tool) && !this.stowed.has(tool)) return (this.current = tool);
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
    this.stowed.clear();
    this.current = this.fallback;
    return taken;
  }

  private remove(tool: T): void {
    this.counts.delete(tool);
    this.stock.delete(tool);
    this.stowed.delete(tool);
    if (this.current === tool) this.current = this.fallback;
  }
}
