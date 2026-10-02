const test = require('tap').test;
const Terrain = require('../../src/extensions/sb_terrain');

// Minimal stand-ins so the extension can be constructed and driven headless.
const makeRenderer = () => ({
    updateDrawableSkinId () {},
    updateDrawableVisible () {},
    updateBitmapSkin () {}
});
const makeExt = () => new Terrain({renderer: makeRenderer(), requestRedraw () {}});

test('getInfo registers the sbTerrain extension', t => {
    const ext = makeExt();
    const info = ext.getInfo();
    t.equal(info.id, 'sbTerrain');
    t.ok(Array.isArray(info.blocks));
    t.ok(info.blocks.length > 20);
    // Every block's text arguments must exist in its argument definitions.
    for (const b of info.blocks) {
        if (typeof b === 'string') continue;
        const refs = [...b.text.matchAll(/\[([A-Z0-9_]+)\]/g)].map(m => m[1]);
        for (const r of refs) {
            t.ok(b.arguments[r], `block ${b.opcode} defines argument [${r}]`);
        }
    }
    t.end();
});

test('seeded noise is deterministic and seed-sensitive', t => {
    const ext = makeExt();
    ext.setNoiseSeed({SEED: 42});
    const a = ext.perlinNoise({X: 11, Y: 23});
    const b = ext.perlinNoise({X: 11, Y: 23});
    t.equal(a, b, 'same seed, same output');
    ext.setNoiseSeed({SEED: 43});
    const c = ext.perlinNoise({X: 11, Y: 23});
    t.notEqual(a, c, 'different seed, different output');
    t.end();
});

test('perlin output stays in a sane range', t => {
    const ext = makeExt();
    ext.setNoiseSeed({SEED: 12345});
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 60; i++) {
        for (let j = 0; j < 60; j++) {
            const v = ext.perlinNoise({X: (i * 1.7) + 0.3, Y: (j * 2.3) + 0.9});
            if (v < min) min = v;
            if (v > max) max = v;
        }
    }
    t.ok(min >= -1.05 && max <= 1.05, `range [${min.toFixed(3)}, ${max.toFixed(3)}]`);
    t.end();
});

test('fbm and ridged reporters are bounded and deterministic', t => {
    const ext = makeExt();
    ext.setNoiseSeed({SEED: 7});
    const f1 = ext.fractalNoise({X: 3.1, Y: 8.7, OCTAVES: 4});
    const f2 = ext.fractalNoise({X: 3.1, Y: 8.7, OCTAVES: 4});
    t.equal(f1, f2);
    t.ok(f1 >= -1.15 && f1 <= 1.15, `fbm in range: ${f1}`);
    const r = ext.ridgedNoise({X: 3.1, Y: 8.7, OCTAVES: 4});
    t.ok(r >= -0.05 && r <= 1.05, `ridged in range: ${r}`);
    const fMore = ext.fractalNoise({X: 3.1, Y: 8.7, OCTAVES: 8});
    t.notEqual(f1, fMore, 'octave count changes output');
    t.end();
});

test('generateTerrain stores a normalized heightmap', t => {
    const ext = makeExt();
    t.equal(ext.terrainGenerated(), false, 'nothing generated initially');
    t.equal(ext.terrainHeight({X: 5, Y: 5}), 0, 'height safe default');
    t.equal(ext.tileAt({X: 5, Y: 5}), 'ocean', 'tile safe default');
    ext.generateTerrain({SEED: 12345, SIZE: 256, OCTAVES: 5});
    t.equal(ext.terrainGenerated(), true);
    t.equal(ext.terrainSize(), 256);
    t.equal(ext._height.length, 256 * 256);
    let min = Infinity;
    let max = -Infinity;
    for (const v of ext._height) {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    t.equal(min, 0);
    t.equal(max, 1);
    t.end();
});

test('same seed regenerates the identical world', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 12345, SIZE: 256, OCTAVES: 5});
    const h1 = ext.terrainHeight({X: 33.5, Y: 77.25});
    ext.generateTerrain({SEED: 12345, SIZE: 256, OCTAVES: 5});
    t.equal(ext.terrainHeight({X: 33.5, Y: 77.25}), h1);
    ext.generateTerrain({SEED: 999, SIZE: 256, OCTAVES: 5});
    t.notEqual(ext.terrainHeight({X: 33.5, Y: 77.25}), h1, 'different seed, different world');
    t.end();
});

test('world size clamps to the 64..2048 range', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 1, SIZE: 10, OCTAVES: 3});
    t.equal(ext.terrainSize(), 64);
    ext.generateTerrain({SEED: 1, SIZE: 99999, OCTAVES: 3});
    t.equal(ext.terrainSize(), 2048);
    t.end();
});

test('terrainHeight uses bilinear sampling and world bounds', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 12345, SIZE: 256, OCTAVES: 5});
    const a = ext.terrainHeight({X: 10, Y: 10});
    const b = ext.terrainHeight({X: 11, Y: 10});
    const mid = ext.terrainHeight({X: 10.5, Y: 10});
    t.ok(mid >= Math.min(a, b) - 1e-6 && mid <= Math.max(a, b) + 1e-6,
        'bilinear midpoint stays between its neighbors');
    t.equal(ext.terrainHeight({X: -100, Y: 0}), 0, 'out of bounds clamps');
    t.equal(ext.terrainHeight({X: 100000, Y: 0}), 0, 'out of bounds clamps');
    t.end();
});

test('land/ocean/beach classification and thresholds', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 12345, SIZE: 256, OCTAVES: 5});
    const sample = () => {
        const counts = {ocean: 0, beach: 0, land: 0};
        for (let y = 0; y < 256; y += 4) {
            for (let x = 0; x < 256; x += 4) {
                counts[ext.tileAt({X: x, Y: y})]++;
            }
        }
        return counts;
    };
    const mid = sample();
    t.ok(mid.ocean > 0 && mid.beach > 0 && mid.land > 0,
        `all three classes present: ${JSON.stringify(mid)}`);
    const h128 = ext.terrainHeight({X: 128, Y: 128});
    const expectTile = h128 < 0 ? 'ocean' : ext.tileAt({X: 128, Y: 128});
    t.equal(ext.tileAt({X: 128, Y: 128}), expectTile);
    const low = sample();
    ext.setSeaLevel({LEVEL: 0.9});
    const high = sample();
    t.ok(low.ocean <= mid.ocean && mid.ocean <= high.ocean,
        'ocean grows as the sea level rises');
    t.equal(ext.seaLevel(), 0.9);
    t.end();
});

test('world/screen coordinate conversion round-trips', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 42, SIZE: 256, OCTAVES: 3});
    ext.setCamera({X: 128, Y: 128});
    ext.setZoom({ZOOM: 96});
    const sx = ext.screenXOfWorld({WX: 160});
    const sy = ext.screenYOfWorld({WY: 96});
    t.equal(Math.round(ext.worldXOfScreen({SX: sx})), 160);
    t.equal(Math.round(ext.worldYOfScreen({SY: sy})), 96);
    t.end();
});

test('camera and zoom setters behave', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 42, SIZE: 256, OCTAVES: 3});
    ext.setZoom({ZOOM: 0});
    t.equal(ext.zoom(), 8, 'zoom clamps to minimum');
    ext.setZoom({ZOOM: 100000});
    t.equal(ext.zoom(), 256, 'zoom clamps to world size');
    ext.setCamera({X: 128, Y: 128});
    ext.changeCameraX({DX: 50});
    ext.changeCameraY({DY: -25});
    t.equal(ext.cameraX(), 178);
    t.equal(ext.cameraY(), 103);
    t.end();
});

test('color setter stores the chosen target color', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 1, SIZE: 64, OCTAVES: 2});
    ext.setTerrainColor({TARGET: 'ocean', COLOR: '#ff0000'});
    t.equal(ext._colors.ocean, '#ff0000');
    ext.setTerrainColor({TARGET: 'bogus', COLOR: '#00ff00'});
    t.equal(ext._colors.ocean, '#ff0000', 'unknown target ignored');
    t.end();
});

test('large world generates in reasonable time', t => {
    const ext = makeExt();
    const start = Date.now();
    ext.generateTerrain({SEED: 5, SIZE: 1024, OCTAVES: 5});
    const ms = Date.now() - start;
    t.ok(ms < 10000, `1024 world generated in ${ms}ms`);
    t.end();
});

test('setTerrainLevels sets ocean and beach thresholds together', t => {
    const ext = makeExt();
    // Works before any world exists (no heightmap needed).
    ext.setTerrainLevels({OCEAN: 0.6, BEACH: 0.1});
    t.equal(ext.seaLevel(), 0.6);
    t.equal(ext.beachHeight(), 0.1);
    // Values are clamped into [0, 1].
    ext.setTerrainLevels({OCEAN: -2, BEACH: 5});
    t.equal(ext.seaLevel(), 0);
    t.equal(ext.beachHeight(), 1);
    // Thresholds take effect on classification immediately.
    ext.generateTerrain({SEED: 12345, SIZE: 256, OCTAVES: 5});
    ext.setTerrainLevels({OCEAN: 0.99, BEACH: 0});
    let ocean = 0;
    for (let y = 0; y < 256; y += 8) {
        for (let x = 0; x < 256; x += 8) {
            if (ext.tileAt({X: x, Y: y}) === 'ocean') ocean++;
        }
    }
    t.ok(ocean > 900, `near-total ocean at sea level 0.99 (got ${ocean})`);
    ext.setTerrainLevels({OCEAN: 0.01, BEACH: 0});
    let land = 0;
    for (let y = 0; y < 256; y += 8) {
        for (let x = 0; x < 256; x += 8) {
            if (ext.tileAt({X: x, Y: y}) === 'land') land++;
        }
    }
    t.ok(land > 900, `near-total land at sea level 0.01 (got ${land})`);
    // The block is registered in the palette metadata.
    const info = ext.getInfo();
    const block = info.blocks.find(b => b.opcode === 'setTerrainLevels');
    t.ok(block, 'setTerrainLevels is registered');
    t.equal(block.arguments.OCEAN.defaultValue, 0.45);
    t.equal(block.arguments.BEACH.defaultValue, 0.035);
    t.end();
});

test('garbage inputs cannot corrupt extension state', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 7, SIZE: 256, OCTAVES: 4});

    // Infinity inputs are ignored, keeping the previous values.
    ext.setSeaLevel({LEVEL: Infinity});
    ext.setSeaLevel({LEVEL: -Infinity});
    t.equal(ext.seaLevel(), 0.45, 'sea level survives Infinity');
    ext.setBeachHeight({HEIGHT: Infinity});
    t.equal(ext.beachHeight(), 0.035, 'beach height survives Infinity');
    ext.setTerrainLevels({OCEAN: Infinity, BEACH: -Infinity});
    t.equal(ext.seaLevel(), 0.45, 'combined block ignores Infinity ocean');
    t.equal(ext.beachHeight(), 0.035, 'combined block ignores -Infinity beach');
    ext.setZoom({ZOOM: Infinity});
    ext.changeZoom({DELTA: -Infinity});
    t.equal(ext.zoom(), 120, 'zoom survives Infinity');
    ext.setCamera({X: 100, Y: 100});
    ext.setCamera({X: Infinity, Y: 50});
    ext.changeCameraX({DX: -Infinity});
    ext.changeCameraY({DY: Infinity});
    t.equal(ext.cameraX(), 100, 'camera x survives Infinity');
    t.equal(ext.cameraY(), 100, 'camera y survives Infinity');

    // NaN is normalized to 0 by Scratch's Cast before the extension sees it,
    // exactly as real blocks behave; state must stay finite and consistent.
    ext.setSeaLevel({LEVEL: NaN});
    t.equal(ext.seaLevel(), 0, 'NaN casts to 0 like Scratch');
    ext.setZoom({ZOOM: NaN});
    t.equal(ext.zoom(), 8, 'NaN zoom clamps to minimum');
    const stateFinite = () => [ext.seaLevel(), ext.beachHeight(), ext.zoom(),
        ext.cameraX(), ext.cameraY()].every(isFinite);
    t.ok(stateFinite(), 'all state finite after NaN inputs');

    // Non-finite generation inputs fall back to sane defaults (never NaN size).
    ext.generateTerrain({SEED: NaN, SIZE: NaN, OCTAVES: NaN});
    t.equal(ext.terrainSize(), 64, 'Cast-mapped 0 size clamps to 64');
    t.ok(ext.terrainGenerated(), 'world still generated');
    ext.generateTerrain({SEED: 1, SIZE: Infinity, OCTAVES: -Infinity});
    t.equal(ext.terrainSize(), 1024, 'Infinity size falls back to 1024');
    let nanFound = false;
    for (let i = 0; i < ext._height.length; i += 97) {
        if (!isFinite(ext._height[i])) { nanFound = true; break; }
    }
    t.equal(nanFound, false, 'no NaN in heightmap after bad inputs');

    // Reporters never return NaN for non-finite inputs.
    t.ok(isFinite(ext.terrainHeight({X: Infinity, Y: -Infinity})));
    t.equal(ext.tileAt({X: Infinity, Y: 5}), 'ocean', 'Infinity coords use safe default');
    t.equal(ext.tileAt({X: NaN, Y: NaN}), ext.tileAt({X: 0, Y: 0}),
        'NaN coords cast to 0 like Scratch');
    t.equal(ext.perlinNoise({X: Infinity, Y: 1}), 0);
    t.equal(ext.fractalNoise({X: 1, Y: -Infinity, OCTAVES: Infinity}), 0);
    t.equal(ext.ridgedNoise({X: NaN, Y: NaN, OCTAVES: NaN}),
        ext.ridgedNoise({X: 0, Y: 0, OCTAVES: 0}),
        'NaN noise inputs cast to 0 like Scratch');
    t.ok(isFinite(ext.screenXOfWorld({WX: Infinity})));
    t.ok(isFinite(ext.screenYOfWorld({WY: -Infinity})));
    t.ok(isFinite(ext.worldXOfScreen({SX: NaN})));
    t.ok(isFinite(ext.worldYOfScreen({SY: NaN})));

    // Garbage strings behave like Scratch: Cast.toNumber maps them to 0.
    ext.setSeaLevel({LEVEL: 'pudding'});
    t.equal(ext.seaLevel(), 0, 'garbage string casts to 0');
    t.equal(ext.terrainHeight({X: 'abc', Y: 'def'}),
        ext.terrainHeight({X: 0, Y: 0}),
        'garbage strings cast to 0 like Scratch does');
    t.ok(stateFinite(), 'all state finite at the end');
    t.end();
});

test('camera changes that would overflow are ignored', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 7, SIZE: 256, OCTAVES: 4});
    ext.setCamera({X: 1e308, Y: 0});
    t.equal(ext.cameraX(), 1e308);
    ext.changeCameraX({DX: 1e308}); // 1e308 + 1e308 = Infinity
    t.equal(ext.cameraX(), 1e308, 'overflowing change ignored');
    t.ok(isFinite(ext.cameraX()), 'camera x stays finite');
    ext.setCamera({X: 0, Y: -1e308});
    ext.changeCameraY({DY: -1e308});
    t.equal(ext.cameraY(), -1e308, 'overflowing change ignored');
    t.ok(isFinite(ext.cameraY()), 'camera y stays finite');
    // Normal changes still work after a rejected one.
    ext.changeCameraX({DX: 5});
    t.equal(ext.cameraX(), 5);
    t.end();
});

test('noise reporters never return NaN, even for extreme inputs', t => {
    const ext = makeExt();
    ext.setNoiseSeed({SEED: 42});
    const cases = [
        [() => ext.perlinNoise({X: 1e308, Y: 1e308}), 'perlin extreme'],
        [() => ext.fractalNoise({X: 1e308, Y: -1e308, OCTAVES: 100}), 'fbm extreme'],
        [() => ext.ridgedNoise({X: -1e308, Y: 1e308, OCTAVES: 100}), 'ridged extreme'],
        [() => ext.fractalNoise({X: 1e308, Y: 1e308, OCTAVES: 12}), 'fbm huge coords'],
        [() => ext.ridgedNoise({X: 0, Y: 0, OCTAVES: 1e308}), 'ridged huge octaves']
    ];
    for (const [fn, name] of cases) {
        const r = fn();
        t.ok(isFinite(r), `${name} is finite (got ${r})`);
    }
    t.end();
});
