/** Sparring dummy: a biped that fences with its own simulated sword.
 *
 *  It drives the same HalfSword controller the player uses, but writes hand
 *  targets directly instead of mouse deltas, so its cuts get the same
 *  momentum, bounces and parries. Behaviour:
 *
 *    guard   → keeps measure (~1.5 m), circles a little, sword up, point
 *              drifting toward your blade
 *    windup  → chambers a cut (high right / high left / overhead) or pulls
 *              back for a half-sword thrust
 *    strike  → drives the hands through fast; the blade whips after them
 *    recover → back to guard
 *    block   → reads a fast incoming blade and puts its sword in the way
 *    stagger → after taking a hit: hands drop, steps back
 *    down    → health gone: sword lowered until it recovers
 */

import * as THREE from "three";
import type { HalfSword, HalfSwordControls } from "./half_sword.js";
import type { Fighter } from "./combat.js";
import type { Vec3 } from "../math/vec3.js";

type State = "guard" | "windup" | "strike" | "recover" | "block" | "stagger" | "down";
type Attack = "cutR" | "cutL" | "over" | "riseR" | "riseL" | "flatR" | "thrust" | "halfThrust";

/** Hand paths in the dummy's frame (x right, y up from chest, z forward).
 *  With the pivot-based blade aim the path defines the cut's angle. */
const ATTACKS: Record<Attack, { windup: [number, number, number]; strike: [number, number, number]; half?: boolean; thrust?: boolean }> = {
  cutR:       { windup: [0.42, 0.42, 0.18],  strike: [-0.22, -0.32, 0.6] },   // diagonal from the right
  cutL:       { windup: [-0.24, 0.45, 0.25], strike: [0.45, -0.3, 0.56] },    // diagonal from the left
  over:       { windup: [0.08, 0.5, 0.08],   strike: [0.06, -0.3, 0.66] },    // straight down
  riseR:      { windup: [0.4, -0.5, 0.25],   strike: [-0.2, 0.35, 0.58] },    // rising from low right
  riseL:      { windup: [-0.22, -0.5, 0.3],  strike: [0.42, 0.35, 0.55] },    // rising from low left
  flatR:      { windup: [0.5, 0.12, 0.12],   strike: [-0.26, 0.05, 0.62] },   // horizontal
  thrust:     { windup: [0.1, -0.05, 0.18],  strike: [0.06, 0.0, 0.7], thrust: true },
  halfThrust: { windup: [0.06, -0.02, 0.1],  strike: [0.04, 0.05, 0.72], half: true },
};
/** Natural follow-ups: a cut ends where the next one can start. */
const COMBOS: Partial<Record<Attack, Attack[]>> = {
  cutR: ["riseL", "cutL", "thrust"],
  cutL: ["riseR", "cutR", "flatR"],
  over: ["riseR", "thrust"],
  riseR: ["over", "cutR"],
  riseL: ["cutL", "over"],
  flatR: ["cutL", "thrust"],
};

export interface DummySettings {
  /** 0 = passive target, 1 = relentless. */
  aggression: number;
  /** Chance to read and block a fast incoming blade. */
  blockSkill: number;
  /** Whether the dummy attacks at all. */
  fightsBack: boolean;
  /** Scales the damage its blade deals. */
  power: number;
}

export class DummyAI {
  settings: DummySettings = { aggression: 0.55, blockSkill: 0.55, fightsBack: true, power: 0.6 };
  private state: State = "guard";
  private timer = 1.2;
  private attack: Attack = "cutR";
  /** Strikes left in the current combo. */
  private chain = 0;
  private feint = false;
  private circleDir = 1;
  private blockCooldown = 0;
  private lastHealth: number;
  private readonly guardOffset = new THREE.Vector3(0.1, 0.05, 0.4);

  constructor(readonly self: Fighter, private readonly sword: HalfSword) {
    this.lastHealth = self.health;
    sword.enabled = true;
    sword.mainSide = "Right";
  }

  get currentState(): State { return this.state; }

  update(dt: number, opponent: Fighter | null): void {
    const f = this.self;
    const hs = this.sword;
    f.damageScale = this.settings.power;
    this.timer -= dt;
    this.blockCooldown -= dt;

    // Took damage → stagger (or go down).
    if (f.health < this.lastHealth) this.enter(f.downTime > 0 ? "down" : "stagger", f.downTime > 0 ? f.downTime : 0.7);
    this.lastHealth = f.health;
    if (this.state === "down" && f.downTime <= 0) this.enter("recover", 0.8);

    // --- footwork --------------------------------------------------------
    const pos = f.agent.getPosition();
    let facing: Vec3 = [0, 0, 1];
    let vel: Vec3 = [0, 0, 0];
    if (opponent) {
      const op = opponent.agent.getPosition();
      const dx = op[0] - pos[0], dz = op[2] - pos[2];
      const dist = Math.hypot(dx, dz) || 1;
      const fx = dx / dist, fz = dz / dist;
      facing = [fx, 0, fz];
      let speed = 0;
      if (this.state === "down") speed = 0;
      else if (dist < 0.9) speed = -1.1;                        // never share a body
      else if (this.state === "stagger") speed = -0.6;
      else if (dist > 1.85) speed = 0.75;
      else if (dist < 1.2) speed = -0.55;
      else if (this.state === "strike") speed = 0.35;          // step into the cut
      const side = this.state === "guard" && dist < 2.2 ? 0.28 * this.circleDir : 0;
      vel = [fx * speed - fz * side, 0, fz * speed + fx * side];
      if (Math.random() < dt * 0.25) this.circleDir *= -1;

      // --- reading the opponent's blade ---------------------------------
      const os = opponent.sword;
      if (os?.ready && os.swordVisible && this.blockCooldown <= 0
        && (this.state === "guard" || this.state === "recover" || this.state === "windup")) {
        const g = new THREE.Vector3(), t = new THREE.Vector3();
        os.bladeSegment(g, t);
        const tipV = os.tipVelocity();
        const mid = g.clone().lerp(t, 0.6);
        const toMe = hs.chestPosition.clone().sub(mid);
        const incoming = tipV.length() > 3.2 && toMe.length() < 1.5 && tipV.dot(toMe) > 0;
        if (incoming) {
          this.blockCooldown = 0.55;
          if (Math.random() < this.settings.blockSkill) {
            // Put the blade across the incoming line, in the dummy's frame.
            const rel = mid.clone().sub(hs.chestPosition);
            this.guardOffset.set(
              THREE.MathUtils.clamp(rel.dot(hs.bodyRight) * 0.8, -0.25, 0.45),
              THREE.MathUtils.clamp(rel.y * 0.8 + 0.1, -0.35, 0.5),
              0.45,
            );
            this.enter("block", 0.45);
          }
        }
      }

      // --- choosing an attack ------------------------------------------
      if (this.state === "guard" && this.timer <= 0 && this.settings.fightsBack && dist < 2.0) {
        if (Math.random() < 0.35 + this.settings.aggression * 0.6) {
          const keys = Object.keys(ATTACKS) as Attack[];
          this.attack = keys[Math.floor(Math.random() * keys.length)];
          // Longer strings the more aggressive it is.
          this.chain = Math.random() < 0.25 + this.settings.aggression * 0.5 ? 1 + Math.floor(Math.random() * 2) : 0;
          this.feint = Math.random() < 0.15 + this.settings.aggression * 0.15;
          this.enter("windup", THREE.MathUtils.lerp(0.55, 0.3, this.settings.aggression));
        } else {
          this.timer = 0.5 + Math.random() * 0.6;
        }
      }
    }
    f.agent.setGoal(vel, facing);

    // Body language through the network's styles: wide fencing stance while
    // fighting, a limp when badly hurt, hunched over when down.
    const style = this.state === "down" ? "HandsBetweenLegs"
      : f.health < f.maxHealth * 0.35 ? "DragLeftLeg"
      : this.state === "stagger" ? "Neutral"
      : "LegsApart";
    if (f.agent.style !== style) f.agent.setStyle(style);

    // --- state machine on the hand target -------------------------------
    const o = hs.handOffset(hs.mainSide);
    let target = this.guardOffset;
    let rate = 5;
    let held = true;
    let thrust = false;
    hs.halfGrip = false;
    switch (this.state) {
      case "guard":
        target = this.guardOffset.lerp(new THREE.Vector3(0.1, 0.05, 0.4), 1 - Math.exp(-dt * 2));
        if (this.timer <= 0 && !this.settings.fightsBack) this.timer = 1;
        break;
      case "windup":
        target = new THREE.Vector3(...ATTACKS[this.attack].windup);
        hs.halfGrip = ATTACKS[this.attack].half ?? false;
        rate = 7;
        if (this.timer <= 0) {
          if (this.feint) {
            // Show one cut, throw another from the opposite side.
            this.feint = false;
            const alts = COMBOS[this.attack] ?? ["thrust"];
            this.attack = alts[Math.floor(Math.random() * alts.length)];
            this.enter("windup", 0.22);
          } else {
            this.enter("strike", ATTACKS[this.attack].thrust ? 0.28 : 0.32);
          }
        }
        break;
      case "strike":
        target = new THREE.Vector3(...ATTACKS[this.attack].strike);
        hs.halfGrip = ATTACKS[this.attack].half ?? false;
        thrust = ATTACKS[this.attack].thrust ?? false;
        rate = 16;
        if (this.timer <= 0) {
          const next = COMBOS[this.attack];
          if (this.chain > 0 && next) {
            this.chain--;
            this.attack = next[Math.floor(Math.random() * next.length)];
            this.enter("windup", 0.2);   // short re-chamber between combo cuts
          } else {
            this.enter("recover", 0.5);
          }
        }
        break;
      case "recover":
        target = new THREE.Vector3(0.1, 0.05, 0.4);
        rate = 4;
        if (this.timer <= 0) this.enter("guard", THREE.MathUtils.lerp(1.8, 0.5, this.settings.aggression) + Math.random() * 0.6);
        break;
      case "block":
        target = this.guardOffset;
        rate = 14;
        if (this.timer <= 0) this.enter("recover", 0.35);
        break;
      case "stagger":
        held = false;
        if (this.timer <= 0) this.enter("recover", 0.5);
        break;
      case "down":
        held = false;
        break;
    }
    if (held) o.lerp(target, 1 - Math.exp(-dt * rate));

    const controls: HalfSwordControls = { dx: 0, dy: 0, wheel: 0, leftHeld: held, rightHeld: held, thrust };
    hs.update(dt, controls);
  }

  private enter(state: State, time: number): void {
    this.state = state;
    this.timer = time;
  }
}
