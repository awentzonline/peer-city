import { NetWorld } from '@engine/index';
import { openLobby } from '../crossplay/lobby';
import { OPEN_WORLD, connect } from '../crossplay/network';
import { hourOffset } from './clock';
import { ACTIONS, ENTITIES } from './defs';
import { Game } from './Game';
import { Hud } from './hud';
import { Land } from './land';
import { Sfx } from './sfx';

const APP_ID = 'peer-wilds.p2p-game-engine.v1';
const LAND_SEED = 20260915;

const sfx = new Sfx();

void openLobby({
  nameKey: 'peer-wilds-name',
  namePrefix: 'Survivor',
  shard: 'island',
  audio: sfx,
  headsetNote: 'Headset detected. Clear some floor space: room-scale walking and swinging tools are supported.',
}).then((launch) => {
  const world = new NetWorld({
    ...OPEN_WORLD,
    transport: connect(APP_ID, launch.mode),
    worldId: `peer-wilds/${launch.shard}`,
    entities: ENTITIES,
    actions: ACTIONS,
    interestRadius: 150,
  });
  const land = new Land(LAND_SEED);
  const hour = launch.params.has('hour') ? Number(launch.params.get('hour')) : null;
  const game = new Game({ world, land, hud: new Hud(land), sfx, launch, hourOffset: hourOffset(hour, Date.now() / 1000) });

  // handy for debugging from the console
  Object.assign(window as object, { peerWilds: { world, land, game } });
  window.addEventListener('pagehide', () => game.dispose());
});
