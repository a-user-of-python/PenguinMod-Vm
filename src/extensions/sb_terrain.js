/**
 * Terrain World extension for PenguinMod / HiddenBlocks.
 *
 * Adds blocks that generate a natural-looking heightmap (seeded, domain-warped
 * fractal noise), classify it into ocean / beach / land with user-set
 * thresholds, render it as a viewport behind the sprites, and expose a camera
 * + coordinate converters so a sprite can explore a huge stored world without
 * the world itself ever moving.
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
     * @returns {number} noise in roughly [-1, 1]
     */
    noise (x, y) {
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

        // Classification thresholds.
        this._seaLevel = 0.45;
        this._beachHeight = 0.035;

        // Terrain colors.
        this._colors = {
            ocean: '#2f6fd0',
            beach: '#e6d49a',
            land: '#4da64d'
        };

        // Camera: world position (tiles, y-up) at stage center + zoom
        // (tiles visible across the stage width).
        this._camX = 0;
        this._camY = 0;
        this._zoom = 120;
        this._visible = true;

        // Renderer layer (created lazily so headless runtimes are fine).
        this._skinId = null;
        this._drawable = null;
        this._imageData = null;

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
     * Generate the stored heightmap. Domain-warped fBm gives natural,
     * continent-like terrain. Normalized to [0, 1].
     */
    _generate (seed, size, octaves) {
        // Coerce inputs first: a non-finite size/octave must not produce a
        // corrupt (NaN-sized) world. Cast.toNumber already maps garbage
        // strings to 0, but true NaN/Infinity can arrive programmatically.
        size = Cast.toNumber(size);
        octaves = Cast.toNumber(octaves);
        if (!isFinite(size)) size = 1024;
        if (!isFinite(octaves)) octaves = 5;
        size = clamp(Math.round(size), 64, 2048);
        // Snap to a power of two for predictable memory use.
        const pow = Math.round(Math.log2(size));
        size = Math.pow(2, clamp(pow, 6, 11));
        octaves = clamp(Math.round(octaves), 1, 10);

        const rand = mulberry32(seed | 0);
        const base = new Perlin2D(rand);
        const warp = new Perlin2D(rand);
        const data = new Float32Array(size * size);
        // Base frequency: this many noise cells span the whole map.
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
        // Normalize to [0, 1].
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

        this._height = data;
        this._size = size;
        this._seed = seed | 0;
        this._octaves = octaves;
        this._camX = size / 2;
        this._camY = size / 2;
        this._zoom = clamp(this._zoom, 8, size);
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
     * @returns {number} 0 = ocean, 1 = beach, 2 = land
     */
    _classify (h) {
        if (h < this._seaLevel) return 0;
        if (h < this._seaLevel + this._beachHeight) return 1;
        return 2;
    }

    // ------------------------------------------------------------------
    // Color LUT
    // ------------------------------------------------------------------

    _rebuildLUT () {
        const sea = clamp(this._seaLevel, 0, 1);
        const beachTop = clamp(sea + Math.max(0, this._beachHeight), 0, 1);
        const ocean = parseColor(this._colors.ocean);
        const beach = parseColor(this._colors.beach);
        const land = parseColor(this._colors.land);
        const deep = ocean.map(c => Math.round(c * 0.45));
        const landDark = land.map(c => Math.round(c * 0.68));
        const peak = [232, 234, 240];
        for (let i = 0; i < LUT_SIZE; i++) {
            const h = i / (LUT_SIZE - 1);
            let rgb;
            if (h < sea) {
                const t = sea > 0 ? Math.pow(h / sea, 0.65) : 1;
                rgb = mix(deep, ocean, t);
            } else if (h < beachTop) {
                rgb = beach;
            } else {
                const t = (h - beachTop) / Math.max(1e-6, 1 - beachTop);
                if (t < 0.55) {
                    rgb = mix(landDark, land, t / 0.55);
                } else {
                    const k = (t - 0.55) / 0.45;
                    rgb = mix(land, peak, k * k);
                }
            }
            this._lut[i * 3] = rgb[0];
            this._lut[(i * 3) + 1] = rgb[1];
            this._lut[(i * 3) + 2] = rgb[2];
        }
    }

    // ------------------------------------------------------------------
    // Renderer layer (the visible viewport; the stored world never moves)
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
                const h = this._sampleBilinear(wx, wy);
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
        try {
            renderer.updateBitmapSkin(this._skinId, this._imageData, 1);
            renderer.updateDrawableVisible(this._drawable, this._visible);
            if (this.runtime.requestRedraw) this.runtime.requestRedraw();
        } catch (e) {
            // Renderer went away; the layer will be recreated on next render.
            this._skinId = null;
            this._drawable = null;
        }
    }

    _pixelsPerTile () {
        return STAGE_W / this._zoom;
    }

    // ------------------------------------------------------------------
    // Extension metadata
    // ------------------------------------------------------------------

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
                        description: 'Terrain class at a world position: ocean, beach or land'
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
                    opcode: 'setTerrainColor',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'sbTerrain.setTerrainColor',
                        default: 'set [TARGET] color to [COLOR]',
                        description: 'Recolor ocean, beach or land'
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
                        default: 'camera y',
                        description: 'Camera world y position'
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
                    items: ['512', '1024', '2048']
                },
                showHide: {
                    acceptReporters: true,
                    items: ['show', 'hide']
                },
                terrainColor: {
                    acceptReporters: true,
                    items: ['ocean', 'beach', 'land']
                }
            }
        };
    }

    // ------------------------------------------------------------------
    // Block implementations
    // ------------------------------------------------------------------

    generateTerrain (args) {
        const seed = Cast.toNumber(args.SEED);
        const size = Cast.toNumber(args.SIZE);
        const octaves = Cast.toNumber(args.OCTAVES);
        this._generate(seed, size, octaves);
        this._render();
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
        return this._noise().noise(x * 0.1, y * 0.1);
    }

    fractalNoise (args) {
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        let octaves = Cast.toNumber(args.OCTAVES);
        if (!isFinite(x) || !isFinite(y)) return 0;
        if (!isFinite(octaves)) octaves = 4;
        return fbm(this._noise(), x * 0.1, y * 0.1, octaves);
    }

    ridgedNoise (args) {
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        let octaves = Cast.toNumber(args.OCTAVES);
        if (!isFinite(x) || !isFinite(y)) return 0;
        if (!isFinite(octaves)) octaves = 4;
        return ridged(this._noise(), x * 0.1, y * 0.1, octaves);
    }

    terrainHeight (args) {
        if (!this._height) return 0;
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        if (!isFinite(x) || !isFinite(y)) return 0;
        if (x < 0 || y < 0 || x > this._size - 1 || y > this._size - 1) return 0;
        return this._sampleBilinear(x, y);
    }

    tileAt (args) {
        if (!this._height) return 'ocean';
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        if (!isFinite(x) || !isFinite(y)) return 'ocean';
        const h = this._sampleNearest(x, y);
        const c = this._classify(h);
        return c === 0 ? 'ocean' : (c === 1 ? 'beach' : 'land');
    }

    setSeaLevel (args) {
        const level = Cast.toNumber(args.LEVEL);
        if (!isFinite(level)) return; // keep the previous level on bad input
        this._seaLevel = clamp(level, 0, 1);
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
        this._rebuildLUT();
        this._render();
    }

    setTerrainColor (args) {
        const target = String(args.TARGET).toLowerCase();
        if (target === 'ocean' || target === 'beach' || target === 'land') {
            this._colors[target] = String(args.COLOR);
            this._rebuildLUT();
            this._render();
        }
    }

    setZoom (args) {
        const zoom = Cast.toNumber(args.ZOOM);
        if (!isFinite(zoom)) return; // keep the previous zoom on bad input
        const maxZoom = this._size > 0 ? this._size : 2048;
        this._zoom = clamp(zoom, 8, maxZoom);
        this._render();
    }

    changeZoom (args) {
        const delta = Cast.toNumber(args.DELTA);
        if (!isFinite(delta)) return;
        const maxZoom = this._size > 0 ? this._size : 2048;
        this._zoom = clamp(this._zoom + delta, 8, maxZoom);
        this._render();
    }

    zoom () {
        return this._zoom;
    }

    setCamera (args) {
        const x = Cast.toNumber(args.X);
        const y = Cast.toNumber(args.Y);
        if (!isFinite(x) || !isFinite(y)) return; // keep position on bad input
        this._camX = x;
        this._camY = y;
        this._render();
    }

    changeCameraX (args) {
        const dx = Cast.toNumber(args.DX);
        if (!isFinite(dx)) return;
        this._camX += dx;
        this._render();
    }

    changeCameraY (args) {
        const dy = Cast.toNumber(args.DY);
        if (!isFinite(dy)) return;
        this._camY += dy;
        this._render();
    }

    cameraX () {
        return this._camX;
    }

    cameraY () {
        return this._camY;
    }

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

    showTerrain (args) {
        this._visible = String(args.SHOWHIDE).toLowerCase() !== 'hide';
        if (this._ensureLayer()) {
            try {
                this.runtime.renderer.updateDrawableVisible(this._drawable, this._visible);
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
