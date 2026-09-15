import * as THREE from 'three';
import { Weapon, weaponSpec } from './arsenal';
import type { Vec3 } from './context';
import { Holsters } from './holsters';
import { buildGun, gunMuzzle, setGunModel } from './models';
import type { Rig } from './rig';

const DESKTOP_GUN = new THREE.Vector3(0.17, -0.17, -0.45);
const v = new THREE.Vector3();

/** First-person guns: the one on the desktop camera, and a headset player's hands and holsters (`vr`). */
export class Hands {
  weapon = Weapon.Pistol;
  readonly vr: Holsters;
  private readonly muzzle = gunMuzzle(Weapon.Pistol);
  private readonly desktopGun = buildGun(Weapon.Pistol);
  private kick = 0;
  private kickScale = 1;

  constructor(rig: Rig) {
    this.vr = new Holsters(rig);
    this.desktopGun.position.copy(DESKTOP_GUN);
    this.desktopGun.scale.setScalar(0.7);
    rig.camera.add(this.desktopGun);
  }

  /** The desktop gun. */
  setWeapon(weapon: Weapon): void {
    if (weapon === this.weapon) return;
    this.weapon = weapon;
    gunMuzzle(weapon, this.muzzle);
    this.kickScale = Math.min(1.6, weaponSpec(weapon).kick);
    setGunModel(this.desktopGun, weapon);
  }

  recoil(): void {
    this.kick = 1;
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
    const k = this.kickScale;
    this.desktopGun.visible = showDesktop;
    this.kick *= Math.exp(-dt * 14);
    this.desktopGun.rotation.x = this.kick * 0.35 * k;
    this.desktopGun.position.z = DESKTOP_GUN.z + this.kick * 0.06 * k;
    this.vr.animate(dt, showVr);
  }
}
