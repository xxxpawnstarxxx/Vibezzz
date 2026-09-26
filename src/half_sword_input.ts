/** Mouse input for Half Sword mode: LMB / RMB held state, accumulated mouse
 *  motion (pointer lock when available) and wheel reach. Inactive unless
 *  `enabled` — the regular biped controls own the mouse otherwise. */

import type { HalfSwordControls } from "./runtime/half_sword.js";

export class HalfSwordInput {
  enabled = false;
  leftHeld = false;
  rightHeld = false;
  private dx = 0;
  private dy = 0;
  private wheel = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    // Per-button mousedown / mouseup fire even for chorded presses (a second
    // button while one is held only produces a pointermove).
    canvas.addEventListener("mousedown", (e) => {
      if (!this.enabled) return;
      if (e.button === 0) this.leftHeld = true;
      if (e.button === 2) this.rightHeld = true;
      if (e.button === 0 || e.button === 2) this.lock();
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.leftHeld = false;
      if (e.button === 2) this.rightHeld = false;
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.enabled || e.pointerType !== "mouse") return;
      // Clamp per-event motion: pointer-lock entry and some platforms emit
      // large bogus jumps that would fling the sword.
      this.dx += Math.max(-120, Math.min(120, e.movementX));
      this.dy += Math.max(-120, Math.min(120, e.movementY));
    });
    canvas.addEventListener("wheel", (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.wheel += e.deltaY;
    }, { passive: false });
    window.addEventListener("blur", () => { this.leftHeld = false; this.rightHeld = false; });
  }

  get locked(): boolean { return document.pointerLockElement === this.canvas; }

  /** `?nolock` in the URL keeps the cursor free (for environments where
   *  pointer lock misbehaves); plain mouse deltas still drive the hands. */
  private readonly allowLock = !new URLSearchParams(location.search).has("nolock");

  private lock(): void {
    if (this.locked || !this.allowLock) return;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch { /* pointer lock unavailable — plain mouse deltas still work */ }
  }

  release(): void {
    if (this.locked) document.exitPointerLock();
    this.leftHeld = this.rightHeld = false;
    this.dx = this.dy = this.wheel = 0;
  }

  /** Controls for this frame; clears the accumulated deltas. */
  consume(): HalfSwordControls {
    const c: HalfSwordControls = {
      dx: this.dx, dy: this.dy, wheel: this.wheel,
      leftHeld: this.leftHeld, rightHeld: this.rightHeld,
    };
    this.dx = this.dy = this.wheel = 0;
    return c;
  }
}
