import { describe, expect, it } from 'vitest';
import type { NetWorld } from '../src/engine/net/world';
import { MAP_GESTURES, MapGestures } from '../src/crossplay/mapGestures';
import { OverheadView } from '../src/crossplay/overhead';
import { Platform } from '../src/crossplay/platform';
import { registerActions } from '../src/haunt/actions';
import type { HauntContext, KeyEntity } from '../src/haunt/context';
import { ACTIONS, ENTITIES, Key, Monster, MonsterKind, MonsterMode, Phase, Result, SurvivorMode } from '../src/haunt/defs';
import { stepRules } from '../src/haunt/frame';
import { HauntRole, POWERS, WHISPER_DARK_MS, WHISPER_DRAW, type HauntBody } from '../src/haunt/haunt';
import { Power, idleHauntIntent, idleSurvivorIntent, stillHaunt, type HauntIntent, type SurvivorIntent } from '../src/haunt/intent';
import { FENCE_MIN, GATE, Manor, PEDESTAL, Paths, SIZE, START, Tile } from '../src/haunt/manor';
import { MONSTERS, summon, summonRefusal } from '../src/haunt/monsters';
import { HUNT_SECONDS, KEYS_HIDDEN, RoundKeeper, WAIT_SECONDS } from '../src/haunt/round';
import { BLEED_SECONDS, MAX_HP, SurvivorRole, type SurvivorBody } from '../src/haunt/survivor';
import { Sim } from './harness';

const SEED = 20261031;
const manor = new Manor(SEED);
const stub = () => new Proxy({}, { get: () => () => {} });

class TestSurvivorBody implements SurvivorBody {
  platform = Platform.Desktop;
  hurts = 0;
  downs = 0;
  ups = 0;
  out = false;
  keys = 0;
  moved(): void {}
  placed(): void {}
  hurt(): void {
    this.hurts++;
  }
  used(): void {}
  died(): void {}
  snuffs = 0;
  lit(): void {}
  snuffed(): void {
    this.snuffs++;
  }
  downed(): void {
    this.downs++;
  }
  helpedUp(): void {
    this.ups++;
  }
  escaped(): void {
    this.out = true;
  }
  gotKey(): void {
    this.keys++;
  }
  placedKey(): void {}
  restarted(): void {}
}

class TestHauntBody implements HauntBody {
  platform = Platform.Touch;
  refusals: string[] = [];
  uses: Power[] = [];
  glares = 0;
  used(power: Power): void {
    this.uses.push(power);
  }
  refused(reason: string): void {
    this.refusals.push(reason);
  }
  ordered(): void {}
  glared(): void {
    this.glares++;
  }
}

interface Peer {
  ctx: HauntContext;
  world: NetWorld;
  keeper: RoundKeeper;
  survivor?: SurvivorRole;
  sbody?: TestSurvivorBody;
  sintent?: SurvivorIntent;
  haunt?: HauntRole;
  hbody?: TestHauntBody;
  hintent?: HauntIntent;
  messages: string[];
}

function peer(net: Sim, id: string, role: 'survivor' | 'haunt', name = id): Peer {
  const world = net.add(id, { worldId: 'haunt-test', entities: ENTITIES, actions: ACTIONS, zoneSize: 4096, cellSize: 1024, interestRadius: 400, spatialCellSize: 16 });
  const messages: string[] = [];
  let keeper!: RoundKeeper;
  const ctx: HauntContext = {
    world,
    manor,
    paths: new Paths(manor),
    sfx: stub() as never,
    hud: { ...stub(), message: (text: string) => messages.push(text) } as never,
    settings: { open: false } as never,
    fx: stub() as never,
    me: null,
    haunt: null,
    round: () => keeper.round,
    playerName: name,
    now: net.now,
  };
  keeper = new RoundKeeper(ctx);
  const p: Peer = { ctx, world, keeper, messages };
  if (role === 'survivor') {
    p.survivor = new SurvivorRole(ctx);
    p.sbody = new TestSurvivorBody();
    p.survivor.attach(p.sbody);
    p.sintent = idleSurvivorIntent();
    p.survivor.spawn();
  } else {
    p.haunt = new HauntRole(ctx);
    p.hbody = new TestHauntBody();
    p.haunt.attach(p.hbody);
    p.hintent = idleHauntIntent();
    p.haunt.spawn();
  }
  registerActions(ctx, { survivor: p.survivor, haunt: p.haunt });
  return p;
}

function frame(p: Peer, now: number, dt: number): void {
  p.ctx.now = now;
  p.survivor?.update(dt, p.sintent!);
  p.haunt?.update(dt, p.hintent!);
  if (p.hintent) stillHaunt(p.hintent);
  stepRules(p.ctx, p.keeper, dt, now);
}

function run(net: Sim, peers: Peer[], ms: number, each?: (now: number) => void): void {
  net.run(
    ms,
    (now) => {
      each?.(now);
      for (const p of peers) frame(p, now, 1 / 60);
    },
    1000 / 60,
  );
}

/** Walk a survivor's virtual head toward a point. Returns how far off it is. */
function walkTo(p: Peer, x: number, y: number): number {
  const s = p.ctx.me!.state;
  const d = Math.hypot(x - s.x, y - s.y);
  let turn = Math.atan2(y - s.y, x - s.x) - p.survivor!.heading;
  while (turn > Math.PI) turn -= Math.PI * 2;
  while (turn < -Math.PI) turn += Math.PI * 2;
  p.sintent!.turn = turn;
  p.sintent!.forward = d > 0.3 ? 1 : 0;
  p.sintent!.run = d > 3;
  return d;
}

/** Walk a survivor along the paths to a point. */
function travel(net: Sim, peers: Peer[], p: Peer, x: number, y: number, ms: number): number {
  let d = Infinity;
  run(net, peers, ms, (now) => {
    const s = p.ctx.me!.state;
    const next = p.ctx.paths.next(s.x, s.y, x, y, 0.35, now) ?? { x, y };
    d = Math.hypot(x - s.x, y - s.y);
    walkTo(p, d < 1.5 ? x : next.x, d < 1.5 ? y : next.y);
  });
  Object.assign(p.sintent!, idleSurvivorIntent());
  return d;
}

/** Skip the wait at the gate. */
function startHunt(net: Sim, peers: Peer[]): void {
  run(net, peers, 3500);
  const owner = peers.find((p) => p.keeper.round?.mine)!;
  owner.keeper.round!.state.timer = 0.05;
  run(net, peers, 300);
}

describe('The manor', () => {
  it('is the same house for the same seed, and all of it can be walked to from the gate', () => {
    const again = new Manor(SEED);
    expect(again.tiles).toEqual(manor.tiles);
    const reach = manor.reachable();
    let open = 0;
    for (let j = FENCE_MIN + 1; j < SIZE - FENCE_MIN - 4; j++) {
      for (let i = FENCE_MIN + 1; i < SIZE - FENCE_MIN - 4; i++) {
        const t = manor.tile(i, j);
        if (t === Tile.Floor || t === Tile.Grass || t === Tile.Path) {
          open++;
          expect(reach[j * SIZE + i], `cell ${i},${j}`).toBe(1);
        }
      }
    }
    expect(open).toBeGreaterThan(2500);
    expect(manor.rooms.length).toBeGreaterThan(10);
    expect(manor.keySpots.length).toBeGreaterThanOrEqual(KEYS_HIDDEN);
    for (const k of manor.keySpots) expect(reach[Manor.index(Math.floor(k.x), Math.floor(k.y))]).toBe(1);
  });

  it('keeps the gate shut until it opens, and walls block sight but tables do not', () => {
    const p = { x: 39.5, y: FENCE_MIN + 1.5 };
    manor.move(p, 0, -3, 0.35);
    expect(p.y).toBeGreaterThan(FENCE_MIN + 1);
    manor.move(p, 0, -3, 0.35, true);
    expect(p.y).toBeLessThan(FENCE_MIN);
    expect(manor.tile(GATE.x0, GATE.y)).toBe(Tile.Gate);
    // through the front wall of the house, beside the door
    expect(manor.sees(30.5, 20, 30.5, 28)).toBe(false);
    expect(manor.sees(39.5, 20, 39.5, 28)).toBe(true);
  });

  it('finds a way from the gate to every hiding place', () => {
    const paths = new Paths(manor);
    for (const spot of manor.keySpots) {
      const p = { x: START.x, y: START.y };
      let arrived = false;
      for (let i = 0; i < 3000 && !arrived; i++) {
        const next = paths.next(p.x, p.y, spot.x, spot.y, 0.35, i * 16)!;
        expect(next).not.toBeNull();
        const dx = next.x - p.x;
        const dy = next.y - p.y;
        const d = Math.hypot(dx, dy);
        const k = Math.min(d, 0.1) / Math.max(d, 1e-6);
        manor.move(p, dx * k, dy * k, 0.35);
        arrived = Math.hypot(spot.x - p.x, spot.y - p.y) < 0.5;
      }
      expect(arrived, `to ${spot.x},${spot.y}`).toBe(true);
    }
  });
});

describe('Overhead view and map gestures', () => {
  const limits = { minX: 0, minY: 0, maxX: 80, maxY: 80, near: 10, far: 90, tiltNear: 0.7, tiltFar: 0.35 };
  const view = { width: 800, height: 600, fov: 60 };

  it('looks at its focus through the middle of the screen, and maps the ground to the screen and back', () => {
    const o = new OverheadView(limits, { x: 40, y: 30, distance: 40, heading: 0.7 });
    const mid = o.groundAt(400, 300, view)!;
    expect(mid.x).toBeCloseTo(40, 4);
    expect(mid.y).toBeCloseTo(30, 4);
    const g = o.groundAt(123, 456, view)!;
    const back = o.toScreen(g, view)!;
    expect(back.x).toBeCloseTo(123, 3);
    expect(back.y).toBeCloseTo(456, 3);
    // up the screen is the way it's heading
    const top = o.groundAt(400, 100, view)!;
    expect(Math.atan2(top.y - mid.y, top.x - mid.x)).toBeCloseTo(0.7, 4);
    // and right of that is right on the screen: (-sin, cos) of the heading in world axes
    const right = o.groundAt(700, 300, view)!;
    expect(Math.atan2(right.y - mid.y, right.x - mid.x)).toBeCloseTo(0.7 + Math.PI / 2, 4);
  });

  it('keeps the ground under a finger while dragging, zooming and turning', () => {
    const o = new OverheadView(limits, { x: 40, y: 30, distance: 40 });
    const g = o.groundAt(200, 200, view)!;
    o.drag(200, 200, 500, 350, view);
    const moved = o.groundAt(500, 350, view)!;
    expect(moved.x).toBeCloseTo(g.x, 2);
    expect(moved.y).toBeCloseTo(g.y, 2);
    const h = o.groundAt(600, 250, view)!;
    o.zoom(0.6, 600, 250, view);
    expect(o.distance).toBeCloseTo(24, 4);
    const z = o.groundAt(600, 250, view)!;
    expect(z.x).toBeCloseTo(h.x, 2);
    expect(z.y).toBeCloseTo(h.y, 2);
    o.turn(0.5, 600, 250, view);
    const t = o.groundAt(600, 250, view)!;
    expect(t.x).toBeCloseTo(h.x, 2);
    expect(t.y).toBeCloseTo(h.y, 2);
  });

  it('tells a tap from a drag, a long press and a pinch', () => {
    const m = new MapGestures();
    m.pointerDown(1, 100, 100, 0);
    m.pointerMove(1, 104, 103);
    m.pointerUp(1, 150);
    expect(m.frame.taps).toEqual([{ x: 100, y: 100 }]);
    expect(m.frame.drag).toBeNull();
    m.endFrame();

    m.pointerDown(2, 100, 100, 1000);
    m.pointerMove(2, 160, 100);
    m.pointerMove(2, 200, 120);
    // the ground follows the finger from where it went down, once it's past the slop
    expect(m.frame.drag).toEqual({ fromX: 100, fromY: 100, toX: 200, toY: 120 });
    m.pointerUp(2, 1100);
    expect(m.frame.taps).toEqual([]);
    m.endFrame();

    m.pointerDown(3, 300, 300, 2000);
    m.update(2000 + MAP_GESTURES.holdMs + 10);
    expect(m.frame.holds).toEqual([{ x: 300, y: 300 }]);
    m.pointerUp(3, 2800);
    expect(m.frame.taps).toEqual([]);
    m.endFrame();

    m.pointerDown(4, 100, 300, 3000);
    m.pointerDown(5, 300, 300, 3010);
    m.pointerMove(5, 500, 300);
    expect(m.frame.pinch!.scale).toBeCloseTo(2, 5);
    m.pointerUp(4, 3100);
    m.pointerUp(5, 3110);
    expect(m.frame.taps).toEqual([]);
  });
});

describe('A night at the manor', () => {
  it('waits at the gate, then hides keys in the house', () => {
    const net = new Sim();
    const a = peer(net, 'a', 'survivor');
    run(net, [a], 3500);
    const round = a.keeper.round!;
    expect(round.state.phase).toBe(Phase.Waiting);
    expect(round.state.timer).toBeLessThan(WAIT_SECONDS);
    startHunt(net, [a]);
    expect(round.state.phase).toBe(Phase.Hunt);
    expect(round.state.timer).toBeGreaterThan(HUNT_SECONDS - 1);
    const keys = [...a.world.all(Key)];
    expect(keys.length).toBe(KEYS_HIDDEN);
    for (const k of keys) expect(manor.indoors(k.state.x, k.state.y)).toBe(true);
    expect(a.ctx.me!.state.round).toBe(round.state.round);
  });

  it('lets the Haunt summon only where no survivor can see, and only with the dread for it', () => {
    const net = new Sim();
    const s = peer(net, 's', 'survivor');
    const h = peer(net, 'h', 'haunt');
    startHunt(net, [s, h]);
    const me = s.ctx.me!.state;

    // right in front of the survivor: refused
    h.hintent!.arm = Power.Shade;
    h.hintent!.pointer = { x: me.x, y: me.y + 10 };
    h.hintent!.primary = true;
    run(net, [s, h], 50);
    expect(h.hbody!.refusals.at(-1)).toMatch(/can see|close|pedestal/);
    expect(h.world.all(Monster).size).toBe(0);

    // deep in the house, out of sight
    const spot = manor.keySpots.find((k) => !summonRefusal(h.ctx, k.x, k.y))!;
    h.hintent!.pointer = { x: spot.x, y: spot.y };
    h.hintent!.primary = true;
    run(net, [s, h], 50);
    expect(h.hbody!.uses).toContain(Power.Shade);
    expect(h.world.all(Monster).size).toBe(1);
    expect([...h.world.owned(Monster)][0].held).toBe(true);
    expect(h.haunt!.armed).toBe(Power.Shade);
    run(net, [s, h], 300);
    expect(s.world.all(Monster).size).toBe(1);

    // spend it all
    h.haunt!.dread = POWERS[Power.Brute].cost - 1;
    h.hintent!.arm = Power.Brute;
    h.hintent!.pointer = { x: spot.x + 2, y: spot.y };
    h.hintent!.primary = true;
    run(net, [s, h], 50);
    expect(h.hbody!.refusals.at(-1)).toMatch(/dread/);
  });

  it("sends a Haunt's monster after a survivor it points at, which strikes them down; a friend helps them up", () => {
    const net = new Sim();
    const a = peer(net, 'a', 'survivor');
    const b = peer(net, 'b', 'survivor');
    const h = peer(net, 'h', 'haunt');
    const all = [a, b, h];
    startHunt(net, all);

    run(net, all, 400);
    const sa = a.ctx.me!;

    const m = summon(h.ctx, MonsterKind.Brute, sa.state.x + 6, sa.state.y + 6, h.ctx.haunt!.id, h.keeper.round!.state.round);
    h.hintent!.selectAll = true;
    run(net, all, 100);
    expect(h.haunt!.selected.has(m.id)).toBe(true);
    // point at them while they're lit: an attack order
    sa.state.light = true;
    run(net, all, 300);
    h.hintent!.pointer = { x: sa.state.x, y: sa.state.y };
    h.hintent!.secondary = true;
    run(net, all, 100);
    expect(m.state.mode).toBe(MonsterMode.Hunt);
    expect(m.state.target).toBe(sa.id);
    sa.state.light = false;
    a.survivor!.battery = 0;

    run(net, all, 12000, () => {
      if (sa.state.mode !== SurvivorMode.Alive) h.world.despawn(m);
    });
    expect(a.sbody!.hurts).toBeGreaterThan(0);
    expect(sa.state.mode).toBe(SurvivorMode.Downed);
    expect(sa.state.bleed).toBeGreaterThan(BLEED_SECONDS - 13);

    // b comes over and holds interact
    const at = { x: sa.state.x, y: sa.state.y };
    travel(net, all, b, at.x + 0.8, at.y, 15000);
    b.sintent!.interact = true;
    run(net, all, 4000);
    expect(b.survivor!.helping).toBe(null);
    expect(sa.state.mode).toBe(SurvivorMode.Alive);
    expect(a.sbody!.ups).toBe(1);
    expect(sa.state.hp).toBeLessThan(MAX_HP);
  });

  it("springs an ambush with a whisper: the Haunt's monsters come, and the lights near it go out", () => {
    const net = new Sim();
    const a = peer(net, 'a', 'survivor');
    const h = peer(net, 'h', 'haunt');
    const all = [a, h];
    startHunt(net, all);
    const sa = a.ctx.me!;
    const round = h.keeper.round!.state.round;

    // one lying in wait nearby, unnoticed in the dark, and one far across the house
    const near = summon(h.ctx, MonsterKind.Crawler, sa.state.x + 12, sa.state.y, h.ctx.haunt!.id, round);
    const far = summon(h.ctx, MonsterKind.Shade, sa.state.x + WHISPER_DRAW + 10, sa.state.y, h.ctx.haunt!.id, round);
    run(net, all, 100);
    expect(near.state.mode).toBe(MonsterMode.Idle);

    // the survivor's light goes on just as the Haunt whispers
    a.sintent!.trigger = true;
    run(net, all, 20);
    a.sintent!.trigger = false;
    expect(sa.state.light).toBe(true);
    h.haunt!.dread = POWERS[Power.Whisper].cost;
    h.hintent!.arm = Power.Whisper;
    h.hintent!.pointer = { x: sa.state.x, y: sa.state.y };
    h.hintent!.primary = true;
    run(net, all, 200);
    expect(h.hbody!.uses).toContain(Power.Whisper);
    expect(h.haunt!.dread).toBeLessThan(1);
    expect(near.state.mode).toBe(MonsterMode.Hunt);
    expect(near.state.target).toBe(sa.id);
    expect(far.state.mode).not.toBe(MonsterMode.Hunt);

    // the light's out, and won't come back on for a moment
    expect(sa.state.light).toBe(false);
    expect(a.sbody!.snuffs).toBe(1);
    a.sintent!.trigger = true;
    run(net, all, 50);
    a.sintent!.trigger = false;
    run(net, all, 100);
    expect(sa.state.light).toBe(false);
    run(net, all, WHISPER_DARK_MS);
    a.sintent!.trigger = true;
    run(net, all, 50);
    a.sintent!.trigger = false;
    run(net, all, 100);
    expect(sa.state.light).toBe(true);
  });

  it("draws the Haunt's monsters to a whisper with nobody near it", () => {
    const net = new Sim();
    const a = peer(net, 'a', 'survivor');
    const h = peer(net, 'h', 'haunt');
    const all = [a, h];
    startHunt(net, all);
    const spot = manor.keySpots.find((k) => !summonRefusal(h.ctx, k.x, k.y))!;
    const m = summon(h.ctx, MonsterKind.Shade, spot.x, spot.y, h.ctx.haunt!.id, h.keeper.round!.state.round);
    h.haunt!.dread = POWERS[Power.Whisper].cost;
    h.hintent!.arm = Power.Whisper;
    h.hintent!.pointer = { x: spot.x + 6, y: spot.y };
    h.hintent!.primary = true;
    run(net, all, 200);
    expect(m.state.mode).toBe(MonsterMode.Move);
    expect(Math.hypot(m.state.tx - (spot.x + 6), m.state.ty - spot.y)).toBeLessThan(2);
    expect(a.sbody!.snuffs).toBe(0);
  });

  it('burns a shade away in a flashlight beam', () => {
    const net = new Sim();
    const a = peer(net, 'a', 'survivor');
    const h = peer(net, 'h', 'haunt');
    startHunt(net, [a, h]);
    const me = a.ctx.me!.state;
    const m = summon(h.ctx, MonsterKind.Shade, me.x, me.y + 5, 0, h.keeper.round!.state.round);
    run(net, [a, h], 300);
    // face it and switch on
    a.survivor!.heading = Math.PI / 2;
    a.survivor!.pitch = 0;
    a.sintent!.trigger = true;
    run(net, [a, h], 50);
    a.sintent!.trigger = false;
    expect(me.light).toBe(true);
    run(net, [a, h], 4000, () => {
      // keep it in the beam
      a.survivor!.heading = Math.atan2(m.render.y - me.y, m.render.x - me.x);
      a.survivor!.pitch = Math.atan2(MONSTERS[MonsterKind.Shade].height - 1.65, Math.hypot(m.render.x - me.x, m.render.y - me.y));
    });
    expect(m.state.mode === MonsterMode.Dead || !m.alive).toBe(true);
    expect(me.battery).toBeLessThan(100);
  });

  it('finds keys, fills the pedestal, opens the gate and gets out', () => {
    const net = new Sim();
    const a = peer(net, 'a', 'survivor');
    const b = peer(net, 'b', 'survivor');
    // someone playing the Haunt who does nothing, so the house doesn't send monsters of its own
    const h = peer(net, 'h', 'haunt');
    const all = [a, b, h];
    startHunt(net, all);
    const round = a.keeper.round!;
    const needed = round.state.needed;

    for (let n = 0; n < needed; n++) {
      // b's or h's peer might own the keys: a has to ask for each
      const loose = [...a.world.all(Key)].find((k) => !k.render.holder && !k.render.socket) as KeyEntity;
      expect(loose).toBeTruthy();
      expect(travel(net, all, a, loose.render.x, loose.render.y, 40000)).toBeLessThan(1.5);
      run(net, all, 400);
      // on the way it may have walked over another one first
      const key = a.world.getAs(Key, a.ctx.me!.state.key)!;
      expect(key?.mine).toBe(true);
      expect(key.state.holder).toBe(a.ctx.me!.id);
      travel(net, all, a, PEDESTAL.cx, PEDESTAL.y0 - 1.2, 40000);
      run(net, all, 400);
      expect(a.ctx.me!.state.key).toBe(0);
      expect(key.state.socket).toBeGreaterThan(0);
    }
    run(net, all, 500);
    expect(a.keeper.round!.state.placed).toBe(needed);
    expect(a.ctx.manor.gateOpen).toBe(true);

    travel(net, all, a, 39.5, FENCE_MIN - 2, 20000);
    expect(a.sbody!.out).toBe(true);
    expect(a.ctx.me!.state.mode).toBe(SurvivorMode.Escaped);

    // b is still inside: the night goes on until they're out or gone
    run(net, all, 500);
    expect(round.state.phase).toBe(Phase.Hunt);
    b.ctx.me!.state.mode = SurvivorMode.Dead;
    run(net, all, 800);
    const r = a.keeper.round!.state;
    expect(r.phase).toBe(Phase.Over);
    expect(r.result).toBe(Result.Escaped);
    expect(r.escaped).toBe(1);
    expect(r.claimed).toBe(1);
  });

  it('lets the house haunt itself when nobody plays the Haunt, and clears it all away for the next night', () => {
    const net = new Sim();
    const a = peer(net, 'a', 'survivor');
    startHunt(net, [a]);
    travel(net, [a], a, 39.5, 30, 10000);
    run(net, [a], 20000);
    expect([...a.world.all(Monster)].length).toBeGreaterThan(0);
    const round = a.keeper.round!;
    round.state.timer = 0.05;
    run(net, [a], 500);
    expect(round.state.phase).toBe(Phase.Over);
    expect(round.state.result).toBe(Result.Claimed);
    round.state.timer = 0.05;
    run(net, [a], 500);
    expect(round.state.phase).toBe(Phase.Waiting);
    expect(a.world.all(Monster).size).toBe(0);
    expect(a.world.all(Key).size).toBe(0);
    expect(a.ctx.me!.state.mode).toBe(SurvivorMode.Alive);
    expect(Math.hypot(a.ctx.me!.state.x - START.x, a.ctx.me!.state.y - START.y)).toBeLessThan(6);
  });

  it("drives the Haunt's presence back with a flashlight", () => {
    const net = new Sim();
    const a = peer(net, 'a', 'survivor');
    const h = peer(net, 'h', 'haunt');
    startHunt(net, [a, h]);
    const me = a.ctx.me!.state;
    h.hintent!.pointer = { x: me.x, y: me.y + 6 };
    run(net, [a, h], 300);
    expect(h.ctx.haunt!.state.present).toBe(true);
    const dread = h.haunt!.dread;
    a.survivor!.heading = Math.PI / 2;
    a.survivor!.pitch = Math.atan2(1.6 - 1.65, 6);
    a.sintent!.trigger = true;
    run(net, [a, h], 50);
    a.sintent!.trigger = false;
    run(net, [a, h], 600);
    expect(h.hbody!.glares).toBe(1);
    expect(h.haunt!.dread).toBeLessThan(dread);
    expect(h.ctx.haunt!.state.present).toBe(false);
  });
});
