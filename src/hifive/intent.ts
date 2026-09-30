import { idleIntent, type AvatarIntent } from '../crossplay/intent';
import { Move } from './moves';

/** What a player of High Five with Friends wants this frame: an avatar's (walking about, tracked hands), plus the fives. */
export interface PalIntent extends AvatarIntent {
  /**
   * A move pressed this frame. At someone holding out a five it's a swing at it, timed on the ring; otherwise it
   * holds that move out, and pressing the one you're holding out again pulls it away.
   */
  move: Move;
  /** Pull the five you're holding out away, whatever it is. */
  yank: boolean;
  /** Slap the backside of whoever's in front of you, if you're behind them. */
  slap: boolean;
}

export function idlePalIntent(): PalIntent {
  return { ...idleIntent(), move: Move.None, yank: false, slap: false };
}

/** Clear this game's presses (the avatar's are `stillIntent`'s). */
export function stillPal(intent: PalIntent): PalIntent {
  intent.move = Move.None;
  intent.yank = intent.slap = false;
  return intent;
}
