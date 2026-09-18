import { defineLocal } from '@engine/index';
import type { Castle, Post, Spot } from './castle';
import { angleDiff, clamp, type GuardEntity, type ShinobiContext, type ShinobiEntity, type Vec3 } from './context';
import { Alert, Feed, Guard, GuardKind, GuardMode, Noise, OrderKind, Phase, Report, ReportKind, Shinobi, ShinobiMode, Sound, Tally, Weapon, Wound } from './defs';
import { FLIGHTS } from './kit';

export interface GuardSpec {
  name: string;
  hp: number;
  walk: number;
  run: number;
  radius: number;
  height: number;
  /** Eye height above its feet. */
  eye: number;
  /** How close it strikes from (an archer: how far it shoots), how hard, and how often. */
  reach: number;
  damage: number;
  cooldownMs: number;
  /** How far it sees a shinobi standing in full light, m, and how wide either side of where it looks, radians. */
  sight: number;
  fov: number;
}

export const GUARDS: Record<GuardKind, GuardSpec> = {
  [GuardKind.Spear]: { name: 'guard', hp: 2, walk: 1.5, run: 4.4, radius: 0.35, height: 1.75, eye: 1.6, reach: 2.3, damage: 1, cooldownMs: 1100, sight: 17, fov: 0.95 },
  [GuardKind.Archer]: { name: 'archer', hp: 2, walk: 1.4, run: 4, radius: 0.35, height: 1.75, eye: 1.6, reach: 30, damage: 1, cooldownMs: 2600, sight: 26, fov: 1.05 },
  [GuardKind.Samurai]: { name: 'samurai', hp: 4, walk: 1.3, run: 5, radius: 0.4, height: 1.8, eye: 1.65, reach: 2.3, damage: 2, cooldownMs: 1300, sight: 15, fov: 0.95 },
  [GuardKind.Lord]: { name: 'lord', hp: 3, walk: 1.1, run: 3.4, radius: 0.4, height: 1.75, eye: 1.55, reach: 0, damage: 0, cooldownMs: 0, sight: 12, fov: 0.85 },
};

/** How far off each sound carries to a guard's ears, m. */
export const EARSHOT: Record<Sound, number> = {
  [Sound.Steps]: 7,
  [Sound.Land]: 9,
  [Sound.Clatter]: 12,
  [Sound.Fall]: 8,
  [Sound.Shout]: 22,
  [Sound.Attack]: 7,
  [Sound.Stab]: 5,
  [Sound.Bell]: 0,
  [Sound.Cry]: 14,
  [Sound.Pickup]: 0,
  [Sound.Gong]: 200,
  [Sound.Kindle]: 0,
};

/** How often a living guard checks in, s: the captain notices one that's stopped. */
export const CHECKIN_SECONDS = 10;
/** A guard this sure it saw something goes to look; this sure, raises the alarm. */
const SUSPICIOUS = 0.35;
/** How long an alarmed guard goes on after losing sight of an intruder, ms, before it searches where they were. */
const LOSE_MS = 6000;
/** How long a guard looks round where it heard or saw something, and a captain's search lasts, s. */
const INVESTIGATE_SECONDS = 12;
export const SEARCH_SECONDS = 25;
/** How far a searching guard sweeps round the spot it was sent to, m. */
const SEARCH_RADIUS = 7;
/** A samurai goes no further than this from the lord after anyone. */
const LEASH = 14;
/** How far a guard notices a dead body from, m. */
const BODY_SIGHT = 13;
/** How long the lord rests at a station, s. */
const REST_SECONDS = [35, 65] as const;
/** The alarm's widening of a guard's eyes. */
const ALARM_SIGHT = 1.3;
/** How long a guard keeps quiet after shouting, ms, and after hearing someone else shout (no need to echo them). */
const SHOUT_MS = 20000;
const ECHO_MS = 8000;
/** How often a guard tells the captain it's still after the same intruder, ms. */
const REPORT_MS = 8000;

interface GuardLocal {
  nextLook: number;
  nextPath: number;
  waypoint: Spot | null;
  nextStrike: number;
  /** The shinobi last seen, where, and when. */
  seenId: number;
  seenX: number;
  seenY: number;
  seenAt: number;
  nextBodies: number;
  nextCheckin: number;
  /** Which way a posted guard watches. */
  facing: number;
  /** Where a search is centred. */
  cx: number;
  cy: number;
  /** Reached where it was going. */
  arrived: boolean;
  /** When it last shouted, heard another guard shout, and told the captain of an intruder (and which). */
  shoutedAt: number;
  heardShoutAt: number;
  reportedAt: number;
  reportedId: number;
}

export const GuardMind = defineLocal<GuardLocal>(() => ({
  nextLook: 0,
  nextPath: 0,
  waypoint: null,
  nextStrike: 0,
  seenId: 0,
  seenX: 0,
  seenY: 0,
  seenAt: -1e9,
  nextBodies: 0,
  nextCheckin: 0,
  facing: NaN,
  cx: 0,
  cy: 0,
  arrived: false,
  shoutedAt: -1e9,
  heardShoutAt: -1e9,
  reportedAt: -1e9,
  reportedId: 0,
}));

/** Bodies a peer's guards have already raised the alarm over. */
const BodyMind = defineLocal<{ found: boolean }>(() => ({ found: false }));

/** Posts are numbered from here in a spearman's `home`; below it, it walks the route with that index. */
export const POST_HOME = 100;

export interface GuardLike {
  x: number;
  y: number;
  z: number;
  angle: number;
  look: number;
  kind: GuardKind;
  alert: Alert;
}

export interface ShinobiLike {
  x: number;
  y: number;
  z: number;
  head: number;
  exposure: number;
  mode: ShinobiMode;
}

/**
 * How plainly a guard sees a shinobi, 0 (not at all) to 1: close, in the light and standing up is plain. Hidden in the
 * dark, crouching in a bush, it has to be very close to see anything. Everyone works this out from what they receive,
 * which is how the captain knows only what the guards see.
 */
export function spotting(castle: Castle, g: GuardLike, sv: ShinobiLike, alarm: boolean): number {
  if (sv.mode === ShinobiMode.Dead || sv.mode === ShinobiMode.Escaped) return 0;
  const spec = GUARDS[g.kind];
  const ex = g.x;
  const ey = g.y;
  const ez = g.z + spec.eye;
  const cz = sv.z + sv.head * 0.75;
  const dx = sv.x - ex;
  const dy = sv.y - ey;
  const d = Math.hypot(dx, dy, cz - ez);
  const wary = alarm || g.alert === Alert.Alarmed;
  if (d < 1.3 && sv.exposure > 0.12) return castle.sees(ex, ey, ez, sv.x, sv.y, cz) ? 1 : 0;
  const range = spec.sight * (0.12 + 0.88 * sv.exposure) * (wary ? ALARM_SIGHT : 1);
  if (d > range) return 0;
  const fov = spec.fov * (wary ? 1.35 : 1);
  if (Math.abs(angleDiff(g.angle + g.look, Math.atan2(dy, dx))) > fov) return 0;
  if (!castle.sees(ex, ey, ez, sv.x, sv.y, cz) && !castle.sees(ex, ey, ez, sv.x, sv.y, sv.z + sv.head)) return 0;
  return 0.25 + 0.75 * (1 - d / range);
}

/** Whether a guard's in a state to fight or look: alive, and not the lord. */
function fighter(kind: GuardKind): boolean {
  return kind !== GuardKind.Lord;
}

// ---------------------------------------------------------------------------
// Mustering the watch for a night
// ---------------------------------------------------------------------------

/** Put the night's watch in place: patrols, posts, archers on towers, and the lord at his door with two samurai. */
export function muster(ctx: ShinobiContext, round: number, shinobi: number): GuardEntity {
  const { castle, world } = ctx;
  const spawn = (kind: GuardKind, at: { x: number; y: number; z?: number }, init: Partial<GuardEntity['state']>): GuardEntity =>
    world.spawn(Guard, { x: at.x, y: at.y, z: at.z ?? 0, kind, hp: GUARDS[kind].hp, round, angle: Math.random() * Math.PI * 2, tx: at.x, ty: at.y, ...init }) as GuardEntity;

  castle.routes.forEach((route, r) => {
    // the long route round the wall gets two, on opposite sides, and more for a bigger band of shinobi
    const walkers = r === 0 ? 2 + Math.max(0, shinobi - 2) : 1;
    for (let k = 0; k < walkers; k++) {
      const wp = Math.floor((k * route.length) / walkers) % route.length;
      spawn(GuardKind.Spear, route[wp], { mode: GuardMode.Patrol, home: r, wp: (wp + 1) % route.length, lantern: true });
    }
  });
  castle.posts.forEach((post, p) => {
    const g = spawn(GuardKind.Spear, post, { mode: GuardMode.Post, home: POST_HOME + p, lantern: true, angle: post.facing });
    GuardMind.of(g).facing = post.facing;
  });
  // archers on the gate towers, and two of the corners
  const perches = [4, 5, ...[0, 1, 2, 3].sort(() => Math.random() - 0.5).slice(0, 2)];
  for (const p of perches) {
    const perch = castle.perches[p];
    const g = spawn(GuardKind.Archer, perch, { mode: GuardMode.Post, home: p, angle: perch.facing });
    GuardMind.of(g).facing = perch.facing;
  }
  const door = castle.stations[0];
  const lord = spawn(GuardKind.Lord, door, { mode: GuardMode.Escort, wp: 0, left: 20, angle: -Math.PI / 2 });
  for (let k = 0; k < 2; k++) spawn(GuardKind.Samurai, { x: door.x + (k ? 1.4 : -1.4), y: door.y + 1 }, { mode: GuardMode.Escort, home: k, target: lord.id });
  return lord;
}

/** Turn out two more guards from the barracks, sent to search at (x, y). Returns them. */
export function reinforce(ctx: ShinobiContext, round: number, x: number, y: number): GuardEntity[] {
  const { castle, world } = ctx;
  const out: GuardEntity[] = [];
  for (let k = 0; k < 2; k++) {
    const at = castle.nearestOpen(castle.barracks.x + (k - 0.5) * 1.5, castle.barracks.y);
    const g = world.spawn(Guard, { x: at.x, y: at.y, kind: GuardKind.Spear, hp: GUARDS[GuardKind.Spear].hp, round, mode: GuardMode.Search, home: k % castle.routes.length, lantern: true, left: SEARCH_SECONDS + 15 }) as GuardEntity;
    const spot = castle.nearestOpen(x, y);
    g.state.tx = spot.x;
    g.state.ty = spot.y;
    Object.assign(GuardMind.of(g), { cx: spot.x, cy: spot.y });
    out.push(g);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Every frame, for the guards this peer owns
// ---------------------------------------------------------------------------

/**
 * Guards this peer owns. Each looks and listens, grows suspicious of what it half sees and goes to look, raises the alarm
 * at what it plainly sees and goes after it, and otherwise does its duty: walks its route, stands its post, keeps by the
 * lord. The lord strolls between his stations through the night and runs for the keep when there's trouble. The dead
 * lie where they fell until the night's over, for other guards to find.
 */
export function updateOwnedGuards(ctx: ShinobiContext, dt: number): void {
  const { world, now } = ctx;
  const round = ctx.round()?.state;
  const alarm = (round?.alarm ?? 0) > 0;
  for (const g of world.owned(Guard) as ReadonlySet<GuardEntity>) {
    const s = g.state;
    const l = GuardMind.of(g);
    if (!round || s.round !== round.round || round.phase === Phase.Waiting || round.phase === Phase.Over) {
      world.despawn(g);
      continue;
    }
    if (s.mode === GuardMode.Dead) continue;
    const spec = GUARDS[s.kind];

    if (now >= l.nextCheckin) {
      if (l.nextCheckin) s.checkin = (s.checkin + 1) & 0xff;
      l.nextCheckin = now + CHECKIN_SECONDS * 1000 * (l.nextCheckin ? 1 : Math.random());
    }
    if (Number.isNaN(l.facing)) l.facing = s.angle;
    if (now >= l.nextLook) {
      l.nextLook = now + 150;
      perceive(ctx, g, 0.15, alarm);
    }
    if (now >= l.nextBodies && fighter(s.kind)) {
      l.nextBodies = now + 600;
      lookForBodies(ctx, g);
    }

    const seeing = now - l.seenAt < 400;
    switch (s.mode) {
      case GuardMode.Chase:
        chase(ctx, g, spec, dt, seeing);
        break;
      case GuardMode.Investigate:
      case GuardMode.Search:
        sweep(ctx, g, spec, dt, alarm);
        break;
      case GuardMode.Patrol:
        patrol(ctx, g, spec, dt, alarm);
        break;
      case GuardMode.Post:
        stand(ctx, g, dt);
        break;
      case GuardMode.Escort:
        if (s.kind === GuardKind.Lord) stroll(ctx, g, spec, dt);
        else escort(ctx, g, spec, dt);
        break;
    }
    if (s.mode !== GuardMode.Chase && !seeing) s.sus = Math.max(0, s.sus - dt * (s.alert === Alert.Calm ? 0.25 : 0.04));
    // a guard at its duty that's stopped worrying calms down (one sent to look calms down when it's done looking)
    const dutiful = s.mode === GuardMode.Patrol || s.mode === GuardMode.Post || s.mode === GuardMode.Escort;
    if (dutiful && s.alert === Alert.Suspicious && s.sus < 0.05 && s.kind !== GuardKind.Lord) s.alert = Alert.Calm;
  }
  separate(ctx);
}

/** Look for shinobi, and grow more or less sure of what's there. */
function perceive(ctx: ShinobiContext, g: GuardEntity, dt: number, alarm: boolean): void {
  const { world, castle, now } = ctx;
  const s = g.state;
  const l = GuardMind.of(g);
  const spec = GUARDS[s.kind];
  let best: ShinobiEntity | null = null;
  let strength = 0;
  const range = spec.sight * ALARM_SIGHT;
  for (const sv of world.query(s.x, s.y, range, Shinobi) as ShinobiEntity[]) {
    const k = spotting(castle, s, { ...sv.render, x: sv.x, y: sv.y }, alarm);
    // the one it was after, if it still sees them at all
    if (k > 0 && (k > strength || (sv.id === l.seenId && strength < 0.9))) {
      best = sv;
      strength = k;
    }
  }
  if (!best) return;
  l.seenId = best.id;
  l.seenX = best.x;
  l.seenY = best.y;
  l.seenAt = now;
  const downed = best.render.mode === ShinobiMode.Downed;
  s.sus = Math.min(1, s.sus + dt * (0.6 + 2.6 * strength) * (s.alert === Alert.Alarmed ? 2 : 1));
  if (s.kind === GuardKind.Lord) {
    if (s.sus >= SUSPICIOUS) flee(ctx, g);
    return;
  }
  // a samurai only goes after someone near enough the lord; further off, it keeps watching them
  const leashed = s.kind === GuardKind.Samurai && beyondLeash(ctx, best.x, best.y);
  if ((s.sus >= 1 || (s.alert === Alert.Alarmed && s.sus > 0.5)) && !leashed) {
    const fresh = s.mode !== GuardMode.Chase || s.target !== best.id;
    s.alert = Alert.Alarmed;
    if (fresh) {
      s.mode = GuardMode.Chase;
      s.target = best.id;
      l.nextPath = 0;
      shout(ctx, g);
      if (best.id !== l.reportedId || now - l.reportedAt > REPORT_MS) {
        l.reportedAt = now;
        l.reportedId = best.id;
        world.send(Report, { kind: ReportKind.Intruder, guard: g.id, about: best.id, x: best.x, y: best.y }, { to: 'all' });
      }
    }
    return;
  }
  if (leashed) {
    l.facing = Math.atan2(best.y - s.y, best.x - s.x);
    return;
  }
  if (s.sus >= SUSPICIOUS && s.mode !== GuardMode.Chase && !downed) {
    if (s.alert === Alert.Calm) s.alert = Alert.Suspicious;
    investigate(g, best.x, best.y, ctx, false);
  }
}

/** Dead guards in plain sight raise the alarm, once each. */
function lookForBodies(ctx: ShinobiContext, g: GuardEntity): void {
  const { world, castle } = ctx;
  const s = g.state;
  const spec = GUARDS[s.kind];
  for (const body of world.query(s.x, s.y, BODY_SIGHT, Guard) as GuardEntity[]) {
    if (body === g || body.render.mode !== GuardMode.Dead || BodyMind.of(body).found) continue;
    const b = body.render;
    const bearing = Math.atan2(body.y - s.y, body.x - s.x);
    if (Math.abs(angleDiff(s.angle + s.look, bearing)) > spec.fov * 1.2) continue;
    if (!castle.sees(s.x, s.y, s.z + spec.eye, body.x, body.y, b.z + 0.3)) continue;
    BodyMind.of(body).found = true;
    world.send(Report, { kind: ReportKind.Body, guard: g.id, about: body.id, x: body.x, y: body.y }, { to: 'all' });
    shout(ctx, g);
    s.alert = Alert.Alarmed;
    s.sus = Math.max(s.sus, 0.8);
    if (s.mode !== GuardMode.Chase) investigate(g, body.x, body.y, ctx, true);
    return;
  }
}

/** Go and look round a spot for a while. */
function investigate(g: GuardEntity, x: number, y: number, ctx: ShinobiContext, run: boolean): void {
  const s = g.state;
  const l = GuardMind.of(g);
  if (s.kind === GuardKind.Archer || s.kind === GuardKind.Lord) {
    l.facing = Math.atan2(y - s.y, x - s.x);
    return;
  }
  const at = ctx.castle.nearestOpen(x, y);
  const again = s.mode === GuardMode.Investigate && Math.hypot(at.x - s.tx, at.y - s.ty) < 1.5;
  s.mode = GuardMode.Investigate;
  s.tx = at.x;
  s.ty = at.y;
  s.left = Math.max(again ? s.left : 0, INVESTIGATE_SECONDS);
  l.cx = at.x;
  l.cy = at.y;
  l.arrived = false;
  l.nextPath = 0;
  if (run) s.alert = Alert.Alarmed;
}

/** After an intruder: close in and strike, or (an archer) shoot. Lose them for long enough and search where they were. */
function chase(ctx: ShinobiContext, g: GuardEntity, spec: GuardSpec, dt: number, seeing: boolean): void {
  const { world, castle, now } = ctx;
  const s = g.state;
  const l = GuardMind.of(g);
  const target = world.getAs(Shinobi, s.target) as ShinobiEntity | undefined;
  const t = target?.render;
  if (!target || !t || t.mode === ShinobiMode.Dead || t.mode === ShinobiMode.Escaped || now - l.seenAt > LOSE_MS) {
    s.target = 0;
    s.alert = Alert.Suspicious;
    s.sus = 0.6;
    if (s.kind === GuardKind.Archer) {
      s.mode = GuardMode.Post;
    } else {
      investigate(g, l.seenX, l.seenY, ctx, false);
      s.mode = GuardMode.Search;
      s.left = INVESTIGATE_SECONDS;
    }
    return;
  }
  const tx = seeing ? target.x : l.seenX;
  const ty = seeing ? target.y : l.seenY;
  const bearing = Math.atan2(ty - s.y, tx - s.x);
  s.look = 0;
  if (s.kind === GuardKind.Samurai) {
    const lord = lordOf(ctx, g);
    if (lord && (Math.hypot(lord.x - s.x, lord.y - s.y) > LEASH || beyondLeash(ctx, tx, ty))) {
      s.mode = GuardMode.Escort;
      s.target = lord.id;
      s.alert = Alert.Suspicious;
      return;
    }
  }
  if (s.kind === GuardKind.Archer) {
    face(g, bearing, dt, 6);
    if (seeing && t.mode === ShinobiMode.Alive && now >= l.nextStrike && Math.hypot(tx - s.x, ty - s.y) < spec.reach) shoot(ctx, g, target);
    return;
  }
  const d = Math.hypot(tx - s.x, ty - s.y);
  const chest = t.z + t.head * 0.7;
  const reach3 = Math.hypot(d, chest - (s.z + 1.2));
  if (reach3 > spec.reach * 0.75 || !seeing) step(ctx, g, tx, ty, spec.run, dt, true);
  else face(g, bearing, dt, 8);
  if (seeing && t.mode === ShinobiMode.Alive && reach3 < spec.reach && now >= l.nextStrike && castle.sees(s.x, s.y, s.z + 1.5, target.x, target.y, chest)) {
    l.nextStrike = now + spec.cooldownMs;
    s.strikes = (s.strikes + 1) & 0xff;
    const k = 2 / Math.max(0.2, d);
    world.command(Wound, { target: target.id, by: g.id, amount: spec.damage, kx: (target.x - s.x) * k, ky: (target.y - s.y) * k });
    world.send(Noise, { kind: Sound.Attack, x: s.x, y: s.y, z: s.z + 1.3, a: s.kind }, { to: 'all' });
  }
}

/** Loose an arrow at a shinobi, aimed a little high for the drop. */
function shoot(ctx: ShinobiContext, g: GuardEntity, target: ShinobiEntity): void {
  const s = g.state;
  const l = GuardMind.of(g);
  const spec = GUARDS[s.kind];
  const flight = FLIGHTS[Weapon.Arrow];
  l.nextStrike = ctx.now + spec.cooldownMs * (0.8 + Math.random() * 0.4);
  s.strikes = (s.strikes + 1) & 0xff;
  const from: Vec3 = { x: s.x + Math.cos(s.angle) * 0.5, y: s.y + Math.sin(s.angle) * 0.5, z: s.z + 1.5 };
  const t = target.render;
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const dz = t.z + t.head * 0.6 - from.z;
  const d = Math.hypot(dx, dy, dz);
  const time = d / flight.speed;
  const spread = 0.025 * d;
  const vx = (dx + (Math.random() - 0.5) * spread) / time;
  const vy = (dy + (Math.random() - 0.5) * spread) / time;
  const vz = (dz + 0.5 * flight.gravity * time * time) / time;
  ctx.flights.launch(Weapon.Arrow, g.id, from, { x: vx, y: vy, z: vz });
  ctx.world.send(Noise, { kind: Sound.Attack, x: s.x, y: s.y, z: s.z + 1.3, a: s.kind }, { to: 'all' });
}

/** Go to a spot and look round it; a search keeps picking new spots near where it was sent. */
function sweep(ctx: ShinobiContext, g: GuardEntity, spec: GuardSpec, dt: number, alarm: boolean): void {
  const { castle, now } = ctx;
  const s = g.state;
  const l = GuardMind.of(g);
  const search = s.mode === GuardMode.Search;
  const hurry = s.alert === Alert.Alarmed || alarm;
  if (!l.cx && !l.cy) {
    l.cx = s.tx;
    l.cy = s.ty;
  }
  if (!l.arrived) {
    if (Math.hypot(s.tx - s.x, s.ty - s.y) < 0.9) {
      l.arrived = true;
    } else {
      step(ctx, g, s.tx, s.ty, hurry ? spec.run * 0.8 : search ? spec.walk * 1.6 : spec.walk * 1.3, dt, true);
      s.look = Math.sin(now / 700 + g.id) * 0.35;
    }
  }
  if (search || l.arrived) s.left = Math.max(0, s.left - dt);
  if (l.arrived) {
    s.look = Math.sin(now / 900 + g.id) * 1.1;
    if (search && Math.random() < dt * 0.35) {
      // on to another spot near the middle of the search
      for (let k = 0; k < 6; k++) {
        const a = Math.random() * Math.PI * 2;
        const r = 2 + Math.random() * SEARCH_RADIUS;
        const x = l.cx + Math.cos(a) * r;
        const y = l.cy + Math.sin(a) * r;
        if (!castle.open(Math.floor(x), Math.floor(y))) continue;
        s.tx = Math.floor(x) + 0.5;
        s.ty = Math.floor(y) + 0.5;
        l.arrived = false;
        l.nextPath = 0;
        break;
      }
    } else {
      face(g, s.angle + dt * 0.4, dt, 1);
    }
  }
  if (s.left <= 0) goHome(ctx, g);
}

/** Back to its duty, calm again. */
export function goHome(ctx: ShinobiContext, g: GuardEntity): void {
  const { castle } = ctx;
  const s = g.state;
  const l = GuardMind.of(g);
  s.alert = Alert.Calm;
  s.target = 0;
  s.left = 0;
  l.arrived = false;
  l.nextPath = 0;
  l.cx = l.cy = 0;
  switch (s.kind) {
    case GuardKind.Archer: {
      const perch = castle.perches[s.home];
      s.mode = GuardMode.Post;
      if (perch) l.facing = perch.facing;
      return;
    }
    case GuardKind.Samurai:
    case GuardKind.Lord: {
      s.mode = GuardMode.Escort;
      if (s.kind === GuardKind.Samurai) s.target = lordOf(ctx, g)?.id ?? 0;
      return;
    }
  }
  if (s.home >= POST_HOME && castle.posts[s.home - POST_HOME]) {
    const post: Post = castle.posts[s.home - POST_HOME];
    s.mode = GuardMode.Post;
    s.tx = post.x;
    s.ty = post.y;
    l.facing = post.facing;
    return;
  }
  const route = castle.routes[s.home] ?? castle.routes[0];
  // the nearest waypoint
  let best = 0;
  route.forEach((p, i) => {
    if (Math.hypot(p.x - s.x, p.y - s.y) < Math.hypot(route[best].x - s.x, route[best].y - s.y)) best = i;
  });
  s.mode = GuardMode.Patrol;
  s.wp = best;
}

/** Walk the route, round and round. */
function patrol(ctx: ShinobiContext, g: GuardEntity, spec: GuardSpec, dt: number, alarm: boolean): void {
  const s = g.state;
  const route = ctx.castle.routes[s.home] ?? ctx.castle.routes[0];
  const wp = route[s.wp % route.length];
  if (Math.hypot(wp.x - s.x, wp.y - s.y) < 1) {
    s.wp = (s.wp + 1) % route.length;
    GuardMind.of(g).nextPath = 0;
  }
  s.tx = wp.x;
  s.ty = wp.y;
  step(ctx, g, wp.x, wp.y, spec.walk * (alarm ? 1.8 : 1), dt, true);
  s.look = Math.sin(ctx.now / 1300 + g.id) * 0.45;
}

/** Stand watch: at the post, looking out one way and glancing either side. */
function stand(ctx: ShinobiContext, g: GuardEntity, dt: number): void {
  const s = g.state;
  const l = GuardMind.of(g);
  if (s.kind !== GuardKind.Archer && Math.hypot(s.tx - s.x, s.ty - s.y) > 0.6) {
    step(ctx, g, s.tx, s.ty, GUARDS[s.kind].walk * 1.4, dt, true);
    return;
  }
  face(g, l.facing, dt, 2);
  s.look = Math.sin(ctx.now / 1500 + g.id) * 1.15;
}

/** A samurai keeps by the lord, just behind him to one side. */
function escort(ctx: ShinobiContext, g: GuardEntity, spec: GuardSpec, dt: number): void {
  const s = g.state;
  const lord = lordOf(ctx, g);
  if (!lord || lord.render.mode === GuardMode.Dead) {
    // guard his body
    s.look = Math.sin(ctx.now / 900 + g.id) * 1.2;
    return;
  }
  s.target = lord.id;
  const la = lord.render.angle;
  const side = s.home ? -1 : 1;
  const bx = lord.x - Math.cos(la) * 1.4 + Math.cos(la + Math.PI / 2) * side * 1.3;
  const by = lord.y - Math.sin(la) * 1.4 + Math.sin(la + Math.PI / 2) * side * 1.3;
  const d = Math.hypot(bx - s.x, by - s.y);
  if (d > 0.5) step(ctx, g, bx, by, d > 4 ? spec.run : Math.max(spec.walk, GUARDS[GuardKind.Lord].walk * 1.3), dt, true);
  else face(g, la + side * 0.9, dt, 3);
  s.look = Math.sin(ctx.now / 1100 + g.id) * 0.9;
  s.alert = lord.render.alert === Alert.Alarmed ? Alert.Alarmed : s.alert === Alert.Alarmed ? Alert.Suspicious : s.alert;
}

/** The lord: from station to station, resting a while at each, unless something's frightened him into the keep. */
function stroll(ctx: ShinobiContext, g: GuardEntity, spec: GuardSpec, dt: number): void {
  const { castle } = ctx;
  const s = g.state;
  const station = castle.stations[s.wp] ?? castle.stations[0];
  const scared = s.alert === Alert.Alarmed;
  if (Math.hypot(station.x - s.x, station.y - s.y) > 0.8) {
    step(ctx, g, station.x, station.y, scared ? spec.run : spec.walk, dt, true);
    s.look = 0;
    return;
  }
  s.left = Math.max(0, s.left - dt);
  s.look = Math.sin(ctx.now / 2000 + g.id) * 0.8;
  face(g, s.wp === 0 ? -Math.PI / 2 : s.angle, dt, 1);
  if (s.left > 0) return;
  if (scared) {
    s.alert = Alert.Suspicious;
    s.left = 20;
    return;
  }
  s.alert = Alert.Calm;
  const n = castle.stations.length;
  s.wp = n > 1 ? (s.wp + 1 + Math.floor(Math.random() * (n - 1))) % n : 0;
  s.left = REST_SECONDS[0] + Math.random() * (REST_SECONDS[1] - REST_SECONDS[0]);
}

/** The lord runs for the keep's door and stays there a while. */
function flee(ctx: ShinobiContext, g: GuardEntity): void {
  const s = g.state;
  if (s.alert === Alert.Alarmed && s.wp === 0) {
    s.left = Math.max(s.left, 25);
    return;
  }
  s.alert = Alert.Alarmed;
  s.wp = 0;
  s.left = 30;
  GuardMind.of(g).nextPath = 0;
}

/**
 * Raise a cry, unless this guard shouted a moment ago, or has just heard another guard do it: everyone near enough
 * already knows, and a courtyard of guards each yelling in turn is only noise.
 */
function shout(ctx: ShinobiContext, g: GuardEntity): void {
  const { now } = ctx;
  const s = g.state;
  const l = GuardMind.of(g);
  if (now - l.shoutedAt < SHOUT_MS || now - l.heardShoutAt < ECHO_MS) return;
  l.shoutedAt = now;
  ctx.world.send(Noise, { kind: Sound.Shout, x: s.x, y: s.y, z: s.z + 1.7, a: s.kind }, { to: 'all' });
}

/** Whether a spot is too far from the lord for his samurai to leave him for. */
function beyondLeash(ctx: ShinobiContext, x: number, y: number): boolean {
  const lord = lordOf(ctx, null);
  return !!lord && lord.render.mode !== GuardMode.Dead && Math.hypot(lord.x - x, lord.y - y) > LEASH;
}

/** The lord a samurai is guarding: the round's. */
function lordOf(ctx: ShinobiContext, _g: GuardEntity | null): GuardEntity | null {
  const id = ctx.round()?.state.lord ?? 0;
  return (ctx.world.getAs(Guard, id) as GuardEntity | undefined) ?? null;
}

function step(ctx: ShinobiContext, g: GuardEntity, tx: number, ty: number, speed: number, dt: number, path: boolean): void {
  const { castle, paths, now } = ctx;
  const s = g.state;
  if (s.z > 0.5) return; // up a tower
  const l = GuardMind.of(g);
  const spec = GUARDS[s.kind];
  let gx = tx;
  let gy = ty;
  if (path) {
    if (now >= l.nextPath || !l.waypoint) {
      l.nextPath = now + 300 + Math.random() * 100;
      l.waypoint = paths.next(s.x, s.y, tx, ty, spec.radius);
    }
    if (!l.waypoint) return;
    gx = l.waypoint.x;
    gy = l.waypoint.y;
    if (Math.hypot(gx - s.x, gy - s.y) < 0.3) l.nextPath = 0;
  }
  const dx = gx - s.x;
  const dy = gy - s.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.05) return;
  const k = Math.min(d, speed * dt) / d;
  if (castle.move(s, dx * k, dy * k, spec.radius, 0)) l.nextPath = 0;
  face(g, Math.atan2(dy, dx), dt, 7);
}

function face(g: GuardEntity, angle: number, dt: number, rate: number): void {
  const s = g.state;
  s.angle += angleDiff(s.angle, angle) * Math.min(1, dt * rate);
}

/** Keep guards from standing in each other. */
function separate(ctx: ShinobiContext): void {
  const { world, castle } = ctx;
  for (const g of world.owned(Guard) as ReadonlySet<GuardEntity>) {
    const s = g.state;
    if (s.mode === GuardMode.Dead || s.z > 0.5) continue;
    const r = GUARDS[s.kind].radius;
    for (const o of world.query(s.x, s.y, 1.2, Guard) as GuardEntity[]) {
      if (o === g || o.render.mode === GuardMode.Dead || o.render.z > 0.5) continue;
      const min = r + GUARDS[o.render.kind].radius;
      const dx = s.x - o.x;
      const dy = s.y - o.y;
      const d = Math.hypot(dx, dy);
      if (d >= min || d < 1e-4) continue;
      const push = (min - d) * 0.5;
      castle.move(s, (dx / d) * push, (dy / d) * push, r, 0);
    }
  }
}

// ---------------------------------------------------------------------------
// What happens to a guard: heard, struck, ordered
// ---------------------------------------------------------------------------

/** A sound somewhere: the guards this peer owns within earshot come to look, or turn to. */
export function hear(ctx: ShinobiContext, kind: Sound, x: number, y: number, z: number): void {
  const { world } = ctx;
  const reach = EARSHOT[kind];
  if (!reach) return;
  for (const g of world.owned(Guard) as ReadonlySet<GuardEntity>) {
    const s = g.state;
    if (s.mode === GuardMode.Dead || Math.hypot(g.x - x, g.y - y, s.z - z) > reach) continue;
    if (kind === Sound.Shout) GuardMind.of(g).heardShoutAt = ctx.now;
    const loud = kind === Sound.Shout || kind === Sound.Cry || kind === Sound.Gong || kind === Sound.Attack;
    if (s.kind === GuardKind.Lord) {
      if (loud) flee(ctx, g);
      continue;
    }
    if (s.mode === GuardMode.Chase) continue;
    if (s.kind === GuardKind.Samurai && s.mode === GuardMode.Escort && !loud) {
      GuardMind.of(g).facing = Math.atan2(y - s.y, x - s.x);
      s.sus = Math.max(s.sus, 0.4);
      continue;
    }
    s.sus = Math.max(s.sus, loud ? 0.8 : 0.5);
    if (s.alert === Alert.Calm) s.alert = Alert.Suspicious;
    if (s.kind === GuardKind.Samurai && !loud) continue;
    investigate(g, x, y, ctx, loud);
  }
}

/**
 * A shinobi's blow or blade on a guard this peer owns. A tanto from behind, or on a guard that isn't alarmed, kills
 * outright; so does a kunai on a guard that doesn't know anyone's there. Anything less alarms it, and it comes for
 * whoever did it.
 */
export function struck(ctx: ShinobiContext, g: GuardEntity, by: number, weapon: Weapon, amount: number, fromX: number, fromY: number): void {
  const s = g.state;
  if (s.mode === GuardMode.Dead) return;
  const behind = Math.abs(angleDiff(s.angle, Math.atan2(fromY - s.y, fromX - s.x))) > 1.9;
  const unaware = s.alert !== Alert.Alarmed;
  const lethal =
    (weapon === Weapon.Tanto && (unaware || behind || s.kind === GuardKind.Lord)) || (weapon === Weapon.Kunai && unaware && s.kind !== GuardKind.Samurai);
  s.hp = lethal ? 0 : Math.max(0, s.hp - amount);
  if (s.hp <= 0) {
    die(ctx, g, by);
    return;
  }
  const l = GuardMind.of(g);
  s.sus = 1;
  if (s.kind === GuardKind.Lord) {
    flee(ctx, g);
    return;
  }
  s.alert = Alert.Alarmed;
  l.seenId = by;
  l.seenX = fromX;
  l.seenY = fromY;
  l.seenAt = ctx.now - 300;
  s.target = by;
  s.mode = GuardMode.Chase;
  s.angle = Math.atan2(fromY - s.y, fromX - s.x);
  shout(ctx, g);
}

function die(ctx: ShinobiContext, g: GuardEntity, by: number): void {
  const { world } = ctx;
  const s = g.state;
  s.mode = GuardMode.Dead;
  s.alert = Alert.Calm;
  s.sus = 0;
  s.target = 0;
  s.lantern = false;
  world.send(Noise, { kind: Sound.Fall, x: g.x, y: g.y, z: s.z, a: s.kind }, { to: 'all' });
  if (world.get(by)) world.command(Tally, { target: by, kind: s.kind });
  if (s.kind === GuardKind.Lord) {
    const who = world.getAs(Shinobi, by)?.render.name ?? 'A shinobi';
    world.send(Feed, { text: `${who} has killed the lord!` }, { to: 'all' });
    world.send(Noise, { kind: Sound.Gong, x: g.x, y: g.y, z: 2, a: 0 }, { to: 'all' });
  }
  // a guard falling from a tower lands at its foot
  if (s.z > 0.5) {
    const at = ctx.castle.nearestOpen(g.x + Math.cos(s.angle) * 2.5, g.y + Math.sin(s.angle) * 2.5);
    s.x = at.x;
    s.y = at.y;
    s.z = 0;
  }
}

/** The captain's order to a guard this peer owns. */
export function ordered(ctx: ShinobiContext, g: GuardEntity, kind: OrderKind, x: number, y: number): void {
  const { castle } = ctx;
  const s = g.state;
  if (s.mode === GuardMode.Dead) return;
  const l = GuardMind.of(g);
  if (s.kind === GuardKind.Lord) {
    if (kind !== OrderKind.Station) return;
    let best = 0;
    castle.stations.forEach((p, i) => {
      if (Math.hypot(p.x - x, p.y - y) < Math.hypot(castle.stations[best].x - x, castle.stations[best].y - y)) best = i;
    });
    s.wp = best;
    s.left = REST_SECONDS[1];
    l.nextPath = 0;
    return;
  }
  if (s.kind === GuardKind.Archer) {
    if (kind === OrderKind.Return) goHome(ctx, g);
    else l.facing = Math.atan2(y - s.y, x - s.x);
    return;
  }
  const at = castle.nearestOpen(x, y);
  switch (kind) {
    case OrderKind.Search:
      s.mode = GuardMode.Search;
      s.target = 0;
      s.tx = at.x;
      s.ty = at.y;
      s.left = SEARCH_SECONDS + Math.hypot(at.x - s.x, at.y - s.y) / GUARDS[s.kind].walk / 1.6;
      s.alert = Math.max(s.alert, Alert.Suspicious) as Alert;
      Object.assign(l, { cx: at.x, cy: at.y, arrived: false, nextPath: 0 });
      break;
    case OrderKind.Post:
      s.mode = GuardMode.Post;
      s.target = 0;
      l.facing = Math.atan2(at.y - s.y, at.x - s.x);
      s.tx = at.x;
      s.ty = at.y;
      l.nextPath = 0;
      break;
    case OrderKind.Return:
      goHome(ctx, g);
      break;
  }
}

/** Whether a guard takes the captain's orders: any that's alive (the lord only to be moved, and archers only to watch). */
export function takesOrders(s: { mode: GuardMode; kind: GuardKind }): boolean {
  return s.mode !== GuardMode.Dead && s.kind !== GuardKind.Lord;
}

/** Clamp a guard's suspicion for showing. */
export function suspicionShown(s: { sus: number; alert: Alert }): number {
  return s.alert === Alert.Alarmed ? 1 : clamp(s.sus, 0, 1);
}
