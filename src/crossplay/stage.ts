import * as THREE from 'three';
import { DesktopInput } from './input';
import { Rig } from './rig';

export const VR_SESSION_INIT: XRSessionInit = { optionalFeatures: ['local-floor', 'bounded-floor'] };

/** How long without an animation frame before the game keeps itself running on a timer. */
const STALLED_MS = 200;

export interface StageLoop {
  /** Simulate `dt` seconds. Draw only when `visible`: background steps aren't rendered. */
  step(dt: number, visible: boolean): void;
  /** A headset session started or ended, so the page is played on a different platform now. */
  platformChanged(presenting: boolean): void;
}

/**
 * The page a crossplay game plays in: a three.js renderer that can present to a headset, the player's rig,
 * keyboard and mouse, and a loop that keeps simulating in a background tab. Games build their world into
 * `scene` and their frontends onto `rig`.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: Rig;
  readonly input: DesktopInput;
  /**
   * Draws a frame instead of rendering `scene` through the rig's camera, for a game that wants more than one scene or
   * pass (a screen in the world showing another place, say). It runs in the animation loop, so in a headset too.
   */
  render: ((renderer: THREE.WebGLRenderer) => void) | null = null;
  private last = performance.now();

  static async vrSupported(): Promise<boolean> {
    try {
      return (await navigator.xr?.isSessionSupported('immersive-vr')) ?? false;
    } catch {
      return false;
    }
  }

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;
    container.appendChild(this.renderer.domElement);
    this.rig = new Rig(this.scene, window.innerWidth / window.innerHeight);
    this.input = new DesktopInput(this.renderer.domElement);
    window.addEventListener('resize', () => this.resize());
  }

  get presenting(): boolean {
    return this.renderer.xr.isPresenting;
  }

  /** Start simulating and drawing. */
  run(loop: StageLoop): void {
    this.renderer.xr.addEventListener('sessionstart', () => {
      if (document.pointerLockElement) document.exitPointerLock();
      loop.platformChanged(true);
    });
    this.renderer.xr.addEventListener('sessionend', () => {
      this.rig.floorY = 0;
      loop.platformChanged(false);
    });

    const tick = (maxMs: number, visible: boolean) => {
      const now = performance.now();
      const dt = Math.min(now - this.last, maxMs) / 1000;
      this.last = now;
      loop.step(dt, visible);
      this.input.endFrame();
    };

    // Browsers stop animation frames in background tabs. A peer that stops ticking would freeze the NPCs
    // it owns for everyone nearby, and after a few quiet seconds its own player drops out of their worlds,
    // so whenever frames stop coming, keep simulating on a timer. The page's own timers get throttled
    // to once a second in the background, and to once a minute after a while; a worker's don't.
    onBeat(() => {
      if (performance.now() - this.last >= STALLED_MS) tick(250, false);
    }, 100);

    // setAnimationLoop (not requestAnimationFrame) so the loop keeps running on the headset's clock.
    this.renderer.setAnimationLoop(() => {
      tick(50, true);
      if (this.render) this.render(this.renderer);
      else this.renderer.render(this.scene, this.rig.camera);
    });
  }

  /** Must be called from a user gesture. */
  enterVR(): Promise<void> {
    if (!navigator.xr) return Promise.reject(new Error('WebXR is not available in this browser'));
    return navigator.xr.requestSession('immersive-vr', VR_SESSION_INIT).then((session) => this.startSession(session));
  }

  async startSession(session: XRSession): Promise<void> {
    const features = (session as XRSession & { enabledFeatures?: readonly string[] }).enabledFeatures;
    const floor = !features || features.includes('local-floor');
    // A floor-level space puts your real floor on the ground. Without one, assume standing height.
    this.rig.floorY = floor ? 0 : 1.6;
    this.renderer.xr.setReferenceSpaceType(floor ? 'local-floor' : 'local');
    await this.renderer.xr.setSession(session);
  }

  private resize(): void {
    if (this.presenting) return;
    this.rig.camera.aspect = window.innerWidth / window.innerHeight;
    this.rig.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Call `fn` every `ms`, from a worker's timer where the browser allows one (so a background tab isn't throttled), else the page's. */
function onBeat(fn: () => void, ms: number): void {
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: 'text/javascript' }));
    // the URL stays: the worker loads it asynchronously
    new Worker(url).onmessage = fn;
  } catch {
    window.setInterval(fn, ms);
  }
}
