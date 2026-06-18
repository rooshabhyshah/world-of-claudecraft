import { describe, it, expect } from 'vitest';
import {
  Creature, Degree, Encounter, strike, castSaveSpell,
  applyCondition, acModifier, meleeAttackModifier, endOfTurnUpkeep,
} from '../src/sim/pf2e';

function fighter(id: number, team: 'party' | 'foes', overrides: Partial<Creature> = {}): Creature {
  return {
    id, name: team === 'party' ? 'Valeros' : 'Goblin', team, level: 1,
    abilities: { str: 18, dex: 14, con: 14, int: 10, wis: 10, cha: 10 },
    hp: 20, maxHp: 20, ac: 18, saves: { fortitude: 8, reflex: 6, will: 4 }, perception: 7,
    strikes: [{ name: 'longsword', attackBonus: 9, damage: '1d8+4', damageType: 'slashing', traits: [] }],
    conditions: new Map(), ...overrides,
  };
}

describe('encounter loop', () => {
  it('rolls initiative, runs turns, and ends when a side is wiped', () => {
    const hero = fighter(1, 'party', { hp: 40, ac: 20, strikes: [{ name: 'greatsword', attackBonus: 12, damage: '2d12+6', damageType: 'slashing', traits: [] }] });
    const goblin = fighter(2, 'foes', { hp: 8, ac: 16 });
    const enc = new Encounter(7, [hero, goblin]);
    enc.start();
    expect(enc.started).toBe(true);
    expect(enc.round).toBe(1);

    // Drive it: on each party turn, swing until the goblin falls.
    let guard = 0;
    while (!enc.isOver() && guard++ < 100) {
      const actor = enc.current().creature;
      if (actor.team === 'party' && actor.hp > 0) {
        const foe = enc.living('foes')[0];
        if (foe && enc.spendActions(1)) strike(enc, actor, foe, actor.strikes[0]);
      }
      if (enc.current().actionsRemaining === 0 || actor.team === 'foes') enc.endTurn();
    }
    expect(enc.isOver()).toBe(true);
    expect(enc.winner()).toBe('party');
  });
});

describe('strikes', () => {
  it('applies the multiple-attack penalty across a turn', () => {
    // Hit a wall of an AC so only the math matters: force misses by using a
    // deterministic seed and a target whose AC we can read off the log.
    const hero = fighter(1, 'party');
    const dummy = fighter(2, 'foes', { hp: 1000, ac: 18 });
    const enc = new Encounter(3, [hero, dummy]);
    enc.start();
    // Position the hero as current actor regardless of initiative.
    while (enc.current().creature !== hero) enc.endTurn();

    const r1 = strike(enc, hero, dummy, hero.strikes[0]);
    const r2 = strike(enc, hero, dummy, hero.strikes[0]);
    const r3 = strike(enc, hero, dummy, hero.strikes[0]);
    // attackBonus 9; MAP makes the effective DC-gap grow. The *natural die* is
    // identical-seed independent, but the recorded attack totals must reflect
    // the −0/−5/−10 progression: total = die + 9 − map.
    const eff = (r: typeof r1) => r.attack.total; // die + 9 - map
    // r2's modifier is 5 lower than r1's, r3's is 10 lower than r1's — for the
    // same natural die. We can't guarantee equal dice, so assert the bonus via
    // reconstruction: total - naturalDie gives the applied modifier.
    expect(r1.attack.total - r1.attack.naturalDie).toBe(9);
    expect(r2.attack.total - r2.attack.naturalDie).toBe(4);  // 9 - 5
    expect(r3.attack.total - r3.attack.naturalDie).toBe(-1); // 9 - 10
  });

  it('agile weapons take a smaller MAP', () => {
    const hero = fighter(1, 'party', {
      strikes: [{ name: 'shortsword', attackBonus: 9, damage: '1d6+4', damageType: 'piercing', traits: ['agile'] }],
    });
    const dummy = fighter(2, 'foes', { hp: 1000 });
    const enc = new Encounter(5, [hero, dummy]);
    enc.start();
    while (enc.current().creature !== hero) enc.endTurn();
    const r1 = strike(enc, hero, dummy, hero.strikes[0]);
    const r2 = strike(enc, hero, dummy, hero.strikes[0]);
    expect(r1.attack.total - r1.attack.naturalDie).toBe(9);
    expect(r2.attack.total - r2.attack.naturalDie).toBe(5); // 9 - 4 (agile)
  });

  it('a critical hit doubles damage', () => {
    // attackBonus huge vs tiny AC guarantees a crit (total >= AC+10) on any die.
    const hero = fighter(1, 'party', {
      strikes: [{ name: 'pick', attackBonus: 50, damage: '1d1+0', damageType: 'piercing', traits: [] }],
    });
    const dummy = fighter(2, 'foes', { hp: 1000, ac: 5 });
    const enc = new Encounter(9, [hero, dummy]);
    enc.start();
    while (enc.current().creature !== hero) enc.endTurn();
    const r = strike(enc, hero, dummy, hero.strikes[0]);
    expect(r.degree).toBe(Degree.CriticalSuccess);
    expect(r.damage).toBe(2); // 1d1 = 1, doubled = 2
  });
});

describe('basic saves', () => {
  it('scales damage by degree of success (crit-success 0, success ½, fail full, crit-fail ×2)', () => {
    const caster = fighter(1, 'party', { spellDC: 100 }); // DC so high every target crit-fails
    const a = fighter(2, 'foes', { hp: 100, saves: { fortitude: 0, reflex: 0, will: 0 } });
    const enc = new Encounter(11, [caster, a]);
    enc.start();
    const res = castSaveSpell(enc, caster, [a], { name: 'Fireball', save: 'reflex', damage: '6d6' });
    expect(res.targets[0].degree).toBe(Degree.CriticalFailure);
    // crit fail = double the rolled damage; HP drops by exactly that.
    expect(res.targets[0].damage).toBe(100 - res.targets[0].targetHp);
    expect(res.targets[0].damage).toBeGreaterThanOrEqual(12); // 6d6 ≥ 6, doubled ≥ 12
  });

  it('an impossible DC yields critical successes and no damage', () => {
    const caster = fighter(1, 'party', { spellDC: -100 });
    const a = fighter(2, 'foes', { hp: 50, saves: { fortitude: 20, reflex: 20, will: 20 } });
    const enc = new Encounter(13, [caster, a]);
    enc.start();
    const res = castSaveSpell(enc, caster, [a], { name: 'Fireball', save: 'reflex', damage: '6d6' });
    expect(res.targets[0].degree).toBe(Degree.CriticalSuccess);
    expect(res.targets[0].damage).toBe(0);
    expect(a.hp).toBe(50);
  });
});

describe('conditions', () => {
  it('off-guard lowers AC by 2', () => {
    const c = fighter(1, 'foes');
    expect(acModifier(c)).toBe(0);
    applyCondition(c, 'off-guard');
    expect(acModifier(c)).toBe(-2);
  });

  it('frightened penalizes attacks and decrements each turn', () => {
    const c = fighter(1, 'party');
    applyCondition(c, 'frightened', 2);
    expect(meleeAttackModifier(c)).toBe(-2);
    endOfTurnUpkeep(c);
    expect(c.conditions.get('frightened')).toBe(1);
    endOfTurnUpkeep(c);
    expect(c.conditions.has('frightened')).toBe(false);
  });

  it('takes the higher value when a condition is re-applied', () => {
    const c = fighter(1, 'party');
    applyCondition(c, 'enfeebled', 1);
    applyCondition(c, 'enfeebled', 3);
    expect(meleeAttackModifier(c)).toBe(-3);
    applyCondition(c, 'enfeebled', 2); // lower — ignored
    expect(meleeAttackModifier(c)).toBe(-3);
  });
});
