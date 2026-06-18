import { Rng } from '../rng';
import { CheckResult, Degree } from './types';

// ---------------------------------------------------------------------------
// The d20 check and the four degrees of success — the single most important
// rule in PF2e. Every attack, save, skill check and spell resolves through here.
// ---------------------------------------------------------------------------

/**
 * Determine the degree of success for a check.
 *
 * 1. Compare the total to the DC:
 *      total >= DC + 10  → critical success
 *      total >= DC       → success
 *      total <= DC - 10  → critical failure
 *      otherwise         → failure
 * 2. A natural 20 improves the result by one step; a natural 1 worsens it by one
 *    step (applied *after* the threshold comparison, and clamped to the range).
 *
 * Pure function — no randomness — so it is trivially unit-testable.
 */
export function degreeOfSuccess(total: number, naturalDie: number, dc: number): Degree {
  let degree: Degree;
  if (total >= dc + 10) degree = Degree.CriticalSuccess;
  else if (total >= dc) degree = Degree.Success;
  else if (total <= dc - 10) degree = Degree.CriticalFailure;
  else degree = Degree.Failure;

  if (naturalDie === 20) degree = Math.min(Degree.CriticalSuccess, degree + 1) as Degree;
  else if (naturalDie === 1) degree = Math.max(Degree.CriticalFailure, degree - 1) as Degree;

  return degree;
}

/** Roll a d20 + modifier against a DC and return the full result. */
export function rollCheck(rng: Rng, modifier: number, dc: number): CheckResult {
  const naturalDie = rng.int(1, 20);
  const total = naturalDie + modifier;
  return { naturalDie, total, dc, degree: degreeOfSuccess(total, naturalDie, dc) };
}

/** PF2e standard: a DC derived from a creature's statistic is that stat + 10
 *  (used to turn a spell attack / save bonus into the DC opponents roll against,
 *  and vice-versa). */
export function statisticDC(modifier: number): number {
  return 10 + modifier;
}
