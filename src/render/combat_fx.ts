/** Combat visuals: spark streaks for blade-on-blade, impact droplets for body
 *  hits, blade motion trails and camera shake. Everything is pooled and
 *  instanced — one draw per effect type. */

import * as THREE from "three";

interface Particle { p: THREE.Vector3; v: THREE.Vector3; life: number; max: number; size: number; stuck: boolean }

class ParticlePool {
  readonly mesh: THREE.InstancedMesh;
  private readonly parts: Particle[] = [];
  private next = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3(0, 0, 1);

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, count: number,
    private readonly opts: { gravity: number; drag: number; stretch: boolean; stick: boolean }) {
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < count; i++) {
      this.parts.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1, size: 1, stuck: false });
      this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
    }
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, life: number, size: number): void {
    const part = this.parts[this.next];
    this.next = (this.next + 1) % this.parts.length;
    part.p.copy(p); part.v.copy(v); part.life = part.max = life; part.size = size; part.stuck = false;
  }

  update(dt: number): void {
    for (let i = 0; i < this.parts.length; i++) {
      const pt = this.parts[i];
      if (pt.life <= 0) { this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0)); continue; }
      pt.life -= dt;
      if (!pt.stuck) {
        pt.v.y -= this.opts.gravity * dt;
        pt.v.multiplyScalar(Math.exp(-this.opts.drag * dt));
        pt.p.addScaledVector(pt.v, dt);
        if (pt.p.y < 0.004) {
          if (this.opts.stick) { pt.p.y = 0.003; pt.stuck = true; pt.life = Math.min(pt.life, 1.2); }
          else { pt.p.y = 0.004; pt.v.y *= -0.3; pt.v.x *= 0.5; pt.v.z *= 0.5; }
        }
      }
      const k = Math.max(pt.life / pt.max, 0);
      if (this.opts.stretch && !pt.stuck) {
        const speed = pt.v.length();
        this.q.setFromUnitVectors(this.fwd, speed > 1e-4 ? pt.v.clone().divideScalar(speed) : this.fwd);
        this.s.set(pt.size * k, pt.size * k, pt.size * (0.4 + speed * 0.12) * k);
      } else {
        this.q.identity();
        const flat = pt.stuck ? 1.8 : 1;
        this.s.set(pt.size * flat * (pt.stuck ? 1 : k), pt.size * (pt.stuck ? 0.15 : k), pt.size * flat * (pt.stuck ? 1 : k));
        if (pt.stuck) this.s.multiplyScalar(Math.min(1, pt.life * 2));
      }
      this.m.compose(pt.p, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Ribbon trail following one blade (guard → tip), fading with age and
 *  lighting up only on fast swings. */
export class BladeTrail {
  readonly mesh: THREE.Mesh;
  private readonly n = 18;
  private readonly guards: THREE.Vector3[] = [];
  private readonly tips: THREE.Vector3[] = [];
  private readonly speeds: number[] = [];
  private readonly times: number[] = [];
  private clock = 0;
  /** Trail length in seconds — time-based so it reads the same at any fps. */
  private readonly span = 0.12;
  private readonly pos: THREE.BufferAttribute;
  private readonly col: THREE.BufferAttribute;

  constructor(color = new THREE.Color(0.75, 0.85, 1.0)) {
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(this.n * 2 * 3), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(this.n * 2 * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.col.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.pos);
    geo.setAttribute("color", this.col);
    const idx: number[] = [];
    for (let i = 0; i < this.n - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    for (let i = 0; i < this.n; i++) {
      this.guards.push(new THREE.Vector3()); this.tips.push(new THREE.Vector3());
      this.speeds.push(0); this.times.push(-1);
    }
  }

  push(guard: THREE.Vector3, tip: THREE.Vector3, tipSpeed: number, visible: boolean, dt: number): void {
    this.clock += dt;
    if (!visible) { this.mesh.visible = false; this.speeds.fill(0); return; }
    // Shift history, newest first.
    const g = this.guards.pop()!, t = this.tips.pop()!;
    this.speeds.pop();
    this.times.pop();
    this.times.unshift(this.clock);
    // Trail only the outer 60% of the blade — reads as the cutting edge.
    this.guards.unshift(g.copy(guard).lerp(tip, 0.4));
    this.tips.unshift(t.copy(tip));
    this.speeds.unshift(tipSpeed);
    let any = false;
    for (let i = 0; i < this.n; i++) {
      this.guards[i].toArray(this.pos.array, i * 6);
      this.tips[i].toArray(this.pos.array, i * 6 + 3);
      const age = 1 - THREE.MathUtils.clamp((this.clock - this.times[i]) / this.span, 0, 1);
      const k = THREE.MathUtils.smoothstep(this.speeds[i], 5, 12) * age * age * 0.22;
      if (k > 0.01) any = true;
      for (let c = 0; c < 3; c++) {
        this.col.array[i * 6 + c] = k * 0.35;      // inner edge dimmer
        this.col.array[i * 6 + 3 + c] = k;
      }
    }
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
    this.mesh.visible = any;
  }
}

export class CombatFx {
  readonly group = new THREE.Group();
  private readonly sparks: ParticlePool;
  private readonly drops: ParticlePool;
  private readonly glints: ParticlePool;
  private shakeAmp = 0;
  private readonly shakeOffset = new THREE.Vector3();

  constructor() {
    this.sparks = new ParticlePool(
      new THREE.BoxGeometry(0.0035, 0.0035, 0.04),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.0, 0.7), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }),
      160, { gravity: 7, drag: 1.5, stretch: true, stick: false });
    this.glints = new ParticlePool(
      new THREE.SphereGeometry(0.03, 10, 6),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 2.2, 1.6), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }),
      8, { gravity: 0, drag: 0, stretch: false, stick: false });
    this.drops = new ParticlePool(
      new THREE.SphereGeometry(0.0055, 6, 4),
      new THREE.MeshStandardMaterial({ color: 0x3b0303, roughness: 0.55, metalness: 0, envMapIntensity: 0.25 }),
      220, { gravity: 9.8, drag: 0.6, stretch: false, stick: true });
    this.group.add(this.sparks.mesh, this.glints.mesh, this.drops.mesh);
  }

  /** Blade-on-blade: bright streaks spraying off the contact + a flash. */
  sparksAt(point: THREE.Vector3, normal: THREE.Vector3, intensity: number): void {
    const count = Math.round(THREE.MathUtils.clamp(10 + intensity * 5, 10, 40));
    for (let i = 0; i < count; i++) {
      const dir = normal.clone().multiplyScalar(Math.random() < 0.5 ? 1 : -1)
        .add(new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).multiplyScalar(1.6))
        .normalize();
      this.sparks.emit(point, dir.multiplyScalar(2 + Math.random() * (2 + intensity)), 0.25 + Math.random() * 0.35, 1);
    }
    this.glints.emit(point, new THREE.Vector3(), 0.08, 1 + intensity * 0.08);
  }

  /** Body hit: droplets thrown along the blade's travel. */
  impactAt(point: THREE.Vector3, dir: THREE.Vector3, intensity: number): void {
    const count = Math.round(THREE.MathUtils.clamp(6 + intensity * 3, 6, 30));
    for (let i = 0; i < count; i++) {
      const v = dir.clone().multiplyScalar(0.8 + Math.random() * 1.6)
        .add(new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).multiplyScalar(1.3));
      this.drops.emit(point, v, 1.8 + Math.random() * 1.2, 0.6 + Math.random() * 1.1);
    }
  }

  shake(amount: number): void { this.shakeAmp = Math.min(this.shakeAmp + amount, 0.08); }

  update(dt: number): void {
    this.sparks.update(dt);
    this.glints.update(dt);
    this.drops.update(dt);
  }

  /** Take last frame's shake off the camera (call before camera follow). */
  removeShake(camera: THREE.Camera): void {
    camera.position.sub(this.shakeOffset);
    this.shakeOffset.set(0, 0, 0);
  }

  /** Add this frame's shake (call right before rendering). */
  addShake(camera: THREE.Camera, dt: number): void {
    this.shakeAmp *= Math.exp(-dt * 9);
    if (this.shakeAmp < 1e-4) return;
    this.shakeOffset.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(this.shakeAmp * 2);
    camera.position.add(this.shakeOffset);
  }
}
