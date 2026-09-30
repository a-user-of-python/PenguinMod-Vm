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
