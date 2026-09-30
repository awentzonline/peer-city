import { NetWorld } from '@engine/index';
import { openLobby } from '../crossplay/lobby';
import { ONE_ZONE, connect } from '../crossplay/network';
import { ACTIONS, ENTITIES } from './defs';
import { Game } from './Game';
import { Hud } from './hud';
import { Sfx } from './sfx';

const APP_ID = 'high-five-friends.p2p-game-engine.v1';

const sfx = new Sfx();

void openLobby({
  nameKey: 'high-five-name',
  namePrefix: 'Pal',
  shard: 'lockerroom',
  audio: sfx,
  touch: true,
  landscape: true,
  headsetNote: 'Headset detected. You give five with your own hands: clear some room to swing.',
}).then((launch) => {
  // the locker room and the field are one neighbourhood: everyone sees everyone's hands
  const world = new NetWorld({
    ...ONE_ZONE,
    transport: connect(APP_ID, launch.mode),
    worldId: `high-five/${launch.shard}`,
    entities: ENTITIES,
    actions: ACTIONS,
    interestRadius: 150,
    spatialCellSize: 12,
  });
  const game = new Game({ world, hud: new Hud(), sfx, launch });

  Object.assign(window as object, { highFive: { world, game } });
  window.addEventListener('pagehide', () => game.dispose());
});
