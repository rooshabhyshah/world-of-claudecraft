import { Rng } from '../rng';

// ---------------------------------------------------------------------------
// Dice expression parsing + rolling. Supports sums of dice terms and flat
// modifiers: "1d8+4", "6d6", "2d6+1d4+3", "1d12-1".
// ---------------------------------------------------------------------------

export interface DiceTerm {
  count: number; // number of dice (0 for a flat modifier)
  faces: number; // die size (0 for a flat modifier)
  flat: number;  // constant contribution
  sign: 1 | -1;
}

const TERM = /([+-]?)\s*(?:(\d+)d(\d+)|(\d+))/gi;

export function parseDice(expr: string): DiceTerm[] {
  const terms: DiceTerm[] = [];
  let m: RegExpExecArray | null;
  TERM.lastIndex = 0;
  while ((m = TERM.exec(expr)) !== null) {
    const sign: 1 | -1 = m[1] === '-' ? -1 : 1;
    if (m[2] && m[3]) {
      terms.push({ count: parseInt(m[2], 10), faces: parseInt(m[3], 10), flat: 0, sign });
    } else if (m[4]) {
      terms.push({ count: 0, faces: 0, flat: parseInt(m[4], 10), sign });
    }
  }
  if (terms.length === 0) throw new Error(`unparseable dice expression: "${expr}"`);
  return terms;
}

export interface RollResult {
  total: number;
  rolls: number[]; // individual die faces, in order
}

export function rollDice(rng: Rng, expr: string): RollResult {
  const terms = parseDice(expr);
  let total = 0;
  const rolls: number[] = [];
  for (const t of terms) {
    if (t.faces > 0) {
      for (let i = 0; i < t.count; i++) {
        const r = rng.int(1, t.faces);
        rolls.push(r);
        total += t.sign * r;
      }
    } else {
      total += t.sign * t.flat;
    }
  }
  return { total, rolls };
}

/** Double the dice for a critical hit: PF2e doubles the entire damage total
 *  (dice + modifiers), which is equivalent to rolling once and doubling. */
export function doubleRoll(roll: RollResult): RollResult {
  return { total: roll.total * 2, rolls: roll.rolls };
}
