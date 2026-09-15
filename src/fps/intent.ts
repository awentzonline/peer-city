import { idleIntent as idleBody, type AvatarIntent as BodyIntent } from '../crossplay/intent';

export { handIntent } from '../crossplay/intent';
export type { HandIntent, TrackedHead } from '../crossplay/intent';

/**
 * What the player of a Peer City avatar wants this frame: the body's intent (see crossplay/intent.ts), plus
 * driving. In a car `strafe` and `forward` steer and accelerate, and `interact` gets in and out.
 */
export interface AvatarIntent extends BodyIntent {
  /** Handbrake. */
  brake: boolean;
  horn: boolean;
}

/** Nothing pressed, with a virtual head and a crosshair. Frontends keep one and overwrite it every frame. */
export function idleIntent(): AvatarIntent {
  return { ...idleBody(), brake: false, horn: false };
}
