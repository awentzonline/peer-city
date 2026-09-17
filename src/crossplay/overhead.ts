import { clamp, type Vec3 } from './math';
import type { Rig } from './rig';

/** How far an overhead view can look and move. Meters, world axes. */
export interface OverheadLimits {
  /** The ground the focus is kept over. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Closest and furthest the camera can be from the focus. */
  near: number;
  far: number;
  /** Radians from straight down: how steeply it looks, closest in and furthest out (it flattens as it closes in). */
  tiltNear: number;
  tiltFar: number;
}

/** A screen: its size in CSS pixels, and the camera's vertical field of view in degrees. */
export interface Viewport {
  width: number;
  height: number;
  fov: number;
}

/**
 * A camera looking down on the world at an angle, for a role that oversees it from above (an RTS player, a dungeon
 * master): a focus on the ground, a distance, a heading "up" the screen is, and a tilt that flattens as it zooms in.
 * It has no DOM or three.js in it: it works out where the eye is, which ground a screen point is over, and how to pan,
 * zoom and turn so the ground under a finger or the mouse stays under it. `apply` puts a rig's camera there.
 */
export class OverheadView {
  /** The ground point in the middle of the view. */
  x: number;
  y: number;
  /** The ground's height there. */
  z = 0;
  /** Meters from the focus to the eye. */
  distance: number;
  /** The heading the top of the screen faces. */
  heading: number;

  constructor(
    readonly limits: OverheadLimits,
    at: { x: number; y: number; distance?: number; heading?: number },
  ) {
    this.x = at.x;
    this.y = at.y;
    this.distance = clamp(at.distance ?? (limits.near + limits.far) / 2, limits.near, limits.far);
    this.heading = at.heading ?? Math.PI / 2;
  }

  /** Radians from straight down, for how far out the camera is. */
  get tilt(): number {
    const { near, far, tiltNear, tiltFar } = this.limits;
    const t = far > near ? (this.distance - near) / (far - near) : 0;
    return tiltNear + (tiltFar - tiltNear) * t;
  }

  /** Where the eye is. */
  eye(out: Vec3): Vec3 {
    const tilt = this.tilt;
    const back = Math.sin(tilt) * this.distance;
    out.x = this.x - Math.cos(this.heading) * back;
    out.y = this.y - Math.sin(this.heading) * back;
    out.z = this.z + Math.cos(tilt) * this.distance;
    return out;
  }

  /** The unit direction from the eye through a screen point. */
  ray(sx: number, sy: number, view: Viewport, out: Vec3): Vec3 {
    const tilt = this.tilt;
    const ch = Math.cos(this.heading);
    const sh = Math.sin(this.heading);
    // forward, right and up, in world axes (which are left-handed: right of a heading h is (-sin h, cos h))
    const fx = ch * Math.sin(tilt);
    const fy = sh * Math.sin(tilt);
    const fz = -Math.cos(tilt);
    const rx = -sh;
    const ry = ch;
    const ux = ch * Math.cos(tilt);
    const uy = sh * Math.cos(tilt);
    const uz = Math.sin(tilt);
    const t = Math.tan((view.fov * Math.PI) / 360);
    const nx = ((sx / view.width) * 2 - 1) * t * (view.width / view.height);
    const ny = (1 - (sy / view.height) * 2) * t;
    const dx = fx + rx * nx + ux * ny;
    const dy = fy + ry * nx + uy * ny;
    const dz = fz + uz * ny;
    const len = Math.hypot(dx, dy, dz);
    out.x = dx / len;
    out.y = dy / len;
    out.z = dz / len;
    return out;
  }

  /** The ground (at the focus's height) under a screen point, or null above the horizon. */
  groundAt(sx: number, sy: number, view: Viewport, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 | null {
    const e = this.eye(eyeTmp);
    const d = this.ray(sx, sy, view, rayTmp);
    if (d.z > -0.02) return null;
    const k = (this.z - e.z) / d.z;
    out.x = e.x + d.x * k;
    out.y = e.y + d.y * k;
    out.z = this.z;
    return out;
  }

  /** Where a world point is on the screen, in CSS pixels, or null behind the camera. */
  toScreen(p: Vec3, view: Viewport, out: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } | null {
    const e = this.eye(eyeTmp);
    const tilt = this.tilt;
    const ch = Math.cos(this.heading);
    const sh = Math.sin(this.heading);
    const px = p.x - e.x;
    const py = p.y - e.y;
    const pz = p.z - e.z;
    const f = px * ch * Math.sin(tilt) + py * sh * Math.sin(tilt) - pz * Math.cos(tilt);
    if (f <= 0.01) return null;
    const r = -px * sh + py * ch;
    const u = px * ch * Math.cos(tilt) + py * sh * Math.cos(tilt) + pz * Math.sin(tilt);
    const t = Math.tan((view.fov * Math.PI) / 360);
    out.x = ((r / f / (t * (view.width / view.height)) + 1) / 2) * view.width;
    out.y = ((1 - u / f / t) / 2) * view.height;
    return out;
  }

  /** Slide the view so the ground that was under one screen point is under another: a drag that holds the ground. */
  drag(fromX: number, fromY: number, toX: number, toY: number, view: Viewport): void {
    const a = this.groundAt(fromX, fromY, view, dragA);
    const b = this.groundAt(toX, toY, view, dragB);
    if (!a || !b) return;
    this.x += a.x - b.x;
    this.y += a.y - b.y;
    this.keepIn();
  }

  /** Move the focus by meters along the screen: `right` across it, `up` the way its top faces. */
  pan(right: number, up: number): void {
    const ch = Math.cos(this.heading);
    const sh = Math.sin(this.heading);
    this.x += ch * up - sh * right;
    this.y += sh * up + ch * right;
    this.keepIn();
  }

  /** Move closer (`factor` < 1) or further, keeping the ground under a screen point where it is. */
  zoom(factor: number, sx: number, sy: number, view: Viewport): void {
    const before = this.groundAt(sx, sy, view, dragA);
    this.distance = clamp(this.distance * factor, this.limits.near, this.limits.far);
    const after = this.groundAt(sx, sy, view, dragB);
    if (before && after) {
      this.x += before.x - after.x;
      this.y += before.y - after.y;
    }
    this.keepIn();
  }

  /** Turn the view by `radians` (+ turns the world clockwise on screen) about the ground under a screen point. */
  turn(radians: number, sx: number, sy: number, view: Viewport): void {
    const before = this.groundAt(sx, sy, view, dragA);
    this.heading += radians;
    const after = this.groundAt(sx, sy, view, dragB);
    if (before && after) {
      this.x += before.x - after.x;
      this.y += before.y - after.y;
    }
    this.keepIn();
  }

  /** Put the rig's camera at the eye, looking at the focus. */
  apply(rig: Rig): void {
    this.eye(eyeOut);
    rig.setDesktopChase(eyeOut, { x: this.x, y: this.y, z: this.z });
  }

  private keepIn(): void {
    const { minX, minY, maxX, maxY } = this.limits;
    this.x = clamp(this.x, minX, maxX);
    this.y = clamp(this.y, minY, maxY);
  }
}

const eyeTmp: Vec3 = { x: 0, y: 0, z: 0 };
const eyeOut: Vec3 = { x: 0, y: 0, z: 0 };
const rayTmp: Vec3 = { x: 0, y: 0, z: 0 };
const dragA: Vec3 = { x: 0, y: 0, z: 0 };
const dragB: Vec3 = { x: 0, y: 0, z: 0 };

/** The page's viewport, for a camera with this field of view. */
export function pageViewport(fov: number): Viewport {
  return { width: window.innerWidth, height: window.innerHeight, fov };
}
