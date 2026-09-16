import type { NetMode } from './network';
import { Stage, VR_SESSION_INIT, errorText } from './stage';
import { isTouchDevice } from './touch';

/** How the player chose to play, from the lobby. */
export interface Launch<T = undefined> {
  playerName: string;
  mode: NetMode;
  /** Which copy of the world to join (the room field), cleaned up for use in room names. */
  shard: string;
  /** `mode/shard`: names this world for the debug panel, and for anything a browser keeps per world. */
  netLabel: string;
  /** Play with fingers: the touch frontend rather than keys and mouse. Only for games with one. */
  touch: boolean;
  /** Emulate a headset on desktop (`?xrsim`). */
  sim: boolean;
  /** The page's query parameters, for a game's own switches. */
  params: URLSearchParams;
  /** A headset session asked for from PLAY VR's click, or null to play on the page. */
  session: Promise<XRSession> | null;
  /** What `LobbyOptions.load` resolved to. */
  loaded: T;
}

export interface LobbyOptions<T> {
  /** Where this browser remembers the player's name. */
  nameKey: string;
  /** Names a new player `Racer123`, and a blank name `Racer`. */
  namePrefix: string;
  /** The room to suggest, and to use when the field's left blank. */
  shard: string;
  /** Unlocked from the PLAY click, which is the gesture a browser wants before it makes sound. */
  audio?: { unlock(): void };
  /** The game has a touch frontend: phones get it (and `?touch` / `?desktop` force either way). */
  touch?: boolean;
  /** On a phone, also ask to turn the screen sideways, where the browser allows it. */
  landscape?: boolean;
  /** Shown when a headset's detected, e.g. how much room to clear. */
  headsetNote: string;
  /** Shown when there's no headset. Defaults to how to get one. */
  noHeadsetNote?: string;
  /**
   * What must be ready before the game starts, e.g. models or WASM already loading, or something kept for this
   * world. Called from the PLAY click; the lobby says LOADING until it's done.
   */
  load?: (launch: Launch<undefined>) => T | Promise<T>;
}

/**
 * The lobby on a game's page: the player's name, the network and room, and PLAY or PLAY VR. Resolves once
 * they've pressed one and `load` is done, with the lobby hidden. Anything that needs the click's user gesture
 * (the headset session, sound, fullscreen) has already been asked for by then.
 *
 * Expects the page's `#lobby`, `#name`, `#net`, `#room`, `#play`, `#play-vr` and `#vr-note`.
 */
export function openLobby<T = undefined>(opts: LobbyOptions<T>): Promise<Launch<T>> {
  const params = new URLSearchParams(location.search);
  const nameInput = document.getElementById('name') as HTMLInputElement;
  const netSelect = document.getElementById('net') as HTMLSelectElement;
  const roomInput = document.getElementById('room') as HTMLInputElement;
  const playButton = document.getElementById('play') as HTMLButtonElement;
  const vrButton = document.getElementById('play-vr') as HTMLButtonElement;
  const vrNote = document.getElementById('vr-note')!;

  // ?touch and ?desktop force a frontend; otherwise fingers on a coarse pointer get the touch one.
  const touch = !!opts.touch && (params.has('touch') || (!params.has('desktop') && isTouchDevice()));
  if (touch) document.body.classList.add('touch');

  nameInput.value = params.get('name') ?? storage('get', opts.nameKey) ?? `${opts.namePrefix}${Math.floor(Math.random() * 900 + 100)}`;
  netSelect.value = params.get('net') === 'local' ? 'local' : 'online';
  roomInput.value = params.get('shard') ?? opts.shard;

  void Stage.vrSupported().then((ok) => {
    vrButton.disabled = !ok;
    vrNote.textContent = ok
      ? opts.headsetNote
      : (opts.noHeadsetNote ?? 'No VR headset detected. Open this page in a WebXR browser (e.g. Meta Quest Browser) to play in VR.');
  });

  return new Promise((resolve) => {
    let started = false;
    const start = (vr: boolean): void => {
      if (started) return;
      started = true;
      // The session must be requested inside the click handler, before anything async.
      const session = vr && navigator.xr ? navigator.xr.requestSession('immersive-vr', VR_SESSION_INIT) : null;
      opts.audio?.unlock();
      // A phone's browser chrome eats a third of a small screen, and this is the gesture that can ask for it.
      if (touch && !vr) void fullscreen(!!opts.landscape);

      const playerName = nameInput.value.trim().slice(0, 16) || opts.namePrefix;
      const mode: NetMode = netSelect.value === 'local' ? 'local' : 'online';
      const shard = roomInput.value.trim().replace(/[^\w-]/g, '').slice(0, 24) || opts.shard;
      storage('set', opts.nameKey, playerName);

      const url = new URL(location.href);
      url.searchParams.set('net', mode);
      url.searchParams.set('shard', shard);
      url.searchParams.delete('name');
      url.searchParams.delete('autostart');
      history.replaceState(null, '', url);

      const launch: Launch<undefined> = { playerName, mode, shard, netLabel: `${mode}/${shard}`, touch, sim: params.has('xrsim'), params, session, loaded: undefined };
      playButton.disabled = vrButton.disabled = true;
      playButton.textContent = 'LOADING…';
      Promise.resolve()
        .then(() => opts.load?.(launch) as T)
        .then(
          (loaded) => {
            document.getElementById('lobby')!.hidden = true;
            resolve({ ...launch, loaded });
          },
          (err: unknown) => {
            playButton.textContent = "COULDN'T LOAD";
            vrNote.textContent = `Couldn't load the game: ${errorText(err)}`;
          },
        );
    };

    playButton.addEventListener('click', () => start(false));
    vrButton.addEventListener('click', () => start(true));
    nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && start(false));
    if (params.has('autostart')) start(false);
  });
}

async function fullscreen(landscape: boolean): Promise<void> {
  try {
    await document.documentElement.requestFullscreen?.();
    if (landscape) await (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape');
  } catch {
    /* not allowed here (iOS never locks); the controls work either way up */
  }
}

function storage(op: 'get' | 'set', key: string, value?: string): string | null {
  try {
    if (op === 'get') return localStorage.getItem(key);
    localStorage.setItem(key, value!);
  } catch {
    /* storage unavailable */
  }
  return null;
}
