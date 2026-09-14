import type { Transport, TransportRoom } from './types';

interface Pending {
  at: number;
  run: () => void;
}

export interface MemoryNetworkOptions {
  /** One-way latency in ms. */
  latencyMs?: number;
  /** Extra uniformly random latency in ms (ordering per peer pair is preserved). */
  jitterMs?: number;
  /** Delay before two peers in a room see each other (simulates WebRTC handshake). */
  connectDelayMs?: number;
}

/**
 * In-process simulated network driven by an explicit clock. Used by tests and
 * the headless load simulation to run hundreds of peers deterministically.
 * Mirrors Trystero's semantics: rooms share one logical connection per peer
 * pair, delivery is reliable and ordered.
 */
export class MemoryNetwork {
  private queue: Pending[] = [];
  private rooms = new Map<string, Map<string, MemoryRoom>>();
  private lastDelivery = new Map<string, number>();
  now = 0;
  bytesSent = 0;
  constructor(readonly opts: MemoryNetworkOptions = {}) {}

  createTransport(peerId: string): Transport {
    return {
      name: 'memory',
      selfId: peerId,
      join: (roomId) => this.join(roomId, peerId),
    };
  }

  /** Deliver everything due at or before `now`. */
  pump(now: number): void {
    this.now = now;
    if (this.queue.length === 0) return;
    this.queue.sort((a, b) => a.at - b.at);
    let i = 0;
    while (i < this.queue.length && this.queue[i].at <= now) i++;
    const due = this.queue.splice(0, i);
    for (const p of due) p.run();
  }

  private schedule(delay: number, run: () => void): void {
    this.queue.push({ at: this.now + delay, run });
  }

  private sharesRoom(a: string, b: string): boolean {
    for (const members of this.rooms.values()) if (members.has(a) && members.has(b)) return true;
    return false;
  }

  private findRoom(peer: string, roomId: string): MemoryRoom | undefined {
    const direct = this.rooms.get(roomId)?.get(peer);
    if (direct) return direct;
    for (const members of this.rooms.values()) {
      const r = members.get(peer);
      if (r) return r;
    }
    return undefined;
  }

  private join(roomId: string, peerId: string): TransportRoom {
    let members = this.rooms.get(roomId);
    if (!members) this.rooms.set(roomId, (members = new Map()));
    const room = new MemoryRoom(roomId, peerId, this);
    const existing = [...members.values()];
    members.set(peerId, room);
    const delay = this.opts.connectDelayMs ?? 150;
    for (const other of existing) {
      this.schedule(delay, () => {
        if (room.closed || other.closed) return;
        room.addPeer(other.selfId);
        other.addPeer(peerId);
      });
    }
    return room;
  }

  /** @internal */
  _leave(room: MemoryRoom): void {
    const members = this.rooms.get(room.id);
    if (!members || members.get(room.selfId) !== room) return;
    members.delete(room.selfId);
    if (members.size === 0) this.rooms.delete(room.id);
    for (const other of members.values()) {
      this.schedule(20, () => other.removePeer(room.selfId));
    }
  }

  /** @internal */
  _send(from: string, to: string, roomId: string, data: Uint8Array): void {
    this.bytesSent += data.length;
    const base = this.opts.latencyMs ?? 40;
    const jitter = this.opts.jitterMs ?? 0;
    const key = `${from}>${to}`;
    // Reliable ordered delivery: never deliver before a previously sent packet.
    const at = Math.max(this.now + base + Math.random() * jitter, this.lastDelivery.get(key) ?? 0);
    this.lastDelivery.set(key, at);
    const copy = data.slice();
    this.queue.push({
      at,
      run: () => {
        if (!this.sharesRoom(from, to)) return;
        this.findRoom(to, roomId)?.deliver(copy, from);
      },
    });
  }
}

class MemoryRoom implements TransportRoom {
  onPeerJoin: (peerId: string) => void = () => {};
  onPeerLeave: (peerId: string) => void = () => {};
  onMessage: (data: Uint8Array, peerId: string) => void = () => {};
  closed = false;
  private members = new Set<string>();

  constructor(
    readonly id: string,
    readonly selfId: string,
    private readonly net: MemoryNetwork,
  ) {}

  addPeer(p: string): void {
    if (this.closed || this.members.has(p)) return;
    this.members.add(p);
    this.onPeerJoin(p);
  }

  removePeer(p: string): void {
    if (this.closed || !this.members.delete(p)) return;
    this.onPeerLeave(p);
  }

  deliver(data: Uint8Array, from: string): void {
    if (!this.closed) this.onMessage(data, from);
  }

  send(data: Uint8Array, peerId: string): void {
    if (this.closed || !this.members.has(peerId)) return;
    this.net._send(this.selfId, peerId, this.id, data);
  }

  peers(): string[] {
    return [...this.members];
  }

  leave(): void {
    if (this.closed) return;
    this.closed = true;
    this.members.clear();
    this.net._leave(this);
  }
}
