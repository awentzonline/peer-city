import { NetWorld } from '@engine/index';
import { openLobby } from '../crossplay/lobby';
import { ONE_ZONE, connect } from '../crossplay/network';
import { ACTIONS, ENTITIES } from './defs';
import { Game } from './Game';
import { Hud } from './hud';
import { Manor } from './manor';
import { Sfx } from './sfx';

const APP_ID = 'peer-haunt.p2p-game-engine.v1';
const MANOR_SEED = 20261031;

const sfx = new Sfx();

void openLobby({
  nameKey: 'peer-haunt-name',
  namePrefix: 'Guest',
  shard: 'manor',
  audio: sfx,
  touch: true,
  landscape: true,
  roles: ['survivor', 'haunt'],
  headsetNote: 'Headset detected. Survivors walk the house for real; the Haunt looms over it. Clear some room around you.',
}).then((launch) => {
  // the whole estate is one neighbourhood: the Haunt watches all of it, and survivors hear each other across it
  const world = new NetWorld({
    ...ONE_ZONE,
    transport: connect(APP_ID, launch.mode),
    worldId: `peer-haunt/${launch.shard}`,
    entities: ENTITIES,
    actions: ACTIONS,
    interestRadius: 200,
    spatialCellSize: 16,
    focusResendDistance: 3,
  });
  const manor = new Manor(MANOR_SEED);
  const game = new Game({ world, manor, hud: new Hud(), sfx, launch });

  Object.assign(window as object, { peerHaunt: { world, manor, game } });
  window.addEventListener('pagehide', () => game.dispose());
});
