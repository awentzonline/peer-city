import { idleIntent, stillIntent, type AvatarIntent } from '../crossplay/intent';
import { Act, Station } from './defs';

/** An order for the ship, from a station's controls. See `Act` for what `a`, `b` and `ref` mean to each. */
export interface ConsoleAct {
  act: Act;
  a: number;
  b: number;
  ref: number;
}

export function act(act: Act, a = 0, b = 0, ref = 0): ConsoleAct {
  return { act, a, b, ref };
}

/**
 * What an officer wants this frame: which station they're at (the viewscreen counts as one), and the orders they gave
 * from it. Every device's controls come down to this, so the rules never see a touch or a click.
 */
export interface OfficerIntent {
  station: Station;
  acts: ConsoleAct[];
}

export function idleOfficerIntent(station: Station): OfficerIntent {
  return { station, acts: [] };
}

/**
 * What a crew member wants: an avatar's, plus a press to act on what's in reach (take or load a torpedo, pick up or set
 * down a relic) and to sit down at a console or get up from one, and the orders given from it while seated.
 */
export interface CrewIntent extends AvatarIntent {
  /** Pressed this frame: take or load a torpedo, pick up or put down a relic. */
  use: boolean;
  /** Pressed: sit at the console in reach, or get up. */
  sit: boolean;
  /** Orders from the console you're sitting at. */
  acts: ConsoleAct[];
}

export function idleCrewIntent(): CrewIntent {
  return { ...idleIntent(), use: false, sit: false, acts: [] };
}

export function stillCrew(intent: CrewIntent): CrewIntent {
  stillIntent(intent);
  intent.use = intent.sit = false;
  intent.acts.length = 0;
  return intent;
}
