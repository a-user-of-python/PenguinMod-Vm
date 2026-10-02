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

test('world size clamps to the 64..5120 range', async t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 1, SIZE: 10, OCTAVES: 3});
    t.equal(ext.terrainSize(), 64);
    await ext.generateTerrain({SEED: 1, SIZE: 99999, OCTAVES: 3});
    t.equal(ext.terrainSize(), 5120);
    t.end();
});

test('terrainHeight uses bilinear sampling and samples infinitely', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 12345, SIZE: 256, OCTAVES: 5});
    const a = ext.terrainHeight({X: 10, Y: 10});
    const b = ext.terrainHeight({X: 11, Y: 10});
    const mid = ext.terrainHeight({X: 10.5, Y: 10});
    t.ok(mid >= Math.min(a, b) - 1e-6 && mid <= Math.max(a, b) + 1e-6,
        'bilinear midpoint stays between its neighbors');
    // No end to the world: out-of-bounds sampling stays finite and in [0, 1].
    for (const [x, y] of [[-100, 0], [100000, 0], [-1e9, 1e9]]) {
        const h = ext.terrainHeight({X: x, Y: y});
        t.ok(isFinite(h) && h >= 0 && h <= 1, `infinite sample at (${x},${y}) = ${h}`);
    }
    t.end();
});

test('land/ocean/beach classification and thresholds', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 12345, SIZE: 256, OCTAVES: 5});
    const sample = () => {
        const counts = {ocean: 0, beach: 0, grass: 0, mountain: 0, snow: 0};
        for (let y = 0; y < 256; y += 4) {
            for (let x = 0; x < 256; x += 4) {
                counts[ext.tileAt({X: x, Y: y})]++;
            }
        }
        return counts;
    };
    const mid = sample();
    t.ok(mid.ocean > 0 && mid.beach > 0 && mid.grass > 0,
        `ocean/beach/grass present: ${JSON.stringify(mid)}`);
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
    t.equal(ext.zoom(), 4, 'zoom clamps to minimum');
    ext.setZoom({ZOOM: 100000});
    t.equal(ext.zoom(), 8192, 'zoom clamps to maximum');
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
            const tile = ext.tileAt({X: x, Y: y});
            if (tile === 'grass' || tile === 'mountain' || tile === 'snow') land++;
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
    t.equal(ext.zoom(), 4, 'NaN zoom clamps to minimum');
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

test('generateTerrain accepts sizes up to 5120 with legacy snap below 2048', async t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 1, SIZE: 100, OCTAVES: 5});
    t.equal(ext.terrainSize(), 128, 'legacy power-of-two snap preserved');
    await ext.generateTerrain({SEED: 1, SIZE: 3000, OCTAVES: 5});
    t.equal(ext.terrainSize(), 3000, 'no snap above 2048');
    t.end();
});

test('large worlds generate asynchronously without freezing', async t => {
    const ext = makeExt();
    const r = ext.generateTerrain({SEED: 99, SIZE: 2100, OCTAVES: 5});
    t.ok(r && typeof r.then === 'function', 'returns a promise for huge worlds');
    t.ok(ext.terrainGenProgress() < 1, 'progress starts below 1');
    await r;
    t.equal(ext.terrainGenProgress(), 1, 'progress reaches 1');
    t.equal(ext.terrainSize(), 2100);
    t.ok(ext.terrainGenerated());
    const h = ext.terrainHeight({X: 1000.5, Y: 1000.5});
    t.ok(h >= 0 && h <= 1, `height in range: ${h}`);
    t.end();
});

test('small worlds stay synchronous', t => {
    const ext = makeExt();
    const r = ext.generateTerrain({SEED: 5, SIZE: 256, OCTAVES: 5});
    t.notOk(r && typeof r.then === 'function', 'no promise for small worlds');
    t.equal(ext.terrainGenProgress(), 1);
    t.end();
});

test('infinite sampling: finite heights everywhere, no end', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 12345, SIZE: 256, OCTAVES: 5});
    const pts = [[-1e6, -1e6], [1e12, 5], [1e308, 1e308], [-0.5, 300], [1e9, -1e9]];
    for (const [x, y] of pts) {
        const h = ext.terrainHeight({X: x, Y: y});
        t.ok(isFinite(h) && h >= 0 && h <= 1, `height at (${x},${y}) = ${h}`);
        t.ok(['ocean', 'beach', 'grass', 'mountain', 'snow'].includes(ext.tileAt({X: x, Y: y})));
        t.ok(['deep ocean', 'ocean', 'shallows', 'beach', 'grass', 'mountain', 'snowy peak']
            .includes(ext.terrainZoneAt({X: x, Y: y})));
    }
    t.end();
});

test('zones, depth and altitude are consistent', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 12345, SIZE: 256, OCTAVES: 5});
    // Find one ocean and one grass tile by scanning.
    let oceanPt = null;
    let grassPt = null;
    for (let y = 0; y < 256 && (!oceanPt || !grassPt); y += 4) {
        for (let x = 0; x < 256 && (!oceanPt || !grassPt); x += 4) {
            const tile = ext.tileAt({X: x, Y: y});
            if (tile === 'ocean' && !oceanPt) oceanPt = [x, y];
            if (tile === 'grass' && !grassPt) grassPt = [x, y];
        }
    }
    t.ok(oceanPt && grassPt, 'found ocean and grass samples');
    t.ok(ext.waterDepthAt({X: oceanPt[0], Y: oceanPt[1]}) > 0, 'ocean has depth');
    t.equal(ext.heightAboveSeaAt({X: oceanPt[0], Y: oceanPt[1]}), 0, 'ocean has no altitude');
    t.ok(ext.heightAboveSeaAt({X: grassPt[0], Y: grassPt[1]}) > 0, 'grass has altitude');
    t.equal(ext.waterDepthAt({X: grassPt[0], Y: grassPt[1]}), 0, 'grass has no depth');
    t.end();
});

test('mountain/snow tiers, sandy clearings and threshold ordering', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 12345, SIZE: 256, OCTAVES: 5});
    // All five tile types appear on a default world.
    const seen = new Set();
    for (let y = 0; y < 256; y += 2) {
        for (let x = 0; x < 256; x += 2) {
            seen.add(ext.tileAt({X: x, Y: y}));
        }
    }
    for (const want of ['ocean', 'beach', 'grass', 'mountain', 'snow']) {
        t.ok(seen.has(want), `tile type '${want}' exists`);
    }
    // Sandy clearings: beach tiles fully surrounded by grass (no ocean nearby).
    let clearing = null;
    outer: for (let y = 4; y < 252; y += 2) {
        for (let x = 4; x < 252; x += 2) {
            if (ext.tileAt({X: x, Y: y}) !== 'beach') continue;
            let allGrass = true;
            for (let dy = -3; dy <= 3 && allGrass; dy++) {
                for (let dx = -3; dx <= 3; dx++) {
                    if (ext.tileAt({X: x + dx, Y: y + dy}) === 'ocean') {
                        allGrass = false;
                        break;
                    }
                }
            }
            if (allGrass) {
                // Confirm the ring around it really is grass, not mountain/snow.
                let ringGrass = true;
                for (let dy = -2; dy <= 2 && ringGrass; dy++) {
                    for (let dx = -2; dx <= 2; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        if (ext.tileAt({X: x + dx, Y: y + dy}) !== 'grass') {
                            ringGrass = false;
                            break;
                        }
                    }
                }
                if (ringGrass) { clearing = [x, y]; break outer; }
            }
        }
    }
    t.ok(clearing, `inland beach clearing surrounded by grass at ${clearing}`);
    // Mountain/snow setters keep ordering: sea < beachTop <= mountain <= snow.
    ext.setMountainSnow({MOUNTAIN: 0.9, SNOW: 0.1});
    t.ok(ext.mountainLine() <= ext.snowLine(), 'snow stays above mountain');
    ext.setTerrainLevels({OCEAN: 0.95, BEACH: 0.2});
    t.ok(ext.mountainLine() >= 0.95, 'mountain pushed above raised beach');
    t.ok(ext.snowLine() >= ext.mountainLine(), 'snow still on top');
    t.ok(ext.snowLine() <= 1, 'snow clamped to 1');
    ext.setMountainSnow({MOUNTAIN: NaN, SNOW: Infinity});
    t.ok(isFinite(ext.mountainLine()) && isFinite(ext.snowLine()), 'bad tier inputs ignored');
    // Recolor the new tiers, including the legacy 'land' alias.
    ext.setTerrainColor({TARGET: 'mountain', COLOR: '#ff0000'});
    ext.setTerrainColor({TARGET: 'land', COLOR: '#00ff00'});
    ext.setTerrainColor({TARGET: 'snow', COLOR: '#0000ff'});
    t.end();
});

// ---- sprite world tools (stub runtime + fake sprite) ----

const makeSpriteTarget = (id, name) => ({
    id: id,
    isStage: false,
    sprite: {name: name},
    x: 0,
    y: 0,
    direction: 90,
    setXY (x, y) { this.x = x; this.y = y; },
    setDirection (d) { this.direction = d; }
});
const makeSpriteExt = () => {
    const hero = makeSpriteTarget('hero-id', 'Hero');
    const runtime = {
        renderer: null,
        requestRedraw () {},
        getSpriteTargetByName (n) { return n === 'Hero' ? hero : undefined; },
        getTargetById (id) { return id === 'hero-id' ? hero : undefined; }
    };
    const Terrain = require('../../src/extensions/sb_terrain');
    const ext = new Terrain(runtime);
    const util = {target: hero};
    return {ext, hero, util};
};

test('sprite anchor/move/world-position blocks', t => {
    const {ext, hero, util} = makeSpriteExt();
    ext.generateTerrain({SEED: 7, SIZE: 256, OCTAVES: 5});
    t.equal(ext.spriteAnchored({SPRITE: ''}, util), false);
    ext.anchorSprite({SPRITE: ''}, util);
    t.equal(ext.spriteAnchored({SPRITE: ''}, util), true);
    t.equal(ext.spriteAnchored({SPRITE: 'Nobody'}, util), false, 'unknown sprite not anchored');
    // Camera starts at world center (128,128); sprite at screen (0,0) => world (128,128).
    t.equal(ext.spriteWorldX({SPRITE: ''}, util), 128);
    t.equal(ext.spriteWorldY({SPRITE: ''}, util), 128);
    ext.moveSpriteInWorld({SPRITE: '', DX: 10, DY: -5}, util);
    t.equal(ext.spriteWorldX({SPRITE: ''}, util), 138);
    t.equal(ext.spriteWorldY({SPRITE: ''}, util), 123);
    ext.setSpriteWorldPos({SPRITE: '', X: 200, Y: 200}, util);
    t.equal(ext.spriteWorldX({SPRITE: ''}, util), 200);
    t.equal(ext.spriteWorldY({SPRITE: ''}, util), 200);
    // Panning the camera keeps the anchored sprite glued to its world spot.
    ext.setCamera({X: 148, Y: 148});
    t.equal(ext.spriteWorldX({SPRITE: ''}, util), 200, 'world pos unchanged by pan');
    t.equal(hero.x, (200 - 148) * (480 / ext.zoom()), 'screen pos shifted by pan');
    ext.unanchorSprite({SPRITE: ''}, util);
    t.equal(ext.spriteAnchored({SPRITE: ''}, util), false);
    t.end();
});

test('camera follow locks onto the sprite', t => {
    const {ext, hero, util} = makeSpriteExt();
    ext.generateTerrain({SEED: 7, SIZE: 256, OCTAVES: 5});
    ext.setSpriteWorldPos({SPRITE: 'Hero', X: 200, Y: 200}, util);
    ext.cameraFollow({SPRITE: 'Hero'}, util);
    ext.updateAnchoredSprites({}, util);
    t.ok(Math.abs(ext.cameraX() - 200) < 1e-9, `camera x follows: ${ext.cameraX()}`);
    t.ok(Math.abs(ext.cameraY() - 200) < 1e-9, `camera y follows: ${ext.cameraY()}`);
    t.ok(Math.abs(hero.x) < 1e-9 && Math.abs(hero.y) < 1e-9, 'sprite centered on screen');
    ext.stopCameraFollow();
    ext.setCamera({X: 0, Y: 0});
    t.equal(ext.cameraX(), 0, 'camera free after stop');
    t.end();
});

test('point sprite towards world position', t => {
    const {ext, hero, util} = makeSpriteExt();
    ext.generateTerrain({SEED: 7, SIZE: 256, OCTAVES: 5});
    ext.setSpriteWorldPos({SPRITE: '', X: 128, Y: 128}, util);
    ext.pointSpriteTowardsWorld({SPRITE: '', X: 228, Y: 128}, util); // due east in world
    t.ok(Math.abs(hero.direction - 90) < 1e-9, `faces east: ${hero.direction}`);
    ext.pointSpriteTowardsWorld({SPRITE: '', X: 128, Y: 228}, util); // due north
    t.ok(Math.abs(hero.direction - 0) < 1e-9, `faces north: ${hero.direction}`);
    ext.pointSpriteTowardsWorld({SPRITE: '', X: 128, Y: 128}, util); // same spot: no-op
    t.ok(isFinite(hero.direction), 'no NaN when pointing at self');
    t.end();
});

test('zoom keeps anchored sprites on their world spots', t => {
    const {ext, hero, util} = makeSpriteExt();
    ext.generateTerrain({SEED: 7, SIZE: 256, OCTAVES: 5});
    ext.setSpriteWorldPos({SPRITE: '', X: 150, Y: 150}, util);
    ext.anchorSprite({SPRITE: ''}, util);
    ext.setZoom({ZOOM: 60});
    t.ok(Math.abs(ext.spriteWorldX({SPRITE: ''}, util) - 150) < 1e-9, 'world x kept across zoom');
    t.ok(Math.abs(ext.spriteWorldY({SPRITE: ''}, util) - 150) < 1e-9, 'world y kept across zoom');
    t.end();
});

test('terrain zone locks to a sprite', t => {
    const {ext, hero, util} = makeSpriteExt();
    ext.generateTerrain({SEED: 12345, SIZE: 256, OCTAVES: 5});
    ext.setSpriteWorldPos({SPRITE: '', X: 10, Y: 10}, util);
    const viaSprite = ext.terrainZoneAtSprite({SPRITE: ''}, util);
    const viaCoords = ext.terrainZoneAt({X: 10, Y: 10});
    t.equal(viaSprite, viaCoords, 'sprite-locked zone matches coordinate zone');
    t.equal(ext.terrainZoneAtSprite({SPRITE: 'Nobody'}, util), 'ocean', 'unknown sprite safe default');
    t.end();
});

test('structures are deterministic and density-sensitive', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 4242, SIZE: 256, OCTAVES: 5});
    ext.generateStructures({DENSITY: 40});
    const a = ext.structureAt({X: 50, Y: 60});
    t.equal(a, ext.structureAt({X: 50, Y: 60}), 'same tile, same answer');
    t.ok(a === '' || ['house', 'tower', 'tree', 'boulder', 'well', 'windmill'].includes(a));
    // Count structures in a sweep at two densities.
    let count40 = 0;
    for (let y = 0; y < 256; y += 2) {
        for (let x = 0; x < 256; x += 2) {
            if (ext.structureAt({X: x, Y: y}) !== '') count40++;
        }
    }
    ext.generateStructures({DENSITY: 0});
    let count0 = 0;
    for (let y = 0; y < 256; y += 2) {
        for (let x = 0; x < 256; x += 2) {
            if (ext.structureAt({X: x, Y: y}) !== '') count0++;
        }
    }
    t.equal(count0, 0, 'density 0 places nothing');
    t.ok(count40 > 0, `density 40 places structures (${count40})`);
    // NaN casts to 0 via Scratch's Cast (like setSeaLevel etc.), so density 0.
    ext.generateStructures({DENSITY: 40});
    ext.generateStructures({DENSITY: NaN});
    let countNaN = 0;
    for (let y = 0; y < 256; y += 8) {
        for (let x = 0; x < 256; x += 8) {
            if (ext.structureAt({X: x, Y: y}) !== '') countNaN++;
        }
    }
    t.equal(countNaN, 0, 'NaN density casts to 0 like Scratch');
    // Infinity is ignored, keeping the previous setting.
    ext.generateStructures({DENSITY: 40});
    ext.generateStructures({DENSITY: Infinity});
    let countInf = 0;
    for (let y = 0; y < 256; y += 8) {
        for (let x = 0; x < 256; x += 8) {
            if (ext.structureAt({X: x, Y: y}) !== '') countInf++;
        }
    }
    t.ok(countInf > 0, 'Infinity density ignored, previous kept');
    t.equal(ext.structureAt({X: NaN, Y: 5}), '', 'NaN coords safe');
    t.end();
});

test('structure visibility toggles', t => {
    const ext = makeExt();
    t.equal(ext.structuresVisible(), true);
    ext.showStructures({SHOWHIDE: 'hide'});
    t.equal(ext.structuresVisible(), false);
    ext.showStructures({SHOWHIDE: 'show'});
    t.equal(ext.structuresVisible(), true);
    t.end();
});

test('getInfo covers every block argument and the new menus', t => {
    const ext = makeExt();
    const info = ext.getInfo();
    const blocks = info.blocks.filter(b => typeof b !== 'string');
    t.ok(blocks.length >= 55, `block count grew: ${blocks.length}`);
    for (const b of blocks) {
        const refs = [...b.text.matchAll(/\[([A-Z0-9_]+)\]/g)].map(m => m[1]);
        for (const r of refs) {
            t.ok(b.arguments[r], `block ${b.opcode} defines argument [${r}]`);
        }
    }
    t.ok(info.menus.worldSize.items.includes('5120'), '5120 in size menu');
    const opcodes = blocks.map(b => b.opcode);
    for (const op of ['terrainGenProgress', 'terrainZoneAt', 'terrainZoneAtSprite',
        'currentZone', 'whenZoneEntered',
        'waterDepthAt', 'heightAboveSeaAt', 'setMountainSnow', 'mountainLine', 'snowLine',
        'anchorSprite', 'unanchorSprite',
        'spriteAnchored', 'moveSpriteInWorld', 'setSpriteWorldPos', 'spriteWorldX',
        'spriteWorldY', 'pointSpriteTowardsWorld', 'cameraFollow', 'stopCameraFollow',
        'updateAnchoredSprites', 'generateStructures', 'structureAt',
        'showStructures', 'structuresVisible']) {
        t.ok(opcodes.includes(op), `opcode ${op} registered`);
    }
    t.end();
});

test('extreme camera never hangs structure rendering (float precision)', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 42, SIZE: 256, OCTAVES: 4});
    ext.generateStructures({DENSITY: 80});
    ext.showStructures({SHOWHIDE: 'show'});
    // Beyond 2^53, tx++ cannot advance: the old float-bound loop never ended.
    for (const c of [1e16, 1e18, 1e308, -1e308]) {
        ext.setCamera({X: c, Y: c});
        const t0 = Date.now();
        ext._render();
        t.ok(Date.now() - t0 < 15000, `render at camera ${c} terminates`);
    }
    // Structures still draw at sane cameras.
    ext.setCamera({X: 128, Y: 128});
    ext._render();
    t.end();
});

test('extreme coordinates never produce NaN heights (noise overflow)', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 42, SIZE: 256, OCTAVES: 5});
    const pts = [
        [-2147483648, 1.7976931348623157e308],
        [1e308, 1e308], [-1e308, -1e308], [1e18, -1e18], [1e307, 1e307]
    ];
    for (const [x, y] of pts) {
        const h = ext.terrainHeight({X: x, Y: y});
        t.ok(isFinite(h) && h >= 0 && h <= 1, `height at (${x},${y}) = ${h}`);
        t.ok(isFinite(ext.waterDepthAt({X: x, Y: y})), 'depth finite');
        t.ok(ext.structureAt({X: x, Y: y}) !== null, 'structure query ok');
    }
    t.end();
});

test('threshold order survives extreme level inputs', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 42, SIZE: 128, OCTAVES: 3});
    for (const [o, b] of [[1, 1], [1, 5], [0.9, 0.9], [1e308, 1e308]]) {
        ext.setTerrainLevels({OCEAN: o, BEACH: b});
        const beachTop = ext.seaLevel() + ext.beachHeight();
        t.ok(beachTop <= 1 + 1e-9, `beachTop <= 1 (got ${beachTop})`);
        t.ok(beachTop <= ext.mountainLine() + 1e-9, 'mountain above beach');
        t.ok(ext.mountainLine() <= ext.snowLine() + 1e-9, 'snow above mountain');
    }
    t.end();
});

test('structures have per-type sizes and include dungeons', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 42, SIZE: 256, OCTAVES: 5});
    ext.generateStructures({DENSITY: 70});
    const seen = new Set();
    for (let y = 0; y < 256; y += 2) {
        for (let x = 0; x < 256; x += 2) {
            const s = ext.structureAt({X: x, Y: y});
            if (s) seen.add(s);
        }
    }
    t.ok(seen.has('dungeon'), 'dungeons generate');
    t.ok(seen.size >= 5, `several types present: ${[...seen].join(',')}`);
    // Size ordering: dungeon renders largest, boulder smallest.
    const fs = require('fs');
    const src = fs.readFileSync(__dirname + '/../../src/extensions/sb_terrain.js', 'utf8');
    t.ok(src.includes('dungeon'), 'dungeon in source');
    t.end();
});

test('current zone reporter and zone-entered hat', t => {
    const ext = makeExt();
    ext.generateTerrain({SEED: 42, SIZE: 256, OCTAVES: 5});
    const tgt = {id: 'p1', x: 0, y: 0, direction: 90, sprite: {name: 'p1'}};
    tgt.setXY = (x, y) => { tgt.x = x; tgt.y = y; };
    const util = {target: tgt, runtime: {getSpriteTargetByName: () => null}};
    const z0 = ext.currentZone({}, util);
    t.ok(['deep ocean', 'ocean', 'shallows', 'beach', 'grass', 'mountain', 'snowy peak'].includes(z0),
        `current zone is a real zone: ${z0}`);
    t.equal(ext.currentZone({}, util), ext.terrainZoneAtSprite({SPRITE: ''}, util),
        'current zone matches sprite zone query');
    // Hat edge-triggers only on transitions into the wanted zone.
    t.equal(ext.whenZoneEntered({ZONE: z0}, util), false, 'no fire on first sight');
    ext.setSpriteWorldPos({SPRITE: '', X: 200, Y: 200}, util);
    const z1 = ext.currentZone({}, util);
    t.equal(ext.whenZoneEntered({ZONE: z1}, util), true, 'fires entering new zone');
    t.equal(ext.whenZoneEntered({ZONE: z1}, util), false, 'no repeat while staying');
    t.equal(ext.whenZoneEntered({ZONE: 'nope'}, util), false, 'bogus zone never fires');
    t.end();
});

test('sprite dropdown menu lists project sprites dynamically', t => {
    const ext = makeExt();
    ext.runtime = {targets: [
        {isStage: true, sprite: null, id: 'stage'},
        {isStage: false, sprite: {name: 'Player'}, id: 'a'},
        {isStage: false, sprite: {name: 'Enemy'}, id: 'b'},
        {isStage: false, sprite: null, id: 'c'}
    ]};
    t.deepEqual(ext._getSpriteMenu(), ['Player', 'Enemy']);
    ext.runtime = {targets: []};
    t.ok(ext._getSpriteMenu().length > 0, 'never returns an empty menu');
    ext.runtime = null;
    t.ok(ext._getSpriteMenu().length > 0, 'survives missing runtime');
    const menus = ext.getInfo().menus;
    t.equal(menus.sprite.items, '_getSpriteMenu', 'menu uses the dynamic function');
    t.end();
});
