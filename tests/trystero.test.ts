import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A stand-in for Trystero's `joinRoom`, faithful in the two ways that matter here: a repeated
 * roomId hands back *the same* room object with single-slot callbacks, and `leave()` only
 * releases that room after a turn of the event loop.
 */
const rooms = new Map<string, any>();
let relayUrls: string[] = [];
let joins = 0;
let sockets: Record<string, { readyState: number }> = {};

function makeRoom(roomId: string): any {
  const peers: Record<string, unknown> = {};
  const room: any = {
    roomId,
    peers,
    left: false,
    onPeerJoin: null,
    onPeerLeave: null,
    onPeerStream: null,
    sent: [] as unknown[],
    streams: [] as unknown[],
    makeAction: () => room.action,
    getPeers: () => peers,
    addStream: (stream: unknown, o: unknown) => (room.streams.push([stream, o]), []),
    removeStream: () => {},
    leave: async () => {
      await new Promise((r) => setTimeout(r, 1));
      room.left = true;
      rooms.delete(roomId);
    },
  };
  room.action = {
    onMessage: null,
    send: async (data: unknown, o: unknown) => void room.sent.push([data, o]),
  };
  return room;
}

vi.mock('trystero', () => ({
  selfId: 'self-peer',
  defaultRelayUrls: Array.from({ length: 20 }, (_, i) => `wss://r${i}`),
  getRelaySockets: () => sockets,
  joinRoom: (config: any, roomId: string) => {
    joins++;
    relayUrls = config.relayConfig.urls;
    const existing = rooms.get(roomId);
    if (existing) return existing;
    const room = makeRoom(roomId);
    rooms.set(roomId, room);
    return room;
  },
}));

const { TrysteroTransport } = await import('@engine/transport/trystero');

describe('TrysteroTransport', () => {
  beforeEach(() => {
    rooms.clear();
    joins = 0;
    sockets = { 'wss://r0': { readyState: 1 } };
  });

  it('gives each caller its own handle on one shared room, and fans events out to all of them', () => {
    const t = new TrysteroTransport({ appId: 'app' });
    const mesh = t.join('world/3,4');
    const voice = t.join('world/3,4');

    expect(joins).toBe(1);
    const room = rooms.get('world/3,4');
    const seen: string[] = [];
    mesh.onPeerJoin = (p) => seen.push(`mesh:${p}`);
    voice.onPeerJoin = (p) => seen.push(`voice:${p}`);
    room.onPeerJoin('friend');

    // Without this, the second `join` would have silently overwritten the first one's callbacks.
    expect(seen).toEqual(['mesh:friend', 'voice:friend']);

    const heard: Uint8Array[] = [];
    mesh.onMessage = (d) => heard.push(d);
    room.action.onMessage(new Uint8Array([7]), { peerId: 'friend' });
    expect(heard).toEqual([new Uint8Array([7])]);

    t.dispose();
  });

  it('holds the room until the last handle leaves', async () => {
    const t = new TrysteroTransport({ appId: 'app' });
    const mesh = t.join('world/0,0');
    const voice = t.join('world/0,0');
    const room = rooms.get('world/0,0');

    voice.leave();
    await new Promise((r) => setTimeout(r, 5));
    expect(room.left).toBe(false);
    expect(mesh.peers()).toEqual([]); // still a live room, not a dead handle

    mesh.leave();
    await new Promise((r) => setTimeout(r, 5));
    expect(room.left).toBe(true);

    t.dispose();
  });

  it('rebuilds its rooms on a wider relay set once every relay has gone dark', async () => {
    const t = new TrysteroTransport({ appId: 'app', redundancy: 4, blackoutMs: 20 });
    const mesh = t.join('world/1,1');
    const events: string[] = [];
    mesh.onPeerJoin = (p) => events.push(`join:${p}`);
    mesh.onPeerLeave = (p) => events.push(`leave:${p}`);

    const before = [...relayUrls];
    expect(before).toHaveLength(4);
    expect(t.relayStatus.open).toBe(1);

    // Every relay socket dies, the way they do after a laptop sleeps or a session burns through them.
    sockets = { 'wss://r0': { readyState: 3 }, 'wss://r1': { readyState: 3 } };
    rooms.get('world/1,1').peers['friend'] = {};
    await vi.waitFor(() => expect(t.relayStatus.recoveries).toBe(1), { timeout: 2000, interval: 20 });
    await vi.waitFor(() => expect(rooms.has('world/1,1')).toBe(true), { timeout: 2000, interval: 20 });

    // Grown, not rotated: peers keep sharing the head of the pool, so they can still meet.
    expect(relayUrls.slice(0, 4)).toEqual(before);
    expect(relayUrls.length).toBeGreaterThan(4);
    // The handle survives the rebuild: it was told its peer went, and is still wired to the
    // room that replaced the one it was holding.
    expect(events).toEqual(['leave:friend']);
    rooms.get('world/1,1').onPeerJoin('friend');
    expect(events).toEqual(['leave:friend', 'join:friend']);

    t.dispose();
  });
});
