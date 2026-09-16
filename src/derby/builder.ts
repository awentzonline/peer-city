import { Avatar, RADIUS, type AvatarBody, type AvatarFrontend } from '../crossplay/avatar';
import { Platform } from '../crossplay/platform';
import type { Role } from '../crossplay/role';
import type { Tool, Toolbox } from '../crossplay/tool';
import { clamp, type BuilderEntity, type DerbyContext, type RaceEntity } from './context';
import { BAYS, EDGE, GARAGE } from './course';
import { Builder as BuilderDef, EditOp, Phase, Racer, RacerMode } from './defs';
import type { DerbyIntent } from './intent';
import { PART_GUN, TOOLS, noAim, type Aim } from './kit';
import { CELL, PARTS, PLACEABLE, PartKind, designStats, type Dir } from './parts';
import { rotate, uprightness } from './physics';
import { RacerSim, designOf, quatOf, type RacerEvents } from './racer';

/** Seated, the eyes are this far above the seat's middle. */
export const SEAT_EYE = 0.95;

/** How the builder's rules reach back to the device playing it. */
export interface BuilderBody extends AvatarBody {
  /** Sat down in the racer (to race), or got out of it (back in the garage). */
  seated(seated: boolean): void;
  /** The race went: countdown beeps and the start. `n` is 3, 2, 1, or 0 for go. */
  countdown(n: number): void;
  /** The racer hit something hard enough to lose parts. */
  crashed(parts: number): void;
  finished(ms: number): void;
}

export type BuilderFrontend = AvatarFrontend<DerbyIntent> &
  BuilderBody & {
    /** Whether to draw yourself sitting in your racer: not from the driver's own eyes. */
    readonly showDriver: boolean;
  };

const NO_BODY: BuilderBody = {
  platform: Platform.Desktop,
  moved() {},
  placed() {},
  hurt() {},
  used() {},
  died() {},
  seated() {},
  countdown() {},
  crashed() {},
  finished() {},
};

/**
 * The player in Peer Derby. In the garage they're an avatar: walking about, holding the part gun and the
 * wrench, building their own racer or helping with someone else's. When a race starts they're seated in their
 * racer, and their intent drives it instead. Only sees an intent, and reaches the device through `body`.
 */
export class Builder extends Avatar<DerbyIntent, BuilderBody, Tool<Builder>> implements Role<DerbyIntent, BuilderFrontend> {
  body: BuilderBody = NO_BODY;
  readonly racer: RacerSim;
  /** What the part gun places. */
  part: PartKind = PartKind.Block;
  /** What each hand's building tool is aimed at: the crosshair's, or a tracked hand's by `Side`. */
  readonly aims: [Aim, Aim] = [noAim(), noAim()];
  private wasSeated = false;
  private lastCount = -1;
  private readonly helpedAt = new Map<string, number>();

  constructor(
    readonly ctx: DerbyContext,
    tools: Toolbox<Tool<Builder>> = TOOLS,
  ) {
    super(tools);
    this.racer = new RacerSim(ctx);
    const events: RacerEvents = {
      modeChanged: (mode) => this.racerMode(mode),
      finished: (ms) => this.body.finished(ms),
      reset: () => ctx.sfx.play('reset'),
      shattered: (n) => this.body.crashed(n),
    };
    this.racer.events = events;
  }

  get me(): BuilderEntity | null {
    return this.ctx.me;
  }

  get now(): number {
    return this.ctx.now;
  }

  get seated(): boolean {
    return this.racer.seated;
  }

  /** The aim for a hand (null for the crosshair's). */
  aimFor(side: number | null): Aim {
    return this.aims[side ?? 0];
  }

  protected override move(p: { x: number; y: number }, dx: number, dy: number): void {
    const { course } = this.ctx;
    const nx = p.x + dx;
    const ny = p.y + dy;
    // the garage, and the track below it as far as its walls
    if (course.inGarage(nx, ny) || (nx > GARAGE.x1 && Math.abs(course.locate(nx, ny).lat) < EDGE - 4)) {
      p.x = nx;
      p.y = ny;
    } else if (course.inGarage(nx, p.y)) {
      p.x = nx;
    } else if (course.inGarage(p.x, ny)) {
      p.y = ny;
    }
  }

  /** Keep out of racers sitting in their bays. */
  protected override collide(p: { x: number; y: number }): void {
    for (const racer of this.ctx.world.query(p.x, p.y, 6, Racer)) {
      if (racer.render.mode !== RacerMode.Parked) continue;
      const s = racer.render;
      const { design, keep } = designOf(racer);
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      design.forEach((part, i) => {
        if (!keep[i]) return;
        x0 = Math.min(x0, part.x * CELL - CELL / 2);
        x1 = Math.max(x1, part.x * CELL + CELL / 2);
        y0 = Math.min(y0, part.y * CELL - CELL / 2);
        y1 = Math.max(y1, part.y * CELL + CELL / 2);
      });
      // parked racers face +x, so their box is axis-aligned
      const lx = p.x - s.x;
      const ly = p.y - s.y;
      const inX = lx > x0 - RADIUS && lx < x1 + RADIUS;
      const inY = ly > y0 - RADIUS && ly < y1 + RADIUS;
      if (!inX || !inY) continue;
      const pushes = [x0 - RADIUS - lx, x1 + RADIUS - lx, y0 - RADIUS - ly, y1 + RADIUS - ly];
      const least = pushes.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
      if (least === pushes[0] || least === pushes[1]) p.x += least;
      else p.y += least;
    }
  }

  protected override groundAt(x: number, y: number): number {
    return this.ctx.course.heightAt(x, y);
  }

  protected override switchedTool(): void {
    this.ctx.sfx.play('switch');
  }

  /** Into the world: a builder beside a free bay, and a racer in it. */
  spawn(): void {
    const { ctx } = this;
    const bay = this.freeBay();
    const stand = ctx.course.bayStand(bay);
    const skin = Math.floor(Math.random() * 30);
    ctx.me = ctx.world.spawn(BuilderDef, { x: stand.x, y: stand.y, name: ctx.playerName, skin });
    ctx.racer = this.racer.spawn(bay, ctx.me.id, skin);
    ctx.me.state.racer = ctx.racer.id;
    this.heading = stand.heading;
    ctx.world.setFocus(stand.x, stand.y);
  }

  /** The lowest bay nobody's racer is in. */
  private freeBay(): number {
    const taken = new Set<number>();
    for (const r of this.ctx.world.all(Racer)) if (r !== this.ctx.racer) taken.add(r.state.bay);
    for (let i = 0; i < BAYS; i++) if (!taken.has(i)) return i;
    return Math.floor(Math.random() * BAYS);
  }

  /** Two racers in one bay (two players arrived at once): the newer one moves. */
  private settleBay(): void {
    const mine = this.ctx.racer;
    if (!mine || mine.state.mode !== RacerMode.Parked) return;
    for (const other of this.ctx.world.all(Racer)) {
      if (other === mine || other.state.bay !== mine.state.bay || other.id > mine.id) continue;
      this.racer.moveToBay(this.freeBay());
      return;
    }
  }

  update(dt: number, intent: DerbyIntent): void {
    const { ctx } = this;
    const me = this.me;
    if (!me) return;
    const s = me.state;
    this.begin(intent);
    const race = this.race();
    this.settleBay();

    this.racer.controls = { steer: intent.steer, brake: intent.brake, push: intent.push, boost: intent.boost };
    this.racer.wantsReset = intent.reset;
    this.racer.update(dt, race);
    this.countdown(race);

    if (this.racer.seated) {
      this.sit(intent);
      return;
    }
    if (this.wasSeated) this.getOut();

    if (intent.head) this.walkTracked(dt, intent.head, intent, true);
    else this.walk(dt, intent);

    this.choosePart(intent);
    if (intent.ready && race?.state.phase === Phase.Building) this.toggleReady();
    for (const aim of this.aims) Object.assign(aim, noAim());
    if (intent.hands) this.useHands(intent.hands, dt);
    else this.useCrosshair(intent, dt);
    ctx.world.setFocus(s.x, s.y);
  }

  /** After the physics step: the racer's rules that need to know where it got to. */
  afterPhysics(dt: number): void {
    this.racer.afterStep(dt);
    if (this.racer.seated) this.placeInSeat();
  }

  race(): RaceEntity | null {
    return this.ctx.race();
  }

  private choosePart(intent: DerbyIntent): void {
    const before = this.part;
    if (intent.part !== null && PLACEABLE.includes(intent.part)) this.part = intent.part;
    if (intent.cyclePart) {
      const i = PLACEABLE.indexOf(this.part);
      this.part = PLACEABLE[(i + intent.cyclePart + PLACEABLE.length) % PLACEABLE.length];
    }
    if (this.part === before) return;
    this.ctx.sfx.play('switch');
    if (!intent.hands && this.inventory.current !== PART_GUN) this.inventory.select(PART_GUN);
  }

  private toggleReady(): void {
    const r = this.ctx.racer;
    if (!r || r.state.mode !== RacerMode.Parked) return;
    r.state.ready = !r.state.ready;
    this.ctx.sfx.play(r.state.ready ? 'ready' : 'switch');
    this.ctx.hud.message(r.state.ready ? 'Ready to race! The race starts when everyone is ready' : 'Not ready: keep building');
  }

  /** Seated: the body goes wherever the seat is, and faces where the racer does (or the headset looks). */
  private sit(intent: DerbyIntent): void {
    const s = this.me!.state;
    if (!this.wasSeated) {
      this.wasSeated = true;
      s.seated = true;
      this.hands[0].hold(null);
      this.hands[1].hold(null);
      s.tool = s.ltool = 255;
      this.body.seated(true);
    }
    this.placeInSeat();
    if (intent.head) {
      s.yaw = intent.head.heading;
      s.pitch = intent.head.pitch;
    }
  }

  private placeInSeat(): void {
    const me = this.me!;
    const racer = this.ctx.racer!;
    const s = me.state;
    const r = racer.state;
    const q = quatOf(r);
    const up = rotate(q, { x: 0, y: 0, z: 1 });
    s.x = r.x;
    s.y = r.y;
    s.z = r.z - this.groundAt(r.x, r.y) + CELL / 2 - 0.9; // hips on the seat
    s.head = 0.9 + SEAT_EYE - CELL / 2;
    const f = rotate(q, { x: 1, y: 0, z: 0 });
    this.heading = Math.atan2(f.y, f.x);
    this.pitch = Math.asin(clamp(f.z, -1, 1)) * (up.z > 0 ? 1 : 0);
    s.yaw = this.heading;
    s.pitch = this.pitch;
    this.ctx.world.setFocus(r.x, r.y);
  }

  /** Where a seated driver's eyes are: above the seat, tipped with the racer. */
  seatEye(out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const r = this.ctx.racer!.state;
    const q = quatOf(r);
    const e = rotate(q, { x: -0.05, y: 0, z: SEAT_EYE });
    out.x = r.x + e.x;
    out.y = r.y + e.y;
    out.z = r.z + e.z;
    return out;
  }

  private getOut(): void {
    this.wasSeated = false;
    const s = this.me!.state;
    s.seated = false;
    const stand = this.ctx.course.bayStand(this.ctx.racer!.state.bay);
    this.heading = stand.heading;
    this.pitch = 0;
    s.head = 1.65;
    this.teleport(stand.x, stand.y);
    this.body.seated(false);
  }

  private racerMode(mode: RacerMode): void {
    const { ctx } = this;
    if (mode === RacerMode.Gridded) ctx.hud.message('To the start! Steer, push off, and use your rockets if you built any');
    if (mode === RacerMode.Parked && this.wasSeated) ctx.hud.message('Back in the garage. Build something better!');
  }

  /** Beeps as the countdown passes each whole second, and the go. */
  private countdown(race: RaceEntity | null): void {
    const r = this.ctx.racer?.state;
    if (!race || !r || r.round !== race.state.round) return;
    let n = -1;
    if (race.state.phase === Phase.Countdown && race.state.timer <= 3) n = Math.ceil(race.state.timer);
    else if (race.state.phase === Phase.Racing && r.mode === RacerMode.Racing) n = 0;
    if (n === this.lastCount || n < 0) {
      if (n < 0) this.lastCount = -1;
      return;
    }
    this.lastCount = n;
    this.body.countdown(n);
  }

  /** The part gun stuck a part on. */
  placed(aim: Aim): void {
    this.ctx.sfx.play('place', this.soundAt(aim));
  }

  /** The wrench took one off. */
  removed(aim: Aim): void {
    this.ctx.sfx.play('unbolt', this.soundAt(aim));
  }

  private soundAt(aim: Aim): { x: number; y: number; z: number } | undefined {
    const r = aim.target?.racer.render;
    return r ? { x: r.x, y: r.y, z: r.z } : undefined;
  }

  /** Apply an edit someone sent to our racer. */
  edit(op: EditOp, x: number, y: number, z: number, dir: Dir, kind: PartKind): void {
    this.racer.applyEdit(op, x, y, z, dir, kind);
  }

  /** Someone on another peer changed our racer. */
  helped(peer: string): void {
    const { ctx } = this;
    if (ctx.now < (this.helpedAt.get(peer) ?? 0)) return;
    this.helpedAt.set(peer, ctx.now + 20_000);
    let name = 'Someone';
    for (const b of ctx.world.all(BuilderDef)) if (b.owner === peer) name = b.state.name;
    ctx.hud.message(`${name} is working on your racer`);
  }

  /** How the racer being built adds up, for the HUD. */
  stats(): { parts: number; mass: number; wheels: number; rockets: number } {
    const racer = this.ctx.racer;
    if (!racer) return { parts: 0, mass: 0, wheels: 0, rockets: 0 };
    const { design, keep } = designOf(racer, false);
    return designStats(design, keep);
  }

  /** Whether the racer's the right way up, for a VR frontend to decide whether to follow its roll. */
  get racerUpright(): number {
    const r = this.ctx.racer;
    return r ? uprightness(quatOf(r.state)) : 1;
  }

  /** The part the gun holds, and what it does. */
  get partSpec(): (typeof PARTS)[PartKind] {
    return PARTS[this.part];
  }

  /** The tool out on a crosshair. */
  get tool(): Tool<Builder> | null {
    return this.inventory.current;
  }
}
