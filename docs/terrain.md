# Terrain extension (sbTerrain)

Generates seeded, natural-looking terrain worlds from noise and renders them
behind your sprites. Built for exploration games: the world is **stored data**,
and the camera moves through it — your sprites stay where they are.

## Quick start: a walkable world

```
when green flag clicked
generate terrain seed [12345] size [1024] octaves [5]
set camera x to [512] y to [512]
set zoom to [96] tiles across
show terrain
```

Player movement (world coordinates, viewport stays smooth):

```
forever
    if <key [right arrow] pressed?> then change camera x by [4]
    if <key [left arrow] pressed?> then change camera x by [-4]
    if <key [up arrow] pressed?> then change camera y by [4]
    if <key [down arrow] pressed?> then change camera y by [-4]
    if <(tile type at x (camera x) y (camera y)) = [ocean]> then
        ... push the player back / play a splash sound
```

## Concepts

- **World**: a stored heightmap of `size` x `size` tiles (64 .. 5120).
  Values are normalized to 0 (lowest) .. 1 (highest). Sizes above 2048 use a
  faster generator and build asynchronously with a progress reporter.
- **Infinite world**: outside the stored map, terrain is sampled on demand
  from the same seeded noise, so there is effectively no edge — you can keep
  walking forever. `terrain generation progress` reports 0..1 while building.
- **Seed**: the same seed + size + octaves always rebuilds the identical
  world, so worlds are shareable and reproducible. Worlds of size 2048 and
  below are bit-identical to the first release.
- **Camera**: the world point at the center of the stage. Move the camera to
  explore; the terrain re-renders automatically.
- **Zoom**: how many world tiles fit across the 480-pixel stage. Small zoom =
  close-up, large zoom = whole map.
- **Biomes**: heights are classified into five tiers — `ocean`, `beach`,
  `grass`, `mountain`, `snowy peak` (highest). Sandy beach clearings also
  appear as patches fully surrounded by grass. Thresholds are enforced in
  order: sea < beach top <= mountain line <= snow line.

## Block reference

**Noise reporters** (roughly -1..1, deterministic from the seed):
- `perlin noise x, y` — raw Perlin value at a point (scaled x0.1 internally).
- `fractal noise x, y, octaves` — layered fBm, more detail with more octaves.
- `ridged noise x, y, octaves` — sharp mountain-ridge style noise (0..1).

**World**:
- `generate terrain seed, size, octaves` — builds the heightmap. Sizes 64..2048
  build synchronously and are bit-identical to the first release; 4096/5120
  build in the background (the block waits until done).
- `terrain generation progress` — 0..1 while a huge world builds.
- `height at world x, y` — bilinear-sampled height, 0..1, at any coordinate
  (outside the stored map it is sampled from the seeded noise — no edge).
- `tile type at x, y` — `ocean`, `beach`, `grass`, `mountain`, or `snow`.
- `terrain zone at x, y` — `deep ocean`, `ocean`, `shallows`, `beach`,
  `grass`, `mountain`, or `snowy peak`.
- `water depth at x, y` / `height above sea at x, y` — 0 when not applicable.
- `set sea level`, `set beach height`, `sea level`, `beach height`.
- `set ocean level [OCEAN] and beach height [BEACH]` — set both in one block.
- `set mountain line [M] and snow line [S]` — heights above M are mountains,
  above S are snowy (ordering is enforced automatically).
- `set [ocean/beach/grass/mountain/snow] color to`, `terrain seed`,
  `world size`.

**Sprites in the world** (the map can stay fixed while sprites move):
- `anchor [SPRITE] to world` / `unanchor [SPRITE]` / `is [SPRITE] anchored?` —
  anchored sprites keep their world position when the camera moves.
- `move [SPRITE] in world by dx, dy` — moves the sprite across the world
  without moving the camera or map.
- `set [SPRITE] world position`, `world x/y of [SPRITE]`.
- `point [SPRITE] towards world x, y`.
- `camera follow [SPRITE]` / `stop camera follow` — optional follow mode.
- `update anchored sprites` — call in a loop to apply camera-follow motion.
- `terrain zone at [SPRITE]` — zone query locked to a moving sprite.
- `current zone` — the zone where *this* sprite is right now; use it like a
  variable in any block or custom function — it updates as you move.
- `when I enter [zone]` — hat block that runs once each time this sprite
  moves into the chosen zone (deep ocean, ocean, shallows, beach, grass,
  mountain, snowy peak).

**Structures**:
- `generate structures with density [0-100]` — scatters named structures on
  grass using a second noise field compared against the land map.
- `structure at world x, y` — `house`, `tower`, `tree`, `boulder`, `well`,
  `windmill`, `dungeon`, or empty. Seven structure images are embedded in the
  extension and drawn on the map, each at its own size — a dungeon looms over
  a house, a boulder is small.
- `show/hide structures`, `structures visible?`.

**Minimap**:
- `show minimap size [N] at [corner]` — draws a small whole-world map in a
  corner of the stage (top/bottom × left/right, your choice). Size is the
  square's side in pixels, clamped to 32–240; junk sizes keep the previous
  size. The minimap floats above the sprites and shows the whole stored
  world, a white frame, a rectangle marking what the camera currently sees,
  and a red dot for the camera-followed sprite.
- `hide minimap`, `minimap visible?`.

**Camera**:
- `set camera x/y`, `change camera x/y by`, `camera x`, `camera y`.
- `set zoom to N tiles across`, `change zoom`, `zoom`.
- `world x to screen x`, `world y to screen y`,
  `screen x to world x`, `screen y to world y`.
- `show terrain`, `hide terrain`, `redraw terrain`.

## Notes

- The terrain renders to a background-layer drawable, so sprites always draw
  on top of it. Pen, video, and other stage layers are untouched.
- The heightmap lives in the extension for the session; it is not saved into
  the project file. Regenerate it on green flag (same seed = same world).
- Starting a new generation always cancels one already in flight.
- All numeric inputs are hardened: Infinity is ignored, NaN becomes 0, and
  out-of-range values are clamped, so hostile inputs can't corrupt the map.
