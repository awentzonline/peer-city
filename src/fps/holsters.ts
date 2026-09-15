import * as THREE from 'three';
import { MAX_OF_A_KIND, WEAPONS, Weapon, weaponSpec, type Inventory } from './arsenal';
import { buildGun, gunMuzzle } from './models';
import type { Rig, XRHand } from './rig';
import { Torso } from './torso';

/** Where a held gun's grip sits in a controller's target-ray space. */
export const GUN_IN_HAND = new THREE.Vector3(0, -0.03, 0.05);
/** How close (m) a hand has to be to a stashed gun to grab it. */
const REACH = 0.1;
/** Grip hysteresis, so a half-squeezed grip doesn't flicker between grabbing and letting go. */
const GRIP_ON = 0.6;
const GRIP_OFF = 0.35;

interface Pose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

function pose(x: number, y: number, z: number, pitch: number, roll = 0): Pose {
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, roll)).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, 0, 0)));
  return { position: new THREE.Vector3(x, y, z), quaternion };
}

const DOWN = -Math.PI / 2;
const UP = Math.PI / 2;
/**
 * Where your first and second gun of each kind are stashed when you get them, in torso space:
 * pistols on the hips, SMGs down the chest, long guns crossed on the back.
 */
const STARTING_SPOTS: Record<Weapon, Pose[]> = {
  [Weapon.Pistol]: [pose(0.22, -0.5, -0.05, DOWN), pose(-0.22, -0.5, -0.05, DOWN)],
  [Weapon.Smg]: [pose(0.14, -0.3, -0.16, DOWN), pose(-0.14, -0.3, -0.16, DOWN)],
  [Weapon.Shotgun]: [pose(0.1, -0.5, 0.27, UP, -0.2), pose(-0.1, -0.5, 0.27, UP, 0.2)],
  [Weapon.Rifle]: [pose(0.08, -0.35, 0.2, UP, -0.4), pose(-0.08, -0.35, 0.2, UP, 0.4)],
  [Weapon.Sniper]: [pose(0.1, -0.4, 0.3, UP, -0.25), pose(-0.1, -0.4, 0.3, UP, 0.25)],
};

interface Gun {
  weapon: Weapon;
  /** First or second of its kind, for its starting spot. */
  index: number;
  group: THREE.Group;
  laser: THREE.Line;
  /** Model bounds in the group's space, for reaching for it. */
  box: THREE.Box3;
  hand: HandState | null;
  kick: number;
  /** Where it was last stashed, in torso space. */
  spot: Pose;
}

interface HandState {
  hand: XRHand;
  glove: THREE.Mesh;
  gripping: boolean;
  gun: Gun | null;
  hover: Gun | null;
}

const point = new THREE.Vector3();
const local = new THREE.Vector3();

/**
 * A headset player's guns. Every gun you carry lives somewhere on your body.
 * Squeeze a grip near one to take it; let go with your hand on your torso and
 * it stays exactly there, or anywhere else and it goes back to where it was.
 */
export class Holsters {
  readonly torso: Torso;
  private readonly guns: Gun[] = [];
  private readonly hands: HandState[];
  private readonly muzzleOut = new THREE.Vector3();
  private readonly laserGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -30)]);
  private readonly laserMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });

  constructor(rig: Rig) {
    this.torso = new Torso(rig);
    this.laserGeo.setAttribute('color', new THREE.Float32BufferAttribute([1, 0.15, 0.15, 0, 0, 0], 3));
    const gloveGeo = new THREE.BoxGeometry(0.075, 0.08, 0.11);
    const gloveMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2e });
    this.hands = [rig.left, rig.right].map((hand) => {
      const glove = new THREE.Mesh(gloveGeo, gloveMat);
      glove.position.set(0, -0.09, 0.12);
      glove.visible = false;
      hand.object.add(glove);
      return { hand, glove, gripping: false, gun: null, hover: null };
    });
  }

  /** The gun in a hand, or null if it's empty. */
  held(hand: XRHand): Weapon | null {
    return this.state(hand).gun?.weapon ?? null;
  }

  /** Muzzle of the gun in a hand, in the controller's space. Shared: use it before calling again. */
  muzzle(hand: XRHand): THREE.Vector3 {
    const gun = this.state(hand).gun;
    this.muzzleOut.copy(GUN_IN_HAND);
    return gun ? this.muzzleOut.add(gunMuzzle(gun.weapon, local)) : this.muzzleOut;
  }

  recoil(hand: XRHand): void {
    const gun = this.state(hand).gun;
    if (gun) gun.kick = 1;
  }

  /** Follow the body, keep a gun on it for everything carried, and handle grabbing and stashing. */
  update(inventory: Inventory): void {
    this.torso.update();
    for (let w = 0; w < WEAPONS.length; w++) this.carry(w, inventory.count(w));

    for (const h of this.hands) {
      if (!h.hand.connected) continue;
      const gripping = h.hand.squeeze > (h.gripping ? GRIP_OFF : GRIP_ON);
      if (h.gun) {
        if (!gripping) this.stash(h);
      } else {
        const near = this.reachable(h);
        if (near && near !== h.hover) h.hand.pulse(0.2, 15);
        h.hover = near;
        if (gripping && !h.gripping && near) this.grab(h, near);
      }
      h.gripping = gripping;
    }
  }

  /** Recoil and visibility. `visible` is false outside VR and while dead. */
  animate(dt: number, visible: boolean): void {
    this.torso.object.visible = visible;
    const decay = Math.exp(-dt * 14);
    for (const h of this.hands) {
      h.glove.visible = visible && h.hand.connected;
      const gun = h.gun;
      if (!gun) continue;
      gun.group.visible = visible && h.hand.connected;
      const k = Math.min(1.6, weaponSpec(gun.weapon).kick);
      gun.kick *= decay;
      gun.group.rotation.x = gun.kick * 0.5 * k;
      gun.group.position.z = GUN_IN_HAND.z + gun.kick * 0.03 * k;
    }
  }

  private state(hand: XRHand): HandState {
    return this.hands[0].hand === hand ? this.hands[0] : this.hands[1];
  }

  private gripPoint(h: HandState): THREE.Vector3 {
    return h.hand.object.localToWorld(point.copy(GUN_IN_HAND));
  }

  /** The stashed gun nearest the hand, if any is within reach. */
  private reachable(h: HandState): Gun | null {
    const p = this.gripPoint(h);
    let best: Gun | null = null;
    let bestD = REACH;
    for (const gun of this.guns) {
      if (gun.hand) continue;
      const d = gun.box.distanceToPoint(gun.group.worldToLocal(local.copy(p)));
      if (d < bestD) {
        bestD = d;
        best = gun;
      }
    }
    return best;
  }

  private grab(h: HandState, gun: Gun): void {
    gun.hand = h;
    h.gun = gun;
    h.hover = null;
    h.hand.object.add(gun.group);
    gun.group.position.copy(GUN_IN_HAND);
    gun.group.quaternion.identity();
    gun.laser.visible = true;
    h.hand.pulse(0.6, 40);
  }

  private stash(h: HandState): void {
    const gun = h.gun!;
    h.gun = null;
    gun.hand = null;
    gun.kick = 0;
    gun.laser.visible = false;
    gun.group.visible = true;
    gun.group.position.copy(GUN_IN_HAND);
    gun.group.quaternion.identity();
    if (this.torso.contains(this.gripPoint(h))) {
      // stays exactly where you let go of it
      this.torso.object.attach(gun.group);
      gun.spot.position.copy(gun.group.position);
      gun.spot.quaternion.copy(gun.group.quaternion);
      h.hand.pulse(0.4, 30);
    } else {
      this.putBack(gun);
    }
  }

  private putBack(gun: Gun): void {
    this.torso.object.add(gun.group);
    gun.group.position.copy(gun.spot.position);
    gun.group.quaternion.copy(gun.spot.quaternion);
  }

  /** Add or remove guns of a kind to match the inventory, dropping stashed ones before held ones. */
  private carry(weapon: Weapon, want: number): void {
    let have = 0;
    for (const g of this.guns) if (g.weapon === weapon) have++;
    for (const heldToo of [false, true]) {
      for (let i = this.guns.length - 1; i >= 0 && have > want; i--) {
        const g = this.guns[i];
        if (g.weapon !== weapon || (g.hand && !heldToo)) continue;
        this.remove(g);
        have--;
      }
    }
    for (; have < Math.min(want, MAX_OF_A_KIND); have++) {
      const firstTaken = this.guns.some((g) => g.weapon === weapon && g.index === 0);
      this.add(weapon, firstTaken ? 1 : 0);
    }
  }

  private add(weapon: Weapon, index: number): void {
    const group = buildGun(weapon);
    const laser = new THREE.Line(this.laserGeo, this.laserMat);
    laser.position.copy(gunMuzzle(weapon));
    laser.visible = false;
    group.add(laser);
    const start = STARTING_SPOTS[weapon][index];
    const gun: Gun = {
      weapon,
      index,
      group,
      laser,
      box: (group.children[0] as THREE.Mesh).geometry.boundingBox!,
      hand: null,
      kick: 0,
      spot: { position: start.position.clone(), quaternion: start.quaternion.clone() },
    };
    this.guns.push(gun);
    this.putBack(gun);
  }

  private remove(gun: Gun): void {
    if (gun.hand) gun.hand.gun = null;
    for (const h of this.hands) if (h.hover === gun) h.hover = null;
    gun.group.removeFromParent();
    this.guns.splice(this.guns.indexOf(gun), 1);
  }
}
