import { describe, expect, it } from 'vitest';
import type { NetWorld } from '../src/engine/net/world';
import { handIntent, type HandIntent } from '../src/crossplay/intent';
import { Platform } from '../src/crossplay/platform';
import { registerActions } from '../src/sewer/actions';
import type { GoblinEntity, LootEntity, SewerContext } from '../src/sewer/context';
import { ACTIONS, ENTITIES, FatChunk, Goblin, GoblinMode, LordMode, Loot, LootKind, LootWhere, Phase, Punch, Result, Sewer, Snatch, Splat, VALVE_FIELDS } from '../src/sewer/defs';
import {
  CHUNKS,
  U,
  V,
  VoxelGrid,
  W,
  ablate,
  breached,
  floorW,
  index,
  inGrid,
  raycastVoxels,
  seedFatberg,
  unsupported,
} from '../src/sewer/fatberg';
import { stepRules } from '../src/sewer/frame';
import { GoblinMind, spawnGoblin } from '../src/sewer/goblins';
import { idleLordIntent, type LordIntent } from '../src/sewer/intent';
import { HOSE, PumpMeter, STROKE } from '../src/sewer/kit';
import { LordRole, MAX_HP, type LordBody } from '../src/sewer/lord';
import { Plug } from '../src/sewer/plug';
import { DiveKeeper, GATHER_SECONDS, RISE, fatSeed } from '../src/sewer/round';
import { Cell, Paths, SIZE, SewerMap } from '../src/sewer/sewer';
import { Sim } from './harness';

const SEED = 4242;
const map = new SewerMap(SEED);
const stub = () => new Proxy({}, { get: () => () => {} });

class TestBody implements LordBody {
  platform = Platform.Desktop;
  hurts = 0;
  punches: number[] = [];
  digs = 0;
  bankedWorth = 0;
  downs = 0;
  ups = 0;
  out = false;
  tears = 0;
  pumps = 0;
  moved(): void {}
  placed(): void {}
  hurt(): void {
    this.hurts++;
  }
  used(): void {}
  died(): void {}
  punched(force: number): void {
    this.punches.push(force);
  }
  grabbed(): void {}
  tore(): void {
    this.tears++;
  }
  pumped(): void {
    this.pumps++;
  }
  sputtered(): void {}
  dug(): void {
    this.digs++;
  }
  banked(worth: number): void {
    this.bankedWorth += worth;
  }
  sackFull(): void {}
  choking(): void {}
  downed(): void {
    this.downs++;
  }
  helpedUp(): void {
    this.ups++;
  }
  surfaced(): void {
    this.out = true;
  }
  restarted(): void {}
}

interface Peer {
  ctx: SewerContext;
  world: NetWorld;
  keeper: DiveKeeper;
  lord: LordRole;
  body: TestBody;
  intent: LordIntent;
  messages: string[];
}

function peer(net: Sim, id: string): Peer {
  const world = net.add(id, { worldId: 'sewer-test', entities: ENTITIES, actions: ACTIONS, zoneSize: 4096, cellSize: 1024, interestRadius: 400, spatialCellSize: 16 });
  const messages: string[] = [];
  let keeper!: DiveKeeper;
  const peerMap = new SewerMap(SEED);
  const ctx: SewerContext = {
    world,
    map: peerMap,
    paths: new Paths(peerMap),
    plug: new Plug(peerMap),
    sfx: stub() as never,
    hud: { ...stub(), message: (text: string) => messages.push(text) } as never,
    settings: { open: false } as never,
    fx: stub() as never,
    me: null,
    sewer: () => keeper.sewer,
    playerName: id,
    now: net.now,
  };
  keeper = new DiveKeeper(ctx);
  const lord = new LordRole(ctx);
  const body = new TestBody();
  lord.attach(body);
  lord.spawn();
  registerActions(ctx, lord, null);
  return { ctx, world, keeper, lord, body, intent: idleLordIntent(), messages };
}

function frame(p: Peer, now: number, dt: number): void {
  p.ctx.now = now;
  p.lord.update(dt, p.intent);
  p.intent.grab = false;
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

function owner(peers: Peer[]): Peer {
  return peers.find((p) => p.keeper.sewer?.mine)!;
}

/** Skip the gathering at the ladder. */
function startDive(net: Sim, peers: Peer[]): void {
  // long enough for the sewer to be settled on and its fatberg made, whoever's jitter wins
  run(net, peers, 8500);
  owner(peers).keeper.sewer!.state.timer = 0.05;
  run(net, peers, 400);
}

/** Stand a Lord a meter out from a goblin by a drain, facing it. */
function faceGoblin(p: Peer, g: { x: number; y: number }, drain: { nx: number; ny: number }): void {
  place(p, g.x + drain.nx, g.y + drain.ny, Math.atan2(-drain.ny, -drain.nx));
}

/** Put a Lord somewhere, facing a way. */
function place(p: Peer, x: number, y: number, heading = 0): void {
  const s = p.ctx.me!.state;
  s.x = x;
  s.y = y;
  p.lord.heading = heading;
  p.lord.pitch = 0;
}

describe('The sewer', () => {
  it('is the same sewer for the same seed, and every chamber can be reached from the ladder, the vault only through the fat', () => {
    const again = new SewerMap(SEED);
    expect(again.cells).toEqual(map.cells);
    expect(map.chambers.length).toBe(16);
    const through = map.reachable(true);
    const around = map.reachable(false);
    for (const c of map.chambers) expect(through[SewerMap.index(c.cx, c.cy)], `chamber at ${c.cx},${c.cy}`).toBe(1);
    expect(around[SewerMap.index(map.vault.cx, map.vault.cy)]).toBe(0);
    expect(map.valves.length).toBe(4);
    expect(map.drains.length).toBeGreaterThan(6);
    expect(map.lootSpots.length).toBeGreaterThan(100);
    expect(map.vaultSpots.length).toBeGreaterThanOrEqual(3);
    for (const v of map.valves) expect(map.cellAt(v.x + v.nx * 0.5, v.y + v.ny * 0.5)).toBe(Cell.Walk);
    // walkways line the tunnels, the channel runs down the middle
    let walk = 0;
    let channel = 0;
    for (let k = 0; k < SIZE * SIZE; k++) {
      if (map.cells[k] === Cell.Walk) walk++;
      if (map.cells[k] === Cell.Channel) channel++;
    }
    expect(walk).toBeGreaterThan(300);
    expect(channel).toBeGreaterThan(300);
    expect(map.groundAt(map.ladderFoot.x, map.ladderFoot.y)).toBeGreaterThan(0);
  });

  it('finds goblins a way round, but not through the fat while it holds', () => {
    const paths = new Paths(map);
    const far = map.chambers[map.chambers.length - 1];
    const route = paths.next(map.ladderFoot.x, map.ladderFoot.y, far.cx + 0.5, far.cy + 0.5, 0.3, 0);
    expect(route).not.toBeNull();
    map.fatBlocks = true;
    const field = paths.field(map.vault.cx + 0.5, map.vault.cy + 0.5, 0);
    expect(field[SewerMap.index(Math.floor(map.ladderFoot.x), Math.floor(map.ladderFoot.y))]).toBe(0xffff);
  });
});

describe('The fatberg', () => {
  it('packs and unpacks every chunk exactly', () => {
    const g = seedFatberg(fatSeed(1));
    const copy = new VoxelGrid();
    for (let ci = 0; ci < CHUNKS; ci++) expect(copy.unpack(ci, g.pack(ci))).toBe(ci < CHUNKS && g.pack(ci).some((b) => b !== 0));
    expect(copy.d).toEqual(g.d);
    expect(copy.unpack(0, g.pack(0))).toBe(false);
  });

  it('plugs the tunnel solid, with no way through, the same for every peer', () => {
    const g = seedFatberg(fatSeed(3));
    expect(seedFatberg(fatSeed(3)).d).toEqual(g.d);
    expect(breached(g)).toBe(false);
    // the middle slice is packed wall to wall, floor to ceiling
    const v = Math.floor(V / 2);
    for (let u = 0; u < U; u++) for (let w = floorW(u); w < W; w++) expect(g.solid(u, v, w), `${u},${v},${w}`).toBe(true);
    expect(unsupported(g)).toEqual([]);
  });

  it('wears away round where a jet hits, most at the middle, and only in chunks it may touch', () => {
    const g = seedFatberg(fatSeed(1));
    const erosion = new Float32Array(g.d.length);
    const hit = { u: 8, v: 5, w: 6 };
    const before = g.mass();
    for (let n = 0; n < 12; n++) ablate(g, hit, 1, erosion);
    expect(g.get(8, 5, 6)).toBe(0);
    expect(g.get(8, 5, 9)).toBeGreaterThan(0); // beyond the blast
    expect(g.mass()).toBeLessThan(before);
    const untouched = seedFatberg(fatSeed(1));
    const nothing = ablate(untouched, hit, 1, new Float32Array(g.d.length), () => false);
    expect(nothing.size).toBe(0);
    expect(untouched.d).toEqual(seedFatberg(fatSeed(1)).d);
  });

  it('casts rays to the first solid voxel, from inside the grid or out', () => {
    const g = new VoxelGrid();
    g.set(5, 6, 4, 2);
    g.set(5, 8, 4, 3);
    const hit = raycastVoxels(g, { x: 5.5, y: -3, z: 4.5 }, { x: 0, y: 1, z: 0 }, 40);
    expect(hit).toMatchObject({ u: 5, v: 6, w: 4 });
    expect(hit!.t).toBeCloseTo(9, 1);
    expect(raycastVoxels(g, { x: 5.5, y: -3, z: 4.5 }, { x: 0, y: 1, z: 0 }, 5)).toBeNull();
    expect(raycastVoxels(g, { x: 2.5, y: -3, z: 4.5 }, { x: 0, y: 1, z: 0 }, 40)).toBeNull();
    const diagonal = raycastVoxels(g, { x: 0.5, y: 1.5, z: 4.5 }, { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 }, 40);
    expect(diagonal).toMatchObject({ u: 5, v: 6, w: 4 });
  });

  it('drops lumps nothing holds up any more', () => {
    const g = new VoxelGrid();
    // a pillar from the floor, and a lump floating free
    for (let w = 0; w < 5; w++) g.set(6, 3, w, 2);
    g.set(9, 3, 6, 2);
    g.set(9, 4, 6, 2);
    const loose = unsupported(g);
    expect(loose.sort()).toEqual([index(9, 3, 6), index(9, 4, 6)].sort());
    expect(inGrid(0, 0, 0)).toBe(false); // under a walkway is rock
  });

  it('counts as breached once a Lord-sized way is carved from end to end', () => {
    const g = seedFatberg(fatSeed(2));
    const erosion = new Float32Array(g.d.length);
    for (let n = 0; n < 40 && !breached(g); n++) {
      for (let v = 0; v < V; v++) for (let w = 1; w < 7; w += 2) ablate(g, { u: 8, v, w }, 1, erosion);
    }
    expect(breached(g)).toBe(true);
  });
});

describe('Pumping', () => {
  it('counts a stroke for each pull back and push home', () => {
    const m = new PumpMeter();
    let strokes = 0;
    const series = [1, 0.8, 0.5, 0.2, 0.1, 0.4, 0.9, 1, 1, 0.3, 0.1, 0.95, 0.6, 0.7, 0.2, 0.5];
    for (const pos of series) strokes += m.update(pos);
    expect(strokes).toBe(2);
    expect(m.update(null)).toBe(0);
    expect(m.update(1)).toBe(0);
  });
});

describe('A dive', () => {
  it('starts once the Lordz have gathered, buries loot, and plugs the vault with a fresh fatberg', () => {
    const net = new Sim();
    const a = peer(net, 'a');
    const b = peer(net, 'b');
    run(net, [a, b], 5000);
    expect(a.keeper.sewer?.render.phase).toBe(Phase.Gather);
    expect(b.keeper.sewer?.id).toBe(a.keeper.sewer?.id);
    run(net, [a, b], GATHER_SECONDS * 1000);
    const sewer = a.keeper.sewer!.render;
    expect(sewer.phase).toBe(Phase.Dive);
    expect(a.ctx.plug.chunks.filter((c) => c).length).toBe(CHUNKS);
    expect(b.ctx.plug.grid.d).toEqual(a.ctx.plug.grid.d);
    const loot = [...b.world.all(Loot)] as LootEntity[];
    expect(loot.filter((l) => l.render.where === LootWhere.Buried).length).toBe(14);
    expect(loot.filter((l) => l.render.where === LootWhere.Stuck).length).toBe(2);
    expect(loot.some((l) => l.render.kind === LootKind.Toilet)).toBe(true);
    expect(a.ctx.me!.render.dive).toBe(sewer.dive);
  });

  it('lets the sewage rise, and open valves drain it', () => {
    const net = new Sim();
    const a = peer(net, 'a');
    startDive(net, [a]);
    const e = a.keeper.sewer!;
    const start = e.state.water;
    run(net, [a], 10000);
    expect(e.state.water).toBeCloseTo(start + RISE * 10, 2);
    // hold E at a valve
    const v = a.ctx.map.valves[0];
    place(a, v.x + v.nx * 0.6, v.y + v.ny * 0.6);
    a.intent.interact = true;
    run(net, [a], 2500);
    a.intent.interact = false;
    expect(e.state[VALVE_FIELDS[0]]).toBeGreaterThan(0.8);
    const high = e.state.water;
    e.state.v1 = e.state.v2 = e.state.v3 = 1;
    run(net, [a], 5000);
    expect(e.state.water).toBeLessThan(high);
    expect(e.state.v0).toBeLessThan(1);
  });

  it('knocks a goblin flying with a punch, and a haymaker bursts it', () => {
    const net = new Sim();
    const a = peer(net, 'a');
    const b = peer(net, 'b');
    const splats: number[] = [];
    b.world.onAction(Splat, (p) => splats.push(p.kind));
    startDive(net, [a, b]);
    const drain = a.ctx.map.drains[0];
    const g = spawnGoblin(b.ctx, drain, b.keeper.sewer!.render.dive) as GoblinEntity;
    run(net, [a, b], 300);
    // stand in front of it and wind up
    faceGoblin(a, g, drain);
    g.state.mode = GoblinMode.Stagger;
    a.intent.trigger = true;
    run(net, [a, b], 800);
    a.intent.trigger = false;
    faceGoblin(a, g, drain);
    run(net, [a, b], 500);
    expect(a.body.punches.length).toBe(1);
    expect(a.body.punches[0]).toBeGreaterThan(1);
    expect(splats).toEqual([1]);
    run(net, [a, b], 1000);
    expect(g.alive).toBe(false);
  });

  it('grabs a goblin, and tears it in half', () => {
    const net = new Sim();
    const a = peer(net, 'a');
    const b = peer(net, 'b');
    startDive(net, [a, b]);
    const drain = a.ctx.map.drains[1];
    const g = spawnGoblin(b.ctx, drain, b.keeper.sewer!.render.dive) as GoblinEntity;
    run(net, [a, b], 300);
    const ga = a.world.getAs(Goblin, g.id)!;
    faceGoblin(a, ga, drain);
    g.state.mode = GoblinMode.Stagger;
    a.intent.grab = true;
    run(net, [a, b], 600);
    expect(a.ctx.me!.state.holding).toBe(g.id);
    expect(ga.mine).toBe(true);
    expect(ga.state.mode).toBe(GoblinMode.Held);
    a.intent.tear = true;
    run(net, [a, b], 800);
    a.intent.tear = false;
    expect(a.body.tears).toBe(1);
    expect(a.ctx.me!.state.holding).toBe(0);
    run(net, [a, b], 800);
    expect(b.world.get(g.id)).toBeUndefined();
  });

  it('digs up buried loot into the sack, and banks it at the ladder', () => {
    const net = new Sim();
    const a = peer(net, 'a');
    startDive(net, [a]);
    const loot = [...a.world.all(Loot)].find((l) => l.render.where === LootWhere.Buried) as LootEntity;
    place(a, loot.x - 0.8, loot.y, 0);
    a.lord.inventory.current = null;
    a.intent.interact = true;
    run(net, [a], 1500);
    a.intent.interact = false;
    expect(a.body.digs).toBe(1);
    expect(a.ctx.me!.state.sack).toBe(1);
    expect(loot.state.where).toBe(LootWhere.Carried);
    const foot = a.ctx.map.ladderFoot;
    place(a, foot.x + 0.3, foot.y + 0.3);
    run(net, [a], 500);
    expect(a.ctx.me!.state.sack).toBe(0);
    expect(a.keeper.sewer!.state.banked).toBe(1);
    expect(a.body.bankedWorth).toBeGreaterThan(0);
  });

  it('lets a goblin snatch loot from a sack, and it drops when the goblin is splattered', () => {
    const net = new Sim();
    const a = peer(net, 'a');
    const b = peer(net, 'b');
    startDive(net, [a, b]);
    const loot = [...a.world.all(Loot)].find((l) => l.render.where === LootWhere.Buried) as LootEntity;
    place(a, loot.x - 0.8, loot.y, 0);
    a.intent.interact = true;
    run(net, [a, b], 1500);
    a.intent.interact = false;
    expect(a.ctx.me!.state.sack).toBe(1);
    const g = spawnGoblin(b.ctx, a.ctx.map.drains[2], b.keeper.sewer!.render.dive) as GoblinEntity;
    // dazed, so it doesn't run off down its drain with the loot
    g.state.mode = GoblinMode.Stagger;
    GoblinMind.of(g).staggerUntil = b.ctx.now + 10000;
    run(net, [a, b], 300);
    b.world.command(Snatch, { target: loot.id, by: g.id });
    run(net, [a, b], 600);
    expect(loot.state.carrier).toBe(g.id);
    expect(a.ctx.me!.state.sack).toBe(0);
    expect(g.state.carrying).toBe(loot.id);
    // punch it dead: the loot falls where it was
    b.world.command(Punch, { target: g.id, by: 0, force: 0.8, dx: 1, dy: 0, dz: 0 });
    run(net, [a, b], 1200);
    expect(loot.state.where).toBe(LootWhere.Lying);
    expect(loot.state.carrier).toBe(0);
  });

  it('builds pressure by pumping, and a charged hose carves through the fatberg for everyone', () => {
    const net = new Sim();
    const a = peer(net, 'a');
    const b = peer(net, 'b');
    startDive(net, [a, b]);
    a.lord.inventory.current = HOSE;
    // zero pressure: nothing happens
    const fat = a.ctx.plug;
    const spot = a.ctx.map.fat;
    const face = fat.frame.toWorld(8, -3, 4);
    const toward = fat.frame.toWorld(8, 2, 4);
    const heading = Math.atan2(toward.y - face.y, toward.x - face.x);
    place(a, face.x, face.y, heading);
    const mass = fat.grid.mass();
    a.intent.trigger = true;
    run(net, [a, b], 1000);
    a.intent.trigger = false;
    expect(fat.grid.mass()).toBe(mass);
    // pump it up
    for (let n = 0; n < 7; n++) {
      a.intent.pump = 0;
      run(net, [a, b], 50);
      a.intent.pump = 1;
      run(net, [a, b], 50);
    }
    a.intent.pump = null;
    expect(a.body.pumps).toBe(7);
    expect(a.lord.charge).toBe(Math.min(100, 7 * STROKE));
    a.intent.trigger = true;
    run(net, [a, b], 5000);
    a.intent.trigger = false;
    expect(fat.grid.mass()).toBeLessThan(mass - 20);
    expect(a.lord.charge).toBeLessThan(5);
    run(net, [a, b], 800);
    expect(b.ctx.plug.grid.d).toEqual(a.ctx.plug.grid.d);
    expect(spot).toBeDefined();
  });

  it('ends rich once everyone still standing climbs out, and a new dive puts them back at the ladder', () => {
    const net = new Sim();
    const a = peer(net, 'a');
    const b = peer(net, 'b');
    startDive(net, [a, b]);
    const foot = a.ctx.map.ladderFoot;
    for (const p of [a, b]) {
      place(p, foot.x, foot.y);
      p.intent.interact = true;
    }
    run(net, [a, b], 2500);
    expect(a.body.out).toBe(true);
    expect(b.ctx.me!.state.mode).toBe(LordMode.Surfaced);
    const sewer = a.keeper.sewer!.render;
    expect(sewer.phase).toBe(Phase.Over);
    expect(sewer.result).toBe(Result.Rich);
    for (const p of [a, b]) p.intent.interact = false;
    run(net, [a, b], 13000);
    expect(a.keeper.sewer!.render.phase).toBe(Phase.Gather);
    expect(a.ctx.me!.state.mode).toBe(LordMode.Active);
    expect(a.ctx.me!.state.hp).toBe(MAX_HP);
    expect([...a.world.all(FatChunk)].every((c) => c.render.dive === a.keeper.sewer!.render.dive)).toBe(true);
  });

  it('knocks a Lord down with enough scratches, and a friend hauls them up', () => {
    const net = new Sim();
    const a = peer(net, 'a');
    const b = peer(net, 'b');
    startDive(net, [a, b]);
    const ga = [...a.world.all(Sewer)][0];
    expect(ga).toBeDefined();
    for (let n = 0; n < MAX_HP; n++) {
      a.lord.hurt(1, 0, 0);
      run(net, [a, b], 1300);
    }
    expect(a.ctx.me!.state.mode).toBe(LordMode.Downed);
    expect(a.body.downs).toBe(1);
    const s = a.ctx.me!.state;
    place(b, s.x + 1, s.y);
    b.intent.interact = true;
    run(net, [a, b], 4000);
    b.intent.interact = false;
    expect(a.ctx.me!.state.mode).toBe(LordMode.Active);
    expect(a.body.ups).toBe(1);
  });
});

describe('In a headset', () => {
  /** A tracked hand at a point, pointing along +x, holding `tool` or nothing. */
  function hand(h: HandIntent, x: number, y: number, z: number, grab: boolean, tool: HandIntent['tool'] = null): void {
    Object.assign(h, { tracked: true, grab, tool, trigger: false });
    Object.assign(h.grip, { x, y, z });
    Object.assign(h.pointing, { x: 1, y: 0, z: 0 });
    Object.assign(h.aim, { x: 1, y: 0, z: 0 });
    Object.assign(h.tip, tool ? { x: x + 0.7, y, z } : { x, y, z });
  }

  function trackedPeer(net: Sim, id: string): { p: Peer; right: HandIntent; left: HandIntent } {
    const p = peer(net, id);
    const right = handIntent();
    const left = handIntent();
    p.intent.hands = [right, left];
    return { p, right, left };
  }

  /** Keep the tracked head where the Lord stands. */
  function head(p: Peer): void {
    const s = p.ctx.me!.state;
    p.intent.head = { x: s.x, y: s.y, z: 1.65, heading: 0, pitch: 0 };
  }

  it('pumps the hose with the other hand sliding back and forth along it', () => {
    const net = new Sim();
    const { p: a, right, left } = trackedPeer(net, 'a');
    startDive(net, [a]);
    const s = a.ctx.me!.state;
    const slide = (back: number) => {
      head(a);
      hand(right, s.x + 0.2, s.y, 1.2, false, HOSE);
      hand(left, s.x + 0.55 - back, s.y, 1.2, true);
    };
    for (let n = 0; n < 5; n++) {
      slide(0);
      run(net, [a], 120);
      slide(0.13);
      run(net, [a], 120);
    }
    slide(0);
    run(net, [a], 120);
    expect(a.body.pumps).toBe(5);
    expect(a.lord.charge).toBe(5 * STROKE);
  });

  it('grabs a goblin in one hand, and tears it in half pulling the other away', () => {
    const net = new Sim();
    const { p: a, right, left } = trackedPeer(net, 'a');
    startDive(net, [a]);
    const drain = a.ctx.map.drains[3];
    const g = spawnGoblin(a.ctx, drain, a.keeper.sewer!.render.dive) as GoblinEntity;
    g.state.mode = GoblinMode.Stagger;
    GoblinMind.of(g).staggerUntil = a.ctx.now + 1e6;
    place(a, g.x + drain.nx * 0.6, g.y + drain.ny * 0.6);
    run(net, [a], 50);
    const at = { x: g.state.x, y: g.state.y, z: g.state.z + 0.9 };
    head(a);
    hand(right, at.x, at.y, at.z, true);
    hand(left, at.x, at.y, 0.3, false);
    run(net, [a], 200);
    expect(a.ctx.me!.state.holding).toBe(g.id);
    // the other hand on it too, then pulled away
    hand(left, at.x, at.y, at.z - 0.35, true);
    run(net, [a], 100);
    hand(left, at.x, at.y, at.z - 0.75, true);
    run(net, [a], 100);
    expect(a.body.tears).toBe(1);
    expect(a.ctx.me!.state.holding).toBe(0);
  });
});
