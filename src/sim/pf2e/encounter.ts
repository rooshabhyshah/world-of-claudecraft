import { Rng } from '../rng';
import { Creature, MAX_ACTIONS_PER_TURN } from './types';
import { rollCheck } from './check';
import { globalCheckPenalty, endOfTurnUpkeep } from './conditions';

// ---------------------------------------------------------------------------
// Encounter: initiative order, rounds, turns and the three-action economy.
//
// This is the loop the AI plays and the human can take over — control of *which*
// actions a creature spends is external (a policy: scripted AI, a Claude agent,
// or human input). The encounter only enforces the rules: whose turn it is, how
// many actions remain, the multiple-attack penalty, and when combat ends.
// ---------------------------------------------------------------------------

export interface Combatant {
  creature: Creature;
  actionsRemaining: number;
  reactionAvailable: boolean;
  /** Multiple Attack Penalty accrued this turn (0, then 5, then 10; agile uses
   *  4/8). Stored as a positive number; applied as a subtraction. */
  attacksThisTurn: number;
}

export class Encounter {
  readonly rng: Rng;
  combatants: Combatant[] = [];
  round = 0;
  turnIndex = 0;
  started = false;
  log: string[] = [];

  constructor(seed: number, creatures: Creature[]) {
    this.rng = new Rng(seed);
    for (const c of creatures) {
      c.conditions ??= new Map();
      this.combatants.push({
        creature: c,
        actionsRemaining: 0,
        reactionAvailable: true,
        attacksThisTurn: 0,
      });
    }
  }

  /** Roll initiative (Perception by default) and sort highest-first. Ties break
   *  toward foes losing to the party, then by raw initiative die order of add. */
  start(): void {
    for (const cb of this.combatants) {
      const c = cb.creature;
      const r = rollCheck(this.rng, c.perception + globalCheckPenalty(c), 0);
      c.initiative = r.total;
    }
    this.combatants.sort((a, b) => {
      if (b.creature.initiative! !== a.creature.initiative!) {
        return b.creature.initiative! - a.creature.initiative!;
      }
      // PCs win ties against foes.
      if (a.creature.team !== b.creature.team) return a.creature.team === 'party' ? -1 : 1;
      return 0;
    });
    this.round = 1;
    this.turnIndex = 0;
    this.started = true;
    this.beginTurn();
  }

  current(): Combatant {
    return this.combatants[this.turnIndex];
  }

  private beginTurn(): void {
    const cb = this.current();
    cb.actionsRemaining = MAX_ACTIONS_PER_TURN;
    cb.reactionAvailable = true;
    cb.attacksThisTurn = 0;
    this.log.push(`-- ${cb.creature.name}'s turn (round ${this.round}) --`);
  }

  /** Spend one or more actions for the current creature. Returns false if the
   *  creature doesn't have enough actions left (the caller should not have
   *  attempted the action). */
  spendActions(n: number): boolean {
    const cb = this.current();
    if (cb.actionsRemaining < n) return false;
    cb.actionsRemaining -= n;
    return true;
  }

  /** End the current creature's turn, run upkeep, and advance. Skips dead
   *  creatures. Increments the round when the order wraps. */
  endTurn(): void {
    endOfTurnUpkeep(this.current().creature);
    do {
      this.turnIndex++;
      if (this.turnIndex >= this.combatants.length) {
        this.turnIndex = 0;
        this.round++;
      }
    } while (this.current().creature.hp <= 0 && !this.isOver());
    if (!this.isOver()) this.beginTurn();
  }

  /** Combat ends when one whole side is down. */
  isOver(): boolean {
    const partyUp = this.combatants.some((c) => c.creature.team === 'party' && c.creature.hp > 0);
    const foesUp = this.combatants.some((c) => c.creature.team === 'foes' && c.creature.hp > 0);
    return !partyUp || !foesUp;
  }

  winner(): 'party' | 'foes' | null {
    if (!this.isOver()) return null;
    const partyUp = this.combatants.some((c) => c.creature.team === 'party' && c.creature.hp > 0);
    return partyUp ? 'party' : 'foes';
  }

  living(team: 'party' | 'foes'): Creature[] {
    return this.combatants.filter((c) => c.creature.team === team && c.creature.hp > 0).map((c) => c.creature);
  }
}
