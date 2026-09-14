import Phaser from 'phaser';

interface Tracer {
  x: number;
  y: number;
  x2: number;
  y2: number;
  life: number;
}

const MAX_DECALS = 160;

/** Purely local visual effects, triggered by replicated state and actions. */
export class Effects {
  private tracers: Tracer[] = [];
  private gfx: Phaser.GameObjects.Graphics;
  private sparksEmitter: Phaser.GameObjects.Particles.ParticleEmitter;
  private fireEmitter: Phaser.GameObjects.Particles.ParticleEmitter;
  private smokeEmitter: Phaser.GameObjects.Particles.ParticleEmitter;
  private decals: Phaser.GameObjects.Image[] = [];

  constructor(private readonly scene: Phaser.Scene) {
    this.gfx = scene.add.graphics().setDepth(8).setBlendMode(Phaser.BlendModes.ADD);
    this.sparksEmitter = scene.add
      .particles(0, 0, 'soft', {
        speed: { min: 60, max: 260 },
        lifespan: { min: 150, max: 380 },
        scale: { start: 0.14, end: 0 },
        tint: [0xfff3b0, 0xffc04d],
        blendMode: 'ADD',
        emitting: false,
      })
      .setDepth(8);
    this.fireEmitter = scene.add
      .particles(0, 0, 'soft', {
        speed: { min: 20, max: 340 },
        lifespan: { min: 250, max: 750 },
        scale: { start: 1.1, end: 0.1 },
        alpha: { start: 0.95, end: 0 },
        tint: [0xffe08a, 0xff9a3c, 0xff5a1f],
        blendMode: 'ADD',
        emitting: false,
      })
      .setDepth(9);
    this.smokeEmitter = scene.add
      .particles(0, 0, 'soft', {
        speed: { min: 8, max: 40 },
        lifespan: { min: 900, max: 1800 },
        scale: { start: 0.35, end: 1.3 },
        alpha: { start: 0.45, end: 0 },
        tint: [0x333333, 0x555555, 0x222222],
        emitting: false,
      })
      .setDepth(7);
  }

  tracer(x: number, y: number, angle: number, dist: number): void {
    const x2 = x + Math.cos(angle) * dist;
    const y2 = y + Math.sin(angle) * dist;
    this.tracers.push({ x, y, x2, y2, life: 1 });
    this.sparksEmitter.explode(4, x2, y2);
    this.sparksEmitter.explode(2, x, y);
  }

  sparks(x: number, y: number, count = 10): void {
    this.sparksEmitter.explode(count, x, y);
  }

  smoke(x: number, y: number, count = 1): void {
    this.smokeEmitter.explode(count, x, y);
  }

  fire(x: number, y: number, count = 1): void {
    this.fireEmitter.explode(count, x, y);
  }

  explosion(x: number, y: number): void {
    this.fireEmitter.explode(40, x, y);
    this.smokeEmitter.explode(18, x, y);
    this.sparksEmitter.explode(30, x, y);
    const flash = this.scene.add.image(x, y, 'glow').setDepth(9).setBlendMode(Phaser.BlendModes.ADD).setScale(2.5);
    this.scene.tweens.add({ targets: flash, alpha: 0, scale: 4, duration: 450, onComplete: () => flash.destroy() });
    this.decal('blood', x, y, 2.2, 0x111111, 0.7);
    const cam = this.scene.cameras.main;
    const d = Math.hypot(cam.midPoint.x - x, cam.midPoint.y - y);
    if (d < 900) cam.shake(300, 0.012 * (1 - d / 900));
  }

  blood(x: number, y: number): void {
    this.decal('blood', x, y, 0.9 + Math.random() * 0.4);
  }

  skid(x: number, y: number, angle: number): void {
    const img = this.decal('px', x, y, 1, 0x111111, 0.35);
    img.setDisplaySize(10, 22).setRotation(angle);
  }

  private decal(key: string, x: number, y: number, scale: number, tint = 0xffffff, alpha = 1): Phaser.GameObjects.Image {
    const img = this.scene.add
      .image(x, y, key)
      .setDepth(2)
      .setScale(scale)
      .setRotation(Math.random() * Math.PI * 2)
      .setTint(tint)
      .setAlpha(alpha);
    this.decals.push(img);
    if (this.decals.length > MAX_DECALS) this.decals.shift()!.destroy();
    return img;
  }

  update(dt: number): void {
    const g = this.gfx;
    g.clear();
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt * 9;
      if (t.life <= 0) {
        this.tracers.splice(i, 1);
        continue;
      }
      g.lineStyle(2, 0xfff2a8, t.life);
      g.lineBetween(t.x, t.y, t.x2, t.y2);
    }
  }
}
