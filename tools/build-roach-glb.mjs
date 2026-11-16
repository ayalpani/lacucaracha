// Builds public/models/roach.glb: an American cockroach (Periplaneta americana) modelled
// from anatomy, in millimetres, front = +Z, feet on y = 0. Vertex colours, no textures,
// ~6k triangles so 200+ of them still run on a mid-range phone.
// Usage: node tools/build-roach-glb.mjs [out.glb]
import { writeFileSync } from 'node:fs';
import {
  BufferAttribute, CatmullRomCurve3, Color, ConeGeometry, CylinderGeometry, Group, Mesh,
  MeshStandardMaterial, Quaternion, SphereGeometry, TubeGeometry, Vector3,
} from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); }); }
  readAsDataURL(blob) { blob.arrayBuffer().then((b) => { this.result = 'data:application/octet-stream;base64,' + Buffer.from(b).toString('base64'); this.onloadend?.(); }); }
};

const col = (hex) => new Color(hex); // sRGB style → linear working colour
const mix = (a, b, t) => a.clone().lerp(b, Math.min(1, Math.max(0, t)));
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

function paint(geo, fn) {
  const pos = geo.attributes.position;
  const c = new Float32Array(pos.count * 3);
  const p = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const k = fn(p, i);
    c.set([k.r, k.g, k.b], i * 3);
  }
  geo.setAttribute('color', new BufferAttribute(c, 3));
  return geo;
}

/** Unit sphere deformed by fn(x,y,z in -1..1) → [x,y,z] in mm; colour by colourFn(local unit coords). */
function blob(w, h, deform, colourFn) {
  const g = new SphereGeometry(1, w, h);
  const pos = g.attributes.position;
  const local = [];
  for (let i = 0; i < pos.count; i++) {
    const u = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    local.push(u);
    pos.setXYZ(i, ...deform(...u));
  }
  g.computeVertexNormals();
  return paint(g, (_p, i) => colourFn(...local[i]));
}

function segment(a, b, r0, r1, radial, colour) {
  const d = new Vector3().subVectors(b, a);
  const len = d.length();
  const g = new CylinderGeometry(r1, r0, len, radial, 1, false).translate(0, len / 2, 0);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d.normalize()));
  g.translate(a.x, a.y, a.z);
  return paint(g, () => colour);
}

function sphereAt(c, r, colour, w = 8, h = 6) {
  const g = new SphereGeometry(1, w, h).scale(r.x, r.y, r.z).translate(c.x, c.y, c.z);
  return paint(g, () => colour);
}

/** Tube along points with radius tapering r0 → r1, banded colour for antenna segments. */
function taperedTube(points, r0, r1, tubular, radial, colourA, colourB, bands) {
  const curve = new CatmullRomCurve3(points);
  const g = new TubeGeometry(curve, tubular, 1, radial, false);
  const pos = g.attributes.position;
  const n = radial + 1;
  const p = new Vector3();
  const c = new Float32Array(pos.count * 3);
  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular;
    const centre = curve.getPointAt(t);
    const r = r0 + (r1 - r0) * t;
    const k = bands && Math.sin(t * bands * Math.PI * 2) > 0.6 ? colourB : mix(colourA, colourB, t * 0.4);
    for (let j = 0; j < n; j++) {
      const idx = i * n + j;
      p.fromBufferAttribute(pos, idx).sub(centre).multiplyScalar(r).add(centre);
      pos.setXYZ(idx, p.x, p.y, p.z);
      c.set([k.r, k.g, k.b], idx * 3);
    }
  }
  g.setAttribute('color', new BufferAttribute(c, 3));
  g.computeVertexNormals();
  return g;
}

const glossy = [];
const matte = [];

// --- palette (sRGB) ---
const WING_DARK = col('#4a1f0a');
const WING = col('#7b3612');
const WING_EDGE = col('#b5692e');
const CREAM = col('#b98a4c');
const PRO_DARK = col('#2e1206');
const HEAD = col('#3a1a0b');
const EYE = col('#0b0605');
const BELLY = col('#8a4a20');
const BELLY_SEAM = col('#3a1808');
const LEG = col('#8a4a22');
const LEG_DARK = col('#5c2c10');
const ANT = col('#6b3416');
const ANT_DARK = col('#3a1a0a');

// --- forewings (tegmina): two long flat lobes, right one overlapping the left ---
for (const side of [1, -1]) {
  const over = side > 0 ? 0.25 : 0; // right wing lies on top
  glossy.push(blob(28, 14,
    (x, y, z) => {
      // z: -1 back .. +1 front. Rounded tip at the back, straight-ish inner edge.
      const zz = z;
      const outline = zz < 0 ? Math.sqrt(Math.max(0, 1 - zz * zz * 0.92)) : 1 - 0.18 * zz * zz;
      const px = side * (2.4 + 1.3 * Math.min(0, zz) + x * 4.3 * outline);
      const py = 3.55 + over + (y > 0 ? y * 1.35 * outline : y * 0.35);
      const pz = -8 + zz * 16.5;
      return [px, py, pz];
    },
    (x, y, z) => {
      const edge = smooth(0.55, 0.98, Math.abs(x));
      const back = smooth(0.2, -1, z);
      let k = mix(WING_DARK, WING, 0.35 + back * 0.6);
      k = mix(k, WING_EDGE, edge * 0.85);
      // Longitudinal veins.
      const vein = Math.abs(Math.sin((x * 3.2 + z * 0.8) * Math.PI));
      if (vein < 0.12 && y > 0) k = mix(k, WING_DARK, 0.45);
      return y < 0 ? mix(k, BELLY, 0.5) : k;
    }));
}

// --- pronotum: wide shield over thorax and head, cream rim, dark two-lobed centre ---
glossy.push(blob(28, 12,
  (x, y, z) => {
    // Wider than long, narrower towards the head (slightly trapezoid).
    const outline = (1 - 0.12 * z * z) * (1 - 0.12 * Math.max(0, z));
    return [x * 6.6 * outline, 4.2 + (y > 0 ? y * 1.15 : y * 0.3), 11.0 + z * 4.7];
  },
  (x, y, z) => {
    if (y < 0) return BELLY;
    const r = Math.sqrt(x * x + z * z);
    const lobe = Math.min(
      Math.hypot((x - 0.28) / 0.33, (z + 0.05) / 0.62),
      Math.hypot((x + 0.28) / 0.33, (z + 0.05) / 0.62),
    );
    let k = mix(PRO_DARK, col('#5a260c'), smooth(0.2, 1.0, lobe));
    k = mix(k, CREAM, smooth(0.7, 0.9, r) * 0.9);
    return k;
  }));

// --- head: tucked under the pronotum, pointing down (hypognathous) ---
glossy.push(blob(14, 10, (x, y, z) => [x * 2.0, 2.4 + y * 1.9 - z * 0.5, 17.0 + z * 1.6 + y * 0.6], () => HEAD));
for (const side of [1, -1]) {
  glossy.push(sphereAt(new Vector3(side * 1.75, 2.9, 17.2), new Vector3(0.55, 1.0, 0.8), EYE));
}
// Mouthparts / palps.
for (const side of [1, -1]) {
  matte.push(segment(new Vector3(side * 0.8, 1.2, 18.0), new Vector3(side * 1.6, 0.4, 19.3), 0.28, 0.18, 4, LEG_DARK));
}

// --- underside: thorax + segmented abdomen (seen from below and from the side) ---
matte.push(blob(24, 12,
  (x, y, z) => {
    const w = z < 0 ? 1 - 0.55 * z * z : 1 - 0.25 * z * z;
    return [x * 5.4 * w, 2.85 + y * 1.2, -6 + z * 15];
  },
  (x, y, z) => {
    const seg = Math.abs(Math.sin(((z + 1) * 15) / 2.4 * Math.PI));
    return seg < 0.35 && z < 0.35 ? BELLY_SEAM : mix(BELLY, col('#8a4a22'), smooth(0.6, 1, Math.abs(x)) * 0.5);
  }));

// --- legs: coxa, femur, tibia with spines, 5-part tarsus ---
const legDefs = [
  // hip (x, z), knee (x, y, z), ankle (x, z), foot (x, z)
  { hip: [2.2, 13.5], knee: [6.0, 4.2, 16.0], ankle: [9.0, 19.0], foot: [11.0, 23.5], femR: 0.55 },
  { hip: [2.6, 8.0], knee: [8.5, 4.8, 8.5], ankle: [13.0, 5.0], foot: [16.5, 2.5], femR: 0.62 },
  { hip: [2.8, 3.0], knee: [9.0, 5.0, -1.0], ankle: [13.5, -11.0], foot: [16.0, -19.5], femR: 0.72 },
];
for (const side of [1, -1]) {
  for (const L of legDefs) {
    const hip = new Vector3(side * L.hip[0], 2.2, L.hip[1]);
    const coxaEnd = new Vector3(side * (L.hip[0] + 1.6), 2.0, L.hip[1] - 0.4);
    const knee = new Vector3(side * L.knee[0], L.knee[1], L.knee[2]);
    const ankle = new Vector3(side * L.ankle[0], 1.0, L.ankle[1]);
    const foot = new Vector3(side * L.foot[0], 0.0, L.foot[1]);
    matte.push(segment(hip, coxaEnd, 1.0, 0.75, 6, LEG_DARK));
    matte.push(segment(coxaEnd, knee, L.femR, L.femR * 0.75, 6, LEG));
    matte.push(segment(knee, ankle, L.femR * 0.55, L.femR * 0.38, 5, LEG));
    // Tibial spines: the bristly look that makes roach legs read as roach legs.
    for (let i = 1; i <= 6; i++) {
      const t = i / 7;
      const base = new Vector3().lerpVectors(knee, ankle, t);
      const dir = new Vector3().subVectors(ankle, knee).normalize();
      const out = new Vector3(side, 0.9 * (i % 2 ? 1 : -0.2), 0).normalize();
      const tip = base.clone().addScaledVector(out, 1.0).addScaledVector(dir, 0.8);
      const sp = new ConeGeometry(0.13, 1.2, 3).translate(0, 0.6, 0);
      sp.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), tip.clone().sub(base).normalize()));
      sp.translate(base.x, base.y, base.z);
      matte.push(paint(sp, () => LEG_DARK));
    }
    // Tarsus: slightly curved chain down to the ground.
    let prev = ankle;
    for (let i = 1; i <= 4; i++) {
      const t = i / 4;
      const p = new Vector3().lerpVectors(ankle, foot, t);
      p.y = (1 - t) * 1.0 + Math.sin(t * Math.PI) * 0.25;
      matte.push(segment(prev, p, 0.24 - t * 0.06, 0.2 - t * 0.06, 4, i % 2 ? LEG : LEG_DARK));
      prev = p;
    }
  }
}

// --- antennae: long, thin, banded, sweeping out and slightly up ---
for (const side of [1, -1]) {
  const pts = [
    new Vector3(side * 1.0, 3.3, 18.2),
    new Vector3(side * 2.6, 4.6, 23),
    new Vector3(side * 5.5, 5.4, 31),
    new Vector3(side * 9.5, 5.0, 40),
    new Vector3(side * 14.5, 3.8, 49),
  ];
  matte.push(taperedTube(pts, 0.32, 0.1, 36, 4, ANT, ANT_DARK, 18));
}

// --- cerci at the tail ---
for (const side of [1, -1]) {
  matte.push(taperedTube([new Vector3(side * 1.4, 3.0, -21.5), new Vector3(side * 2.6, 3.4, -24.5), new Vector3(side * 3.6, 3.9, -27)], 0.55, 0.15, 6, 5, LEG, LEG_DARK, 4));
}

const toNonIndexedAll = (list) => list.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => {
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.uv) g.setAttribute('uv', new BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g;
});

const root = new Group();
root.name = 'Periplaneta americana';
const shellMat = new MeshStandardMaterial({ name: 'chitin_glossy', vertexColors: true, roughness: 0.28, metalness: 0 });
const legMat = new MeshStandardMaterial({ name: 'chitin_matte', vertexColors: true, roughness: 0.5, metalness: 0 });
const shell = new Mesh(mergeVertices(mergeGeometries(toNonIndexedAll(glossy)), 1e-4), shellMat);
const legs = new Mesh(mergeVertices(mergeGeometries(toNonIndexedAll(matte)), 1e-4), legMat);
shell.name = 'shell';
legs.name = 'legs_antennae';
root.add(shell, legs);
const tris = (shell.geometry.index.count + legs.geometry.index.count) / 3;
const glb = await new GLTFExporter().parseAsync(root, { binary: true });
const out = process.argv[2] ?? 'public/models/roach.glb';
writeFileSync(out, Buffer.from(glb));
console.log(`wrote ${out}: ${tris} triangles, ${(glb.byteLength / 1024).toFixed(0)} KB`);
