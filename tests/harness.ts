import { MemoryNetwork, type MemoryNetworkOptions } from '../src/engine/transport/memory';
import { NetWorld, type NetWorldOptions } from '../src/engine/net/world';

/** Drives a set of NetWorlds over a simulated network with a shared fake clock. */
export class Sim {
  readonly net: MemoryNetwork;
  readonly worlds: NetWorld[] = [];
  now = 1000;

  constructor(netOpts: MemoryNetworkOptions = { latencyMs: 30, connectDelayMs: 100 }) {
    this.net = new MemoryNetwork(netOpts);
  }

  add(id: string, opts: Omit<NetWorldOptions, 'transport' | 'now'>): NetWorld {
    const w = new NetWorld({ ...opts, transport: this.net.createTransport(id), now: () => this.now });
    this.worlds.push(w);
    return w;
  }

  remove(w: NetWorld): void {
    w.dispose();
    this.worlds.splice(this.worlds.indexOf(w), 1);
  }

  /** Advance simulated time in frame-sized steps, calling `each` before every world update. */
  run(ms: number, each?: (now: number) => void, frameMs = 16): void {
    const end = this.now + ms;
    while (this.now < end) {
      this.now += frameMs;
      this.net.pump(this.now);
      each?.(this.now);
      for (const w of this.worlds) w.update(this.now);
    }
  }
}
