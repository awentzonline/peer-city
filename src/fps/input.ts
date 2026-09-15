/** Keyboard and mouse with pointer lock. Edge-triggered presses last until `endFrame()`. */
export class DesktopInput {
  private readonly held = new Set<string>();
  private readonly edges = new Set<string>();
  private buttons = 0;
  private mdx = 0;
  private mdy = 0;
  locked = false;
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(private readonly el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (!e.repeat) this.edges.add(e.code);
      this.held.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => {
      this.held.clear();
      this.buttons = 0;
    });
    el.addEventListener('mousedown', (e) => {
      if (!this.locked) {
        this.requestLock();
        return;
      }
      this.buttons |= 1 << e.button;
      this.edges.add(`Mouse${e.button}`);
    });
    window.addEventListener('mouseup', (e) => (this.buttons &= ~(1 << e.button)));
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mdx += e.movementX;
      this.mdy += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) this.buttons = 0;
      this.onLockChange?.(this.locked);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  requestLock(): void {
    try {
      void Promise.resolve(this.el.requestPointerLock()).catch(() => {});
    } catch {
      /* pointer lock unavailable */
    }
  }

  down(code: string): boolean {
    return this.held.has(code);
  }

  pressed(code: string): boolean {
    return this.edges.has(code);
  }

  mouse(button: number): boolean {
    return (this.buttons & (1 << button)) !== 0;
  }

  /** Mouse movement since the last call. */
  consumeMouse(): [number, number] {
    const out: [number, number] = [this.mdx, this.mdy];
    this.mdx = this.mdy = 0;
    return out;
  }

  endFrame(): void {
    this.edges.clear();
  }
}
