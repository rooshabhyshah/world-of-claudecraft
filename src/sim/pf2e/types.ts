// ---------------------------------------------------------------------------
// Pathfinder 2e core domain types.
//
// This is a fresh rules engine — it shares the deterministic substrate of the
// project (the seeded Rng, the entity/world/render layers) but none of the WoW
// combat model. PF2e is turn-based, d20-vs-DC, three-action, four-degrees.
// ---------------------------------------------------------------------------

export type Ability = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

export type AbilityScores = Record<Ability, number>;

/** Ability modifier from a raw score, PF2e rules: floor((score - 10) / 2). */
export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

// Proficiency ranks. The numeric value is the rank bonus added on top of level
// (a trained, level-5 character has a +7 proficiency bonus: 5 + 2). Untrained
// adds nothing at all — not even level.
export enum Proficiency {
  Untrained = 0,
  Trained = 2,
  Expert = 4,
  Master = 6,
  Legendary = 8,
}

/** Proficiency bonus = level + rank, except Untrained which is a flat 0. */
export function profBonus(level: number, rank: Proficiency): number {
  return rank === Proficiency.Untrained ? 0 : level + rank;
}

export type DamageType =
  | 'bludgeoning' | 'piercing' | 'slashing'
  | 'fire' | 'cold' | 'electricity' | 'acid' | 'sonic'
  | 'mental' | 'spirit' | 'vitality' | 'void' | 'poison' | 'bleed' | 'untyped';

export type SaveType = 'fortitude' | 'reflex' | 'will';

// The four degrees of success — the spine of every PF2e resolution. Ordered so
// that a natural 20 is "+1 step" and a natural 1 is "-1 step".
export enum Degree {
  CriticalFailure = 0,
  Failure = 1,
  Success = 2,
  CriticalSuccess = 3,
}

export interface CheckResult {
  naturalDie: number; // the raw d20
  total: number;      // d20 + modifier
  dc: number;
  degree: Degree;
}

// Weapon / unarmed attack traits we care about mechanically (the long tail is
// adjudicated by the AI DM, not hard-coded here).
export type WeaponTrait = 'agile' | 'finesse' | 'reach' | 'thrown' | 'deadly' | 'forceful';

export interface Strike {
  name: string;
  /** Total attack bonus before MAP / conditions (monster-statblock style, or
   *  derived by character math for the PC). */
  attackBonus: number;
  /** Damage dice expression, e.g. "1d8+4". */
  damage: string;
  damageType: DamageType;
  traits: WeaponTrait[];
  /** Reach in feet (default 5). */
  reach?: number;
}

// A live condition on a creature. Value is the numeric severity for valued
// conditions (frightened 2, enfeebled 1…), or `true` for binary ones (prone,
// off-guard…).
export type ConditionValue = number | true;

export interface Creature {
  id: number;
  name: string;
  team: 'party' | 'foes';
  level: number;
  abilities: AbilityScores;

  hp: number;
  maxHp: number;

  /** Final Armor Class before condition adjustments. */
  ac: number;
  saves: Record<SaveType, number>;
  perception: number;

  strikes: Strike[];

  // Spellcasting (optional — only casters have it).
  spellDC?: number;
  spellAttack?: number;

  conditions: Map<string, ConditionValue>;

  // Encounter-scoped scratch.
  initiative?: number;
}

export const MAX_ACTIONS_PER_TURN = 3;
