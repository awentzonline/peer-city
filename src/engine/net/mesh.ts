import type { Transport, TransportRoom } from '../transport/types';

export interface MeshHandlers {
  connect(peer: string): void;
  disconnect(peer: string): void;
  /** The path to `peer` changed; in-flight messages may have been lost. */
  reroute(peer: string): void;
  message(data: Uint8Array, peer: string): void;
}

/**
 * Presents a set of overlapping transport rooms as one peer graph. A peer is
 * "connected" while we share at least one room with it. Losing the last shared
 * room starts a grace period so zone hops don't cause entity churn.
 */
export class PeerMesh {
  private rooms = new Map<string, TransportRoom>();
  private roomMembers = new Map<string, Set<string>>();
  private peerRooms = new Map<string, Set<string>>();
  private route = new Map<string, TransportRoom>();
  private connected = new Set<string>();
  private graceUntil = new Map<string, number>();
  private readonly empty: ReadonlySet<string> = new Set();

  constructor(
    private readonly transport: Transport,
    private readonly prefix: string,
    private readonly handlers: MeshHandlers,
    private readonly now: () => number,
    private readonly graceMs: number,
  ) {}

  get selfId(): string {
    return this.transport.selfId;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  roomKeys(): IterableIterator<string> {
    return this.rooms.keys();
  }

  isJoined(key: string): boolean {
    return this.rooms.has(key);
  }

  members(key: string): ReadonlySet<string> {
    return this.roomMembers.get(key) ?? this.empty;
  }

  isConnected(peer: string): boolean {
    return this.connected.has(peer);
  }

  /** Connected and currently routable (not in the disconnect grace window). */
  canSend(peer: string): boolean {
    return this.route.has(peer);
  }

  join(key: string): void {
    if (this.rooms.has(key)) return;
    const room = this.transport.join(`${this.prefix}${key}`);
    this.rooms.set(key, room);
    this.roomMembers.set(key, new Set());
    room.onPeerJoin = (peer) => this.onRoomPeerJoin(key, room, peer);
    room.onPeerLeave = (peer) => this.onRoomPeerLeave(key, peer);
    room.onMessage = (data, peer) => {
      if (this.connected.has(peer)) this.handlers.message(data, peer);
    };
    for (const peer of room.peers()) this.onRoomPeerJoin(key, room, peer);
  }

  leave(key: string): void {
    const room = this.rooms.get(key);
    if (!room) return;
    const members = [...(this.roomMembers.get(key) ?? [])];
    this.rooms.delete(key);
    room.leave();
    for (const peer of members) this.onRoomPeerLeave(key, peer);
    this.roomMembers.delete(key);
  }

  send(peer: string, data: Uint8Array): boolean {
    const room = this.route.get(peer);
    if (!room) return false;
    room.send(data, peer);
    return true;
  }

  /** Fires disconnects for peers whose grace period expired. */
  update(now: number): void {
    for (const [peer, until] of this.graceUntil) {
      if (now < until) continue;
      this.graceUntil.delete(peer);
      if (this.connected.delete(peer)) this.handlers.disconnect(peer);
    }
  }

  dispose(): void {
    for (const key of [...this.rooms.keys()]) this.leave(key);
    for (const peer of [...this.connected]) this.handlers.disconnect(peer);
    this.connected.clear();
    this.graceUntil.clear();
  }

  private onRoomPeerJoin(key: string, room: TransportRoom, peer: string): void {
    if (peer === this.selfId || !this.rooms.has(key)) return;
    const members = this.roomMembers.get(key)!;
    if (members.has(peer)) return;
    members.add(peer);
    let set = this.peerRooms.get(peer);
    if (!set) this.peerRooms.set(peer, (set = new Set()));
    set.add(key);

    if (!this.route.has(peer)) this.route.set(peer, room);
    if (!this.connected.has(peer)) {
      this.connected.add(peer);
      this.handlers.connect(peer);
    } else if (this.graceUntil.delete(peer)) {
      this.handlers.reroute(peer);
    }
  }

  private onRoomPeerLeave(key: string, peer: string): void {
    const members = this.roomMembers.get(key);
    if (!members?.delete(peer)) return;
    const set = this.peerRooms.get(peer);
    set?.delete(key);
    const current = this.route.get(peer);
    if (current && current.id !== `${this.prefix}${key}`) return;
    // re-route through another shared room if there is one
    const nextKey = set && set.size > 0 ? set.values().next().value : undefined;
    if (nextKey !== undefined && this.rooms.has(nextKey)) {
      this.route.set(peer, this.rooms.get(nextKey)!);
      this.handlers.reroute(peer);
      return;
    }
    this.route.delete(peer);
    this.peerRooms.delete(peer);
    if (this.connected.has(peer)) this.graceUntil.set(peer, this.now() + this.graceMs);
  }
}
