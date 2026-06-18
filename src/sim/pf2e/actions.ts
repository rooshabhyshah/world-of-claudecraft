import { Creature, Degree, SaveType, Strike } from './types';
import { Encounter } from './encounter';
import { rollCheck, degreeOfSuccess } from './check';
import { rollDice, doubleRoll } from './dice';
import { acModifier, meleeAttackModifier, saveModifier, spellModifier } from './conditions';

// ---------------------------------------------------------------------------
// Actions: the verbs a creature spends its three actions on. Each returns a
// structured result the renderer/UI shows and the AI DM narrates. The engine
// rolls and enforces; nothing here asks a policy (or a model) for an outcome.
// ---------------------------------------------------------------------------

function mapPenalty(attacksThisTurn: number, agile: boolean): number {
  if (attacksThisTurn <= 0) return 0;
  if (attacksThisTurn === 1) return agile ? 4 : 5;
  return agile ? 8 : 10;
}

export interface StrikeResult {
  kind: 'strike';
  attacker: string;
  defender: string;
  strike: string;
  attack: { naturalDie: number; total: number; dc: number };
  degree: Degree;
  damage: number;
  defenderHp: number;
}

/** A single Strike (1 action). Applies the multiple-attack penalty, condition
 *  modifiers on both sides, crit doubling, and damage. */
export function strike(enc: Encounter, attacker: Creature, defender: Creature, strike: Strike): StrikeResult {
  const cb = enc.combatants.find((c) => c.creature === attacker)!;
  const agile = strike.traits.includes('agile');
  const map = mapPenalty(cb.attacksThisTurn, agile);

  const attackMod = strike.attackBonus + meleeAttackModifier(attacker) - map;
  const targetAC = defender.ac + acModifier(defender);
  const check = rollCheck(enc.rng, attackMod, targetAC);
  cb.attacksThisTurn++;

  let damage = 0;
  if (check.degree === Degree.Success || check.degree === Degree.CriticalSuccess) {
    let roll = rollDice(enc.rng, strike.damage);
    if (check.degree === Degree.CriticalSuccess) roll = doubleRoll(roll);
    damage = Math.max(0, roll.total);
    defender.hp = Math.max(0, defender.hp - damage);
  }

  const result: StrikeResult = {
    kind: 'strike',
    attacker: attacker.name,
    defender: defender.name,
    strike: strike.name,
    attack: { naturalDie: check.naturalDie, total: check.total, dc: targetAC },
    degree: check.degree,
    damage,
    defenderHp: defender.hp,
  };
  enc.log.push(describeStrike(result));
  return result;
}

const DEGREE_WORD = ['critical miss', 'miss', 'hit', 'critical hit'];

function describeStrike(r: StrikeResult): string {
  const outcome = DEGREE_WORD[r.degree];
  const dmg = r.damage > 0 ? ` for ${r.damage} damage (${r.defenderHp} HP left)` : '';
  return `${r.attacker}'s ${r.strike} vs ${r.defender}: ${r.attack.total} vs AC ${r.attack.dc} — ${outcome}${dmg}`;
}

// --- Save-based area spell (e.g. Fireball: basic Reflex) -------------------

export interface SaveSpellTargetResult {
  target: string;
  save: { naturalDie: number; total: number; dc: number };
  degree: Degree;
  damage: number;
  targetHp: number;
}

export interface SaveSpellResult {
  kind: 'saveSpell';
  caster: string;
  spell: string;
  targets: SaveSpellTargetResult[];
}

const BASIC_SAVE_MULT: Record<Degree, number> = {
  [Degree.CriticalSuccess]: 0,
  [Degree.Success]: 0.5,
  [Degree.Failure]: 1,
  [Degree.CriticalFailure]: 2,
};

/** Cast an area spell with a basic save against the caster's spell DC. Damage is
 *  rolled once; each target applies the basic-save multiplier to it. */
export function castSaveSpell(
  enc: Encounter,
  caster: Creature,
  targets: Creature[],
  opts: { name: string; save: SaveType; damage: string },
): SaveSpellResult {
  const dc = (caster.spellDC ?? 10) + spellModifier(caster);
  const rolled = rollDice(enc.rng, opts.damage).total;

  const out: SaveSpellTargetResult[] = targets.map((t) => {
    const saveMod = t.saves[opts.save] + saveModifier(t, opts.save);
    // The target rolls its save against the spell DC.
    const check = rollCheck(enc.rng, saveMod, dc);
    const degree = check.degree;
    const damage = Math.floor(rolled * BASIC_SAVE_MULT[degree]);
    if (damage > 0) t.hp = Math.max(0, t.hp - damage);
    return {
      target: t.name,
      save: { naturalDie: check.naturalDie, total: check.total, dc },
      degree,
      damage,
      targetHp: t.hp,
    };
  });

  enc.log.push(`${caster.name} casts ${opts.name} (DC ${dc}, ${opts.save} save)`);
  for (const r of out) {
    enc.log.push(`  ${r.target}: save ${r.save.total} → ${DEGREE_WORD_SAVE[r.degree]}, ${r.damage} damage (${r.targetHp} HP)`);
  }
  return { kind: 'saveSpell', caster: caster.name, spell: opts.name, targets: out };
}

const DEGREE_WORD_SAVE = ['critical failure', 'failure', 'success', 'critical success'];

// Re-export the pure helper so callers can resolve ad-hoc checks (skills,
// the AI DM's improvised rulings) without reaching into ./check.
export { degreeOfSuccess };
