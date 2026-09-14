import type { NetWorld } from '../net/world';

/** Drop-in DOM overlay showing replication health. Toggle with `visible`. */
export class NetDebugPanel {
  readonly el: HTMLDivElement;
  private last = 0;

  constructor(
    private readonly world: NetWorld,
    parent: HTMLElement = document.body,
    private readonly label = '',
  ) {
    this.el = document.createElement('div');
    Object.assign(this.el.style, {
      position: 'fixed',
      left: '8px',
      top: '8px',
      font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: '#d7ffd9',
      background: 'rgba(0,0,0,0.6)',
      padding: '6px 8px',
      borderRadius: '6px',
      whiteSpace: 'pre',
      pointerEvents: 'none',
      zIndex: '20',
    } satisfies Partial<CSSStyleDeclaration>);
    parent.appendChild(this.el);
  }

  set visible(v: boolean) {
    this.el.style.display = v ? 'block' : 'none';
  }

  get visible(): boolean {
    return this.el.style.display !== 'none';
  }

  update(now = performance.now()): void {
    if (!this.visible || now - this.last < 250) return;
    this.last = now;
    const s = this.world.stats;
    const f = this.world.focus;
    const kb = (b: number) => (b / 1024).toFixed(1);
    this.el.textContent = [
      `${this.label} id ${this.world.selfId.slice(0, 8)}`,
      `peers ${s.peers}  zone rooms ${s.rooms}  rtt ${s.avgRttMs.toFixed(0)}ms`,
      `entities owned ${s.owned}  remote ${s.remote}`,
      `up ${kb(s.bytesOutPerSec)} KB/s  down ${kb(s.bytesInPerSec)} KB/s`,
      `handoffs ${s.handoffs}  claims ${s.claims}  conflicts ${s.conflicts}`,
      f ? `focus ${f.x.toFixed(0)},${f.y.toFixed(0)}  r=${f.radius}` : 'focus -',
    ].join('\n');
  }

  dispose(): void {
    this.el.remove();
  }
}
