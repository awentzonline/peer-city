import { idleIntent, stillIntent, type AvatarIntent } from '../crossplay/intent';

/**
 * What a Lord wants this frame: an avatar's, plus the sewer's own. On a crosshair the trigger punches with bare fists
 * (held, it winds up a haymaker), sprays the hose or sweeps the detector, and throws a goblin you're holding.
 * `interact`, held, does whatever's at hand: hauls someone up, climbs the ladder, turns a valve or digs. Tracked hands
 * do all that with the hands themselves: swing to punch, grip to grab, pump the hose with the other hand.
 */
export interface LordIntent extends AvatarIntent {
  /** Crosshair: put the tools away and use your fists. */
  fists: boolean;
  /**
   * Crosshair: where the hose's pump handle is, 0 pulled back to 1 pushed home (a key held down pulls it), or null
   * for nobody on it. Tracked hands pump with the other hand on the slide instead.
   */
  pump: number | null;
  /** Crosshair: grab the goblin in front of you, or let go of the one you've got. Pressed this frame. */
  grab: boolean;
  /** Crosshair, holding a goblin: pull it apart. Held. */
  tear: boolean;
}

export function idleLordIntent(): LordIntent {
  return { ...idleIntent(), fists: false, pump: null, grab: false, tear: false };
}

/** Clear what a frontend sets afresh every frame, keeping the device's poses. */
export function stillLord(intent: LordIntent): LordIntent {
  stillIntent(intent);
  intent.fists = intent.grab = intent.tear = false;
  intent.pump = null;
  return intent;
}
