// Deterministic synthetic fixtures for auto-detect: every image is generated from a seed, so the
// labeled set is reproducible. They stand in for real images; see the notes in auto.test.ts.
import type { CategoryFamily } from '@ie/contracts';
import sharp from 'sharp';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gauss = (rand: () => number): number => {
  const u = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
};

const clamp = (x: number): number => Math.max(0, Math.min(255, Math.round(x)));

const fromRaw = (data: Uint8Array, width: number, height: number, channels: 3 | 4): Promise<Buffer> =>
  sharp(data, { raw: { width, height, channels } }).png().toBuffer();

const fromSvg = (svg: string): Promise<Buffer> => sharp(Buffer.from(svg)).png().toBuffer();

interface FieldOptions {
  seed: number;
  /** Spatial frequencies in cycles across the image; small = smooth scene, large = fine texture. */
  freq: number;
  noise: number;
  /** 0 = grey, 1 = strongly coloured. */
  color: number;
  base?: number;
  amplitude?: number;
  /** Amplitude of fine-scale detail (grain, foliage, fabric); 0 gives a soft, blurry-looking image. */
  detail?: number;
}

/** Smooth multi-frequency colour field plus Gaussian noise: a stand-in for a photograph or texture. */
async function field(width: number, height: number, o: FieldOptions): Promise<Buffer> {
  const rand = rng(o.seed);
  const waves = Array.from({ length: 3 }, () =>
    Array.from({ length: 6 }, () => ({
      fx: (0.3 + rand()) * o.freq,
      fy: (0.3 + rand()) * o.freq,
      phase: rand() * Math.PI * 2,
      amp: (o.amplitude ?? 38) * (0.4 + rand() * 0.6),
    })),
  );
  const fine = Array.from({ length: 10 }, () => ({
    fx: 20 + rand() * 50,
    fy: 20 + rand() * 50,
    phase: rand() * Math.PI * 2,
    amp: (o.detail ?? 0) * (0.5 + rand() * 0.5),
  }));
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const detailTerm = fine.reduce((s, w) => s + w.amp * Math.sin(2 * Math.PI * (w.fx * x / width + w.fy * y / height) + w.phase), 0);
      const grey = (o.base ?? 128) + waves[1]!.reduce((s, w) => s + w.amp * Math.sin(2 * Math.PI * (w.fx * x / width + w.fy * y / height) + w.phase), 0) * 0.5;
      const n = gauss(rand) * o.noise;
      for (let c = 0; c < 3; c++) {
        const tint = waves[c]!.reduce((s, w) => s + w.amp * Math.sin(2 * Math.PI * (w.fx * x / width + w.fy * y / height) + w.phase), 0);
        out[(y * width + x) * 3 + c] = clamp(grey * (1 - o.color) + (o.base ?? 128) * o.color + tint * o.color + n + detailTerm);
      }
    }
  }
  return fromRaw(out, width, height, 3);
}

async function pixelSprite(grid: number, scale: number, seed: number): Promise<Buffer> {
  const rand = rng(seed);
  const palette = Array.from({ length: 7 }, () => [clamp(rand() * 255), clamp(rand() * 255), clamp(rand() * 255)]);
  const out = new Uint8Array(grid * grid * 3);
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid / 2; x++) {
      const solid = rand() < 0.55 && Math.abs(x - grid / 4) + Math.abs(y - grid / 2) < grid * 0.7;
      const colour = solid ? palette[1 + Math.floor(rand() * 6)]! : palette[0]!;
      for (const xx of [x, grid - 1 - x]) out.set(colour, (y * grid + xx) * 3);
    }
  }
  const small = await fromRaw(out, grid, grid, 3);
  return sharp(small).resize(grid * scale, grid * scale, { kernel: 'nearest' }).png().toBuffer();
}

const lineArtSvg = (w: number, h: number): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <g fill="none" stroke="#111" stroke-width="3" stroke-linecap="round">
    <circle cx="${w * 0.3}" cy="${h * 0.4}" r="${h * 0.22}"/>
    <path d="M ${w * 0.1} ${h * 0.85} C ${w * 0.3} ${h * 0.6}, ${w * 0.5} ${h * 0.95}, ${w * 0.9} ${h * 0.7}"/>
    <rect x="${w * 0.55}" y="${h * 0.15}" width="${w * 0.3}" height="${h * 0.3}"/>
    <path d="M ${w * 0.55} ${h * 0.15} L ${w * 0.7} ${h * 0.05} L ${w * 0.85} ${h * 0.15}"/>
  </g></svg>`;

const flatSceneSvg = (w: number, h: number, hue: string[]): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="100%" height="55%" fill="${hue[0]}"/><rect y="55%" width="100%" height="45%" fill="${hue[1]}"/>
  <circle cx="${w * 0.78}" cy="${h * 0.22}" r="${h * 0.1}" fill="${hue[2]}"/>
  <polygon points="${w * 0.1},${h * 0.55} ${w * 0.3},${h * 0.2} ${w * 0.5},${h * 0.55}" fill="${hue[3]}"/>
  <rect x="${w * 0.55}" y="${h * 0.4}" width="${w * 0.2}" height="${h * 0.3}" fill="${hue[4]}"/>
  <rect x="${w * 0.6}" y="${h * 0.5}" width="${w * 0.05}" height="${h * 0.1}" fill="${hue[0]}"/></svg>`;

const flatCharacterSvg = (w: number, h: number): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect width="100%" height="100%" fill="#bfe3f5"/>
  <ellipse cx="${w / 2}" cy="${h * 0.3}" rx="${w * 0.17}" ry="${h * 0.12}" fill="#f3c9a5" stroke="#3a2a20" stroke-width="4"/>
  <path d="M ${w * 0.3} ${h * 0.28} Q ${w / 2} ${h * 0.05} ${w * 0.7} ${h * 0.28} Q ${w / 2} ${h * 0.2} ${w * 0.3} ${h * 0.28}" fill="#7a2e8f"/>
  <rect x="${w * 0.33}" y="${h * 0.42}" width="${w * 0.34}" height="${h * 0.4}" rx="30" fill="#e8467c" stroke="#3a2a20" stroke-width="4"/>
  <rect x="${w * 0.38}" y="${h * 0.8}" width="${w * 0.09}" height="${h * 0.17}" fill="#2d3e8f"/><rect x="${w * 0.53}" y="${h * 0.8}" width="${w * 0.09}" height="${h * 0.17}" fill="#2d3e8f"/></svg>`;

const iconSvg = (opaque: boolean): string => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
  ${opaque ? '<rect width="256" height="256" fill="#ffffff"/>' : ''}
  <defs><radialGradient id="g"><stop offset="0" stop-color="#ffb347"/><stop offset="1" stop-color="#d1401a"/></radialGradient></defs>
  <circle cx="128" cy="128" r="100" fill="url(#g)"/><path d="M96 128 L120 152 L164 100" fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round"/></svg>`;

export interface AutoFixture {
  name: string;
  prompt: string;
  expectedFamily: CategoryFamily;
  /** Part of the must-pass cases named in the spec. */
  mustPass?: boolean;
  build: () => Promise<Buffer>;
}

const photo = (seed: number, w = 1600, h = 1200, over: Partial<FieldOptions> = {}) =>
  field(w, h, { seed, freq: 2.2, noise: 5, color: 0.7, detail: 5, ...over });

export const AUTO_FIXTURES: AutoFixture[] = [
  // Medium and format cues from the image alone.
  { name: 'pixel sprite 32px upscaled', prompt: '', expectedFamily: 'stylize', mustPass: true, build: () => pixelSprite(32, 8, 11) },
  { name: 'pixel sprite 64px upscaled, game prompt', prompt: 'game sprite', expectedFamily: 'stylize', mustPass: true, build: () => pixelSprite(64, 16, 12) },
  { name: 'line art on white', prompt: '', expectedFamily: 'stylize', mustPass: true, build: () => fromSvg(lineArtSvg(1200, 900)) },
  { name: 'line art with sketch prompt', prompt: 'sketch of a house', expectedFamily: 'stylize', mustPass: true, build: () => fromSvg(lineArtSvg(1000, 1000)) },
  { name: 'transparent icon', prompt: '', expectedFamily: 'stylize', build: () => fromSvg(iconSvg(false)) },
  { name: 'opaque icon with prompt', prompt: 'app icon', expectedFamily: 'stylize', build: () => fromSvg(iconSvg(true)) },
  { name: 'seamless texture prompt', prompt: 'seamless stone texture', expectedFamily: 'texture', mustPass: true, build: () => field(512, 512, { seed: 21, freq: 24, noise: 14, color: 0.2 }) },
  { name: 'fine texture, no prompt', prompt: '', expectedFamily: 'texture', mustPass: true, build: () => field(512, 512, { seed: 22, freq: 40, noise: 18, color: 0.15, amplitude: 60 }) },
  { name: 'soft noisy faded photo', prompt: '', expectedFamily: 'restore', mustPass: true, build: () => field(1200, 900, { seed: 31, freq: 1.4, noise: 22, color: 0.1, amplitude: 14 }) },
  { name: 'old photo restore prompt', prompt: 'restore this old family photo', expectedFamily: 'restore', mustPass: true, build: () => photo(32, 1200, 900, { color: 0.2, noise: 12 }) },
  { name: 'low-contrast faded sepia', prompt: '', expectedFamily: 'restore', mustPass: true, build: () => field(1000, 800, { seed: 33, freq: 1.2, noise: 14, color: 0.08, amplitude: 10, base: 150 }) },

  // Scene and subject cues from the prompt, with the image supplying realism.
  { name: 'wide photographic landscape', prompt: '', expectedFamily: 'environment', build: () => photo(41, 2400, 1000) },
  { name: 'mountain landscape prompt', prompt: 'misty mountain landscape', expectedFamily: 'environment', build: () => photo(42) },
  { name: 'living room interior prompt', prompt: 'modern living room interior', expectedFamily: 'environment', build: () => photo(43) },
  { name: 'forest scene prompt', prompt: 'a forest scene', expectedFamily: 'environment', build: () => photo(44) },
  { name: 'photographic scene, no prompt', prompt: '', expectedFamily: 'environment', build: () => photo(45) },
  { name: 'flat stylized scene', prompt: '', expectedFamily: 'environment', build: () => fromSvg(flatSceneSvg(1200, 800, ['#8fd3ff', '#5fae5b', '#ffd54a', '#7d5ba6', '#d9734a'])) },
  { name: 'cartoon village prompt', prompt: 'cartoon village', expectedFamily: 'environment', build: () => fromSvg(flatSceneSvg(1200, 800, ['#b9e6ff', '#7cc36a', '#ffe066', '#9b6fd0', '#f08a5d'])) },
  { name: 'portrait prompt, tall frame', prompt: 'portrait of a woman', expectedFamily: 'character', build: () => photo(51, 600, 1000) },
  { name: 'tall frame, no prompt', prompt: '', expectedFamily: 'character', build: () => photo(52, 600, 1000) },
  { name: 'anime character', prompt: 'anime girl', expectedFamily: 'character', build: () => fromSvg(flatCharacterSvg(600, 1000)) },
  { name: 'dragon prompt', prompt: 'a dragon on a cliff', expectedFamily: 'character', build: () => photo(53) },
  { name: 'sports car prompt', prompt: 'a sports car', expectedFamily: 'props', build: () => photo(61) },
  { name: 'perfume bottle product shot', prompt: 'perfume bottle product shot', expectedFamily: 'props', build: () => photo(62, 1200, 1200) },
  { name: 'wooden chest prop', prompt: 'a wooden chest', expectedFamily: 'props', build: () => photo(63, 1200, 1200) },
  { name: 'isometric house', prompt: 'isometric house', expectedFamily: 'props', build: () => fromSvg(flatSceneSvg(1000, 1000, ['#cfd8dc', '#90a4ae', '#ffcc80', '#b0bec5', '#8d6e63'])) },
];
