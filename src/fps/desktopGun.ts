import * as THREE from 'three';
import { Weapon, weaponSpec } from './arsenal';
import type { Vec3 } from './context';
import { buildGun, gunMuzzle, setGunModel } from './models';
import type { Rig } from './rig';

const OFFSET = new THREE.Vector3(0.17, -0.17, -0.45);
const v = new THREE.Vector3();

/** The desktop first-person gun, held in front of the camera. A headset player's guns are in holsters.ts. */
export class DesktopGun {
  weapon = Weapon.Pistol;
  private readonly muzzle = gunMuzzle(Weapon.Pistol);
  private readonly model = buildGun(Weapon.Pistol);
  private kick = 0;
  private kickScale = 1;

  constructor(rig: Rig) {
    this.model.position.copy(OFFSET);
    this.model.scale.setScalar(0.7);
    rig.camera.add(this.model);
  }

  setWeapon(weapon: Weapon): void {
    if (weapon === this.weapon) return;
    this.weapon = weapon;
    gunMuzzle(weapon, this.muzzle);
    this.kickScale = Math.min(1.6, weaponSpec(weapon).kick);
    setGunModel(this.model, weapon);
  }

  dispose(): void {
    this.model.removeFromParent();
  }

  recoil(): void {
    this.kick = 1;
  }

  /** World position of the muzzle. */
  muzzleWorld(out: Vec3): Vec3 {
    this.model.updateWorldMatrix(true, false);
    v.copy(this.muzzle).applyMatrix4(this.model.matrixWorld);
    out.x = v.x;
    out.y = v.z;
    out.z = v.y;
    return out;
  }

  update(dt: number, visible: boolean): void {
    const k = this.kickScale;
    this.model.visible = visible;
    this.kick *= Math.exp(-dt * 14);
    this.model.rotation.x = this.kick * 0.35 * k;
    this.model.position.z = OFFSET.z + this.kick * 0.06 * k;
  }
}
