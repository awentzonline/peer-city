/**
 * Steering by tilting a phone like a wheel. The device's orientation says which way is up in the phone's own
 * axes; turned into the screen's axes (the screen may be rotated), the angle of that up away from the top of
 * the screen is how far the wheel is turned. That holds however far back the phone's tipped, short of flat,
 * and never jumps the way the raw angles do when a phone held upright in landscape passes through vertical.
 */
export interface TiltTuning {
  /** Radians of tilt for full lock. */
  full: number;
  /** Radians of tilt ignored around level. */
  deadzone: number;
}

export const TILT_TUNING: TiltTuning = { full: 0.55, deadzone: 0.05 };

/**
 * Which way is up, in the screen's axes (x right, y up the screen), for a device's orientation: `beta` and
 * `gamma` in degrees as `deviceorientation` gives them, and the screen's rotation (`screen.orientation.angle`).
 */
export function upOnScreen(beta: number, gamma: number, screenAngle: number): { x: number; y: number } {
  const b = (beta * Math.PI) / 180;
  const g = (gamma * Math.PI) / 180;
  const a = (screenAngle * Math.PI) / 180;
  // world up in device axes: the transpose of the spec's Z-X'-Y'' rotation, applied to (0, 0, 1)
  const ux = -Math.sin(g) * Math.cos(b);
  const uy = Math.sin(b);
  return { x: ux * Math.cos(a) - uy * Math.sin(a), y: ux * Math.sin(a) + uy * Math.cos(a) };
}

/**
 * -1..1, + left: turning the phone anticlockwise, as you'd turn a wheel left. A phone tipped past flat (the top
 * of the screen down) counts as if it weren't, rather than spinning the wheel half a turn.
 */
export function tiltSteer(beta: number, gamma: number, screenAngle: number, tuning: TiltTuning = TILT_TUNING): number {
  const up = upOnScreen(beta, gamma, screenAngle);
  if (Math.hypot(up.x, up.y) < 0.15) return 0; // lying flat: no way to tell
  const angle = Math.atan2(up.x, Math.abs(up.y));
  const live = Math.max(0, Math.abs(angle) - tuning.deadzone) / (tuning.full - tuning.deadzone);
  return Math.sign(angle) * Math.min(1, live);
}

/** Reads the device's orientation while it's on. Turn it on from a tap: iOS only asks for permission then. */
export class Tilt {
  on = false;
  /** Whether a reading has arrived since it was turned on: a desktop browser has the event but never fires it. */
  live = false;
  private beta = 0;
  private gamma = 0;

  constructor(readonly tuning: TiltTuning = TILT_TUNING) {}

  /** Start listening, asking for permission where it's needed. False if it isn't allowed or there's no sensor. */
  async enable(): Promise<boolean> {
    if (typeof DeviceOrientationEvent === 'undefined') return false;
    const ask = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission;
    if (ask) {
      try {
        if ((await ask()) !== 'granted') return false;
      } catch {
        return false;
      }
    }
    if (!this.on) window.addEventListener('deviceorientation', this.onOrientation);
    this.on = true;
    this.live = false;
    return true;
  }

  disable(): void {
    window.removeEventListener('deviceorientation', this.onOrientation);
    this.on = this.live = false;
  }

  /** -1..1, + left; 0 while off. */
  steer(): number {
    if (!this.on || !this.live) return 0;
    return tiltSteer(this.beta, this.gamma, screenAngle(), this.tuning);
  }

  private onOrientation = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null) return;
    this.beta = e.beta;
    this.gamma = e.gamma;
    this.live = true;
  };
}

function screenAngle(): number {
  if (typeof screen !== 'undefined' && screen.orientation) return screen.orientation.angle;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}
