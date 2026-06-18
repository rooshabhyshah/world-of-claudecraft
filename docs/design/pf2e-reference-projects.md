# Reference projects: `deusversus/aidm` and `Mnehmos/mnehmos.rpg.mcp`

Two existing projects are close enough to our PF2e AI-GM to mine directly. They're
complementary: **aidm** is the GM/narrative/memory/orchestration layer on *our exact stack*
(Claude Agent SDK + TypeScript + Postgres/pgvector); **mnehmos.rpg.mcp** is the
deterministic rules engine + agent tool-surface design (TypeScript + SQLite + MCP, with
2,214 tests). Neither is PF2e and neither is a dependency we'd take — they're **design
references**. This doc records what each does and what we borrow / adapt / skip.

Sources: [github.com/deusversus/aidm](https://github.com/deusversus/aidm) (default branch
`master`; `ROADMAP.md` is the master design doc) ·
[github.com/Mnehmos/mnehmos.rpg.mcp](https://github.com/Mnehmos/mnehmos.rpg.mcp).

---

## 1. `aidm` — the GM, memory, and orchestration layer

**Stack:** TypeScript, Next.js 15, React 19, **Claude Agent SDK** + Mastra, **Postgres 16 +
pgvector**, Drizzle ORM, Langfuse/PostHog, Clerk, Railway. Single author, in-progress (v4
rewrite of a Python v3) — treat as a blueprint, not battle-tested. (Note: the repo blurb
still says "24+ agents / ChromaDB"; the live ROADMAP describes ~15 agents + pgvector —
trust the ROADMAP.)

### 1.1 The three-phase turn lifecycle (directly adoptable)

This *is* the orchestration loop from our master plan's §5C, proven on our stack:

| Phase | Tier | Role |
|---|---|---|
| **Scenewright** (before turn) | fast | Routes the turn. Consultants: `IntentClassifier` (10 intent types + an **epicness 0.0–1.0** score), `WorldBuilderAgent` (validates player in-fiction assertions against canon), `OverrideHandler` (`/meta`, `/override`), `OutcomeJudge` (success level, DC, narrative weight MINOR/SIGNIFICANT/CLIMACTIC), `Validator`. |
| **KeyAnimator** ("the author", turn) | creative, streaming | Narrates. Runs as a Claude Agent SDK session with a 4-block cached system prompt; calls consultants as needed — crucially a **`CombatAgent` that pre-resolves hit/miss/damage *before* the prose**. Tier-0 fast-path when epicness < 0.2. Streams prose via SSE. |
| **Chronicler** (after turn) | fast, background | Writes state. `ProductionAgent` (quests/locations), `RelationshipAnalyzer`, the **memory writer**, `ForeshadowingLedger`, `Director` (arc pacing), `Compactor`. Runs in-process via Next.js `after()` under a per-campaign advisory lock (a 2nd turn waits ≤15s). |

**Borrow:** the whole pre-turn-route → narrate → post-turn-write shape, and especially
**CombatAgent-pre-resolution** — resolve the d20 + degree of success in the engine, *then*
narrate. That is exactly our "engine is the referee, Claude is the author."

### 1.2 Memory architecture (a ready blueprint)

**Seven layers**, each exposed as an MCP server: Ambient (prompt-cache block), Working
(sliding window), Episodic (turn transcripts, full-text/tsvector), **Semantic** (pgvector +
decay + heat + reranker), Voice (the GM's "journal" of phrasings), Arc (foreshadowing seeds
with a PLANTED→…→RESOLVED lifecycle), **Critical** (Session-Zero facts + player overrides,
never decays).

**Semantic memory** is the meaty part — **15 categories with per-category decay
multipliers** applied per turn (`heat *= multiplier ^ turns_elapsed`):

- never decay (1.0): `core`, `session_zero`
- very slow (0.97): `relationship` (milestones floor at 40)
- slow (0.95): `consequence`, `fact`, `npc_interaction`, `location`, `narrative_beat`
- normal (0.90): `quest`, `world_state`, `event`, `npc_state`
- fast (0.80): `character_state` · very fast (0.70): `episode`

Heat starts 100, access-boost +30/+20 (cap 100), floor 1.0, `heat ≤ 0` hard-deleted in a
nightly cron; **dedup at cosine > 0.92**. Retrieval is **epicness-scaled** — Tier 0/1/2/3 →
**0 / 3 / 6 / 9** memories (COMBAT always ≥ Tier 2; special conditions +1 tier) — via
**multi-query decomposition** (2–3 queries → cosine → merge/dedup → rerank with boosts → an
LLM `MemoryRanker` pass when > 3 candidates).

**Borrow:** the category-decay + heat model, critical-facts-never-decay, and
epicness-scaled retrieval are close to ideal for a PF2e campaign — **adapt the categories**
to our domain (encounter state, NPC disposition, faction intel, quest, location, party
knowledge). This directly fills our §5.6 / §5C-D campaign-memory layer.

### 1.3 Prompt cache + models

**4-block system array** (static→dynamic): Block 1 immutable voice/rules DNA (~8–12K,
session-start only) · Block 2 append-only compaction buffer · Block 3 sliding working
window · Block 4 dynamic scene context (**uncached**, changes every turn). **Target ≥80%
cache hit after turn 5** (tracked in Langfuse). **Model tiers:** `probe`/`fast` (Haiku),
`thinking` (Sonnet/Opus), `creative` (Opus for KeyAnimator) — agents mapped to tiers.

**Borrow:** the 4-block layout verbatim — it's the same cache discipline our plan calls
for. Map `creative`→`claude-opus-4-8`, `fast`→`claude-haiku-4-5`.

### 1.4 Skip
The web-app shell (Next.js/Clerk/Railway/PostHog) — we're a game client, not a SaaS. And
don't inherit its breadth of ~15 agents wholesale; start with the 3-phase spine and add
consultants only as needed.

---

## 2. `mnehmos.rpg.mcp` — the deterministic engine + tool surface

**Stack:** TypeScript (99.5%), **SQLite** (persisted, migration-driven, repository
pattern), **Zod** at every boundary, **MCP SDK**, esbuild, **Vitest (2,214 tests / 136
files)**. License **ISC** ("use freely, attribution appreciated"). It's D&D 5e, but the
*patterns* transfer wholesale. Ships 1,100+ creature presets and 50+ balanced encounters.

### 2.1 The "LLM can't cheat" reflex arc (the core idea)

> "LLMs propose intentions. The engine validates and executes. LLMs never directly mutate
> world state."

An OODA loop: **OBSERVE (read tools) → ORIENT (LLM) → DECIDE → ACT (write tools) → VALIDATE
(engine) → loop.** Concretely: action proposed → constraint validation (in range? ammo?
conscious?) → **impossible actions blocked before execution** → **dice rolled server-side**
→ state persisted atomically → results observed. This is exactly the grounding our
LLM-as-game-agent research demanded (legal-action enforcement, engine owns dice), made
concrete.

### 2.2 Tool-surface consolidation (the token win)

**195 → 33 tools.** Instead of per-entity CRUD, **action-routed tools**: one
`character_manage` with an `action` enum (`create|get|update|delete|list|search`), 29 such
tools + 4 meta tools (`search_tools`, `load_tool_schema`, `subscribe/unsubscribe_to_events`).
Plus **fuzzy-enum matching** (typo tolerance + correction suggestions) and **guiding errors**
(invalid action returns the available options). Schemas are **loaded on demand** via
`load_tool_schema` rather than all upfront. Reported **~85% token-overhead reduction (~50K →
6–8K)**.

**Borrow:** this is the answer to "keep the agent's tool surface small" from our research —
action-routed tools + lazy schema loading + error-as-guidance (which dovetails with our
"return the error as a tool_result for self-repair"). The engine surface for our PF2e agent
(`character_manage`, `combat_manage`, `combat_action`, `combat_map`, …) can mirror this.

### 2.3 Storage & structure (close to our stack)

SQLite + repository pattern + Zod validation; tables for characters, combat_encounters,
spatial_rooms, npcs, quests, inventory, world_regions; atomic, deterministic replay. Engine
split into `engine/{combat,spatial,worldgen,strategy}`, `server/{consolidated,handlers,
meta-tools,events}`, `utils/{fuzzy-enum,schema-shorthand}`. Combat already models
initiative, **spatial grid (collision, LoS, range, AOE)**, opportunity-attack reactions,
death saves, resistances, legendary actions.

**Borrow:** the directory shape, the repository-over-SQLite pattern (charbuilder already
uses `better-sqlite3`), Zod-at-boundaries, the encounter-preset idea, and the spatial-grid
combat structure (LoS/range/AOE — which our visual-layer research said we need).

### 2.4 Skip
The worldgen/nation-`strategy` simulation, and the D&D-5e-specific rules content (we swap in
PF2e). Whether to expose our engine as an **MCP server** (decoupled, reusable across
clients) or as **in-process Agent-SDK tools** (simpler for a single-player app) is a real
decision — see §3.

---

## 3. What our architecture takes from each

| Layer | Take from | Adapt |
|---|---|---|
| GM turn loop | **aidm** Scenewright→KeyAnimator→Chronicler | trim to a 3-phase spine; CombatAgent-pre-resolution = our engine resolving before narration |
| Campaign memory | **aidm** 7-layer + 15-category decay/heat + epicness retrieval + 4-block cache | re-map categories to PF2e (encounter/NPC/quest/party-knowledge) |
| Engine authority | **mnehmos** reflex arc (validate→roll server-side→persist→observe) | PF2e rules (degrees of success, the 3-action economy, conditions) |
| Agent tool surface | **mnehmos** action-routed tools + `search_tools`/`load_tool_schema` + guiding errors | our PF2e action verbs; pairs with legal-action injection |
| State storage | **mnehmos** SQLite + repos + Zod | charbuilder already uses `better-sqlite3` |
| Models / cache | **aidm** tier mapping + 4-block cache | `creative`→`claude-opus-4-8`, `fast`→`claude-haiku-4-5` |

### Decisions these surface
1. **Two stores, not one.** aidm needs **pgvector** for semantic-memory embeddings; mnehmos
   uses plain **SQLite** for deterministic game state. We likely want both: SQLite (or
   `better-sqlite3`, matching charbuilder) for **game/world state**, and a vector store for
   **campaign semantic memory** — either Postgres+pgvector (aidm's path) or a local SQLite
   vector extension (`sqlite-vec`) to stay single-process. **Recommend** starting with
   SQLite + `sqlite-vec` for a self-contained single-player build; graduate to pgvector only
   if memory scale demands it.
2. **MCP server vs in-process tools.** mnehmos and aidm both expose subsystems as **MCP
   servers** (decoupled, multi-client). For our single-player game, **in-process Claude
   Agent SDK tools are simpler**; keep the engine API clean enough that wrapping it as MCP
   later is a thin shim, not a rewrite.
3. **Heat/decay is worth it.** aidm's per-category decay + heat solves the "summaries drift,
   model canonizes hallucinations" failure our research flagged — adopt it rather than
   reinventing.

### Caveats
- **aidm is single-author and in-progress** — mine the design, don't depend on it; verify
  its license before copying code (mnehmos is ISC, copy-friendly with attribution).
- Both are bigger than we need; cherry-pick the spine (turn loop, memory model, reflex arc,
  tool consolidation) and leave the rest.
