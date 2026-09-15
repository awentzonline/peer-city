import * as THREE from 'three';
import { Weapon, weaponSpec } from './arsenal';
import type { Vec3 } from './context';
import { buildGun, gunMuzzle, setGunModel } from './models';
import type { Rig, XRHand } from './rig';

/** Where a gun's grip sits in a controller's target-ray space. */
const GUN_IN_HAND = new THREE.Vector3(0, -0.03, 0.05);
const DESKTOP_GUN = new THREE.Vector3(0.17, -0.17, -0.45);
const v = new THREE.Vector3();

interface VrGun {
  hand: XRHand;
  gun: THREE.Group;
  laser: THREE.Line;
  kick: number;
}

/** First-person guns: one on the desktop camera, one in each VR hand with a laser sight. */
export class Hands {
  weapon = Weapon.Pistol;
  readonly grip = GUN_IN_HAND;
  /** Muzzle position in a controller's target-ray space. */
  readonly handMuzzle = new THREE.Vector3();
  private readonly muzzle = gunMuzzle(Weapon.Pistol);
  private readonly desktopGun = buildGun(Weapon.Pistol);
  private desktopKick = 0;
  private kickScale = 1;
  private readonly vr: VrGun[] = [];

  constructor(rig: Rig) {
    this.handMuzzle.copy(GUN_IN_HAND).add(this.muzzle);
    this.desktopGun.position.copy(DESKTOP_GUN);
    this.desktopGun.scale.setScalar(0.7);
    rig.camera.add(this.desktopGun);

    const laserGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -30)]);
    laserGeo.setAttribute('color', new THREE.Float32BufferAttribute([1, 0.15, 0.15, 0, 0, 0], 3));
    const laserMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const gloveGeo = new THREE.BoxGeometry(0.075, 0.08, 0.11);
    const gloveMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2e });
    for (const hand of [rig.left, rig.right]) {
      const gun = buildGun(Weapon.Pistol);
      gun.position.copy(GUN_IN_HAND);
      const glove = new THREE.Mesh(gloveGeo, gloveMat);
      glove.position.set(0, -0.06, 0.07);
      const laser = new THREE.Line(laserGeo, laserMat);
      laser.position.copy(this.muzzle);
      gun.add(glove, laser);
      gun.visible = false;
      hand.object.add(gun);
      this.vr.push({ hand, gun, laser, kick: 0 });
    }
  }

  setWeapon(weapon: Weapon): void {
    if (weapon === this.weapon) return;
    this.weapon = weapon;
    gunMuzzle(weapon, this.muzzle);
    this.handMuzzle.copy(GUN_IN_HAND).add(this.muzzle);
    this.kickScale = Math.min(1.6, weaponSpec(weapon).kick);
    setGunModel(this.desktopGun, weapon);
    for (const g of this.vr) {
      setGunModel(g.gun, weapon);
      g.laser.position.copy(this.muzzle);
    }
  }

  recoil(hand?: XRHand): void {
    if (!hand) {
      this.desktopKick = 1;
      return;
    }
    const entry = this.vr.find((g) => g.hand === hand);
    if (entry) entry.kick = 1;
  }

  /** World position of the desktop gun's muzzle. */
  desktopMuzzle(out: Vec3): Vec3 {
    this.desktopGun.updateWorldMatrix(true, false);
    v.copy(this.muzzle).applyMatrix4(this.desktopGun.matrixWorld);
    out.x = v.x;
    out.y = v.z;
    out.z = v.y;
    return out;
  }

  update(dt: number, showDesktop: boolean, showVr: boolean): void {
    const decay = Math.exp(-dt * 14);
    const k = this.kickScale;
    this.desktopGun.visible = showDesktop;
    this.desktopKick *= decay;
    this.desktopGun.rotation.x = this.desktopKick * 0.35 * k;
    this.desktopGun.position.z = DESKTOP_GUN.z + this.desktopKick * 0.06 * k;
    for (const g of this.vr) {
      g.gun.visible = showVr && g.hand.connected;
      g.kick *= decay;
      g.gun.rotation.x = g.kick * 0.5 * k;
      g.gun.position.z = GUN_IN_HAND.z + g.kick * 0.03 * k;
    }
  }
}
