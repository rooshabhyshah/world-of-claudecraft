# Feasibility: PF2e rules + data, with an AI that plays (and you can take over)

**Status:** feasibility writeup — no code yet.
**Asked:** "Could we get claudecraft to use PF2e rules and data?"
**Refined scope (from discussion):**

- **Single-player**, not the MMO. The thing of value is *playing a character — moving,
  casting spells, doing combat* — under real PF2e rules.
- **PF2e rules *and* data**, not just a reskin. Real d20-vs-DC combat with Pathfinder 2e
  content (classes, spells, feats, items) sourced from the `charbuilder` dataset.
- **An AI controls the game** — it plays the character autonomously (targets, casts,
  spends actions, decides). **You can take over** the controls at any moment, and hand
  back.

This document assesses what that takes, what's reusable, what has to be rebuilt, and a
phased plan. It is a *map*, not a commitment.

---

## 1. TL;DR

The good news, in three parts:

1. **The hardest-looking part is already scaffolded.** claudecraft drives the player
   character through a single control interface (`IWorld` in `src/world_api.ts`), and it
   already has a machine-control surface (`src/sim/obs.ts` — a discrete action space and
   observation API "for RL agents") plus headless drivers (`headless/env_server.ts`, the
   bot scripts in `scripts/`). "AI plays, human takes over" is a *routing* problem on top
   of plumbing that exists, not a new subsystem.

2. **The data is a solved problem.** `charbuilder` already loads the full
   `foundryvtt/pf2e` dataset — **28 classes, 1,796 spells, 5,851 feats, 51 ancestries,
   ~5,500 items, 43 conditions**. We extract a trimmed slice at build time; no runtime
   coupling between the two repos.

3. **The real work is the rules core.** claudecraft's `src/sim/sim.ts` (~3,000 lines) is
   built on *vanilla World of Warcraft* mechanics — real-time 20 Hz, swing timers, a GCD,
   rage/mana/energy, WoW hit tables and armor DR. PF2e is turn-based, d20-vs-DC, three
   actions per turn, four save types, four degrees of success. **This is a rewrite of the
   combat core**, not a patch. That's the cost center; budget weeks, not days.

The AI-DM framing actually *reduces* risk on the rules side: we don't have to hand-code
the behaviour of all 5,851 feats. A deterministic engine enforces the core math (dice,
AC, saves, degrees of success, the action economy); Claude adjudicates everything the
engine doesn't model (odd feats, narrative, rulings) and *plays* the character. The
engine is the referee; Claude is the player and the GM.

---

## 2. What exists today (and what it's worth to us)

### 2.1 Reusable — keep

| System | Where | Why it carries over |
|---|---|---|
| **Control interface** | `src/world_api.ts` (`IWorld`) | One surface for *all* commands (`castAbility`, `targetEntity`, `interact`, movement…). Both human input and bots already go through it. This is the seam where "AI vs human control" lives. |
| **Agent action space** | `src/sim/obs.ts` | A discrete action enum + observation builder explicitly written for programmatic agents. The AI player's tool surface can mirror this. |
| **Headless drivers** | `headless/env_server.ts`, `scripts/*_raid.mjs`, `scripts/smoke_*.mjs` | Proof the world runs and is driven without a browser — exactly how an AI player attaches. |
| **Renderer / UI / input / audio** | `src/render/`, `src/ui/`, `src/game/` | Procedural Three.js renderer, classic HUD, camera/input, WebAudio. Almost entirely rules-agnostic — a character casting *Fireball* renders the same whether the damage math is WoW or PF2e. Some HUD panels (resource bars, action bar) need relabeling. |
| **Deterministic sim skeleton** | `src/sim/rng.ts`, `entity.ts`, `world.ts`, `colliders.ts` | Seeded RNG, entity model, terrain/collision. Combat-system-agnostic; reusable as the substrate. |
| **Content scaffolding** | `src/sim/content/`, `types.ts` | Zones, NPCs, camps, loot tables, the `AbilityDef`/`AbilityEffect`/`Entity` shapes. The *shapes* get replaced, but the loading pattern stays. |

### 2.2 WoW-specific — replace

The combat core in `src/sim/sim.ts` and the kit definitions in `src/sim/content/classes.ts`
are deeply WoW. Concrete couplings (grep-verified):

- Real-time loop: 20 Hz tick, `swingTimer`, `swingIntervalMult`, 1.5s GCD.
- Resources: `resourceType: 'rage' | 'mana' | 'energy'`, combo points, the 5-second mana rule.
- Formulas (in `types.ts`): `spellHitChance(level, targetLevel)` with the +3-level cliff,
  `armorReduction = armor/(armor + 85·L + 400)`, `rageFromDealing = 7.5·d/c`, crit ×1.5
  spell / ×2 melee.
- 9 hardcoded WoW classes (`warrior/mage/rogue/paladin/hunter/priest/shaman/warlock/druid`),
  each with a fixed ability-id list.

None of this survives contact with PF2e. See §4 for what replaces it.

---

## 3. What `charbuilder` gives us (the data)

`charbuilder` reads `foundryvtt/pf2e` JSON at runtime via loaders in `src/lib/pf2e/`, plus
real stat math we can lift:

- **Loaders**: `class-loader.ts`, `spell-loader.ts`, `feat-filter.ts`, etc.
- **Stat math worth reusing**: `stats.ts` (HP/AC/saves), `spell-utils.ts` (slot
  progression by tradition), `boost-constraints.server.ts` (ability boosts). These already
  encode PF2e proficiency math we'd otherwise reinvent.
- **Counts present locally**: classes 28, spells 1,796, feats 5,851, ancestries 51,
  backgrounds 340, heritages 53, conditions 43, equipment ~5,500.

**Recommended data path: build-time extract.** A script reads `charbuilder`'s
`data/pf2e/` submodule and emits a trimmed, typed slice into claudecraft's
`src/sim/content/pf2e/` (only the fields the engine needs: action cost, traits, save type,
damage formula, range, area, effect tags). Rationale:

- No runtime dependency between repos; claudecraft stays self-contained and Dockerable.
- We don't need 5,500 items or 1,796 spells on day one — extract a starter slice (one
  class, a dozen spells, basic weapons) and widen over time.
- Upstream pf2e updates are a re-run of the extract, not a live coupling.

(Alternative — vendoring the same submodule into claudecraft — keeps us auto-synced with
upstream but pulls a large dataset and `fs`-based loaders into the game repo. Not worth it
for a single-player prototype.)

---

## 4. The rules gap (this is the work)

These are different game models. The mismatch is structural, not cosmetic:

| | claudecraft (WoW) | PF2e |
|---|---|---|
| Time | Real-time, 20 Hz, swing/GCD timers | **Turn-based**, initiative order |
| Action economy | Cooldowns + GCD | **3 actions + 1 reaction** per turn |
| To-hit | WoW hit table vs level | `d20 + modifiers vs AC` |
| Crit | Fixed ×1.5 / ×2 | **Beat DC by 10, or nat 20** → crit; **four degrees of success** |
| Defense | Armor damage-reduction % | **AC** (flat target number) |
| Saves | Resistances | **Fortitude / Reflex / Will**, each its own degrees |
| Resources | rage / mana / energy | **Spell slots** (by rank & tradition), **focus points**, per-encounter |
| Conditions | A handful (stun, root, slow…) | A formal set of ~43 (frightened, clumsy, off-guard, persistent damage…) |

**Implication for the engine.** The cleanest path is a **new turn-based encounter mode**
that replaces the real-time combat loop, while reusing the world/movement/exploration
layer for the out-of-combat parts. The deterministic core becomes:

- Initiative + turn/round state machine.
- An **action resolver**: each of the 3 actions resolves a Strike / Cast a Spell / Stride
  / Interact / etc., computing `d20 + mods` against AC or a save DC and bucketing into
  crit-success / success / failure / crit-failure.
- A **condition engine** keyed to the PF2e condition list (replaces the WoW aura system).
- Character math from PF2e proficiencies (port from `charbuilder/src/lib/pf2e/stats.ts`).

This is the part to prototype first and narrowly (§6, Phase 1) — one martial class, basic
Strikes and a few spells — to validate the model before breadth.

---

## 5. Architecture: deterministic engine + PF2e data + Claude (the AI player/DM)

The design principle: **the engine is the referee; Claude is the player and the GM.** The
engine never asks Claude what 2d6+4 is or whether an attack hit — it rolls and enforces.
Claude decides *what to attempt* and narrates *what it means*.

```
                ┌─────────────────────────────────────────────┐
                │  Claude agent loop (the AI player / DM)      │
                │  - observes game state (from obs.ts-style    │
                │    snapshot)                                 │
                │  - decides the next action(s)                │
                │  - narrates via the chat channel            │
                └───────────────┬─────────────────────────────┘
                                │ tool calls = IWorld commands
                                │ (strike, cast_spell, stride, end_turn…)
              ┌─────────────────▼──────────────────┐
   control →  │  Control router (AI ⇄ human toggle) │  ← human input
   handoff    └─────────────────┬──────────────────┘
                                │  IWorld (one surface for both)
              ┌─────────────────▼──────────────────┐
              │  Deterministic PF2e engine          │
              │  - initiative / turns / actions     │
              │  - d20 vs AC/DC, degrees of success │
              │  - conditions, spell slots/focus    │
              │  - char math (ported from charbuilder)│
              └─────────────────┬──────────────────┘
                                │  reads
              ┌─────────────────▼──────────────────┐
              │  PF2e content (build-time extract   │
              │  from charbuilder → src/sim/content/pf2e)│
              └─────────────────────────────────────┘
```

### 5.1 "AI plays, you take over" — the control router

This is the central UX. `IWorld` is already the single command surface; we add a router
in front of it with a `controller` flag:

- **AI in control:** the Claude agent loop observes state and emits actions as tool calls,
  which the router forwards to `IWorld`. Visually identical to the existing bot drivers in
  `scripts/`, but the policy is a model, not a hardcoded script.
- **You take over:** flip the toggle (a key, like the existing UI toggles). Human input
  now drives `IWorld`; the agent loop pauses (or drops to "advisor" — suggests but doesn't
  act). Flip back to hand control to the AI.
- **Mid-action handoff** is clean *because PF2e is turn-based* — control changes at action
  or turn boundaries, with none of the real-time race conditions a WoW handoff would have.
  (A nice side-benefit of the turn-based rewrite.)

### 5.2 The AI player as a Claude agent

This is a textbook tool-use agent loop:

- **Tools = the PF2e action surface**, mirroring `obs.ts`: `strike(target)`,
  `cast_spell(id, target|area)`, `stride(to)`, `step`, `raise_shield`, `interact`,
  `end_turn`, etc. Tool *descriptions* state when to use each — recent Claude models reward
  prescriptive "call this when…" descriptions.
- **The engine validates every tool call** (legal target? action available? in range? slot
  remaining?) and returns the resolved outcome (hit/miss, degree of success, damage,
  conditions applied). The model proposes; the engine disposes. This is the guardrail that
  keeps an LLM honest about the rules.
- **Adjudication fallback**: when an action depends on a feat/spell the engine doesn't
  model mechanically, Claude rules on it narratively and the engine applies a structured
  effect (damage/condition/heal) the model returns. This is how we cover the long tail of
  5,851 feats without hand-coding them.
- **Model**: default `claude-opus-4-8` with adaptive thinking for combat decisions; a
  cheaper model (e.g. `claude-haiku-4-5`) is fine for routine narration/chatter. Keep one
  model per loop to preserve prompt caching; the big static prefix (rules summary, current
  character sheet) caches well across turns.
- **Latency**: turn-based hides model latency far better than real-time would — a few
  seconds to "think" on a turn reads as deliberation, not lag.

### 5.3 Narration through the existing chat channel

`IWorld` already has `chat(text)` and the UI has a chat log. The DM's narration and NPC
dialogue ride that existing channel — no new surface needed. NPC "voices" are just the
agent writing to chat.

### 5.4 "Change and update the session" — steering

You can reshape a run at any time. Two layers:

- **In-fiction**, via chat: tell the DM "make this fight harder", "I cast Shield instead",
  "retcon that NPC as friendly" — the agent treats it as steering input on its next turn.
- **Out-of-band**, via dev controls: the repo already gates god-mode actions behind
  `ALLOW_DEV_COMMANDS` (level/teleport, used by test bots). That's the natural home for
  "spawn this encounter / set level / edit the character / reseed the world" — direct
  state edits that bypass the fiction.

> Implementation note: if this is ever built on Anthropic's **Managed Agents**, "session"
> is a literal first-class object there, and steering/`system.message` events are the
> built-in mechanism for "change and update the session" mid-run. For a self-hosted
> single-player build, a plain Claude agent loop with our own session state is simpler and
> sufficient — but the Managed Agents shape is worth knowing as a target.

---

## 6. Phased plan

Each phase is independently demoable. Stop wherever the value plateaus.

**Phase 0 — Extract spike (small).** Build-time extractor: read `charbuilder/data/pf2e/`,
emit a *tiny* typed slice (1 class — e.g. Fighter — basic weapons, ~6 spells, the core
conditions) into `src/sim/content/pf2e/`. Output is just typed data; nothing consumes it
yet. De-risks the data path.

**Phase 1 — Turn-based PF2e core (the big one).** New encounter mode: initiative, the
3-action economy, `d20` vs AC and save DCs, the four degrees of success, a starter
condition set, and character math ported from `charbuilder/src/lib/pf2e/stats.ts`. Driven
by a throwaway scripted controller (like the existing bots) and validated by a Vitest
suite mirroring `tests/`. **No AI yet** — prove the rules are right first. This is the
make-or-break phase.

**Phase 2 — Human play.** Wire `IWorld` + the HUD/action bar to the turn-based engine so
*you* can play one encounter end-to-end: pick actions, strike, cast, see degrees of
success and conditions. Relabel resource/action UI for PF2e.

**Phase 3 — The AI player + control router.** Stand up the Claude agent loop with the
action-surface tools and engine validation. Add the controller toggle: AI plays a fight
autonomously; you take over mid-encounter and hand back. This delivers the headline
feature.

**Phase 4 — DM, narration, steering.** Route narration/NPC dialogue through `chat`; add
in-fiction steering and the `ALLOW_DEV_COMMANDS`-style session edits. Now it's a playable
AI-run PF2e session you can seize at will.

**Phase 5 — Breadth.** Widen the extract (more classes/spells/feats/items), lean on
Claude's adjudication fallback for the long tail, expand encounters/content.

---

## 7. Risks & open questions

- **Rules correctness is the schedule risk.** PF2e's degrees of success, condition
  interactions, and action economy have a lot of edge cases. Mitigation: narrow Phase 1,
  test-first, port proven math from `charbuilder` rather than reinventing.
- **Long tail of feats/spells.** 5,851 feats can't be mechanically modeled by hand.
  Mitigation: the engine models the core; Claude adjudicates the rest into structured
  effects. Accept that some exotic interactions are "GM's call" — which is true at a real
  table too.
- **How much of the WoW world survives?** Zones, NPCs, quests, models are reusable as
  *content scaffolding*, but their stats/encounters are WoW-tuned. Decide early whether
  Phase 2+ reuses Eastbrook Vale re-statted for PF2e, or starts a fresh small encounter.
- **Scope creep toward the MMO.** The multiplayer server, parties, trading, duels,
  Postgres persistence (`server/`, `src/net/`) are all **out of scope** for the
  single-player AI build. Leave them untouched; don't let them pull the rewrite wider.
- **Licensing.** PF2e content is under Paizo's ORC license (charbuilder already carries
  the attribution requirement). Any build that ships PF2e data must display attribution —
  same obligation as charbuilder.
- **Determinism + AI.** Keep the dice and rules in the seeded deterministic engine, never
  in the model. The model only ever *chooses actions* and *narrates*; it never decides
  outcomes. This keeps runs reproducible and the rules trustworthy.

---

## 8. Recommendation

It's feasible, and the architecture is unusually clean for this kind of port because the
control seam (`IWorld`), the agent action surface (`obs.ts`), and the headless drivers
already exist — and because the data is sitting ready in `charbuilder`. The single load-
bearing piece of new work is the **turn-based PF2e rules engine** (Phase 1). Everything
else is wiring to things that already exist.

Suggested next step: green-light **Phase 0 + Phase 1** as a spike. If the turn-based core
feels right and the rules check out under test, the AI-player and DM layers (Phases 3–4)
are comparatively low-risk wiring on top.
