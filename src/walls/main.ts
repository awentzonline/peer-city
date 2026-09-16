import { NetWorld, type Transport } from '@engine/index';
import { BroadcastTransport } from '@engine/transport/broadcast';
import { TrysteroTransport } from '@engine/transport/trystero';
import { Stage, VR_SESSION_INIT, errorText } from '../crossplay/stage';
import { isTouchDevice } from '../crossplay/touch';
import { ACTIONS, ENTITIES } from './defs';
import { Game } from './Game';
import { Hud } from './hud';
import { Sfx } from './sfx';
import { IndexedDbWalls } from './store';

const APP_ID = 'peer-walls.p2p-game-engine.v1';

const params = new URLSearchParams(location.search);
// ?touch and ?desktop force a frontend; otherwise fingers on a coarse pointer get the touch one.
const touch = params.has('touch') || (!params.has('desktop') && isTouchDevice());
if (touch) document.body.classList.add('touch');
const nameInput = document.getElementById('name') as HTMLInputElement;
const netSelect = document.getElementById('net') as HTMLSelectElement;
const roomInput = document.getElementById('room') as HTMLInputElement;
const playButton = document.getElementById('play') as HTMLButtonElement;
const vrButton = document.getElementById('play-vr') as HTMLButtonElement;
const vrNote = document.getElementById('vr-note')!;

nameInput.value = params.get('name') ?? safeStorage('get', 'peer-walls-name') ?? `Writer${Math.floor(Math.random() * 900 + 100)}`;
netSelect.value = params.get('net') === 'local' ? 'local' : 'online';
roomInput.value = params.get('shard') ?? 'yard';

void Stage.vrSupported().then((ok) => {
  vrButton.disabled = !ok;
  vrNote.textContent = ok
    ? 'Headset detected. Paint standing up, with room to reach.'
    : 'No VR headset detected. Open this page in a WebXR browser (e.g. Meta Quest Browser) to paint in VR.';
});

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

  const playerName = nameInput.value.trim().slice(0, 16) || 'Writer';
  const mode = netSelect.value as 'online' | 'local';
  const yard = roomInput.value.trim().replace(/[^\w-]/g, '').slice(0, 24) || 'yard';
  safeStorage('set', 'peer-walls-name', playerName);

  const url = new URL(location.href);
  url.searchParams.set('net', mode);
  url.searchParams.set('shard', yard);
  url.searchParams.delete('name');
  url.searchParams.delete('autostart');
  history.replaceState(null, '', url);

  if (touch && !vr) void landscape();

  const sfx = new Sfx();
  sfx.unlock();
  playButton.disabled = true;
  playButton.textContent = 'LOADING…';
  const store = new IndexedDbWalls();

  void store.load(`${mode}/${yard}`).then((saved) => {
    document.getElementById('lobby')!.hidden = true;
    const transport: Transport = mode === 'local' ? new BroadcastTransport(APP_ID) : new TrysteroTransport({ appId: APP_ID });
    // The yard is small, and everyone in it should see everyone else paint.
    const world = new NetWorld({
      transport,
      worldId: `peer-walls/${yard}`,
      entities: ENTITIES,
      actions: ACTIONS,
      zoneSize: 4096,
      cellSize: 1024,
      interestRadius: 400,
      tickRate: 20,
      interpDelayMs: 100,
      bytesPerTick: 4000,
      spatialCellSize: 16,
      focusResendDistance: 3,
      zoneJoinMargin: 100,
      zoneKeepMargin: 300,
    });
    const hud = new Hud();
    const game = new Game({
      world,
      transport,
      hud,
      sfx,
      playerName,
      yard: `${mode}/${yard}`,
      netLabel: `${mode}/${yard}`,
      container: document.getElementById('game')!,
      store,
      saved,
      sim: params.has('xrsim'),
      touch,
      // tabs on one machine find each other at once; peers across the internet can take several seconds
      settleMs: mode === 'local' ? 1500 : 6000,
    });

    if (session) session.then((s) => game.startSession(s)).catch((err: unknown) => hud.message(`Couldn't start VR: ${errorText(err)}`));
    else if (!touch) game.input.requestLock();

    Object.assign(window as object, { peerWalls: { world, game } });
    window.addEventListener('pagehide', () => game.dispose());
  });
}

async function landscape(): Promise<void> {
  try {
    await document.documentElement.requestFullscreen?.();
    await (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape');
  } catch {
    /* not allowed here (iOS never locks); the controls work either way up */
  }
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
