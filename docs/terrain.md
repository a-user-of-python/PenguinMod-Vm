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
    if <(terrain at world x (camera x) y (camera y)) = [ocean]> then
        ... push the player back / play a splash sound
```

Put the player sprite at the **screen** position of its world position:

```
go to x: (world x to screen x (player world x)) y: (world y to screen y (player world y))
```

## Concepts

- **World**: a stored heightmap of `size` x `size` tiles (512, 1024, or 2048).
  Values are normalized to 0 (lowest) .. 1 (highest).
- **Seed**: the same seed + size + octaves always rebuilds the identical world,
  so worlds are shareable and reproducible. `regenerate terrain` rebuilds it
  without changing your camera or zoom.
- **Camera**: the world point at the center of the stage. Move the camera to
  explore; the terrain re-renders automatically.
- **Zoom**: how many world tiles fit across the 480-pixel stage. Small zoom =
  close-up, large zoom = whole map.
- **Classification**: height below `sea level` is ocean, below
  `sea level + beach height` is beach, the rest is land. Adjust the two
  thresholds live and the map re-renders.

## Block reference

**Noise reporters** (roughly -1..1, deterministic from the seed):
- `perlin noise x, y` — raw Perlin value at a point (scaled x0.1 internally).
- `fractal noise x, y, octaves` — layered fBm, more detail with more octaves.
- `ridged noise x, y, octaves` — sharp mountain-ridge style noise (0..1).

**World**:
- `generate terrain seed, size, octaves` — builds the heightmap (may take a
  moment at 2048; it runs synchronously).
- `regenerate terrain` — rebuilds the identical world from the current seed.
- `height at world x, y` — bilinear-sampled height, 0..1 (0 outside the map).
- `terrain at world x, y` — `ocean`, `beach`, or `land`.
- `is land / is ocean / is beach at world x, y` — 1 or 0.
- `set sea level`, `set beach height`, `sea level`, `beach height`.
- `set ocean/beach/land color`, `terrain seed`, `world size`.

**Camera**:
- `set camera x/y`, `change camera x/y by`, `camera x`, `camera y`.
- `set zoom to N tiles across`, `zoom`.
- `world x to screen x`, `world y to screen y`,
  `screen x to world x`, `screen y to world y`.
- `show terrain`, `hide terrain`, `redraw terrain`.

## Notes

- The terrain renders to a background-layer drawable, so sprites always draw
  on top of it. Pen, video, and other stage layers are untouched.
- The heightmap lives in the extension for the session; it is not saved into
  the project file. Regenerate it on green flag (same seed = same world).
- Generation is synchronous: 512 is instant, 1024 takes ~0.5s, 2048 a few
  seconds on a desktop. Generate once at startup, then just move the camera.
