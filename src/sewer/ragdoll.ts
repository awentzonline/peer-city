import * as THREE from 'three';
import { SOLID, merge, paint } from '../crossplay/models';
import { FixedStep, GRAVITY, RAPIER, collisionGroups, sceneQuat, type Quat } from '../crossplay/rigid';
import { SplatKind } from './defs';
import { VOX } from './fatberg';
import { GOBLIN_PARTS, goblinRig, restGoblin, type PartName } from './models';
import { CHAMBER_HEIGHT, Cell, SIZE, TUNNEL_HEIGHT, WALK_HEIGHT, type SewerMap } from './sewer';

/** How long a body lingers before it sinks away, and is gone, s. */
const LINGER = 7;
const SINK = 3;
/** Most sets of bodies at once: the oldest go first. */
const MAX_SETS = 14;
/** Floating: how buoyant a body is in the sewage (1 floats just awash), and how thick the muck is. */
const BUOYANCY = 1.35;
const WATER_DRAG = 3.2;

const WORLD = 1;
const LIMBS = 2;

interface Piece {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  /** Half its size, for how much of it's under the sewage. */
  half: number;
}

interface Bunch {
  pieces: Piece[];
  joints: RAPIER.ImpulseJoint[];
  age: number;
}

const v = new THREE.Vector3();
const q = new THREE.Quaternion();
const sq = new THREE.Quaternion();
const wq: Quat = { x: 0, y: 0, z: 0, w: 1 };

/** A scene position as a world one (z up). */
function toWorld(p: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: p.x, y: p.z, z: p.y };
}

/** A scene rotation as a world one: the same swap of y and z as positions (see crossplay/rigid.ts `sceneQuat`). */
function worldQuat(s: THREE.Quaternion): Quat {
  wq.x = -s.x;
  wq.y = -s.z;
  wq.z = -s.y;
  wq.w = s.w;
  return wq;
}

/**
 * Ragdolls and debris, on this peer only: nobody else needs to see them land in the same place. A small Rapier world
 * with the sewer's floors, walls and ceilings in it, where splattered goblins fly, flop and float, torn halves go
 * their separate ways, burst ones rain down in pieces, and lumps of fat bob about in the sewage till they sink.
 */
export class Ragdolls {
  private readonly world: RAPIER.World;
  private readonly clock = new FixedStep(1 / 60, 4);
  private readonly sets: Bunch[] = [];
  private readonly fatGeo = paint(new THREE.BoxGeometry(VOX, VOX, VOX), 0xd8cc8a);
  private readonly fatMat = new THREE.MeshLambertMaterial({ color: 0xe0d49a });
  private readonly gibGeo = merge([paint(new THREE.BoxGeometry(0.1, 0.07, 0.08), 0x5a6a2a), paint(new THREE.BoxGeometry(0.05, 0.05, 0.06).translate(0.05, 0.03, 0), 0x8a2a1a)]);
  water = 0.35;

  constructor(
    private readonly scene: THREE.Scene,
    map: SewerMap,
  ) {
    this.world = new RAPIER.World({ x: 0, y: 0, z: -GRAVITY });
    this.world.timestep = this.clock.step;
    this.buildSewer(map);
  }

  /** Floors, walls and ceilings, as runs of cells along each row. */
  private buildSewer(map: SewerMap): void {
    const add = (x0: number, x1: number, j: number, z0: number, z1: number) => {
      const w = x1 - x0;
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(w / 2, 0.5, (z1 - z0) / 2)
          .setTranslation(x0 + w / 2, j + 0.5, (z0 + z1) / 2)
          .setFriction(0.8)
          .setRestitution(0.15)
          .setCollisionGroups(collisionGroups(WORLD, LIMBS)),
      );
    };
    const kind = (i: number, j: number): number => {
      const c = map.cell(i, j);
      if (c === Cell.Rock) return 0;
      return c === Cell.Walk ? 2 : 1;
    };
    for (let j = 0; j < SIZE; j++) {
      let i = 0;
      while (i < SIZE) {
        const k = kind(i, j);
        const ceil = map.ceiling[j * SIZE + i];
        let e = i + 1;
        while (e < SIZE && kind(e, j) === k && map.ceiling[j * SIZE + e] === ceil) e++;
        if (k === 0) add(i, e, j, -1, CHAMBER_HEIGHT + 1);
        else {
          add(i, e, j, -1, k === 2 ? WALK_HEIGHT : 0);
          add(i, e, j, ceil || TUNNEL_HEIGHT, ceil + 2);
        }
        i = e;
      }
    }
  }

  /** A goblin splattered at (x, y, z), facing `angle`: flung whole, torn in half, or burst into pieces. */
  splat(kind: SplatKind, look: number, x: number, y: number, z: number, angle: number, vx: number, vy: number, vz: number): void {
    const rig = goblinRig(look);
    restGoblin(rig);
    rig.root.position.set(x, z, y);
    rig.root.rotation.y = -angle;
    if (kind === SplatKind.Tear) {
      // arms flung up, as if pulled apart by them
      rig.pivots.armL.rotation.z = 2.4;
      rig.pivots.armR.rotation.z = 2.4;
    }
    rig.root.updateMatrixWorld(true);
    const ragdoll = kind !== SplatKind.Gib;
    const pieces = new Map<PartName, Piece>();
    const set: Bunch = { pieces: [], joints: [], age: 0 };
    const side = { x: -Math.sin(angle), y: Math.cos(angle) };
    const tearDir = Math.hypot(vx, vy) > 0.1 ? { x: vx / Math.hypot(vx, vy), y: vy / Math.hypot(vx, vy) } : side;
    for (const part of GOBLIN_PARTS) {
      const mesh = rig.meshes[part.name];
      mesh.getWorldPosition(v);
      mesh.getWorldQuaternion(q);
      const at = toWorld(v);
      let lx = vx;
      let ly = vy;
      let lz = vz;
      if (kind === SplatKind.Tear) {
        // the top half one way, the bottom the other
        const top = part.name === 'torso' || part.name === 'head' || part.name === 'armL' || part.name === 'armR';
        const k = top ? 3.5 : -2.5;
        lx = tearDir.x * k;
        ly = tearDir.y * k;
        lz = top ? 3 : 1.5;
      } else if (kind === SplatKind.Gib) {
        const a = Math.random() * Math.PI * 2;
        const s = 2 + Math.random() * 5;
        lx = vx * 0.5 + Math.cos(a) * s;
        ly = vy * 0.5 + Math.sin(a) * s;
        lz = vz * 0.5 + 2 + Math.random() * 5;
      } else {
        lx += (Math.random() - 0.5) * 1.5;
        ly += (Math.random() - 0.5) * 1.5;
        lz += Math.random() * 1.5;
      }
      const piece = this.addBody(mesh, at, worldQuat(q), part.size, { x: lx, y: ly, z: lz }, 1.2);
      mesh.removeFromParent();
      this.scene.add(mesh);
      pieces.set(part.name, piece);
      set.pieces.push(piece);
    }
    if (ragdoll) {
      for (const part of GOBLIN_PARTS) {
        if (!part.parent) continue;
        if (kind === SplatKind.Tear && part.name === 'torso') continue;
        const a = pieces.get(part.parent)!;
        const b = pieces.get(part.name)!;
        rig.root.localToWorld(v.set(part.joint[0], part.joint[1], part.joint[2]));
        const joint = toWorld(v);
        set.joints.push(this.world.createImpulseJoint(RAPIER.JointData.spherical(this.local(a.body, joint), this.local(b.body, joint)), a.body, b.body, true));
      }
    } else {
      // and a scatter of smaller bits
      for (let n = 0; n < 8; n++) {
        const mesh = new THREE.Mesh(this.gibGeo, SOLID);
        this.scene.add(mesh);
        const a = Math.random() * Math.PI * 2;
        const s = 2 + Math.random() * 5;
        set.pieces.push(this.addBody(mesh, { x: x + Math.cos(a) * 0.2, y: y + Math.sin(a) * 0.2, z: z + 0.5 + Math.random() * 0.5 }, { x: 0, y: 0, z: 0, w: 1 }, [0.1, 0.07, 0.08], { x: Math.cos(a) * s, y: Math.sin(a) * s, z: 2 + Math.random() * 4 }, 0.9));
      }
    }
    this.push(set);
  }

  /** Lumps of fat came off the fatberg: these voxel centres, which float in the sewage. */
  lumps(centres: { x: number; y: number; z: number }[]): void {
    const set: Bunch = { pieces: [], joints: [], age: 0 };
    // one body a lump is plenty: sample the loose voxels down to a few dozen
    const step = Math.max(1, Math.ceil(centres.length / 40));
    for (let n = 0; n < centres.length; n += step) {
      const c = centres[n];
      const mesh = new THREE.Mesh(this.fatGeo, this.fatMat);
      const s = Math.min(2.2, Math.cbrt(step));
      mesh.scale.setScalar(s);
      this.scene.add(mesh);
      set.pieces.push(this.addBody(mesh, c, { x: 0, y: 0, z: 0, w: 1 }, [VOX * s, VOX * s, VOX * s], { x: (Math.random() - 0.5) * 1.2, y: (Math.random() - 0.5) * 1.2, z: Math.random() }, 0.45));
    }
    this.push(set);
  }

  private addBody(mesh: THREE.Object3D, at: { x: number; y: number; z: number }, rot: Quat, size: readonly [number, number, number], vel: { x: number; y: number; z: number }, density: number): Piece {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(at.x, at.y, at.z)
        .setRotation({ ...rot })
        .setLinvel(vel.x, vel.y, vel.z)
        .setAngvel({ x: (Math.random() - 0.5) * 8, y: (Math.random() - 0.5) * 8, z: (Math.random() - 0.5) * 8 })
        .setCcdEnabled(true),
    );
    // a part's box in the scene is (x, y up, z); in the world, y and z swap
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(size[0] / 2, size[2] / 2, size[1] / 2)
        .setDensity(density * 400)
        .setFriction(0.7)
        .setRestitution(0.2)
        .setCollisionGroups(collisionGroups(LIMBS, WORLD)),
      body,
    );
    return { body, mesh, half: Math.max(size[0], size[1], size[2]) / 2 };
  }

  /** A world point in a body's own frame. */
  private local(body: RAPIER.RigidBody, p: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const t = body.translation();
    const r = body.rotation();
    q.set(r.x, r.y, r.z, r.w).invert();
    v.set(p.x - t.x, p.y - t.y, p.z - t.z).applyQuaternion(q);
    return { x: v.x, y: v.y, z: v.z };
  }

  private push(set: Bunch): void {
    this.sets.push(set);
    while (this.sets.length > MAX_SETS) this.remove(this.sets.shift()!);
  }

  private remove(set: Bunch): void {
    for (const p of set.pieces) {
      this.world.removeRigidBody(p.body);
      p.mesh.removeFromParent();
    }
  }

  update(dt: number): void {
    if (!this.sets.length) return;
    this.clock.run(dt, (step) => {
      for (const set of this.sets) {
        const sinking = set.age > LINGER;
        for (const p of set.pieces) {
          const t = p.body.translation();
          const under = Math.min(1, Math.max(0, (this.water - (t.z - p.half)) / (2 * p.half)));
          if (under <= 0) continue;
          const mass = p.body.mass();
          const lift = sinking ? 0.4 : BUOYANCY;
          p.body.applyImpulse({ x: 0, y: 0, z: lift * GRAVITY * mass * under * step }, true);
          const lv = p.body.linvel();
          const k = Math.max(0, 1 - WATER_DRAG * under * step);
          p.body.setLinvel({ x: lv.x * k, y: lv.y * k, z: lv.z * k }, true);
          const av = p.body.angvel();
          p.body.setAngvel({ x: av.x * k, y: av.y * k, z: av.z * k }, true);
        }
      }
      this.world.step();
    });
    for (let i = this.sets.length - 1; i >= 0; i--) {
      const set = this.sets[i];
      set.age += dt;
      if (set.age > LINGER + SINK) {
        this.remove(set);
        this.sets.splice(i, 1);
        continue;
      }
      for (const p of set.pieces) {
        const t = p.body.translation();
        p.mesh.position.set(t.x, t.z, t.y);
        p.mesh.quaternion.copy(sceneQuat(p.body.rotation(), sq));
      }
    }
  }
}
