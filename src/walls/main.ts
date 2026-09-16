import { NetWorld } from '@engine/index';
import { openLobby } from '../crossplay/lobby';
import { ONE_ZONE, connect } from '../crossplay/network';
import { ACTIONS, ENTITIES } from './defs';
import { Game } from './Game';
import { Hud } from './hud';
import { Sfx } from './sfx';
import { IndexedDbWalls } from './store';

const APP_ID = 'peer-walls.p2p-game-engine.v1';

const sfx = new Sfx();
const store = new IndexedDbWalls();

void openLobby({
  nameKey: 'peer-walls-name',
  namePrefix: 'Writer',
  shard: 'yard',
  audio: sfx,
  touch: true,
  landscape: true,
  headsetNote: 'Headset detected. Paint standing up, with room to reach.',
  noHeadsetNote: 'No VR headset detected. Open this page in a WebXR browser (e.g. Meta Quest Browser) to paint in VR.',
  // the walls this browser kept for the yard, which a lone painter starts from
  load: (launch) => store.load(launch.netLabel),
}).then((launch) => {
  // The yard is small, and everyone in it should see everyone else paint.
  const world = new NetWorld({
    ...ONE_ZONE,
    transport: connect(APP_ID, launch.mode),
    worldId: `peer-walls/${launch.shard}`,
    entities: ENTITIES,
    actions: ACTIONS,
    interestRadius: 400,
    spatialCellSize: 16,
  });
  const game = new Game({
    world,
    hud: new Hud(),
    sfx,
    launch,
    store,
    // tabs on one machine find each other at once; peers across the internet can take several seconds
    settleMs: launch.mode === 'local' ? 1500 : 6000,
  });

  Object.assign(window as object, { peerWalls: { world, game } });
  window.addEventListener('pagehide', () => game.dispose());
});
