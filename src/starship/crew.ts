import { Avatar, RADIUS, type AvatarBody, type AvatarFrontend } from '../crossplay/avatar';
import { Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Role } from '../crossplay/role';
import type { Tool } from '../crossplay/tool';
import { hurtSentinel } from './away';
import { type CrewEntity, type FaultEntity, type RelicEntity, type SentinelEntity, type StarshipContext } from './context';
import { CONSOLES, PAD, RACK, REACH, TUBES, Tile, WALL_HEIGHT, type ConsoleSpot } from './deck';
import { Act, Beam, Beam3, Carry, Crew as CrewDef, CrewMode, Damage, Fault, FaultKind, Grab, Mend, Noise, Relic, Sentinel, Shot, Sound, Station, Transport } from './defs';
import type { CrewIntent } from './intent';
import { EXTINGUISHER, PHASER, SPANNER, TOOLS, type CrewTool, type Fixer, type Use } from './kit';
import { order } from './officer';
import { bridgeSpot, transporterBlocked } from './ship';

/** How the crew's rules reach back to the device playing them. */
export interface CrewBody extends AvatarBody {
  /** Knocked out: carried to sickbay shortly. */
  downed(): void;
  /** Back on your feet in sickbay. */
  revived(): void;
  /** Beamed somewhere: down to a planet, or back aboard. */
  beamed(aboard: boolean): void;
  /** Sat down at a console, or got up (null). */
  seated(station: Station | null): void;
  /** Mended something, or put a fire out. */
  fixed(kind: FaultKind): void;
  /** Picked something up, or put it down. */
  carrying(carry: Carry): void;
  /** A new voyage: back on the bridge. */
  restarted(): void;
}

export type CrewFrontend = AvatarFrontend<CrewIntent> & CrewBody;

const NO_BODY: CrewBody = {
  platform: Platform.Desktop,
  moved() {},
  placed() {},
  hurt() {},
  used() {},
  died() {},
  downed() {},
  revived() {},
  beamed() {},
  seated() {},
  fixed() {},
  carrying() {},
  restarted() {},
};

export const MAX_HP = 100;
/** Before someone knocked out comes round in sickbay, s. */
export const DOWN_SECONDS = 7;
/** A fire this near burns, m, this much a second. */
const FIRE_REACH = 1.3;
const FIRE_DPS = 9;
const PHASER_RANGE = 30;
/** How far off the line of a shot a sentinel can be and still be hit, m. */
const PHASER_SLOP = 0.6;
/** How much a spanner or extinguisher mends in a use: about three seconds of work. */
const MEND_SPANNER = 0.035;
const MEND_EXTINGUISHER = 0.034;
/** How far back from a console its seat is, m. */
export const SEAT_BACK = 1;
/** Hands full with a torpedo: this much slower. */
const LADEN = 0.6;

/** Something in reach to do, for the hints and the buttons. */
export type Nearby =
  | { kind: 'rack' }
  | { kind: 'tube'; index: number; loaded: boolean }
  | { kind: 'relic'; relic: RelicEntity }
  | { kind: 'console'; console: ConsoleSpot }
  | null;

/**
 * The player as crew: an avatar on the ship's decks, or down on a planet. Hands-on work the stations can't do: fix
 * sparking conduits with the spanner and put out fires with the extinguisher (faults make their systems work worse),
 * carry torpedoes from the rack to the tubes faster than the autoloader, stand on the transporter pad to be beamed down,
 * fight the drones guarding a relic with a hand phaser, and carry the relic back to be beamed aboard. At a bridge
 * console, sit down to run that station.
 */
export class CrewRole extends Avatar<CrewIntent, CrewBody, CrewTool> implements Role<CrewIntent, CrewFrontend> {
  body: CrewBody = NO_BODY;
  /** What you could do right here, for a hint. */
  nearby: Nearby = null;
  /** The fault the tool in hand is aimed at, for a hint. */
  aimedFault: FaultEntity | null = null;
  private downAt = 0;
  private voyage = -1;
  private burnt = 0;
  private sprayUntil = 0;
  private carryWas = Carry.Nothing;
  /** Working a console standing, as a headset does, rather than sitting at it. */
  private standingAt = false;

  constructor(readonly ctx: StarshipContext) {
    super(TOOLS);
  }

  get me(): CrewEntity | null {
    return this.ctx.me;
  }

  get now(): number {
    return this.ctx.now;
  }

  /** The station you're at: sitting at its console, or (in a headset) working it standing up. */
  get seat(): Station | null {
    const seat = this.me?.state.seat ?? 0;
    return seat ? ((seat - 1) as Station) : null;
  }

  /** The console you're sitting at, pinned in front of it with your hands on its keys. Only a flat screen sits. */
  get sitting(): Station | null {
    return this.standingAt ? null : this.seat;
  }

  get holding(): Carry {
    return this.me?.state.carry ?? Carry.Nothing;
  }

  protected override move(p: { x: number; y: number }, dx: number, dy: number): void {
    this.ctx.deck.move(p, dx, dy, RADIUS);
  }

  protected override collide(p: { x: number; y: number }): void {
    this.ctx.deck.pushOut(p, RADIUS);
  }

  spawn(): void {
    const { ctx } = this;
    const at = bridgeSpot(Math.floor(Math.random() * 15));
    ctx.me = ctx.world.spawn(CrewDef, { x: at.x, y: at.y, name: ctx.playerName, skin: Math.floor(Math.random() * 40), hp: MAX_HP, voyage: ctx.ship()?.render.voyage ?? 0 });
    this.heading = Math.PI;
    this.inventory.select(SPANNER);
    ctx.world.setFocus(5000, 5000, 20000);
  }

  update(dt: number, intent: CrewIntent): void {
    const me = this.me;
    if (!me) return;
    const s = me.state;
    this.begin(intent);
    this.voyageCheck();
    const seated = this.sitting;

    if (s.mode === CrewMode.Down) {
      intent.strafe = intent.forward = 0;
      intent.run = intent.jump = false;
      if (intent.head) this.walkTracked(dt, intent.head, intent, false);
      else this.walk(dt, intent);
      if (this.now - this.downAt > DOWN_SECONDS * 1000) this.revive();
    } else if (seated !== null) {
      const c = CONSOLES[seated];
      if (intent.sit || intent.jump || Math.hypot(intent.strafe, intent.forward) > 0.5) this.stand();
      else {
        for (const a of intent.acts) order(this.ctx, a);
        s.x = c.x - Math.cos(c.heading) * SEAT_BACK;
        s.y = c.y - Math.sin(c.heading) * SEAT_BACK;
        s.yaw = this.heading;
        s.pitch = this.pitch;
      }
    } else {
      if (s.carry === Carry.Torpedo) {
        intent.run = false;
        intent.strafe *= LADEN;
        intent.forward *= LADEN;
      }
      if (intent.head) this.walkTracked(dt, intent.head, intent, true);
      else this.walk(dt, intent);
    }

    if (intent.head) this.workStanding(intent);
    const up = s.mode === CrewMode.Up && this.sitting === null;
    this.findNearby();
    if (up) {
      if (s.carry === Carry.Nothing) {
        if (intent.hands) this.useHands(intent.hands, dt);
        else this.useCrosshair(intent, dt);
      } else {
        this.putAway();
      }
      if (intent.use) this.act();
      if (intent.sit && seated === null && this.nearby?.kind === 'console') this.sit(this.nearby.console);
    } else {
      this.putAway();
    }
    this.burn(dt);
    this.relicCarry();
    s.spray = this.now < this.sprayUntil;
    this.ctx.world.setFocus(5000, 5000, 20000);
  }

  // -------------------------------------------------------------------------
  // A voyage, and being knocked out
  // -------------------------------------------------------------------------

  /** A new voyage: back to the bridge, healed, hands empty. */
  private voyageCheck(): void {
    const ship = this.ctx.ship()?.render;
    const s = this.me!.state;
    if (!ship) return;
    if (this.voyage === -1) this.voyage = ship.voyage;
    if (ship.voyage === this.voyage && s.voyage === ship.voyage) return;
    this.voyage = s.voyage = ship.voyage;
    const at = bridgeSpot(Math.floor(Math.random() * 15));
    this.teleport(at.x, at.y);
    this.heading = Math.PI;
    s.hp = MAX_HP;
    s.mode = CrewMode.Up;
    s.carry = Carry.Nothing;
    s.seat = 0;
    this.body.restarted();
  }

  /** Hurt, on this peer: a sentinel's bolt, or a fire. */
  wound(amount: number): void {
    const s = this.me?.state;
    if (!s || s.mode !== CrewMode.Up) return;
    s.hp = Math.max(0, s.hp - amount);
    this.body.hurt(amount);
    if (s.hp > 0) return;
    s.mode = CrewMode.Down;
    s.seat = 0;
    if (s.carry === Carry.Torpedo) order(this.ctx, { act: Act.LoadTube, a: -1, b: 0, ref: 0 });
    s.carry = Carry.Nothing;
    this.downAt = this.now;
    this.body.downed();
  }

  private revive(): void {
    const s = this.me!.state;
    s.mode = CrewMode.Up;
    s.hp = MAX_HP;
    const at = bridgeSpot(Math.floor(Math.random() * 15));
    const away = !this.ctx.deck.onShip(s.x);
    this.teleport(at.x, at.y);
    if (away) s.beams = (s.beams + 1) % 256;
    this.body.revived();
  }

  /** The transporter put you somewhere. Carrying the relic aboard brings it home. */
  transported(x: number, y: number): void {
    const { ctx } = this;
    const s = this.me?.state;
    if (!s || s.mode !== CrewMode.Up) return;
    const aboard = ctx.deck.onShip(x);
    if (aboard && s.carry === Carry.Relic) {
      for (const r of ctx.world.all(Relic) as ReadonlySet<RelicEntity>) if (r.render.carrier === this.me!.id) ctx.world.command(Transport, { target: r.id, x, y });
    }
    if (s.carry === Carry.Torpedo) order(ctx, { act: Act.LoadTube, a: -1, b: 0, ref: 0 });
    s.carry = Carry.Nothing;
    s.seat = 0;
    this.teleport(x, y);
    s.beams = (s.beams + 1) % 256;
    this.body.beamed(aboard);
  }

  private burn(dt: number): void {
    const s = this.me!.state;
    if (s.mode !== CrewMode.Up) return;
    let fire = false;
    for (const f of this.ctx.world.query(s.x, s.y, FIRE_REACH, Fault) as FaultEntity[]) if (f.render.kind === FaultKind.Fire) fire = true;
    if (!fire) return;
    this.burnt += FIRE_DPS * dt;
    if (this.burnt >= 3) {
      this.wound(this.burnt);
      this.burnt = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Things in reach: the torpedo rack and tubes, the relic, consoles
  // -------------------------------------------------------------------------

  private findNearby(): void {
    const { ctx } = this;
    const s = this.me!.state;
    const ship = ctx.ship()?.render;
    this.nearby = null;
    if (s.mode !== CrewMode.Up) return;
    let best = REACH;
    const consider = (x: number, y: number, n: Exclude<Nearby, null>) => {
      const d = Math.hypot(x - s.x, y - s.y);
      if (d < best) {
        best = d;
        this.nearby = n;
      }
    };
    if (ctx.deck.onShip(s.x)) {
      consider(RACK.x, RACK.y + 0.4, { kind: 'rack' });
      TUBES.forEach((t, i) => consider(t.x, t.y, { kind: 'tube', index: i, loaded: !!ship && (ship.tubes & (1 << i)) !== 0 }));
      if (s.carry === Carry.Nothing) for (const c of CONSOLES) consider(c.x, c.y, { kind: 'console', console: c });
    } else if (s.carry === Carry.Nothing) {
      for (const r of ctx.world.query(s.x, s.y, REACH + 1, Relic) as RelicEntity[]) if (!r.render.carrier) consider(r.x, r.y, { kind: 'relic', relic: r });
    }
  }

  /** The use press: take or load a torpedo, pick up or put down the relic. */
  private act(): void {
    const { ctx } = this;
    const s = this.me!.state;
    const n = this.nearby;
    const ship = ctx.ship()?.render;
    // with nobody at science, crew work the transporter themselves: from the pad, or by communicator from a planet
    if (ship && selfBeam(ctx) && !n) {
      if (ctx.deck.onShip(s.x) ? Math.hypot(s.x - PAD.x, s.y - PAD.y) <= PAD.radius : s.carry !== Carry.Torpedo) {
        order(ctx, { act: ctx.deck.onShip(s.x) ? Act.BeamDown : Act.BeamUp, a: 0, b: 0, ref: 0 });
        return;
      }
    }
    if (s.carry === Carry.Relic) {
      for (const r of ctx.world.all(Relic) as ReadonlySet<RelicEntity>) if (r.render.carrier === this.me!.id) ctx.world.command(Grab, { target: r.id, by: 0 });
      s.carry = Carry.Nothing;
      this.body.carrying(Carry.Nothing);
      return;
    }
    if (!n || !ship) return;
    switch (n.kind) {
      case 'rack':
        if (s.carry === Carry.Torpedo) {
          order(ctx, { act: Act.LoadTube, a: -1, b: 0, ref: 0 });
          s.carry = Carry.Nothing;
        } else if (s.carry === Carry.Nothing && ship.torps > 0) {
          order(ctx, { act: Act.TakeTorpedo, a: 0, b: 0, ref: 0 });
          s.carry = Carry.Torpedo;
        } else return;
        this.body.carrying(s.carry);
        break;
      case 'tube':
        if (s.carry !== Carry.Torpedo || n.loaded) return;
        order(ctx, { act: Act.LoadTube, a: n.index, b: 0, ref: 0 });
        s.carry = Carry.Nothing;
        this.body.carrying(Carry.Nothing);
        break;
      case 'relic':
        if (s.carry !== Carry.Nothing) return;
        ctx.world.command(Grab, { target: n.relic.id, by: this.me!.id });
        break;
    }
  }

  /** Whether the relic's yours, as its owner says. */
  private relicCarry(): void {
    const s = this.me!.state;
    if (s.carry === Carry.Torpedo) {
      this.carryWas = s.carry;
      return;
    }
    let mine = false;
    for (const r of this.ctx.world.all(Relic)) if (r.render.carrier === this.me!.id) mine = true;
    s.carry = mine && s.mode === CrewMode.Up ? Carry.Relic : Carry.Nothing;
    if (s.carry !== this.carryWas) this.body.carrying(s.carry);
    this.carryWas = s.carry;
  }

  private sit(c: ConsoleSpot): void {
    const s = this.me!.state;
    s.seat = c.station + 1;
    this.heading = c.heading;
    this.pitch = -0.2;
    this.putAway();
    this.body.seated(c.station);
  }

  /**
   * A headset at a console: its orders go straight through, and it's down as at that station, but nothing else about
   * you changes — your tools stay in your hands, and you walk off when you like.
   */
  private workStanding(intent: CrewIntent): void {
    const s = this.me!.state;
    const aboard = s.mode === CrewMode.Up && this.ctx.deck.onShip(s.x);
    const at = aboard ? intent.working : null;
    this.standingAt = true;
    s.seat = at === null ? 0 : at + 1;
    if (aboard) for (const a of intent.acts) order(this.ctx, a);
  }

  private stand(): void {
    const s = this.me!.state;
    s.seat = 0;
    this.body.seated(null);
  }

  private putAway(): void {
    this.hands[Side.Left].hold(null);
    this.hands[Side.Right].hold(null);
    const s = this.me!.state;
    s.tool = 255;
    s.ltool = 255;
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  /** The hand phaser: the first drone along the shot, or the wall. */
  shoot(use: Use): void {
    const { ctx } = this;
    const { world, deck } = ctx;
    const o = use.origin;
    const a = use.aim;
    let end = PHASER_RANGE;
    const aboard = deck.onShip(o.x);
    for (let d = 0.3; d < PHASER_RANGE; d += 0.25) {
      const z = o.z + a.z * d;
      const tile = deck.tile(o.x + a.x * d, o.y + a.y * d);
      if (z < 0 || (aboard && z > WALL_HEIGHT) || tile === Tile.Solid || (tile === Tile.Object && z < 1)) {
        end = d;
        break;
      }
    }
    let hit: SentinelEntity | null = null;
    let hitAt = end;
    for (const e of world.query(o.x, o.y, end, Sentinel) as SentinelEntity[]) {
      const rx = e.x - o.x;
      const ry = e.y - o.y;
      const rz = e.render.z - o.z;
      const along = rx * a.x + ry * a.y + rz * a.z;
      if (along < 0 || along > hitAt) continue;
      const off = Math.hypot(rx - a.x * along, ry - a.y * along, rz - a.z * along);
      if (off < PHASER_SLOP) {
        hit = e;
        hitAt = along;
      }
    }
    const tip = use.tip;
    world.send(Beam3, { kind: Shot.HandPhaser, x: tip.x, y: tip.y, z: tip.z, tx: o.x + a.x * hitAt, ty: o.y + a.y * hitAt, tz: o.z + a.z * hitAt, hit: !!hit }, { to: 'all' });
    if (hit) {
      if (hit.mine) hurtSentinel(ctx, hit, 1);
      else world.command(Damage, { target: hit.id, amount: 1, x: o.x, y: o.y });
    }
    use.effect({ kick: 0.3, hit: hit ? 'body' : 'miss' });
  }

  /** The spanner or extinguisher on the nearest fault of its kind in front of it. */
  fix(use: Use, tool: Fixer): void {
    const { ctx } = this;
    const fault = this.faultAhead(use, tool);
    this.aimedFault = fault;
    if (tool === EXTINGUISHER) this.sprayUntil = this.now + 180;
    if (!fault) return;
    const amount = tool === EXTINGUISHER ? MEND_EXTINGUISHER : MEND_SPANNER;
    ctx.world.command(Mend, { target: fault.id, amount });
    if (fault.render.left - amount <= 0.001) this.body.fixed(fault.render.kind);
    use.effect({ kick: tool === SPANNER ? 0.08 : 0.02 });
    if (tool === SPANNER && Math.random() < 0.25) ctx.world.send(Noise, { kind: Sound.Repair, x: fault.x, y: fault.y, z: fault.render.z, ship: false }, { to: 'all', self: true });
  }

  /** The fault a fixing tool would work on: its kind, in reach, and roughly where it points (or right on it). */
  faultAhead(use: Use, tool: Fixer): FaultEntity | null {
    const o = use.origin;
    const a = use.aim;
    let best: FaultEntity | null = null;
    let score = Infinity;
    for (const f of this.ctx.world.query(o.x, o.y, tool.reach + 1, Fault) as FaultEntity[]) {
      if (f.render.kind !== tool.fixes) continue;
      const fz = f.render.z + (f.render.kind === FaultKind.Fire ? 0.4 : 0);
      const rx = f.x - o.x;
      const ry = f.y - o.y;
      const rz = fz - o.z;
      const d = Math.hypot(rx, ry, rz);
      if (d > tool.reach) continue;
      const facing = d > 0.001 ? (rx * a.x + ry * a.y + rz * a.z) / d : 1;
      // a crosshair can't reach down to a fire at your feet, so a fire counts on the flat
      const flat = Math.hypot(rx, ry);
      const facingFlat = flat > 0.001 ? (rx * a.x + ry * a.y) / (flat * Math.max(0.2, Math.hypot(a.x, a.y))) : 1;
      if (d > 0.7 && facing < 0.75 && !(tool === EXTINGUISHER && facingFlat > 0.85)) continue;
      if (d < score) {
        score = d;
        best = f;
      }
    }
    return best;
  }

  /** The fault the current tool would fix, from the eyes: for a hint before you pull the trigger. */
  lookingAtFault(): FaultEntity | null {
    const tool = this.inventory.current;
    if (!this.me || (tool !== SPANNER && tool !== EXTINGUISHER)) return null;
    const hand = this.hands[Side.Right];
    return this.faultAhead(hand, tool as Fixer);
  }

  protected override switchedTool(): void {
    this.aimedFault = null;
  }

  /** The tool that'd help most right here: for touch's tool strip, which is small. */
  suggestedTool(): Tool<any> | null {
    const s = this.me?.state;
    if (!s) return null;
    let fire = false;
    let sparks = false;
    for (const f of this.ctx.world.query(s.x, s.y, 5, Fault) as FaultEntity[]) {
      if (f.render.kind === FaultKind.Fire) fire = true;
      else sparks = true;
    }
    if (!this.ctx.deck.onShip(s.x)) return PHASER;
    return fire ? EXTINGUISHER : sparks ? SPANNER : null;
  }
}

/** Whether crew can beam themselves: nobody's at science to do it, and the transporter's free to use. */
export function selfBeam(ctx: StarshipContext): boolean {
  const ship = ctx.ship()?.render;
  return !!ship && ship.beam === Beam.Idle && !transporterBlocked(ship) && !crewStations(ctx).has(Station.Science);
}

/** Sitting or standing, crew count at their station too. */
export function crewStations(ctx: StarshipContext): Map<Station, string[]> {
  const out = new Map<Station, string[]>();
  for (const c of ctx.world.all(CrewDef)) {
    if (!c.render.seat) continue;
    const st = (c.render.seat - 1) as Station;
    out.set(st, [...(out.get(st) ?? []), c.render.name]);
  }
  return out;
}
