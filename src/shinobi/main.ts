import { NetWorld } from '@engine/index';
import { openLobby } from '../crossplay/lobby';
import { ONE_ZONE, connect } from '../crossplay/network';
import { Castle } from './castle';
import { ACTIONS, ENTITIES } from './defs';
import { Game } from './Game';
import { Hud } from './hud';
import { Sfx } from './sfx';

const APP_ID = 'peer-shinobi.p2p-game-engine.v1';
const CASTLE_SEED = 1603;

const sfx = new Sfx();

void openLobby({
  nameKey: 'peer-shinobi-name',
  namePrefix: 'Shadow',
  shard: 'castle',
  audio: sfx,
  touch: true,
  landscape: true,
  roles: ['shinobi', 'captain'],
  headsetNote: 'Headset detected. Shinobi climb the walls with their own hands; the captain stands over the map. Clear some room around you.',
}).then((launch) => {
  // the whole castle is one neighbourhood: the captain watches all of it
  const world = new NetWorld({
    ...ONE_ZONE,
    transport: connect(APP_ID, launch.mode),
    worldId: `peer-shinobi/${launch.shard}`,
    entities: ENTITIES,
    actions: ACTIONS,
    interestRadius: 200,
    spatialCellSize: 16,
    focusResendDistance: 3,
  });
  const castle = new Castle(CASTLE_SEED);
  const game = new Game({ world, castle, hud: new Hud(), sfx, launch });

  Object.assign(window as object, { peerShinobi: { world, castle, game } });
  window.addEventListener('pagehide', () => game.dispose());
});
