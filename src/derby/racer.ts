import { clamp, type DerbyContext, type RaceEntity, type RacerEntity, type Vec3 } from './context';
import { FINISH } from './course';
import { EditOp, Feed, Phase, Racer, RacerMode, Shatter } from './defs';
import {
  CELL,
  DIRS,
  NO_BROKEN,
  PARTS,
  cleanDesign,
  decodeDesign,
  designStats,
  encodeDesign,
  intact,
  isBroken,
  partAt,
  starterDesign,
  withBroken,
  withPart,
  withoutPart,
  type Design,
  type Dir,
  type PartKind,
} from './parts';
import { quatOf, writeQuat } from '../crossplay/rigid';
import { FUEL_SECONDS, NO_CONTROLS, headingOf, rotate, uprightness, yawQuat, type BodyPose, type Controls, type Quat, type RacerBody } from './physics';
import { raceTime } from './race';

/** Seconds upside down or stuck before a racer is put back on the track by itself. */
const STUCK_SECONDS = 4;
/** Progress can't jump further than this in a frame: no finishing by flying over a bend. */
const MAX_PROGRESS_STEP = 25;

/** How a racer's design is kept decoded: the blob it came from, and what's still attached. */
export interface Decoded {
  bytes: Uint8Array;
  broken: Uint8Array;
  design: Design;
  keep: boolean[];
}

const decoded = new WeakMap<RacerEntity, Decoded>();

/** A racer's design and which parts are still on it, decoded once per change. */
export function designOf(racer: RacerEntity, useRender = true): Decoded {
  const s = useRender ? racer.render : racer.state;
  let d = decoded.get(racer);
  if (!d || d.bytes !== s.design) {
    const design = decodeDesign(s.design);
    d = { bytes: s.design, broken: s.broken, design, keep: intact(design, s.broken) };
    decoded.set(racer, d);
  } else if (d.broken !== s.broken) {
    d.broken = s.broken;
    d.keep = intact(d.design, s.broken);
  }
  return d;
}

export { quatOf } from '../crossplay/rigid';

/** Where a point in racer space is in the world. */
export function racerToWorld(racer: RacerEntity, p: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const s = racer.render;
  rotate(quatOf(s, q), p, out);
  out.x += s.x;
  out.y += s.y;
  out.z += s.z;
  return out;
}

const q: Quat = { x: 0, y: 0, z: 0, w: 1 };
const pose: BodyPose = { x: 0, y: 0, z: 0, q: { x: 0, y: 0, z: 0, w: 1 } };
const v3: Vec3 = { x: 0, y: 0, z: 0 };

/** What the owner of a racer tells its builder happened. */
export interface RacerEvents {
  /** Went to the grid, started racing, or went back to its bay. */
  modeChanged(mode: RacerMode): void;
  finished(ms: number): void;
  /** Put back on the track. */
  reset(): void;
  /** Parts tore off. */
  shattered(count: number): void;
}

/**
 * The owner's side of a racer: builds it from edits, takes it to the grid and down the hill in the physics
 * world, keeps track of its progress, and brings it home. Only the peer whose player built it runs this.
 */
export class RacerSim {
  entity: RacerEntity | null = null;
  readonly body: RacerBody;
  events: RacerEvents | null = null;
  controls: Controls = NO_CONTROLS;
  /** The driver asked to go back to the last checkpoint. */
  wantsReset = false;
  /** The driver asked to give up and go home. */
  wantsQuit = false;
  /** Local time the race started for this racer, ms. */
  private startedAt = 0;
  private stuck = 0;
  private built: Uint8Array | null = null;
  private builtBroken: Uint8Array | null = null;

  constructor(private readonly ctx: DerbyContext) {
    this.body = ctx.physics.addRacer(true);
  }

  get design(): Design {
    return designOf(this.entity!, false).design;
  }

  get mode(): RacerMode {
    return this.entity?.state.mode ?? RacerMode.Parked;
  }

  /** In its seat, rather than building. */
  get seated(): boolean {
    return this.mode !== RacerMode.Parked;
  }

  /** Into its bay, built as `design` if there is one (e.g. how it was left last time), or the starter cart. */
  spawn(bay: number, builder: number, color: number, design: Uint8Array | null = null): RacerEntity {
    const { ctx } = this;
    const b = ctx.course.bay(bay);
    const parts = design?.length ? cleanDesign(decodeDesign(design)) : starterDesign();
    this.entity = ctx.world.spawn(Racer, { x: b.x, y: b.y, z: b.z + 1, bay, builder, color, design: encodeDesign(parts), mode: RacerMode.Parked });
    this.entity.held = true;
    this.rebuild();
    this.park();
    return this.entity;
  }

  /** Move to another bay (someone else took this one). */
  moveToBay(bay: number): void {
    this.entity!.state.bay = bay;
    if (this.mode === RacerMode.Parked) this.park();
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  /** Apply an edit someone sent. Only while it's in its bay. Returns whether it changed. */
  applyEdit(op: EditOp, x: number, y: number, z: number, dir: Dir, kind: PartKind): boolean {
    const e = this.entity;
    if (!e || this.mode !== RacerMode.Parked) return false;
    const design = this.design;
    let next: Design | null = null;
    if (op === EditOp.Add) {
      const [dx, dy, dz] = DIRS[dir];
      const onto = partAt(design, x - dx, y - dy, z - dz);
      next = onto >= 0 ? withPart(design, onto, dir, kind) : null;
    } else {
      const i = partAt(design, x, y, z);
      next = i > 0 ? withoutPart(design, i) : null;
    }
    if (!next) return false;
    e.state.design = encodeDesign(next);
    e.state.ready = false;
    this.rebuild();
    this.park();
    return true;
  }

  /** Rebuild it as a whole design, e.g. one off a shelf. Only while it's in its bay. Returns whether it could. */
  loadDesign(design: Uint8Array): boolean {
    const e = this.entity;
    if (!e || this.mode !== RacerMode.Parked) return false;
    e.state.design = encodeDesign(cleanDesign(decodeDesign(design)));
    e.state.ready = false;
    this.rebuild();
    this.park();
    return true;
  }

  // -------------------------------------------------------------------------
  // Racing
  // -------------------------------------------------------------------------

  /** The owner's frame: follow the race's phase, drive, and replicate where the body is. Call before the physics step. */
  update(dt: number, race: RaceEntity | null): void {
    const e = this.entity;
    if (!e) return;
    const s = e.state;
    this.rebuild();
    const phase = race?.state.phase ?? Phase.Building;
    const round = race?.state.round ?? 0;

    switch (s.mode) {
      case RacerMode.Parked:
        if (phase === Phase.Countdown && round !== s.round && (race?.state.timer ?? 0) > 1) this.toGrid(round);
        break;
      case RacerMode.Gridded:
        if (phase === Phase.Racing && round === s.round) this.go();
        else if (phase !== Phase.Countdown || round !== s.round) this.home();
        break;
      case RacerMode.Racing:
        if (phase !== Phase.Racing || round !== s.round) this.home();
        else if (this.wantsQuit) this.giveUp();
        break;
      case RacerMode.Finished:
        if (phase !== Phase.Racing || round !== s.round) this.home();
        break;
    }
    this.body.controls = s.mode === RacerMode.Racing ? this.controls : s.mode === RacerMode.Finished ? { ...NO_CONTROLS, brake: true } : NO_CONTROLS;
    s.steer = this.body.controls.steer;
  }

  /** After the physics step: parts torn off, progress, the finish, and where it's got to. */
  afterStep(dt: number): void {
    const e = this.entity;
    if (!e) return;
    const s = e.state;
    const { body, ctx } = this;
    if (body.isDynamic) {
      this.shatter(body.takeBreaks());
      s.boost = body.boosting;
      s.fuel = body.fuel;
    } else {
      s.boost = false;
    }
    body.pose(pose);
    s.x = pose.x;
    s.y = pose.y;
    s.z = pose.z;
    writeQuat(s, pose.q);
    s.speed = body.isDynamic ? body.forwardSpeed() : 0;

    if (s.mode !== RacerMode.Racing && s.mode !== RacerMode.Finished) return;
    const w = ctx.course.locate(s.x, s.y);
    if (w.u > s.progress && w.u - s.progress < MAX_PROGRESS_STEP && Math.abs(w.lat) < 20) s.progress = w.u;
    if (s.mode === RacerMode.Racing && s.progress >= FINISH) {
      s.mode = RacerMode.Finished;
      s.finish = Math.max(1, Math.round(ctx.now - this.startedAt));
      this.events?.finished(s.finish);
      this.events?.modeChanged(s.mode);
      const name = ctx.me?.state.name ?? 'Someone';
      ctx.world.send(Feed, { text: `${name} crossed the line in ${raceTime(s.finish)}` }, { to: 'all' });
      return;
    }
    if (s.mode !== RacerMode.Racing) return;

    const upright = uprightness(pose.q);
    // stopped on the flat start, you're expected to push off; further down, stopped means stuck
    const stalled = body.speed() < 0.6 && !this.controls.push && s.progress > 45;
    this.stuck = upright < 0.2 || (stalled && body.grounded && s.progress < FINISH) ? this.stuck + dt : 0;
    if (this.wantsReset || this.stuck > STUCK_SECONDS || ctx.course.outOfBounds(s.x, s.y, s.z)) this.resetToCheckpoint();
  }

  /** Back on the track at the last checkpoint, facing downhill, stopped and mended: the time it cost is the price. */
  resetToCheckpoint(): void {
    const s = this.entity!.state;
    const { course } = this.ctx;
    s.broken = NO_BROKEN;
    this.rebuild();
    const u = Math.max(4, course.checkpoint(s.progress));
    const p = course.pointAt(u, (Math.random() - 0.5) * 8);
    this.body.place(p.x, p.y, p.z + this.rideHeight() + 0.6, yawQuat(p.heading));
    this.stuck = 0;
    this.events?.reset();
  }

  private toGrid(round: number): void {
    const s = this.entity!.state;
    s.round = round;
    s.mode = RacerMode.Gridded;
    s.finish = 0;
    s.ready = false;
    s.quit = false;
    s.broken = NO_BROKEN;
    this.rebuild();
    const slot = this.ctx.course.gridSlot(s.bay);
    s.progress = this.ctx.course.locate(slot.x, slot.y).u;
    this.body.setDynamic(false);
    this.body.place(slot.x, slot.y, slot.z + this.rideHeight() + 0.05, yawQuat(slot.heading));
    this.events?.modeChanged(s.mode);
  }

  private go(): void {
    const s = this.entity!.state;
    s.mode = RacerMode.Racing;
    this.startedAt = this.ctx.now;
    this.body.fuel = FUEL_SECONDS;
    this.body.setDynamic(true);
    this.stuck = 0;
    this.events?.modeChanged(s.mode);
  }

  /** Out of the race and home to build something better. It stays in the round, so the standings show it. */
  private giveUp(): void {
    this.entity!.state.quit = true;
    this.home();
    const name = this.ctx.me?.state.name ?? 'Someone';
    this.ctx.world.send(Feed, { text: `${name} gave up and went back to the garage` }, { to: 'all' });
  }

  /** Back to the bay, mended. */
  private home(): void {
    const s = this.entity!.state;
    s.mode = RacerMode.Parked;
    s.broken = NO_BROKEN;
    s.fuel = FUEL_SECONDS;
    this.body.setDynamic(false);
    this.rebuild();
    this.park();
    this.events?.modeChanged(s.mode);
  }

  /** Sit it on its bay's pad. */
  park(): void {
    const s = this.entity!.state;
    const b = this.ctx.course.bay(s.bay);
    this.body.place(b.x, b.y, b.z + this.rideHeight() + 0.02, yawQuat(b.heading));
  }

  /** How far above the ground the seat's middle is when the racer sits on its lowest parts. */
  private rideHeight(): number {
    const d = designOf(this.entity!, false);
    return -designStats(d.design, d.keep).bottom;
  }

  /** Rebuild the body if the design or its broken parts changed. */
  private rebuild(): void {
    const s = this.entity!.state;
    if (this.built === s.design && this.builtBroken === s.broken) return;
    this.built = s.design;
    this.builtBroken = s.broken;
    this.body.build(designOf(this.entity!, false).design, s.broken);
  }

  /** Tear off parts hit too hard, and everything that was only held on by them. */
  private shatter(hit: number[]): void {
    if (!hit.length) return;
    const e = this.entity!;
    const s = e.state;
    const { design, keep } = designOf(e, false);
    const fresh = hit.filter((i) => keep[i] && !isBroken(s.broken, i));
    if (!fresh.length) return;
    const broken = withBroken(s.broken, fresh);
    const after = intact(design, broken);
    const lost: number[] = [];
    keep.forEach((k, i) => k && !after[i] && lost.push(i));
    if (!lost.length) return;

    const { body, ctx } = this;
    body.pose(pose);
    const lin = body.body.linvel();
    const ang = body.body.angvel();
    for (const i of lost) {
      const p = design[i];
      const r = rotate(pose.q, { x: p.x * CELL, y: p.y * CELL, z: p.z * CELL }, v3);
      const at = { x: pose.x + r.x, y: pose.y + r.y, z: pose.z + r.z };
      // the velocity of that point on the body, and a kick outward
      const vx = lin.x + ang.y * r.z - ang.z * r.y + r.x * 2;
      const vy = lin.y + ang.z * r.x - ang.x * r.z + r.y * 2;
      const vz = lin.z + ang.x * r.y - ang.y * r.x + 2 + Math.random() * 2;
      ctx.physics.throwPart(p.kind, p.dir, at, pose.q, { x: vx, y: vy, z: vz });
    }
    s.broken = broken;
    this.rebuild();
    ctx.world.send(Shatter, { racer: e.id, parts: new Uint8Array(lost), vx: lin.x, vy: lin.y, vz: lin.z }, { to: 'near', x: s.x, y: s.y, radius: 600, self: false });
    const worst = Math.max(...lost.map((i) => PARTS[design[i].kind].mass));
    ctx.fx.crash(s.x, s.y, s.z, lost.length);
    ctx.sfx.play('crunch', { x: s.x, y: s.y, z: s.z }, clamp(worst / 20, 0.4, 1.4));
    this.events?.shattered(lost.length);
  }

  dispose(): void {
    this.ctx.physics.removeRacer(this.body);
  }
}

/** Another peer's racer, in this peer's physics world: a kinematic stand-in where its owner says it is. */
export class RacerProxies {
  private readonly bodies = new Map<RacerEntity, { body: RacerBody; design: Uint8Array | null; broken: Uint8Array | null }>();

  constructor(private readonly ctx: DerbyContext) {}

  update(): void {
    const { ctx } = this;
    for (const racer of ctx.world.remote(Racer)) {
      let p = this.bodies.get(racer);
      if (!p) this.bodies.set(racer, (p = { body: ctx.physics.addRacer(false), design: null, broken: null }));
      const s = racer.render;
      if (p.design !== s.design || p.broken !== s.broken) {
        p.design = s.design;
        p.broken = s.broken;
        p.body.build(designOf(racer).design, s.broken);
        p.body.place(s.x, s.y, s.z, quatOf(s, q));
      }
      p.body.follow(s.x, s.y, s.z, quatOf(s, q));
    }
    for (const [racer, p] of this.bodies) {
      if (racer.alive) continue;
      ctx.physics.removeRacer(p.body);
      this.bodies.delete(racer);
    }
  }
}

/** Someone else's racer lost parts: throw copies of them from where it's drawn. */
export function throwShattered(ctx: DerbyContext, racer: RacerEntity, parts: Uint8Array, vx: number, vy: number, vz: number): void {
  const { design } = designOf(racer);
  const rq = quatOf(racer.render, { x: 0, y: 0, z: 0, w: 1 });
  for (const i of parts) {
    const p = design[i];
    if (!p) continue;
    const at = racerToWorld(racer, { x: p.x * CELL, y: p.y * CELL, z: p.z * CELL }, { x: 0, y: 0, z: 0 });
    const kick = () => (Math.random() - 0.5) * 4;
    ctx.physics.throwPart(p.kind, p.dir, at, rq, { x: vx + kick(), y: vy + kick(), z: vz + 2 + Math.random() * 2 });
  }
  const s = racer.render;
  ctx.fx.crash(s.x, s.y, s.z, parts.length);
  ctx.sfx.play('crunch', { x: s.x, y: s.y, z: s.z }, 1);
}

/** The heading a racer faces, from its replicated rotation. */
export function racerHeading(racer: RacerEntity): number {
  return headingOf(quatOf(racer.render, q));
}
