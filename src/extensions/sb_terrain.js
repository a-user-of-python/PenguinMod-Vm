/**
 * Terrain World extension for PenguinMod / HiddenBlocks.
 *
 * Adds blocks that generate a natural-looking heightmap (seeded, domain-warped
 * fractal noise), classify it into ocean / beach / land with user-set
 * thresholds, render it as a viewport behind the sprites, and expose a camera
 * + coordinate converters so a sprite can explore a huge stored world without
 * the world itself ever moving.
 *
 * Worlds up to 2048 tiles use the original exact generator (bit-identical
 * output for the same seed). Larger worlds (up to 5120) use a faster path
 * with a coarser domain-warp field; the look stays in the same style.
 * Sampling outside the stored grid keeps working forever: heights are
 * computed on demand from the same seeded noise, so the world has no end.
 *
 * Sprites can be "anchored" to the world: they keep their world position
 * while the camera pans (or stay fixed while the sprite roams with normal
 * motion blocks and the map stays put). A structure layer places named
 * structures (house, tower, tree, boulder, well, windmill) on land using a
 * second noise field compared against the land map.
 *
 * The heightmap is stored data: generating with the same seed always rebuilds
 * the identical world, so projects can regenerate their world on green flag.
 *
 * @author Sean's Blocks (sbTerrain)
 */

const formatMessage = require('format-message');
const BlockType = require('../extension-support/block-type');
const ArgumentType = require('../extension-support/argument-type');
const Cast = require('../util/cast');
const StageLayering = require('../engine/stage-layering');

const STAGE_W = 480;
const STAGE_H = 360;
const LUT_SIZE = 1024;
const MAX_WORLD_SIZE = 5120;
const EXACT_GEN_MAX = 2048; // sizes at/below this use the original algorithm
const STRUCT_ICON_PX = 40;
const STRUCT_VIEW_ZOOM_MAX = 320; // structures draw only when zoomed in past this

const STRUCT_TYPES = ['house', 'tower', 'tree', 'boulder', 'well', 'windmill', 'dungeon'];
// Relative draw sizes: dungeons loom over houses, boulders are small.
const STRUCT_SCALES = {
    boulder: 0.7,
    tree: 0.8,
    well: 0.8,
    house: 1.0,
    windmill: 1.25,
    tower: 1.5,
    dungeon: 1.9
};
const STRUCT_SVGS = [
    // house
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
    '<rect x="10" y="22" width="28" height="18" fill="#a06a3c"/>' +
    '<polygon points="6,24 24,8 42,24" fill="#c0392b"/>' +
    '<rect x="21" y="30" width="7" height="10" fill="#4a2f16"/></svg>',
    // tower
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
    '<rect x="16" y="12" width="16" height="28" fill="#8d8d8d"/>' +
    '<rect x="13" y="6" width="7" height="7" fill="#8d8d8d"/>' +
    '<rect x="21" y="6" width="7" height="7" fill="#8d8d8d"/>' +
    '<rect x="29" y="6" width="7" height="7" fill="#8d8d8d"/>' +
    '<rect x="21" y="20" width="6" height="9" fill="#333333"/>' +
    '<rect x="16" y="12" width="16" height="3" fill="#6e6e6e"/></svg>',
    // tree (pine)
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
    '<rect x="22" y="30" width="4" height="10" fill="#6d4c41"/>' +
    '<polygon points="24,4 13,24 35,24" fill="#2e7d32"/>' +
    '<polygon points="24,14 11,32 37,32" fill="#388e3c"/></svg>',
    // boulder
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
    '<ellipse cx="24" cy="28" rx="17" ry="12" fill="#9e9e9e"/>' +
    '<ellipse cx="18" cy="24" rx="6" ry="4" fill="#c6c6c6"/>' +
    '<ellipse cx="30" cy="31" rx="4" ry="3" fill="#7a7a7a"/></svg>',
    // well
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
    '<rect x="14" y="8" width="3" height="18" fill="#6d4c41"/>' +
    '<rect x="31" y="8" width="3" height="18" fill="#6d4c41"/>' +
    '<polygon points="11,10 24,2 37,10" fill="#c0392b"/>' +
    '<rect x="14" y="24" width="20" height="15" fill="#8d6e63"/>' +
    '<ellipse cx="24" cy="24" rx="10" ry="4" fill="#3e2723"/>' +
    '<rect x="13" y="27" width="22" height="3" fill="#6d4c41"/></svg>',
    // windmill
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
    '<polygon points="20,44 28,44 26,18 22,18" fill="#eceff1"/>' +
    '<g stroke="#78909c" stroke-width="3" stroke-linecap="round">' +
    '<line x1="24" y1="16" x2="24" y2="3"/>' +
    '<line x1="24" y1="16" x2="37" y2="16"/>' +
    '<line x1="24" y1="16" x2="24" y2="29"/>' +
    '<line x1="24" y1="16" x2="11" y2="16"/></g>' +
    '<circle cx="24" cy="16" r="3.5" fill="#455a64"/></svg>',
    // dungeon (dark fortress gate, the largest structure)
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
    '<rect x="4" y="20" width="7" height="20" fill="#616161"/>' +
    '<rect x="37" y="20" width="7" height="20" fill="#616161"/>' +
    '<rect x="4" y="15" width="7" height="5" fill="#616161"/>' +
    '<rect x="37" y="15" width="7" height="5" fill="#616161"/>' +
    '<rect x="11" y="16" width="26" height="24" fill="#4e4e4e"/>' +
    '<rect x="11" y="10" width="8" height="6" fill="#4e4e4e"/>' +
    '<rect x="21" y="10" width="6" height="6" fill="#4e4e4e"/>' +
    '<rect x="29" y="10" width="8" height="6" fill="#4e4e4e"/>' +
    '<polygon points="19,40 19,28 24,21 29,28 29,40" fill="#141414"/>' +
    '<rect x="15" y="20" width="4" height="6" fill="#212121"/>' +
    '<rect x="29" y="20" width="4" height="6" fill="#212121"/></svg>'
];

/**
 * Small deterministic PRNG (mulberry32).
 * @param {number} seed integer seed
 * @returns {function(): number} function returning [0, 1)
 */
function mulberry32 (seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Classic improved Perlin gradient noise (2D).
 */
class Perlin2D {
    /**
     * @param {function(): number} rand seeded random source
     */
    constructor (rand) {
        this.p = new Uint8Array(512);
        const perm = new Uint8Array(256);
        for (let i = 0; i < 256; i++) perm[i] = i;
        for (let i = 255; i > 0; i--) {
            const j = (rand() * (i + 1)) | 0;
            const tmp = perm[i];
            perm[i] = perm[j];
            perm[j] = tmp;
        }
        for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
    }
    fade (t) {
        return (t * t * t) * ((t * ((t * 6) - 15)) + 10);
    }
    lerp (a, b, t) {
        return a + (t * (b - a));
    }
    grad (hash, x, y) {
        // 8 unit-length gradient directions
        const s = 0.7071067811865475; // 1/sqrt(2)
        switch (hash & 7) {
        case 0: return (x + y) * s;
        case 1: return (-x + y) * s;
        case 2: return (x - y) * s;
        case 3: return (-x - y) * s;
        case 4: return x;
        case 5: return -x;
        case 6: return y;
        default: return -y;
        }
    }
    /**
     * @param {number} x
     * @param {number} y
     * @returns {number} noise in roughly [-1, 1]; 0 for non-finite input
     * (octave doubling can overflow past ~1e308 at extreme coordinates)
     */
    noise (x, y) {
        if (!isFinite(x) || !isFinite(y)) return 0;
        const X = Math.floor(x) & 255;
        const Y = Math.floor(y) & 255;
        x -= Math.floor(x);
        y -= Math.floor(y);
        const u = this.fade(x);
        const v = this.fade(y);
        const p = this.p;
        const aa = p[p[X] + Y];
        const ab = p[p[X] + Y + 1];
        const ba = p[p[X + 1] + Y];
        const bb = p[p[X + 1] + Y + 1];
        // With unit gradients the result stays within ~[-1, 1].
        return this.lerp(
            this.lerp(this.grad(aa, x, y), this.grad(ba, x - 1, y), u),
            this.lerp(this.grad(ab, x, y - 1), this.grad(bb, x - 1, y - 1), u),
            v
        );
    }
}

/**
 * Fractal Brownian motion.
 * @returns {number} roughly [-1, 1]
 */
function fbm (perlin, x, y, octaves) {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    const count = Math.max(1, Math.min(12, Math.floor(octaves)));
    for (let i = 0; i < count; i++) {
        sum += amp * perlin.noise(x * freq, y * freq);
        norm += amp;
        amp *= 0.5;
        freq *= 2.03;
    }
    return sum / norm;
}

/**
 * Ridged multifractal noise. Good for mountain ranges.
 * @returns {number} roughly [0, 1]
 */
function ridged (perlin, x, y, octaves) {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    const count = Math.max(1, Math.min(12, Math.floor(octaves)));
    for (let i = 0; i < count; i++) {
        let n = 1 - Math.abs(perlin.noise(x * freq, y * freq));
        n *= n;
        sum += amp * n;
        norm += amp;
        amp *= 0.5;
        freq *= 2.1;
    }
    return sum / norm;
}

/**
 * Build a raw 512-entry permutation table (same shuffle as Perlin2D).
 * Used by the fast large-world generator to avoid method-call overhead.
 */
function makePermTable (rand) {
    const p = new Uint8Array(512);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) {
        const j = (rand() * (i + 1)) | 0;
        const tmp = perm[i];
        perm[i] = perm[j];
        perm[j] = tmp;
    }
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
    return p;
}

/**
 * Inlined 2D Perlin noise over a raw permutation table.
 * Same lattice math as Perlin2D.noise, written as a single function so the
 * large-world generator avoids per-evaluation method dispatch.
 */
function fastNoise (p, x, y) {
    const s = 0.7071067811865475;
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const aa = p[p[X] + Y];
    const ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y];
    const bb = p[p[X + 1] + Y + 1];
    // grad(aa, xf, yf) etc., inlined
    let g;
    g = aa & 7;
    const a1 = g === 0 ? (xf + yf) * s : g === 1 ? (-xf + yf) * s :
        g === 2 ? (xf - yf) * s : g === 3 ? (-xf - yf) * s :
        g === 4 ? xf : g === 5 ? -xf : g === 6 ? yf : -yf;
    g = ba & 7;
    const x1 = xf - 1;
    const a2 = g === 0 ? (x1 + yf) * s : g === 1 ? (-x1 + yf) * s :
        g === 2 ? (x1 - yf) * s : g === 3 ? (-x1 - yf) * s :
        g === 4 ? x1 : g === 5 ? -x1 : g === 6 ? yf : -yf;
    g = ab & 7;
    const y1 = yf - 1;
    const b1 = g === 0 ? (xf + y1) * s : g === 1 ? (-xf + y1) * s :
        g === 2 ? (xf - y1) * s : g === 3 ? (-xf - y1) * s :
        g === 4 ? xf : g === 5 ? -xf : g === 6 ? y1 : -y1;
    g = bb & 7;
    const b2 = g === 0 ? (x1 + y1) * s : g === 1 ? (-x1 + y1) * s :
        g === 2 ? (x1 - y1) * s : g === 3 ? (-x1 - y1) * s :
        g === 4 ? x1 : g === 5 ? -x1 : g === 6 ? y1 : -y1;
    const xa = a1 + (a2 - a1) * u;
    const xb = b1 + (b2 - b1) * u;
    return xa + (xb - xa) * v;
}

/**
 * Inlined fBm over a raw permutation table.
 */
function fastFbm (p, x, y, octaves) {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
        sum += amp * fastNoise(p, x * freq, y * freq);
        norm += amp;
        amp *= 0.5;
        freq *= 2.03;
    }
    return sum / norm;
}

/**
 * Deterministic integer hash for structure type selection.
 */
function hash2i (x, y, seed) {
    let h = (Math.imul(x | 0, 374761393) +
        Math.imul(y | 0, 668265263) +
        Math.imul(seed | 0, 2246822519)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) % STRUCT_TYPES.length;
}

/**
 * Parse a Scratch color (#rrggbb / #rgb) into [r, g, b].
 */
function parseColor (value) {
    let s = String(value).trim();
    if (s.charAt(0) === '#') s = s.substring(1);
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    const n = parseInt(s, 16);
    if (isNaN(n) || s.length !== 6) return [128, 128, 128];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix (a, b, t) {
    return [
        Math.round(a[0] + ((b[0] - a[0]) * t)),
        Math.round(a[1] + ((b[1] - a[1]) * t)),
        Math.round(a[2] + ((b[2] - a[2]) * t))
    ];
}

function clamp (v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

class SBTerrain {
    constructor (runtime) {
        /**
         * The runtime instantiating this extension.
         * @type {Runtime}
         */
        this.runtime = runtime;

        // Raw noise state (for the standalone noise reporter blocks).
        this._noiseSeed = 12345;
        this._perlin = null;

        // Stored world data. null until generated.
        this._height = null; // Float32Array, row-major, [0, 1]
        this._size = 0;
        this._seed = 12345;
        this._octaves = 5;
        // Generator state kept for infinite out-of-bounds sampling.
        this._genBase = null; // Perlin2D
        this._genWarp = null; // Perlin2D
        this._genOctaves = 5;
        this._normMin = 0;
        this._normMax = 1;
        // Async generation bookkeeping.
        this._genToken = 0;
        this._genProgress = 1; // 0..1; 1 when idle

        // Classification thresholds (kept ordered: sea < beachTop < mountain < snow).
        this._seaLevel = 0.45;
        this._beachHeight = 0.035;
        this._mountainLine = 0.70;
        this._snowLine = 0.87;

        // Terrain colors.
        this._colors = {
            ocean: '#2f6fd0',
            beach: '#e6d49a',
            grass: '#4da64d',
            mountain: '#8d8177',
            snow: '#eef3fa'
        };

        // Camera: world position (tiles, y-up) at stage center + zoom
        // (tiles visible across the stage width).
        this._camX = 0;
        this._camY = 0;
        this._zoom = 120;
        this._visible = true;

        // Renderer layers (created lazily so headless runtimes are fine).
        this._skinId = null;
        this._drawable = null;
        this._imageData = null;
        this._structSkinId = null;
        this._structDrawable = null;
        this._structImageData = null;

        // Structure system: second noise field compared against the land map.
        this._structDensity = 12; // 0..100, approximate share of land tiles
        this._structSeed = 0;
        this._structPerlin = null;
        this._sandPerlin = null;
        this._structuresVisible = true;
        this._structIcons = null; // {type: {data, w, h}} once rasterized
        this._structIconsLoading = false;

        // World-anchored sprites: target ids that move with the camera.
        this._anchors = new Set();
        // Last seen zone per sprite id, for the "when I enter [zone]" hat.
        this._zoneMemory = new Map();
        this._followName = null; // sprite name the camera follows, or null

        // Terrain shape tunables (internal; not blocks).
        this._baseFreq = 5; // noise cells spanning the whole map at octave 0
        this._warpStrength = 2.0; // domain-warp offset strength

        // Height -> RGB lookup table, rebuilt when thresholds/colors change.
        this._lut = new Uint8Array(LUT_SIZE * 3);
        this._rebuildLUT();
    }

    // ------------------------------------------------------------------
    // Noise internals
    // ------------------------------------------------------------------

    _noise () {
        if (!this._perlin) {
            this._perlin = new Perlin2D(mulberry32(this._noiseSeed));
        }
        return this._perlin;
    }

    _resetNoise (seed) {
        this._noiseSeed = seed | 0;
        this._perlin = null;
    }

    // ------------------------------------------------------------------
    // Terrain generation
    // ------------------------------------------------------------------

    /**
     * Original exact generator (sizes up to 2048). Bit-identical to the
     * first release: same permutation shuffle, same warp math, same
     * normalization. Returns {data, min, max, base, warp}.
     */
    _generateExactData (seed, size, octaves) {
        const rand = mulberry32(seed | 0);
        const base = new Perlin2D(rand);
        const warp = new Perlin2D(rand);
        const data = new Float32Array(size * size);
        const freq = this._baseFreq / size;
        for (let y = 0; y < size; y++) {
            const ny = y * freq;
            for (let x = 0; x < size; x++) {
                const nx = x * freq;
                // Domain warp: sample the warp field, then offset the main field.
                const qx = fbm(warp, nx, ny, 3);
                const qy = fbm(warp, nx + 5.2, ny + 1.3, 3);
                const w = this._warpStrength;
                const h = fbm(base, nx + (w * qx), ny + (w * qy), octaves);
                data[(y * size) + x] = h;
            }
        }
        return this._normalizeData(data);
    }

    _normalizeData (data) {
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < data.length; i++) {
            const v = data[i];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        const span = (max - min) || 1;
        for (let i = 0; i < data.length; i++) {
            data[i] = (data[i] - min) / span;
        }
        return {data: data, min: min, max: max};
    }

    /**
     * Install a freshly generated world: swap in the heightmap, remember the
     * generator state for infinite sampling, recenter the camera, rebuild
     * the structure field from the new seed, and render.
     */
    _installWorld (res, seed, size, octaves) {
        this._height = res.data;
        this._size = size;
        this._seed = seed | 0;
        this._octaves = octaves;
        this._normMin = res.min;
        this._normMax = res.max;
        // Rebuild generator Perlin instances deterministically from the seed
        // so out-of-bounds sampling matches the exact generator math.
        const rand = mulberry32(seed | 0);
        // _generateExactData consumed rand for base then warp; mirror that.
        this._genBase = new Perlin2D(rand);
        this._genWarp = new Perlin2D(rand);
        this._genOctaves = octaves;
        this._camX = size / 2;
        this._camY = size / 2;
        this._zoom = clamp(this._zoom, 4, 8192);
        // Structures follow the world seed; keep the user's density.
        this._initStructureField();
    }

    _initStructureField () {
        this._structSeed = (this._seed ^ 0x9e3779b9) | 0;
        this._structPerlin = new Perlin2D(mulberry32(this._structSeed));
        // Sand-clearing field: beach patches fully surrounded by grass.
        this._sandPerlin = new Perlin2D(mulberry32((this._seed ^ 0x51ab3b47) | 0));
    }

    /**
     * Parse and harden the generate arguments. Returns {seed, size, octaves}.
     * Sizes up to 2048 keep the legacy power-of-two snap (bit-identical
     * worlds); larger sizes allow any integer up to 5120.
     */
    _parseGenerateArgs (seedArg, sizeArg, octArg) {
        let seed = Cast.toNumber(seedArg);
        let size = Cast.toNumber(sizeArg);
        let octaves = Cast.toNumber(octArg);
        if (!isFinite(seed)) seed = 12345;
        if (!isFinite(size)) size = 1024;
        if (!isFinite(octaves)) octaves = 5;
        seed = seed | 0;
        size = clamp(Math.round(size), 64, MAX_WORLD_SIZE);
        if (size <= EXACT_GEN_MAX) {
            // Legacy snap to a power of two for predictable memory use.
            const pow = Math.round(Math.log2(size));
            size = Math.pow(2, clamp(pow, 6, 11));
        }
        octaves = clamp(Math.round(octaves), 1, 10);
        return {seed: seed, size: size, octaves: octaves};
    }

    _sampleBilinear (x, y) {
        const size = this._size;
        const data = this._height;
        x = clamp(x, 0, size - 1.001);
        y = clamp(y, 0, size - 1.001);
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const fx = x - x0;
        const fy = y - y0;
        const i00 = data[(y0 * size) + x0];
        const i10 = data[((y0 * size) + x0) + 1];
        const i01 = data[((y0 + 1) * size) + x0];
        const i11 = data[(((y0 + 1) * size) + x0) + 1];
        const top = i00 + ((i10 - i00) * fx);
        const bottom = i01 + ((i11 - i01) * fx);
        return top + ((bottom - top) * fy);
    }

    _sampleNearest (x, y) {
        const size = this._size;
        const xi = clamp(Math.round(x), 0, size - 1);
        const yi = clamp(Math.round(y), 0, size - 1);
        return this._height[(yi * size) + xi];
    }

    /**
     * Raw (pre-normalization) height using the exact generator math.
     * Powers infinite out-of-bounds sampling with the same seed.
     */
    _heightRawExact (nx, ny) {
        const w = this._warpStrength;
        const qx = fbm(this._genWarp, nx, ny, 3);
        const qy = fbm(this._genWarp, nx + 5.2, ny + 1.3, 3);
        return fbm(this._genBase, nx + w * qx, ny + w * qy, this._genOctaves);
    }

    /**
     * Height at any world coordinate. Inside the stored grid this is the
     * bilinear sample; outside, the seeded noise is evaluated on demand and
     * normalized with the world's own min/max, so the world has no end.
     * Always in [0, 1]. Returns 0 when no world exists.
     */
    _heightAt (x, y) {
        if (!this._height || !this._genBase || !this._genWarp) return 0;
        const size = this._size;
        if (x >= 0 && y >= 0 && x <= size - 1 && y <= size - 1) {
            return this._sampleBilinear(x, y);
        }
        const freq = this._baseFreq / size;
        const raw = this._heightRawExact(x * freq, y * freq);
        const span = (this._normMax - this._normMin) || 1;
        const v = (raw - this._normMin) / span;
        return v < 0 ? 0 : (v > 1 ? 1 : v);
    }

    /**
     * Nearest height at any world coordinate (for tile classification).
     */
    _heightNearestAt (x, y) {
        if (!this._height || !this._genBase || !this._genWarp) return 0;
        const size = this._size;
        const xi = Math.round(x);
        const yi = Math.round(y);
        if (xi >= 0 && yi >= 0 && xi < size && yi < size) {
            return this._height[(yi * size) + xi];
        }
        const freq = this._baseFreq / size;
        const raw = this._heightRawExact(xi * freq, yi * freq);
        const span = (this._normMax - this._normMin) || 1;
        const v = (raw - this._normMin) / span;
        return v < 0 ? 0 : (v > 1 ? 1 : v);
    }

    /**
     * @returns {number} 0 = ocean, 1 = beach, 2 = grass, 3 = mountain, 4 = snow
     * When tile coords are given, sandy clearings (beach patches fully
     * surrounded by grass) are carved out of the lower grass band.
     */
    _classify (h, x, y) {
        const sea = this._seaLevel;
        const beachTop = sea + Math.max(0, this._beachHeight);
        if (h < sea) return 0;
        if (h < beachTop) return 1;
        if (h < this._mountainLine) {
            if (typeof x === 'number' && typeof y === 'number' && isFinite(x) && isFinite(y) &&
                this._sandPerlin && this._size > 0 &&
                h < beachTop + (0.35 * (this._mountainLine - beachTop))) {
                const s = fbm(this._sandPerlin, (x / this._size) * 6, (y / this._size) * 6, 3);
                if (s > 0.55) return 1;
            }
            return 2;
        }
        if (h < this._snowLine) return 3;
        return 4;
    }

    /**
     * Depth/altitude zone name for a normalized height.
     */
    _zoneName (h, x, y) {
        const c = this._classify(h, x, y);
        switch (c) {
        case 0: {
            const sea = this._seaLevel;
            if (h < sea * 0.45) return 'deep ocean';
            if (h < sea * 0.85) return 'ocean';
            return 'shallows';
        }
        case 1: return 'beach';
        case 2: return 'grass';
        case 3: return 'mountain';
        default: return 'snowy peak';
        }
    }
    // ------------------------------------------------------------------
    // Color LUT
    // ------------------------------------------------------------------

    _rebuildLUT () {
        const sea = clamp(this._seaLevel, 0, 1);
        const beachTop = clamp(sea + Math.max(0, this._beachHeight), 0, 1);
        const mountain = clamp(Math.max(this._mountainLine, beachTop), 0, 1);
        const snow = clamp(Math.max(this._snowLine, mountain), 0, 1);
        const ocean = parseColor(this._colors.ocean);
        const beach = parseColor(this._colors.beach);
        const grass = parseColor(this._colors.grass);
        const rock = parseColor(this._colors.mountain);
        const snowC = parseColor(this._colors.snow);
        const deep = ocean.map(c => Math.round(c * 0.45));
        const grassDark = grass.map(c => Math.round(c * 0.68));
        const rockDark = rock.map(c => Math.round(c * 0.62));
        for (let i = 0; i < LUT_SIZE; i++) {
            const h = i / (LUT_SIZE - 1);
            let rgb;
            if (h < sea) {
                const t = sea > 0 ? Math.pow(h / sea, 0.65) : 1;
                rgb = mix(deep, ocean, t);
            } else if (h < beachTop) {
                rgb = beach;
            } else if (h < mountain) {
                const t = (h - beachTop) / Math.max(1e-6, mountain - beachTop);
                rgb = mix(grassDark, grass, Math.min(1, t * 1.6));
            } else if (h < snow) {
                const t = (h - mountain) / Math.max(1e-6, snow - mountain);
                rgb = mix(rockDark, rock, t);
            } else {
                const t = (h - snow) / Math.max(1e-6, 1 - snow);
                const k = Math.min(1, t * 2.2);
                rgb = mix(rock, snowC, k * k);
            }
            this._lut[i * 3] = rgb[0];
            this._lut[(i * 3) + 1] = rgb[1];
            this._lut[(i * 3) + 2] = rgb[2];
        }
    }

    // ------------------------------------------------------------------
    // Renderer layers (the visible viewport; the stored world never moves)
    // ------------------------------------------------------------------

    _ensureLayer () {
        const renderer = this.runtime && this.runtime.renderer;
        if (!renderer || typeof document === 'undefined') return false;
        try {
            if (this._skinId === null || typeof this._skinId === 'undefined') {
                this._imageData = new ImageData(STAGE_W, STAGE_H);
                this._skinId = renderer.createBitmapSkin(this._imageData, 1);
                // Background group: above the stage backdrop, below sprites.
                this._drawable = renderer.createDrawable(StageLayering.BACKGROUND_LAYER);
                renderer.updateDrawableSkinId(this._drawable, this._skinId);
                renderer.updateDrawableVisible(this._drawable, this._visible);
                // Structure overlay sits just above the terrain in the same group.
                this._structImageData = new ImageData(STAGE_W, STAGE_H);
                this._structSkinId = renderer.createBitmapSkin(this._structImageData, 1);
                this._structDrawable = renderer.createDrawable(StageLayering.BACKGROUND_LAYER);
                renderer.updateDrawableSkinId(this._structDrawable, this._structSkinId);
                renderer.updateDrawableVisible(this._structDrawable, this._visible);
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    _render () {
        if (!this._height) return;
        if (!this._ensureLayer()) return;
        const renderer = this.runtime.renderer;
        const pixels = this._imageData.data;
        const ppt = STAGE_W / this._zoom; // pixels per tile
        const cx = this._camX;
        const cy = this._camY;
        const lut = this._lut;
        let p = 0;
        for (let py = 0; py < STAGE_H; py++) {
            // Screen row py=0 is the top; world y points up.
            const wy = cy + (((STAGE_H / 2) - py - 0.5) / ppt);
            for (let px = 0; px < STAGE_W; px++) {
                const wx = cx + ((px - (STAGE_W / 2) + 0.5) / ppt);
                const h = this._heightAt(wx, wy);
                let li = ((h * (LUT_SIZE - 1)) | 0);
                if (li < 0) li = 0;
                else if (li >= LUT_SIZE) li = LUT_SIZE - 1;
                li *= 3;
                pixels[p++] = lut[li];
                pixels[p++] = lut[li + 1];
                pixels[p++] = lut[li + 2];
                pixels[p++] = 255;
            }
        }
        this._renderStructures();
        try {
            renderer.updateBitmapSkin(this._skinId, this._imageData, 1);
            renderer.updateBitmapSkin(this._structSkinId, this._structImageData, 1);
            renderer.updateDrawableVisible(this._drawable, this._visible);
            renderer.updateDrawableVisible(this._structDrawable,
                this._visible && this._structuresVisible);
            if (this.runtime.requestRedraw) this.runtime.requestRedraw();
        } catch (e) {
            // Renderer went away; the layers will be recreated on next render.
            this._skinId = null;
            this._drawable = null;
            this._structSkinId = null;
            this._structDrawable = null;
        }
    }

    _pixelsPerTile () {
        return STAGE_W / this._zoom;
    }

    // ------------------------------------------------------------------
    // Structures: a second noise field compared against the land map
    // ------------------------------------------------------------------

    /**
     * Structure type at integer tile (tx, ty), or '' when there is none.
     * A structure exists where the tile is land and the structure noise
     * field exceeds the density threshold. Pure function of the seeds:
     * no per-tile storage, works infinitely far out.
     */
    _structureTypeAt (tx, ty) {
        if (!this._height || !this._structPerlin) return '';
        if (!isFinite(tx) || !isFinite(ty)) return '';
        // Classify exactly like tileAt so a structure can only ever sit on grass.
        const h = this._heightNearestAt(tx, ty);
        if (this._classify(h, Math.round(tx), Math.round(ty)) !== 2) return '';
        const x = Math.floor(tx);
        const y = Math.floor(ty);
        const s = fbm(this._structPerlin, x * 0.02, y * 0.02, 3);
        const threshold = 0.9 - (this._structDensity / 100) * 1.8;
        if (!(s > threshold)) return '';
        return STRUCT_TYPES[hash2i(x, y, this._structSeed)];
    }

    /**
     * Rasterize the embedded SVG structure icons (once, lazily).
     * @returns {boolean} true when icons are ready to draw
     */
    _ensureStructIcons () {
        if (this._structIcons) return true;
        if (typeof document === 'undefined' || typeof Image === 'undefined') return false;
        if (this._structIconsLoading) return false;
        this._structIconsLoading = true;
        const jobs = STRUCT_TYPES.map((type, i) => new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                try {
                    // Each structure rasterizes at its own size: a dungeon
                    // looms over a house, a boulder is small.
                    const px = Math.max(8, Math.round(
                        STRUCT_ICON_PX * (STRUCT_SCALES[type] || 1)));
                    const c = document.createElement('canvas');
                    c.width = px;
                    c.height = px;
                    const g = c.getContext('2d');
                    g.clearRect(0, 0, px, px);
                    g.drawImage(img, 0, 0, px, px);
                    const id = g.getImageData(0, 0, px, px);
                    resolve({type: type, data: id.data, w: id.width, h: id.height});
                } catch (e) {
                    resolve(null);
                }
            };
            img.onerror = () => resolve(null);
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(STRUCT_SVGS[i]);
        }));
        Promise.all(jobs).then(results => {
            const icons = {};
            for (const r of results) {
                if (r) icons[r.type] = r;
            }
            this._structIcons = icons;
            this._structIconsLoading = false;
            this._render(); // paint the icons once they arrive
        });
        return false;
    }

    _blitIcon (icon, dx, dy) {
        const dst = this._structImageData.data;
        const sw = STAGE_W;
        const sh = STAGE_H;
        const src = icon.data;
        const iw = icon.w;
        const ih = icon.h;
        for (let y = 0; y < ih; y++) {
            const py = dy + y;
            if (py < 0 || py >= sh) continue;
            for (let x = 0; x < iw; x++) {
                const px = dx + x;
                if (px < 0 || px >= sw) continue;
                const si = ((y * iw) + x) * 4;
                const sa = src[si + 3] / 255;
                if (sa <= 0) continue;
                const di = ((py * sw) + px) * 4;
                const da = dst[di + 3] / 255;
                const oa = sa + (da * (1 - sa));
                if (oa <= 0) continue;
                const inv = 1 - sa;
                dst[di] = ((src[si] * sa) + (dst[di] * da * inv)) / oa;
                dst[di + 1] = ((src[si + 1] * sa) + (dst[di + 1] * da * inv)) / oa;
                dst[di + 2] = ((src[si + 2] * sa) + (dst[di + 2] * da * inv)) / oa;
                dst[di + 3] = oa * 255;
            }
        }
    }

    _renderStructures () {
        const data = this._structImageData.data;
        for (let i = 0; i < data.length; i++) data[i] = 0;
        if (!this._structuresVisible || !this._structPerlin) return;
        if (!this._ensureStructIcons()) return;
        // Beyond this zoom the tile count per frame explodes and icons would
        // be sub-pixel anyway.
        if (this._zoom > STRUCT_VIEW_ZOOM_MAX) return;
        const ppt = this._pixelsPerTile();
        const x0 = Math.floor(this._camX - (this._zoom / 2)) - 1;
        const x1 = Math.ceil(this._camX + (this._zoom / 2)) + 1;
        const ySpan = (this._zoom * STAGE_H) / STAGE_W;
        const y0 = Math.floor(this._camY - (ySpan / 2)) - 1;
        const y1 = Math.ceil(this._camY + (ySpan / 2)) + 1;
        // Iterate by count, not by float comparison: beyond ~2^53, tx++ can no
        // longer advance past a huge camX and the loop would never terminate.
        // The span can never legitimately exceed zoom + a small margin.
        let nx = x1 - x0;
        let ny = y1 - y0;
        if (!isFinite(nx) || !isFinite(ny) || nx < 0 || ny < 0) return;
        const maxSpan = this._zoom + 8;
        if (nx > maxSpan || ny > maxSpan) return;
        for (let iy = 0; iy <= ny; iy++) {
            const ty = y0 + iy;
            for (let ix = 0; ix <= nx; ix++) {
                const tx = x0 + ix;
                const type = this._structureTypeAt(tx, ty);
                if (!type) continue;
                const icon = this._structIcons[type];
                if (!icon) continue;
                const sx = Math.round((((tx + 0.5) - this._camX) * ppt) + (STAGE_W / 2) - (icon.w / 2));
                const sy = Math.round((STAGE_H / 2) - (((ty + 0.5) - this._camY) * ppt) - (icon.h / 2));
                this._blitIcon(icon, sx, sy);
            }
        }
    }

    // ------------------------------------------------------------------
    // World-anchored sprites
    // ------------------------------------------------------------------

    /**
     * Resolve a sprite by name. Empty/blank names mean "the sprite running
     * this block". Returns null for unknown names and for the stage.
     */
    _resolveSprite (name, util) {
        const n = String(name === null || typeof name === 'undefined' ? '' : name).trim();
        let target = null;
        try {
            if (n === '') {
                target = util && util.target;
            } else if (this.runtime && typeof this.runtime.getSpriteTargetByName === 'function') {
                target = this.runtime.getSpriteTargetByName(n);
            }
        } catch (e) {
            target = null;
        }
        if (!target || target.isStage || !target.sprite) return null;
        return target;
    }

    _pruneAnchors () {
        if (this._anchors.size === 0 && this._zoneMemory.size === 0) return;
        for (const id of Array.from(this._anchors)) {
            let t = null;
            try {
                t = this.runtime.getTargetById(id);
            } catch (e) {
                t = null;
            }
            if (!t || t.isStage || !t.sprite) this._anchors.delete(id);
        }
        for (const id of Array.from(this._zoneMemory.keys())) {
            let t = null;
            try {
                t = this.runtime ? this.runtime.getTargetById(id) : null;
            } catch (e) {
                t = null;
            }
            if (!t || t.isStage || !t.sprite) this._zoneMemory.delete(id);
        }
    }

    /**
     * Shift every anchored sprite's screen position when the camera moves,
     * so each keeps its world position. (dx, dy) are camera deltas in tiles.
     */
    _shiftAnchors (dx, dy) {
        if ((dx === 0 && dy === 0) || this._anchors.size === 0) return;
        const ppt = this._pixelsPerTile();
        const sx = dx * ppt;
        const sy = dy * ppt;
        if (!isFinite(sx) || !isFinite(sy)) return;
        for (const id of Array.from(this._anchors)) {
            let t = null;
            try {
                t = this.runtime.getTargetById(id);
            } catch (e) {
                t = null;
            }
            if (!t || t.isStage || !t.sprite) {
                this._anchors.delete(id);
                continue;
            }
            // ignoreFencing: world sprites may legally sit off-stage.
            t.setXY(t.x - sx, t.y - sy, false, true);
        }
    }

    /**
     * Reposition anchored sprites after a zoom change so each keeps its
     * world position.
     */
    _rescaleAnchors (oldPpt) {
        if (this._anchors.size === 0) return;
        const newPpt = this._pixelsPerTile();
        if (!isFinite(oldPpt) || !isFinite(newPpt) || oldPpt === 0) return;
        for (const id of Array.from(this._anchors)) {
            let t = null;
            try {
                t = this.runtime.getTargetById(id);
            } catch (e) {
                t = null;
            }
            if (!t || t.isStage || !t.sprite) {
                this._anchors.delete(id);
                continue;
            }
            const wx = this._camX + (t.x / oldPpt);
            const wy = this._camY + (t.y / oldPpt);
            t.setXY((wx - this._camX) * newPpt, (wy - this._camY) * newPpt, false, true);
        }
    }

    // ------------------------------------------------------------------
    // Extension metadata
    // ------------------------------------------------------------------

    /**
     * Dynamic menu items for the SPRITE dropdowns: the project's current
     * sprite names, refreshed every time a dropdown opens.
     * @returns {Array<string>} sprite names (never empty)
     */
    _getSpriteMenu () {
        const names = [];
        try {
            const targets = this.runtime ? this.runtime.targets : null;
            if (targets) {
                for (const t of targets) {
                    if (!t.isStage && t.sprite && t.sprite.name) {
                        names.push(t.sprite.name);
                    }
                }
            }
        } catch (e) {
            // fall through to the fallback below
        }
        return names.length > 0 ? names : [''];
    }

    getInfo () {
        return {
            id: 'sbTerrain',
            name: formatMessage({
                id: 'sbTerrain.name',
                default: 'Terrain',
                description: 'Name of the terrain world extension'
            }),
            color1: '#3d8b4f',
            color2: '#357a45',
            menuIconURI: null,
            blocks: [
                {
                    opcode: 'generateTerrain',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.generateTerrain',
                        default: 'generate terrain with seed [SEED] size [SIZE] detail [OCTAVES]',
                        description: 'Generate a new terrain heightmap world'
                    }),
                    arguments: {
                        SEED: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 12345
                        },
                        SIZE: {
                            type: ArgumentType.NUMBER,
                            menu: 'worldSize',
                            defaultValue: '1024'
                        },
                        OCTAVES: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 5
                        }
                    }
                },
                {
                    opcode: 'terrainGenProgress',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.terrainGenProgress',
                        default: 'terrain generation progress',
                        description: '0 to 1 progress of the running world generation (1 when idle)'
                    })
                },
                {
                    opcode: 'terrainGenerated',
                    blockType: BlockType.BOOLEAN,
                    text: formatMessage({
                        id: 'sbTerrain.terrainGenerated',
                        default: 'terrain is generated?',
                        description: 'Whether a terrain world currently exists'
                    })
                },
                {
                    opcode: 'terrainSize',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.terrainSize',
                        default: 'terrain size',
                        description: 'Size of the terrain world in tiles'
                    })
                },
                '---',
                {
                    opcode: 'setNoiseSeed',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.setNoiseSeed',
                        default: 'set noise seed to [SEED]',
                        description: 'Set the seed used by the raw noise blocks'
                    }),
                    arguments: {
                        SEED: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 12345
                        }
                    }
                },
                {
                    opcode: 'perlinNoise',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.perlinNoise',
                        default: 'perlin noise at x: [X] y: [Y]',
                        description: 'Raw Perlin noise value, roughly -1 to 1'
                    }),
                    arguments: {
                        X: {type: ArgumentType.NUMBER, defaultValue: 0},
                        Y: {type: ArgumentType.NUMBER, defaultValue: 0}
                    }
                },
                {
                    opcode: 'fractalNoise',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.fractalNoise',
                        default: 'fractal noise at x: [X] y: [Y] octaves: [OCTAVES]',
                        description: 'Fractal Brownian motion noise, roughly -1 to 1'
                    }),
                    arguments: {
                        X: {type: ArgumentType.NUMBER, defaultValue: 0},
                        Y: {type: ArgumentType.NUMBER, defaultValue: 0},
                        OCTAVES: {type: ArgumentType.NUMBER, defaultValue: 4}
                    }
                },
                {
                    opcode: 'ridgedNoise',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.ridgedNoise',
                        default: 'ridged noise at x: [X] y: [Y] octaves: [OCTAVES]',
                        description: 'Ridged multifractal noise, roughly 0 to 1'
                    }),
                    arguments: {
                        X: {type: ArgumentType.NUMBER, defaultValue: 0},
                        Y: {type: ArgumentType.NUMBER, defaultValue: 0},
                        OCTAVES: {type: ArgumentType.NUMBER, defaultValue: 4}
                    }
                },
                '---',
                {
                    opcode: 'terrainHeight',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.terrainHeight',
                        default: 'terrain height at x: [X] y: [Y]',
                        description: 'Heightmap value 0 to 1 at a world position'
                    }),
                    arguments: {
                        X: {type: ArgumentType.NUMBER, defaultValue: 0},
                        Y: {type: ArgumentType.NUMBER, defaultValue: 0}
                    }
                },
                {
                    opcode: 'tileAt',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.tileAt',
                        default: 'tile type at x: [X] y: [Y]',
                        description: 'Terrain class at a world position: ocean, beach, grass, mountain or snow'
                    }),
                    arguments: {
                        X: {type: ArgumentType.NUMBER, defaultValue: 0},
                        Y: {type: ArgumentType.NUMBER, defaultValue: 0}
                    }
                },
                {
                    opcode: 'terrainZoneAt',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.terrainZoneAt',
                        default: 'terrain zone at x: [X] y: [Y]',
                        description: 'Depth/altitude zone: deep ocean, ocean, shallows, beach, grass, mountain or snowy peak'
                    }),
                    arguments: {
                        X: {type: ArgumentType.NUMBER, defaultValue: 0},
                        Y: {type: ArgumentType.NUMBER, defaultValue: 0}
                    }
                },
                {
                    opcode: 'terrainZoneAtSprite',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.terrainZoneAtSprite',
                        default: 'terrain zone at sprite [SPRITE]',
                        description: 'Depth/altitude zone under a sprite (blank = this sprite)'
                    }),
                    arguments: {
                        SPRITE: {type: ArgumentType.STRING, menu: 'sprite', defaultValue: ''}
                    }
                },
                {
                    opcode: 'currentZone',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.currentZone',
                        default: 'current zone',
                        description: 'Terrain zone where I am right now; updates as I move between zones'
                    })
                },
                {
                    opcode: 'whenZoneEntered',
                    blockType: BlockType.HAT,
                    text: formatMessage({
                        id: 'sbTerrain.whenZoneEntered',
                        default: 'when I enter [ZONE]',
                        description: 'Runs once when this sprite moves into the chosen terrain zone'
                    }),
                    arguments: {
                        ZONE: {type: ArgumentType.STRING, menu: 'zone', defaultValue: 'grass'}
                    }
                },
                {
                    opcode: 'waterDepthAt',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.waterDepthAt',
                        default: 'water depth at x: [X] y: [Y]',
                        description: 'How far below sea level a position is (0 on land)'
                    }),
                    arguments: {
                        X: {type: ArgumentType.NUMBER, defaultValue: 0},
                        Y: {type: ArgumentType.NUMBER, defaultValue: 0}
                    }
                },
                {
                    opcode: 'heightAboveSeaAt',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.heightAboveSeaAt',
                        default: 'height above sea at x: [X] y: [Y]',
                        description: 'How far above sea level a position is (0 in water)'
                    }),
                    arguments: {
                        X: {type: ArgumentType.NUMBER, defaultValue: 0},
                        Y: {type: ArgumentType.NUMBER, defaultValue: 0}
                    }
                },
                {
                    opcode: 'setSeaLevel',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.setSeaLevel',
                        default: 'set sea level to [LEVEL]',
                        description: 'Heights below this are ocean (0 to 1)'
                    }),
                    arguments: {
                        LEVEL: {type: ArgumentType.NUMBER, defaultValue: 0.45}
                    }
                },
                {
                    opcode: 'seaLevel',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.seaLevel',
                        default: 'sea level',
                        description: 'Current sea level threshold'
                    })
                },
                {
                    opcode: 'setBeachHeight',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.setBeachHeight',
                        default: 'set beach height to [HEIGHT]',
                        description: 'How far above sea level counts as beach (0 to 1)'
                    }),
                    arguments: {
                        HEIGHT: {type: ArgumentType.NUMBER, defaultValue: 0.035}
                    }
                },
                {
                    opcode: 'beachHeight',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.beachHeight',
                        default: 'beach height',
                        description: 'Current beach band height'
                    })
                },
                {
                    opcode: 'setTerrainLevels',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.setTerrainLevels',
                        default: 'set ocean level [OCEAN] and beach height [BEACH]',
                        description: 'Set the ocean and beach thresholds together (land is everything above the beach)'
                    }),
                    arguments: {
                        OCEAN: {type: ArgumentType.NUMBER, defaultValue: 0.45},
                        BEACH: {type: ArgumentType.NUMBER, defaultValue: 0.035}
                    }
                },
                {
                    opcode: 'setMountainSnow',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.setMountainSnow',
                        default: 'set mountain line [MOUNTAIN] and snow line [SNOW]',
                        description: 'Heights above the mountain line are mountains; above the snow line they are snowy'
                    }),
                    arguments: {
                        MOUNTAIN: {type: ArgumentType.NUMBER, defaultValue: 0.70},
                        SNOW: {type: ArgumentType.NUMBER, defaultValue: 0.87}
                    }
                },
                {
                    opcode: 'mountainLine',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.mountainLine',
                        default: 'mountain line',
                        description: 'Current mountain threshold'
                    })
                },
                {
                    opcode: 'snowLine',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.snowLine',
                        default: 'snow line',
                        description: 'Current snowy-mountain threshold'
                    })
                },
                {
                    opcode: 'setTerrainColor',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.setTerrainColor',
                        default: 'set [TARGET] color to [COLOR]',
                        description: 'Recolor ocean, beach, grass, mountain or snow'
                    }),
                    arguments: {
                        TARGET: {type: ArgumentType.STRING, menu: 'terrainColor', defaultValue: 'ocean'},
                        COLOR: {type: ArgumentType.COLOR, defaultValue: '#2f6fd0'}
                    }
                },
                '---',
                {
                    opcode: 'setZoom',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.setZoom',
                        default: 'set zoom to [ZOOM] tiles across',
                        description: 'How many world tiles fit across the stage width'
                    }),
                    arguments: {
                        ZOOM: {type: ArgumentType.NUMBER, defaultValue: 120}
                    }
                },
                {
                    opcode: 'changeZoom',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.changeZoom',
                        default: 'change zoom by [DELTA]',
                        description: 'Zoom in (negative) or out (positive)'
                    }),
                    arguments: {
                        DELTA: {type: ArgumentType.NUMBER, defaultValue: -10}
                    }
                },
                {
                    opcode: 'zoom',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.zoom',
                        default: 'zoom',
                        description: 'Current zoom in tiles across the stage'
                    })
                },
                '---',
                {
                    opcode: 'setCamera',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.setCamera',
                        default: 'set camera to x: [X] y: [Y]',
                        description: 'Move the viewport over the stored world'
                    }),
                    arguments: {
                        X: {type: ArgumentType.NUMBER, defaultValue: 512},
                        Y: {type: ArgumentType.NUMBER, defaultValue: 512}
                    }
                },
                {
                    opcode: 'changeCameraX',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.changeCameraX',
                        default: 'change camera x by [DX]',
                        description: 'Pan the viewport horizontally'
                    }),
                    arguments: {
                        DX: {type: ArgumentType.NUMBER, defaultValue: 10}
                    }
                },
                {
                    opcode: 'changeCameraY',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.changeCameraY',
                        default: 'change camera y by [DY]',
                        description: 'Pan the viewport vertically'
                    }),
                    arguments: {
                        DY: {type: ArgumentType.NUMBER, defaultValue: 10}
                    }
                },
                {
                    opcode: 'cameraX',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.cameraX',
                        default: 'camera x',
                        description: 'Camera world x position'
                    })
                },
                {
                    opcode: 'cameraY',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.cameraY',
                        default: 'camera y position'
                    })
                },
                '---',
                {
                    opcode: 'anchorSprite',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.anchorSprite',
                        default: 'anchor [SPRITE] to world',
                        description: 'Glue a sprite to its world position; it stays put while the camera pans (blank = this sprite)'
                    }),
                    arguments: {
                        SPRITE: {type: ArgumentType.STRING, menu: 'sprite', defaultValue: ''}
                    }
                },
                {
                    opcode: 'unanchorSprite',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.unanchorSprite',
                        default: 'unanchor [SPRITE]',
                        description: 'Stop gluing a sprite to the world (blank = this sprite)'
                    }),
                    arguments: {
                        SPRITE: {type: ArgumentType.STRING, menu: 'sprite', defaultValue: ''}
                    }
                },
                {
                    opcode: 'spriteAnchored',
                    blockType: BlockType.BOOLEAN,
                    text: formatMessage({
                        id: 'sbTerrain.spriteAnchored',
                        default: 'is [SPRITE] anchored?',
                        description: 'Whether a sprite is glued to the world (blank = this sprite)'
                    }),
                    arguments: {
                        SPRITE: {type: ArgumentType.STRING, menu: 'sprite', defaultValue: ''}
                    }
                },
                {
                    opcode: 'moveSpriteInWorld',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.moveSpriteInWorld',
                        default: 'move [SPRITE] in world by dx: [DX] dy: [DY]',
                        description: 'Move a sprite by world tiles (blank = this sprite)'
                    }),
                    arguments: {
                        SPRITE: {type: ArgumentType.STRING, menu: 'sprite', defaultValue: ''},
                        DX: {type: ArgumentType.NUMBER, defaultValue: 10},
                        DY: {type: ArgumentType.NUMBER, defaultValue: 0}
                    }
                },
                {
                    opcode: 'setSpriteWorldPos',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.setSpriteWorldPos',
                        default: 'set world position of [SPRITE] to x: [X] y: [Y]',
                        description: 'Teleport a sprite to a world position (blank = this sprite)'
                    }),
                    arguments: {
                        SPRITE: {type: ArgumentType.STRING, menu: 'sprite', defaultValue: ''},
                        X: {type: ArgumentType.NUMBER, defaultValue: 512},
                        Y: {type: ArgumentType.NUMBER, defaultValue: 512}
                    }
                },
                {
                    opcode: 'spriteWorldX',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.spriteWorldX',
                        default: 'world x of [SPRITE]',
                        description: 'World x under a sprite (blank = this sprite)'
                    }),
                    arguments: {
                        SPRITE: {type: ArgumentType.STRING, menu: 'sprite', defaultValue: ''}
                    }
                },
                {
                    opcode: 'spriteWorldY',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.spriteWorldY',
                        default: 'world y of [SPRITE]',
                        description: 'World y under a sprite (blank = this sprite)'
                    }),
                    arguments: {
                        SPRITE: {type: ArgumentType.STRING, menu: 'sprite', defaultValue: ''}
                    }
                },
                {
                    opcode: 'pointSpriteTowardsWorld',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.pointSpriteTowardsWorld',
                        default: 'point [SPRITE] towards world x: [X] y: [Y]',
                        description: 'Turn a sprite to face a world position (blank = this sprite)'
                    }),
                    arguments: {
                        SPRITE: {type: ArgumentType.STRING, menu: 'sprite', defaultValue: ''},
                        X: {type: ArgumentType.NUMBER, defaultValue: 512},
                        Y: {type: ArgumentType.NUMBER, defaultValue: 512}
                    }
                },
                {
                    opcode: 'cameraFollow',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.cameraFollow',
                        default: 'camera follow [SPRITE]',
                        description: 'Lock the camera onto a sprite; call [update anchored sprites] in a loop (blank = this sprite)'
                    }),
                    arguments: {
                        SPRITE: {type: ArgumentType.STRING, menu: 'sprite', defaultValue: ''}
                    }
                },
                {
                    opcode: 'stopCameraFollow',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.stopCameraFollow',
                        default: 'stop camera follow',
                        description: 'Unlock the camera from the followed sprite'
                    })
                },
                {
                    opcode: 'updateAnchoredSprites',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.updateAnchoredSprites',
                        default: 'update anchored sprites',
                        description: 'Sync world-glued sprites and the follow camera; put in a forever loop'
                    })
                },
                '---',
                {
                    opcode: 'screenXOfWorld',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.screenXOfWorld',
                        default: 'screen x of world x: [WX]',
                        description: 'Convert a world x to stage x for sprite placement'
                    }),
                    arguments: {
                        WX: {type: ArgumentType.NUMBER, defaultValue: 512}
                    }
                },
                {
                    opcode: 'screenYOfWorld',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.screenYOfWorld',
                        default: 'screen y of world y: [WY]',
                        description: 'Convert a world y to stage y for sprite placement'
                    }),
                    arguments: {
                        WY: {type: ArgumentType.NUMBER, defaultValue: 512}
                    }
                },
                {
                    opcode: 'worldXOfScreen',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.worldXOfScreen',
                        default: 'world x of screen x: [SX]',
                        description: 'Convert a stage x to a world x'
                    }),
                    arguments: {
                        SX: {type: ArgumentType.NUMBER, defaultValue: 0}
                    }
                },
                {
                    opcode: 'worldYOfScreen',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.worldYOfScreen',
                        default: 'world y of screen y: [SY]',
                        description: 'Convert a stage y to a world y'
                    }),
                    arguments: {
                        SY: {type: ArgumentType.NUMBER, defaultValue: 0}
                    }
                },
                '---',
                {
                    opcode: 'generateStructures',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.generateStructures',
                        default: 'generate structures with density [DENSITY]',
                        description: 'Scatter named structures on land using a second noise field (0-100)'
                    }),
                    arguments: {
                        DENSITY: {type: ArgumentType.NUMBER, defaultValue: 12}
                    }
                },
                {
                    opcode: 'structureAt',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'sbTerrain.structureAt',
                        default: 'structure at world x: [X] y: [Y]',
                        description: 'Structure type at a world tile: house, tower, tree, boulder, well, windmill, dungeon or empty'
                    }),
                    arguments: {
                        X: {type: ArgumentType.NUMBER, defaultValue: 0},
                        Y: {type: ArgumentType.NUMBER, defaultValue: 0}
                    }
                },
                {
                    opcode: 'showStructures',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.showStructures',
                        default: '[SHOWHIDE] structures',
                        description: 'Show or hide the structure icons on the map'
                    }),
                    arguments: {
                        SHOWHIDE: {type: ArgumentType.STRING, menu: 'showHide', defaultValue: 'show'}
                    }
                },
                {
                    opcode: 'structuresVisible',
                    blockType: BlockType.BOOLEAN,
                    text: formatMessage({
                        id: 'sbTerrain.structuresVisible',
                        default: 'structures are visible?',
                        description: 'Whether structure icons are shown'
                    })
                },
                '---',
                {
                    opcode: 'showTerrain',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.showTerrain',
                        default: '[SHOWHIDE] terrain',
                        description: 'Show or hide the terrain viewport'
                    }),
                    arguments: {
                        SHOWHIDE: {type: ArgumentType.STRING, menu: 'showHide', defaultValue: 'show'}
                    }
                },
                {
                    opcode: 'terrainVisible',
                    blockType: BlockType.BOOLEAN,
                    text: formatMessage({
                        id: 'sbTerrain.terrainVisible',
                        default: 'terrain is visible?',
                        description: 'Whether the terrain viewport is shown'
                    })
                },
                {
                    opcode: 'redrawTerrain',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.redrawTerrain',
                        default: 'redraw terrain',
                        description: 'Force the terrain viewport to redraw'
                    })
                }
            ],
            menus: {
                worldSize: {
                    acceptReporters: true,
                    items: ['512', '1024', '2048', '4096', '5120']
                },
                showHide: {
                    acceptReporters: true,
                    items: ['show', 'hide']
                },
                terrainColor: {
                    acceptReporters: true,
                    items: ['ocean', 'beach', 'grass', 'mountain', 'snow']
                },
                zone: {
                    acceptReporters: true,
                    items: ['deep ocean', 'ocean', 'shallows', 'beach', 'grass',
                        'mountain', 'snowy peak']
                },
                sprite: {
                    acceptReporters: true,
                    // A string `items` names a method on this extension that
                    // returns the menu entries when the dropdown opens, so
                    // the list always shows the project's current sprites.
                    items: '_getSpriteMenu'
                }
            }
        };
    }

    // ------------------------------------------------------------------
    // Block implementations
    // ------------------------------------------------------------------

    generateTerrain (args) {
        const parsed = this._parseGenerateArgs(args.SEED, args.SIZE, args.OCTAVES);
        const seed = parsed.seed;
        const size = parsed.size;
        const octaves = parsed.octaves;
        if (size <= EXACT_GEN_MAX) {
            // Small worlds stay synchronous, exactly like the first release.
            // The token bump still cancels any in-flight async generation.
            this._genToken++;
            const res = this._generateExactData(seed, size, octaves);
            this._installWorld(res, seed, size, octaves);
            this._genProgress = 1;
            this._render();
            return;
        }
        // Huge worlds generate in row chunks so the editor never freezes.
        // Returning a promise makes the VM yield this thread until done.
        const token = ++this._genToken;
        this._genProgress = 0;
        return (async () => {
            const rowsPerChunk = 256;
            // Yield between chunks; each chunk fills rowsPerChunk rows.
            const data = new Float32Array(size * size);
            const rand = mulberry32(seed | 0);
            const base = makePermTable(rand);
            const warpP = makePermTable(rand);
            const freq = this._baseFreq / size;
            const w = this._warpStrength;
            const oct = clamp(Math.round(octaves), 1, 10);
            const ws = Math.max(32, size >> 2);
            const wgrid = new Float32Array(ws * ws * 2);
            const wf = this._baseFreq / ws;
            for (let y = 0; y < ws; y++) {
                const ny = y * wf;
                for (let x = 0; x < ws; x++) {
                    const nx = x * wf;
                    const i = (y * ws + x) * 2;
                    wgrid[i] = fastFbm(warpP, nx, ny, 3);
                    wgrid[i + 1] = fastFbm(warpP, nx + 5.2, ny + 1.3, 3);
                }
            }
            const invScale = ws / size;
            for (let y0 = 0; y0 < size; y0 += rowsPerChunk) {
                if (token !== this._genToken) return; // superseded
                const y1 = Math.min(y0 + rowsPerChunk, size);
                for (let y = y0; y < y1; y++) {
                    const ny = y * freq;
                    const gy = y * invScale;
                    const wy0 = Math.floor(gy);
                    const wy1 = wy0 + 1 < ws ? wy0 + 1 : ws - 1;
                    const fy = gy - wy0;
                    for (let x = 0; x < size; x++) {
                        const nx = x * freq;
                        const gx = x * invScale;
                        const wx0 = Math.floor(gx);
                        const wx1 = wx0 + 1 < ws ? wx0 + 1 : ws - 1;
                        const fx = gx - wx0;
                        const i00 = (wy0 * ws + wx0) * 2;
                        const i10 = (wy0 * ws + wx1) * 2;
                        const i01 = (wy1 * ws + wx0) * 2;
                        const i11 = (wy1 * ws + wx1) * 2;
                        const qx = ((wgrid[i00] + (wgrid[i10] - wgrid[i00]) * fx) * (1 - fy) +
                            (wgrid[i01] + (wgrid[i11] - wgrid[i01]) * fx) * fy);
                        const qy = ((wgrid[i00 + 1] + (wgrid[i10 + 1] - wgrid[i00 + 1]) * fx) * (1 - fy) +
                            (wgrid[i01 + 1] + (wgrid[i11 + 1] - wgrid[i01 + 1]) * fx) * fy);
                        data[(y * size) + x] = fastFbm(base, nx + w * qx, ny + w * qy, oct);
                    }
                }
                this._genProgress = Math.min(0.999, y1 / size);
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            if (token !== this._genToken) return; // superseded
            const res = this._normalizeData(data);
            this._installWorld(res, seed, size, octaves);
            this._genProgress = 1;
            this._render();
        })();
    }

    terrainGenProgress () {
        return this._genProgress;
    }

    terrainGenerated () {
        return this._height !== null;
    }

    terrainSize () {
        return this._size;
    }

    setNoiseSeed (args) {
        this._resetNoise(Cast.toNumber(args.SEED));
    }

    perlinNoise (args) {
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        if (!isFinite(x) || !isFinite(y)) return 0;
        // Scale so integer steps land between lattice points (which are 0).
        const r = this._noise().noise(x * 0.1, y * 0.1);
        return isFinite(r) ? r : 0;
    }

    fractalNoise (args) {
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        let octaves = Cast.toNumber(args.OCTAVES);
        if (!isFinite(x) || !isFinite(y)) return 0;
        if (!isFinite(octaves)) octaves = 4;
        const r = fbm(this._noise(), x * 0.1, y * 0.1, octaves);
        return isFinite(r) ? r : 0;
    }

    ridgedNoise (args) {
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        let octaves = Cast.toNumber(args.OCTAVES);
        if (!isFinite(x) || !isFinite(y)) return 0;
        if (!isFinite(octaves)) octaves = 4;
        const r = ridged(this._noise(), x * 0.1, y * 0.1, octaves);
        return isFinite(r) ? r : 0;
    }

    terrainHeight (args) {
        if (!this._height) return 0;
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        if (!isFinite(x) || !isFinite(y)) return 0;
        // Infinite world: outside the stored grid the seeded noise is
        // evaluated on demand, so there is no edge and no end.
        return this._heightAt(x, y);
    }

    tileAt (args) {
        if (!this._height) return 'ocean';
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        if (!isFinite(x) || !isFinite(y)) return 'ocean';
        const h = this._heightNearestAt(x, y);
        const c = this._classify(h, Math.round(x), Math.round(y));
        return c === 0 ? 'ocean' : (c === 1 ? 'beach' : (c === 2 ? 'grass' :
            (c === 3 ? 'mountain' : 'snow')));
    }

    terrainZoneAt (args) {
        if (!this._height) return 'ocean';
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        if (!isFinite(x) || !isFinite(y)) return 'ocean';
        return this._zoneName(this._heightAt(x, y), x, y);
    }

    terrainZoneAtSprite (args, util) {
        if (!this._height) return 'ocean';
        const t = this._resolveSprite(args.SPRITE, util);
        if (!t) return 'ocean';
        const ppt = this._pixelsPerTile();
        const wx = this._camX + (t.x / ppt);
        const wy = this._camY + (t.y / ppt);
        return this._zoneName(this._heightAt(wx, wy), wx, wy);
    }

    /**
     * World position of a sprite target.
     */
    _spriteWorld (t) {
        const ppt = this._pixelsPerTile();
        return [this._camX + (t.x / ppt), this._camY + (t.y / ppt)];
    }

    /**
     * The sprite this "I" refers to: the calling sprite, else the
     * camera-followed sprite, else null (caller falls back to the camera).
     */
    _meSprite (util) {
        let t = null;
        try {
            t = this._resolveSprite('', util);
        } catch (e) {
            t = null;
        }
        if (t) return t;
        if (this._followName && this.runtime) {
            try {
                const f = this.runtime.getSpriteTargetByName(this._followName);
                if (f && !f.isStage && f.sprite) return f;
            } catch (e) {
                // fall through to the camera
            }
        }
        return null;
    }

    currentZone (args, util) {
        if (!this._height) return 'ocean';
        const t = this._meSprite(util);
        const wx = t ? this._spriteWorld(t)[0] : this._camX;
        const wy = t ? this._spriteWorld(t)[1] : this._camY;
        return this._zoneName(this._heightAt(wx, wy), wx, wy);
    }

    whenZoneEntered (args, util) {
        if (!this._height) return false;
        const t = this._meSprite(util);
        if (!t) return false;
        const [wx, wy] = this._spriteWorld(t);
        const zone = this._zoneName(this._heightAt(wx, wy), wx, wy);
        const last = this._zoneMemory.get(t.id);
        this._zoneMemory.set(t.id, zone);
        if (this._zoneMemory.size > 500) this._zoneMemory.clear();
        const want = String(args.ZONE);
        // Edge-trigger: fire only on the transition into the wanted zone.
        return last !== undefined && last !== zone && zone === want;
    }

    waterDepthAt (args) {
        if (!this._height) return 0;
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        if (!isFinite(x) || !isFinite(y)) return 0;
        const d = this._seaLevel - this._heightAt(x, y);
        return d > 0 ? d : 0;
    }

    heightAboveSeaAt (args) {
        if (!this._height) return 0;
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        if (!isFinite(x) || !isFinite(y)) return 0;
        const d = this._heightAt(x, y) - this._seaLevel;
        return d > 0 ? d : 0;
    }

    /**
     * Keep sea < beachTop <= mountainLine <= snowLine after any edit.
     * beachTop is clamped to 1 first: heights above 1 don't exist, so a
     * beach band spilling past 1 would otherwise unorder the tiers.
     */
    _enforceThresholdOrder () {
        this._seaLevel = clamp(this._seaLevel, 0, 1);
        this._beachHeight = clamp(this._beachHeight, 0, 1 - this._seaLevel);
        const beachTop = this._seaLevel + this._beachHeight;
        if (this._mountainLine < beachTop) this._mountainLine = beachTop;
        if (this._snowLine < this._mountainLine) this._snowLine = this._mountainLine;
        this._mountainLine = clamp(this._mountainLine, 0, 1);
        this._snowLine = clamp(this._snowLine, 0, 1);
    }

    setSeaLevel (args) {
        const level = Cast.toNumber(args.LEVEL);
        if (!isFinite(level)) return; // keep the previous level on bad input
        this._seaLevel = clamp(level, 0, 1);
        this._enforceThresholdOrder();
        this._rebuildLUT();
        this._render();
    }

    seaLevel () {
        return this._seaLevel;
    }

    setBeachHeight (args) {
        const height = Cast.toNumber(args.HEIGHT);
        if (!isFinite(height)) return; // keep the previous height on bad input
        this._beachHeight = clamp(height, 0, 1);
        this._enforceThresholdOrder();
        this._rebuildLUT();
        this._render();
    }

    beachHeight () {
        return this._beachHeight;
    }

    setTerrainLevels (args) {
        const ocean = Cast.toNumber(args.OCEAN);
        const beach = Cast.toNumber(args.BEACH);
        // Non-finite inputs are ignored so one bad value can't corrupt the map.
        if (isFinite(ocean)) this._seaLevel = clamp(ocean, 0, 1);
        if (isFinite(beach)) this._beachHeight = clamp(beach, 0, 1);
        this._enforceThresholdOrder();
        this._rebuildLUT();
        this._render();
    }

    setMountainSnow (args) {
        const mountain = Cast.toNumber(args.MOUNTAIN);
        const snow = Cast.toNumber(args.SNOW);
        // Non-finite inputs are ignored; order is enforced afterwards.
        if (isFinite(mountain)) this._mountainLine = clamp(mountain, 0, 1);
        if (isFinite(snow)) this._snowLine = clamp(snow, 0, 1);
        this._enforceThresholdOrder();
        this._rebuildLUT();
        this._render();
    }

    mountainLine () {
        return this._mountainLine;
    }

    snowLine () {
        return this._snowLine;
    }

    setTerrainColor (args) {
        let target = String(args.TARGET).toLowerCase();
        if (target === 'land') target = 'grass'; // legacy alias
        if (target === 'ocean' || target === 'beach' || target === 'grass' ||
            target === 'mountain' || target === 'snow') {
            this._colors[target] = String(args.COLOR);
            this._rebuildLUT();
            this._render();
        }
    }

    setZoom (args) {
        const zoom = Cast.toNumber(args.ZOOM);
        if (!isFinite(zoom)) return; // keep the previous zoom on bad input
        const oldPpt = this._pixelsPerTile();
        this._zoom = clamp(zoom, 4, 8192);
        this._rescaleAnchors(oldPpt);
        this._render();
    }

    changeZoom (args) {
        const delta = Cast.toNumber(args.DELTA);
        if (!isFinite(delta)) return;
        const oldPpt = this._pixelsPerTile();
        const nz = this._zoom + delta;
        if (!isFinite(nz)) return;
        this._zoom = clamp(nz, 4, 8192);
        this._rescaleAnchors(oldPpt);
        this._render();
    }

    zoom () {
        return this._zoom;
    }

    setCamera (args) {
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        if (!isFinite(x) || !isFinite(y)) return; // keep position on bad input
        const dx = x - this._camX;
        const dy = y - this._camY;
        this._camX = x;
        this._camY = y;
        this._shiftAnchors(dx, dy);
        this._render();
    }

    changeCameraX (args) {
        const dx = Cast.toNumber(args.DX);
        if (!isFinite(dx)) return;
        const nx = this._camX + dx;
        if (!isFinite(nx)) return; // ignore changes that would overflow
        this._camX = nx;
        this._shiftAnchors(dx, 0);
        this._render();
    }

    changeCameraY (args) {
        const dy = Cast.toNumber(args.DY);
        if (!isFinite(dy)) return;
        const ny = this._camY + dy;
        if (!isFinite(ny)) return; // ignore changes that would overflow
        this._camY = ny;
        this._shiftAnchors(0, dy);
        this._render();
    }

    cameraX () {
        return this._camX;
    }

    cameraY () {
        return this._camY;
    }

    // ---------------- Sprite world tools ----------------

    anchorSprite (args, util) {
        const t = this._resolveSprite(args.SPRITE, util);
        if (t) this._anchors.add(t.id);
    }

    unanchorSprite (args, util) {
        const t = this._resolveSprite(args.SPRITE, util);
        if (t) this._anchors.delete(t.id);
    }

    spriteAnchored (args, util) {
        const t = this._resolveSprite(args.SPRITE, util);
        return !!t && this._anchors.has(t.id);
    }

    moveSpriteInWorld (args, util) {
        const t = this._resolveSprite(args.SPRITE, util);
        if (!t) return;
        const dx = Cast.toNumber(args.DX);
        const dy = Cast.toNumber(args.DY);
        if (!isFinite(dx) || !isFinite(dy)) return;
        const ppt = this._pixelsPerTile();
        const sx = t.x + (dx * ppt);
        const sy = t.y + (dy * ppt);
        if (!isFinite(sx) || !isFinite(sy)) return; // huge inputs must not warp the sprite
        t.setXY(sx, sy, false, true);
    }

    setSpriteWorldPos (args, util) {
        const t = this._resolveSprite(args.SPRITE, util);
        if (!t) return;
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        if (!isFinite(x) || !isFinite(y)) return;
        const ppt = this._pixelsPerTile();
        const sx = (x - this._camX) * ppt;
        const sy = (y - this._camY) * ppt;
        if (!isFinite(sx) || !isFinite(sy)) return; // huge inputs must not warp the sprite
        t.setXY(sx, sy, false, true);
    }

    spriteWorldX (args, util) {
        const t = this._resolveSprite(args.SPRITE, util);
        if (!t) return 0;
        return this._camX + (t.x / this._pixelsPerTile());
    }

    spriteWorldY (args, util) {
        const t = this._resolveSprite(args.SPRITE, util);
        if (!t) return 0;
        return this._camY + (t.y / this._pixelsPerTile());
    }

    pointSpriteTowardsWorld (args, util) {
        const t = this._resolveSprite(args.SPRITE, util);
        if (!t) return;
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        if (!isFinite(x) || !isFinite(y)) return;
        const ppt = this._pixelsPerTile();
        const dx = (((x - this._camX) * ppt) - t.x);
        const dy = (((y - this._camY) * ppt) - t.y);
        if (dx === 0 && dy === 0) return;
        t.setDirection(90 - ((Math.atan2(dy, dx) * 180) / Math.PI));
    }

    cameraFollow (args, util) {
        const name = String(args.SPRITE === null || typeof args.SPRITE === 'undefined' ?
            '' : args.SPRITE).trim();
        if (name === '') {
            // Blank follows the calling sprite, like the other sprite blocks.
            const t = this._resolveSprite('', util);
            if (!t) {
                this._followName = null;
                return;
            }
            this._followName = t.sprite.name;
            this._anchors.add(t.id);
            return;
        }
        this._followName = name;
        const t = this._resolveSprite(name, util);
        if (t) this._anchors.add(t.id);
    }

    stopCameraFollow () {
        this._followName = null;
    }

    updateAnchoredSprites (args, util) {
        this._pruneAnchors();
        if (!this._followName) return;
        const t = this._resolveSprite(this._followName, util);
        if (!t) {
            this._followName = null; // followed sprite is gone; unlock
            return;
        }
        this._anchors.add(t.id);
        const ppt = this._pixelsPerTile();
        const dx = t.x / ppt;
        const dy = t.y / ppt;
        if (!isFinite(dx) || !isFinite(dy)) return;
        if (dx !== 0 || dy !== 0) {
            this._camX += dx;
            this._camY += dy;
            // Shift every anchored sprite (including the followed one, which
            // lands exactly on the camera center).
            this._shiftAnchors(dx, dy);
        }
        this._render();
    }

    // ---------------- Coordinate converters ----------------

    screenXOfWorld (args) {
        const wx = Cast.toNumber(args.WX);
        if (!isFinite(wx)) return 0;
        return (wx - this._camX) * this._pixelsPerTile();
    }

    screenYOfWorld (args) {
        const wy = Cast.toNumber(args.WY);
        if (!isFinite(wy)) return 0;
        return (wy - this._camY) * this._pixelsPerTile();
    }

    worldXOfScreen (args) {
        const sx = Cast.toNumber(args.SX);
        if (!isFinite(sx)) return this._camX;
        return this._camX + (sx / this._pixelsPerTile());
    }

    worldYOfScreen (args) {
        const sy = Cast.toNumber(args.SY);
        if (!isFinite(sy)) return this._camY;
        return this._camY + (sy / this._pixelsPerTile());
    }

    // ---------------- Structures ----------------

    generateStructures (args) {
        const d = Cast.toNumber(args.DENSITY);
        if (isFinite(d)) this._structDensity = clamp(d, 0, 100);
        this._initStructureField();
        this._render();
    }

    structureAt (args) {
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        if (!isFinite(x) || !isFinite(y)) return '';
        return this._structureTypeAt(x, y);
    }

    showStructures (args) {
        this._structuresVisible = String(args.SHOWHIDE).toLowerCase() !== 'hide';
        this._render();
    }

    structuresVisible () {
        return this._structuresVisible;
    }

    // ---------------- Visibility ----------------

    showTerrain (args) {
        this._visible = String(args.SHOWHIDE).toLowerCase() !== 'hide';
        if (this._ensureLayer()) {
            try {
                this.runtime.renderer.updateDrawableVisible(this._drawable, this._visible);
                this.runtime.renderer.updateDrawableVisible(this._structDrawable,
                    this._visible && this._structuresVisible);
                if (this.runtime.requestRedraw) this.runtime.requestRedraw();
            } catch (e) {
                // ignore
            }
        }
    }

    terrainVisible () {
        return this._visible;
    }

    redrawTerrain () {
        this._render();
    }
}

module.exports = SBTerrain;
