/** Sparring dummy — Half Sword's AI combat model on our simulated sword.
 *
 *  It drives the same HalfSword controller the player uses (hand targets
 *  instead of mouse deltas), so its cuts get the same momentum, edge
 *  alignment, bounces, parries and stuck blades.
 *
 *  Structure follows the Blueprint analysis (Vol. 01 §3, §4, §14):
 *
 *    range      MeleeCombatRange: Safe / Middle / Striking
 *    behaviour  AI_CombatBehavior: Retreat, Harass, Attack, Defend, Safe,
 *               Search Weapon — picked from range, health and equipment
 *    strafe     AI_Strafe: Straight or Circle
 *    attack     AI_AttackStage: Choose Hand → Set Up Intent → Charge
 *               (attack / thrust / forward lunge / tackle) → Swing /
 *               Reverse Swing / Thrust Release / Alt Grip (half-sword) →
 *               Parried / Riposte → Finish; Berserk at low health
 *
 *  Plus reactions to the newer systems: struggles free of grabs, wrenches a
 *  stuck blade out, fights on one-handed with a wrecked arm, limps on a
 *  wrecked leg, and goes looking for its sword when disarmed.
 */

import * as THREE from "three";
import type { HalfSword, HalfSwordControls, HandSide } from "./half_sword.js";
import type { Fighter } from "./combat.js";
import type { LooseSword } from "./loose_items.js";
import type { Vec3 } from "../math/vec3.js";

export type Behavior = "retreat" | "harass" | "attack" | "defend" | "safe" | "search";
export type Stage =
  | "idle" | "intent" | "charge" | "swing" | "reverse" | "thrust" | "altGrip"
  | "tackle" | "parried" | "finish" | "block" | "stagger" | "down" | "pickup" | "wrench";
type Range = "safe" | "middle" | "striking";
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
  halfThrust: { windup: [0.06, -0.02, 0.1],  strike: [0.04, 0.05, 0.72], half: true, thrust: true },
};
/** Reverse Swing: a cut ends where the next one can start. */
const COMBOS: Partial<Record<Attack, Attack[]>> = {
  cutR: ["riseL", "cutL", "thrust"],
  cutL: ["riseR", "cutR", "flatR"],
  over: ["riseR", "thrust"],
  riseR: ["over", "cutR"],
  riseL: ["cutL", "over"],
  flatR: ["cutL", "thrust"],
};
const GUARD = new THREE.Vector3(0.1, 0.05, 0.4);
const UP = new THREE.Vector3(0, 1, 0);

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

export interface DummyWorld {
  items: LooseSword[];
  pickUp(f: Fighter, item: LooseSword, side: HandSide): void;
  dropSword(f: Fighter): LooseSword | null;
  /** A tackle connected. */
  tackled(by: Fighter, target: Fighter): void;
}

export class DummyAI {
  settings: DummySettings = { aggression: 0.55, blockSkill: 0.55, fightsBack: true, power: 0.6 };
  behavior: Behavior = "safe";
  stage: Stage = "idle";
  berserk = false;
  private timer = 1.2;
  private behaviorTimer = 0;
  private attack: Attack = "cutR";
  private chain = 0;
  private feint = false;
  private strafe: "straight" | "circle" = "circle";
  private circleDir = 1;
  private blockCooldown = 0;
  private struggle = 0;
  private lastHealth: number;
  private readonly guardOffset = GUARD.clone();

  constructor(readonly self: Fighter, private readonly sword: HalfSword) {
    this.lastHealth = self.health;
    sword.enabled = true;
    sword.mainSide = "Right";
  }

  /** "behaviour · stage" for the HUD / debugging. */
  get currentState(): string { return `${this.behavior}${this.berserk ? " (berserk)" : ""} · ${this.stage}`; }

  update(dt: number, opponent: Fighter | null, world: DummyWorld): void {
    const f = this.self;
    const hs = this.sword;
    f.damageScale = this.settings.power * (this.berserk ? 1.35 : 1);
    this.timer -= dt;
    this.behaviorTimer -= dt;
    this.blockCooldown -= dt;
    const aggr = this.settings.aggression;
    const limbs = f.limbs;
    hs.disabled.Left = (limbs?.armL ?? 1) <= 0;
    hs.disabled.Right = (limbs?.armR ?? 1) <= 0;
    const legWrecked = (limbs?.legL ?? 1) <= 0 || (limbs?.legR ?? 1) <= 0;

    // A wrecked sword arm drops the sword; it'll pick it up with the other.
    if (hs.armed && hs.disabled[hs.mainSide]) world.dropSword(f);

    // --- reactions that pre-empt everything ---------------------------------
    if (f.health < this.lastHealth - 0.5 && this.stage !== "down") {
      this.enter("stagger", 0.35 + Math.min(0.4, (this.lastHealth - f.health) * 0.01));
    }
    this.lastHealth = f.health;
    if (f.downTime > 0) { if (this.stage !== "down") this.enter("down", f.downTime); }
    else if (this.stage === "down") this.enter("finish", 0.6);
    if ((f.stagger ?? 0) > 0 && this.stage !== "down" && this.stage !== "stagger") this.enter("stagger", f.stagger!);
    if ((f.parried ?? 0) > 0 && ["swing", "reverse", "thrust", "altGrip", "charge"].includes(this.stage)) {
      this.enter("parried", f.parried!);
    }
    // Held by someone: struggle, then wrench free.
    if ((f.grabbedBy ?? 0) > 0) {
      this.struggle += dt;
      if (this.struggle > THREE.MathUtils.lerp(2.4, 0.9, aggr) * (this.berserk ? 0.6 : 1)) {
        f.breakFree = true;
        this.struggle = 0;
      }
    } else {
      this.struggle = 0;
    }
    // Berserk: a final surge when badly hurt.
    if (!this.berserk && f.health < f.maxHealth * 0.3 && f.health > 0 && aggr > 0.25) this.berserk = true;
    if (f.health >= f.maxHealth) this.berserk = false;

    // --- perception ---------------------------------------------------------
    const pos = f.agent.getPosition();
    let facing: Vec3 = [0, 0, 1];
    let dist = Infinity, fx = 0, fz = 1;
    if (opponent) {
      const op = opponent.agent.getPosition();
      const dx = op[0] - pos[0], dz = op[2] - pos[2];
      dist = Math.hypot(dx, dz) || 1;
      fx = dx / dist; fz = dz / dist;
      facing = [fx, 0, fz];
    }
    const range: Range = dist < 1.45 ? "striking" : dist < 2.5 ? "middle" : "safe";

    // --- behaviour selection (AI_CombatBehavior) ------------------------------
    const busy = ["intent", "charge", "swing", "reverse", "thrust", "altGrip", "tackle", "stagger", "down", "parried", "pickup", "wrench"].includes(this.stage);
    const nearestItem = this.nearestItem(world.items, pos);
    if (this.behaviorTimer <= 0 && !busy) {
      this.behaviorTimer = 0.4;
      if (!hs.armed) this.behavior = nearestItem ? "search" : "retreat";
      else if (!this.settings.fightsBack) this.behavior = range === "striking" ? "defend" : "safe";
      else if (!this.berserk && f.health < f.maxHealth * 0.3 && Math.random() < 0.5) this.behavior = "retreat";
      else if (range === "striking") this.behavior = Math.random() < 0.3 + aggr * 0.55 + (this.berserk ? 0.3 : 0) ? "attack" : "defend";
      else if (range === "middle") this.behavior = Math.random() < 0.55 + aggr * 0.3 ? "harass" : "safe";
      else this.behavior = "safe";
      this.strafe = this.behavior === "harass" || (this.behavior === "defend" && Math.random() < 0.5) ? "circle" : "straight";
      if (Math.random() < 0.3) this.circleDir *= -1;
    }

    // Stuck in the opponent: wrench it out (pull back and wiggle).
    if (hs.isStuck && this.stage !== "down" && this.stage !== "stagger") this.stage = "wrench";
    else if (this.stage === "wrench") this.enter("finish", 0.3);

    // --- footwork ------------------------------------------------------------
    let speed = 0, side = 0;
    const want = this.behavior === "retreat" ? 3.4 : this.behavior === "safe" ? 2.2
      : this.behavior === "harass" ? 1.9 : 1.35;
    if (this.stage === "down" || this.stage === "pickup") speed = 0;
    else if (this.stage === "stagger" || this.stage === "parried") speed = -0.5;
    else if (this.stage === "tackle") speed = 2.4;
    else if (dist < 0.6) speed = -1.1;                                    // never share a body
    else if (!this.settings.fightsBack || (f.grabbedBy ?? 0) > 0) speed = 0; // training post / held: stand ground
    else if (this.stage === "charge" && ATTACKS[this.attack].thrust) speed = 1.4; // Charge Forward lunge
    else if (this.stage === "swing" || this.stage === "reverse") speed = 0.35;
    else if (dist > want + 0.25) speed = this.berserk ? 1.2 : 0.8;
    else if (dist < want - 0.25) speed = -0.6;
    if (this.strafe === "circle" && !busy && dist < 3) side = (this.behavior === "harass" ? 0.45 : 0.28) * this.circleDir;
    let vel: Vec3 = [fx * speed - fz * side, 0, fz * speed + fx * side];

    // Search Weapon: walk to the nearest loose sword and take it up.
    if (this.behavior === "search" && nearestItem && this.stage !== "down" && this.stage !== "stagger") {
      const ip = nearestItem.position;
      const ix = ip.x - pos[0], iz = ip.z - pos[2];
      const idist = Math.hypot(ix, iz) || 1;
      facing = [ix / idist, 0, iz / idist];
      if (idist > 0.55) vel = [ix / idist * 1.1, 0, iz / idist * 1.1];
      else {
        vel = [0, 0, 0];
        if (this.stage !== "pickup") this.enter("pickup", 0.55);
      }
    }
    if (legWrecked) { vel[0] *= 0.5; vel[2] *= 0.5; }
    if (f.push) { vel[0] += f.push.x; vel[2] += f.push.z; }
    f.agent.setGoal(vel, facing);

    // Body language through the network's styles.
    const style = this.stage === "down" ? "HandsBetweenLegs"
      : legWrecked || (f.health < f.maxHealth * 0.35 && !this.berserk) ? "DragLeftLeg"
      : this.stage === "stagger" ? "Neutral"
      : this.berserk ? "BigSteps"
      : "LegsApart";
    if (f.agent.style !== style) f.agent.setStyle(style);
    // Stoop to pick things up.
    const lean = this.stage === "pickup" ? 0.85 : 0;
    f.reactor.leanTarget.copy(new THREE.Vector3().crossVectors(UP, new THREE.Vector3(facing[0], 0, facing[2])).normalize().multiplyScalar(lean));

    // --- blade reading (Defend) -----------------------------------------------
    if (opponent && hs.armed) this.readThreat(opponent);

    // --- attack state machine (AI_AttackStage) ----------------------------------
    const speedK = this.berserk ? 0.7 : 1;
    if ((f.riposte ?? 0) > 0 && hs.armed && this.settings.fightsBack && (this.stage === "idle" || this.stage === "block" || this.stage === "finish")) {
      // Riposte: answer a successful parry immediately.
      f.riposte = 0;
      this.attack = Math.random() < 0.5 ? "thrust" : (Math.random() < 0.5 ? "cutR" : "cutL");
      this.chain = 0; this.feint = false;
      this.enter("charge", 0.12);
    }
    if (this.stage === "idle" && this.timer <= 0) {
      if (hs.armed && this.behavior === "attack" && range !== "safe") this.chooseAttack(dist);
      else if (hs.armed && this.behavior === "harass") {
        // Harass: a feint from the middle, sometimes carried through.
        this.attack = (["cutR", "cutL", "over", "thrust"] as Attack[])[Math.floor(Math.random() * 4)];
        this.feint = true; this.chain = 0;
        this.enter("intent", 0.35);
      } else this.timer = 0.3 + Math.random() * 0.4;
    }

    const o = hs.handOffset(hs.mainSide);
    let target = this.guardOffset;
    let rate = 5;
    let held = hs.armed;
    let thrust = false;
    hs.halfGrip = false;
    switch (this.stage) {
      case "idle":
        target = this.guardOffset.lerp(GUARD, 1 - Math.exp(-dt * 2));
        break;
      case "intent":
        // Set Up Intent: a readable telegraph — the chamber is shown.
        target = new THREE.Vector3(...ATTACKS[this.attack].windup).multiplyScalar(0.7).add(GUARD.clone().multiplyScalar(0.3));
        if (this.timer <= 0) {
          if (this.feint && this.behavior === "harass" && Math.random() < 0.6) this.enter("finish", 0.3);
          else this.enter("charge", THREE.MathUtils.lerp(0.4, 0.22, aggr) * speedK);
        }
        break;
      case "charge":
        target = new THREE.Vector3(...ATTACKS[this.attack].windup);
        hs.halfGrip = ATTACKS[this.attack].half ?? false;
        rate = 8;
        if (this.timer <= 0) {
          if (this.feint) {
            this.feint = false;
            const alts = COMBOS[this.attack] ?? ["thrust"];
            this.attack = alts[Math.floor(Math.random() * alts.length)];
            this.enter("charge", 0.2 * speedK);
          } else {
            const a = ATTACKS[this.attack];
            this.enter(a.half ? "altGrip" : a.thrust ? "thrust" : "swing", a.thrust ? 0.28 : 0.32);
          }
        }
        break;
      case "swing": case "reverse": case "thrust": case "altGrip": {
        const a = ATTACKS[this.attack];
        target = new THREE.Vector3(...a.strike);
        hs.halfGrip = a.half ?? false;
        thrust = (a.thrust ?? false) && !a.half;
        rate = 16;
        if (this.timer <= 0) {
          const next = COMBOS[this.attack];
          if (this.chain > 0 && next) {
            this.chain--;
            this.attack = next[Math.floor(Math.random() * next.length)];
            this.enter("charge", 0.18 * speedK);   // Reverse Swing: short re-chamber
            this.stage = "charge";
          } else {
            this.enter("finish", 0.45);
          }
        }
        break;
      }
      case "tackle":
        // Charge Tackle: shoulder into them.
        target = new THREE.Vector3(0.05, -0.1, 0.3);
        if (opponent && dist < 0.8) {
          world.tackled(f, opponent);
          this.enter("finish", 0.6);
        } else if (this.timer <= 0) this.enter("finish", 0.4);
        break;
      case "parried":
        held = false;   // blade knocked aside, hands jarred
        if (this.timer <= 0) this.enter("finish", 0.35);
        break;
      case "finish":
        target = GUARD;
        rate = 4;
        if (this.timer <= 0) this.enter("idle", THREE.MathUtils.lerp(1.6, 0.4, aggr) * speedK + Math.random() * 0.5);
        break;
      case "block":
        target = this.guardOffset;
        rate = 14;
        if (this.timer <= 0) this.enter("finish", 0.3);
        break;
      case "wrench": {
        // Pull straight back with a side-to-side wiggle.
        const t = performance.now() * 0.012;
        target = new THREE.Vector3(0.15 + Math.sin(t) * 0.12, -0.05, 0.12);
        rate = 10;
        break;
      }
      case "stagger":
        held = false;
        if (this.timer <= 0) this.enter("finish", 0.4);
        break;
      case "pickup":
        held = false;
        if (this.timer <= 0) {
          if (nearestItem && Math.hypot(nearestItem.position.x - pos[0], nearestItem.position.z - pos[2]) < 0.8) {
            const s: HandSide = hs.disabled.Right ? "Left" : "Right";
            world.pickUp(f, nearestItem, s);
          }
          this.behavior = "safe";
          this.enter("finish", 0.4);
        }
        break;
      case "down":
        held = false;
        break;
    }
    if (!hs.armed) {
      // Bare hands: fists up in guard when close, else relaxed.
      const up = range !== "safe" && !["down", "stagger", "pickup"].includes(this.stage);
      hs.handOffset("Left").lerp(new THREE.Vector3(-0.12, 0.05, 0.32), 1 - Math.exp(-dt * 6));
      hs.handOffset("Right").lerp(new THREE.Vector3(0.12, 0.08, 0.3), 1 - Math.exp(-dt * 6));
      hs.update(dt, { dx: 0, dy: 0, wheel: 0, leftHeld: up, rightHeld: up });
      return;
    }
    if (held) o.lerp(target, 1 - Math.exp(-dt * rate));
    const offSide: HandSide = hs.mainSide === "Right" ? "Left" : "Right";
    const two = held && !hs.disabled[offSide];
    const controls: HalfSwordControls = {
      dx: 0, dy: 0, wheel: 0,
      leftHeld: held && (two || hs.mainSide === "Left"),
      rightHeld: held && (two || hs.mainSide === "Right"),
      thrust,
    };
    hs.update(dt, controls);
  }

  /** Choose Hand + charge variant. */
  private chooseAttack(dist: number): void {
    const aggr = this.settings.aggression;
    // Charge Tackle: a shoulder charge from just outside striking range.
    if (dist > 1.0 && dist < 2.0 && Math.random() < 0.08 + aggr * 0.08 + (this.berserk ? 0.12 : 0)) {
      this.enter("tackle", 0.9);
      return;
    }
    const keys = Object.keys(ATTACKS) as Attack[];
    this.attack = keys[Math.floor(Math.random() * keys.length)];
    this.chain = Math.random() < 0.25 + aggr * 0.5 + (this.berserk ? 0.3 : 0) ? 1 + Math.floor(Math.random() * 2) : 0;
    this.feint = Math.random() < 0.15 + aggr * 0.15;
    this.enter("intent", THREE.MathUtils.lerp(0.3, 0.12, aggr) * (this.berserk ? 0.6 : 1));
  }

  private readThreat(opponent: Fighter): void {
    const hs = this.sword;
    const os = opponent.sword;
    if (!os?.ready || !os.swordVisible || this.blockCooldown > 0) return;
    if (!(this.stage === "idle" || this.stage === "finish" || this.stage === "intent" || this.stage === "charge")) return;
    const g = new THREE.Vector3(), t = new THREE.Vector3();
    os.bladeSegment(g, t);
    const tipV = os.tipVelocity();
    const mid = g.clone().lerp(t, 0.6);
    const toMe = hs.chestPosition.clone().sub(mid);
    const incoming = tipV.length() > 3.2 && toMe.length() < 1.5 && tipV.dot(toMe) > 0;
    if (!incoming) return;
    this.blockCooldown = 0.55;
    const skill = this.settings.blockSkill * (this.behavior === "defend" ? 1.25 : 1) * (this.berserk ? 0.6 : 1);
    if (Math.random() < skill) {
      const rel = mid.clone().sub(hs.chestPosition);
      this.guardOffset.set(
        THREE.MathUtils.clamp(rel.dot(hs.bodyRight) * 0.8, -0.25, 0.45),
        THREE.MathUtils.clamp(rel.y * 0.8 + 0.1, -0.35, 0.5),
        0.45,
      );
      this.enter("block", 0.45);
    }
  }

  private nearestItem(items: LooseSword[], pos: Vec3): LooseSword | null {
    let best: LooseSword | null = null, bd = 12;
    for (const it of items) {
      if (it.heldBy || it.cooldown > 0) continue;
      const d = Math.hypot(it.position.x - pos[0], it.position.z - pos[2]);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  }

  private enter(stage: Stage, time: number): void {
    this.stage = stage;
    this.timer = time;
  }
}
