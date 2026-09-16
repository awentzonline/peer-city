import { defineAction, defineEntity, t } from '@engine/index';
import { BODY_FIELDS } from '../crossplay/avatar';
import { MAX_POINTS, POINT_BYTES } from './wall';

/**
 * Everything in Peer Walls that goes over the network. Meters, world axes (x, y on the ground, z up).
 *
 * The walls aren't entities. Paint is a stream of `Paint` strokes sent to everyone, which every peer paints
 * onto its own copy of the walls (wall.ts). Someone arriving gets a copy of the walls as they are from a painter
 * who has them (`WallAsk` → `WallTile`s → `WallDone`), then paints the strokes that copy hadn't seen yet
 * (sync.ts).
 */

export const Painter = defineEntity({
  name: 'painter',
  fields: {
    ...BODY_FIELDS,
    name: t.string(16),
    skin: t.uint(8),
    color: t.uint(32), // 0xRRGGBB loaded in their tools
    cap: t.uint(8), // the spray can's nozzle (kit.ts)
    spraying: t.bool(), // paint is coming out of the can in their right hand: others see a mist and hear the hiss
    lspraying: t.bool(), // ...their left hand
    // Which copy of the walls they have (sync.ts): made up when a wall is first painted on alone, and
    // inherited by everyone who takes a copy of it. 0 while they don't have one yet.
    wall: t.uint(32),
    born: t.uint(32), // wall-clock seconds that copy was first made: when two meet, the older one wins
  },
  priority: 3,
  snapDistance: 8,
});

/** Paint along a stroke. See `Surface.stroke`. */
export const Paint = defineAction('paint', {
  surface: t.uint(8),
  brush: t.uint(8),
  color: t.uint(32),
  /** Counts up per painter, so a copy of the walls can say which of their strokes it already has. */
  seq: t.uint(32),
  /** Carries on from the painter's last batch, which already stamped the first point. */
  cont: t.bool(),
  pts: t.bytes(MAX_POINTS * POINT_BYTES),
});

/** "Send me your walls." To one painter who has them. */
export const WallAsk = defineAction('wallAsk', { req: t.uint(32) });

/** One painted tile of a copy of the walls: its RGB pixels, deflated. */
export const WallTile = defineAction('wallTile', {
  req: t.uint(32),
  surface: t.uint(8),
  tile: t.uint(16),
  data: t.bytes(64000),
});

/** The end of a copy: which walls it is, and the last stroke of each painter's it includes. */
export const WallDone = defineAction('wallDone', {
  req: t.uint(32),
  wall: t.uint(32),
  born: t.uint(32),
  /** `encodeSeen`. */
  seen: t.bytes(16000),
  tiles: t.uint(16),
});

export const ENTITIES = [Painter];
export const ACTIONS = [Paint, WallAsk, WallTile, WallDone];
