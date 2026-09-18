import { NetWorld } from '@engine/index';
import { openLobby } from '../crossplay/lobby';
import { ONE_ZONE, connect } from '../crossplay/network';
import { initPhysics } from '../crossplay/rigid';
import { ACTIONS, ENTITIES } from './defs';
import { Game } from './Game';
import { Hud } from './hud';
import { SewerMap } from './sewer';
import { Sfx } from './sfx';

const APP_ID = 'sewer-lordz.p2p-game-engine.v1';
const SEWER_SEED = 20260917;

const sfx = new Sfx();
// the ragdolls are WebAssembly: start loading it now, and only let anyone down the ladder once it's ready
const physicsReady = initPhysics();

void openLobby({
  nameKey: 'sewer-lordz-name',
  namePrefix: 'Lord',
  shard: 'drains',
  audio: sfx,
  touch: true,
  landscape: true,
  headsetNote: 'Headset detected. You punch goblins with your own fists and pump the hose with your own arms: clear some room around you.',
  load: () => physicsReady,
}).then((launch) => {
  // the whole sewer is one neighbourhood: everyone sees every goblin, and hears everyone down here
  const world = new NetWorld({
    ...ONE_ZONE,
    transport: connect(APP_ID, launch.mode),
    worldId: `sewer-lordz/${launch.shard}`,
    entities: ENTITIES,
    actions: ACTIONS,
    interestRadius: 200,
    spatialCellSize: 12,
    focusResendDistance: 3,
  });
  const map = new SewerMap(SEWER_SEED);
  const game = new Game({ world, map, hud: new Hud(), sfx, launch });

  Object.assign(window as object, { sewerLordz: { world, map, game } });
  window.addEventListener('pagehide', () => game.dispose());
});
