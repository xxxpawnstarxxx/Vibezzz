/** Enemy director: group tactics for several enemies at once, plus the
 *  gauntlet wave / rank table.
 *
 *  Half Sword's AI enums (Vol. 01 §4, §14) give each fighter a range bucket,
 *  a behaviour and a strafe mode; what a crowd needs on top is coordination,
 *  or everyone swings at once and stacks up in one spot. The director:
 *
 *    - hands out attack tokens: only `maxAttackers` enemies may commit to
 *      attacks / grapples; the rest harass and circle at middle range
 *      (tokens rotate so everyone gets a turn, and go to the closest first),
 *    - assigns surround slots: enemies spread evenly around the player,
 *      keeping their current angular order so they don't cross paths,
 *    - defines the gauntlet: waves of ranked enemies ending in the Baron
 *      (BP_HalfSwordGameMode: Player Rank → Baron Rank → BARON Spawned).
 */

import type { DummyAI, DummySettings } from "./dummy_ai.js";
import type { Vec3 } from "../math/vec3.js";

export interface Rank {
  name: string;
  settings: DummySettings;
  health: number;
}

/** Enemy ranks, weakest first. */
export const RANKS: Rank[] = [
  { name: "Peasant", health: 70,  settings: { aggression: 0.3,  blockSkill: 0.25, fightsBack: true, power: 0.45, grapple: 0.1 } },
  { name: "Militia", health: 90,  settings: { aggression: 0.45, blockSkill: 0.4,  fightsBack: true, power: 0.55, grapple: 0.15 } },
  { name: "Squire",  health: 100, settings: { aggression: 0.55, blockSkill: 0.5,  fightsBack: true, power: 0.65, grapple: 0.2 } },
  { name: "Man-at-arms", health: 115, settings: { aggression: 0.65, blockSkill: 0.6, fightsBack: true, power: 0.75, grapple: 0.25 } },
  { name: "Knight",  health: 130, settings: { aggression: 0.75, blockSkill: 0.7,  fightsBack: true, power: 0.85, grapple: 0.3 } },
  { name: "Baron",   health: 260, settings: { aggression: 0.85, blockSkill: 0.8,  fightsBack: true, power: 1.0,  grapple: 0.35 } },
];

export interface Wave { ranks: number[]; maxAttackers: number }

/** Gauntlet: six waves, the last one the Baron. */
export const WAVES: Wave[] = [
  { ranks: [0], maxAttackers: 1 },
  { ranks: [0, 1], maxAttackers: 1 },
  { ranks: [1, 2], maxAttackers: 1 },
  { ranks: [1, 2, 2], maxAttackers: 2 },
  { ranks: [3, 3, 4], maxAttackers: 2 },
  { ranks: [5, 3], maxAttackers: 2 },
];

export interface DirectedEnemy {
  id: string;
  ai: DummyAI;
  position(): Vec3;
  alive(): boolean;
}

export class EnemyDirector {
  maxAttackers = 1;
  private readonly tokenSince = new Map<string, number>();
  private time = 0;

  update(dt: number, enemies: DirectedEnemy[], player: Vec3 | null): void {
    this.time += dt;
    const live = enemies.filter((e) => e.alive());
    for (const e of enemies) if (!e.alive()) e.ai.orders = { canAttack: false, slotAngle: null };
    if (!player || live.length === 0) {
      for (const e of live) e.ai.orders = { canAttack: true, slotAngle: null };
      return;
    }
    const dist = (e: DirectedEnemy) => { const p = e.position(); return Math.hypot(p[0] - player[0], p[2] - player[2]); };

    // --- attack tokens: keep holders for a few seconds, then rotate.
    const holders = live.filter((e) => this.tokenSince.has(e.id));
    for (const h of holders) {
      const held = this.time - this.tokenSince.get(h.id)!;
      const busy = ["intent", "charge", "swing", "reverse", "thrust", "altGrip", "grapple", "tackle", "punch"].includes(h.ai.stage);
      if (held > 6 && !busy) this.tokenSince.delete(h.id);
    }
    for (const id of [...this.tokenSince.keys()]) if (!live.some((e) => e.id === id)) this.tokenSince.delete(id);
    const candidates = live.filter((e) => !this.tokenSince.has(e.id)).sort((a, b) => dist(a) - dist(b));
    while (this.tokenSince.size < Math.min(this.maxAttackers, live.length) && candidates.length) {
      this.tokenSince.set(candidates.shift()!.id, this.time);
    }

    // --- surround slots: even spacing, current angular order preserved.
    const angle = (e: DirectedEnemy) => { const p = e.position(); return Math.atan2(p[0] - player[0], p[2] - player[2]); };
    const sorted = live.map((e) => ({ e, a: angle(e) })).sort((x, y) => x.a - y.a);
    const n = sorted.length;
    const offset = n > 0 ? sorted.reduce((s, x, i) => s + wrap(x.a - (i * 2 * Math.PI) / n), 0) / n : 0;
    sorted.forEach(({ e }, i) => {
      e.ai.orders = {
        canAttack: this.tokenSince.has(e.id),
        slotAngle: n > 1 ? offset + (i * 2 * Math.PI) / n : null,
      };
    });
  }
}

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
