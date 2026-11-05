/** sRGB, linear-light and CIE Lab (D65) conversions. 8-bit sRGB in and out; everything else is floating point. */

const SRGB_TO_LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** 8-bit sRGB value -> linear light, 0..1. */
export const toLinear = (v: number): number => SRGB_TO_LINEAR[v]!;

/** Linear light -> 8-bit sRGB, rounded and clamped. */
export function toSrgb8(linear: number): number {
  const c = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  const v = Math.round(c * 255);
  return v <= 0 ? 0 : v > 255 ? 255 : v; // `<=` also turns -0 into 0
}

const XN = 0.95047;
const ZN = 1.08883;
const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;

const f = (t: number): number => (t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
const fInverse = (t: number): number => {
  const cubed = t * t * t;
  return cubed > EPSILON ? cubed : (116 * t - 16) / KAPPA;
};

export type Lab = [number, number, number];

export function rgbToLab(r: number, g: number, b: number): Lab {
  const lr = SRGB_TO_LINEAR[r]!;
  const lg = SRGB_TO_LINEAR[g]!;
  const lb = SRGB_TO_LINEAR[b]!;
  const x = 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = 0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb;
  const fx = f(x / XN);
  const fy = f(y);
  const fz = f(z / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Lab -> 8-bit sRGB (out-of-gamut colours are clamped). */
export function labToRgb8(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116;
  const x = XN * fInverse(fy + a / 500);
  const y = fInverse(fy);
  const z = ZN * fInverse(fy - b / 200);
  return [
    toSrgb8(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    toSrgb8(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    toSrgb8(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
  ];
}

/** Linear light -> sRGB on a 0..255 scale, neither clamped nor rounded (so the mapping stays smooth). */
function toSrgbFloat(linear: number): number {
  const c = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return c * 255;
}

/** Lab -> sRGB on a 0..255 scale, neither clamped to the gamut nor rounded (for building smooth lookup tables). */
export function labToRgbFloat(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116;
  const x = XN * fInverse(fy + a / 500);
  const y = fInverse(fy);
  const z = ZN * fInverse(fy - b / 200);
  return [
    toSrgbFloat(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    toSrgbFloat(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    toSrgbFloat(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
  ];
}
/** CIE76 colour difference: Euclidean distance in Lab. A difference of about 2-3 is just noticeable side by side. */
export const deltaE76 = (p: Lab, q: Lab): number => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
