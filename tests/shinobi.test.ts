import { describe, expect, it } from 'vitest';
import type { NetWorld } from '../src/engine/net/world';
import { HandClimb } from '../src/crossplay/climb';
import { handIntent } from '../src/crossplay/intent';
import { Platform } from '../src/crossplay/platform';
import { registerActions } from '../src/shinobi/actions';
import { CaptainRole, type CaptainBody } from '../src/shinobi/captain';
import { Castle, GATE, Paths, SIZE, START, STEP, Tile, WALL, WALL_HEIGHT } from '../src/shinobi/castle';
import type { GuardEntity, ShinobiContext } from '../src/shinobi/context';
import { ACTIONS, Alert, Blade, ENTITIES, Guard, GuardKind, GuardMode, Noise, OrderKind, Phase, Result, ShinobiMode, Weapon } from '../src/shinobi/defs';
import { Flights } from '../src/shinobi/flights';
import { stepRules } from '../src/shinobi/frame';
import { CHECKIN_SECONDS, GuardMind, POST_HOME } from '../src/shinobi/guards';
import { Call, idleCaptainIntent, idleShinobiIntent, stillCaptain, type CaptainIntent, type ShinobiIntent } from '../src/shinobi/intent';
import { KUNAI, SHURIKEN, TANTO } from '../src/shinobi/kit';
import { OVER_SECONDS, RoundKeeper, WAIT_SECONDS } from '../src/shinobi/round';
import { MAX_HP, ShinobiRole, type ShinobiBody } from '../src/shinobi/shinobi';
import { Sim } from './harness';

const SEED = 1603;
const castle = new Castle(SEED);
const stub = () => new Proxy({}, { get: () => () => {} });

class TestShinobiBody implements ShinobiBody {
  platform = Platform.Desktop;
  hurts = 0;
  climbs = 0;
  overs = 0;
  hardLandings = 0;
  takedowns: GuardKind[] = [];
  picks = 0;
  out = false;
  moved(): void {}
  placed(): void {}
  hurt(): void {
    this.hurts++;
  }
  used(): void {}
  died(): void {}
  climbed(over: boolean): void {
    if (over) this.overs++;
    else this.climbs++;
  }
  gripped(): void {}
  landed(hard: boolean): void {
    if (hard) this.hardLandings++;
  }
  tookDown(kind: GuardKind): void {
    this.takedowns.push(kind);
  }
  picked(): void {
    this.picks++;
  }
  downed(): void {}
  helpedUp(): void {}
  escaped(): void {
    this.out = true;
  }
  restarted(): void {}
}

class TestCaptainBody implements CaptainBody {
  platform = Platform.Touch;
  refusals: string[] = [];
  uses: Call[] = [];
  orders = 0;
  used(call: Call): void {
    this.uses.push(call);
  }
  refused(reason: string): void {
    this.refusals.push(reason);
  }
  ordered(): void {
    this.orders++;
  }
}

interface Peer {
  ctx: ShinobiContext;
  world: NetWorld;
  keeper: RoundKeeper;
  shinobi?: ShinobiRole;
  body?: TestShinobiBody;
  intent?: ShinobiIntent;
  captain?: CaptainRole;
  cbody?: TestCaptainBody;
  cintent?: CaptainIntent;
  noises: number[];
}

function peer(net: Sim, id: string, role: 'shinobi' | 'captain' | 'none', name = id): Peer {
  const world = net.add(id, { worldId: 'shinobi-test', entities: ENTITIES, actions: ACTIONS, zoneSize: 4096, cellSize: 1024, interestRadius: 400, spatialCellSize: 16 });
  let keeper!: RoundKeeper;
  const ctx = {
    world,
    castle,
    paths: new Paths(castle),
    sfx: stub() as never,
    hud: stub() as never,
    settings: { open: false } as never,
    fx: stub() as never,
    me: null,
    captain: null,
    round: () => keeper.round,
    playerName: name,
    now: net.now,
  } as unknown as ShinobiContext;
  ctx.flights = new Flights(ctx);
  keeper = new RoundKeeper(ctx);
  const noises: number[] = [];
  const p: Peer = { ctx, world, keeper, noises };
  if (role === 'shinobi') {
    p.shinobi = new ShinobiRole(ctx);
    p.body = new TestShinobiBody();
    p.shinobi.attach(p.body);
    p.intent = idleShinobiIntent();
    p.shinobi.spawn();
  } else if (role === 'captain') {
    p.captain = new CaptainRole(ctx);
    p.cbody = new TestCaptainBody();
    p.captain.attach(p.cbody);
    p.cintent = idleCaptainIntent();
    p.captain.spawn();
  }
  registerActions(ctx, keeper, { shinobi: p.shinobi, captain: p.captain });
  world.onAction(Noise, (n) => noises.push(n.kind));
  return p;
}

function frame(p: Peer, now: number, dt: number): void {
  p.ctx.now = now;
  p.shinobi?.update(dt, p.intent!);
  p.captain?.update(dt, p.cintent!);
  if (p.cintent) stillCaptain(p.cintent);
  if (p.intent) {
    p.intent.jump = false;
    p.intent.turn = p.intent.lookUp = 0;
  }
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

/** Put a shinobi somewhere on the ground, facing a way. */
function place(p: Peer, x: number, y: number, heading: number): void {
  const s = p.ctx.me!.state;
  s.x = x;
  s.y = y;
  s.z = 0;
  (p.shinobi as unknown as { feet: number }).feet = 0;
  p.shinobi!.heading = heading;
  p.shinobi!.pitch = 0;
}

/** Skip the wait in the forest. */
function startNight(net: Sim, peers: Peer[]): void {
  run(net, peers, 3500);
  const owner = peers.find((p) => p.keeper.round?.mine)!;
  owner.keeper.round!.state.timer = 0.05;
  run(net, peers, 300);
}

/** Every guard, owned or not, from one peer's view. */
function guards(p: Peer, kind?: GuardKind): GuardEntity[] {
  return ([...p.world.all(Guard)] as GuardEntity[]).filter((g) => kind === undefined || g.render.kind === kind);
}

/** Take every guard but one out of the way (far off in a corner, posted, facing the wall), so a test sees only it. */
function clearAllBut(p: Peer, ...keep: GuardEntity[]): void {
  for (const g of guards(p)) {
    if (keep.includes(g) || !g.mine) continue;
    if (g.state.kind === GuardKind.Lord) {
      Object.assign(g.state, { x: 90, y: 90, mode: GuardMode.Post, tx: 90, ty: 90 });
      continue;
    }
    p.world.despawn(g);
  }
}

describe('The castle', () => {
  it('is the same castle for the same seed, and every bit of ground inside the wall can be walked to from the gate', () => {
    const again = new Castle(SEED);
    expect(again.tiles).toEqual(castle.tiles);
    expect(again.heights).toEqual(castle.heights);
    const reach = castle.reachable();
    let open = 0;
    for (let j = WALL.y0 + 1; j < WALL.y1; j++) {
      for (let i = WALL.x0 + 1; i < WALL.x1; i++) {
        if (!castle.open(i, j)) continue;
        open++;
        expect(reach[j * SIZE + i], `cell ${i},${j}`).toBe(1);
      }
    }
    expect(open).toBeGreaterThan(3000);
    expect(castle.buildings.length).toBeGreaterThan(12);
    expect(castle.stations.length).toBeGreaterThanOrEqual(3);
    expect(castle.routes.length).toBe(4);
    expect(castle.perches.length).toBe(6);
    expect(castle.lanterns.length).toBeGreaterThan(10);
    expect(castle.tile(GATE.x0, GATE.y)).toBe(Tile.Gate);
    for (const s of castle.stations) expect(reach[Math.floor(s.y) * SIZE + Math.floor(s.x)]).toBe(1);
    for (const route of castle.routes) for (const s of route) expect(reach[Math.floor(s.y) * SIZE + Math.floor(s.x)]).toBe(1);
  });

  it('lets a body walk over what is no more than a step up, stand on roofs, and see over low things but not through walls', () => {
    // the wall blocks at ground level, and holds you up on top
    const p = { x: 30.5, y: WALL.y0 + 1.6 };
    castle.move(p, 0, -2, 0.35, 0);
    expect(p.y).toBeGreaterThan(WALL.y0 + 1.3);
    expect(castle.support(30.5, WALL.y0 + 0.5, WALL_HEIGHT)).toBe(WALL_HEIGHT);
    expect(castle.support(30.5, WALL.y0 + 0.5, 0)).toBe(0);
    expect(STEP).toBeLessThan(1);
    // through the wall from outside, no; over it from a tower, yes
    expect(castle.sees(30.5, WALL.y0 - 3, 1.6, 30.5, WALL.y0 + 5, 1.6)).toBe(false);
    expect(castle.sees(30.5, WALL.y0 - 3, 8, 30.5, WALL.y0 + 5, 1.6)).toBe(true);
    // a hand on the wall's top edge can hold it; one in the open air can't
    expect(castle.holdable({ x: 30.5, y: WALL.y0 + 1.05, z: WALL_HEIGHT - 0.1 })).toBe(true);
    expect(castle.holdable({ x: 30.5, y: WALL.y0 + 2, z: 2 })).toBe(false);
  });
});

describe('Climbing', () => {
  it('takes a virtual head up a wall while climb is held, over the top, along it, and down with a thud', () => {
    const net = new Sim();
    const a = peer(net, 'a', 'shinobi');
    // until the night's known, so it doesn't send us back to the forest mid-climb
    run(net, [a], 4000);
    place(a, 30.5, WALL.y0 - 1.2, Math.PI / 2);
    a.intent!.forward = 0.2;
    a.intent!.climb = true;
    run(net, [a], 3500);
    a.intent!.climb = false;
    a.intent!.forward = 0;
    const s = a.ctx.me!.state;
    expect(a.body!.climbs).toBe(1);
    expect(a.body!.overs).toBe(1);
    expect(s.z).toBeCloseTo(WALL_HEIGHT, 1);
    expect(Math.floor(s.y)).toBe(WALL.y0);
    // walk along the top of the wall
    a.shinobi!.heading = 0;
    a.intent!.forward = 1;
    run(net, [a], 1000);
    expect(s.x).toBeGreaterThan(32);
    expect(s.z).toBeCloseTo(WALL_HEIGHT, 1);
    // step off inside, standing up: a loud landing
    a.intent!.forward = 0;
    a.shinobi!.heading = Math.PI / 2;
    a.intent!.forward = 1;
    run(net, [a], 700);
    a.intent!.forward = 0;
    run(net, [a], 600);
    expect(s.z).toBe(0);
    expect(a.body!.hardLandings).toBe(1);
    expect(a.noises).toContain(1 /* Sound.Land */);
  });

  it('holds tracked hands where they took hold and moves the body round them', () => {
    const climb = new HandClimb();
    const hands: [ReturnType<typeof handIntent>, ReturnType<typeof handIntent>] = [handIntent(), handIntent()];
    const out = { x: 0, y: 0, z: 0 };
    hands[0].tracked = true;
    hands[0].grab = true;
    hands[0].grip = { x: 1, y: 2, z: 1.8 };
    expect(climb.update(hands, () => false, out)).toBe(false);
    expect(climb.update(hands, () => true, out)).toBe(true);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
    // the hand pulls down 30 cm: the body goes up 30 cm
    hands[0].grip = { x: 1, y: 2, z: 1.5 };
    climb.update(hands, () => false, out);
    expect(out.z).toBeCloseTo(0.3, 5);
    // both hands average; letting go of one keeps the other
    hands[1].tracked = hands[1].grab = true;
    hands[1].grip = { x: 1.4, y: 2, z: 1.7 };
    climb.update(hands, () => true, out);
    expect(out.z).toBeCloseTo(0.15, 5);
    hands[0].grab = false;
    expect(climb.update(hands, () => false, out)).toBe(true);
    expect(climb.holds(0)).toBe(false);
    climb.release();
    expect(climb.holding).toBe(false);
  });
});

describe('The watch', () => {
  it('musters guards, archers, and the lord with his samurai when the night begins', () => {
    const net = new Sim();
    const a = peer(net, 'a', 'shinobi');
    run(net, [a], 3500);
    expect(a.keeper.round!.state.phase).toBe(Phase.Waiting);
    expect(a.keeper.round!.state.timer).toBeLessThan(WAIT_SECONDS);
    startNight(net, [a]);
    const round = a.keeper.round!.state;
    expect(round.phase).toBe(Phase.Night);
    expect(guards(a, GuardKind.Lord).length).toBe(1);
    expect(round.lord).toBe(guards(a, GuardKind.Lord)[0].id);
    expect(guards(a, GuardKind.Samurai).length).toBe(2);
    expect(guards(a, GuardKind.Archer).length).toBe(4);
    for (const g of guards(a, GuardKind.Archer)) expect(g.state.z).toBeGreaterThan(5);
    expect(guards(a, GuardKind.Spear).length).toBeGreaterThanOrEqual(8);
    // patrols move
    const walker = guards(a, GuardKind.Spear).find((g) => g.state.mode === GuardMode.Patrol)!;
    const from = { x: walker.state.x, y: walker.state.y };
    run(net, [a], 3000);
    expect(Math.hypot(walker.state.x - from.x, walker.state.y - from.y)).toBeGreaterThan(2);
  });

  it('sees a shinobi standing in lantern light in front of it, raises the alarm and strikes; misses one crouched in a bush', () => {
    const net = new Sim();
    const a = peer(net, 'a', 'shinobi');
    startNight(net, [a]);
    const post = guards(a).find((g) => g.state.home === POST_HOME + 2)!;
    clearAllBut(a, post);
    const gs = post.state;

    // a bush in the dark near the post, if there is one, else skip that half
    const bush = findCell((i, j) => castle.tile(i, j) === Tile.Bush && castle.staticLight(i + 0.5, j + 0.5) < 0.35 && Math.hypot(i - gs.x, j - gs.y) > 4 && Math.hypot(i - gs.x, j - gs.y) < 8);
    if (bush) {
      place(a, bush.x, bush.y, 0);
      a.intent!.crouch = true;
      GuardMind.of(post).facing = Math.atan2(bush.y - gs.y, bush.x - gs.x);
      gs.angle = GuardMind.of(post).facing;
      run(net, [a], 3000);
      expect(a.shinobi!.hidden).toBe(true);
      expect(gs.alert).toBe(Alert.Calm);
      a.intent!.crouch = false;
    }

    // standing in the open right in front of it, by its own lantern
    place(a, gs.x + Math.cos(gs.angle) * 3, gs.y + Math.sin(gs.angle) * 3, gs.angle + Math.PI);
    let chased = false;
    run(net, [a], 6000, () => {
      if (gs.mode === GuardMode.Chase && gs.alert === Alert.Alarmed && gs.target === a.ctx.me!.id) chased = true;
    });
    expect(chased).toBe(true);
    expect(a.body!.hurts).toBeGreaterThan(0);
    expect(a.ctx.me!.state.hp).toBeLessThan(MAX_HP);
  });

  it('comes to look at a blade that clatters nearby', () => {
    const net = new Sim();
    const a = peer(net, 'a', 'shinobi');
    startNight(net, [a]);
    const post = guards(a).find((g) => g.state.home === POST_HOME + 2)!;
    clearAllBut(a, post);
    const gs = post.state;
    // turn it to face the keep, and from well behind it, out of its sight, throw a shuriken at the ground to its side
    GuardMind.of(post).facing = gs.angle = Math.PI / 2;
    run(net, [a], 100);
    place(a, gs.x, gs.y - 12, Math.PI / 2);
    a.shinobi!.inventory.select(SHURIKEN);
    const s = a.ctx.me!.state;
    const tx = gs.x + 5;
    const ty = gs.y - 1;
    a.shinobi!.heading = Math.atan2(ty - s.y, tx - s.x);
    a.shinobi!.pitch = -Math.atan2(1.6, Math.hypot(tx - s.x, ty - s.y)) + 0.02;
    a.intent!.trigger = true;
    run(net, [a], 50);
    a.intent!.trigger = false;
    expect(a.shinobi!.inventory.charges(SHURIKEN)).toBe(7);
    run(net, [a], 1500);
    expect(a.noises).toContain(2 /* Sound.Clatter */);
    expect(gs.mode).toBe(GuardMode.Investigate);
    expect(gs.alert).toBe(Alert.Suspicious);
    expect([...a.world.all(Blade)].length).toBe(1);
  });

  it('dies silently to a tanto from behind, and to a kunai it never saw coming; a shuriken only alarms it', async () => {
    const net = new Sim();
    const a = peer(net, 'a', 'shinobi');
    startNight(net, [a]);
    const posts = guards(a).filter((g) => g.state.home >= POST_HOME);
    const [first, second, third] = posts;
    clearAllBut(a, first, second, third);

    // the other two far off, out of sight of the first
    const [row2, row3] = clearRows();
    const s2 = second.state;
    const s3 = third.state;
    Object.assign(s2, { x: 60.5, y: row2, tx: 60.5, ty: row2, mode: GuardMode.Post, alert: Alert.Calm, sus: 0, look: 0 });
    Object.assign(s3, { x: 60.5, y: row3, tx: 60.5, ty: row3, mode: GuardMode.Post, alert: Alert.Calm, sus: 0, look: 0 });
    GuardMind.of(second).facing = s2.angle = 0;
    GuardMind.of(third).facing = s3.angle = 0;
    run(net, [a], 100);

    // creep up behind the first and strike
    const gs = first.state;
    const behind = gs.angle + Math.PI;
    place(a, gs.x + Math.cos(behind) * 1.2, gs.y + Math.sin(behind) * 1.2, gs.angle);
    GuardMind.of(first).facing = gs.angle;
    first.state.look = 0;
    a.intent!.crouch = true;
    run(net, [a], 50);
    a.intent!.trigger = true;
    run(net, [a], 50);
    a.intent!.trigger = false;
    run(net, [a], 300);
    expect(gs.mode).toBe(GuardMode.Dead);
    expect(a.body!.takedowns).toEqual([GuardKind.Spear]);
    expect(a.noises).not.toContain(4 /* Sound.Shout */);
    expect(a.ctx.me!.state.kills).toBe(1);

    // a kunai into the second from across the courtyard
    a.intent!.crouch = false;
    place(a, 52.5, row2, 0);
    a.shinobi!.pitch = 0.02;
    a.shinobi!.inventory.select(KUNAI);
    run(net, [a], 20);
    a.intent!.trigger = true;
    run(net, [a], 30);
    a.intent!.trigger = false;
    run(net, [a], 800);
    expect(s2.mode).toBe(GuardMode.Dead);
    expect(a.shinobi!.inventory.charges(KUNAI)).toBe(2);
    // the kunai lies at its feet, to pick up again
    const blade = [...a.world.all(Blade)].find((b) => b.render.kind === Weapon.Kunai)!;
    expect(Math.hypot(blade.render.x - 60.5, blade.render.y - row2)).toBeLessThan(1.5);
    place(a, blade.render.x, blade.render.y, 0);
    run(net, [a], 300);
    // (taking it is asynchronous: ownership is a lock)
    await new Promise((resolve) => setTimeout(resolve, 0));
    run(net, [a], 300);
    expect(a.shinobi!.inventory.charges(KUNAI)).toBe(3);
    expect(a.body!.picks).toBe(1);

    // a shuriken in the third's back: hurt and alarmed, coming for you
    place(a, 52.5, row3, 0);
    a.shinobi!.inventory.select(SHURIKEN);
    run(net, [a], 20);
    a.intent!.trigger = true;
    run(net, [a], 30);
    a.intent!.trigger = false;
    run(net, [a], 600);
    expect(s3.mode).not.toBe(GuardMode.Dead);
    expect(s3.hp).toBe(1);
    expect(s3.alert).toBe(Alert.Alarmed);
    expect(a.shinobi!.inventory.current).toBe(SHURIKEN);
    expect(TANTO.issued).toBe(1);
  });
});

describe('The Captain of the Watch', () => {
  it('only sees a shinobi a guard sees, and hears only what a guard heard', () => {
    const net = new Sim();
    const a = peer(net, 'a', 'shinobi');
    const c = peer(net, 'c', 'captain');
    const all = [a, c];
    startNight(net, all);
    const owner = [a, c].find((p) => guards(p).some((g) => g.mine))!;
    const post = guards(owner).find((g) => g.state.home === POST_HOME + 2)!;
    clearAllBut(owner, post);
    const gs = post.state;
    run(net, all, 400);

    // far off in the dark: unseen, and its running feet unheard
    place(a, 90, 50, Math.PI / 2);
    a.intent!.forward = 1;
    a.intent!.run = true;
    run(net, all, 1500);
    a.intent!.forward = 0;
    a.intent!.run = false;
    expect(c.captain!.intel.sees(a.ctx.me!.id)).toBe(false);
    expect(c.captain!.intel.pings.length).toBe(0);

    // in front of the guard: seen
    place(a, gs.x + Math.cos(gs.angle) * 4, gs.y + Math.sin(gs.angle) * 4, 0);
    // (it glances either side as it stands there, so give its eyes time to come round)
    run(net, all, 5000, () => {
      if (c.captain!.intel.sees(a.ctx.me!.id)) a.intent!.crouch = false;
    });
    expect(c.captain!.intel.sees(a.ctx.me!.id)).toBe(true);
    expect(c.captain!.intel.pings.some((p) => p.kind === 'shout')).toBe(true);
  });

  it("sends a picked-out guard to search where it's told, and learns a guard is dead when he misses his check-in", () => {
    const net = new Sim();
    const a = peer(net, 'a', 'shinobi');
    const c = peer(net, 'c', 'captain');
    const all = [a, c];
    startNight(net, all);
    place(a, 90, 90, 0);
    const walker = guards(c, GuardKind.Spear).find((g) => g.render.mode === GuardMode.Patrol)!;
    c.cintent!.pointer = { x: walker.x, y: walker.y };
    c.cintent!.primary = true;
    run(net, all, 50);
    expect(c.captain!.selected.has(walker.id)).toBe(true);
    const spot = castle.nearestOpen(60, 70);
    c.cintent!.pointer = { x: spot.x, y: spot.y };
    c.cintent!.secondary = true;
    run(net, all, 400);
    expect(c.cbody!.orders).toBe(1);
    expect(walker.render.mode).toBe(GuardMode.Search);
    expect(Math.hypot(walker.render.tx - spot.x, walker.render.ty - spot.y)).toBeLessThan(1);

    // a guard dies unseen and unheard; the captain doesn't know until he misses his check-in
    const victim = guards(c, GuardKind.Spear).find((g) => g !== walker && g.render.mode === GuardMode.Patrol)!;
    const owner = [a, c].find((p) => p.world.get(victim.id)?.mine)!;
    const vs = owner.world.getAs(Guard, victim.id)!.state;
    run(net, all, 200);
    vs.mode = GuardMode.Dead;
    run(net, all, 1000);
    expect(c.captain!.intel.standing(victim)).toBe(true);
    run(net, all, (CHECKIN_SECONDS + 5) * 1000);
    expect(c.captain!.intel.standing(victim)).toBe(false);
    expect(c.captain!.intel.pings.some((p) => p.kind === 'quiet') || c.captain!.intel.pings.some((p) => p.kind === 'body')).toBe(true);
  });

  it('lights braziers, and moves the lord', () => {
    const net = new Sim();
    const a = peer(net, 'a', 'shinobi');
    const c = peer(net, 'c', 'captain');
    const all = [a, c];
    startNight(net, all);
    place(a, 90, 90, 0);
    c.cintent!.arm = Call.Braziers;
    c.cintent!.pointer = { x: 30, y: 40 };
    c.cintent!.primary = true;
    run(net, all, 300);
    expect(c.cbody!.uses).toEqual([Call.Braziers]);
    // the light it casts shows up in a shinobi's exposure
    place(a, 30, 40, 0);
    run(net, all, 400);
    expect(a.shinobi!.exposure).toBeGreaterThanOrEqual(0.75);
    c.cintent!.arm = Call.Braziers;
    c.cintent!.pointer = { x: 30, y: 60 };
    c.cintent!.primary = true;
    run(net, all, 100);
    expect(c.cbody!.refusals.at(-1)).toMatch(/Braziers in/);

    const far = castle.stations.length - 1;
    c.cintent!.arm = Call.MoveLord;
    c.cintent!.pointer = { x: castle.stations[far].x, y: castle.stations[far].y };
    c.cintent!.primary = true;
    run(net, all, 300);
    const lord = guards(c, GuardKind.Lord)[0];
    expect(lord.render.wp).toBe(far);
  });
});

describe('A night at the castle', () => {
  it('ends when the lord is killed and a shinobi gets back over the wall', () => {
    const net = new Sim();
    const a = peer(net, 'a', 'shinobi');
    startNight(net, [a]);
    const lord = guards(a, GuardKind.Lord)[0];
    clearAllBut(a, lord);
    Object.assign(lord.state, { x: 40.5, y: 30.5, mode: GuardMode.Escort, left: 60, angle: 0 });
    // behind him
    place(a, 39.3, 30.5, 0);
    a.intent!.crouch = true;
    run(net, [a], 30);
    a.intent!.trigger = true;
    run(net, [a], 30);
    a.intent!.trigger = false;
    run(net, [a], 400);
    expect(lord.state.mode).toBe(GuardMode.Dead);
    expect(a.body!.takedowns).toContain(GuardKind.Lord);
    const round = a.keeper.round!.state;
    expect(round.phase).toBe(Phase.Escape);

    // out through the gate
    place(a, (GATE.x0 + GATE.x1 + 1) / 2, WALL.y0 + 2, -Math.PI / 2);
    a.intent!.crouch = false;
    a.intent!.forward = 1;
    run(net, [a], 2000);
    expect(a.body!.out).toBe(true);
    expect(a.ctx.me!.state.mode).toBe(ShinobiMode.Escaped);
    run(net, [a], 300);
    expect(round.phase).toBe(Phase.Over);
    expect(round.result).toBe(Result.Assassinated);
    expect(round.escaped).toBe(1);

    // and the next night starts afresh
    round.timer = 0.05;
    run(net, [a], 500);
    expect(round.phase).toBe(Phase.Waiting);
    expect(a.world.all(Guard).size).toBe(0);
    expect(a.ctx.me!.state.mode).toBe(ShinobiMode.Alive);
    expect(Math.hypot(a.ctx.me!.state.x - START.x, a.ctx.me!.state.y - START.y)).toBeLessThan(8);
    expect(OVER_SECONDS).toBeGreaterThan(0);
    expect(OrderKind.Search).toBe(0);
  });
});

/** Two rows of open ground from x 51 to 62, a few apart, for throwing along. */
function clearRows(): [number, number] {
  const rows: number[] = [];
  for (let j = WALL.y0 + 3; j < WALL.y1 - 2 && rows.length < 2; j++) {
    let clear = true;
    for (let i = 51; i <= 62; i++) if (castle.height(i, j) > 0 || castle.height(i, j - 1) > 0 || castle.height(i, j + 1) > 0) clear = false;
    if (clear && (!rows.length || j - rows[0] > 16)) rows.push(j + 0.5);
  }
  return [rows[0], rows[1]];
}

function findCell(ok: (i: number, j: number) => boolean): { x: number; y: number } | null {
  for (let j = WALL.y0 + 2; j < WALL.y1 - 1; j++) for (let i = WALL.x0 + 2; i < WALL.x1 - 1; i++) if (ok(i, j)) return { x: i + 0.5, y: j + 0.5 };
  return null;
}
