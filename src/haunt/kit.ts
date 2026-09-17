import * as THREE from 'three';
import { merge, paint } from '../crossplay/models';
import { Tool, Toolbox, type ToolUse } from '../crossplay/tool';
import type { SurvivorRole } from './survivor';

export type Use = ToolUse<SurvivorRole>;

/** How far a beam reaches, and how wide it is either side of where it points, radians. */
export const BEAM_RANGE = 14;
export const BEAM_HALF_ANGLE = 0.24;

/**
 * A survivor's flashlight: the only thing that fights back. Pull the trigger to switch it on or off. On, it lights the
 * way, burns whatever's in its beam, and gives away where you are. The battery runs down while it's on and slowly
 * comes back while it's off.
 */
export class Flashlight extends Tool<SurvivorRole> {
  constructor() {
    super({
      name: 'Flashlight',
      model: { build: flashlightGeometry, length: 0.26 },
      grip: { tip: [0, 0.01, -0.2] },
      // on the right of the chest, pointing down, like a torch clipped to a jacket
      stash: [{ at: [0.16, -0.22, -0.16], pitch: -Math.PI / 2 }],
      color: 0xffe8a0,
      issued: 1,
      max: 1,
      laser: false,
    });
  }

  override onUse(use: Use): void {
    use.avatar.switchLight(use);
  }

  override onHold(use: Use, dt: number): void {
    use.avatar.shine(use, dt);
  }

  override onUnequip(use: Use): void {
    use.avatar.putAwayLight(use);
  }
}

function flashlightGeometry(): THREE.BufferGeometry {
  return merge([
    paint(new THREE.CylinderGeometry(0.022, 0.02, 0.2, 10).rotateX(Math.PI / 2).translate(0, 0, -0.08), 0x2b2b30),
    paint(new THREE.CylinderGeometry(0.036, 0.024, 0.06, 12).rotateX(Math.PI / 2).translate(0, 0, -0.2), 0x3d3d44),
    paint(new THREE.CylinderGeometry(0.031, 0.031, 0.006, 12).rotateX(Math.PI / 2).translate(0, 0, -0.232), 0xfff4c8),
    paint(new THREE.BoxGeometry(0.012, 0.01, 0.03).translate(0, 0.024, -0.06), 0xb33b2e),
  ]);
}

export const FLASHLIGHT = new Flashlight();

export const TOOLS = new Toolbox<Flashlight>([FLASHLIGHT]);
