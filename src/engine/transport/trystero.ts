import { defaultRelayUrls, getRelaySockets, joinRoom, selfId } from 'trystero';
import type { RoomMedia, Transport, TransportRoom } from './types';

export interface TrysteroTransportOptions {
  /** Globally unique app identifier; peers only discover others with the same appId. */
  appId: string;
  /** Optional room password (encrypts signalling payloads). */
  password?: string;
  /**
   * Override the Nostr relay pool used for peer discovery. Peers must overlap on at least
   * one relay to ever find each other, so all peers in an app should pass the same pool.
   */
  relayUrls?: string[];
  /** How many relays of the pool to use at once. More costs announce traffic, fewer risks a blackout. */
  redundancy?: number;
  /** Custom ICE / TURN servers for peers behind strict NATs. */
  turnConfig?: { urls: string | string[]; username?: string; credential?: string }[];
  /** Rebuild rooms after this long with no relay socket open at all. 0 disables recovery. */
  blackoutMs?: number;
}

/** What discovery looks like right now, for the debug panel and for telling a player to reload. */
export interface RelayStatus {
  open: number;
  total: number;
  /** Relays are all down and we've run out of pool to grow into; only a reload can help. */
  exhausted: boolean;
  /** How many times we've rebuilt the rooms onto a wider relay set. */
  recoveries: number;
}

const DEFAULT_REDUNDANCY = 8;
const DEFAULT_BLACKOUT_MS = 30_000;
const GROW_BY = 5;
const POLL_MS = 5_000;
const MIN_RECOVERY_INTERVAL_MS = 60_000;

/** Trystero's own relay ordering (`shuffle(defaults, strToNum(appId))`), so unpatched peers pick the same head. */
function relayPool(appId: string, urls: string[]): string[] {
  let seed = appId.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % Number.MAX_SAFE_INTEGER;
  const a = [...urls];
  const rand = (): number => {
    const x = Math.sin(seed++) * 1e4;
    return x - Math.floor(x);
  };
  let i = a.length;
  while (i) {
    const j = Math.floor(rand() * i--);
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/** One live Trystero room, plus every handle currently sharing it. */
interface Entry {
  room: ReturnType<typeof joinRoom>;
  send: (data: Uint8Array, peerId: string) => void;
  handles: Set<Handle>;
}

interface Handle extends TransportRoom {
  readonly media: RoomMedia;
}

/**
 * Serverless WebRTC via Trystero (Nostr relays for signalling). Trystero shares
 * one RTCPeerConnection per remote peer across all rooms, so overlapping zone
 * rooms don't multiply connections.
 *
 * Two things this adds on top of `joinRoom`:
 *
 * - **Shared rooms.** `joinRoom` returns *the same room object* for a repeated roomId, whose
 *   `onPeerJoin`/`onMessage` are single slots — so two subsystems joining the same name (the
 *   world mesh and proximity voice both follow the zones) would silently clobber each other.
 *   Handles here are independent and fan out, and the room is left when the last one leaves.
 * - **Blackout recovery.** Trystero retires a relay permanently — for the life of the page —
 *   when its socket backs off past a minute or when it rejects an event, and stops announcing
 *   on it. Long sessions burn relays down one by one until discovery is dead and no new peer
 *   can ever be found, even though the room name never changed. When no relay is open at all
 *   we rebuild every room onto a *wider* slice of the same deterministic pool: growing rather
 *   than rotating keeps every peer sharing the head of the list, so they still overlap.
 */
export class TrysteroTransport implements Transport {
  readonly name = 'trystero';
  readonly selfId: string = selfId;

  private readonly pool: string[];
  private readonly blackoutMs: number;
  private readonly entries = new Map<string, Entry>();
  private width: number;
  private recoveries = 0;
  private lastOpenAt = Date.now();
  private lastRecoveryAt = 0;
  private recovering = false;
  private disposed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly wake = () => this.check();

  constructor(private readonly opts: TrysteroTransportOptions) {
    this.pool = relayPool(opts.appId, opts.relayUrls ?? defaultRelayUrls);
    this.width = Math.min(opts.redundancy ?? DEFAULT_REDUNDANCY, this.pool.length);
    this.blackoutMs = opts.blackoutMs ?? DEFAULT_BLACKOUT_MS;
    // No point polling slower than the blackout we're meant to notice.
    this.timer = setInterval(this.wake, Math.min(POLL_MS, Math.max(50, this.blackoutMs / 2)));
    // Sleeping a laptop closes every relay socket without firing `offline`, so the tab wakes
    // up deaf. These are the moments worth looking, rather than waiting out the poll.
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.wake);
      window.addEventListener('pageshow', this.wake);
      document.addEventListener('visibilitychange', this.wake);
    }
  }

  get relayStatus(): RelayStatus {
    const sockets: Record<string, WebSocket | undefined> = getRelaySockets?.() ?? {};
    const all = Object.values(sockets);
    return {
      open: all.filter((s) => s?.readyState === 1).length,
      total: all.length,
      exhausted: this.width >= this.pool.length && this.recoveries > 0,
      recoveries: this.recoveries,
    };
  }

  join(roomId: string): TransportRoom {
    const entry = this.entries.get(roomId) ?? this.open(roomId);
    const media: RoomMedia = {
      addStream: (stream, peerId) => {
        for (const p of entry.room.addStream(stream, { target: peerId })) p.catch(() => {});
      },
      removeStream: (stream, peerId) => entry.room.removeStream(stream, { target: peerId }),
      onPeerStream: () => {},
    };
    const handle: Handle = {
      id: roomId,
      media,
      onPeerJoin: () => {},
      onPeerLeave: () => {},
      onMessage: () => {},
      // Handles sharing a room share its data channel too: every handle sees every message.
      send: (data, peerId) => this.entries.get(roomId)?.send(data, peerId),
      peers: () => Object.keys(this.entries.get(roomId)?.room.getPeers() ?? {}),
      leave: () => {
        const live = this.entries.get(roomId);
        if (!live?.handles.delete(handle) || live.handles.size > 0) return;
        this.entries.delete(roomId);
        live.room.leave().catch(() => {});
      },
    };
    entry.handles.add(handle);
    return handle;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.wake);
      window.removeEventListener('pageshow', this.wake);
      document.removeEventListener('visibilitychange', this.wake);
    }
    for (const entry of this.entries.values()) entry.room.leave().catch(() => {});
    this.entries.clear();
  }

  // ---------------------------------------------------------------------------

  private config(): Record<string, unknown> {
    const config: Record<string, unknown> = { appId: this.opts.appId };
    if (this.opts.password) config.password = this.opts.password;
    config.relayConfig = { urls: this.pool.slice(0, this.width) };
    if (this.opts.turnConfig) config.turnConfig = this.opts.turnConfig;
    return config;
  }

  /** Joins the underlying Trystero room and wires it to fan out to whichever handles hold it. */
  private open(roomId: string): Entry {
    const room = joinRoom(this.config() as never, roomId);
    const action = room.makeAction<Uint8Array>('g');
    const entry: Entry = {
      room,
      send: (data, peerId) => {
        action.send(data, { target: peerId }).catch(() => {
          /* peer vanished mid-send; the mesh will notice */
        });
      },
      handles: new Set(),
    };
    this.entries.set(roomId, entry);
    const each = (f: (h: Handle) => void): void => {
      for (const h of [...entry.handles]) if (this.entries.get(roomId) === entry) f(h);
    };
    room.onPeerJoin = (peerId) => each((h) => h.onPeerJoin(peerId));
    room.onPeerLeave = (peerId) => each((h) => h.onPeerLeave(peerId));
    room.onPeerStream = (stream, peerId) => each((h) => h.media.onPeerStream(stream, peerId));
    action.onMessage = (data, ctx) => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as unknown as ArrayBuffer);
      each((h) => h.onMessage(bytes, ctx.peerId));
    };
    return entry;
  }

  private check(): void {
    if (this.disposed || this.recovering || !this.blackoutMs || this.entries.size === 0) return;
    const now = Date.now();
    if (this.relayStatus.open > 0) {
      this.lastOpenAt = now;
      return;
    }
    if (now - this.lastOpenAt < this.blackoutMs) return;
    if (now - this.lastRecoveryAt < MIN_RECOVERY_INTERVAL_MS) return;
    if (this.width >= this.pool.length) return; // nothing left to grow into
    void this.recover();
  }

  /**
   * Widens the relay set and rebuilds every room on it. Trystero fixes its relays when the
   * first room is joined and only re-reads them once *no* room is left, so every room has to
   * go and come back — which drops the peer connections with them. The mesh treats that as
   * ordinary churn, and being briefly peerless beats being permanently undiscoverable.
   */
  private async recover(): Promise<void> {
    this.recovering = true;
    this.lastRecoveryAt = Date.now();
    this.recoveries++;
    this.width = Math.min(this.width + GROW_BY, this.pool.length);
    const rooms = [...this.entries];
    try {
      // Say goodbye before we pull the rooms out, so callers drop their routes now rather than
      // holding stale ones; the new rooms announce whoever is still there as ordinary joins.
      for (const [, entry] of rooms) {
        for (const peerId of Object.keys(entry.room.getPeers())) {
          for (const handle of [...entry.handles]) handle.onPeerLeave(peerId);
        }
      }
      // `leave` only releases Trystero's room registry after it has told peers and waited, so
      // rejoining before every leave settles would just hand back the same dead room object.
      await Promise.all(rooms.map(([, e]) => e.room.leave().catch(() => {})));
      if (this.disposed) return;
      for (const [roomId, old] of rooms) {
        if (this.entries.get(roomId) !== old) continue; // left for real while we were away
        this.entries.delete(roomId);
        const entry = this.open(roomId);
        for (const handle of old.handles) entry.handles.add(handle);
      }
    } finally {
      this.recovering = false;
      this.lastOpenAt = Date.now();
    }
  }
}
