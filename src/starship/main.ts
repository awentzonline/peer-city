import { NetWorld } from '@engine/index';
import { openLobby } from '../crossplay/lobby';
import { ONE_ZONE, connect } from '../crossplay/network';
import { isTouchDevice } from '../crossplay/touch';
import { Deck } from './deck';
import { ACTIONS, ENTITIES } from './defs';
import { Game } from './Game';
import { Hud } from './hud';
import { FOCUS } from './officer';
import { Sector } from './sector';
import { Sfx } from './sfx';

const APP_ID = 'peer-starship.p2p-game-engine.v1';
const SECTOR_SEED = 2261;

const sfx = new Sfx();

void openLobby({
  nameKey: 'peer-starship-name',
  namePrefix: 'Ensign',
  shard: 'sector',
  audio: sfx,
  touch: true,
  // phones make the best stations; a computer's the best way onto the decks
  roles: isTouchDevice() ? ['station', 'crew', 'viewer'] : ['crew', 'station', 'viewer'],
  headsetNote: 'Headset detected. Crew walk the decks with their own hands: fix the ship, load torpedoes, beam down to planets. Clear some room around you.',
}).then((launch) => {
  // the whole sector and every deck are one neighbourhood: the bridge needs to see all of it
  const world = new NetWorld({
    ...ONE_ZONE,
    zoneSize: 65536,
    cellSize: 65536,
    transport: connect(APP_ID, launch.mode),
    worldId: `peer-starship/${launch.shard}`,
    entities: ENTITIES,
    actions: ACTIONS,
    interestRadius: FOCUS.radius,
    spatialCellSize: 16,
    focusResendDistance: 50,
    bytesPerTick: 6000,
  });
  const game = new Game({ world, sector: new Sector(SECTOR_SEED), deck: new Deck(SECTOR_SEED), hud: new Hud(), sfx, launch });

  Object.assign(window as object, { peerStarship: { world, game } });
  window.addEventListener('pagehide', () => game.dispose());
});
