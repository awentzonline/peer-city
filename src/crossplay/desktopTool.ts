import * as THREE from 'three';
import type { Vec3 } from './math';
import { buildTool, setToolModel, toolTip } from './models';
import type { Rig } from './rig';
import type { Tool } from './tool';

/** Where the view's hand holds a tool, in camera space, and how big the tool is drawn. */
const HAND = new THREE.Vector3(0.17, -0.17, -0.45);
const SCALE = 0.7;
const v = new THREE.Vector3();

/** The desktop first-person tool, held in front of the camera. A headset player's tools are in holsters.ts. */
export class DesktopTool {
  tool: Tool<any> | null = null;
  /** Made by buildTool, on the camera. Games may pose it further between `update` and rendering. */
  readonly model = buildTool(null);
  private readonly tip = new THREE.Vector3();
  private kick = 0;
  private kickScale = 1;

  constructor(rig: Rig) {
    this.model.position.copy(HAND);
    this.model.scale.setScalar(SCALE);
    rig.camera.add(this.model);
  }

  setTool(tool: Tool<any> | null): void {
    if (tool === this.tool) return;
    this.tool = tool;
    setToolModel(this.model, tool);
    if (tool) toolTip(tool, this.tip);
  }

  dispose(): void {
    this.model.removeFromParent();
  }

  /** Kick the tool back, `kick` times as hard as a pistol. */
  recoil(kick: number): void {
    if (kick <= 0) return;
    this.kick = 1;
    this.kickScale = Math.min(1.6, kick);
  }

  /** World position of the tool's tip, or null with nothing in hand. */
  tipWorld(out: Vec3): Vec3 | null {
    if (!this.tool) return null;
    this.model.updateWorldMatrix(true, false);
    v.copy(this.tip).applyMatrix4(this.model.matrixWorld);
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
    this.model.position.set(HAND.x, HAND.y, HAND.z + this.kick * 0.06 * k);
  }
}
