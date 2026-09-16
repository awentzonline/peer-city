import * as THREE from 'three';
import { mulberry32 } from '@engine/index';
import { SOLID, box, merge, paint } from '../crossplay/models';
import { BOARD, PALETTE, RACK, STREET_Y, WALL_HEIGHT, WALL_THICKNESS, YARD, rackHeight, rackWidth, swatchAt } from './yard';

const SKY = 0xf2c6a0;

/**
 * The yard as it's drawn, apart from the paint: a late-afternoon sky, the asphalt, the blocks the painted faces
 * are on, the board, the paint rack, the street outside the gate, and the buildings beyond the walls.
 * Everything's merged into a few meshes; `box` takes world-ish arguments in scene axes (x, up, y).
 */
export class Scenery {
  constructor(scene: THREE.Scene) {
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 60, 260);
    scene.add(new THREE.HemisphereLight(0xfff1e0, 0x4a4540, 1.45));
    const sun = new THREE.DirectionalLight(0xffe2b8, 1.5);
    sun.position.set(-0.5, 0.8, -0.6);
    scene.add(sun);
    scene.add(this.ground(), this.walls(), this.rack(), this.street(), this.skyline());
  }

  /** A box by its world extents: x0..x1, y0..y1 on the ground, z0..z1 up. */
  private static block(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: number): THREE.BufferGeometry {
    return box(x1 - x0, z1 - z0, y1 - y0, (x0 + x1) / 2, (z0 + z1) / 2, (y0 + y1) / 2, color);
  }

  private ground(): THREE.Mesh {
    const b = Scenery.block;
    const parts = [
      // asphalt in the yard, pavement at the gate, and the road
      b(YARD.x0 - 40, YARD.x1 + 40, YARD.y0, YARD.y1 + 40, -0.1, 0, 0x5b5b5e),
      b(YARD.x0 - 40, YARD.x1 + 40, STREET_Y, YARD.y0, -0.1, 0.02, 0x9a968f),
      b(YARD.x0 - 40, YARD.x1 + 40, STREET_Y - 9, STREET_Y, -0.1, -0.02, 0x3a3a3e),
      b(YARD.x0 - 40, YARD.x1 + 40, STREET_Y - 9, STREET_Y - 9.4, -0.1, 0.12, 0x9a968f),
    ];
    // road markings and cracks with the paint worn off
    for (let x = YARD.x0 - 38; x < YARD.x1 + 38; x += 5) parts.push(b(x, x + 2.5, STREET_Y - 4.6, STREET_Y - 4.4, -0.02, -0.005, 0xe8e2c8));
    const rng = mulberry32(3);
    for (let i = 0; i < 40; i++) {
      const x = YARD.x0 + rng() * (YARD.x1 - YARD.x0);
      const y = YARD.y0 + rng() * (YARD.y1 - YARD.y0);
      const w = 0.3 + rng() * 1.6;
      parts.push(rng() < 0.5 ? b(x, x + w, y, y + 0.04, 0, 0.004, 0x3f3f42) : b(x, x + 0.04, y, y + w, 0, 0.004, 0x3f3f42));
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  private walls(): THREE.Mesh {
    const b = Scenery.block;
    const t = WALL_THICKNESS;
    const h = WALL_HEIGHT;
    const cap = 0x8a857d;
    const side = 0xa19c93;
    const parts = [
      b(YARD.x0 - t, YARD.x1 + t, YARD.y1, YARD.y1 + t, 0, h, side),
      b(YARD.x0 - t, YARD.x0, YARD.y0, YARD.y1 + t, 0, h, side),
      b(YARD.x1, YARD.x1 + t, YARD.y0, YARD.y1 + t, 0, h, side),
      // coping along the tops
      b(YARD.x0 - t - 0.05, YARD.x1 + t + 0.05, YARD.y1 - 0.05, YARD.y1 + t + 0.05, h, h + 0.12, cap),
      b(YARD.x0 - t - 0.05, YARD.x0 + 0.05, YARD.y0 - 0.05, YARD.y1 + t, h, h + 0.12, cap),
      b(YARD.x1 - 0.05, YARD.x1 + t + 0.05, YARD.y0 - 0.05, YARD.y1 + t, h, h + 0.12, cap),
      // the board, on a pair of posts
      b(BOARD.x0, BOARD.x1, BOARD.y - BOARD.thickness / 2, BOARD.y + BOARD.thickness / 2, 0, BOARD.height, 0xa88d62),
      b(BOARD.x0 - 0.12, BOARD.x0, BOARD.y - 0.2, BOARD.y + 0.2, 0, BOARD.height + 0.15, 0x6e5a3a),
      b(BOARD.x1, BOARD.x1 + 0.12, BOARD.y - 0.2, BOARD.y + 0.2, 0, BOARD.height + 0.15, 0x6e5a3a),
      // gate posts where the side walls end
      b(YARD.x0 - t - 0.1, YARD.x0 + 0.1, YARD.y0 - 0.5, YARD.y0, 0, h + 0.4, 0x7b766e),
      b(YARD.x1 - 0.1, YARD.x1 + t + 0.1, YARD.y0 - 0.5, YARD.y0, 0, h + 0.4, 0x7b766e),
    ];
    // a dumpster and some paint tins in the corners, for company
    parts.push(b(-14.6, -12.4, 8.2, 9.6, 0, 1.3, 0x2e6b4a), b(-14.7, -12.3, 8.1, 9.7, 1.3, 1.38, 0x24553b));
    const rng = mulberry32(11);
    for (let i = 0; i < 7; i++) {
      const x = 12.6 + rng() * 1.8;
      const y = 7.4 + rng() * 2.2;
      parts.push(paint(new THREE.CylinderGeometry(0.14, 0.14, 0.3, 10).translate(x, 0.15, y), PALETTE[Math.floor(rng() * PALETTE.length)].rgb));
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  private rack(): THREE.Mesh {
    const b = Scenery.block;
    const w = rackWidth() / 2;
    const x0 = RACK.x - w;
    const x1 = RACK.x + w;
    const top = RACK.z + rackHeight();
    const parts = [
      // pegboard and its legs, with a shelf of cans below the swatches
      b(x0 - 0.12, x1 + 0.12, RACK.y - 0.06, RACK.y - 0.02, RACK.z - 0.12, top + 0.12, 0x6d4c33),
      b(x0 - 0.12, x0 - 0.04, RACK.y - 0.1, RACK.y - 0.02, 0, top + 0.12, 0x4d3726),
      b(x1 + 0.04, x1 + 0.12, RACK.y - 0.1, RACK.y - 0.02, 0, top + 0.12, 0x4d3726),
      b(x0 - 0.12, x1 + 0.12, RACK.y - 0.02, RACK.y + 0.32, 0.72, 0.76, 0x4d3726),
    ];
    for (let i = 0; i < PALETTE.length; i++) {
      const c = swatchAt(i);
      const rgb = PALETTE[i].rgb;
      parts.push(b(c.x - RACK.size / 2, c.x + RACK.size / 2, RACK.y - 0.02, RACK.y, c.z - RACK.size / 2, c.z + RACK.size / 2, rgb));
      // a can of it on the shelf below, top row's at the back
      const back = i < RACK.cols;
      const cx = c.x + (back ? -0.06 : 0.08);
      const cy = RACK.y + (back ? 0.09 : 0.22);
      parts.push(paint(new THREE.CylinderGeometry(0.033, 0.033, 0.19, 10).translate(cx, 0.855, cy), 0xdfe6e9));
      parts.push(paint(new THREE.CylinderGeometry(0.034, 0.034, 0.07, 10).translate(cx, 0.85, cy), rgb));
    }
    return new THREE.Mesh(merge(parts), SOLID);
  }

  private street(): THREE.Mesh {
    const b = Scenery.block;
    const parts: THREE.BufferGeometry[] = [];
    // lamp posts along the pavement
    for (const x of [-20, 0, 20]) {
      parts.push(b(x - 0.08, x + 0.08, STREET_Y + 0.4, STREET_Y + 0.56, 0, 5.2, 0x3d3d42));
      parts.push(b(x - 0.08, x + 0.08, STREET_Y + 0.4, STREET_Y + 1.4, 5.1, 5.24, 0x3d3d42));
      parts.push(b(x - 0.15, x + 0.15, STREET_Y + 1.2, STREET_Y + 1.5, 4.95, 5.1, 0xfff3c4));
    }
    // bollards across the gate
    for (let x = YARD.x0 + 1; x < YARD.x1; x += 2.5) parts.push(paint(new THREE.CylinderGeometry(0.09, 0.09, 0.8, 8).translate(x, 0.4, STREET_Y + 0.25), 0xf5b82e));
    return new THREE.Mesh(merge(parts), SOLID);
  }

  /** Blocks of flats and warehouses beyond the walls, seeded so everyone sees the same town. */
  private skyline(): THREE.Mesh {
    const b = Scenery.block;
    const rng = mulberry32(2026);
    const parts: THREE.BufferGeometry[] = [];
    const colors = [0x9b7b66, 0x7f8a94, 0xb59a7a, 0x6f6a74, 0xa58f84, 0x8c9a8a];
    const add = (x0: number, x1: number, y0: number, y1: number) => {
      const h = 8 + rng() * 22;
      const color = colors[Math.floor(rng() * colors.length)];
      parts.push(b(x0, x1, y0, y1, 0, h, color));
      // rows of windows front and back
      for (let z = 3; z < h - 2; z += 3.2) parts.push(b(x0 + 0.8, x1 - 0.8, y0 - 0.05, y1 + 0.05, z, z + 1.2, 0x3b4550));
    };
    for (let x = -60; x < 60; x += 14) add(x, x + 12 + rng() * 2, YARD.y1 + 6 + rng() * 6, YARD.y1 + 26);
    for (let y = -10; y < 40; y += 16) {
      add(YARD.x0 - 34, YARD.x0 - 8 - rng() * 4, y, y + 12);
      add(YARD.x1 + 8 + rng() * 4, YARD.x1 + 34, y, y + 12);
    }
    for (let x = -60; x < 60; x += 16) add(x, x + 13, STREET_Y - 30, STREET_Y - 14 - rng() * 3);
    return new THREE.Mesh(merge(parts), SOLID);
  }
}
