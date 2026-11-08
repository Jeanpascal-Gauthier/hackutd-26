// Weather-radar style heat field shared by the 2D floor plan and the 3D building.
// Every room is a source with a fire and smoke level; the shader blurs them across walls,
// churns the result with slowly swirling noise and maps it onto a radar colour ramp
// (smoke: green -> yellow, fire: orange -> red -> magenta core).
import { ShaderMaterial, Vector2, Vector4 } from "three";
import { HEAT_FLOOR as FLOOR, type HeatRect, type HeatSource } from "./sources";

export { hasHeat, heatSources, type HeatRect, type HeatSource } from "./sources";
export const MAX_SOURCES = 16;

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragmentShader = /* glsl */ `
#define MAX_SOURCES ${MAX_SOURCES}
uniform float uTime;
uniform int uCount;
uniform vec4 uRects[MAX_SOURCES];   // minX, minZ, maxX, maxZ (metres)
uniform vec2 uValues[MAX_SOURCES];  // fire, smoke (0..1)
uniform vec4 uBounds;               // extent the quad covers (metres)
uniform vec4 uClip;                 // building footprint; the field fades out beyond it
uniform vec2 uCore;                 // hottest point; the swirl turns around it
uniform float uLayer;               // 0 = lowest layer; higher layers spread wider
uniform float uOpacity;
uniform float uComposite;           // 1 = draw shadow + two drifting layers in one pass (2D)
varying vec2 vUv;

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dot(hash2(i), f), dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
             mix(dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.0; a *= 0.5; }
  return v;
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float sdBox(vec2 p, vec4 r) {
  vec2 c = (r.xy + r.zw) * 0.5, h = (r.zw - r.xy) * 0.5;
  vec2 d = abs(p - c) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// NWS-style reflectivity ramp.
vec3 ramp(float v) {
  vec3 c = vec3(0.05, 0.42, 0.16);
  c = mix(c, vec3(0.13, 0.74, 0.24), smoothstep(0.08, 0.18, v));
  c = mix(c, vec3(0.62, 0.86, 0.20), smoothstep(0.18, 0.28, v));
  c = mix(c, vec3(1.00, 0.87, 0.20), smoothstep(0.28, 0.38, v));
  c = mix(c, vec3(1.00, 0.57, 0.10), smoothstep(0.38, 0.50, v));
  c = mix(c, vec3(0.94, 0.16, 0.10), smoothstep(0.50, 0.62, v));
  c = mix(c, vec3(0.68, 0.04, 0.12), smoothstep(0.62, 0.74, v));
  c = mix(c, vec3(0.88, 0.26, 0.80), smoothstep(0.74, 0.86, v));
  c = mix(c, vec3(1.00, 0.86, 0.97), smoothstep(0.86, 0.98, v));
  return c;
}

vec4 heat(vec2 p, float l) {
  // Sampled per pixel (no coarse radar cells), so the field stays sharp at any resolution.
  float t = uTime;
  vec2 rel = p - uCore;
  float r = length(rel);
  // The field itself is twisted into a pinwheel around the core (breathing slowly), and the
  // noise that roughens it rotates rigidly on top, so the swirl moves but never winds up.
  float twist = (1.1 + 0.25 * sin(t * 0.21 + l)) * exp(-r / 6.0);
  vec2 q = rot(1.3 * exp(-r / 5.0) + t * (0.07 + 0.03 * l)) * rel;
  float n1 = fbm(q * 0.26 + vec2(l * 13.1, l * 7.7) + vec2(t * 0.05, -t * 0.03));
  float n2 = fbm(q * 0.5 - vec2(t * 0.04, t * 0.06) + 31.0 * l);
  vec2 wp = uCore + rot(twist) * rel + vec2(n1, n2) * (2.2 + 0.6 * l);
  float spread = 1.0 + 0.4 * l;
  float sf = 1.6 * spread, ss = 2.4 * spread;
  float fire = 0.0, smoke = 0.0;
  for (int i = 0; i < MAX_SOURCES; i++) {
    if (i >= uCount) break;
    float d = max(sdBox(wp, uRects[i]), 0.0);
    fire = 1.0 - (1.0 - fire) * (1.0 - uValues[i].x * exp(-d * d / (2.0 * sf * sf)));
    smoke = 1.0 - (1.0 - smoke) * (1.0 - uValues[i].y * exp(-d * d / (2.0 * ss * ss)));
  }
  float grain = 0.75 + 0.5 * fbm(p * 1.1 + vec2(-t * 0.08, t * 0.05) + l * 5.0);
  float level = max(fire * grain * 1.15, smoke * grain * 0.55);
  float outside = max(sdBox(p, uClip), 0.0);
  level *= exp(-outside * outside * 2.5);
  if (level < 0.07) return vec4(0.0);
  vec3 col = ramp(floor(level * 14.0) / 14.0);
  // Light smoke stays a faint wash so the plan underneath still reads; fire is near-opaque.
  return vec4(col, mix(0.2, 0.85, smoothstep(0.07, 0.7, level)));
}

vec4 over(vec4 a, vec4 b) {
  float alpha = a.a + b.a * (1.0 - a.a);
  return vec4((a.rgb * a.a + b.rgb * b.a * (1.0 - a.a)) / max(alpha, 1e-4), alpha);
}

void main() {
  vec2 p = vec2(mix(uBounds.x, uBounds.z, vUv.x), mix(uBounds.w, uBounds.y, vUv.y));
  vec4 c;
  if (uComposite > 0.5) {
    // Flat view: a soft drop shadow, the field, and an upper layer that drifts against it.
    float t = uTime;
    vec2 lift = vec2(0.35 + 0.15 * sin(t * 0.31), 0.55 + 0.12 * cos(t * 0.23));
    vec4 shadow = vec4(0.0, 0.0, 0.0, heat(p - vec2(0.6, 0.8), 0.0).a * 0.22);
    vec4 top = heat(p + lift, 1.0);
    top.a *= 0.55;
    c = over(top, over(heat(p, 0.0), shadow));
  } else {
    c = heat(p, uLayer);
  }
  gl_FragColor = vec4(c.rgb, c.a * uOpacity);
}`;

export function createHeatMaterial({ composite = false, layer = 0 } = {}) {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uCount: { value: 0 },
      uRects: { value: Array.from({ length: MAX_SOURCES }, () => new Vector4()) },
      uValues: { value: Array.from({ length: MAX_SOURCES }, () => new Vector2()) },
      uBounds: { value: new Vector4(0, 0, 1, 1) },
      uClip: { value: new Vector4(0, 0, 1, 1) },
      uCore: { value: new Vector2() },
      uLayer: { value: layer },
      uOpacity: { value: 1 },
      uComposite: { value: composite ? 1 : 0 },
    },
  });
}

export function setHeatBounds(material: ShaderMaterial, bounds: HeatRect, clip: HeatRect) {
  (material.uniforms.uBounds!.value as Vector4).set(...bounds);
  (material.uniforms.uClip!.value as Vector4).set(...clip);
}

export function setHeatSources(material: ShaderMaterial, sources: HeatSource[]) {
  const active = sources.filter((s) => s.fire > FLOOR || s.smoke > FLOOR)
    .sort((a, b) => Math.max(b.fire, b.smoke) - Math.max(a.fire, a.smoke)).slice(0, MAX_SOURCES);
  const rects = material.uniforms.uRects!.value as Vector4[];
  const values = material.uniforms.uValues!.value as Vector2[];
  active.forEach((s, i) => { rects[i]!.set(s.x, s.z, s.x + s.w, s.z + s.d); values[i]!.set(s.fire, s.smoke); });
  material.uniforms.uCount!.value = active.length;
  // Swirl centre: fire-weighted centroid, else smoke-weighted.
  const weight = (s: HeatSource) => active.some((a) => a.fire > FLOOR) ? s.fire : s.smoke;
  const total = active.reduce((sum, s) => sum + weight(s), 0) || 1;
  (material.uniforms.uCore!.value as Vector2).set(
    active.reduce((sum, s) => sum + (s.x + s.w / 2) * weight(s), 0) / total,
    active.reduce((sum, s) => sum + (s.z + s.d / 2) * weight(s), 0) / total,
  );
}

export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Time used for the single still frame drawn under reduced motion. */
export const STILL_TIME = 12;
