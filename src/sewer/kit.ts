import * as THREE from 'three';
import { merge, paint } from '../crossplay/models';
import { Tool, Toolbox, type ToolUse } from '../crossplay/tool';
import type { LordRole } from './lord';

export type Use = ToolUse<LordRole>;

/** How far the hose's jet reaches, m. */
export const HOSE_RANGE = 7;
/** Pressure a full pump stroke adds, and spraying uses a second, of 100. */
export const STROKE = 16;
export const SPRAY_DRAIN = 22;
/** How far the pump handle travels on a hose, m, for tracked hands. */
export const PUMP_THROW = 0.14;

/**
 * A metal detector. Sweep its coil over the sewage and it beeps faster the nearer it is to something buried in the
 * silt (or stuck in the fat). Only its holder hears it.
 */
export class Detector extends Tool<LordRole> {
  constructor() {
    super({
      name: 'Detector',
      model: { build: detectorGeometry, length: 1.05 },
      // held like a walking stick, the coil down in front
      grip: { tip: [0, 0, -1.0], pitch: -0.75 },
      // down the left hip, coil to the floor
      stash: [{ at: [-0.22, -0.42, -0.05], pitch: -Math.PI / 2 }],
      color: 0x8fe3ff,
      issued: 1,
      max: 1,
    });
  }

  override onHold(use: Use): void {
    use.avatar.sweep(use);
  }
}

/**
 * A pressure hose: a pump-action water lance. Pump it to build pressure (a hand on the slide, back and forth, or R),
 * then pull the trigger to blast the fatberg away, or knock a goblin flat.
 */
export class Hose extends Tool<LordRole> {
  constructor() {
    super({
      name: 'Pressure hose',
      model: { build: hoseGeometry, length: 0.9 },
      grip: { tip: [0, 0.04, -0.72] },
      stash: [{ at: [0.24, -0.4, -0.08], pitch: -Math.PI / 2 }],
      color: 0xffd35a,
      issued: 1,
      max: 1,
      automatic: true,
      cooldownMs: 100,
    });
  }

  override onUse(use: Use): void {
    use.avatar.spray(use);
  }

  override onHold(use: Use, dt: number): void {
    use.avatar.holdHose(use, dt);
  }

  override onRelease(use: Use): void {
    use.avatar.stopSpray();
  }

  override onUnequip(use: Use): void {
    use.avatar.stopSpray();
  }
}

/**
 * Counts pump strokes from where the handle is: 0 pulled all the way back, 1 pushed home. A stroke is back past a
 * quarter and home past three quarters. Null means nobody's on the handle.
 */
export class PumpMeter {
  private back = false;

  update(pos: number | null): number {
    if (pos === null) {
      this.back = false;
      return 0;
    }
    if (pos < 0.25) this.back = true;
    else if (pos > 0.75 && this.back) {
      this.back = false;
      return 1;
    }
    return 0;
  }

  /** Where the handle is in the stroke, for showing it: true while it's pulled back. */
  get pulled(): boolean {
    return this.back;
  }
}

function detectorGeometry(): THREE.BufferGeometry {
  return merge([
    // handle and arm cuff at the grip
    paint(new THREE.CylinderGeometry(0.018, 0.018, 0.14, 8).rotateX(Math.PI / 2).translate(0, 0, 0.02), 0x1f1f22),
    paint(new THREE.BoxGeometry(0.07, 0.05, 0.1).translate(0, 0.045, -0.05), 0x2c3a44),
    paint(new THREE.BoxGeometry(0.05, 0.004, 0.06).translate(0, 0.072, -0.05), 0x8fe3ff),
    // the shaft
    paint(new THREE.CylinderGeometry(0.012, 0.012, 0.86, 8).rotateX(Math.PI / 2).translate(0, 0, -0.52), 0x9a9da3),
    // the coil, flat to the ground when the shaft's tipped down
    paint(new THREE.CylinderGeometry(0.13, 0.13, 0.025, 18).rotateX(0.75).translate(0, -0.02, -0.98), 0x1d1d20),
    paint(new THREE.TorusGeometry(0.115, 0.012, 6, 18).rotateX(Math.PI / 2 + 0.75).translate(0, -0.005, -0.98), 0xd4a93a),
  ]);
}

function hoseGeometry(): THREE.BufferGeometry {
  return merge([
    // stock and grip
    paint(new THREE.BoxGeometry(0.05, 0.12, 0.05).translate(0, -0.05, 0.03), 0x3a2a1c),
    paint(new THREE.BoxGeometry(0.06, 0.07, 0.2).translate(0, 0.02, 0.1), 0x3a2a1c),
    // the pressure tank under the barrel
    paint(new THREE.CylinderGeometry(0.045, 0.045, 0.3, 12).rotateX(Math.PI / 2).translate(0, -0.035, -0.2), 0xc0392b),
    paint(new THREE.CylinderGeometry(0.02, 0.02, 0.02, 8).translate(0, 0.02, -0.07), 0xe8e8e8),
    // brass lance and nozzle
    paint(new THREE.CylinderGeometry(0.017, 0.017, 0.62, 8).rotateX(Math.PI / 2).translate(0, 0.04, -0.4), 0xc8a24a),
    paint(new THREE.CylinderGeometry(0.012, 0.028, 0.06, 10).rotateX(Math.PI / 2).translate(0, 0.04, -0.71), 0xd8b45a),
    // the pump slide
    paint(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 10).rotateX(Math.PI / 2).translate(0, 0.0, -0.42), 0x2b2b2b),
  ]);
}

export const DETECTOR = new Detector();
export const HOSE = new Hose();

export type SewerTool = Detector | Hose;

export const TOOLS = new Toolbox<SewerTool>([DETECTOR, HOSE]);
