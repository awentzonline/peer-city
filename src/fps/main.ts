import { NetWorld } from '@engine/index';
import { loadAssets } from '../crossplay/assets';
import { openLobby } from '../crossplay/lobby';
import { OPEN_WORLD, connect } from '../crossplay/network';
import { ASSETS } from './assets';
import { City } from './city';
import { ACTIONS, ENTITIES } from './defs';
import { Game } from './Game';
import { Hud } from './hud';
import { Sfx } from './sfx';

const APP_ID = 'peer-city-3d.p2p-game-engine.v1';
const CITY_SEED = 20260914;

const sfx = new Sfx();
// Models download while the lobby is up; the game starts once they're in.
const assetsReady = loadAssets(ASSETS);

void openLobby({
  nameKey: 'peer-city-name',
  namePrefix: 'Player',
  shard: 'downtown',
  audio: sfx,
  touch: true,
  headsetNote: 'Headset detected. Clear some floor space: room-scale walking is supported.',
  load: () => assetsReady,
}).then((launch) => {
  const world = new NetWorld({
    ...OPEN_WORLD,
    transport: connect(APP_ID, launch.mode),
    worldId: `peer-city-3d/${launch.shard}`,
    entities: ENTITIES,
    actions: ACTIONS,
    interestRadius: 170,
  });
  const city = new City(CITY_SEED);
  const game = new Game({ world, city, hud: new Hud(city), sfx, launch });

  // handy for debugging from the console
  Object.assign(window as object, { peerCity3d: { world, city, game } });
  window.addEventListener('pagehide', () => game.dispose());
});
