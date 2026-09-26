/** A deliberately simple longsword: tapered blade, crossguard, wrapped grip
 *  and pommel. Origin is the main hand's grip, +Y runs toward the tip, +X is
 *  the edge-to-edge (width) axis. */

import * as THREE from "three";
import { SWORD } from "../runtime/half_sword.js";

export function createSword(): THREE.Group {
  const steel = new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 1, roughness: 0.28 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x5b5f66, metalness: 1, roughness: 0.45 });
  const leather = new THREE.MeshStandardMaterial({ color: 0x3a2517, metalness: 0, roughness: 0.85 });

  const group = new THREE.Group();
  group.name = "Sword";
  group.userData.steel = steel;
  group.userData.blood = 0;

  // Blade: guard (y = 0.07) → tip (y = bladeLength), narrowing to a point.
  const bladeStart = 0.07;
  const bladeLen = SWORD.bladeLength - bladeStart;
  const bladeGeo = new THREE.BoxGeometry(0.046, bladeLen, 0.008, 1, 8, 1);
  const pos = bladeGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) + bladeLen / 2) / bladeLen;  // 0 at guard, 1 at tip
    const taper = t < 0.85 ? 1 - 0.35 * t : (1 - 0.35 * 0.85) * (1 - (t - 0.85) / 0.15);
    pos.setX(i, pos.getX(i) * Math.max(taper, 0.02));
    // Diamond cross-section: thin toward the edges.
    pos.setZ(i, pos.getZ(i) * (Math.abs(pos.getX(i)) > 0.005 ? 0.35 : 1));
  }
  bladeGeo.translate(0, bladeStart + bladeLen / 2, 0);
  bladeGeo.computeVertexNormals();
  group.add(new THREE.Mesh(bladeGeo, steel));

  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.022, 0.03), iron);
  guard.position.y = 0.06;
  group.add(guard);

  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.017, 0.21, 12), leather);
  grip.position.y = -0.045;
  group.add(grip);

  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 10), iron);
  pommel.scale.set(1, 0.8, 0.7);
  pommel.position.y = -0.17;
  group.add(pommel);

  group.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  group.visible = false;
  return group;
}

const CLEAN = new THREE.Color(0xc9ced6);
const BLOODY = new THREE.Color(0x4a0606);

/** Blood on the blade (0…1): per-module paint, like Half Sword's vertex
 *  paint — here a tint + roughness shift on the steel. */
export function setSwordBlood(sword: THREE.Object3D, amount: number): void {
  const a = THREE.MathUtils.clamp(amount, 0, 1);
  sword.userData.blood = a;
  const steel = sword.userData.steel as THREE.MeshStandardMaterial | undefined;
  if (!steel) return;
  steel.color.copy(CLEAN).lerp(BLOODY, a * 0.75);
  steel.roughness = 0.28 + a * 0.35;
  steel.metalness = 1 - a * 0.45;
}
