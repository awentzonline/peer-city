import * as THREE from 'three';
import type { Vec3 } from './context';
import { MUZZLE, buildPistol } from './models';
import type { Rig, XRHand } from './rig';

const GUN_IN_HAND = new THREE.Vector3(0, -0.03, 0.05);
/** Muzzle position in a controller's target-ray space. */
export const HAND_MUZZLE = GUN_IN_HAND.clone().add(MUZZLE);

const DESKTOP_GUN = new THREE.Vector3(0.17, -0.17, -0.45);
const v = new THREE.Vector3();

interface VrGun {
  hand: XRHand;
  gun: THREE.Group;
  kick: number;
}

/** First-person guns: one on the desktop camera, one in each VR hand with a laser sight. */
export class Hands {
  private readonly desktopGun = buildPistol();
  private desktopKick = 0;
  private readonly vr: VrGun[] = [];

  constructor(rig: Rig) {
    this.desktopGun.position.copy(DESKTOP_GUN);
    this.desktopGun.scale.setScalar(0.7);
    rig.camera.add(this.desktopGun);

    const laserGeo = new THREE.BufferGeometry().setFromPoints([MUZZLE, new THREE.Vector3(MUZZLE.x, MUZZLE.y, MUZZLE.z - 30)]);
    laserGeo.setAttribute('color', new THREE.Float32BufferAttribute([1, 0.15, 0.15, 0, 0, 0], 3));
    const laserMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const gloveGeo = new THREE.BoxGeometry(0.075, 0.08, 0.11);
    const gloveMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2e });
    for (const hand of [rig.left, rig.right]) {
      const gun = buildPistol();
      gun.position.copy(GUN_IN_HAND);
      const glove = new THREE.Mesh(gloveGeo, gloveMat);
      glove.position.set(0, -0.06, 0.07);
      gun.add(glove, new THREE.Line(laserGeo, laserMat));
      gun.visible = false;
      hand.object.add(gun);
      this.vr.push({ hand, gun, kick: 0 });
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
    v.copy(MUZZLE).applyMatrix4(this.desktopGun.matrixWorld);
    out.x = v.x;
    out.y = v.z;
    out.z = v.y;
    return out;
  }

  update(dt: number, showDesktop: boolean, showVr: boolean): void {
    const decay = Math.exp(-dt * 14);
    this.desktopGun.visible = showDesktop;
    this.desktopKick *= decay;
    this.desktopGun.rotation.x = this.desktopKick * 0.35;
    this.desktopGun.position.z = DESKTOP_GUN.z + this.desktopKick * 0.06;
    for (const g of this.vr) {
      g.gun.visible = showVr && g.hand.connected;
      g.kick *= decay;
      g.gun.rotation.x = g.kick * 0.5;
      g.gun.position.z = GUN_IN_HAND.z + g.kick * 0.03;
    }
  }
}
