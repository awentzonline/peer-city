import type { NetEntity, NetWorld, StateOf } from '@engine/index';
import type { Settings } from '../crossplay/settings';
import type { Deck } from './deck';
import type { Crew, Fault, Officer, Raider, Relic, Sentinel, Ship } from './defs';
import type { Torpedoes } from './flights';
import type { Hud } from './hud';
import type { Sector } from './sector';
import type { Sfx } from './sfx';

export { TAU, angleDiff, clamp, direction } from '../crossplay/math';
export type { Vec3 } from '../crossplay/math';

export type ShipEntity = NetEntity<StateOf<typeof Ship>>;
export type ShipState = StateOf<typeof Ship>;
export type OfficerEntity = NetEntity<StateOf<typeof Officer>>;
export type RaiderEntity = NetEntity<StateOf<typeof Raider>>;
export type CrewEntity = NetEntity<StateOf<typeof Crew>>;
export type FaultEntity = NetEntity<StateOf<typeof Fault>>;
export type SentinelEntity = NetEntity<StateOf<typeof Sentinel>>;
export type RelicEntity = NetEntity<StateOf<typeof Relic>>;

/** What shows and sounds the rules' events, on a peer that draws. Tests leave these as no-ops. */
export interface StarshipFx {
  /** A torpedo flew; the space views draw them. */
  torpedo(id: number, x: number, y: number, heading: number, hostile: boolean): void;
  /** One reached its end. */
  torpedoGone(id: number, hit: boolean): void;
}

/** Shared services for Peer Starship's systems. No device in here (see crossplay/role.ts). */
export interface StarshipContext {
  world: NetWorld;
  sector: Sector;
  deck: Deck;
  sfx: Sfx;
  hud: Hud;
  settings: Settings;
  fx: StarshipFx;
  torpedoes: Torpedoes;
  /** The ship, once this peer knows of it. */
  ship(): ShipEntity | null;
  /** The local player's crew member, if they're playing crew. */
  me: CrewEntity | null;
  /** The local player at a station or the viewscreen, if they're one. */
  officer: OfficerEntity | null;
  playerName: string;
  /** performance.now() of the current frame. */
  now: number;
}
