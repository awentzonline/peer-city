import type { NetWorld } from '@engine/index';
import { clamp, type Vec3 } from '../crossplay/math';
import { FixedStep, GRAVITY, RAPIER, collisionGroups as groups, headingOf, quatOf, rotate, uprightness, writeQuat, yawQuat, type Quat } from '../crossplay/rigid';
import type { CartEntity, GolferEntity } from './context';
import { GRID, N, type Course } from './course';
import { Cart, Golfer, Knock, Noise, Whack } from './defs';

/**
 * Golf carts, in a Rapier world over the course. Every peer runs its own: the carts it owns are dynamic bodies on
 * raycast wheels, driven by whoever sits in them (or parked with the brake on), and everyone else's are kinematic
 * stand-ins that follow where their owners say they are. So carts crash into each other without anyone being in
 * charge of the crash, and each owner decides what the crash did to its own cart and driver.
 *
 * World axes (z up). A cart's body is in cart space: +X forward, +Z up, from the middle of its floor.
 */

/** A cart's size, m: half-lengths of its box. */
export const CART = { halfLength: 1.2, halfWidth: 0.62, wheelRadius: 0.23 };
/** The most carts on the course at once. */
export const MAX_CARTS = 8;
/** Where the driver sits, in cart space: on the left as you face forward (the world's -y side of a cart facing +x). */
export const DRIVER_SEAT: Vec3 = { x: -0.25, y: -0.3, z: 0.28 };
/** How near (m, from its middle) a golfer must be to get in. */
export const BOARD_REACH = 2.4;

const WORLD = 1;
const CARTS = 2;

const MASS = 380;
const ENGINE_FORCE = 900;
const TOP_SPEED = 11.5;
const REVERSE_SPEED = 4;
const BRAKE = 18;
const STEER_ANGLE = 0.55;
/** A contact this hard against another cart or a tree is a crash; this hard, and the driver's thrown out. */
export const CRASH_FORCE = 9000;
export const EJECT_FORCE = 32000;
/** Faster than this, a cart knocks over whoever it hits. */
const RAM_SPEED = 3;
/** Seconds a cart can be on its side before it's put back on its wheels (or, parked, back at the barn). */
const FLIPPED_SECONDS = 2.5;

export interface CartControls {
  /** -1..1: + forward. */
  throttle: number;
  /** -1..1: + left. */
  steer: number;
  brake: boolean;
}

export const PARKED: CartControls = { throttle: 0, steer: 0, brake: true };

export interface Crash {
  cart: CartEntity;
  force: number;
  x: number;
  y: number;
  z: number;
}

const tmpA: Vec3 = { x: 0, y: 0, z: 0 };
const tmpB: Vec3 = { x: 0, y: 0, z: 0 };
const q: Quat = { x: 0, y: 0, z: 0, w: 1 };

/** One cart in the physics world: dynamic while this peer owns it, a kinematic stand-in otherwise. */
class CartBody {
  body!: RAPIER.RigidBody;
  private vehicle: RAPIER.DynamicRayCastVehicleController | null = null;
  readonly handles = new Set<number>();
  dynamic = false;
  controls: CartControls = PARKED;
  /** Seconds on its side, or under water. */
  stuck = 0;

  constructor(
    private readonly carts: CartWorld,
    x: number,
    y: number,
    z: number,
    rot: Quat,
  ) {
    this.build(false, x, y, z, rot, null);
  }

  build(dynamic: boolean, x: number, y: number, z: number, rot: Quat, velocity: Vec3 | null): void {
    const { world } = this.carts;
    this.dispose();
    this.dynamic = dynamic;
    const desc = dynamic ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.kinematicPositionBased();
    desc.setTranslation(x, y, z).setRotation(rot).setCanSleep(false).setCcdEnabled(dynamic).setAngularDamping(1.2).setLinearDamping(0.05);
    if (dynamic && velocity) desc.setLinvel(velocity.x, velocity.y, velocity.z);
    const body = (this.body = world.createRigidBody(desc));
    const g = groups(CARTS, WORLD | CARTS);
    const chassis = RAPIER.ColliderDesc.cuboid(CART.halfLength, CART.halfWidth, 0.2).setTranslation(0, 0, 0.05).setMass(MASS).setFriction(0.4).setRestitution(0.25).setCollisionGroups(g);
    if (dynamic) chassis.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(CRASH_FORCE);
    const roof = RAPIER.ColliderDesc.cuboid(0.95, 0.58, 0.04).setTranslation(-0.1, 0, 1.55).setMass(8).setFriction(0.3).setCollisionGroups(g);
    for (const c of [chassis, roof]) this.handles.add(world.createCollider(c, body).handle);

    if (!dynamic) return;
    const v = (this.vehicle = world.createVehicleController(body));
    v.indexUpAxis = 2;
    v.setIndexForwardAxis = 0;
    for (const [wx, wy] of [
      [0.82, 0.55],
      [0.82, -0.55],
      [-0.82, 0.55],
      [-0.82, -0.55],
    ]) {
      const i = v.numWheels();
      v.addWheel({ x: wx, y: wy, z: -0.05 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }, 0.28, CART.wheelRadius);
      v.setWheelSuspensionStiffness(i, 30);
      v.setWheelSuspensionCompression(i, 2.6);
      v.setWheelSuspensionRelaxation(i, 3.4);
      v.setWheelMaxSuspensionTravel(i, 0.2);
      v.setWheelMaxSuspensionForce(i, 40_000);
      v.setWheelFrictionSlip(i, 2.2);
      v.setWheelSideFrictionStiffness(i, 1);
    }
  }

  forwardSpeed(): number {
    const v = this.body.linvel();
    const f = rotate(this.body.rotation(), { x: 1, y: 0, z: 0 }, tmpA);
    return v.x * f.x + v.y * f.y + v.z * f.z;
  }

  /** Before a physics step: the driver's pedals and wheel. */
  beforeStep(step: number): void {
    const { vehicle, controls } = this;
    if (!vehicle) return;
    const speed = this.forwardSpeed();
    let engine = 0;
    let brake = 0;
    if (controls.brake) brake = BRAKE;
    else if (controls.throttle > 0.05) {
      if (speed < -0.6) brake = BRAKE;
      else if (speed < TOP_SPEED) engine = controls.throttle * ENGINE_FORCE;
    } else if (controls.throttle < -0.05) {
      if (speed > 0.6) brake = BRAKE;
      else if (speed > -REVERSE_SPEED) engine = controls.throttle * ENGINE_FORCE * 0.7;
    } else {
      brake = 1.2; // rolling to a stop
    }
    // + steers left as you see it: toward the world's -y from a cart facing +x, the opposite of Rapier's steering
    const steer = -controls.steer * STEER_ANGLE * clamp(1.3 - Math.abs(speed) / 14, 0.45, 1);
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      vehicle.setWheelSteering(i, front ? steer : 0);
      // Rapier's engine force pushes a wheel backward along the forward axis
      vehicle.setWheelEngineForce(i, front ? 0 : -engine);
      vehicle.setWheelBrake(i, brake);
    }
    vehicle.updateVehicle(step, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(CARTS, WORLD));
  }

  wheelsDown(): number {
    let n = 0;
    for (let i = 0; i < 4; i++) if (this.vehicle?.wheelIsInContact(i)) n++;
    return n;
  }

  dispose(): void {
    const { world } = this.carts;
    if (this.vehicle) world.removeVehicleController(this.vehicle);
    this.vehicle = null;
    this.handles.clear();
    if (this.body && world.getRigidBody(this.body.handle)) world.removeRigidBody(this.body);
  }
}

export class CartWorld {
  readonly world: RAPIER.World;
  private readonly clock = new FixedStep(1 / 60, 8);
  private readonly events: RAPIER.EventQueue;
  private readonly bodies = new Map<CartEntity, CartBody>();
  private readonly byHandle = new Map<number, CartBody>();
  private readonly strongest = new Map<CartBody, number>();
  /** Who each cart last ran over, and when, so one bump isn't a dozen knocks. */
  private readonly rammed = new Map<string, number>();

  constructor(
    readonly net: NetWorld,
    readonly course: Course,
  ) {
    this.world = new RAPIER.World({ x: 0, y: 0, z: -GRAVITY });
    this.world.timestep = this.clock.step;
    this.events = new RAPIER.EventQueue(true);
    const ground = (c: RAPIER.ColliderDesc) => this.world.createCollider(c.setCollisionGroups(groups(WORLD, CARTS)).setFriction(0.8));

    // the ground, triangulated the same way the scene and Course.heightAt split it
    const vertices = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) vertices.set([i * GRID, j * GRID, course.heights[j * N + i]], (j * N + i) * 3);
    const indices = new Uint32Array((N - 1) * (N - 1) * 6);
    let k = 0;
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i;
        indices.set([a, a + 1, a + N, a + 1, a + N + 1, a + N], k);
        k += 6;
      }
    }
    ground(RAPIER.ColliderDesc.trimesh(vertices, indices));
    const upright = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }; // cylinders stand along y; turn them onto z
    for (const t of course.trees) ground(RAPIER.ColliderDesc.cylinder(3, t.trunk).setTranslation(t.x, t.y, t.z + 2.5).setRotation(upright));
    const c = course.clubhouse;
    const cz = course.heightAt(c.x, c.y);
    ground(RAPIER.ColliderDesc.cuboid(c.d / 2, c.w / 2, 3).setTranslation(c.x, c.y, cz + 2.5).setRotation(yawQuat(c.heading)));
  }

  /** The body for a cart, if it has one yet. */
  private bodyOf(cart: CartEntity): CartBody | undefined {
    return this.bodies.get(cart);
  }

  /** What the driver of a cart this peer owns wants it to do this frame. */
  drive(cart: CartEntity, controls: CartControls): void {
    const b = this.bodyOf(cart);
    if (b) b.controls = controls;
  }

  /**
   * Keep a body for every cart: dynamic for the ones this peer owns, following the rest. Call before `step`,
   * after the network's been received.
   */
  sync(): void {
    for (const cart of this.net.all(Cart)) {
      let b = this.bodies.get(cart);
      const s = cart.mine ? cart.state : cart.render;
      if (!b) {
        b = new CartBody(this, s.x, s.y, s.z, quatOf(s, { x: 0, y: 0, z: 0, w: 1 }));
        this.bodies.set(cart, b);
      }
      if (cart.mine !== b.dynamic) {
        // taken over (or handed on): carry on from where it was last seen, at the speed it was going
        const rot = quatOf(s, { x: 0, y: 0, z: 0, w: 1 });
        const f = rotate(rot, { x: s.speed, y: 0, z: 0 }, tmpB);
        this.forget(b);
        b.build(cart.mine, s.x, s.y, s.z, rot, f);
        b.controls = PARKED;
      }
      for (const h of b.handles) this.byHandle.set(h, b);
      if (!cart.mine) {
        b.body.setNextKinematicTranslation({ x: s.x, y: s.y, z: s.z });
        b.body.setNextKinematicRotation(quatOf(s, q));
      }
    }
    for (const [cart, b] of this.bodies) {
      if (cart.alive) continue;
      this.forget(b);
      b.dispose();
      this.bodies.delete(cart);
    }
  }

  private forget(b: CartBody): void {
    for (const h of b.handles) this.byHandle.delete(h);
  }

  /** Run the carts forward. Returns the crashes this peer's carts had. */
  step(dt: number): Crash[] {
    this.strongest.clear();
    this.clock.run(dt, (step) => {
      for (const b of this.bodies.values()) if (b.dynamic) b.beforeStep(step);
      this.world.step(this.events);
      this.events.drainContactForceEvents((e) => {
        const a = this.byHandle.get(e.collider1());
        const b = this.byHandle.get(e.collider2());
        // only carts against carts or trees count: the ground's bumps are just driving
        const ground = !a || !b ? this.isGround(a ? e.collider2() : e.collider1()) : false;
        if (ground) return;
        const force = e.totalForceMagnitude();
        for (const body of [a, b]) if (body?.dynamic) this.strongest.set(body, Math.max(this.strongest.get(body) ?? 0, force));
      });
    });
    const crashes: Crash[] = [];
    for (const [cart, b] of this.bodies) {
      const force = this.strongest.get(b);
      if (!force || !cart.mine) continue;
      const t = b.body.translation();
      crashes.push({ cart, force, x: t.x, y: t.y, z: t.z });
    }
    return crashes;
  }

  /** Whether a collider is the ground itself (not a tree or the clubhouse). */
  private isGround(handle: number): boolean {
    return this.world.getCollider(handle)?.shape.type === RAPIER.ShapeType.TriMesh;
  }

  /**
   * After a step: write where this peer's carts got to, send the ones that sank or rolled over back to the barn
   * (or back onto their wheels, with someone in them), and knock down anyone a moving cart ran into.
   */
  afterStep(dt: number, now: number): void {
    for (const [cart, b] of this.bodies) {
      if (!cart.mine) continue;
      const s = cart.state;
      const t = b.body.translation();
      const r = b.body.rotation();
      s.x = t.x;
      s.y = t.y;
      s.z = t.z;
      writeQuat(s, r);
      s.speed = b.forwardSpeed();
      s.steer = b.controls.steer;

      const pond = this.course.pondAt(t.x, t.y);
      const sunk = !!pond && t.z < pond.z + 0.2;
      const flipped = uprightness(r) < 0.35;
      const lost = this.course.outOfBounds(t.x, t.y) || t.z < this.course.heightAt(t.x, t.y) - 3;
      b.stuck = flipped || sunk ? b.stuck + dt : 0;
      if (lost || (sunk && !s.driver) || (b.stuck > FLIPPED_SECONDS && (sunk || !s.driver))) {
        this.toBarn(cart);
      } else if (b.stuck > FLIPPED_SECONDS) {
        // on its side with someone in it: back onto its wheels where it is
        this.place(cart, t.x, t.y, this.course.heightAt(t.x, t.y) + 0.9, headingOf(r));
      }
      if (s.driver && Math.abs(s.speed) > RAM_SPEED) this.ram(cart, now);
    }
  }

  /** Whether a cart is under water, for its driver to climb out. */
  sunk(cart: CartEntity): boolean {
    const s = cart.state;
    const pond = this.course.pondAt(s.x, s.y);
    return !!pond && s.z < pond.z + 0.35;
  }

  /** Put a cart this peer owns somewhere, stopped and upright. */
  place(cart: CartEntity, x: number, y: number, z: number, heading: number): void {
    const b = this.bodies.get(cart);
    if (!b) return;
    b.body.setTranslation({ x, y, z }, true);
    b.body.setRotation(yawQuat(heading), true);
    b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.stuck = 0;
    Object.assign(cart.state, { x, y, z, speed: 0 });
    writeQuat(cart.state, yawQuat(heading));
  }

  /** Back to its bay at the barn. */
  toBarn(cart: CartEntity): void {
    const bay = this.course.barn.bays[cart.state.slot % this.course.barn.bays.length];
    this.place(cart, bay.x, bay.y, this.course.heightAt(bay.x, bay.y) + 0.8, bay.heading);
  }

  /** Knock down golfers a driven cart runs into. */
  private ram(cart: CartEntity, now: number): void {
    const s = cart.state;
    const rot = quatOf(s, q);
    const heading = headingOf(rot);
    const c = Math.cos(heading);
    const sn = Math.sin(heading);
    for (const g of this.net.query(s.x, s.y, 3.5, Golfer) as Iterable<GolferEntity>) {
      const gs = g.render;
      if (g.id === s.driver || gs.down || gs.cart) continue;
      const dx = g.x - s.x;
      const dy = g.y - s.y;
      const along = dx * c + dy * sn;
      const across = -dx * sn + dy * c;
      if (Math.abs(along) > CART.halfLength + 0.45 || Math.abs(across) > CART.halfWidth + 0.45) continue;
      if (Math.abs(g.render.z + this.course.heightAt(g.x, g.y) - s.z) > 1.6) continue;
      // only what's ahead of (or behind, reversing) the way it's going
      if (Math.sign(along) !== Math.sign(s.speed) && Math.abs(across) < CART.halfWidth) continue;
      const key = `${cart.id}:${g.id}`;
      if ((this.rammed.get(key) ?? 0) > now) continue;
      this.rammed.set(key, now + 1200);
      const push = Math.abs(s.speed) * 0.9;
      const side = Math.sign(across) || 1;
      const kx = c * s.speed * 0.8 - sn * side * push * 0.5;
      const ky = sn * s.speed * 0.8 + c * side * push * 0.5;
      this.net.command(Knock, { target: g.id, by: s.driver, kx, ky, cause: 1 });
      this.net.send(Noise, { kind: Whack.Bonk, x: g.x, y: g.y, z: s.z + 0.5, power: clamp(push / 10, 0.3, 1) }, { to: 'near', x: g.x, y: g.y, radius: 120 });
    }
    if (this.rammed.size > 200) for (const [k, until] of this.rammed) if (until < now) this.rammed.delete(k);
  }

  /** How many of a cart's wheels are on the ground (this peer's carts only). */
  wheelsDown(cart: CartEntity): number {
    return this.bodies.get(cart)?.wheelsDown() ?? 0;
  }

  dispose(): void {
    for (const b of this.bodies.values()) b.dispose();
    this.events.free();
    this.world.free();
  }
}

/** Where a cart's driver sits, in the world, from its rendered pose. */
export function seatOf(cart: CartEntity, out: Vec3, useState = false): Vec3 {
  const s = useState ? cart.state : cart.render;
  rotate(quatOf(s, q), DRIVER_SEAT, out);
  out.x += s.x;
  out.y += s.y;
  out.z += s.z;
  return out;
}

export function cartHeading(cart: CartEntity, useState = false): number {
  return headingOf(quatOf(useState ? cart.state : cart.render, q));
}

/** Push a golfer-sized circle at `p` out of every cart's box, as drawn. */
export function pushOutOfCarts(net: NetWorld, p: { x: number; y: number }, radius: number, feetZ: number, ignore = 0): void {
  for (const cart of net.query(p.x, p.y, 4, Cart) as Iterable<CartEntity>) {
    if (cart.id === ignore) continue;
    const s = cart.render;
    if (Math.abs(s.z - feetZ - 0.5) > 1.4) continue;
    const heading = headingOf(quatOf(s, q));
    const c = Math.cos(heading);
    const sn = Math.sin(heading);
    const dx = p.x - s.x;
    const dy = p.y - s.y;
    const along = dx * c + dy * sn;
    const across = -dx * sn + dy * c;
    const ha = CART.halfLength + radius;
    const hw = CART.halfWidth + radius;
    if (Math.abs(along) >= ha || Math.abs(across) >= hw) continue;
    let na = along;
    let nw = across;
    if (ha - Math.abs(along) < hw - Math.abs(across)) na = Math.sign(along || 1) * ha;
    else nw = Math.sign(across || 1) * hw;
    p.x = s.x + na * c - nw * sn;
    p.y = s.y + na * sn + nw * c;
  }
}

/**
 * Keeps the course's carts: whoever runs the match makes sure there's one for every golfer (up to `MAX_CARTS`),
 * parked at the barn, and if two peers made the same one at once, the newer goes. Carts are never taken away when
 * golfers leave; there just aren't new ones.
 */
export function keepCarts(net: NetWorld, carts: CartWorld, runsMatch: boolean): void {
  const bySlot = new Map<number, CartEntity>();
  for (const cart of net.all(Cart) as Iterable<CartEntity>) {
    const other = bySlot.get(cart.state.slot);
    if (!other || cart.id < other.id) bySlot.set(cart.state.slot, cart);
  }
  for (const cart of net.owned(Cart) as Iterable<CartEntity>) {
    const keep = bySlot.get(cart.state.slot);
    if (keep !== cart && !cart.state.driver) net.despawn(cart);
  }
  if (!runsMatch) return;
  const golfers = net.all(Golfer).size;
  const want = clamp(golfers, 1, MAX_CARTS);
  for (let slot = 0; slot < want; slot++) {
    if (bySlot.has(slot)) continue;
    const bay = carts.course.barn.bays[slot];
    const rot = yawQuat(bay.heading);
    const z = carts.course.heightAt(bay.x, bay.y) + 0.6;
    net.spawn(Cart, { x: bay.x, y: bay.y, z, qx: rot.x, qy: rot.y, qz: rot.z, qw: rot.w, slot });
  }
}
