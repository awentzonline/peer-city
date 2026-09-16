import * as THREE from 'three';
import { GRIP_IN_HAND, type Holsters } from '../crossplay/holsters';
import type { Inventory } from '../crossplay/inventory';
import { SOLID, box, buildTool, merge } from '../crossplay/models';
import type { Rig, XRHand } from '../crossplay/rig';
import type { Hud } from './hud';
import type { WildTool } from './kit';

/**
 * How near a hand has to be to the pack on your back to open it, and to something in it to take it out.
 * The pack owns this much of your back, so keep it well clear of where tools are stashed (kit.ts).
 */
const REACH = 0.15;
const SLOT_REACH = 0.12;
/** Grip hysteresis, as in holsters.ts. */
const GRIP_ON = 0.6;
const GRIP_OFF = 0.35;
/** Where the pack rides, and where its contents float when it's open, in torso space (+X right, +Y up, -Z forward). */
const ON_BACK = new THREE.Vector3(0, -0.15, 0.26);
const OPEN_AT = new THREE.Vector3(0, -0.34, -0.34);
const SLOT_GAP = 0.17;
const SLOT_SCALE = 0.55;

interface Slot {
  tool: WildTool;
  group: THREE.Group;
}

/**
 * The pack a headset player wears. Everything you gather goes in it rather than onto your body, so your
 * shoulders, back and belt stay for the tools you actually use (see crossplay/inventory.ts).
 *
 * Reach behind your shoulder and squeeze to swing it round: what's in it floats in front of your chest.
 * Squeeze an empty hand on one to take it out, and it goes back onto your body where that kind lives.
 * Let a tool go inside the open pack to put it away again.
 */
export class VrPack {
  private readonly bag: THREE.Mesh;
  private readonly slots: Slot[] = [];
  private open = false;
  private readonly gripping: [boolean, boolean] = [false, false];
  private readonly point = new THREE.Vector3();
  private readonly local = new THREE.Vector3();

  constructor(
    private readonly rig: Rig,
    private readonly holsters: Holsters,
    private readonly inventory: Inventory<WildTool>,
    private readonly hud: Hud,
  ) {
    this.bag = new THREE.Mesh(
      merge([
        box(0.26, 0.3, 0.14, 0, 0, 0.07, 0x5a3f28),
        box(0.2, 0.1, 0.05, 0, 0.12, 0.16, 0x7a5636), // flap
        box(0.05, 0.34, 0.06, -0.14, 0.02, -0.02, 0x4a3320), // straps over the shoulders
        box(0.05, 0.34, 0.06, 0.14, 0.02, -0.02, 0x4a3320),
      ]),
      SOLID,
    );
    this.bag.position.copy(ON_BACK);
    holsters.torso.object.add(this.bag);
    holsters.onLetGo = (tool, grip) => this.open && this.nearOpenPack(grip) && this.inventory.stow(tool as WildTool);
    holsters.claimed = (grip) => this.claims(grip);
  }

  /** Hands on the pack, and what's in it, once holsters have run for the frame. */
  update(): void {
    for (const hand of [this.rig.right, this.rig.left]) this.readHand(hand);
    this.layOut();
  }

  dispose(): void {
    this.holsters.onLetGo = null;
    this.holsters.claimed = null;
    this.bag.removeFromParent();
    this.bag.geometry.dispose();
    for (const slot of this.slots) slot.group.removeFromParent();
    this.slots.length = 0;
  }

  private readHand(hand: XRHand): void {
    const side = hand === this.rig.right ? 0 : 1;
    const gripping = hand.connected && hand.squeeze > (this.gripping[side] ? GRIP_OFF : GRIP_ON);
    const fresh = gripping && !this.gripping[side];
    this.gripping[side] = gripping;
    // a hand with a tool in it is grabbing, not rummaging; letting go inside the pack is what stows it
    if (!fresh || this.holsters.held(hand)) return;

    const grip = this.gripPoint(hand);
    if (this.onBag(grip)) {
      this.open = !this.open;
      hand.pulse(0.5, this.open ? 40 : 20);
      this.hud.message(this.open ? 'Pack open: take something out, or let a tool go in it' : 'Pack closed');
      return;
    }
    if (!this.open) return;
    for (const slot of this.slots) {
      if (!this.inSlot(grip, slot)) continue;
      this.inventory.takeOut(slot.tool);
      hand.pulse(0.7, 40);
      this.hud.message(`Took out the ${slot.tool.name.toLowerCase()}: it's on your body now`);
      return;
    }
  }

  /**
   * The pack and what's laid out in it are the pack's, not the holsters': an empty hand squeezing here is
   * opening it, closing it or taking something out, however near a stashed tool's shaft happens to reach.
   */
  private claims(grip: THREE.Vector3): boolean {
    return this.onBag(grip) || (this.open && this.slots.some((slot) => this.inSlot(grip, slot)));
  }

  private onBag(grip: THREE.Vector3): boolean {
    return grip.distanceTo(this.bag.getWorldPosition(this.local)) < REACH;
  }

  private inSlot(grip: THREE.Vector3, slot: Slot): boolean {
    return grip.distanceTo(slot.group.getWorldPosition(this.local)) < SLOT_REACH;
  }

  /** Whether a point is in the open pack's contents, so a tool let go there goes in. */
  private nearOpenPack(grip: THREE.Vector3): boolean {
    this.holsters.torso.object.updateMatrixWorld();
    const local = this.holsters.torso.object.worldToLocal(this.local.copy(grip));
    return local.distanceTo(OPEN_AT) < 0.35;
  }

  private gripPoint(hand: XRHand): THREE.Vector3 {
    return hand.object.localToWorld(this.point.copy(GRIP_IN_HAND));
  }

  /** Show what's in the pack while it's open, in a row across your chest. */
  private layOut(): void {
    const packed = this.open ? this.inventory.packed() : [];
    for (let i = this.slots.length - 1; i >= 0; i--) {
      if (packed.includes(this.slots[i].tool)) continue;
      this.slots[i].group.removeFromParent();
      this.slots.splice(i, 1);
    }
    for (const tool of packed) {
      if (this.slots.some((slot) => slot.tool === tool)) continue;
      const group = buildTool(tool);
      group.scale.setScalar(SLOT_SCALE);
      this.holsters.torso.object.add(group);
      this.slots.push({ tool, group });
    }
    this.slots.sort((a, b) => a.tool.id - b.tool.id);
    this.slots.forEach((slot, i) => {
      slot.group.position.copy(OPEN_AT);
      slot.group.position.x += (i - (this.slots.length - 1) / 2) * SLOT_GAP;
      slot.group.rotation.set(-Math.PI / 2, 0, 0); // tips up, so you see what each one is
    });
  }
}
