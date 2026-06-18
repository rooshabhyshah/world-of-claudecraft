import { Creature, SaveType } from './types';

// ---------------------------------------------------------------------------
// Condition engine. PF2e has ~43 conditions; this models the ones that bear on
// combat math directly. The rest (and exotic interactions) are adjudicated by
// the AI DM and applied as structured effects, rather than hard-coded here.
//
// Conditions adjust checks, DCs, AC, attack rolls and damage. Penalties of the
// same type don't stack (PF2e takes the worst), but the slice below uses only
// status and circumstance penalties that don't overlap, so we sum directly and
// leave full type-stacking for a later pass.
// ---------------------------------------------------------------------------

export const KNOWN_CONDITIONS = [
  'frightened',  // valued: status penalty to all checks and DCs
  'off-guard',   // -2 circumstance to AC
  'prone',       // off-guard in melee, -2 circumstance to attacks
  'enfeebled',   // valued: status penalty to Str-based rolls (melee attack/damage)
  'clumsy',      // valued: status penalty to Dex-based rolls (ranged attack, AC, Reflex)
  'stupefied',   // valued: penalty to spell attack/DC and concentrate checks
  'drained',     // valued: status penalty to Con (Fortitude, and lost HP — HP handled elsewhere)
  'sickened',    // valued: status penalty to all checks and DCs
] as const;

export type ConditionName = (typeof KNOWN_CONDITIONS)[number];

function val(c: Creature, name: ConditionName): number {
  const v = c.conditions.get(name);
  if (v === undefined) return 0;
  return v === true ? 1 : v;
}

function has(c: Creature, name: ConditionName): boolean {
  return c.conditions.has(name);
}

/** Status penalty applied to *all* checks and DCs (frightened + sickened). */
export function globalCheckPenalty(c: Creature): number {
  return -(val(c, 'frightened') + val(c, 'sickened'));
}

/** Net modifier to this creature's AC from conditions. */
export function acModifier(c: Creature): number {
  let mod = 0;
  if (has(c, 'off-guard') || has(c, 'prone')) mod -= 2; // circumstance
  mod -= val(c, 'clumsy');                               // status, Dex-based
  mod += globalCheckPenalty(c);                          // frightened/sickened hit DCs too
  return mod;
}

/** Net modifier to this creature's melee attack rolls from conditions. */
export function meleeAttackModifier(c: Creature): number {
  let mod = globalCheckPenalty(c);
  mod -= val(c, 'enfeebled'); // Str-based
  if (has(c, 'prone')) mod -= 2;
  return mod;
}

/** Net modifier to this creature's spell attack rolls / spell DC. */
export function spellModifier(c: Creature): number {
  return globalCheckPenalty(c) - val(c, 'stupefied');
}

/** Net modifier to a given save. */
export function saveModifier(c: Creature, save: SaveType): number {
  let mod = globalCheckPenalty(c);
  if (save === 'fortitude') mod -= val(c, 'drained');
  if (save === 'reflex') mod -= val(c, 'clumsy');
  return mod;
}

/** Apply or raise a valued condition (takes the higher value). */
export function applyCondition(c: Creature, name: ConditionName, value: number | true = true): void {
  if (value === true) {
    c.conditions.set(name, true);
    return;
  }
  const cur = c.conditions.get(name);
  const curN = cur === true ? 1 : (cur ?? 0);
  c.conditions.set(name, Math.max(curN, value));
}

/** End-of-turn upkeep: frightened decreases by 1 each turn (and clears at 0). */
export function endOfTurnUpkeep(c: Creature): void {
  const f = c.conditions.get('frightened');
  if (typeof f === 'number') {
    if (f <= 1) c.conditions.delete('frightened');
    else c.conditions.set('frightened', f - 1);
  }
}
