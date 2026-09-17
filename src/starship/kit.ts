import * as THREE from 'three';
import { merge, paint } from '../crossplay/models';
import { Tool, Toolbox, type ToolUse } from '../crossplay/tool';
import type { CrewRole } from './crew';
import { FaultKind } from './defs';

export type Use = ToolUse<CrewRole>;

export class CrewTool extends Tool<CrewRole> {}

/** A hand phaser: for the drones on away missions. Stun setting only, so it does nothing to crew. */
export class HandPhaser extends CrewTool {
  constructor() {
    super({
      name: 'Phaser',
      model: { build: phaserGeometry, length: 0.2 },
      grip: { tip: [0, 0.03, -0.16] },
      stash: [{ at: [0.2, -0.5, -0.06], pitch: -Math.PI / 2 }],
      color: 0x6ad0ff,
      issued: 1,
      cooldownMs: 320,
      laser: true,
    });
  }

  override onUse(use: Use): void {
    use.avatar.shoot(use);
  }
}

/**
 * A spanner for sparking conduits and a hand extinguisher for fires. Hold the trigger on one from close by: in a headset,
 * put the tool's end on it.
 */
export class Fixer extends CrewTool {
  constructor(
    name: string,
    readonly fixes: FaultKind,
    build: () => THREE.BufferGeometry,
    length: number,
    stash: [number, number, number],
    readonly reach: number,
  ) {
    super({
      name,
      model: { build, length },
      grip: { tip: [0, 0, -length * 0.85] },
      stash: [{ at: stash, pitch: -Math.PI / 2 }],
      color: fixes === FaultKind.Fire ? 0xff5a4a : 0xffd35a,
      issued: 1,
      cooldownMs: 100,
      automatic: true,
    });
  }

  override onUse(use: Use): void {
    use.avatar.fix(use, this);
  }
}

export const PHASER = new HandPhaser();
export const SPANNER = new Fixer('Spanner', FaultKind.Sparks, spannerGeometry, 0.42, [-0.2, -0.5, -0.06], 1.9);
export const EXTINGUISHER = new Fixer('Extinguisher', FaultKind.Fire, extinguisherGeometry, 0.4, [-0.17, -0.25, -0.18], 4);

export const TOOLS = new Toolbox<CrewTool>([PHASER, SPANNER, EXTINGUISHER]);

// ---------------------------------------------------------------------------
// Models: pointing down -Z, top up +Y, grip at the origin
// ---------------------------------------------------------------------------

export function phaserGeometry(): THREE.BufferGeometry {
  return merge([
    paint(new THREE.BoxGeometry(0.035, 0.1, 0.045).rotateX(0.25).translate(0, -0.03, 0.02), 0x2a2e38),
    paint(new THREE.BoxGeometry(0.045, 0.045, 0.17).translate(0, 0.03, -0.06), 0xc8ccd6),
    paint(new THREE.BoxGeometry(0.03, 0.02, 0.06).translate(0, 0.06, -0.03), 0x2a2e38),
    paint(new THREE.CylinderGeometry(0.014, 0.014, 0.02, 8).rotateX(Math.PI / 2).translate(0, 0.03, -0.15), 0x6ad0ff),
  ]);
}

export function spannerGeometry(): THREE.BufferGeometry {
  return merge([
    paint(new THREE.CylinderGeometry(0.018, 0.018, 0.14, 8).rotateX(Math.PI / 2).translate(0, 0, 0.02), 0x2a2e38),
    paint(new THREE.CylinderGeometry(0.01, 0.01, 0.24, 6).rotateX(Math.PI / 2).translate(0, 0, -0.15), 0xb8bcc8),
    paint(new THREE.BoxGeometry(0.012, 0.05, 0.05).translate(0, 0.02, -0.29), 0xb8bcc8),
    paint(new THREE.BoxGeometry(0.012, 0.05, 0.05).translate(0, -0.02, -0.29), 0xb8bcc8),
    paint(new THREE.BoxGeometry(0.02, 0.02, 0.02).translate(0, 0, -0.27), 0xffd35a),
  ]);
}

export function extinguisherGeometry(): THREE.BufferGeometry {
  return merge([
    paint(new THREE.CylinderGeometry(0.05, 0.05, 0.26, 10).rotateX(Math.PI / 2).translate(0, -0.03, 0.02), 0xc0302a),
    paint(new THREE.CylinderGeometry(0.02, 0.02, 0.05, 8).rotateX(Math.PI / 2).translate(0, -0.03, -0.13), 0x2a2e38),
    paint(new THREE.BoxGeometry(0.02, 0.02, 0.14).translate(0, 0.02, -0.2), 0x2a2e38),
    paint(new THREE.BoxGeometry(0.03, 0.06, 0.03).translate(0, 0.02, 0.03), 0x2a2e38),
  ]);
}
