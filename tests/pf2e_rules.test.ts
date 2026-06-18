import { describe, it, expect } from 'vitest';
import {
  Degree, Proficiency, profBonus, abilityMod,
  degreeOfSuccess, statisticDC,
  parseDice, rollDice,
} from '../src/sim/pf2e';
import { Rng } from '../src/sim/rng';

describe('ability + proficiency math', () => {
  it('computes ability modifiers (floor((score-10)/2))', () => {
    expect(abilityMod(10)).toBe(0);
    expect(abilityMod(18)).toBe(4);
    expect(abilityMod(7)).toBe(-2);
    expect(abilityMod(11)).toBe(0);
  });

  it('adds level to proficiency rank, except untrained', () => {
    expect(profBonus(5, Proficiency.Untrained)).toBe(0);
    expect(profBonus(5, Proficiency.Trained)).toBe(7);
    expect(profBonus(1, Proficiency.Legendary)).toBe(9);
  });

  it('derives a DC from a statistic', () => {
    expect(statisticDC(8)).toBe(18);
  });
});

describe('degrees of success', () => {
  it('buckets by the DC ±10 thresholds', () => {
    // DC 15, ordinary d20 (not 1 or 20)
    expect(degreeOfSuccess(25, 12, 15)).toBe(Degree.CriticalSuccess); // >= DC+10
    expect(degreeOfSuccess(15, 12, 15)).toBe(Degree.Success);          // >= DC
    expect(degreeOfSuccess(14, 12, 15)).toBe(Degree.Failure);          // < DC
    expect(degreeOfSuccess(5, 12, 15)).toBe(Degree.CriticalFailure);   // <= DC-10
  });

  it('a natural 20 improves one step', () => {
    // total 14 vs DC 15 would be a Failure, but nat 20 bumps to Success.
    expect(degreeOfSuccess(14, 20, 15)).toBe(Degree.Success);
    // an already-crit stays crit (clamped).
    expect(degreeOfSuccess(30, 20, 15)).toBe(Degree.CriticalSuccess);
  });

  it('a natural 1 worsens one step', () => {
    // total 16 vs DC 15 would be a Success, but nat 1 drops to Failure.
    expect(degreeOfSuccess(16, 1, 15)).toBe(Degree.Failure);
    // a would-be success exactly at DC+10 with a nat 1 is only a success.
    expect(degreeOfSuccess(25, 1, 15)).toBe(Degree.Success);
  });
});

describe('dice', () => {
  it('parses dice expressions', () => {
    expect(parseDice('1d8+4')).toEqual([
      { count: 1, faces: 8, flat: 0, sign: 1 },
      { count: 0, faces: 0, flat: 4, sign: 1 },
    ]);
    expect(parseDice('2d6+1d4-1')).toHaveLength(3);
  });

  it('rolls within the expected bounds and is seed-deterministic', () => {
    const a = rollDice(new Rng(42), '6d6');
    const b = rollDice(new Rng(42), '6d6');
    expect(a).toEqual(b);                 // deterministic
    expect(a.rolls).toHaveLength(6);
    expect(a.total).toBeGreaterThanOrEqual(6);
    expect(a.total).toBeLessThanOrEqual(36);
  });

  it('applies flat modifiers and signs', () => {
    const r = rollDice(new Rng(1), '1d1+4'); // d1 always 1
    expect(r.total).toBe(5);
    const neg = rollDice(new Rng(1), '1d1-3');
    expect(neg.total).toBe(-2);
  });
});
