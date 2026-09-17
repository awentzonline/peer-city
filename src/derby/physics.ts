import { clamp, type Vec3 } from '../crossplay/math';
import { FixedStep, GRAVITY, RAPIER, collisionGroups as groups, rotate, yawQuat, type BodyPose, type Quat } from '../crossplay/rigid';
import { Course, GARAGE, LENGTH, TOP } from './course';
import { CELL, DIRS, Dir, PARTS, PartKind, WHEEL_DROP, intact, type Design } from './parts';

/**
 * Rigid-body physics, with Rapier (WASM). Every peer runs its own physics world over the same course, and
 * simulates only what it owns: its own racer is a dynamic body on raycast wheels, pushed by rockets, lifted by
 * wings and balloons. Everyone else's racer is a kinematic stand-in that follows where its owner says it is,
 * so racers can bump into each other plausibly without anyone being in charge of the collision. Parts torn off
 * in a crash fly as debris that nothing else hits.
 *
 * World axes (z up). A racer's body is in racer space: +X forward, +Y left, +Z up, from the middle of the seat.
 */

export { GRAVITY, RAPIER, headingOf, initPhysics, rotate, uprightness, yawQuat, type BodyPose, type Quat } from '../crossplay/rigid';

/** Who collides with whom: the course with everything, racers with each other, debris only with the course and debris. */
const WORLD = 1;
const RACERS = 2;
const DEBRIS = 4;

export const DRIVER_MASS = 70;
/** Seconds of rocket fuel a race. */
export const FUEL_SECONDS = 6;
const STEER_ANGLE = 0.35;
const BRAKE_FORCE = 45;
/** A push off with your feet: only when slow. */
const PUSH_FORCE = 900;
const PUSH_TOP_SPEED = 6;
/** Air drag per (m/s)², N. */
const DRAG = 0.35;
const DEBRIS_SECONDS = 9;

/** What the driver wants the racer to do. */
export interface Controls {
  /** -1..1, + left. */
  steer: number;
  brake: boolean;
  push: boolean;
  boost: boolean;
}

export const NO_CONTROLS: Controls = { steer: 0, brake: false, push: false, boost: false };

const tmpA: Vec3 = { x: 0, y: 0, z: 0 };
const tmpB: Vec3 = { x: 0, y: 0, z: 0 };
const tmpC: Vec3 = { x: 0, y: 0, z: 0 };

interface WheelInfo {
  part: number;
  index: number;
  steers: boolean;
}

/** A part that pushes or pulls: where it is in racer space, and what kind. */
interface ForcePart {
  part: number;
  kind: PartKind;
  at: Vec3;
  dir: Dir;
}

export interface Debris {
  body: RAPIER.RigidBody;
  kind: PartKind;
  dir: Dir;
  until: number;
}

/**
 * One racer in the physics world. Built from a design and the parts broken off it, and rebuilt when either
 * changes. `dynamic` is the owner's racer while racing; otherwise it's kinematic, held where it's put.
 */
export class RacerBody {
  body: RAPIER.RigidBody;
  private vehicle: RAPIER.DynamicRayCastVehicleController | null = null;
  private wheels: WheelInfo[] = [];
  private forces: ForcePart[] = [];
  /** Collider handle → part index, for working out what hit what. */
  private readonly parts = new Map<number, number>();
  /** Parts hit harder than they can take, since `takeBreaks`. */
  private readonly breaks = new Set<number>();
  private design: Design = [];
  private keep: boolean[] = [];
  private dynamic = false;
  /** The centre of mass, racer space. */
  readonly com: Vec3 = { x: 0, y: 0, z: 0 };
  controls: Controls = NO_CONTROLS;
  fuel = FUEL_SECONDS;
  /** Whether any wheel or part touched the ground in the last step. */
  grounded = false;
  boosting = false;

  constructor(
    private readonly physics: Physics,
    readonly owned: boolean,
  ) {
    this.body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
  }

  get mass(): number {
    return this.body.mass();
  }

  /** (Re)build the body from a design and a broken-parts mask, keeping where it is and how it's moving. */
  build(design: Design, broken: Uint8Array): void {
    const { world } = this.physics;
    const old = this.body;
    const t = old.translation();
    const r = old.rotation();
    const lv = old.linvel();
    const av = old.angvel();
    this.dispose();

    this.design = design;
    this.keep = intact(design, broken);
    const desc = this.dynamic ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.kinematicPositionBased();
    desc.setTranslation(t.x, t.y, t.z).setRotation(r).setCanSleep(false).setCcdEnabled(this.dynamic).setAngularDamping(0.7);
    if (this.dynamic) desc.setLinvel(lv.x, lv.y, lv.z).setAngvel(av);
    const body = (this.body = world.createRigidBody(desc));
    this.wheels = [];
    this.forces = [];
    this.parts.clear();
    this.breaks.clear();

    design.forEach((p, i) => {
      if (!this.keep[i]) return;
      const spec = PARTS[p.kind];
      const x = p.x * CELL;
      const y = p.y * CELL;
      const z = p.z * CELL;
      let c: RAPIER.ColliderDesc;
      if (spec.wheel) {
        // raycast wheels touch the ground; this only carries the wheel's mass (and stands in for it on others' peers)
        c = RAPIER.ColliderDesc.ball(spec.wheel.radius * 0.8).setTranslation(x, y, z - WHEEL_DROP);
        if (this.owned) c.setSensor(true);
      } else if (p.kind === PartKind.Wing) {
        c = RAPIER.ColliderDesc.cuboid(CELL / 2, CELL / 2, 0.04).setTranslation(x, y, z);
      } else if (p.kind === PartKind.Balloon) {
        c = RAPIER.ColliderDesc.ball(0.38).setTranslation(x, y, z + 0.9);
      } else {
        c = RAPIER.ColliderDesc.cuboid(CELL / 2, CELL / 2, CELL / 2).setTranslation(x, y, z);
      }
      c.setMass(spec.mass + (p.kind === PartKind.Seat ? DRIVER_MASS : 0))
        .setFriction(spec.friction)
        .setRestitution(spec.restitution)
        .setCollisionGroups(groups(RACERS, WORLD | RACERS));
      if (this.owned && this.dynamic && Number.isFinite(spec.strength) && !spec.wheel) {
        c.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(spec.strength);
      }
      const collider = world.createCollider(c, body);
      this.parts.set(collider.handle, i);
      if (spec.thrust || spec.lift || spec.buoyancy) this.forces.push({ part: i, kind: p.kind, at: { x, y, z: p.kind === PartKind.Balloon ? z + 0.9 : z }, dir: p.dir });
    });

    const com = body.localCom();
    this.com.x = com.x;
    this.com.y = com.y;
    this.com.z = com.z;

    if (this.owned && this.dynamic) {
      const v = (this.vehicle = world.createVehicleController(body));
      v.indexUpAxis = 2;
      v.setIndexForwardAxis = 0;
      design.forEach((p, i) => {
        const spec = PARTS[p.kind];
        if (!this.keep[i] || !spec.wheel) return;
        const axle = p.dir === Dir.PX || p.dir === Dir.NX ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
        const index = v.numWheels();
        v.addWheel({ x: p.x * CELL, y: p.y * CELL, z: p.z * CELL }, { x: 0, y: 0, z: -1 }, axle, WHEEL_DROP + 0.22, spec.wheel.radius);
        v.setWheelSuspensionStiffness(index, 24);
        v.setWheelSuspensionCompression(index, 2.6);
        v.setWheelSuspensionRelaxation(index, 4);
        v.setWheelMaxSuspensionTravel(index, 0.4);
        v.setWheelMaxSuspensionForce(index, 60_000);
        v.setWheelFrictionSlip(index, p.kind === PartKind.BigWheel ? 1.8 : 1.3);
        v.setWheelSideFrictionStiffness(index, 0.7);
        this.wheels.push({ part: i, index, steers: p.x * CELL > this.com.x + 0.1 });
      });
    }
  }

  /** Simulate it (the owner, racing), or hold it still wherever it's put. Rebuilds. */
  setDynamic(dynamic: boolean): void {
    if (this.dynamic === dynamic) return;
    this.dynamic = dynamic;
    this.build(this.design, withKeep(this.keep));
  }

  get isDynamic(): boolean {
    return this.dynamic;
  }

  /** Put it somewhere at once, stopped. */
  place(x: number, y: number, z: number, q: Quat): void {
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation(q, true);
    if (this.dynamic) {
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  /** A kinematic stand-in moves to where its owner says it is, in the next step. */
  follow(x: number, y: number, z: number, q: Quat): void {
    if (this.dynamic) return;
    this.body.setNextKinematicTranslation({ x, y, z });
    this.body.setNextKinematicRotation(q);
  }

  pose(out: BodyPose): BodyPose {
    const t = this.body.translation();
    const r = this.body.rotation();
    out.x = t.x;
    out.y = t.y;
    out.z = t.z;
    out.q.x = r.x;
    out.q.y = r.y;
    out.q.z = r.z;
    out.q.w = r.w;
    return out;
  }

  /** Speed along the racer's nose, m/s. */
  forwardSpeed(): number {
    const v = this.body.linvel();
    const f = rotate(this.body.rotation(), { x: 1, y: 0, z: 0 }, tmpA);
    return v.x * f.x + v.y * f.y + v.z * f.z;
  }

  speed(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.y, v.z);
  }

  /** Where each wheel is on its suspension and how far it's rolled, for drawing the owner's racer. */
  wheelState(part: number): { drop: number; steer: number; spin: number } | null {
    const w = this.wheels.find((wh) => wh.part === part);
    if (!w || !this.vehicle) return null;
    return {
      drop: this.vehicle.wheelSuspensionLength(w.index) ?? WHEEL_DROP,
      steer: this.vehicle.wheelSteering(w.index) ?? 0,
      spin: this.vehicle.wheelRotation(w.index) ?? 0,
    };
  }

  /** Parts hit too hard since last asked. */
  takeBreaks(): number[] {
    const out = [...this.breaks];
    this.breaks.clear();
    return out;
  }

  /** @internal a collider of this racer took a contact force over its strength */
  impact(handle: number): void {
    const part = this.parts.get(handle);
    if (part !== undefined && part > 0) this.breaks.add(part);
  }

  owns(handle: number): boolean {
    return this.parts.has(handle);
  }

  /** @internal before a physics step: the driver's controls, and every part's pushes and pulls. */
  beforeStep(dt: number): void {
    if (!this.dynamic) return;
    const { body, controls } = this;
    body.resetForces(true);
    body.resetTorques(true);
    const q = body.rotation();
    const t = body.translation();
    const v = body.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    const forward = rotate(q, { x: 1, y: 0, z: 0 }, tmpB);
    const vForward = v.x * forward.x + v.y * forward.y + v.z * forward.z;

    // + steers left as you see it. The scene draws world +y on the right of a racer facing +x (see models.ts),
    // so left is a turn toward -y: clockwise from above, the opposite of Rapier's steering and torques.
    const turn = -controls.steer;
    const vehicle = this.vehicle;
    let wheelsDown = 0;
    if (vehicle) {
      for (const w of this.wheels) {
        vehicle.setWheelSteering(w.index, w.steers ? turn * STEER_ANGLE * clamp(1.4 - Math.abs(vForward) / 40, 0.45, 1) : 0);
        vehicle.setWheelBrake(w.index, controls.brake ? BRAKE_FORCE : 0);
        vehicle.setWheelEngineForce(w.index, 0);
      }
      vehicle.updateVehicle(dt, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(RACERS, WORLD | RACERS));
      for (const w of this.wheels) if (vehicle.wheelIsInContact(w.index)) wheelsDown++;
    }
    const low = this.physics.nearGround(t.x, t.y, t.z, 1.6);
    this.grounded = wheelsDown > 0 || low;

    const add = (f: Vec3, at?: Vec3) => {
      if (at) body.addForceAtPoint(f, { x: t.x + at.x, y: t.y + at.y, z: t.z + at.z }, true);
      else body.addForce(f, true);
    };

    // a push off with your feet gets you going, then it's all gravity
    if (controls.push && this.grounded && vForward < PUSH_TOP_SPEED) add({ x: forward.x * PUSH_FORCE, y: forward.y * PUSH_FORCE, z: 0 });

    // no steering wheels: lean the whole thing round (sleds, and anything with its wheels knocked off)
    const steersWithWheels = this.wheels.some((w) => w.steers && vehicle?.wheelIsInContact(w.index));
    if (!steersWithWheels && controls.steer && (this.grounded || speed > 3)) {
      const up = rotate(q, { x: 0, y: 0, z: 1 }, tmpC);
      const av = body.angvel();
      const want = turn * (this.grounded ? 1.3 : 0.5);
      const have = av.x * up.x + av.y * up.y + av.z * up.z;
      const k = (want - have) * body.mass() * 0.6;
      body.addTorque({ x: up.x * k, y: up.y * k, z: up.z * k }, true);
    }

    if (controls.brake && !vehicle?.numWheels()) add({ x: -v.x * body.mass() * 0.8, y: -v.y * body.mass() * 0.8, z: 0 });

    const drag = DRAG * speed;
    if (speed > 0.1) add({ x: -v.x * drag, y: -v.y * drag, z: -v.z * drag });

    this.boosting = controls.boost && this.fuel > 0 && this.forces.some((f) => f.kind === PartKind.Rocket);
    if (this.boosting) this.fuel = Math.max(0, this.fuel - dt);
    for (const f of this.forces) {
      const spec = PARTS[f.kind];
      const at = rotate(q, f.at, tmpA);
      if (spec.thrust && this.boosting) {
        const [dx, dy, dz] = DIRS[f.dir];
        const push = rotate(q, { x: -dx * spec.thrust, y: -dy * spec.thrust, z: -dz * spec.thrust }, tmpC);
        add(push, at);
      } else if (spec.lift) {
        const up = rotate(q, { x: 0, y: 0, z: 1 }, tmpC);
        // lift from air over the wing, and drag against falling flat through it
        const vUp = v.x * up.x + v.y * up.y + v.z * up.z;
        const lift = clamp(spec.lift * vForward * Math.abs(vForward), -900, 900) - clamp(vUp * Math.abs(vUp) * 4, -1200, 1200);
        add({ x: up.x * lift, y: up.y * lift, z: up.z * lift }, at);
      } else if (spec.buoyancy) {
        add({ x: 0, y: 0, z: spec.buoyancy }, at);
      }
    }
  }

  dispose(): void {
    const { world } = this.physics;
    if (this.vehicle) world.removeVehicleController(this.vehicle);
    this.vehicle = null;
    if (world.getRigidBody(this.body.handle)) world.removeRigidBody(this.body);
  }

  /** Parts of the design that are still on, by index. */
  get intact(): readonly boolean[] {
    return this.keep;
  }
}

/** A broken-parts mask with every part not kept set. */
function withKeep(keep: boolean[]): Uint8Array {
  const mask = new Uint8Array(8);
  keep.forEach((k, i) => {
    if (!k) mask[i >> 3] |= 1 << (i & 7);
  });
  return mask;
}

export class Physics {
  readonly world: RAPIER.World;
  readonly racers = new Set<RacerBody>();
  readonly debris: Debris[] = [];
  private readonly events: RAPIER.EventQueue;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  private readonly clock = new FixedStep(1 / 60, 8);

  /** Seconds simulated. */
  get time(): number {
    return this.clock.time;
  }

  constructor(readonly course: Course) {
    this.world = new RAPIER.World({ x: 0, y: 0, z: -GRAVITY });
    this.world.timestep = this.clock.step;
    this.events = new RAPIER.EventQueue(true);
    const ground = (c: RAPIER.ColliderDesc) => this.world.createCollider(c.setCollisionGroups(groups(WORLD, WORLD | RACERS | DEBRIS)).setFriction(0.7));

    const { positions, indices } = course.ribbon(1);
    ground(RAPIER.ColliderDesc.trimesh(positions, indices));
    const gw = (GARAGE.x1 - GARAGE.x0) / 2;
    const gh = (GARAGE.y1 - GARAGE.y0) / 2;
    ground(RAPIER.ColliderDesc.cuboid(gw, gh, 2).setTranslation((GARAGE.x0 + GARAGE.x1) / 2, (GARAGE.y0 + GARAGE.y1) / 2, TOP - 2));
    // a wall of hay at the bottom of the runout
    const end = course.pointAt(LENGTH - 2, 0);
    ground(RAPIER.ColliderDesc.cuboid(1, 40, 3).setTranslation(end.x, end.y, end.z + 2).setRotation(yawQuat(end.heading)).setRestitution(0.3));
    const upright = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }; // cylinders stand along y; turn them onto z
    for (const tree of course.trees) {
      ground(RAPIER.ColliderDesc.cylinder(tree.height / 2, tree.radius).setTranslation(tree.x, tree.y, tree.z + tree.height / 2).setRotation(upright));
    }
  }

  addRacer(owned: boolean): RacerBody {
    const r = new RacerBody(this, owned);
    this.racers.add(r);
    return r;
  }

  removeRacer(r: RacerBody): void {
    r.dispose();
    this.racers.delete(r);
  }

  /** Whether there's ground (the course, not racers) within `depth` below a point. */
  nearGround(x: number, y: number, z: number, depth: number): boolean {
    this.ray.origin = { x, y, z };
    return this.world.castRay(this.ray, depth, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC, groups(DEBRIS, WORLD)) !== null;
  }

  /** Throw a part off: a loose body with the part's shape, gone after a while. */
  throwPart(kind: PartKind, dir: Dir, at: Vec3, q: Quat, velocity: Vec3): void {
    const spin = () => (Math.random() - 0.5) * 8;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(at.x, at.y, at.z)
        .setRotation(q)
        .setLinvel(velocity.x, velocity.y, velocity.z)
        .setAngvel({ x: spin(), y: spin(), z: spin() }),
    );
    const spec = PARTS[kind];
    const shape = spec.wheel ? RAPIER.ColliderDesc.cylinder(spec.wheel.width / 2, spec.wheel.radius) : RAPIER.ColliderDesc.cuboid(CELL / 2, CELL / 2, CELL / 2);
    this.world.createCollider(shape.setMass(Math.min(spec.mass, 20)).setRestitution(0.3).setFriction(0.6).setCollisionGroups(groups(DEBRIS, WORLD | DEBRIS)), body);
    this.debris.push({ body, kind, dir, until: this.time + DEBRIS_SECONDS + Math.random() * 3 });
    while (this.debris.length > 80) this.world.removeRigidBody(this.debris.shift()!.body);
  }

  /** Run the world forward `dt` seconds in fixed steps. Long gaps (a background tab) are cut short. */
  step(dt: number): void {
    this.clock.run(dt, (step) => {
      for (const r of this.racers) r.beforeStep(step);
      this.world.step(this.events);
      this.events.drainContactForceEvents((e) => {
        for (const r of this.racers) {
          if (!r.isDynamic) continue;
          if (r.owns(e.collider1())) r.impact(e.collider1());
          if (r.owns(e.collider2())) r.impact(e.collider2());
        }
      });
    });
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      if (d.until > this.time) continue;
      this.world.removeRigidBody(d.body);
      this.debris.splice(i, 1);
    }
  }

  dispose(): void {
    this.events.free();
    this.world.free();
  }
}
