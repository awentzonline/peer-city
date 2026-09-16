import type { Rig } from '../crossplay/rig';
import type { Builder } from './builder';
import { clamp, direction, type DerbyContext, type Vec3 } from './context';
import { rotate } from './physics';
import { quatOf } from './racer';

const CHASE_DISTANCE = 7;
const CHASE_HEIGHT = 2.6;

/**
 * The race camera on a screen: behind and above the racer, looking where it's going, eased so bumps don't
 * shake the view to bits; or the driver's eyes. Looking round swings it about the racer, springing back
 * behind when you stop.
 */
export class ChaseCamera {
  firstPerson = false;
  /** Looking round the racer: yaw and pitch offsets from behind it. */
  private orbit = 0;
  private orbitPitch = 0;
  private readonly cam = { x: 0, y: 0, z: 0, ready: false };
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: DerbyContext,
    private readonly sim: Builder,
    private readonly rig: Rig,
  ) {}

  /** Swing the view round: radians, + to the right and up. */
  look(right: number, up: number): void {
    this.orbit = clamp(this.orbit - right, -Math.PI, Math.PI);
    this.orbitPitch = clamp(this.orbitPitch + up, -0.5, 0.9);
  }

  /** Start again from behind the racer, without easing in from wherever the camera was. */
  reset(): void {
    this.orbit = 0;
    this.orbitPitch = 0.05;
    this.cam.ready = false;
  }

  update(dt: number): void {
    const { ctx, rig, sim } = this;
    const r = ctx.racer!.state;
    const q = quatOf(r);
    if (this.firstPerson) {
      const eye = sim.seatEye(this.tmp);
      const f = rotate(q, { x: Math.cos(this.orbit), y: Math.sin(this.orbit), z: 0 });
      const heading = Math.atan2(f.y, f.x);
      const pitch = Math.asin(clamp(f.z, -1, 1)) + this.orbitPitch * 0.6;
      rig.setDesktopView(eye.x, eye.y, eye.z, heading, pitch);
      ctx.sfx.setListener(eye, direction(heading, pitch, this.dir));
      return;
    }
    const f = rotate(q, { x: 1, y: 0, z: 0 });
    const heading = Math.atan2(f.y, f.x) + this.orbit;
    const back = Math.cos(this.orbitPitch) * CHASE_DISTANCE;
    const want = { x: r.x - Math.cos(heading) * back, y: r.y - Math.sin(heading) * back, z: r.z + CHASE_HEIGHT + Math.sin(this.orbitPitch) * CHASE_DISTANCE };
    const ground = ctx.course.heightAt(want.x, want.y) + 0.8;
    want.z = Math.max(want.z, ground);
    const cam = this.cam;
    const k = cam.ready ? 1 - Math.exp(-dt * 8) : 1;
    cam.x += (want.x - cam.x) * k;
    cam.y += (want.y - cam.y) * k;
    cam.z += (want.z - cam.z) * k;
    cam.ready = true;
    rig.setDesktopChase(cam, { x: r.x + Math.cos(heading) * 3, y: r.y + Math.sin(heading) * 3, z: r.z + 0.8 });
    // the look swings back behind the racer when you stop looking round
    this.orbit *= Math.exp(-dt * 1.5);
    this.orbitPitch += (0.05 - this.orbitPitch) * (1 - Math.exp(-dt * 1.5));
    ctx.sfx.setListener(cam, direction(heading, 0, this.dir));
  }
}
