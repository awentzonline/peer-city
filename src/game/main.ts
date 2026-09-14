import Phaser from 'phaser';
import { NetWorld, type Transport } from '@engine/index';
import { BroadcastTransport } from '@engine/transport/broadcast';
import { TrysteroTransport } from '@engine/transport/trystero';
import { City } from './city';
import { ACTIONS, ENTITIES } from './defs';
import { GameScene } from './GameScene';
import { Hud } from './hud';
import { Sfx } from './sfx';

const APP_ID = 'peer-city.p2p-game-engine.v1';
const CITY_SEED = 20260913;

const params = new URLSearchParams(location.search);
const nameInput = document.getElementById('name') as HTMLInputElement;
const netSelect = document.getElementById('net') as HTMLSelectElement;
const roomInput = document.getElementById('room') as HTMLInputElement;
const playButton = document.getElementById('play') as HTMLButtonElement;

const storedName = safeStorage('get', 'peer-city-name');
nameInput.value = params.get('name') ?? storedName ?? `Player${Math.floor(Math.random() * 900 + 100)}`;
netSelect.value = params.get('net') === 'local' ? 'local' : 'online';
roomInput.value = params.get('shard') ?? 'downtown';

playButton.addEventListener('click', start);
nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && start());
if (params.has('autostart')) start();

function start(): void {
  if (playButton.disabled) return;
  playButton.disabled = true;
  const playerName = nameInput.value.trim().slice(0, 16) || 'Player';
  const mode = netSelect.value as 'online' | 'local';
  const shard = roomInput.value.trim().replace(/[^\w-]/g, '').slice(0, 24) || 'downtown';
  safeStorage('set', 'peer-city-name', playerName);

  const url = new URL(location.href);
  url.searchParams.set('net', mode);
  url.searchParams.set('shard', shard);
  url.searchParams.delete('name');
  url.searchParams.delete('autostart');
  history.replaceState(null, '', url);

  const sfx = new Sfx();
  sfx.unlock();
  document.getElementById('lobby')!.hidden = true;

  const transport: Transport = mode === 'local' ? new BroadcastTransport(APP_ID) : new TrysteroTransport({ appId: APP_ID });
  const world = new NetWorld({
    transport,
    worldId: `peer-city/${shard}`,
    entities: ENTITIES,
    actions: ACTIONS,
    zoneSize: 2048,
    cellSize: 512,
    interestRadius: 1150,
    tickRate: 20,
    interpDelayMs: 110,
  });
  const city = new City(CITY_SEED);
  const hud = new Hud(city);

  const game = new Phaser.Game({
    type: Phaser.WEBGL,
    parent: 'game',
    backgroundColor: '#1f5f9a',
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    render: { antialias: true },
    scene: [new GameScene({ world, city, hud, sfx, playerName, netLabel: `${mode}/${shard}` })],
  });

  // handy for debugging from the console
  Object.assign(window as object, { peerCity: { world, city, game } });
  window.addEventListener('pagehide', () => world.dispose());
}

function safeStorage(op: 'get' | 'set', key: string, value?: string): string | null {
  try {
    if (op === 'get') return localStorage.getItem(key);
    localStorage.setItem(key, value!);
  } catch {
    /* storage unavailable */
  }
  return null;
}
