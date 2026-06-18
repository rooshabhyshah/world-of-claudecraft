# Research: the visual layer for a PF2e video game

Deep-research report. Scope: how to render and represent the world for a *simple,
readable* (not fancy) single-player Pathfinder 2e game built on this repo's TypeScript +
Three.js engine. Art is **AI/user-generated** (a pipeline question, not sourcing).
Elevation is **mechanical** (a real grid layer: movement, range, cover, LoS, reach,
falling). Both an **overworld** and a tactical **encounter map** are in scope.

Method: five parallel web-research agents (render approach; map/terrain + elevation
modeling; Foundry pf2e implementation + data; creature/token visuals + stat-block UI; art
pipeline), each searching, fetching, and extracting falsifiable claims. **Confidence
caveat:** the map-modeling and creature-visuals threads hit repeated `WebFetch` 403s and
lean on (corroborated) search-result summaries; render, Foundry, and art-pipeline threads
fetched primary sources directly. PF2e rules facts are high-confidence (Archives of
Nethys).

---

## Headline finding: the "iso vs 3D" question partly dissolves

The framing "2.5D isometric **vs** simple 3D" resolves, on the evidence, to a **hybrid**:
**real low-poly 3D geometry rendered through an *orthographic* camera locked to a default
isometric angle** (rotatable). This is what the canonical "elevation-matters" tactical
RPGs actually do — Final Fantasy Tactics, Tactics Ogre, Disgaea, and XCOM are 3D under an
ortho/iso camera, **not** 2D sprite stacks. You get the isometric *look* and flat
readability while the engine solves elevation occlusion and draw-order for you.

True 2.5D **sprite-tile stacking** is the loser here specifically *because* elevation is
mechanical: practitioners report it stays manageable only to ~3 stacked floor levels
before z-sort/occlusion bugs compound — fatal for a game where height can be many 5-ft
steps and must be exact. ([GameDev.net 3D tile maps](https://www.gamedev.net/forums/topic/534781-3d-tile-maps-how-to-storerender-the-level-eg-final-fantasy-tactics-disgaea/),
[Panda3D iso/FFT](https://discourse.panda3d.org/t/isometric-3d-tile-game-with-panda3d-final-fantasy-tactics/5969))

This also directly reuses the repo's existing Three.js stack — swap `PerspectiveCamera`
for `OrthographicCamera` offset equally on all axes and you get clean iso with no manual
trig. ([Three.js iso gist](https://gist.github.com/nitaku/032c1724a0433ae0f85f),
[three.js forum](https://discourse.threejs.org/t/responsive-isometric-orthographic-camera/37894))

---

## Recommended path per layer

### 1. Render approach → **low-poly 3D + orthographic iso camera (rotatable)**
- Elevation becomes *real geometry* — height tiles, ramps, multi-level — and the engine
  handles occlusion/sorting; no hand-authored z-sort. ([GameDev.net](https://www.gamedev.net/forums/topic/534781-3d-tile-maps-how-to-storerender-the-level-eg-final-fantasy-tactics-disgaea/))
- Avoids the 2D sprite **per-direction explosion** (1 char × 8 facings × frames = hundreds
  of sprites); a 3D model animates once, renders from any angle. ([GameDev.net cost thread](https://gamedev.net/forums/topic/694163-what-is-cheaper-pixel-art-or-low-poly/))
- Keep the camera *locked to iso by default* for parallel-projection readability (constant
  scale, whole battlefield visible), but allow rotation + roof-removal/near-object
  transparency to defeat the tall-object occlusion problem that fixed 2D iso **cannot**
  solve. ([XCOM roof removal](https://www.engadget.com/2012-11-02-xcom-patch-to-solve-roof-visibility-issues-make-easy-mode-easie.html),
  [occlusion in tactical RPGs](https://www.neogaf.com/threads/i-cant-enjoy-most-tactical-rpg-because-of-a-stupid-reason.635701/))

### 2. Map & terrain → **two representations sharing one heightfield-to-mesh path**
- **Encounter map:** an `N×N` grid; each cell carries `heightSteps` (integer 5-ft steps),
  terrain/cost flags, and occupant. Render as a heightfield: a `PlaneGeometry` with
  `segments = gridDim − 1`, each vertex `Z = heightSteps × 5ft`. ([Three.js heightmap terrain](https://blog.mastermaps.com/2013/10/terrain-building-with-threejs.html))
- **Overworld:** a lower-resolution continuous heightmap plane for free roaming, *no*
  combat grid. Same mesh code, different resolution.
- **Handoff (genre standard):** keep them as two map types; on encounter trigger,
  instantiate the tactical grid (optionally seeded from the overworld tile's biome), then
  return to the overworld after combat. ([tactical JRPG/CRPG handoff](https://turnbasedlovers.com/review/a-tactical-jrpg-that-plays-like-a-crpg-guild-saga-vanished-worlds-1-year-later/))
- Multi-level maps (bridges, buildings, caves): a **stack of 2D arrays (z-levels)**, not a
  dense 3D array — simpler and lighter. ([roguelike z-levels](http://trystans.blogspot.com/2011/09/roguelike-tutorial-07-z-levels-and.html))

### 3. Mechanical elevation → **per-square height + 3D grid LoS/cover**
- **LoS:** symmetric **recursive shadowcasting** on the grid (A sees B ⇔ B sees A — fair
  for tactics), evaluated in 3D by comparing tile heights; mirror Foundry's "Wall Height"
  lesson that walls carry **top/bottom** elevation and a token is visible if its top *or*
  bottom is. ([symmetric shadowcasting](https://www.albertford.com/shadowcasting/),
  [FOV study](https://www.roguebasin.com/index.php/Comparative_study_of_field_of_view_algorithms_for_2D_grid_based_worlds),
  [Wall Height](https://foundryvtt.com/packages/wall-height/))
- **Cover (PF2e exact rule):** a **center-to-center line** from attacker square to target
  square — rasterize it (supercover/Bresenham) and inspect crossed cells: blocking
  terrain → **standard (+2 AC/Ref/Stealth)**, a creature in the line → **lesser (+1)**,
  Take Cover/extreme → **greater (+4)**; a creature 2+ sizes larger blocks as *standard*.
  Cover is **per attacker→target pair** — recompute, don't store globally. ([AoN Cover](https://2e.aonprd.com/Rules.aspx?ID=2372),
  [AoN cover & large creatures](https://2e.aonprd.com/Rules.aspx?ID=2373),
  [redblob line drawing](https://www.redblobgames.com/grids/line-drawing.html))
- **Movement:** grid-as-graph, **Dijkstra/A\*** with per-tile cost (difficult terrain ×2,
  greater ×3); small integer costs → a bucket priority queue. ([redblob pathfinding](https://www.redblobgames.com/pathfinding/grids/algorithms.html))
- **Falling:** a max step-height gate between adjacent cells; exceeding it falls, and fall
  height in 5-ft increments drives fall damage.
- **Reference implementation to mirror:** Foundry core *Scene Levels* (absorbing the
  *Levels* module) + *Wall Height* + caewok's *Terrain Mapper* (regions set/ramp
  elevation), *Elevation Ruler* (3D distance), and *Token Cover* (geometric per-pair
  cover). ([Levels/Scene Levels](https://wiki.theripper93.com/levels),
  [Terrain Mapper](https://github.com/caewok/fvtt-terrain-mapper/blob/main/README.md),
  [Elevation Ruler](https://github.com/caewok/fvtt-elevation-ruler),
  [Token Cover](https://github.com/caewok/fvtt-token-cover))

### 4. Creatures/NPCs → **alpha-tested billboard sprites now, meshes for hero assets later**
- Two valid options under a 3D engine: simple **3D meshes** (no sprite explosion) or
  **HD-2D billboard sprites** (flat art in a 3D world, à la Octopath/Triangle Strategy).
  ([HD-2D](https://en.wikipedia.org/wiki/HD-2D))
- Recommend **billboard sprites first** — cheapest fit for AI/user art (one PNG per
  creature) — but note the catch: a Y-axis billboard goes **razor-thin from straight
  top-down**, which is exactly why we keep the **tilted iso** camera, not pure top-down.
  Use **`alphaTest` cutout**, not soft alpha, to dodge Three.js transparent-sprite sorting
  bugs. ([billboard clipping](https://discussions.unity.com/t/problem-solving-2d-billboard-sprites-clipping-into-3d-environment/743786),
  [Three.js transparency](https://threejs.org/manual/en/transparency.html))
- **Footprint = N×N grid occupancy by PF2e size:** Tiny <1 (can share, 4+/square),
  Small/Medium 1×1, Large 2×2, Huge 3×3, Gargantuan 4×4; scale one texture across the
  footprint. ([AoN size/space/reach](https://2e.aonprd.com/Rules.aspx?ID=2359),
  [token size guide](https://rpgtokenmaker.com/guides/creature-token-sizes))
- **Facing:** optional, derived from last move (arrow overlay) — not a mandatory system,
  which suits "simple and readable." ([About Face](https://github.com/eadorin/about-face))
- **Status UI hierarchy (copy Foundry):** small condition icons stacked top-left + one HP
  bar + **one promotable large center overlay** (wounded <50% → unconscious → defeated
  skull). ([Foundry Token HUD](https://foundryvtt.wiki/en/basics/Token-HUD))

### 5. Stat blocks → **source from foundryvtt/pf2e `packs/`, render in canonical order**
- The `foundryvtt/pf2e` repo ships NPC/bestiary packs: `pathfinder-monster-core`,
  `pathfinder-npc-core`, `pathfinder-bestiary`(`-2`/`-3`), `npc-gallery`, plus AP/PFS
  bestiaries. ([packs dir](https://github.com/foundryvtt/pf2e/tree/master/packs))
- **NPC actor schema maps ~1:1 to an engine `Creature`:** `system.abilities.{str…}.mod`,
  `system.attributes.ac.value`, `system.attributes.hp.{max,value}`,
  `system.saves.{fortitude,reflex,will}.value`, `system.traits.size.value`,
  `system.traits.value[]`, `system.attributes.speed.value`; strikes/spells in `items[]`
  (`type:"melee"`/`"ranged"` with `bonus.value` + `damageRolls`; plus `spell`, `action`).
  ([packs/schema](https://github.com/foundryvtt/pf2e/tree/master/packs))
- **License:** code Apache-2.0; mechanics ORC/OGL (remaster entries carry
  `system.publication.license:"ORC"`); mechanical stat-block text is freely includable; art
  is separately licensed per file — moot for us since we generate our own. ([pf2e README](https://github.com/foundryvtt/pf2e/blob/master/README.md))
- **Display:** render from structured data in the canonical AoN stat-block order (name/
  level/traits → Perception/skills → ability mods → AC, saves → HP/immunities → Speed →
  attacks → spells/abilities), single column, with **action-cost glyphs** (1/2/3/reaction/
  free). Precedent: Obsidian PF2e Statblocks, monster.pf2.tools. ([AoN reading statistics](https://2e.aonprd.com/Rules.aspx?ID=786),
  [monster.pf2.tools](https://monster.pf2.tools/))

### 6. Art pipeline → **trivial for terrain & tokens; offline-only for meshes**
- **Heightmap → terrain:** native and easy in Three.js — canvas `getImageData()` → vertex
  Z, or `displacementMap` on a *segmented* plane, or the `THREE.Terrain` lib. 8-bit gives
  256 levels (banding) — but for **blocky per-square elevation that's exactly what we
  want**. And heightmap→grid maps *better to 3D than to iso*, reinforcing layer 1.
  ([threejs-cookbook](https://github.com/josdirksen/threejs-cookbook/blob/master/02-geometries-meshes/02.06-create-terrain-from-heightmap.html),
  [displacementMap](https://sbcode.net/threejs/displacmentmap/),
  [THREE.Terrain](https://github.com/IceCreamYou/THREE.Terrain))
- **PNG → token/sprite:** `Sprite`/`SpriteMaterial` (auto-billboard) or a flat textured
  quad; `alphaTest` for clean edges. ([billboards](https://threejs.org/manual/en/billboards.html))
- **AI textures:** seamless/tileable generators are production-ready —
  `RepeatWrapping` + power-of-two sizes. ([seamless textures](https://normalmap.ai/learn/what-is-a-tileable-texture/))
- **Image → 3D mesh:** Meshy/Tripo/TRELLIS.2 export GLB that loads via `GLTFLoader`, but AI
  meshes have irregular topology → good for **static props**, **not** rigging/animation.
  Treat as **offline authoring** (generate → light cleanup → ship GLB), not runtime; TRELLIS.2
  self-hosting needs ≥24 GB VRAM. ([Meshy](https://www.meshy.ai/blog/best-ai-tools-for-3d-game-assets),
  [TRELLIS.2](https://github.com/microsoft/TRELLIS.2))

### 7. Animation & the 3-action economy → instant resolution, sequenced presentation

Animation and PF2e's action economy are one problem in a turn-based game: **actions are
resolved instantly and deterministically; animation is a presentation layer that replays
the result and sequences it, one action at a time.** This keeps the rules engine pure (the
AI can "play fast" with animations skipped) and makes the AI⇄human handoff clean, because
control only ever changes at action boundaries.

**The action economy (mechanical model).** Each turn a creature gets **3 actions + 1
reaction + free actions**. Model actions/activities as data — each declares an
`actionCost` (1/2/3/reaction/free) and a resolver:
- Single actions: Stride, Strike, Step, Raise a Shield, Interact, Stand.
- Activities cost more: most spells are 2 actions (some 1/3); abilities 1–3.
- **Multiple Attack Penalty:** 2nd Strike −5, 3rd −10 (−4/−8 with *agile*), reset each turn.
- **Reactions** fire off-turn on a trigger (e.g. Attack of Opportunity) and interrupt the
  acting creature — a small trigger/interrupt system layered on the turn loop.
The encounter tracks `actionsRemaining`, attacks-this-turn (for MAP), and a reaction flag,
with end-of-turn upkeep. This is the loop the AI plays and the human takes over.
(Mechanically this is the same engine sketched in the master plan's rules layer.)

**Animation, by render choice (follows from layer 4):**
- **Billboard sprites (recommended start) → procedural motion over mostly-static art.**
  Key consequence of AI/user-generated art: **AI is good at static images, unreliable at
  consistent multi-frame animation** — so do *not* AI-generate sprite sheets. Give each
  creature one or two static images and animate procedurally: move = lerp along the path;
  Strike = lunge toward target + scale-pop + impact flash on the defender; Cast =
  glow/scale pulse; hit = flinch/flash; death = topple/fade. Cheap, legible, and sidesteps
  the frame-consistency problem. (Later upgrade: the Octopath trick — render a low-poly
  model to flat frames offline — for real frame animation.)
- **Low-poly meshes → skeletal animation** via glTF clips + Three.js `AnimationMixer`
  (idle/walk/attack/cast/hit/die, crossfaded); one rig animates from any angle.
  **But** AI image→mesh gives un-riggable topology (layer 6), so mesh animation means
  hand-rigged or library assets — you trade the pure-AI-art creature pipeline for nicer
  motion.

**The bridge.** Each resolved action emits an event (StrikeResult, move path, cast) → the
renderer plays the matching clip/tween and **blocks turn advancement until it finishes**
(with a fast/skip mode for autonomous AI play). The HUD shows **3 action pips** that
deplete as actions are spent; reactions interrupt mid-action with their own short clip.

> **Caveat — the one immature piece:** AI-generated *animation* (image→animation, AI
> sprite-sheets) is not reliable enough to depend on today. The procedural-motion-over-
> static-art approach above is the pragmatic answer; revisit if the tooling matures.

---

## What to prototype first (de-risks the most)
1. **Heightfield grid mesh** from an integer height array (encounter map) rendered under an
   ortho iso camera — proves layers 1+2+6 at once.
2. **Center-to-center cover + symmetric shadowcasting LoS** on that grid with per-square
   height — the hardest, most game-defining rule (layer 3).
3. **A `Creature` loaded from a real `foundryvtt/pf2e` NPC JSON** placed on the grid as an
   alpha-tested billboard with the correct N×N footprint (layers 4+5).
4. **One turn end-to-end:** 3 action pips, a Stride (lerp move) and two Strikes (with MAP
   and procedural lunge/flash), then turn handoff — proves the instant-resolution /
   sequenced-presentation split (layer 7).

## Open risks
- Multi-level (true z-stacked) maps add real complexity to LoS/cover/pathfinding; keep the
  first slice single-level with per-square height, add z-levels later.
- Billboard-vs-mesh is reversible — start sprites, upgrade hot assets; don't over-invest
  early.
- Confirm the exact current `foundryvtt/pf2e` NPC JSON field paths against a live file when
  building the importer (schema drifts across releases).
