/** Rotate each arm's mesh about the mesh's own shoulder pivot.
 *
 *  The biped network (and its Geno skeleton) puts the LeftArm/RightArm joint
 *  well inside the torso. Geno's mannequin mesh was built around that, but a
 *  realistic body's glenohumeral joint sits ~7 cm further out. Skinned about
 *  Geno's pivot, a raised or forward arm swings the deltoid into the chest
 *  and the upper arm sinks into the torso.
 *
 *  For characters that carry a `meshPivot` on their arm bones (baked by
 *  tools/build-human.mjs), each frame we:
 *    1. find where the mesh pivot `h` rides with the clavicle (P),
 *    2. re-seat the upper-arm transform so its rotation happens about P,
 *    3. shift the whole lower arm (forearm, hand, fingers, helpers) by the
 *       same offset so the elbow stays attached.
 *  The rotations the network (or the arm IK) chose are untouched. Arms that
 *  were already solved about the pivot (HalfSword's IK) come out unchanged —
 *  the correction is idempotent.
 */

import * as THREE from "three";

export interface ArmPivot {
  clavicle: number;
  arm: number;
  /** Mesh pivot in bind (skin) space. */
  pivot: THREE.Vector3;
  /** Pivot in the clavicle's bind-local frame. */
  pivotInClavicle: THREE.Vector3;
  /** Bone indices of the arm's descendants (forearm down), cascade order. */
  lower: number[];
}

export function compileArmPivots(
  pivots: ReadonlyMap<string, THREE.Vector3>,
  boneNameToIndex: ReadonlyMap<string, number>,
  boneInverses: readonly THREE.Matrix4[],
  parents: readonly number[],
): ArmPivot[] {
  const out: ArmPivot[] = [];
  for (const side of ["Left", "Right"]) {
    const pivot = pivots.get(`${side}Arm`);
    const arm = boneNameToIndex.get(`${side}Arm`);
    const clavicle = boneNameToIndex.get(`${side}Shoulder`);
    if (!pivot || arm === undefined || clavicle === undefined) continue;
    const lower: number[] = [];
    const stack = parents.map((p, i) => (p === arm ? i : -1)).filter((i) => i >= 0);
    while (stack.length) {
      const i = stack.shift()!;
      lower.push(i);
      parents.forEach((p, c) => { if (p === i) stack.push(c); });
    }
    out.push({
      clavicle, arm, lower, pivot: pivot.clone(),
      pivotInClavicle: pivot.clone().applyMatrix4(boneInverses[clavicle]),
    });
  }
  return out;
}

/** World position the mesh pivot rides to with the clavicle. */
export function pivotPosition(a: ArmPivot, world: readonly THREE.Matrix4[], out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(a.pivotInClavicle).applyMatrix4(world[a.clavicle]);
}

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _t = new THREE.Vector3(), _d = new THREE.Vector3();

export function applyArmPivots(world: THREE.Matrix4[], arms: readonly ArmPivot[], boneInverses: readonly THREE.Matrix4[]): void {
  for (const a of arms) {
    // Skinning matrix of the upper arm: M = W·B⁻¹ = [R | t].
    _m.multiplyMatrices(world[a.arm], boneInverses[a.arm]);
    pivotPosition(a, world, _p);
    _t.setFromMatrixPosition(_m);
    // Desired M' = T(P)·R·T(-h)  →  translation P − R·h.
    _d.copy(a.pivot).applyMatrix4(_m).sub(_t);      // R·h
    _d.negate().add(_p).sub(_t);                     // δ = (P − R·h) − t
    if (_d.lengthSq() < 1e-12) continue;
    world[a.arm].elements[12] += _d.x; world[a.arm].elements[13] += _d.y; world[a.arm].elements[14] += _d.z;
    for (const i of a.lower) {
      world[i].elements[12] += _d.x; world[i].elements[13] += _d.y; world[i].elements[14] += _d.z;
    }
  }
}
