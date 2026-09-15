import { ByteReader, ByteWriter } from './codec';
import { NetEntity } from './entity';
import { fnv1a, rendezvous } from './hash';
import { PeerMesh } from './mesh';
import type { ActionDef, EntityDef, Infer, Quantized, Shape } from './schema';
import { SpatialHash } from '../spatial/SpatialHash';
import type { Transport } from '../transport/types';

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------
const MAGIC = 0xa7;
const HEADER_SIZE = 11; // magic u8, schema u16, senderTime f64
const TIME_OFFSET = 3;

const MSG_FOCUS = 1;
const MSG_ENTITY = 2;
const MSG_REMOVE = 3;
const MSG_RESYNC = 4;
const MSG_OWN_REQ = 5;
const MSG_OWN_REPLY = 6;
const MSG_ACTION = 7;
const MSG_PING = 8;
const MSG_PONG = 9;
const MSG_YIELD = 10;

const F_FULL = 1;
const F_HANDOFF = 2;
const F_HELD = 4;

const REMOVE_DESTROYED = 0;
const REMOVE_OUT_OF_INTEREST = 1;

const ROUTE_OWNER = 1;

export type RemoveReason = 'despawned' | 'destroyed' | 'out-of-interest' | 'owner-left' | 'stale' | 'unloaded';

export interface NetWorldOptions {
  transport: Transport;
  /** Namespace for zone rooms; peers with different worldIds never meet. */
  worldId: string;
  /** Every replicated entity type. All peers must register the same list in the same order. */
  entities: EntityDef<any>[];
  /** Every action type. Same ordering rule as entities. */
  actions?: ActionDef<any>[];
  /** Side length of a zone (one transport room). Default 2048. */
  zoneSize?: number;
  /** Side length of an authority cell (unit of NPC ownership balancing). Default 512. */
  cellSize?: number;
  /** Radius around a peer's focus in which it receives entities. Default 1000. */
  interestRadius?: number;
  /** Network ticks per second. Default 20. */
  tickRate?: number;
  /** How far in the past remote entities are rendered. Default 120ms. */
  interpDelayMs?: number;
  /** Soft per-peer byte budget for entity updates each tick. Default 1400. */
  bytesPerTick?: number;
  keepaliveMs?: number;
  staleMs?: number;
  fullRefreshMs?: number;
  rebalanceMs?: number;
  handoffDwellMs?: number;
  disconnectGraceMs?: number;
  ownershipRequestTimeoutMs?: number;
  /**
   * Distance constants below are in world units. The defaults suit pixel-scale
   * 2D worlds; scale them down for worlds measured in meters.
   */
  /** Cell size of the spatial hash behind `query()`. Default 256. */
  spatialCellSize?: number;
  /** Focus movement that triggers an early focus update to peers. Default 12. */
  focusResendDistance?: number;
  /** Extra distance beyond 1.25 × interest radius at which zones are joined. Default 200. */
  zoneJoinMargin?: number;
  /** Extra distance beyond 1.25 × interest radius before zones are left (hysteresis). Default 600. */
  zoneKeepMargin?: number;
  now?: () => number;
}

export type ActionTarget =
  | { to: 'all'; self?: boolean }
  | { to: 'peer'; peer: string }
  | { to: 'owner'; entity: NetEntity<any> | number }
  | { to: 'near'; x: number; y: number; radius?: number; self?: boolean };

export interface ActionContext {
  /** Peer that sent the action (selfId for local dispatch). */
  from: string;
  local: boolean;
}

export type TransferPolicy = (entity: NetEntity<any>, requester: string) => boolean;

interface WorldEvents {
  entityAdded: (e: NetEntity<any>) => void;
  entityRemoved: (e: NetEntity<any>, reason: RemoveReason) => void;
  ownershipGained: (e: NetEntity<any>, previousOwner: string) => void;
  ownershipLost: (e: NetEntity<any>, newOwner: string) => void;
  peerJoined: (peer: string) => void;
  peerLeft: (peer: string) => void;
}

interface SentRecord {
  last: Quantized[] | null;
  /** Mask of the last update sent; used to send one "settled" sample after motion stops. */
  lastMask: number;
  tick: number;
  time: number;
  fullTime: number;
  seen: number;
}

class RemotePeer {
  focusX = 0;
  focusY = 0;
  radius = 0;
  hasFocus = false;
  offset: number | null = null;
  rtt = 0;
  readonly sent = new Map<number, SentRecord>();
  readonly forceFull = new Set<number>();
  readonly out = new ByteWriter(1024);
  lastFocusSent = -Infinity;
  lastFocusX = NaN;
  lastFocusY = NaN;
  lastPing = -Infinity;
  bytesIn = 0;
  bytesOut = 0;

  constructor(
    readonly id: string,
    private readonly schemaHash: number,
  ) {
    this.resetOut();
  }

  resetOut(): void {
    this.out.reset().u8(MAGIC).u16(this.schemaHash).f64(0);
  }
}

interface Want {
  e: NetEntity<any>;
  rec: SentRecord;
  mask: number;
  full: boolean;
  score: number;
}

interface PendingRequest {
  entityId: number;
  resolve: (ok: boolean) => void;
  deadline: number;
}

export interface NetStats {
  peers: number;
  rooms: number;
  owned: number;
  remote: number;
  bytesOutPerSec: number;
  bytesInPerSec: number;
  avgRttMs: number;
  /** Cumulative ownership handoffs this peer initiated (rebalancing, zone exits, requests). */
  handoffs: number;
  /** Cumulative orphaned entities this peer claimed after their owner left. */
  claims: number;
  /** Cumulative times another peer's stronger claim overrode ours. */
  conflicts: number;
}

/**
 * The replication engine. One per client.
 *
 * Topology: the world is cut into zones; each zone is a transport room. A peer
 * joins the rooms of zones overlapping its interest circle, so it's connected
 * only to peers that could possibly see the same things.
 *
 * Authority: every entity has one owner. Player-controlled things are owned by
 * their player. Migratable things (NPCs, cars, pickups) belong to whichever peer
 * in the zone wins the rendezvous hash for the entity's cell; they hand off as
 * membership changes and are claimed when their owner disappears. Conflicts are
 * resolved by (epoch, peerId) so all peers converge.
 *
 * Replication: owners send each peer only entities inside that peer's interest
 * radius, as field-level deltas against what that peer last received (channels
 * are reliable + ordered), throttled by distance and capped per tick.
 */
export class NetWorld {
  readonly selfId: string;
  readonly spatial: SpatialHash<NetEntity<any>>;
  readonly zoneSize: number;
  readonly cellSize: number;
  readonly interestRadius: number;

  private readonly defs: EntityDef<any>[];
  private readonly actionDefs: ActionDef<any>[];
  private readonly schemaHash: number;
  private readonly mesh: PeerMesh;
  private readonly clock: () => number;
  private readonly tickMs: number;
  private readonly interpDelayMs: number;
  private readonly bytesPerTick: number;
  private readonly keepaliveMs: number;
  private readonly staleMs: number;
  private readonly fullRefreshMs: number;
  private readonly rebalanceMs: number;
  private readonly handoffDwellMs: number;
  private readonly requestTimeoutMs: number;
  private readonly focusResendDistance: number;
  private readonly zoneJoinMargin: number;
  private readonly zoneKeepMargin: number;

  private readonly entities = new Map<number, NetEntity<any>>();
  private readonly byType: Set<NetEntity<any>>[];
  private readonly owned = new Set<NetEntity<any>>();
  private readonly remote = new Set<NetEntity<any>>();
  private readonly peers = new Map<string, RemotePeer>();
  private readonly listeners: { [K in keyof WorldEvents]: Set<WorldEvents[K]> } = {
    entityAdded: new Set(),
    entityRemoved: new Set(),
    ownershipGained: new Set(),
    ownershipLost: new Set(),
    peerJoined: new Set(),
    peerLeft: new Set(),
  };
  private readonly actionHandlers = new Map<number, Set<(p: any, ctx: ActionContext) => void>>();
  private readonly transferPolicies = new Map<number, TransferPolicy>();
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private inbox: { data: Uint8Array; peer: string }[] = [];
  private localActions: { def: ActionDef<any>; payload: any }[] = [];

  private focusX = 0;
  private focusY = 0;
  private radius: number;
  private hasFocus = false;
  private tickNo = 0;
  private nextTick = 0;
  private nextRebalance = 0;
  private nextWatchdog = 0;
  private nowMs = 0;
  private idTag: number;
  private idCounter = 0;
  private requestSeq = 1;
  private readonly scratch = new ByteWriter(256);
  private readonly queryBuf: NetEntity<any>[] = [];
  private readonly wants: Want[] = [];
  /** Reused Want records, so replication doesn't allocate per entity per peer per tick. */
  private readonly wantPool: Want[] = [];
  private warnedSchema = false;

  private statWindowStart = 0;
  private statBytesOut = 0;
  private statBytesIn = 0;
  readonly stats: NetStats = {
    peers: 0,
    rooms: 0,
    owned: 0,
    remote: 0,
    bytesOutPerSec: 0,
    bytesInPerSec: 0,
    avgRttMs: 0,
    handoffs: 0,
    claims: 0,
    conflicts: 0,
  };

  constructor(opts: NetWorldOptions) {
    this.selfId = opts.transport.selfId;
    this.defs = opts.entities;
    this.actionDefs = opts.actions ?? [];
    if (this.defs.length > 255 || this.actionDefs.length > 255) throw new Error('At most 255 entity and action types');
    this.defs.forEach((d, i) => (d.typeId = i));
    this.actionDefs.forEach((d, i) => (d.typeId = i));
    this.byType = this.defs.map(() => new Set());
    const signature = [
      ...this.defs.map((d) => `E:${d.name}{${d.layout.signature()}}`),
      ...this.actionDefs.map((d) => `A:${d.name}{${d.layout.signature()}}`),
    ].join(';');
    this.schemaHash = fnv1a(signature) & 0xffff;

    this.zoneSize = opts.zoneSize ?? 2048;
    this.cellSize = opts.cellSize ?? 512;
    this.interestRadius = this.radius = opts.interestRadius ?? 1000;
    this.tickMs = 1000 / (opts.tickRate ?? 20);
    this.interpDelayMs = opts.interpDelayMs ?? 120;
    this.bytesPerTick = opts.bytesPerTick ?? 1400;
    this.keepaliveMs = opts.keepaliveMs ?? 1000;
    this.staleMs = opts.staleMs ?? 4500;
    this.fullRefreshMs = opts.fullRefreshMs ?? 15000;
    this.rebalanceMs = opts.rebalanceMs ?? 500;
    this.handoffDwellMs = opts.handoffDwellMs ?? 1500;
    this.requestTimeoutMs = opts.ownershipRequestTimeoutMs ?? 3000;
    this.spatial = new SpatialHash(opts.spatialCellSize ?? 256);
    this.focusResendDistance = opts.focusResendDistance ?? 12;
    this.zoneJoinMargin = opts.zoneJoinMargin ?? 200;
    this.zoneKeepMargin = opts.zoneKeepMargin ?? 600;
    this.clock = opts.now ?? (() => performance.now());
    this.nowMs = this.clock();
    this.idTag = randomTag();

    this.mesh = new PeerMesh(
      opts.transport,
      `${opts.worldId}/`,
      {
        connect: (p) => this.onPeerConnect(p),
        disconnect: (p) => this.onPeerDisconnect(p),
        reroute: (p) => this.peers.get(p)?.sent.clear(),
        message: (data, p) => this.inbox.push({ data, peer: p }),
      },
      this.clock,
      opts.disconnectGraceMs ?? 2500,
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Where this peer is looking. Drives zone membership and what others send us. */
  setFocus(x: number, y: number, radius = this.interestRadius): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.focusX = x;
    this.focusY = y;
    this.radius = radius;
    this.hasFocus = true;
  }

  get focus(): { x: number; y: number; radius: number } | null {
    return this.hasFocus ? { x: this.focusX, y: this.focusY, radius: this.radius } : null;
  }

  spawn<S extends Shape>(def: EntityDef<S>, init: Partial<Infer<S>> = {}, opts: { held?: boolean } = {}): NetEntity<Infer<S>> {
    this.assertDef(def);
    const state = Object.assign(def.layout.defaults(), init) as Infer<S>;
    const e = new NetEntity<Infer<S>>(this.nextId(), def, this.selfId, 1, true, state);
    e.held = opts.held ?? false;
    this.addEntity(e);
    return e;
  }

  /** Destroy an entity you own, on every peer. */
  despawn(e: NetEntity<any>): void {
    if (!e.alive) return;
    if (!e.mine) {
      console.warn(`[net] despawn of entity ${e.id} ignored: not owner`);
      return;
    }
    const rOut2 = (this.interestRadius * 1.25) ** 2;
    for (const peer of this.peers.values()) {
      const rec = peer.sent.get(e.id);
      const near = peer.hasFocus && dist2(e.stateX, e.stateY, peer.focusX, peer.focusY) <= rOut2;
      if (rec?.last || near) {
        peer.out.u8(MSG_REMOVE).id48(e.id).u16(e.epoch).u8(REMOVE_DESTROYED);
      }
      peer.sent.delete(e.id);
    }
    this.removeLocal(e, 'despawned');
  }

  get(id: number): NetEntity<any> | undefined {
    return id ? this.entities.get(id) : undefined;
  }

  getAs<S extends Shape>(def: EntityDef<S>, id: number): NetEntity<Infer<S>> | undefined {
    const e = id ? this.entities.get(id) : undefined;
    return e && e.def === def ? (e as NetEntity<Infer<S>>) : undefined;
  }

  /** Every known entity of a type (owned and remote). Don't mutate the set. */
  all<S extends Shape>(def: EntityDef<S>): ReadonlySet<NetEntity<Infer<S>>> {
    return this.byType[def.typeId] as Set<NetEntity<Infer<S>>>;
  }

  get entityCount(): number {
    return this.entities.size;
  }

  /** Entities within `r` of a point (by rendered position), optionally of one type. */
  query<S extends Shape>(x: number, y: number, r: number, def?: EntityDef<S>, out: NetEntity<Infer<S>>[] = []): NetEntity<Infer<S>>[] {
    const buf = this.spatial.queryRadius(x, y, r, this.queryBuf);
    const r2 = r * r;
    for (const e of buf) {
      if ((!def || e.def === def) && e.alive && dist2(e.x, e.y, x, y) <= r2) out.push(e as NetEntity<Infer<S>>);
    }
    buf.length = 0;
    return out;
  }

  /** True if this peer or any connected peer focuses within `r` of the point. */
  isObserved(x: number, y: number, r: number): boolean {
    const r2 = r * r;
    if (this.hasFocus && dist2(x, y, this.focusX, this.focusY) <= r2) return true;
    for (const p of this.peers.values()) if (p.hasFocus && dist2(x, y, p.focusX, p.focusY) <= r2) return true;
    return false;
  }

  /**
   * Whether this peer is the regional authority for a point: the peer that
   * should spawn/own ambient content there. Every peer in the zone computes the
   * same answer, so use it to decide who populates NPCs without coordination.
   */
  isAuthorityFor(x: number, y: number): boolean {
    if (!this.hasFocus) return false;
    const zk = this.zoneKey(x, y);
    if (!this.mesh.isJoined(zk)) return false;
    const cell = `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
    return rendezvous(cell, this.zoneCandidates(zk)) === this.selfId;
  }

  /** Known focus points of connected peers (for minimaps, spawners...). */
  *peerFoci(): IterableIterator<{ peer: string; x: number; y: number; rtt: number }> {
    for (const p of this.peers.values()) if (p.hasFocus) yield { peer: p.id, x: p.focusX, y: p.focusY, rtt: p.rtt };
  }

  get peerCount(): number {
    return this.peers.size;
  }

  /**
   * Ask the owner to hand an entity over (e.g. to drive a car or pick up an
   * item). Resolves true once this peer owns it; the entity is then `held`
   * until `release()`.
   */
  requestOwnership(e: NetEntity<any>): Promise<boolean> {
    if (!e.alive) return Promise.resolve(false);
    if (e.mine) {
      e.held = true;
      return Promise.resolve(true);
    }
    const peer = this.peers.get(e.owner);
    if (!peer || !this.mesh.canSend(e.owner)) return Promise.resolve(false);
    const reqId = this.requestSeq++;
    peer.out.u8(MSG_OWN_REQ).id48(e.id).u32(reqId);
    return new Promise((resolve) => {
      this.pendingRequests.set(reqId, { entityId: e.id, resolve, deadline: this.nowMs + this.requestTimeoutMs });
    });
  }

  /** Allow an owned entity to migrate to the regional authority again. */
  release(e: NetEntity<any>): void {
    if (e.mine) e.held = false;
  }

  /** Decide whether to grant ownership requests for a type. Default: grant unless held. */
  setTransferPolicy<S extends Shape>(def: EntityDef<S>, policy: (e: NetEntity<Infer<S>>, requester: string) => boolean): void {
    this.transferPolicies.set(def.typeId, policy as TransferPolicy);
  }

  on<K extends keyof WorldEvents>(event: K, fn: WorldEvents[K]): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  onAction<S extends Shape>(def: ActionDef<S>, fn: (payload: Infer<S>, ctx: ActionContext) => void): () => void {
    let set = this.actionHandlers.get(def.typeId);
    if (!set) this.actionHandlers.set(def.typeId, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /**
   * Send a typed action. Delivery is reliable; it goes out with the next
   * network tick. Local handlers (when targeted) run during the next update().
   */
  send<S extends Shape>(def: ActionDef<S>, payload: Infer<S>, target: ActionTarget): void {
    if (this.actionDefs[def.typeId] !== def) throw new Error(`Action "${def.name}" is not registered`);
    const w = this.scratch.reset();
    def.layout.writeMasked(w, def.layout.quantizeInto(payload, []), def.layout.allMask);
    const body = w.finish();

    switch (target.to) {
      case 'peer':
        if (target.peer === this.selfId) this.localActions.push({ def, payload });
        else this.writeAction(target.peer, def, body, 0, 0, 0);
        break;
      case 'owner': {
        const e = typeof target.entity === 'number' ? this.entities.get(target.entity) : target.entity;
        if (!e || !e.alive) return;
        if (e.mine) this.localActions.push({ def, payload });
        else this.writeAction(e.owner, def, body, ROUTE_OWNER, e.id, 2);
        break;
      }
      case 'all':
        for (const p of this.peers.keys()) this.writeAction(p, def, body, 0, 0, 0);
        if (target.self ?? true) this.localActions.push({ def, payload });
        break;
      case 'near': {
        for (const p of this.peers.values()) {
          const r = target.radius ?? p.radius;
          if (p.hasFocus && dist2(target.x, target.y, p.focusX, p.focusY) <= r * r) this.writeAction(p.id, def, body, 0, 0, 0);
        }
        if (target.self ?? true) this.localActions.push({ def, payload });
        break;
      }
    }
  }

  /** Call once per frame, before simulating owned entities. */
  update(now = this.clock()): void {
    this.nowMs = now;
    this.mesh.update(now);

    for (const e of this.owned) this.spatial.update(e, e.stateX, e.stateY);

    const inbox = this.inbox;
    this.inbox = [];
    for (const m of inbox) this.handlePacket(m.data, m.peer);

    if (this.localActions.length) {
      const local = this.localActions;
      this.localActions = [];
      for (const a of local) this.dispatch(a.def, a.payload, this.selfId, true);
    }

    if (this.pendingRequests.size) {
      for (const [id, req] of this.pendingRequests) {
        if (now >= req.deadline) {
          this.pendingRequests.delete(id);
          req.resolve(false);
        }
      }
    }

    if (now >= this.nextTick) {
      this.tick(now);
      this.nextTick = Math.max(this.nextTick + this.tickMs, now - this.tickMs);
    }

    this.interpolate(now);
  }

  dispose(): void {
    this.mesh.dispose();
  }

  // -------------------------------------------------------------------------
  // Tick: zones, authority, replication
  // -------------------------------------------------------------------------

  private tick(now: number): void {
    this.tickNo++;
    const leaving = this.updateZones();

    if (leaving.length) this.handoffLeavingZones(leaving);
    if (now >= this.nextRebalance) {
      this.nextRebalance = now + this.rebalanceMs;
      this.rebalance(now);
    }

    for (const peer of this.peers.values()) {
      if (!this.mesh.canSend(peer.id)) continue;
      this.writeFocus(peer, now);
      if (now - peer.lastPing > 2000) {
        peer.lastPing = now;
        peer.out.u8(MSG_PING).f64(now);
      }
      if (peer.hasFocus || peer.forceFull.size) this.replicateTo(peer, now);
      this.flush(peer, now);
    }

    for (const key of leaving) this.mesh.leave(key);

    if (now >= this.nextWatchdog) {
      this.nextWatchdog = now + 1000;
      for (const e of this.remote) {
        if (e._orphanSince) {
          if (this.peers.has(e.owner)) {
            e._orphanSince = 0;
          } else if (now - e._orphanSince > 1500) {
            // Nobody claimed it (peers' views of the zone disagreed). Claim it ourselves;
            // if several holders do, the (epoch, peerId) tie-break plus YIELD converges.
            this.takeOwnership(e, Math.min(e.epoch + 1, 0xffff), e.owner, false);
            this.stats.claims++;
            continue;
          } else {
            continue;
          }
        }
        if (now - e._lastHeard > this.staleMs) this.removeLocal(e, 'stale');
      }
    }
    this.updateStats(now);
  }

  private zoneKey(x: number, y: number): string {
    return `${Math.floor(x / this.zoneSize)},${Math.floor(y / this.zoneSize)}`;
  }

  /** Joins newly needed zone rooms; returns keys to leave after this tick's flush. */
  private updateZones(): string[] {
    const leaving: string[] = [];
    if (!this.hasFocus) return leaving;
    const joinR = this.radius * 1.25 + this.zoneJoinMargin;
    const keepR = this.radius * 1.25 + this.zoneKeepMargin;
    const want = this.zonesInCircle(this.focusX, this.focusY, joinR);
    for (const key of want) this.mesh.join(key);
    const keep = new Set(this.zonesInCircle(this.focusX, this.focusY, keepR));
    for (const key of this.mesh.roomKeys()) if (!keep.has(key)) leaving.push(key);
    return leaving;
  }

  private zonesInCircle(x: number, y: number, r: number): string[] {
    const s = this.zoneSize;
    const out: string[] = [];
    const x0 = Math.floor((x - r) / s);
    const x1 = Math.floor((x + r) / s);
    const y0 = Math.floor((y - r) / s);
    const y1 = Math.floor((y + r) / s);
    for (let zx = x0; zx <= x1; zx++) {
      for (let zy = y0; zy <= y1; zy++) {
        const nx = Math.max(zx * s, Math.min(x, (zx + 1) * s));
        const ny = Math.max(zy * s, Math.min(y, (zy + 1) * s));
        if (dist2(x, y, nx, ny) <= r * r) out.push(`${zx},${zy}`);
      }
    }
    return out;
  }

  /** Peers eligible for authority over things in a zone. */
  private zoneCandidates(zoneKey: string, excludeSelf = false): string[] {
    if (this.mesh.isJoined(zoneKey)) {
      const out = [...this.mesh.members(zoneKey)].filter((p) => this.mesh.canSend(p));
      if (!excludeSelf) out.push(this.selfId);
      return out;
    }
    // Not in that room: fall back to connected peers whose focus is near the zone.
    const [zx, zy] = zoneKey.split(',').map(Number);
    const s = this.zoneSize;
    const margin = this.interestRadius * 1.25;
    const out: string[] = [];
    for (const p of this.peers.values()) {
      if (!p.hasFocus || !this.mesh.canSend(p.id)) continue;
      if (p.focusX >= zx * s - margin && p.focusX < (zx + 1) * s + margin && p.focusY >= zy * s - margin && p.focusY < (zy + 1) * s + margin) {
        out.push(p.id);
      }
    }
    return out;
  }

  private cellKey(e: NetEntity<any>): string {
    return `${Math.floor(e.stateX / this.cellSize)},${Math.floor(e.stateY / this.cellSize)}`;
  }

  private handoffLeavingZones(leaving: string[]): void {
    const set = new Set(leaving);
    for (const e of [...this.owned]) {
      if (!e.def.migratable || e.held) continue;
      const zk = this.zoneKey(e.stateX, e.stateY);
      if (!set.has(zk)) continue;
      const target = rendezvous(this.cellKey(e), this.zoneCandidates(zk, true));
      if (target) this.handoff(e, target, false);
      else this.despawn(e); // nobody left to simulate it: unload
    }
  }

  private rebalance(now: number): void {
    for (const e of [...this.owned]) {
      if (!e.def.migratable || e.held) continue;
      if (e.def.cullDistance !== Infinity && !this.isObserved(e.stateX, e.stateY, e.def.cullDistance)) {
        this.despawn(e);
        continue;
      }
      const zk = this.zoneKey(e.stateX, e.stateY);
      const candidates = this.zoneCandidates(zk);
      if (!this.mesh.isJoined(zk) && candidates.length === 0) {
        // Wandered somewhere nobody (that we know of) can see.
        if (now - e._handoffSince > this.handoffDwellMs && e._handoffTo === '') this.despawn(e);
        else if (e._handoffTo !== '') {
          e._handoffTo = '';
          e._handoffSince = now;
        }
        continue;
      }
      const desired = rendezvous(this.cellKey(e), candidates);
      if (!desired || desired === this.selfId) {
        e._handoffTo = null;
        continue;
      }
      if (e._handoffTo !== desired) {
        e._handoffTo = desired;
        e._handoffSince = now;
      } else if (now - e._handoffSince >= this.handoffDwellMs) {
        this.handoff(e, desired, false);
      }
    }
  }

  private writeFocus(peer: RemotePeer, now: number): void {
    if (!this.hasFocus) return;
    const moved = Math.abs(this.focusX - peer.lastFocusX) + Math.abs(this.focusY - peer.lastFocusY);
    if (moved > this.focusResendDistance || now - peer.lastFocusSent > 500 || Number.isNaN(moved)) {
      peer.out.u8(MSG_FOCUS).f32(this.focusX).f32(this.focusY).u16(Math.min(65535, this.radius));
      peer.lastFocusSent = now;
      peer.lastFocusX = this.focusX;
      peer.lastFocusY = this.focusY;
    }
  }

  private quantize(e: NetEntity<any>, force = false): Quantized[] {
    if (force || e._qTick !== this.tickNo) {
      e.def.layout.quantizeInto(e.state, e._q);
      e._qTick = force ? -1 : this.tickNo;
    }
    return e._q;
  }

  private replicateTo(peer: RemotePeer, now: number): void {
    const tick = this.tickNo;
    const wants = this.wants;
    wants.length = 0;

    // A peer owns few entities, so scanning them directly is cheaper than a spatial query
    // over the interest circle, which would also return every remote entity in range.
    // This covers peer.forceFull too: only owned entities can be forced.
    for (const e of this.owned) this.consider(peer, e, now);
    peer.forceFull.clear();

    // Anything we previously sent that's no longer in range: tell them to drop it.
    for (const [id, rec] of peer.sent) {
      if (rec.seen === tick) continue;
      const e = this.entities.get(id);
      if (rec.last && e && e.mine) peer.out.u8(MSG_REMOVE).id48(id).u16(e.epoch).u8(REMOVE_OUT_OF_INTEREST);
      peer.sent.delete(id);
    }

    if (wants.length > 1) wants.sort(byScoreDesc);
    const budgetEnd = peer.out.length + this.bytesPerTick;
    for (let i = 0; i < wants.length; i++) {
      if (i > 0 && peer.out.length >= budgetEnd) break;
      const { e, rec, mask, full } = wants[i];
      const q = this.quantize(e);
      this.writeEntity(peer.out, e, q, mask, full ? F_FULL : 0);
      if (rec.last === null) rec.last = q.slice();
      else for (let k = 0; k < q.length; k++) rec.last[k] = q[k];
      rec.tick = tick;
      rec.time = now;
      rec.lastMask = mask;
      if (full) rec.fullTime = now;
    }
    wants.length = 0;
  }

  /** Queues an owned entity for `peer` this tick if it's in range and due an update. */
  private consider(peer: RemotePeer, e: NetEntity<any>, now: number): void {
    const R = peer.radius;
    const rOut = R * 1.2;
    const d2 = dist2(e.stateX, e.stateY, peer.focusX, peer.focusY);
    const forced = peer.forceFull.size > 0 && peer.forceFull.has(e.id);
    if (d2 > rOut * rOut && !forced) return; // anything already sent is swept by replicateTo
    const tick = this.tickNo;
    let rec = peer.sent.get(e.id);
    if (!rec) {
      // Right after gaining ownership, cover the whole hysteresis ring: peers there may
      // still hold the previous owner's copy and would otherwise keep a stale view.
      if (d2 > R * R && tick - e._gainTick > 3 && !forced) return;
      rec = { last: null, lastMask: 0, tick: -1e9, time: -1e9, fullTime: now - Math.random() * this.fullRefreshMs * 0.5, seen: tick };
      peer.sent.set(e.id, rec);
    }
    rec.seen = tick;
    const q = this.quantize(e);
    const full = rec.last === null || forced || now - rec.fullTime > this.fullRefreshMs;
    const dn = Math.sqrt(d2) / R;
    let mask = e.def.layout.allMask;
    if (!full) {
      mask = 0;
      const last = rec.last!;
      for (let i = 0; i < q.length; i++) if (last[i] !== q[i]) mask |= 1 << i;
      const interval = dn < 0.4 ? 1 : dn < 0.75 ? 2 : 4;
      if (mask === 0) {
        // An empty update right after movement tells receivers the entity came to rest,
        // so they stop extrapolating instead of overshooting until the next keepalive.
        const settle = rec.lastMask !== 0 && tick - rec.tick >= interval;
        if (!settle && now - rec.time < this.keepaliveMs) return;
      } else if (tick - rec.tick < interval) {
        return;
      }
    }
    const score = rec.last === null || forced ? 1e9 : ((tick - rec.tick) * e.def.priority) / (0.25 + dn);
    let want = this.wantPool[this.wants.length];
    if (want) {
      want.e = e;
      want.rec = rec;
      want.mask = mask;
      want.full = full;
      want.score = score;
    } else {
      this.wantPool.push((want = { e, rec, mask, full, score }));
    }
    this.wants.push(want);
  }

  private writeEntity(w: ByteWriter, e: NetEntity<any>, q: Quantized[], mask: number, flags: number): void {
    w.u8(MSG_ENTITY).id48(e.id).u8(e.def.typeId).u8(flags);
    if (flags & F_FULL) w.u16(e.epoch);
    w.varuint(mask);
    e.def.layout.writeMasked(w, q, mask);
  }

  private writeAction(peerId: string, def: ActionDef<any>, body: Uint8Array, route: number, entityId: number, ttl: number): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.out.u8(MSG_ACTION).u8(def.typeId).u8(route);
    if (route & ROUTE_OWNER) peer.out.id48(entityId).u8(ttl);
    peer.out.bytes(body);
    if (peer.out.length > 16000) this.flush(peer, this.nowMs);
  }

  private flush(peer: RemotePeer, now: number): void {
    if (peer.out.length <= HEADER_SIZE) return;
    peer.out.view.setFloat64(TIME_OFFSET, now, true);
    const data = peer.out.finish();
    if (this.mesh.send(peer.id, data)) {
      peer.bytesOut += data.length;
      this.statBytesOut += data.length;
    }
    peer.resetOut();
  }

  // -------------------------------------------------------------------------
  // Ownership transitions
  // -------------------------------------------------------------------------

  private handoff(e: NetEntity<any>, to: string, held: boolean): boolean {
    const peer = this.peers.get(to);
    if (!peer || !this.mesh.canSend(to) || !e.mine) return false;
    e.epoch = Math.min(e.epoch + 1, 0xffff);
    const q = this.quantize(e, true);
    this.writeEntity(peer.out, e, q, e.def.layout.allMask, F_FULL | F_HANDOFF | (held ? F_HELD : 0));
    this.loseOwnership(e, to);
    this.stats.handoffs++;
    return true;
  }

  private loseOwnership(e: NetEntity<any>, newOwner: string): void {
    e.mine = false;
    e.held = false;
    e.owner = newOwner;
    e._handoffTo = null;
    this.owned.delete(e);
    this.remote.add(e);
    e.render = { ...e.state };
    e._buf?.clear();
    this.pushSample(e, this.nowMs);
    e._lastHeard = this.nowMs;
    for (const p of this.peers.values()) p.sent.delete(e.id);
    this.emit('ownershipLost', e, newOwner);
  }

  private takeOwnership(e: NetEntity<any>, epoch: number, from: string, held: boolean): void {
    e.epoch = epoch;
    e.owner = this.selfId;
    e.mine = true;
    e.held = held;
    e._handoffTo = null;
    this.remote.delete(e);
    this.owned.add(e);
    e.render = e.state;
    e._buf?.clear();
    e._gainTick = this.tickNo;
    e._orphanSince = 0;
    this.emit('ownershipGained', e, from);
    this.resolveRequestsFor(e.id, true);
  }

  private resolveRequestsFor(entityId: number, ok: boolean): void {
    for (const [id, req] of this.pendingRequests) {
      if (req.entityId !== entityId) continue;
      this.pendingRequests.delete(id);
      req.resolve(ok);
    }
  }

  // -------------------------------------------------------------------------
  // Peers
  // -------------------------------------------------------------------------

  private onPeerConnect(id: string): void {
    if (!this.peers.has(id)) this.peers.set(id, new RemotePeer(id, this.schemaHash));
    this.emit('peerJoined', id);
  }

  private onPeerDisconnect(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    for (const e of [...this.remote]) {
      if (e.owner !== id) continue;
      if (!e.def.migratable) {
        this.removeLocal(e, 'owner-left');
        continue;
      }
      const zk = this.zoneKey(e.stateX, e.stateY);
      const winner = rendezvous(this.cellKey(e), this.zoneCandidates(zk));
      if (winner === this.selfId) {
        this.takeOwnership(e, Math.min(e.epoch + 1, 0xffff), id, false);
        this.stats.claims++;
      } else {
        // the winner should claim it (higher epoch); if not, the watchdog falls back
        e._orphanSince = this.nowMs;
      }
    }
    this.emit('peerLeft', id);
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private handlePacket(data: Uint8Array, from: string): void {
    const peer = this.peers.get(from);
    if (!peer) return;
    peer.bytesIn += data.length;
    this.statBytesIn += data.length;
    const r = new ByteReader(data);
    try {
      if (r.u8() !== MAGIC) return;
      if (r.u16() !== this.schemaHash) {
        if (!this.warnedSchema) console.warn(`[net] peer ${from} runs a different schema; ignoring its packets`);
        this.warnedSchema = true;
        return;
      }
      const senderTime = r.f64();
      const sampleOffset = this.nowMs - senderTime;
      if (peer.offset === null || sampleOffset < peer.offset) peer.offset = sampleOffset;
      else peer.offset += (sampleOffset - peer.offset) * 0.02;
      const localTime = senderTime + peer.offset;

      while (r.remaining > 0) {
        const type = r.u8();
        switch (type) {
          case MSG_FOCUS:
            peer.focusX = r.f32();
            peer.focusY = r.f32();
            peer.radius = r.u16();
            peer.hasFocus = true;
            break;
          case MSG_ENTITY:
            this.readEntity(r, peer, localTime);
            break;
          case MSG_REMOVE: {
            const id = r.id48();
            const epoch = r.u16();
            const reason = r.u8();
            const e = this.entities.get(id);
            if (e && !e.mine && (e.owner === from || epoch > e.epoch)) {
              this.removeLocal(e, reason === REMOVE_DESTROYED ? 'destroyed' : 'out-of-interest');
            }
            break;
          }
          case MSG_RESYNC: {
            const id = r.id48();
            if (this.entities.get(id)?.mine) peer.sent.delete(id);
            break;
          }
          case MSG_OWN_REQ: {
            const id = r.id48();
            const reqId = r.u32();
            const e = this.entities.get(id);
            const policy = e ? this.transferPolicies.get(e.def.typeId) : undefined;
            const ok = !!e && e.mine && e.alive && (policy ? policy(e, from) : !e.held) && this.handoff(e, from, true);
            peer.out.u8(MSG_OWN_REPLY).id48(id).u32(reqId).u8(ok ? 1 : 0);
            break;
          }
          case MSG_OWN_REPLY: {
            const id = r.id48();
            const reqId = r.u32();
            const ok = r.u8() === 1;
            const req = this.pendingRequests.get(reqId);
            if (req) {
              this.pendingRequests.delete(reqId);
              req.resolve(ok && !!this.entities.get(id)?.mine);
            }
            break;
          }
          case MSG_ACTION:
            this.readAction(r, peer);
            break;
          case MSG_PING:
            peer.out.u8(MSG_PONG).f64(r.f64());
            break;
          case MSG_PONG:
            peer.rtt = this.nowMs - r.f64();
            break;
          case MSG_YIELD: {
            const id = r.id48();
            const epoch = r.u16();
            const owner = r.string();
            const e = this.entities.get(id);
            if (e && e.mine && owner !== this.selfId && (epoch > e.epoch || (epoch === e.epoch && owner < this.selfId))) {
              this.loseOwnership(e, owner);
              e.epoch = epoch;
              this.stats.conflicts++;
            }
            break;
          }
          default:
            throw new Error(`unknown message type ${type}`);
        }
      }
    } catch (err) {
      console.warn(`[net] malformed packet from ${from}`, err);
    }
  }

  private readEntity(r: ByteReader, peer: RemotePeer, localTime: number): void {
    const from = peer.id;
    const id = r.id48();
    const def = this.defs[r.u8()];
    if (!def) throw new Error('unknown entity type');
    const flags = r.u8();
    const epoch = flags & F_FULL ? r.u16() : -1;
    const mask = r.varuint();
    let e = this.entities.get(id);

    if (flags & F_HANDOFF) {
      if (!e) {
        const state = def.layout.defaults();
        def.layout.readMaskedInto(r, mask, state);
        e = new NetEntity(id, def, this.selfId, epoch, true, state);
        e.held = !!(flags & F_HELD);
        e._gainTick = this.tickNo;
        this.addEntity(e);
        this.emit('ownershipGained', e, from);
        this.resolveRequestsFor(id, true);
      } else if (epoch > e.epoch || (e.owner === from && epoch >= e.epoch)) {
        def.layout.readMaskedInto(r, mask, e.state);
        this.takeOwnership(e, epoch, from, !!(flags & F_HELD));
      } else {
        def.layout.readMaskedInto(r, mask, null);
      }
      return;
    }

    if (flags & F_FULL) {
      if (!e) {
        const state = def.layout.defaults();
        def.layout.readMaskedInto(r, mask, state);
        e = new NetEntity(id, def, from, epoch, false, state);
        e._lastHeard = this.nowMs;
        this.addEntity(e);
        this.pushSample(e, localTime);
        return;
      }
      const accept = epoch > e.epoch || (epoch === e.epoch && (e.owner === from || from < e.owner));
      if (!accept) {
        def.layout.readMaskedInto(r, mask, null);
        // They think they own something with a weaker claim: correct them.
        if (e.mine) peer.forceFull.add(id);
        else if (this.peers.has(e.owner)) peer.out.u8(MSG_YIELD).id48(id).u16(e.epoch).string(e.owner);
        return;
      }
      if (e.mine) {
        this.loseOwnership(e, from);
        this.stats.conflicts++;
      }
      e.owner = from;
      e.epoch = epoch;
      e._orphanSince = 0;
    } else if (!e || e.mine || e.owner !== from) {
      def.layout.readMaskedInto(r, mask, null);
      if (!e) peer.out.u8(MSG_RESYNC).id48(id);
      return;
    }

    def.layout.readMaskedInto(r, mask, e.state);
    e._lastHeard = this.nowMs;
    this.pushSample(e, localTime);
  }

  private readAction(r: ByteReader, peer: RemotePeer): void {
    const def = this.actionDefs[r.u8()];
    if (!def) throw new Error('unknown action type');
    const route = r.u8();
    let targetId = 0;
    let ttl = 0;
    if (route & ROUTE_OWNER) {
      targetId = r.id48();
      ttl = r.u8();
    }
    const start = r.pos;
    const payload = def.layout.defaults() as Record<string, unknown>;
    def.layout.readMaskedInto(r, def.layout.allMask, payload);

    if (route & ROUTE_OWNER) {
      const e = this.entities.get(targetId);
      if (e && !e.mine) {
        // Ownership moved while the action was in flight: forward it.
        if (ttl > 0 && e.owner !== peer.id && this.peers.has(e.owner)) {
          this.writeAction(e.owner, def, r.buf.slice(start, r.pos), ROUTE_OWNER, targetId, ttl - 1);
        }
        return;
      }
    }
    this.dispatch(def, payload, peer.id, false);
  }

  private dispatch(def: ActionDef<any>, payload: unknown, from: string, local: boolean): void {
    const handlers = this.actionHandlers.get(def.typeId);
    if (!handlers) return;
    const ctx: ActionContext = { from, local };
    for (const fn of handlers) {
      try {
        fn(payload, ctx);
      } catch (err) {
        console.error(`[net] action handler for "${def.name}" threw`, err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Local bookkeeping
  // -------------------------------------------------------------------------

  private pushSample(e: NetEntity<any>, time: number): void {
    const def = e.def;
    const keys = def.layout.keys;
    const state = e.state as Record<string, unknown>;
    const render = e.render as Record<string, unknown>;
    // non-interpolated fields apply immediately
    for (let i = 0; i < keys.length; i++) {
      if (!def.interpIdx.includes(i)) render[keys[i]] = state[keys[i]];
    }
    const buf = e._buf;
    if (!buf) return;
    const jump = dist2(e.stateX, e.stateY, e.x, e.y);
    if (buf.count > 0 && jump > def.snapDistance * def.snapDistance) {
      buf.clear();
      for (const i of def.interpIdx) render[keys[i]] = state[keys[i]];
    }
    const vals = e._interpOut;
    for (let k = 0; k < def.interpIdx.length; k++) vals[k] = state[keys[def.interpIdx[k]]] as number;
    buf.push(time, vals, this.tickMs);
  }

  private interpolate(now: number): void {
    const renderTime = now - this.interpDelayMs;
    for (const e of this.remote) {
      const buf = e._buf;
      if (buf && buf.count > 0) {
        const out = e._interpOut;
        if (buf.sample(renderTime, out)) {
          const keys = e.def.layout.keys;
          const idx = e.def.interpIdx;
          const render = e.render as Record<string, number>;
          for (let k = 0; k < idx.length; k++) render[keys[idx[k]]] = out[k];
        }
      }
      this.spatial.update(e, e.x, e.y);
    }
  }

  private addEntity(e: NetEntity<any>): void {
    this.entities.set(e.id, e);
    this.byType[e.def.typeId].add(e);
    (e.mine ? this.owned : this.remote).add(e);
    this.spatial.update(e, e.x, e.y);
    this.emit('entityAdded', e);
  }

  private removeLocal(e: NetEntity<any>, reason: RemoveReason): void {
    if (!e.alive) return;
    e.alive = false;
    this.entities.delete(e.id);
    this.byType[e.def.typeId].delete(e);
    this.owned.delete(e);
    this.remote.delete(e);
    this.spatial.remove(e);
    if (e.mine) for (const p of this.peers.values()) p.sent.delete(e.id);
    this.resolveRequestsFor(e.id, false);
    this.emit('entityRemoved', e, reason);
  }

  private emit<K extends keyof WorldEvents>(event: K, ...args: Parameters<WorldEvents[K]>): void {
    for (const fn of this.listeners[event]) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.error(`[net] ${event} listener threw`, err);
      }
    }
  }

  private nextId(): number {
    if (++this.idCounter > 0xffff) {
      this.idTag = randomTag();
      this.idCounter = 1;
    }
    return this.idTag * 0x10000 + this.idCounter;
  }

  private assertDef(def: EntityDef<any>): void {
    if (this.defs[def.typeId] !== def) throw new Error(`Entity "${def.name}" is not registered with this NetWorld`);
  }

  private updateStats(now: number): void {
    const s = this.stats;
    s.peers = this.peers.size;
    s.rooms = this.mesh.roomCount;
    s.owned = this.owned.size;
    s.remote = this.remote.size;
    const elapsed = now - this.statWindowStart;
    if (elapsed >= 1000) {
      s.bytesOutPerSec = (this.statBytesOut * 1000) / elapsed;
      s.bytesInPerSec = (this.statBytesIn * 1000) / elapsed;
      this.statBytesOut = this.statBytesIn = 0;
      this.statWindowStart = now;
      let rtt = 0;
      for (const p of this.peers.values()) rtt += p.rtt;
      s.avgRttMs = this.peers.size ? rtt / this.peers.size : 0;
    }
  }
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function byScoreDesc(a: Want, b: Want): number {
  return b.score - a.score;
}

function randomTag(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] || 1;
}
