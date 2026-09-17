import * as THREE from 'three';
import { clamp } from '../crossplay/math';
import { Platform } from '../crossplay/platform';
import { Btn, type Rig, type XrPoseSource } from '../crossplay/rig';
import { VrSettings } from '../crossplay/settingsPanel';
import { SnapTurn, deadzone } from '../crossplay/vrControls';
import type { CaptainFrontend, CaptainRole } from './captain';
import { CaptainMarker, captainUsed, listenOverMap } from './captainDesktop';
import { WALL } from './castle';
import type { ShinobiContext, Vec3 } from './context';
import type { OrderKind } from './defs';
import { Call, idleCaptainIntent, stillCaptain, type CaptainIntent } from './intent';
import { Wrist } from './wrist';

const START_HEIGHT = 16;
const MIN_HEIGHT = 6;
const MAX_HEIGHT = 40;
const TRIGGER = 0.6;
const ARM_CYCLE: (Call | 'none')[] = [Call.Braziers, Call.Bell, Call.Reinforce, Call.MoveLord, 'none'];
const LASER_FROM = new THREE.Vector3(0, 0, -0.05);

/**
 * The captain in a headset: standing over the map of the castle like a table the size of a field, reaching into it with a
 * laser. The left stick walks you over it, the right snap-turns (left and right) and raises or lowers you (up and down).
 * Point the right hand: the trigger picks out a guard or makes the armed call, the grip sends the picked-out guards to
 * search there, A cycles the calls and B picks out all. The left trigger gathers the guards near where you point, the
 * left X has them stand watch there, and Y opens the settings.
 */
export class VrCaptain implements CaptainFrontend {
  readonly platform = Platform.Vr;
  private readonly intent = idleCaptainIntent();
  private readonly turn = new SnapTurn();
  private readonly wrist: Wrist;
  private readonly menu: VrSettings;
  private readonly marker: CaptainMarker;
  private readonly laser: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private height = START_HEIGHT;
  private readonly pos: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly head: Vec3 = { x: 0, y: 0, z: 0 };
  private refusal = { text: '', until: 0 };
  private placed = false;

  constructor(
    private readonly ctx: ShinobiContext,
    private readonly role: CaptainRole,
    private readonly rig: Rig,
    private readonly source: XrPoseSource,
    scene: THREE.Scene,
  ) {
    rig.setMode(source.mode);
    this.wrist = new Wrist(rig, ctx.hud, 'captain');
    this.menu = new VrSettings(ctx.settings, rig);
    this.marker = new CaptainMarker(ctx, scene);
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
    this.laser = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x6ad0ff, transparent: true, opacity: 0.7, depthWrite: false, fog: false }));
    this.laser.position.copy(LASER_FROM);
    rig.right.object.add(this.laser);
    ctx.hud.message('The castle lies before you. Point with your right hand; the trigger picks out guards, the grip sends them.');
  }

  dispose(): void {
    this.wrist.dispose();
    this.menu.dispose();
    this.marker.dispose();
    this.laser.removeFromParent();
    this.laser.geometry.dispose();
    this.laser.material.dispose();
  }

  read(dt: number): CaptainIntent {
    const { rig, intent } = this;
    this.source.read(rig, dt);
    stillCaptain(intent);
    const { left, right } = rig;
    if (!this.placed) {
      this.placed = true;
      rig.placeHeadAt(48, WALL.y0 - 4);
    }
    if (left.pressed(Btn.B)) this.menu.toggle();
    const onMenu = this.menu.update(this.ctx.now);

    const heading = rig.headHeading();
    const sx = deadzone(left.stickX);
    const sy = -deadzone(left.stickY);
    const speed = (6 + this.height * 0.5) * dt;
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    rig.shift((c * sy - s * sx) * speed, (s * sy + c * sx) * speed);
    this.turn.update(rig, right.stickX);
    this.height = clamp(this.height - deadzone(right.stickY) * 12 * dt, MIN_HEIGHT, MAX_HEIGHT);
    // the map is flattened, so a low stance is close enough to read it
    rig.root.position.y = this.height;
    rig.head(this.head);
    const cx = clamp(this.head.x, WALL.x0 - 12, WALL.x1 + 12);
    const cy = clamp(this.head.y, WALL.y0 - 12, WALL.y1 + 12);
    if (cx !== this.head.x || cy !== this.head.y) rig.shift(cx - this.head.x, cy - this.head.y);

    let ground: { x: number; y: number } | null = null;
    if (right.connected) {
      rig.handPose(right, LASER_FROM, this.pos, this.dir);
      if (this.dir.z < -0.02) {
        const k = -this.pos.z / this.dir.z;
        ground = { x: this.pos.x + this.dir.x * k, y: this.pos.y + this.dir.y * k };
        this.laser.scale.z = Math.min(200, k);
      } else {
        this.laser.scale.z = 30;
      }
    }
    this.laser.visible = right.connected && !onMenu;
    intent.pointer = ground;
    intent.focus.x = ground?.x ?? cx;
    intent.focus.y = ground?.y ?? cy;
    intent.reach = ground ? 1.4 + Math.hypot(ground.x - this.pos.x, ground.y - this.pos.y, this.pos.z) * 0.03 : 1.5;
    if (onMenu) return intent;

    intent.primary = right.trigger >= TRIGGER && right.pressed(Btn.Trigger);
    intent.secondary = right.pressed(Btn.Squeeze);
    intent.gather = left.pressed(Btn.Trigger);
    intent.selectAll = right.pressed(Btn.B);
    intent.post = left.pressed(Btn.A);
    if (right.pressed(Btn.A)) {
      const i = this.role.armed === null ? -1 : ARM_CYCLE.indexOf(this.role.armed);
      const next = ARM_CYCLE[(i + 1) % ARM_CYCLE.length];
      intent.arm = next === 'none' ? 'none' : next;
      this.ctx.sfx.play('arm');
    }
    return intent;
  }

  present(): void {
    const { ctx, role } = this;
    this.marker.update(this.intent.pointer, role);
    listenOverMap(ctx);
    ctx.hud.showCaptain(ctx, role, { place: 'Trigger where', pick: 'Trigger on your guards', send: 'Grip', bar: '' }, ctx.now < this.refusal.until ? this.refusal.text : '');
    this.wrist.update(ctx);
  }

  used(call: Call): void {
    captainUsed(this.ctx, call);
    this.rig.right.pulse(0.5, 60);
  }

  refused(reason: string): void {
    this.refusal = { text: reason, until: this.ctx.now + 1800 };
    this.ctx.sfx.play('nope');
    this.rig.right.pulse(0.2, 30);
  }

  ordered(x: number, y: number, kind: OrderKind): void {
    this.marker.ping(x, y, kind);
    this.rig.right.pulse(0.3, 30);
  }
}
