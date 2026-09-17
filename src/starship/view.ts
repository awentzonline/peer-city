import * as THREE from 'three';
import type { CrewEntity, StarshipContext } from './context';
import { Carry, Crew, CrewMode } from './defs';

/**
 * What a frontend puts on its screen each frame: space (through the space view's camera, framed for the viewscreen's
 * mode), a deck (through a camera, lit for where it looks: the ship or a planet), or nothing at all, which is how a phone
 * at a station saves its battery.
 */
export type Drawn = { place: 'space'; camera?: THREE.Camera } | { place: 'deck'; camera: THREE.Camera; x: number } | { place: 'none' };

/** Frontends of this game say what they draw. */
export interface Draws {
  drawn(): Drawn;
  /** The ship was hit: shake, flash or buzz as the device can. */
  jolt?(amount: number, shielded: boolean): void;
}

/** A camera over the away team's shoulders, for the viewscreen: whoever has the relic, or whoever's down there. */
export class AwayCamera {
  readonly camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 400);
  private who: CrewEntity | null = null;
  private ready = false;
  private readonly at = new THREE.Vector3();
  private readonly from = new THREE.Vector3();

  constructor(private readonly ctx: StarshipContext) {}

  /** Who it's following, if anyone's on a planet. */
  subject(): CrewEntity | null {
    const { world, deck } = this.ctx;
    const away = ([...world.all(Crew)] as CrewEntity[]).filter((c) => !deck.onShip(c.x));
    if (!away.length) {
      this.who = null;
      return null;
    }
    const carrier = away.find((c) => c.render.carry === Carry.Relic);
    if (carrier) this.who = carrier;
    else if (!this.who || !away.includes(this.who)) {
      this.who = away.find((c) => c.render.mode === CrewMode.Up) ?? away[0];
      this.ready = false;
    }
    return this.who;
  }

  /** Frame the subject for a screen `aspect` wide. False if nobody's away. */
  aim(aspect: number, dt: number): boolean {
    const c = this.subject();
    if (!c) return false;
    const cam = this.camera;
    if (cam.aspect !== aspect) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
    const yaw = c.render.yaw;
    const want = new THREE.Vector3(c.x - Math.cos(yaw) * 4.2, 2.8, c.y - Math.sin(yaw) * 4.2);
    const look = new THREE.Vector3(c.x + Math.cos(yaw) * 2, 1.3, c.y + Math.sin(yaw) * 2);
    const k = this.ready ? Math.min(1, dt * 3) : 1;
    this.from.lerp(want, k);
    this.at.lerp(look, k);
    this.ready = true;
    cam.position.copy(this.from);
    cam.lookAt(this.at);
    return true;
  }
}
