import { NetWorld, type Transport } from '@engine/index';
import { BroadcastTransport } from '@engine/transport/broadcast';
import { TrysteroTransport } from '@engine/transport/trystero';
import { loadAssets } from '../crossplay/assets';
import { Stage, VR_SESSION_INIT } from '../crossplay/stage';
import { ASSETS } from './assets';
import { City } from './city';
import { ACTIONS, ENTITIES } from './defs';
import { Game } from './Game';
import { Hud } from './hud';
import { Sfx } from './sfx';

const APP_ID = 'peer-city-3d.p2p-game-engine.v1';
const CITY_SEED = 20260914;

const params = new URLSearchParams(location.search);
const nameInput = document.getElementById('name') as HTMLInputElement;
const netSelect = document.getElementById('net') as HTMLSelectElement;
const roomInput = document.getElementById('room') as HTMLInputElement;
const playButton = document.getElementById('play') as HTMLButtonElement;
const vrButton = document.getElementById('play-vr') as HTMLButtonElement;
const vrNote = document.getElementById('vr-note')!;

const storedName = safeStorage('get', 'peer-city-name');
nameInput.value = params.get('name') ?? storedName ?? `Player${Math.floor(Math.random() * 900 + 100)}`;
netSelect.value = params.get('net') === 'local' ? 'local' : 'online';
roomInput.value = params.get('shard') ?? 'downtown';

void Stage.vrSupported().then((ok) => {
  vrButton.disabled = !ok;
  vrNote.textContent = ok
    ? 'Headset detected. Clear some floor space: room-scale walking is supported.'
    : 'No VR headset detected. Open this page in a WebXR browser (e.g. Meta Quest Browser) to play in VR.';
});

// Models download while the lobby is up; the game starts once they're in.
const assetsReady = loadAssets(ASSETS);

let started = false;
playButton.addEventListener('click', () => start(false));
vrButton.addEventListener('click', () => start(true));
nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && start(false));
if (params.has('autostart')) start(false);

function start(vr: boolean): void {
  if (started) return;
  started = true;
  // The session must be requested inside the click handler, before anything async.
  const session = vr && navigator.xr ? navigator.xr.requestSession('immersive-vr', VR_SESSION_INIT) : null;

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
  playButton.textContent = 'LOADING…';
  assetsReady.then(
    () => launch(session, sfx, playerName, mode, shard),
    (err: unknown) => {
      vrNote.textContent = `Couldn't load game assets: ${err instanceof Error ? err.message : String(err)}`;
    },
  );
}

function launch(session: Promise<XRSession> | null, sfx: Sfx, playerName: string, mode: 'online' | 'local', shard: string): void {
  document.getElementById('lobby')!.hidden = true;
  const transport: Transport = mode === 'local' ? new BroadcastTransport(APP_ID) : new TrysteroTransport({ appId: APP_ID });
  // Distances are meters, so the engine's pixel-scale defaults are scaled down.
  const world = new NetWorld({
    transport,
    worldId: `peer-city-3d/${shard}`,
    entities: ENTITIES,
    actions: ACTIONS,
    zoneSize: 256,
    cellSize: 64,
    interestRadius: 170,
    tickRate: 20,
    interpDelayMs: 110,
    spatialCellSize: 24,
    focusResendDistance: 1.5,
    zoneJoinMargin: 25,
    zoneKeepMargin: 75,
  });
  const city = new City(CITY_SEED);
  const hud = new Hud(city);
  const sim = params.has('xrsim');
  const game = new Game({ world, city, hud, sfx, playerName, netLabel: `${mode}/${shard}`, container: document.getElementById('game')!, sim });

  if (session) {
    session.then((s) => game.startSession(s)).catch((err: unknown) => hud.message(`Couldn't start VR: ${err instanceof Error ? err.message : String(err)}`));
  } else {
    game.input.requestLock();
  }

  // handy for debugging from the console
  Object.assign(window as object, { peerCity3d: { world, city, game } });
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
