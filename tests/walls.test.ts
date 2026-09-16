import { describe, expect, it } from 'vitest';
import type { NetWorld } from '../src/engine/net/world';
import { ACTIONS, ENTITIES, Painter } from '../src/walls/defs';
import { MemoryWalls } from '../src/walls/store';
import { WallSync, capture, decodeSeen, encodeSeen, type PainterEntity } from '../src/walls/sync';
import { Brush, PX_PER_M, Surface, TILE, decodePoints, encodePoints, quantizePoint, type StrokePoint } from '../src/walls/wall';
import { PALETTE, SURFACES, buildSurfaces, collide, pickSwatch, pickWall, swatchAt } from '../src/walls/yard';
import { Sim } from './harness';
import { Side, handIntent } from '../src/crossplay/intent';
import { Platform } from '../src/crossplay/platform';
import type { WallsContext } from '../src/walls/context';
import { idleWallsIntent } from '../src/walls/intent';
import { ARM, MARKER_PEN, SPRAY_CAN } from '../src/walls/kit';
import { Painter as PainterRole } from '../src/walls/painter';

const RED = 0xe0282e;
const BLUE = 0x2451d6;

function line(x0: number, y0: number, x1: number, y1: number, n: number, r: number, a: number): StrokePoint[] {
  return Array.from({ length: n }, (_, i) => quantizePoint({ x: x0 + ((x1 - x0) * i) / (n - 1), y: y0 + ((y1 - y0) * i) / (n - 1), r, a }));
}

function same(a: readonly Surface[], b: readonly Surface[]): boolean {
  return a.every((s, i) => s.data.every((v, j) => v === b[i].data[j]));
}

describe('A wall', () => {
  it('knows where a ray from in front meets it, and ignores one from behind', () => {
    const north = new Surface(0, SURFACES[0]);
    const hit = north.hit({ x: 0, y: 8, z: 1.5 }, { x: 0, y: 1, z: 0 }, 5);
    expect(hit?.distance).toBeCloseTo(2);
    expect(hit?.px).toBeCloseTo(north.w / 2);
    expect(hit?.py).toBeCloseTo(1.5 * PX_PER_M);
    expect(north.hit({ x: 0, y: 12, z: 1.5 }, { x: 0, y: -1, z: 0 }, 5)).toBeNull();
    expect(north.hit({ x: 0, y: 8, z: 1.5 }, { x: 0, y: 1, z: 0 }, 1)).toBeNull();
    // seen from in front, right really is right: step right and the point on the wall moves right
    const heading = Math.PI / 2;
    const right = { x: -Math.sin(heading), y: Math.cos(heading) };
    const moved = north.hit({ x: right.x, y: 8 + right.y, z: 1.5 }, { x: 0, y: 1, z: 0 }, 5);
    expect(moved!.px).toBeGreaterThan(hit!.px);
  });

  it('takes a marker line where it was drawn, in its colour', () => {
    const s = new Surface(0, SURFACES[0]);
    const bare = s.pixel(100, 110);
    s.stroke(Brush.Marker, RED, line(50, 100, 150, 100, 5, 3, 1), false, 1);
    expect(s.pixel(100, 100)).toBe(RED);
    expect(s.pixel(100, 110)).toBe(bare);
  });

  it('builds spray up the longer it is held on a spot, and speckles it', () => {
    const s = new Surface(0, SURFACES[0]);
    const redness = () => (s.pixel(200, 100) >> 16) - (s.pixel(200, 100) & 255);
    const before = redness();
    s.stroke(Brush.Spray, RED, [quantizePoint({ x: 200, y: 100, r: 12, a: 0.1 })], false, 1);
    const once = redness();
    for (let i = 0; i < 120; i++) s.stroke(Brush.Spray, RED, [quantizePoint({ x: 200, y: 100, r: 12, a: 0.1 })], false, i + 2);
    expect(once).toBeGreaterThan(before);
    const c = s.pixel(200, 100);
    expect(Math.abs((c >> 16) - (RED >> 16)) + Math.abs(((c >> 8) & 255) - ((RED >> 8) & 255)) + Math.abs((c & 255) - (RED & 255))).toBeLessThan(12);
    // a fast pass lays down less than holding still
    const t = new Surface(0, SURFACES[0]);
    t.stroke(Brush.Spray, RED, [quantizePoint({ x: 100, y: 100, r: 12, a: 0.3 }), quantizePoint({ x: 400, y: 100, r: 12, a: 0.3 })], true, 5);
    expect(t.pixel(250, 100)).not.toBe(RED);
  });

  it('marks the tiles paint touched, and copies them out and back', () => {
    const s = new Surface(0, SURFACES[0]);
    s.takeDirty();
    s.stroke(Brush.Roller, BLUE, line(TILE - 10, 50, TILE + 10, 50, 3, 16, 1), false, 3);
    expect(s.takeDirty()).toEqual([0, 1]);
    expect([...s.painted].filter(Boolean)).toHaveLength(2);
    const copy = new Surface(0, SURFACES[0]);
    for (const t of capture([s])) copy.writeTile(t.tile, t.data);
    expect(same([s], [copy])).toBe(true);
  });

  it('paints the same pixels from a stroke that went over the wire', () => {
    const pts = line(30.3, 40.7, 180.1, 90.2, 7, 9.3, 0.42);
    const back = decodePoints(encodePoints(pts));
    expect(back).toEqual(pts);
    const a = new Surface(1, SURFACES[1]);
    const b = new Surface(1, SURFACES[1]);
    a.stroke(Brush.Spray, BLUE, pts, false, 77);
    b.stroke(Brush.Spray, BLUE, back, false, 77);
    expect(same([a], [b])).toBe(true);
  });
});

describe('The yard', () => {
  it("won't paint the north wall through the board", () => {
    const surfaces = buildSurfaces();
    const through = pickWall(surfaces, { x: 7, y: -6, z: 1.5 }, { x: 0, y: 1, z: 0 }, 30);
    expect(through?.surface).toBe(4); // the board's south side, not the wall behind it
    expect(pickWall(surfaces, { x: -7, y: -6, z: 1.5 }, { x: 0, y: 1, z: 0 }, 30)?.surface).toBe(0);
  });

  it('keeps painters in and picks swatches off the rack', () => {
    const p = { x: 100, y: 0 };
    collide(p, 0.35);
    expect(p.x).toBeCloseTo(14.65);
    const c = swatchAt(5);
    const hit = pickSwatch({ x: c.x, y: c.y + 1.5, z: c.z }, { x: 0, y: -1, z: 0 }, 3);
    expect(hit?.color).toBe(5);
    expect(PALETTE[PALETTE.length - 1].name).toBe('Buff');
  });
});

interface Peer {
  id: string;
  world: NetWorld;
  surfaces: Surface[];
  sync: WallSync;
  me: PainterEntity;
  messages: string[];
}

function peer(net: Sim, id: string, saved: MemoryWalls | null = null, yard = 'yard'): Peer {
  const world = net.add(id, { worldId: 'walls-test', entities: ENTITIES, actions: ACTIONS, zoneSize: 4096, cellSize: 1024, interestRadius: 1500, spatialCellSize: 16 });
  const surfaces = buildSurfaces();
  const messages: string[] = [];
  const me = world.spawn(Painter, { x: 0, y: -6, name: id });
  world.setFocus(0, -6);
  let loaded: ReturnType<typeof capture> | null = null;
  if (saved) void saved.load(yard).then((t) => (loaded = t));
  const sync = new WallSync(
    { world, surfaces, me: () => me, now: () => net.now, wallClock: () => net.now / 1000, message: (m) => messages.push(m), saved: () => loaded },
    { settleMs: 1500, staleMs: 4000 },
  );
  return { id, world, surfaces, sync, me, messages };
}

/** Frames of network and sync, letting compression finish in between. */
async function run(net: Sim, peers: Peer[], ms: number, each?: () => void): Promise<void> {
  const end = net.now + ms;
  while (net.now < end) {
    net.now += 50;
    net.net.pump(net.now);
    for (const p of peers) {
      p.world.update(net.now);
      p.sync.update();
    }
    each?.();
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('Sharing walls', () => {
  it('sends seen-stroke counts intact', () => {
    const seen = new Map([
      ['abc', 3],
      ['a-much-longer-peer-id', 123456],
    ]);
    expect(decodeSeen(encodeSeen(seen))).toEqual(seen);
  });

  it('paints strokes on everyone, and gives a late arrival the walls while painting carries on', async () => {
    const net = new Sim({ latencyMs: 30, connectDelayMs: 100 });
    const ann = peer(net, 'ann');
    await run(net, [ann], 2000);
    expect(ann.sync.synced).toBe(true);

    const bob = peer(net, 'bob');
    await run(net, [ann, bob], 400);
    // ann paints across several tiles
    ann.sync.paint(0, Brush.Roller, RED, line(20, 40, 700, 250, 20, 20, 1), false);
    await run(net, [ann, bob], 2500);
    expect(bob.sync.synced).toBe(true);
    expect(same(ann.surfaces, bob.surfaces)).toBe(true);

    // cat arrives while both keep painting
    const cat = peer(net, 'cat');
    let frame = 0;
    await run(net, [ann, bob, cat], 3000, () => {
      frame++;
      const x = 100 + frame * 7;
      ann.sync.paint(0, Brush.Spray, BLUE, [quantizePoint({ x, y: 200, r: 14, a: 0.2 }), quantizePoint({ x: x + 7, y: 210, r: 14, a: 0.2 })], frame > 1);
      if (frame % 3 === 0) bob.sync.paint(3, Brush.Marker, RED, line(frame, 20, frame + 30, 120, 4, 2, 1), false);
    });
    await run(net, [ann, bob, cat], 1500);
    expect(cat.sync.synced).toBe(true);
    expect(cat.me.state.wall).toBe(ann.me.state.wall);
    expect(same(ann.surfaces, cat.surfaces)).toBe(true);
    expect(same(bob.surfaces, cat.surfaces)).toBe(true);
  });

  it('starts from the walls you saved when nobody else is there', async () => {
    const store = new MemoryWalls();
    const painted = buildSurfaces();
    painted[2].stroke(Brush.Marker, RED, line(10, 10, 300, 200, 10, 4, 1), false, 9);
    await store.save('yard', painted);
    const net = new Sim();
    const ann = peer(net, 'ann', store);
    await run(net, [ann], 2000);
    expect(ann.sync.synced).toBe(true);
    expect(same(ann.surfaces, painted)).toBe(true);
  });

  it('settles two groups that started their own walls on the older one', async () => {
    // a slow handshake: each starts walls of their own, and paints on them, before they can see each other
    const net = new Sim({ latencyMs: 30, connectDelayMs: 3000 });
    const ann = peer(net, 'ann');
    await run(net, [ann], 1200); // birth times are whole seconds: make ann's clearly older
    const bob = peer(net, 'bob');
    await run(net, [ann, bob], 1800);
    expect(ann.sync.synced && bob.sync.synced).toBe(true);
    expect(bob.me.state.wall).not.toBe(ann.me.state.wall);
    ann.sync.paint(1, Brush.Marker, RED, line(10, 10, 400, 10, 5, 4, 1), false);
    bob.sync.paint(1, Brush.Marker, BLUE, line(10, 100, 400, 100, 5, 4, 1), false);

    await run(net, [ann, bob], 4000);
    expect(bob.me.state.wall).toBe(ann.me.state.wall);
    expect(same(ann.surfaces, bob.surfaces)).toBe(true);
    expect(bob.messages.some((m) => m.includes('here first'))).toBe(true);
  });
});

describe('A painter', () => {
  const stub = () => new Proxy({}, { get: () => () => {} });

  function painterIn(net: Sim, id: string) {
    const p = peer(net, id);
    const ctx = { world: p.world, surfaces: p.surfaces, sync: p.sync, sfx: stub(), hud: stub(), settings: stub(), fx: stub(), me: null, playerName: id, now: net.now } as unknown as WallsContext;
    const painter = new PainterRole(ctx);
    painter.attach({ platform: Platform.Desktop, moved() {}, placed() {}, hurt() {}, used() {}, died() {} });
    painter.spawn();
    p.world.despawn(p.me);
    const intent = idleWallsIntent();
    const frame = (n = 1) => {
      for (let i = 0; i < n; i++) {
        net.now += 16;
        ctx.now = net.now;
        painter.update(1 / 60, intent);
      }
    };
    return { ...p, ctx, painter, intent, frame };
  }

  /** Stand facing a spot on the north wall from `back` meters away, eyes at 1.65 m. */
  function faceNorthWall(painter: PainterRole, x: number, back: number): void {
    const s = painter.me!.state;
    s.x = x;
    s.y = 10 - back;
    painter.heading = Math.PI / 2;
    painter.pitch = 0;
  }

  it('sprays through the crosshair, wider from further back', async () => {
    const net = new Sim();
    const a = painterIn(net, 'ann');
    a.painter.inventory.select(SPRAY_CAN);
    faceNorthWall(a.painter, -5, 1.2);
    a.intent.trigger = true;
    a.frame(30);
    const near = a.painter.aims[0];
    expect(near.painting).toBe(true);
    expect(a.painter.me!.state.spraying).toBe(true);
    const north = a.surfaces[0];
    const spot = north.hit({ x: -5, y: 8.8, z: 1.65 }, { x: 0, y: 1, z: 0 }, 5)!;
    expect(north.pixel(spot.px, spot.py)).not.toBe(new Surface(0, SURFACES[0]).pixel(spot.px, spot.py));
    const nearRadius = near.radius;
    faceNorthWall(a.painter, 5, 2);
    a.frame(1);
    expect(a.painter.aims[0].radius).toBeGreaterThan(nearRadius);
    faceNorthWall(a.painter, 5, 4);
    a.frame(1);
    expect(a.painter.aims[0].inReach).toBe(false);
  });

  it('only marks the wall right up against it', () => {
    const net = new Sim();
    const a = painterIn(net, 'ann');
    a.intent.selectTool = MARKER_PEN;
    faceNorthWall(a.painter, 0, 2);
    a.intent.trigger = true;
    a.frame(5);
    expect(a.painter.aims[0].painting).toBe(false);
    faceNorthWall(a.painter, 0, ARM + 0.1);
    a.frame(5);
    expect(a.painter.aims[0].painting).toBe(true);
  });

  it('loads a colour off the rack, without painting on that press', () => {
    const net = new Sim();
    const a = painterIn(net, 'ann');
    const c = swatchAt(9);
    const s = a.painter.me!.state;
    s.x = c.x;
    s.y = c.y + 1.2;
    s.head = c.z - 0; // eyes level with the swatch
    a.painter.heading = -Math.PI / 2;
    a.intent.trigger = true;
    a.frame(3);
    expect(a.painter.colorIndex).toBe(9);
    expect(s.color).toBe(PALETTE[9].rgb);
    expect(a.painter.aims[0].painting).toBe(false);
  });

  it('paints from a tracked hand, as far as the nozzle is from the wall', () => {
    const net = new Sim();
    const a = painterIn(net, 'ann');
    faceNorthWall(a.painter, 2, 1);
    const hand = handIntent();
    Object.assign(hand, { tracked: true, tool: SPRAY_CAN, trigger: true });
    hand.grip = { x: 2, y: 9.5, z: 1.4 };
    hand.tip = { x: 2, y: 9.7, z: 1.5 };
    hand.pointing = hand.aim = { x: 0, y: 1, z: 0 };
    a.intent.head = { x: 2, y: 9, z: 1.65, heading: Math.PI / 2, pitch: 0 };
    a.intent.hands = [hand, handIntent()];
    a.frame(10);
    const aim = a.painter.aims[Side.Right];
    expect(aim.painting).toBe(true);
    expect(aim.distance).toBeCloseTo(0.3, 1);
  });
});
