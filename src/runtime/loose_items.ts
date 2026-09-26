/** Loose swords: dropped, disarmed or lying around to be picked up.
 *
 *  A light rigid-body sim — gravity, spin, ground contact with bounce and
 *  friction at the pommel / guard / tip, then settling flat on the floor.
 *  The sword's local frame matches render/sword.ts: origin at the grip,
 *  +Y toward the tip, +X across the guard.
 */

import * as THREE from "three";
import { SWORD } from "./half_sword.js";

const UP = new THREE.Vector3(0, 1, 0);
/** Contact points in sword space: pommel, guard ends, tip. */
const CONTACTS = [
  new THREE.Vector3(0, -0.17, 0),
  new THREE.Vector3(0.12, 0.06, 0), new THREE.Vector3(-0.12, 0.06, 0),
  new THREE.Vector3(0, SWORD.bladeLength, 0),
];
const REST_HEIGHT = 0.03;

export class LooseSword {
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  readonly angularVelocity = new THREE.Vector3();
  /** Seconds before it can be picked up again (just dropped / knocked away). */
  cooldown = 0;
  resting = false;
  /** Set while a hand is lifting it (grab in progress). */
  heldBy: string | null = null;

  constructor(readonly mesh: THREE.Object3D) {}

  /** Handle centre (what a hand grabs). */
  gripPoint(out = new THREE.Vector3()): THREE.Vector3 { return out.copy(this.position); }

  step(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.heldBy) return;
    if (this.resting && this.velocity.lengthSq() < 1e-6) return;
    const steps = 4, h = dt / steps;
    const p = new THREE.Vector3();
    for (let s = 0; s < steps; s++) {
      this.velocity.y -= 9.81 * h;
      this.position.addScaledVector(this.velocity, h);
      const w = this.angularVelocity.length();
      if (w > 1e-6) {
        this.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(this.angularVelocity.clone().divideScalar(w), w * h)).normalize();
      }
      // Ground contacts.
      let touching = 0;
      for (const c of CONTACTS) {
        p.copy(c).applyQuaternion(this.quaternion).add(this.position);
        if (p.y < REST_HEIGHT) {
          touching++;
          const pen = REST_HEIGHT - p.y;
          this.position.y += pen / 2;
          const r = p.clone().sub(this.position);
          const vAt = this.velocity.clone().add(new THREE.Vector3().crossVectors(this.angularVelocity, r));
          if (vAt.y < 0) {
            this.velocity.y += -vAt.y * 0.6;
            // Contact torque: the point that hits spins the blade.
            this.angularVelocity.add(new THREE.Vector3().crossVectors(r, UP).multiplyScalar(-vAt.y * 1.2));
          }
          // Friction.
          this.velocity.x *= Math.exp(-h * 6); this.velocity.z *= Math.exp(-h * 6);
        }
      }
      if (touching > 0) this.angularVelocity.multiplyScalar(Math.exp(-h * 5));
      if (touching >= 2) {
        // Settle flat: blade horizontal, flat of the blade facing up.
        const y = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion).setY(0);
        if (y.lengthSq() > 1e-6) {
          y.normalize();
          const z = UP.clone();
          const x = new THREE.Vector3().crossVectors(y, z);
          const flat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
          if (flat.dot(this.quaternion) < 0) flat.set(-flat.x, -flat.y, -flat.z, -flat.w);
          this.quaternion.slerp(flat, 1 - Math.exp(-h * 8));
        }
      }
    }
    if (this.position.y < REST_HEIGHT + 0.02 && this.velocity.length() < 0.05 && this.angularVelocity.length() < 0.1) {
      this.resting = true;
      this.velocity.set(0, 0, 0); this.angularVelocity.set(0, 0, 0);
    } else {
      this.resting = false;
    }
  }

  sync(): void {
    this.mesh.position.copy(this.position);
    this.mesh.quaternion.copy(this.quaternion);
  }
}
