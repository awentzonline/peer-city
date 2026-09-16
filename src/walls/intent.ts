import { idleIntent, type AvatarIntent } from '../crossplay/intent';

/** What a player of Peer Walls wants this frame: an avatar's (walking the yard, holding paint), plus the paint. */
export interface WallsIntent extends AvatarIntent {
  /** Load a colour, by its place on the rack (yard.ts `PALETTE`), or step through them (-1, 0, 1). */
  color: number | null;
  cycleColor: number;
  /** Step through sizes: the spray can's caps, the marker's nibs, the roller's widths (-1, 0, 1). */
  cycleSize: number;
}

export function idleWallsIntent(): WallsIntent {
  return { ...idleIntent(), color: null, cycleColor: 0, cycleSize: 0 };
}
