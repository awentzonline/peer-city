import * as THREE from 'three';
import type { Inventory } from './inventory';
import { buildTool, toolForward, toolMesh, toolTip } from './models';
import type { Rig, XRHand } from './rig';
import type { StashSpot, Tool } from './tool';
import { Torso } from './torso';

/** Where a held tool's grip sits in a controller's target-ray space. */
export const GRIP_IN_HAND = new THREE.Vector3(0, -0.03, 0.05);
const FORWARD = new THREE.Vector3(0, 0, -1);
/** How close (m) a hand has to be to a stashed tool to grab it. */
const REACH = 0.1;
/** Grip hysteresis, so a half-squeezed grip doesn't flicker between grabbing and letting go. */
const GRIP_ON = 0.6;
const GRIP_OFF = 0.35;
/** For a tool that doesn't say where it goes: hanging down the front of the belly. */
const DEFAULT_SPOT: StashSpot = { at: [0.12, -0.45, -0.2], pitch: -Math.PI / 2 };

interface Pose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

function stashPose({ at, pitch = 0, roll = 0 }: StashSpot): Pose {
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, roll)).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, 0, 0)));
  return { position: new THREE.Vector3(at[0], at[1], at[2]), quaternion };
}

interface Carried {
  tool: Tool<any>;
  /** First, second, ... of its kind, for its starting spot. */
  index: number;
  /** Made by buildTool: the grip is its origin. */
  group: THREE.Group;
  laser: THREE.Line | null;
  hand: HandState | null;
  kick: number;
  kickScale: number;
  /** Where it was last stashed, in torso space. */
  spot: Pose;
}

interface HandState {
  hand: XRHand;
  glove: THREE.Mesh;
  gripping: boolean;
  /** Squeezing without taking anything: reaching for something in the world. */
  grabbing: boolean;
  item: Carried | null;
  hover: Carried | null;
}

const point = new THREE.Vector3();
const local = new THREE.Vector3();

/**
 * A headset player's tools. Every tool you carry lives somewhere on your body.
 * Squeeze a grip near one to take it; let go with your hand on your torso and
 * it stays exactly there, or anywhere else and it goes back to where it was.
 */
export class Holsters {
  readonly torso: Torso;
  /**
   * Let go of a tool somewhere that isn't the body: return true if something else took it (an open pack),
   * and it goes back where it was on the body until the inventory says it's gone.
   */
  onLetGo: ((tool: Tool<any>, grip: THREE.Vector3) => boolean) | null = null;
  private readonly items: Carried[] = [];
  private readonly hands: HandState[];
  private readonly tipOut = new THREE.Vector3();
  private readonly forwardOut = new THREE.Vector3();
  private readonly laserGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -30)]);
  private readonly laserMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  private readonly gloveGeo = new THREE.BoxGeometry(0.075, 0.08, 0.11);
  private readonly gloveMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2e });

  constructor(rig: Rig) {
    this.torso = new Torso(rig);
    this.laserGeo.setAttribute('color', new THREE.Float32BufferAttribute([1, 0.15, 0.15, 0, 0, 0], 3));
    this.hands = [rig.left, rig.right].map((hand) => {
      const glove = new THREE.Mesh(this.gloveGeo, this.gloveMat);
      glove.position.set(0, -0.09, 0.12);
      glove.visible = false;
      hand.object.add(glove);
      return { hand, glove, gripping: false, grabbing: false, item: null, hover: null };
    });
  }

  /** The tool in a hand, or null if it's empty. */
  held(hand: XRHand): Tool<any> | null {
    return this.state(hand).item?.tool ?? null;
  }

  /** The model of the tool in a hand (made by buildTool, so `toolMesh` is in the tool's own space), or null. */
  model(hand: XRHand): THREE.Group | null {
    return this.state(hand).item?.group ?? null;
  }

  /** Whether an empty hand is squeezing on nothing it carries, i.e. reaching for something in the world. */
  grabbing(hand: XRHand): boolean {
    return this.state(hand).grabbing;
  }

  /** The tip of the tool in a hand (or the grip, if it's empty), in the controller's space. Shared: use it before calling again. */
  tip(hand: XRHand): THREE.Vector3 {
    const item = this.state(hand).item;
    this.tipOut.copy(GRIP_IN_HAND);
    return item ? this.tipOut.add(toolTip(item.tool, local)) : this.tipOut;
  }

  /** Which way the tool in a hand points (or the controller, if it's empty), in the controller's space. Shared too. */
  forward(hand: XRHand): THREE.Vector3 {
    const item = this.state(hand).item;
    return item ? toolForward(item.tool, this.forwardOut) : this.forwardOut.copy(FORWARD);
  }

  /** Kick the tool in a hand back, `kick` times as hard as a pistol. */
  recoil(hand: XRHand, kick: number): void {
    const item = this.state(hand).item;
    if (!item || kick <= 0) return;
    item.kick = 1;
    item.kickScale = Math.min(1.6, kick);
  }

  /** Follow the body, keep a tool on it for everything carried to hand, and handle grabbing and stashing. */
  update(inventory: Inventory<any>): void {
    this.torso.update();
    // what's in the pack isn't on the body
    for (const tool of inventory.tools.all) this.carry(tool, inventory.inPack(tool) ? 0 : inventory.count(tool));

    for (const h of this.hands) {
      if (!h.hand.connected) {
        h.grabbing = false;
        continue;
      }
      const gripping = h.hand.squeeze > (h.gripping ? GRIP_OFF : GRIP_ON);
      if (h.item) {
        if (!gripping) this.stash(h);
      } else {
        const near = this.reachable(h);
        if (near && near !== h.hover) h.hand.pulse(0.2, 15);
        h.hover = near;
        if (gripping && !h.gripping && near) this.grab(h, near);
      }
      h.grabbing = gripping && !h.item && (h.grabbing || !h.gripping);
      h.gripping = gripping;
    }
  }

  /** Take the body, tools and gloves back off the rig. */
  dispose(): void {
    for (const item of this.items) item.group.removeFromParent(); // including any in a hand
    for (const h of this.hands) h.glove.removeFromParent();
    this.torso.dispose();
    this.laserGeo.dispose();
    this.laserMat.dispose();
    this.gloveGeo.dispose();
    this.gloveMat.dispose();
  }

  /** Recoil and visibility. `visible` is false while dead. */
  animate(dt: number, visible: boolean): void {
    this.torso.object.visible = visible;
    const decay = Math.exp(-dt * 14);
    for (const h of this.hands) {
      h.glove.visible = visible && h.hand.connected;
      const item = h.item;
      if (!item) continue;
      item.group.visible = visible && h.hand.connected;
      const k = item.kickScale;
      item.kick *= decay;
      item.group.rotation.x = item.kick * 0.5 * k;
      item.group.position.z = GRIP_IN_HAND.z + item.kick * 0.03 * k;
    }
  }

  private state(hand: XRHand): HandState {
    return this.hands[0].hand === hand ? this.hands[0] : this.hands[1];
  }

  private gripPoint(h: HandState): THREE.Vector3 {
    return h.hand.object.localToWorld(point.copy(GRIP_IN_HAND));
  }

  /** The stashed tool nearest the hand, if any is within reach. */
  private reachable(h: HandState): Carried | null {
    const p = this.gripPoint(h);
    let best: Carried | null = null;
    let bestD = REACH;
    for (const item of this.items) {
      if (item.hand) continue;
      const mesh = toolMesh(item.group);
      const d = mesh.geometry.boundingBox!.distanceToPoint(mesh.worldToLocal(local.copy(p)));
      if (d < bestD) {
        bestD = d;
        best = item;
      }
    }
    return best;
  }

  private grab(h: HandState, item: Carried): void {
    item.hand = h;
    h.item = item;
    h.hover = null;
    h.hand.object.add(item.group);
    item.group.position.copy(GRIP_IN_HAND);
    item.group.quaternion.identity();
    if (item.laser) item.laser.visible = true;
    h.hand.pulse(0.6, 40);
  }

  private stash(h: HandState): void {
    const item = h.item!;
    h.item = null;
    item.hand = null;
    item.kick = 0;
    if (item.laser) item.laser.visible = false;
    item.group.visible = true;
    item.group.position.copy(GRIP_IN_HAND);
    item.group.quaternion.identity();
    if (this.onLetGo?.(item.tool, this.gripPoint(h))) {
      this.putBack(item); // it stays on the body until the inventory drops it
      h.hand.pulse(0.4, 30);
    } else if (this.torso.contains(this.gripPoint(h))) {
      // stays exactly where you let go of it
      this.torso.object.attach(item.group);
      item.spot.position.copy(item.group.position);
      item.spot.quaternion.copy(item.group.quaternion);
      h.hand.pulse(0.4, 30);
    } else {
      this.putBack(item);
    }
  }

  private putBack(item: Carried): void {
    this.torso.object.add(item.group);
    item.group.position.copy(item.spot.position);
    item.group.quaternion.copy(item.spot.quaternion);
  }

  /** Add or remove tools of a kind to match the inventory, dropping stashed ones before held ones. */
  private carry(tool: Tool<any>, want: number): void {
    let have = 0;
    for (const item of this.items) if (item.tool === tool) have++;
    for (const heldToo of [false, true]) {
      for (let i = this.items.length - 1; i >= 0 && have > want; i--) {
        const item = this.items[i];
        if (item.tool !== tool || (item.hand && !heldToo)) continue;
        this.remove(item);
        have--;
      }
    }
    for (; have < Math.min(want, tool.max); have++) {
      let index = 0;
      while (this.items.some((item) => item.tool === tool && item.index === index)) index++;
      this.add(tool, index);
    }
  }

  private add(tool: Tool<any>, index: number): void {
    const group = buildTool(tool);
    let laser: THREE.Line | null = null;
    if (tool.laser) {
      // in the model's own space, so it leaves the tip whichever way the tool is held
      laser = new THREE.Line(this.laserGeo, this.laserMat);
      laser.position.set(tool.grip.tip[0], tool.grip.tip[1], tool.grip.tip[2]);
      laser.visible = false;
      toolMesh(group).add(laser);
    }
    const start = stashPose(tool.stash[Math.min(index, tool.stash.length - 1)] ?? DEFAULT_SPOT);
    const item: Carried = { tool, index, group, laser, hand: null, kick: 0, kickScale: 1, spot: start };
    this.items.push(item);
    this.putBack(item);
  }

  private remove(item: Carried): void {
    if (item.hand) item.hand.item = null;
    for (const h of this.hands) if (h.hover === item) h.hover = null;
    item.group.removeFromParent();
    this.items.splice(this.items.indexOf(item), 1);
  }
}
