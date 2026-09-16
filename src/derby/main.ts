import { NetWorld, type Transport } from '@engine/index';
import { BroadcastTransport } from '@engine/transport/broadcast';
import { TrysteroTransport } from '@engine/transport/trystero';
import { Stage, VR_SESSION_INIT, errorText } from '../crossplay/stage';
import { isTouchDevice } from '../crossplay/touch';
import { Course } from './course';
import { ACTIONS, ENTITIES } from './defs';
import { Game } from './Game';
import { Hud } from './hud';
import { initPhysics } from './physics';
import { Sfx } from './sfx';

const APP_ID = 'peer-derby.p2p-game-engine.v1';
const COURSE_SEED = 20260916;

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

nameInput.value = params.get('name') ?? safeStorage('get', 'peer-derby-name') ?? `Racer${Math.floor(Math.random() * 900 + 100)}`;
netSelect.value = params.get('net') === 'local' ? 'local' : 'online';
roomInput.value = params.get('shard') ?? 'hill';

// the physics engine is WebAssembly: start loading it now, and only let anyone in once it's ready
const physicsReady = initPhysics();
playButton.disabled = true;
playButton.textContent = 'LOADING…';
void physicsReady.then(
  () => {
    playButton.disabled = false;
    playButton.textContent = 'PLAY';
    if (params.has('autostart')) start(false);
  },
  (err: unknown) => (playButton.textContent = `Physics failed: ${errorText(err)}`),
);

void Stage.vrSupported().then((ok) => {
  vrButton.disabled = !ok;
  vrNote.textContent = ok
    ? 'Headset detected. You build standing up and race sitting down: clear some space either way.'
    : 'No VR headset detected. Open this page in a WebXR browser (e.g. Meta Quest Browser) to play in VR.';
});

let started = false;
playButton.addEventListener('click', () => start(false));
vrButton.addEventListener('click', () => start(true));
nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && !playButton.disabled && start(false));

function start(vr: boolean): void {
  if (started) return;
  started = true;
  // The session must be requested inside the click handler, before anything async.
  const session = vr && navigator.xr ? navigator.xr.requestSession('immersive-vr', VR_SESSION_INIT) : null;

  const playerName = nameInput.value.trim().slice(0, 16) || 'Racer';
  const mode = netSelect.value as 'online' | 'local';
  const shard = roomInput.value.trim().replace(/[^\w-]/g, '').slice(0, 24) || 'hill';
  safeStorage('set', 'peer-derby-name', playerName);

  const url = new URL(location.href);
  url.searchParams.set('net', mode);
  url.searchParams.set('shard', shard);
  url.searchParams.delete('name');
  url.searchParams.delete('autostart');
  history.replaceState(null, '', url);

  // A phone gets the whole screen, turned sideways where the browser allows it, for thumbs either side.
  if (touch && !vr) void landscape();

  const sfx = new Sfx();
  sfx.unlock();
  document.getElementById('lobby')!.hidden = true;

  void physicsReady.then(() => {
    const transport: Transport = mode === 'local' ? new BroadcastTransport(APP_ID) : new TrysteroTransport({ appId: APP_ID });
    // The whole hill is one neighbourhood: everyone in a race should see everyone else's progress.
    const world = new NetWorld({
      transport,
      worldId: `peer-derby/${shard}`,
      entities: ENTITIES,
      actions: ACTIONS,
      zoneSize: 4096,
      cellSize: 1024,
      interestRadius: 1500,
      tickRate: 20,
      interpDelayMs: 100,
      bytesPerTick: 4000,
      spatialCellSize: 32,
      focusResendDistance: 4,
      zoneJoinMargin: 100,
      zoneKeepMargin: 300,
    });
    const course = new Course(COURSE_SEED);
    const hud = new Hud();
    const game = new Game({
      world,
      transport,
      course,
      hud,
      sfx,
      playerName,
      netLabel: `${mode}/${shard}`,
      container: document.getElementById('game')!,
      sim: params.has('xrsim'),
      touch,
    });

    if (session) session.then((s) => game.startSession(s)).catch((err: unknown) => hud.message(`Couldn't start VR: ${errorText(err)}`));
    else if (!touch) game.input.requestLock();

    Object.assign(window as object, { peerDerby: { world, course, game } });
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
