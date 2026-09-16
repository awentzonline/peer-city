import { NetWorld } from '@engine/index';
import { openLobby } from '../crossplay/lobby';
import { ONE_ZONE, connect } from '../crossplay/network';
import { Course } from './course';
import { ACTIONS, ENTITIES } from './defs';
import { Game } from './Game';
import { Hud } from './hud';
import { initPhysics } from './physics';
import { Sfx } from './sfx';

const APP_ID = 'peer-derby.p2p-game-engine.v1';
const COURSE_SEED = 20260916;

const sfx = new Sfx();
// the physics engine is WebAssembly: start loading it now, and only let anyone in once it's ready
const physicsReady = initPhysics();

void openLobby({
  nameKey: 'peer-derby-name',
  namePrefix: 'Racer',
  shard: 'hill',
  audio: sfx,
  touch: true,
  landscape: true,
  headsetNote: 'Headset detected. You build standing up and race sitting down: clear some space either way.',
  load: () => physicsReady,
}).then((launch) => {
  // The whole hill is one neighbourhood: everyone in a race should see everyone else's progress.
  const world = new NetWorld({
    ...ONE_ZONE,
    transport: connect(APP_ID, launch.mode),
    worldId: `peer-derby/${launch.shard}`,
    entities: ENTITIES,
    actions: ACTIONS,
    interestRadius: 1500,
    spatialCellSize: 32,
    focusResendDistance: 4,
  });
  const course = new Course(COURSE_SEED);
  const game = new Game({ world, course, hud: new Hud(), sfx, launch });

  Object.assign(window as object, { peerDerby: { world, course, game } });
  window.addEventListener('pagehide', () => game.dispose());
});
