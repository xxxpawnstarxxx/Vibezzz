/** Procedural combat sounds (Web Audio, no asset files).
 *
 *    clang  — inharmonic metal partials + a bright noise transient
 *    hit    — low thump + filtered noise body blow (sharper for thrusts)
 *    whoosh — band-passed noise sweep for fast swings
 *
 *  The AudioContext is created on the first user gesture (browser policy).
 */

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastWhoosh = new Map<string, number>();
  volume = 0.6;

  constructor() {
    const unlock = () => this.ensure();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
  }

  private ensure(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return this.ctx;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    // Gentle compression keeps stacked clangs from clipping.
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return this.ctx;
  }

  private noiseSource(ctx: AudioContext): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    return src;
  }

  /** Steel on steel. `intensity` ≈ contact speed in m/s. */
  clang(intensity: number): void {
    const ctx = this.ctx; if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const vol = Math.min(0.12 + intensity * 0.05, 0.55);
    const base = 620 + Math.random() * 260;
    for (const [ratio, amp, decay] of [[1, 1, 0.9], [2.76, 0.6, 0.6], [5.4, 0.4, 0.35], [8.93, 0.25, 0.2], [13.3, 0.15, 0.12]]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = base * ratio * (1 + (Math.random() - 0.5) * 0.01);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol * amp, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay * (0.7 + intensity * 0.05));
      osc.connect(g).connect(this.master);
      osc.start(t); osc.stop(t + decay * 1.5 + 0.1);
    }
    const n = this.noiseSource(ctx);
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 3500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol * 0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    n.connect(hp).connect(g).connect(this.master);
    n.start(t); n.stop(t + 0.08);
  }

  /** Blade into a body. */
  hit(intensity: number, thrust: boolean): void {
    const ctx = this.ctx; if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const vol = Math.min(0.25 + intensity * 0.06, 0.8);
    // Thump.
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(thrust ? 160 : 120, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(og).connect(this.master);
    osc.start(t); osc.stop(t + 0.2);
    // Wet body noise.
    const n = this.noiseSource(ctx);
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass";
    lp.frequency.setValueAtTime(thrust ? 2600 : 1600, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + 0.15);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol * 0.7, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    n.connect(lp).connect(g).connect(this.master);
    n.start(t); n.stop(t + 0.18);
  }

  /** Light tap when a slow blade just touches a body. */
  tap(): void {
    const ctx = this.ctx; if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const n = this.noiseSource(ctx);
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 900; bp.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.08, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    n.connect(bp).connect(g).connect(this.master);
    n.start(t); n.stop(t + 0.06);
  }

  /** Swing whoosh; call every frame with the tip speed, throttled per blade. */
  whoosh(key: string, tipSpeed: number): void {
    const ctx = this.ctx; if (!ctx || !this.master) return;
    if (tipSpeed < 6.5) return;
    const now = ctx.currentTime;
    if (now - (this.lastWhoosh.get(key) ?? 0) < 0.3) return;
    this.lastWhoosh.set(key, now);
    const n = this.noiseSource(ctx);
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 2.2;
    bp.frequency.setValueAtTime(350, now);
    bp.frequency.exponentialRampToValueAtTime(1100 + tipSpeed * 60, now + 0.12);
    bp.frequency.exponentialRampToValueAtTime(300, now + 0.28);
    const g = ctx.createGain();
    const vol = Math.min(0.05 + (tipSpeed - 6.5) * 0.02, 0.25);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(vol, now + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    n.connect(bp).connect(g).connect(this.master);
    n.start(now); n.stop(now + 0.32);
  }
}
