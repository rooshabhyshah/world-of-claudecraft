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

### 5.5 Controllers — a per-character roster (generalizes 5.1)

The "AI ⇄ human toggle" is really a **per-combatant `Controller`**. Every character and
creature has a controller, reassignable live, that is one of:

- **human (you)** — your input drives `IWorld`;
- **persona-agent** — a Claude agent with its own "flavor" (see 5.7);
- **GM-agent** — the dungeon master drives this creature;
- **scripted** — a cheap rule-based policy (the existing bot drivers).

All controllers consume the same observation (`obs.ts` snapshot) and emit the same
engine-validated actions — **the engine doesn't care who's driving** — so "I'll take this
one / you take the rogue / let an agent run the goblins" is just swapping a combatant's
controller. The **GM agent owns a single serialized world-state write path** (it arbitrates
turn order and commits actions); per the multi-agent research (AI Town's single ordered
`inputs` table / blackboard single-source-of-truth), this is what prevents agents from
racing or contradicting shared state.

### 5.6 Campaign memory — the brain loaded on boot

On boot the game loads a persistent **campaign store** — party, NPCs, locations, quest/plot
state, session history — and feeds it to the GM agent as context; the GM **writes back** as
the story moves. The proven shape (Smallville / AI Town) is **memory stream → retrieval
(recency + importance + relevance) → periodic reflection/summary roll-up** to keep a long
campaign inside the context budget. Maps to Claude's memory tool (or a memory store). This
is also where "tweak / update the session" persists across boots.

### 5.7 Multi-agent personas (generalizes 5.2)

Each party member or NPC can be **its own agent with a distinct persona**, coordinated by
the GM agent (coordinator → per-character sub-agents). Research-backed guardrails:

- **Persona = structured role/goal/backstory system prompt**, not free text.
- **Re-anchor the persona every few turns** — assigned personas drift by ~8 turns due to
  attention decay; give each character its own retrieval memory.
- **Gate generation to the active character** and keep the GM as coordinator — flat
  free-for-all chat degrades past ~5 concurrent agents, and a single authoritative write
  path avoids the "agent says X but does Y" contradiction failure mode.

### 5.8 Houserules — a `Ruleset` config, not hardcoded constants

"Tweak the rules of PF2e" (extra actions, extra Speed, **remove MAP** — the multiple-attack
penalty, not the visual map — etc.) means the engine must be **parameterized by a `Ruleset`
/ `HouseRules` object** threaded through the encounter and every resolver, live-tweakable by
you *or* the GM agent (exposed as a GM tool, applied as mid-session config the engine reads
each turn). The current spike **hardcodes** `MAX_ACTIONS_PER_TURN = 3` and MAP −5/−10; those
become `ruleset.actionsPerTurn`, `ruleset.map`, `ruleset.mapEnabled`, Speed modifiers, and
so on. De-hardcoding the spike is the concrete first step.

### 5.9 Extensibility — registries for new mechanics

"New mechanics I'm willing to add with more code" means **actions, conditions, and effects
are registries, not closed `switch`es** — a net-new mechanic registers a handler. The
spike's effect union becomes a pluggable registry. **New creatures = new stat blocks** via
the same `Creature` schema (the foundry `pf2e` NPC shape from the visual-layer research),
authored by you *or* generated by the GM agent on the fly.

### 5.10 The rating bridge — connective tissue back to charbuilder ⭐

This is the strategic link, not a side feature. The action HUD shows **(a) available
actions** (engine-derived legality — which of your actions/Strikes/spells are legal right
now given budget, range, slots) **and (b) recommended actions** (highlighted).

- **Ratings → recommendations.** The highlight is driven by **charbuilder's S/A/B/C/D
  rating framework** — extract the ratings alongside the pf2e data and map them onto the
  legal actions (chess-engine-hint / advisor-UI style). This is also the in-play teaching
  surface ("what's good here, and why").
- **Play → ratings.** Combat outcomes and usage become **data that refines the ratings**
  ("eventually feed into the rating system"). That reframes the game as **charbuilder's
  playtest/validation loop**, not a standalone toy — the two repos close a circle.
- **Cross-repo:** add a ratings extract to the build-time pipeline, plus a feedback path for
  play data.

---

## 5C. Stitching it together — the orchestration architecture (research-backed)

How the pieces (engine, controllers, GM, memory, ratings) actually wire up at runtime,
synthesized from prior art in LLM game agents, multi-agent systems, AI game masters, and
mixed human/AI party games.

### A. The turn loop — engine-validated agent play

A ReAct loop per controlling agent: **observe → choose → resolve**, one model call per
decision.
- **Inject the legal-action list every turn.** This is the single highest-leverage
  grounding technique — an OpenSpiel ablation measured average return dropping 0.75 → 0.45
  without it — and legality *decays as the game grows*, so re-ground each turn rather than
  trusting a big context. The engine derives the legal set (budget/range/slots) and hands
  it to the agent. ([Board Game Arena](https://arxiv.org/html/2508.03368v1),
  [GPT-5 illegal-move decay](https://blog.mathieuacher.com/GPT5-IllegalChessBench/))
- **LLM decides, engine resolves.** Force a tool call (`tool_choice` any), constrain
  params with enums, but the **engine validator is non-negotiable** — enums reduce, don't
  eliminate, illegal calls. Repair a bad call by returning the **error as a `tool_result`**
  the model reads and fixes. ([writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents),
  [mnehmos.rpg.mcp](https://github.com/Mnehmos/mnehmos.rpg.mcp))
- **Two models, cached prefix.** `claude-opus-4-8` (adaptive thinking) for combat decisions
  and GM authoring; `claude-haiku-4-5` for routine narration and the memory extractor. An
  aidm-style **4-block prompt cache** (immutable rules → compaction summary → sliding
  recent window → regenerated retrieval) targets ≥80% cache hits after a few turns.
  ([aidm](https://github.com/deusversus/aidm))
- **Budget per encounter, not per call** — agent loops use ~4× (single) to ~15× (multi)
  the tokens of plain chat; cap turns and parallelize independent resolutions (e.g. all the
  goblins' obvious moves). ([agent-loop latency](https://mlsystems.dev/blog/agent-loop-latency/))

### B. Who drives what — controller roster + handoff

- **The Dragon Age handoff rule:** taking over a character **disables its agent**; handing
  it back **re-enables** it. Clean, race-free, and turn-based makes it trivial. ([DA tactics](https://dragonage.fandom.com/wiki/Tactics_(Origins)))
- **A three-tier control hierarchy** maps onto our UI: *manual command* > *recommended
  action* > *default policy* — i.e. available → recommended → auto.
- **Turn-faithful escalation (BG3 "Ask vs Auto"):** an agent-run character can be set to
  auto-resolve or to **ask you on flagged decisions** (reactions, risky moves). This
  resolves the genre's override-timing fork (mid-action override à la FF12 vs configure-
  then-commit à la Unicorn Overlord) by escalating at decision boundaries. ([BG3 reactions](https://baldursgate3.wiki.fextralife.com/Reactions))

### C. The GM as coordinator + single write path

- The **GM agent is the coordinator and owns the only world-state write path.** Character
  agents *propose* actions (tool calls); the engine validates; the GM/engine commit in turn
  order. This is the AI-Town "single ordered `inputs` table" / blackboard single-source-of-
  truth pattern, and it kills both action races and the "agent says X but does Y"
  contradiction. ([AI Town](https://github.com/a16z-infra/ai-town/blob/main/ARCHITECTURE.md))
- **GM tools:** `narrate` (chat), `spawn_creature` (new stat block), `start_encounter`,
  `set_scene/terrain`, `apply_houserule` (a `Ruleset` tweak), `advance_quest`, `write_memory`.
- **Character agents:** structured role/goal/backstory persona + own retrieval memory,
  **re-anchored every few turns** (personas drift by ~turn 8). Only the *active* character's
  agent generates. Keep the roster small and the GM authoritative — multi-agent "agent
  drift" means a swarm isn't automatically more stable than one well-fed author. ([persona drift](https://arxiv.org/html/2402.10962v1),
  [agent drift](https://arxiv.org/abs/2601.04170))

### D. Campaign memory — boot + persist

The pattern every production AI-GM converges on, in three parts loaded on boot and fed to
the GM:
1. an **always-injected block** of critical/non-decaying canon (world, party, key facts);
2. a **rolling hierarchical summary** of the campaign;
3. a **vector store of episodic memories + entity "cards"** (NPCs/places/facts, AI Dungeon
   "Story Cards" / SillyTavern lorebook style) retrieved by relevance to the current scene.

New facts are persisted **after each turn by a "Chronicler"/extractor** (a cheap background
write). **Anti-drift discipline is mandatory** — the universal failure mode is summaries
diverging from truth and the model canonizing its own hallucinations: retrieve facts from
*raw transcripts* (not summaries), version/timestamp memories, and flag critical canon as
non-decaying. Long context alone does **not** fix continuity (lost-in-the-middle).
([AI Dungeon memory](https://help.aidungeon.com/faq/the-memory-system),
[memory survey](https://arxiv.org/html/2603.07670v1),
[MemGPT](https://www.emergentmind.com/topics/memgpt-style-memory-management))

### E. Recommendations → the rating bridge (UI)

The chess-GUI pipeline is the precedent: **per-option eval → rank → graded visual
highlight.** Map charbuilder's S/A/B/C/D tiers onto the legal-action set and render as a
**graded** highlight (the "arrow-thickness scales with move strength" idiom), with per-
action odds shown *before commit* (XCOM hit-%). Make it a **dismissible toggle** so it
assists without removing agency, and **align to the character's build/playstyle**, not a
global optimum — a recommendation that ignores playstyle reads as dumb. A lighter-touch
companion is enemy-intent telegraphing (Slay the Spire). Chosen-action + outcome logs feed
back as data to refine the ratings — closing the loop with charbuilder.
([Lichess arrows](https://lichess.org/forum/lichess-feedback/feature-request-changing-analysis-arrows),
[XCOM odds](https://www.gamedeveloper.com/design/jake-solomon-explains-the-careful-use-of-randomness-in-i-xcom-2-i-))

### F. One turn, end to end (the stitch)

1. **GM** pulls scene context from campaign memory, narrates into chat.
2. **Engine** rolls initiative; the encounter state machine starts.
3. On each combatant's turn, its **controller** (you / a persona-agent / the GM) receives
   the observation **plus the legal-action list**, with recommended actions highlighted from
   the rating bridge.
4. It acts via **validated tool calls**; the engine resolves (d20 vs AC/DC, degrees of
   success), the presentation layer animates, the action pips deplete.
5. The **Chronicler** writes new facts to memory; the turn advances.
6. At any boundary you can **seize a character** (its agent pauses), **tweak a houserule**,
   **spawn a creature**, or **edit the scene** — all as engine-validated state changes.

**Prior art we're standing on:** Voyager (self-repairing tool-agent), Board Game
Arena/OpenSpiel (engine-validated LLM play), Generative Agents + AI Town (multi-agent +
memory), MemGPT / AI Dungeon / SillyTavern (campaign memory), `deusversus/aidm` (closest
Claude-Agent-SDK GM reference), Dragon Age / BG3 / FF12 Gambits (mixed human-AI control),
Lichess / XCOM (recommendation UI).

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
