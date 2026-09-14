import Phaser from 'phaser';
import type { EntityViews, NetEntity } from '@engine/index';
import type { GameContext } from './context';
import { Car, CarKind, CarMode, Ped, PedMode, Pickup, PickupKind, Player } from './defs';
import { COP_SKINS, PED_SKINS, carSize, carTextureKey } from './textures';

const LABEL_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'Trebuchet MS, sans-serif',
  fontSize: '13px',
  color: '#ffffff',
  stroke: '#000000',
  strokeThickness: 3,
};

interface HumanView {
  shadow: Phaser.GameObjects.Image;
  body: Phaser.GameObjects.Image;
  ring?: Phaser.GameObjects.Image;
  label?: Phaser.GameObjects.Text;
  lastX: number;
  lastY: number;
  phase: number;
  dead: boolean;
}

function createHuman(ctx: GameContext, e: NetEntity<{ x: number; y: number }>, texture: string, withLabel: boolean, isMe: boolean): HumanView {
  const { scene } = ctx;
  const view: HumanView = {
    shadow: scene.add.image(e.x + 3, e.y + 4, 'shadow').setDepth(4).setScale(0.55),
    body: scene.add.image(e.x, e.y, texture).setDepth(5),
    lastX: e.x,
    lastY: e.y,
    phase: Math.random() * 10,
    dead: false,
  };
  if (withLabel) {
    view.ring = scene.add
      .image(e.x, e.y, 'ring')
      .setDepth(4)
      .setScale(0.7)
      .setTint(isMe ? 0x7dff8a : 0x4fc3ff)
      .setAlpha(0.8);
    view.label = scene.add.text(e.x, e.y - 26, '', LABEL_STYLE).setOrigin(0.5, 1).setDepth(10);
  }
  return view;
}

function updateHuman(ctx: GameContext, v: HumanView, x: number, y: number, angle: number, dead: boolean, hidden: boolean, dt: number) {
  const moved = Math.hypot(x - v.lastX, y - v.lastY);
  v.lastX = x;
  v.lastY = y;
  const visible = !hidden;
  v.body.setVisible(visible);
  v.shadow.setVisible(visible && !dead);
  v.ring?.setVisible(visible && !dead);
  v.label?.setVisible(visible);
  if (!visible) return;

  if (dead && !v.dead) {
    v.dead = true;
    ctx.fx.blood(x, y);
    v.body.setTint(0xb07070).setDepth(3);
  } else if (!dead && v.dead) {
    v.dead = false;
    v.body.clearTint().setDepth(5);
  }
  v.body.setPosition(x, y).setRotation(angle);
  if (!dead) {
    const speed = moved / Math.max(dt, 0.001);
    v.phase += Math.min(speed, 260) * dt * 0.09;
    const bob = speed > 5 ? 1 + Math.sin(v.phase) * 0.07 : 1;
    v.body.setScale(bob, 1);
  } else {
    v.body.setScale(1.1, 0.8);
  }
  v.shadow.setPosition(x + 3, y + 4);
  v.ring?.setPosition(x, y);
  v.label?.setPosition(x, y - 18);
}

function destroyHuman(v: HumanView) {
  v.body.destroy();
  v.shadow.destroy();
  v.ring?.destroy();
  v.label?.destroy();
}

interface CarView {
  shadow: Phaser.GameObjects.Image;
  body: Phaser.GameObjects.Image;
  siren: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  wrecked: boolean;
  fxTimer: number;
}

export function registerViews(ctx: GameContext, views: EntityViews): void {
  const { scene, world } = ctx;

  views.register(Player, {
    create: (e) => createHuman(ctx, e, `ped${e.state.skin % PED_SKINS}`, true, e === ctx.me),
    update: (v, e, dt) => {
      const s = e.render;
      if (v.label && v.label.text !== s.name) v.label.setText(s.name);
      updateHuman(ctx, v, e.x, e.y, s.angle, s.hp === 0, s.car !== 0, dt);
    },
    destroy: (v) => destroyHuman(v),
  });

  views.register(Ped, {
    create: (e) => createHuman(ctx, e, e.state.cop ? `cop${e.state.skin % COP_SKINS}` : `ped${e.state.skin % PED_SKINS}`, false, false),
    update: (v, e, dt) => updateHuman(ctx, v, e.x, e.y, e.render.angle, e.render.mode === PedMode.Dead, false, dt),
    destroy: (v) => destroyHuman(v),
  });

  views.register(Car, {
    create: (e): CarView => {
      const { w, h } = carSize(e.state.kind);
      return {
        shadow: scene.add.image(e.x + 5, e.y + 6, 'shadow').setDepth(5).setDisplaySize(w * 1.1, h * 1.5),
        body: scene.add.image(e.x, e.y, carTextureKey(e.state.kind, e.state.color)).setDepth(6),
        siren: scene.add.image(e.x, e.y, 'glow').setDepth(7).setBlendMode(Phaser.BlendModes.ADD).setScale(0.5).setVisible(false),
        label: scene.add.text(e.x, e.y, '', LABEL_STYLE).setOrigin(0.5, 1).setDepth(10),
        wrecked: false,
        fxTimer: 0,
      };
    },
    update: (v, e, dt) => {
      const s = e.render;
      v.body.setPosition(e.x, e.y).setRotation(s.angle);
      v.shadow.setPosition(e.x + 5, e.y + 6).setRotation(s.angle);

      const wrecked = s.mode === CarMode.Wrecked;
      if (wrecked !== v.wrecked) {
        v.wrecked = wrecked;
        if (wrecked) v.body.setTint(0x2a2a2a);
        else v.body.clearTint();
      }

      v.fxTimer -= dt;
      if (v.fxTimer <= 0) {
        if (wrecked) {
          ctx.fx.fire(e.x + (Math.random() - 0.5) * 20, e.y + (Math.random() - 0.5) * 12);
          ctx.fx.smoke(e.x, e.y);
          v.fxTimer = 0.08;
        } else if (s.hp < 35) {
          ctx.fx.smoke(e.x + Math.cos(s.angle) * 20, e.y + Math.sin(s.angle) * 20);
          if (s.hp < 15) ctx.fx.fire(e.x + Math.cos(s.angle) * 20, e.y + Math.sin(s.angle) * 20);
          v.fxTimer = s.hp < 15 ? 0.1 : 0.25;
        } else {
          v.fxTimer = 0.3;
        }
      }

      const siren = s.siren && s.kind === CarKind.Police && !wrecked;
      v.siren.setVisible(siren);
      if (siren) {
        const blue = Math.floor(ctx.now / 180) % 2 === 0;
        v.siren.setPosition(e.x, e.y).setTint(blue ? 0x3b6bff : 0xff2e2e);
      }

      const driver = s.driver ? world.getAs(Player, s.driver) : undefined;
      const name = driver && s.mode === CarMode.Driven ? driver.render.name : '';
      if (v.label.text !== name) v.label.setText(name);
      v.label.setPosition(e.x, e.y - 22).setVisible(name !== '');
    },
    destroy: (v, e, reason) => {
      if (reason === 'destroyed' && v.wrecked) ctx.fx.smoke(e.x, e.y, 6);
      v.body.destroy();
      v.shadow.destroy();
      v.siren.destroy();
      v.label.destroy();
    },
  });

  views.register(Pickup, {
    create: (e) => ({
      glow: scene.add
        .image(e.x, e.y, 'glow')
        .setDepth(3)
        .setScale(0.35)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(e.state.kind === PickupKind.Cash ? 0x6eff7a : 0xff6b6b),
      icon: scene.add.image(e.x, e.y, e.state.kind === PickupKind.Cash ? 'cash' : 'health').setDepth(3),
      t: Math.random() * 6,
    }),
    update: (v, e, dt) => {
      v.t += dt * 3;
      v.icon.setPosition(e.x, e.y + Math.sin(v.t) * 2).setRotation(Math.sin(v.t * 0.5) * 0.2);
      v.glow.setPosition(e.x, e.y).setAlpha(0.6 + Math.sin(v.t) * 0.3);
    },
    destroy: (v) => {
      v.icon.destroy();
      v.glow.destroy();
    },
  });
}
