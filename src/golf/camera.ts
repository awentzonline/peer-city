import type { Rig } from '../crossplay/rig';
import { Flight } from './ball';
import { cartHeading, seatOf } from './carts';
import { clamp, direction, type GolfContext, type Vec3 } from './context';
import type { Golfer } from './golfer';

/** What a screen's camera is showing. */
export type CameraMode = 'eyes' | 'address' | 'ball' | 'cart' | 'down';

/** How long the camera stays on your ball once it's stopped, ms. */
const LINGER_MS = 1300;

/**
 * The camera on a screen (desktop and touch). Walking about, it's your eyes, with a crosshair to club people.
 * Standing over your ball it goes behind the ball, looking down the line you're aiming along, with you in the
 * shot. Strike it and the camera chases the ball until it stops (or you walk off). Driving, it follows the cart
 * (or sits in your seat), and knocked flat you see yourself lying there. Moves between those are eased, except
 * back to your eyes.
 */
export class GolfCamera {
  mode: CameraMode = 'eyes';
  /** In a cart: from the driver's eyes rather than behind. */
  cartEyes = false;
  private following = false;
  private stoppedAt = 0;
  /** Looking round a cart or a flattened golfer: yaw and pitch offsets. */
  private orbit = 0;
  private orbitPitch = 0;
  private readonly cam = { x: 0, y: 0, z: 0, ready: false };
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: GolfContext,
    private readonly sim: Golfer,
    private readonly rig: Rig,
  ) {}

  /** Whether your own golfer's in the picture. */
  get showSelf(): boolean {
    return this.mode !== 'eyes';
  }

  /** Whether you're drawn sitting in your cart. */
  get showDriver(): boolean {
    return !(this.mode === 'cart' && this.cartEyes);
  }

  /** Swing the view round a cart or a flattened golfer: radians, + to the right and up. */
  look(right: number, up: number): void {
    this.orbit = clamp(this.orbit - right, -Math.PI, Math.PI);
    this.orbitPitch = clamp(this.orbitPitch + up, -0.4, 0.9);
  }

  /** You just struck your ball: watch it go. */
  followBall(): void {
    this.following = true;
    this.stoppedAt = 0;
  }

  /** You walked off: back to your eyes. */
  stopFollowing(): void {
    this.following = false;
  }

  update(dt: number): void {
    const { ctx, sim, rig } = this;
    const s = sim.me?.state;
    if (!s) return;
    const mode = this.pick();
    if (mode !== this.mode) {
      this.mode = mode;
      this.orbit = 0;
      this.orbitPitch = 0;
      if (mode === 'eyes') this.cam.ready = false;
    }

    if (mode === 'eyes' || (mode === 'cart' && this.cartEyes)) {
      const eye = sim.eyePosition(this.tmp);
      let heading = sim.heading;
      let pitch = sim.pitch;
      if (mode === 'cart' && sim.cart) {
        heading = cartHeading(sim.cart) + this.orbit;
        pitch = this.orbitPitch * 0.6;
        seatOf(sim.cart, eye);
        eye.z += 0.8;
      }
      rig.setDesktopView(eye.x, eye.y, eye.z, heading, pitch);
      ctx.sfx.setListener(eye, direction(heading, pitch, this.dir));
      this.cam.x = eye.x;
      this.cam.y = eye.y;
      this.cam.z = eye.z;
      this.cam.ready = true;
      return;
    }

    const want = this.tmp;
    const at = this.at;
    let rate = 6;
    const ball = sim.sim;
    switch (mode) {
      case 'address': {
        const a = sim.aimHeading;
        const ground = ctx.course.heightAt(ball.x, ball.y);
        want.x = ball.x - Math.cos(a) * 3.4;
        want.y = ball.y - Math.sin(a) * 3.4;
        want.z = ground + 1.75;
        const ahead = 25;
        at.x = ball.x + Math.cos(a) * ahead;
        at.y = ball.y + Math.sin(a) * ahead;
        at.z = ground + 0.9 + Math.tan(clamp(sim.pitch + 0.15, -0.5, 0.6)) * ahead;
        rate = 5;
        break;
      }
      case 'ball': {
        const speed = Math.hypot(ball.vx, ball.vy);
        const a = speed > 0.5 ? Math.atan2(ball.vy, ball.vx) : sim.aimHeading;
        const back = ball.flight === Flight.Air ? 9 : 5;
        want.x = ball.x - Math.cos(a) * back;
        want.y = ball.y - Math.sin(a) * back;
        want.z = ball.z + (ball.flight === Flight.Air ? 3.5 : 2.2);
        at.x = ball.x;
        at.y = ball.y;
        at.z = ball.z;
        rate = 3;
        break;
      }
      case 'down': {
        const a = s.yaw + Math.PI + this.orbit;
        const feet = sim.feetZ();
        want.x = s.x + Math.cos(a) * 3.2 * Math.cos(this.orbitPitch);
        want.y = s.y + Math.sin(a) * 3.2 * Math.cos(this.orbitPitch);
        want.z = feet + 2.6 + Math.sin(this.orbitPitch) * 3;
        at.x = s.x;
        at.y = s.y;
        at.z = feet + 0.3;
        break;
      }
      case 'cart': {
        const c = sim.cart!.render;
        const heading = cartHeading(sim.cart!) + this.orbit;
        const back = Math.cos(this.orbitPitch) * 6;
        want.x = c.x - Math.cos(heading) * back;
        want.y = c.y - Math.sin(heading) * back;
        want.z = c.z + 2.4 + Math.sin(this.orbitPitch) * 6;
        at.x = c.x + Math.cos(heading) * 3;
        at.y = c.y + Math.sin(heading) * 3;
        at.z = c.z + 0.9;
        rate = 8;
        // the view swings back behind the cart when you stop looking round
        this.orbit *= Math.exp(-dt * 1.5);
        this.orbitPitch += (0.05 - this.orbitPitch) * (1 - Math.exp(-dt * 1.5));
        break;
      }
    }
    want.z = Math.max(want.z, ctx.course.heightAt(want.x, want.y) + 0.6);
    const cam = this.cam;
    if (!cam.ready) sim.eyePosition(cam);
    const k = 1 - Math.exp(-dt * rate);
    cam.x += (want.x - cam.x) * k;
    cam.y += (want.y - cam.y) * k;
    cam.z += (want.z - cam.z) * k;
    cam.ready = true;
    rig.setDesktopChase(cam, at);
    const d = Math.hypot(at.x - cam.x, at.y - cam.y, at.z - cam.z) || 1;
    this.dir.x = (at.x - cam.x) / d;
    this.dir.y = (at.y - cam.y) / d;
    this.dir.z = (at.z - cam.z) / d;
    ctx.sfx.setListener(cam, this.dir);
  }

  private pick(): CameraMode {
    const { sim, ctx } = this;
    if (sim.seated && sim.cart) return 'cart';
    if (sim.down) return 'down';
    if (this.following) {
      const flying = sim.sim.flight === Flight.Air || sim.sim.flight === Flight.Rolling;
      if (flying) this.stoppedAt = 0;
      else if (!this.stoppedAt) this.stoppedAt = ctx.now;
      if (flying || ctx.now - this.stoppedAt < LINGER_MS) return 'ball';
      this.following = false;
    }
    if (sim.addressing) return 'address';
    return 'eyes';
  }
}
