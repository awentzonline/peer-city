/**
 * Keyboard and mouse. Edge-triggered presses last until `endFrame()`. The mouse is either captured with pointer lock
 * to look around (the default), or left free as a pointer over the page (`setCapture(false)`), for a role that points
 * at things on the screen, like an overseer's cursor.
 */
export class DesktopInput {
  private readonly held = new Set<string>();
  private readonly edges = new Set<string>();
  private buttons = 0;
  private mdx = 0;
  private mdy = 0;
  private wheelSteps = 0;
  private capture = true;
  locked = false;
  onLockChange: ((locked: boolean) => void) | null = null;
  /** Where the pointer is over the page, in CSS pixels, and whether it's over the game rather than off the window. */
  readonly pointer = { x: 0, y: 0, inside: false };
  private readonly downs = new Map<number, { x: number; y: number }>();

  constructor(private readonly el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (!e.repeat) this.edges.add(e.code);
      this.held.add(e.code);
      if (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => {
      this.held.clear();
      this.buttons = 0;
    });
    el.addEventListener('mousedown', (e) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.pointer.inside = true;
      if (this.capture && !this.locked) {
        this.requestLock();
        return;
      }
      this.buttons |= 1 << e.button;
      this.edges.add(`Mouse${e.button}`);
      this.downs.set(e.button, { x: e.clientX, y: e.clientY });
    });
    window.addEventListener('mouseup', (e) => (this.buttons &= ~(1 << e.button)));
    document.addEventListener('mousemove', (e) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.pointer.inside = true;
      if (!this.locked && this.capture) return;
      this.mdx += e.movementX;
      this.mdy += e.movementY;
    });
    document.documentElement.addEventListener('mouseleave', () => (this.pointer.inside = false));
    document.addEventListener(
      'wheel',
      (e) => {
        if ((this.locked || !this.capture) && e.deltaY) this.wheelSteps += Math.sign(e.deltaY);
      },
      { passive: true },
    );
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) this.buttons = 0;
      this.onLockChange?.(this.locked);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Whether the mouse is captured to look around (true) or left free as a pointer (false). */
  get capturing(): boolean {
    return this.capture;
  }

  /** Capture the mouse to look around, or leave it free as a pointer, letting go of any lock it has. */
  setCapture(capture: boolean): void {
    if (capture === this.capture) return;
    this.capture = capture;
    this.buttons = 0;
    if (!capture && document.pointerLockElement === this.el) document.exitPointerLock();
    this.onLockChange?.(this.locked);
  }

  /** Whether the mouse is where the game can use it: captured, or free over the page. */
  get ready(): boolean {
    return this.locked || !this.capture;
  }

  requestLock(): void {
    if (!this.capture) return;
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

  /** Where the pointer was when a button last went down, in CSS pixels: where a drag began, however fast it was. */
  downAt(button: number): { x: number; y: number } {
    return this.downs.get(button) ?? this.pointer;
  }

  /** Mouse movement since the last call. */
  consumeMouse(): [number, number] {
    const out: [number, number] = [this.mdx, this.mdy];
    this.mdx = this.mdy = 0;
    return out;
  }

  /** Wheel notches this frame: positive is scrolling down. */
  wheel(): number {
    return this.wheelSteps;
  }

  endFrame(): void {
    this.edges.clear();
    this.wheelSteps = 0;
  }
}
