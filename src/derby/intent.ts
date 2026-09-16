import { idleIntent, type AvatarIntent } from '../crossplay/intent';
import type { PartKind } from './parts';

/**
 * What a player of Peer Derby wants this frame: an avatar's (walking the garage, holding the part gun or the
 * wrench), plus driving and building. Driving fields only matter while seated in a racer.
 */
export interface DerbyIntent extends AvatarIntent {
  /** -1..1, + left. */
  steer: number;
  brake: boolean;
  /** Push off with your feet: only helps from slow. */
  push: boolean;
  /** Fire the rockets. */
  boost: boolean;
  /** Back to the last checkpoint. */
  reset: boolean;
  /** Give up the race and go back to the garage. Frontends ask first, so a slip doesn't throw a race away. */
  quit: boolean;
  /** Toggle being ready to race. */
  ready: boolean;
  /** Load a kind of part into the part gun, or step through them (-1, 0, 1). */
  part: PartKind | null;
  cyclePart: number;
}

export function idleDerbyIntent(): DerbyIntent {
  return { ...idleIntent(), steer: 0, brake: false, push: false, boost: false, reset: false, quit: false, ready: false, part: null, cyclePart: 0 };
}
