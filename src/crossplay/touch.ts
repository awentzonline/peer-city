/**
 * Touch input, with no DOM in it: the overlay (touchControls.ts) turns pointer events into these calls,
 * so the gesture rules can be tested headless. Edge-triggered presses last until `endFrame()`, as on
 * keys and mouse buttons (input.ts), and a frontend reads everything it wants in one `read()`.
 *
 * Two zones, in the shape every touch shooter settles on: a thumb on the left walks (a floating stick,
 * wherever the thumb lands), a thumb on the right looks. A quick tap in the look zone fires, so a second
 * finger can shoot without leaving the aim, and buttons are named presses like any other control.
 */
export type TouchZone = 'stick' | 'look';

export interface TouchTuning {
  /** Full throw of the walk stick, in CSS pixels. */
  stickRadius: number;
  /** Fraction of the throw ignored around the origin. */
  deadzone: number;
  /** Fraction of the throw past which you run. */
  runAt: number;
  /** Radians of view per pixel dragged. */
  look: number;
  /** A look-zone touch shorter than this, that moved less than `tapSlop`, is a tap: it fires. */
  tapMs: number;
  tapSlop: number;
  /** Whether tapping the look zone fires at all. */
  tapToFire: boolean;
}

export const TOUCH_TUNING: TouchTuning = {
  stickRadius: 62,
  deadzone: 0.14,
  runAt: 0.82,
  look: 0.0042,
  tapMs: 220,
  tapSlop: 14,
  tapToFire: true,
};

/** The press that fires, whether it came from the fire button or a tap in the look zone. */
export const FIRE = 'fire';

interface Finger {
  zone: TouchZone;
  x: number;
  y: number;
  /** Where the finger went down, which for the stick drifts along when it's pushed past the throw. */
  ox: number;
  oy: number;
  at: number;
  /** Furthest the finger has been from where it went down. */
  slop: number;
  /** This finger drives its zone; later ones in the same zone only tap. */
  owner: boolean;
}

export class TouchInput {
  /** Walk, -1..1 relative to where the head faces. `y` is forward. */
  readonly stick = { x: 0, y: 0 };
  run = false;
  /** Where the overlay draws the stick: the origin the thumb set, and the knob's offset from it, in pixels. */
  readonly stickPose = { active: false, ox: 0, oy: 0, kx: 0, ky: 0 };

  private readonly fingers = new Map<number, Finger>();
  private readonly held = new Set<string>();
  private readonly edges = new Set<string>();
  private lookDx = 0;
  private lookDy = 0;

  constructor(readonly tuning: TouchTuning = TOUCH_TUNING) {}

  down(name: string): boolean {
    return this.held.has(name);
  }

  pressed(name: string): boolean {
    return this.edges.has(name);
  }

  /** View movement since the last call, in pixels: positive x is right, positive y is down the screen. */
  consumeLook(): [number, number] {
    const out: [number, number] = [this.lookDx, this.lookDy];
    this.lookDx = this.lookDy = 0;
    return out;
  }

  /** A button went down. */
  press(name: string): void {
    this.edges.add(name);
    this.held.add(name);
  }

  release(name: string): void {
    this.held.delete(name);
  }

  /** A button that's only ever a press, e.g. picking a tool. */
  tap(name: string): void {
    this.edges.add(name);
  }

  pointerDown(id: number, x: number, y: number, zone: TouchZone, now = performance.now()): void {
    // A phone can take a touch away without ever ending it (a system gesture, a call). Reusing its id must
    // let go of the old one, or a finger that owns a zone is lost and the stick stays where it was.
    if (this.fingers.has(id)) this.cancel(id);
    const owner = !this.owned(zone);
    this.fingers.set(id, { zone, x, y, ox: x, oy: y, at: now, slop: 0, owner });
    if (zone === 'stick' && owner) {
      this.stickPose.active = true;
      this.stickPose.ox = x;
      this.stickPose.oy = y;
      this.stickPose.kx = this.stickPose.ky = 0;
    }
  }

  pointerMove(id: number, x: number, y: number): void {
    const f = this.fingers.get(id);
    if (!f) return;
    if (f.owner && f.zone === 'look') {
      this.lookDx += x - f.x;
      this.lookDy += y - f.y;
    }
    f.x = x;
    f.y = y;
    f.slop = Math.max(f.slop, Math.hypot(x - f.ox, y - f.oy));
    if (f.owner && f.zone === 'stick') this.moveStick(f);
  }

  pointerUp(id: number, now = performance.now()): void {
    const f = this.fingers.get(id);
    if (!f) return;
    this.fingers.delete(id);
    const { tuning } = this;
    if (f.zone === 'look' && tuning.tapToFire && now - f.at <= tuning.tapMs && f.slop <= tuning.tapSlop) this.tap(FIRE);
    if (f.zone === 'stick' && f.owner) this.stopStick();
    // Another finger already in the zone takes it over, so lifting the first doesn't drop the walk.
    if (f.owner) this.handOver(f.zone);
  }

  /** A pointer was cancelled, or the page lost the touches (backgrounded, a system gesture). */
  cancel(id: number): void {
    const f = this.fingers.get(id);
    if (!f) return;
    this.fingers.delete(id);
    if (f.zone === 'stick' && f.owner) this.stopStick();
    if (f.owner) this.handOver(f.zone);
  }

  clear(): void {
    this.fingers.clear();
    this.held.clear();
    this.stopStick();
  }

  endFrame(): void {
    this.edges.clear();
  }

  private owned(zone: TouchZone): boolean {
    for (const f of this.fingers.values()) if (f.zone === zone && f.owner) return true;
    return false;
  }

  /** Give a zone to the oldest finger still in it. */
  private handOver(zone: TouchZone): void {
    let next: Finger | null = null;
    for (const f of this.fingers.values()) if (f.zone === zone && (!next || f.at < next.at)) next = f;
    if (!next) return;
    next.owner = true;
    // Look carries on from where that finger is, rather than jumping the view by where it went down.
    if (zone === 'stick') {
      next.ox = next.x;
      next.oy = next.y;
      this.stickPose.active = true;
      this.stickPose.ox = next.x;
      this.stickPose.oy = next.y;
      this.moveStick(next);
    }
  }

  private moveStick(f: Finger): void {
    const { stickRadius, deadzone, runAt } = this.tuning;
    let dx = f.x - f.ox;
    let dy = f.y - f.oy;
    const r = Math.hypot(dx, dy);
    // Past full throw the origin follows the thumb, so the stick stays under it and can be eased back.
    if (r > stickRadius) {
      const back = (r - stickRadius) / r;
      f.ox += dx * back;
      f.oy += dy * back;
      dx *= stickRadius / r;
      dy *= stickRadius / r;
    }
    const mag = Math.min(1, Math.hypot(dx, dy) / stickRadius);
    const live = mag <= deadzone ? 0 : (mag - deadzone) / (1 - deadzone);
    const scale = mag > 0 ? live / mag : 0;
    this.stick.x = (dx / stickRadius) * scale;
    this.stick.y = (-dy / stickRadius) * scale;
    this.run = mag >= runAt;
    Object.assign(this.stickPose, { active: true, ox: f.ox, oy: f.oy, kx: dx, ky: dy });
  }

  private stopStick(): void {
    this.stick.x = this.stick.y = 0;
    this.run = false;
    this.stickPose.active = false;
    this.stickPose.kx = this.stickPose.ky = 0;
  }
}

/** Whether this page is most likely being played with fingers: a coarse primary pointer that can touch. */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse && (navigator.maxTouchPoints ?? 0) > 0;
}
