import { NetWorld } from '@engine/index';
import { openLobby } from '../crossplay/lobby';
import { ONE_ZONE, connect } from '../crossplay/network';
import { initPhysics } from '../crossplay/rigid';
import { Course } from './course';
import { ACTIONS, ENTITIES } from './defs';
import { Game } from './Game';
import { Hud } from './hud';
import { Sfx } from './sfx';

const APP_ID = 'peer-golf.p2p-game-engine.v1';
const COURSE_SEED = 20260917;

const sfx = new Sfx();
// the cart physics is WebAssembly: start loading it now, and only let anyone in once it's ready
const physicsReady = initPhysics();

void openLobby({
  nameKey: 'peer-golf-name',
  namePrefix: 'Golfer',
  shard: 'club',
  audio: sfx,
  touch: true,
  landscape: true,
  headsetNote: 'Headset detected. You swing the clubs for real: clear plenty of space around you.',
  load: () => physicsReady,
}).then((launch) => {
  // The whole course is one neighbourhood: everyone should see everyone's ball and every cart.
  const world = new NetWorld({
    ...ONE_ZONE,
    transport: connect(APP_ID, launch.mode),
    worldId: `peer-golf/${launch.shard}`,
    entities: ENTITIES,
    actions: ACTIONS,
    interestRadius: 1000,
    spatialCellSize: 24,
    focusResendDistance: 4,
  });
  const course = new Course(COURSE_SEED);
  const game = new Game({ world, course, hud: new Hud(), sfx, launch });

  Object.assign(window as object, { peerGolf: { world, course, game } });
  window.addEventListener('pagehide', () => game.dispose());
});
