import type { Platform } from './platform';

/**
 * Extreme crossplay, on the local peer. Whoever is playing here is a role plus a frontend:
 *
 *   device ──> Frontend.read() ──> intent ──> Role.update() ──> replicated state
 *                                                  │
 *   camera, HUD, first-person models <── Frontend.present()
 *
 * A **role** is what someone does in the world, and owns its rules: the avatar (avatar.ts) walks, drives
 * and shoots. It sees only its intent, a plain object with no DOM or three.js in it, so it runs headless.
 * Roles needn't match across platforms: headset and desktop players can be avatars in the street while a
 * tablet player oversees the city from above and sends NPCs after them.
 *
 * A **frontend** is one platform's take on one role. It reads the device into the role's intent, reflects
 * what the rules did back onto the device (each role defines those callbacks, e.g. `AvatarBody`), and
 * draws the role's state the way that device needs. It only exists while its platform is playing: the
 * `Seat` builds it when that platform takes over and disposes of it before building the next, so two
 * frontends never share the camera, the scene or the HUD.
 */
export interface Role<Intent, F extends Frontend<Intent> = Frontend<Intent>> {
  /** The frontend now playing this role, replacing any before it. */
  attach(frontend: F): void;
  update(dt: number, intent: Intent): void;
}

export interface Frontend<Intent> {
  readonly platform: Platform;
  /**
   * A desktop frontend that points at things with a free mouse pointer (an overseer), rather than capturing the mouse
   * to look around. Default false.
   */
  readonly cursor?: boolean;
  /** Read the device. Runs every simulation step, including throttled ones in a background tab. */
  read(dt: number): Intent;
  /** Show the result once the world has been simulated. Rendered frames only. */
  present(dt: number): void;
  /** Take out everything this frontend added to the scene and rig. It's never used again. */
  dispose(): void;
}

/** The local player: a role, and the frontend playing it right now. */
export class Seat<Intent, F extends Frontend<Intent> = Frontend<Intent>> {
  private current: F;

  /** What built the current frontend, to fall back on if the next one fails to build. */
  private make: () => F;

  constructor(
    readonly role: Role<Intent, F>,
    create: () => F,
  ) {
    this.make = create;
    this.current = this.start(create);
  }

  get frontend(): F {
    return this.current;
  }

  /** Switch platforms, e.g. when a headset session starts or ends. The old frontend is gone before the new one is built. */
  use(create: () => F): void {
    this.current.dispose();
    try {
      this.current = this.start(create);
      this.make = create;
    } catch (err) {
      // e.g. a headset frontend that throws: back to the one that worked, rather than stepping a disposed one
      this.current = this.start(this.make);
      throw err;
    }
  }

  step(dt: number): void {
    this.role.update(dt, this.current.read(dt));
  }

  present(dt: number): void {
    this.current.present(dt);
  }

  private start(create: () => F): F {
    const frontend = create();
    this.role.attach(frontend);
    return frontend;
  }
}

/**
 * For a role only one player may hold (the Haunt, the Captain): among `all` of that role's entities, the one that
 * outranks `me`, if any. Whoever took it first wins; taken in the same second, the lower id does, so every peer agrees.
 * The one it returns is who `me` should yield to.
 */
export function seniorHolder<E extends { id: number; render: { since: number } }>(all: Iterable<E>, me: E): E | null {
  let senior: E | null = null;
  for (const e of all) {
    if (e === me) continue;
    const before = e.render.since < me.render.since || (e.render.since === me.render.since && e.id < me.id);
    if (!before) continue;
    if (!senior || e.render.since < senior.render.since || (e.render.since === senior.render.since && e.id < senior.id)) senior = e;
  }
  return senior;
}
