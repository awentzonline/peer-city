import * as THREE from 'three';
import { SOLID, box, merge } from '../crossplay/models';
import type { Builder } from './builder';
import { TOP } from './course';
import { Racer } from './defs';
import { buildRacer, disposeRacer, type RacerModel } from './models';
import { CELL, cleanDesign, decodeDesign, designStats } from './parts';
import { CUBBY, PLAQUE, SHELF_DEPTH, SHELF_SLOTS, SHELF_WIDTH, SLOT_WIDTH, ShelfAction, shelves } from './shelf';

const WOOD = 0x9c7447;
const DARK_WOOD = 0x6d4c2f;
const LIT = 0xffe066;

interface Slot {
  plaque: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  panel: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** Turns the model on the spot, in the middle of the cubby. */
  turntable: THREE.Group;
  bytes: Uint8Array | null;
  color: number;
  model: RacerModel | null;
}

/**
 * The shelves as they're drawn: the woodwork, a SAVE plaque over each cubby, and in each cubby a little model of
 * the design saved there, turning slowly. Whatever a tool's pointing at lights up, and a shelf that isn't yours
 * has its SAVE plaques greyed out. Scenery in the world rather than a HUD, so it's the same in a headset.
 */
export class ShelfViews {
  private readonly slots: Slot[][] = [];

  constructor(
    scene: THREE.Scene,
    private readonly builder: Builder,
  ) {
    const { course } = builder.ctx;
    const wood: THREE.BufferGeometry[] = [];
    const saveTex = [...Array(SHELF_SLOTS)].map((_, i) => label(`SAVE ${i + 1}`, '#0984e3', '#fff', 256, 96));
    const emptyTex = [...Array(SHELF_SLOTS)].map((_, i) => label(`${i + 1}\nempty`, '#2d3436', 'rgba(255,255,255,0.45)', 256, 256));
    const header = label('DESIGNS', '#3d2a1a', '#f5c542', 512, 96);

    for (const shelf of shelves(course)) {
      const { front, y } = shelf;
      const back = front - SHELF_DEPTH;
      const mid = front - SHELF_DEPTH / 2;
      // Scene coordinates: (x, height, y). The shelf is deep along x and wide along y.
      wood.push(
        box(0.1, 3, SHELF_WIDTH, back - 0.05, TOP + 1.5, y, DARK_WOOD),
        box(SHELF_DEPTH, CUBBY[0], SHELF_WIDTH, mid, TOP + CUBBY[0] / 2, y, WOOD),
        box(SHELF_DEPTH, 0.6, SHELF_WIDTH, mid, TOP + CUBBY[1] + 0.3, y, WOOD),
      );
      for (let i = 0; i <= SHELF_SLOTS; i++) {
        const at = y - SHELF_WIDTH / 2 + 0.1 + i * ((SHELF_WIDTH - 0.2) / SHELF_SLOTS);
        wood.push(box(SHELF_DEPTH, CUBBY[1] - CUBBY[0], 0.1, mid, TOP + (CUBBY[0] + CUBBY[1]) / 2, at, DARK_WOOD));
      }
      const sign = plane(1.8, 0.34, header);
      sign.position.set(back + 0.011, TOP + 2.72, y);
      scene.add(sign);

      this.slots.push(
        shelf.slots.map((s, i) => {
          const plaque = plane(SLOT_WIDTH - 0.12, PLAQUE[1] - PLAQUE[0] - 0.06, saveTex[i]);
          plaque.position.set(front + 0.012, TOP + (PLAQUE[0] + PLAQUE[1]) / 2, s.y);
          const panel = plane(SLOT_WIDTH - 0.1, CUBBY[1] - CUBBY[0], emptyTex[i]);
          panel.position.set(back + 0.011, TOP + (CUBBY[0] + CUBBY[1]) / 2, s.y);
          const turntable = new THREE.Group();
          turntable.position.set(mid + 0.05, TOP + CUBBY[0] + 0.02, s.y);
          scene.add(plaque, panel, turntable);
          return { plaque, panel, turntable, bytes: null, color: -1, model: null };
        }),
      );
    }
    const mesh = new THREE.Mesh(merge(wood), SOLID);
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
  }

  update(dt: number): void {
    const { builder } = this;
    const { world } = builder.ctx;
    const lit = builder.aims.map((a) => a.shelf).filter((h) => !!h);
    this.slots.forEach((slots, bay) => {
      const owner = builder.shelfOwner(bay);
      const mine = !!owner && owner === builder.me;
      const color = (owner && world.getAs(Racer, owner.state.racer)?.state.color) ?? 0;
      slots.forEach((slot, i) => {
        const saved = builder.savedAt(bay, i);
        if (saved !== slot.bytes || color !== slot.color) this.show(slot, saved, color);
        const on = (action: ShelfAction) => lit.some((h) => h.bay === bay && h.slot === i && h.action === action);
        slot.plaque.material.color.setHex(on(ShelfAction.Save) ? LIT : mine ? 0xffffff : 0x6c6c6c);
        slot.panel.material.color.setHex(on(ShelfAction.Load) ? LIT : 0xffffff);
        slot.turntable.rotation.y += dt * (on(ShelfAction.Load) ? 2 : 0.5);
      });
    });
  }

  /** Put a model of a design in a cubby, scaled to fit, turning about its middle. */
  private show(slot: Slot, bytes: Uint8Array | null, color: number): void {
    slot.bytes = bytes;
    slot.color = color;
    if (slot.model) disposeRacer(slot.model);
    slot.model = null;
    slot.panel.visible = !bytes;
    if (!bytes) return;
    const design = cleanDesign(decodeDesign(bytes));
    const keep = design.map(() => true);
    const m = buildRacer(design, keep, color);
    m.label.visible = m.ready.visible = false;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let top = 0;
    for (const p of design) {
      x0 = Math.min(x0, p.x * CELL);
      x1 = Math.max(x1, p.x * CELL);
      y0 = Math.min(y0, p.y * CELL);
      y1 = Math.max(y1, p.y * CELL);
      top = Math.max(top, p.z * CELL + CELL / 2);
    }
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const radius = Math.max(...design.map((p) => Math.hypot(p.x * CELL - cx, p.y * CELL - cy))) + CELL * 0.75;
    const bottom = designStats(design).bottom;
    const s = Math.min(0.45 / radius, 0.8 / (top - bottom), 0.4);
    m.root.scale.setScalar(s);
    m.root.position.set(-cx * s, -bottom * s, -cy * s);
    slot.turntable.add(m.root);
    slot.model = m;
  }
}

function plane(w: number, h: number, map: THREE.Texture): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map }));
  // planes face +z; these face down the hill, +x
  mesh.rotation.y = Math.PI / 2;
  return mesh;
}

/** Text on a coloured card, a line per `\n`. */
function label(text: string, background: string, ink: string, w: number, h: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = text.split('\n');
  const size = Math.min(h / (lines.length + 0.6), (w / Math.max(...lines.map((l) => l.length))) * 1.2);
  ctx.font = `bold ${Math.round(size)}px Trebuchet MS, sans-serif`;
  lines.forEach((l, i) => ctx.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * size * 1.1));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
