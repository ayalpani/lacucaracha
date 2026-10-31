import {
  BufferAttribute,
  BufferGeometry,
  Euler,
  Float32BufferAttribute,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { withOcclusion } from './occlusion';

/** Body length (head to wing tips, without antennae) the model is scaled to, in metres. */
export const TARGET_BODY_LENGTH = 0.036;

export interface RoachModelPart {
  geometry: BufferGeometry;
  material: Material;
}

export interface RoachModel {
  name: string;
  parts: RoachModelPart[];
  triangles: number;
  /** Body half-width, body length and height after normalisation (metres). Drive the leg shader. */
  bodyHalfWidth: number;
  bodyLength: number;
  height: number;
}

/** Manual fix-ups for models that come out of an image-to-3D tool lying on their side or facing backwards. */
export interface RoachOrientation {
  /** Quarter turns around the up axis, applied after auto-orientation. */
  yaw: number;
  /** Quarter turns around the side axis, for models exported Z-up. */
  pitch: number;
}

export const DEFAULT_ORIENTATION: RoachOrientation = { yaw: 0, pitch: 0 };

/**
 * Parses a GLB, bakes all meshes into a few merged geometries (one per material),
 * and normalises it: body centred, feet on y = 0, length along +Z (front), real size.
 * Animations and skins are ignored: the swarm animates legs in the vertex shader instead.
 */
export async function loadRoachModel(
  data: ArrayBuffer,
  name = 'roach.glb',
  orientation: RoachOrientation = DEFAULT_ORIENTATION,
): Promise<RoachModel> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(data, '');
  gltf.scene.updateMatrixWorld(true);

  const byMaterial = new Map<Material, BufferGeometry[]>();
  gltf.scene.traverse((o: Object3D) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const g = cleanGeometry(mesh.geometry, mesh.matrixWorld);
    const list = byMaterial.get(material) ?? [];
    list.push(g);
    byMaterial.set(material, list);
  });
  if (byMaterial.size === 0) throw new Error('Die GLB-Datei enthält kein Mesh.');

  const parts: RoachModelPart[] = [];
  for (const [material, geos] of byMaterial) {
    const merged = mergeAll(geos);
    parts.push({ geometry: merged, material });
  }

  // Manual orientation first (pitch for Z-up exports), then auto: long axis → Z, antennae → +Z.
  const pre = new Matrix4().makeRotationFromEuler(new Euler((orientation.pitch * Math.PI) / 2, 0, 0));
  for (const p of parts) p.geometry.applyMatrix4(pre);
  let stats = measure(parts);
  if (stats.bodyX > stats.bodyZ) {
    rotateY(parts, Math.PI / 2);
    stats = measure(parts);
  }
  // Antennae stick out much further in front than cerci/hind legs at the back.
  if (stats.overhangBack > stats.overhangFront) {
    rotateY(parts, Math.PI);
    stats = measure(parts);
  }
  if (orientation.yaw % 4 !== 0) {
    rotateY(parts, (orientation.yaw * Math.PI) / 2);
    stats = measure(parts);
  }

  const s = TARGET_BODY_LENGTH / Math.max(stats.bodyZ, 1e-6);
  const norm = new Matrix4()
    .makeScale(s, s, s)
    .multiply(new Matrix4().makeTranslation(-stats.cx, -stats.minY, -stats.cz));
  let triangles = 0;
  for (const p of parts) {
    p.geometry.applyMatrix4(norm);
    p.geometry.computeBoundingBox();
    p.geometry.computeBoundingSphere();
    triangles += (p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count) / 3;
  }

  return {
    name,
    parts,
    triangles,
    bodyHalfWidth: stats.bodyHalfWidth * s,
    bodyLength: TARGET_BODY_LENGTH,
    height: stats.height * s,
  };
}

/** World-space copy with only position/normal/uv (skins, morphs, tangents dropped). */
function cleanGeometry(src: BufferGeometry, world: Matrix4): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', src.attributes.position.clone());
  if (src.attributes.normal) g.setAttribute('normal', src.attributes.normal.clone());
  if (src.attributes.uv) g.setAttribute('uv', src.attributes.uv.clone());
  if (src.index) g.setIndex(src.index.clone());
  g.applyMatrix4(world);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g;
}

function mergeAll(geos: BufferGeometry[]): BufferGeometry {
  if (geos.length === 1) return geos[0];
  // mergeGeometries needs all-indexed or all-non-indexed.
  const mixed = geos.some((g) => g.index) && geos.some((g) => !g.index);
  const list = mixed ? geos.map((g) => (g.index ? g.toNonIndexed() : g)) : geos;
  // Normalised (quantised) attributes don't merge with float ones: convert to float.
  for (const g of list) {
    for (const key of Object.keys(g.attributes)) {
      const a = g.attributes[key] as BufferAttribute;
      if (a.normalized || !(a.array instanceof Float32Array)) {
        const f = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) f[i * a.itemSize + c] = a.getComponent(i, c);
        g.setAttribute(key, new BufferAttribute(f, a.itemSize));
      }
    }
  }
  const merged = mergeGeometries(list, false);
  if (!merged) throw new Error('Meshes der GLB-Datei konnten nicht zusammengeführt werden.');
  return merged;
}

function rotateY(parts: RoachModelPart[], angle: number): void {
  const m = new Matrix4().makeRotationY(angle);
  for (const p of parts) p.geometry.applyMatrix4(m);
}

interface Stats {
  minY: number;
  height: number;
  cx: number;
  cz: number;
  bodyX: number;
  bodyZ: number;
  bodyHalfWidth: number;
  overhangFront: number;
  overhangBack: number;
}

/**
 * Finds the body inside the whole model. Uses triangle centroids weighted by triangle
 * area: the shell is most of the surface, legs and antennae are thin and add little
 * area (vertex counts would lie, tools tessellate unevenly). Only the part above the
 * lowest 35 % of the height counts, which drops the feet and lower leg segments.
 */
function measure(parts: RoachModelPart[]): Stats {
  let minY = Infinity;
  let maxY = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const p of parts) {
    const pos = p.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
  }
  const cutY = minY + (maxY - minY) * 0.35;
  const xs: Weighted[] = [];
  const zs: Weighted[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (const p of parts) {
    const pos = p.geometry.attributes.position;
    const idx = p.geometry.index;
    const tris = (idx ? idx.count : pos.count) / 3;
    const step = Math.max(1, Math.floor(tris / 40000));
    for (let t = 0; t < tris; t += step) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      const cy = (a.y + b.y + c.y) / 3;
      if (cy < cutY) continue;
      const cx = (a.x + b.x + c.x) / 3;
      const cz = (a.z + b.z + c.z) / 3;
      b.sub(a);
      c.sub(a);
      const area = b.cross(c).length() / 2;
      if (area <= 0) continue;
      xs.push({ v: cx, w: area });
      zs.push({ v: cz, w: area });
    }
  }
  const x0 = weightedPercentile(xs, 0.04);
  const x1 = weightedPercentile(xs, 0.96);
  const z0 = weightedPercentile(zs, 0.03);
  const z1 = weightedPercentile(zs, 0.97);
  return {
    minY,
    height: maxY - minY,
    cx: (x0 + x1) / 2,
    cz: (z0 + z1) / 2,
    bodyX: x1 - x0,
    bodyZ: z1 - z0,
    bodyHalfWidth: (x1 - x0) / 2,
    overhangFront: zMax - z1,
    overhangBack: z0 - zMin,
  };
}

interface Weighted {
  v: number;
  w: number;
}

function weightedPercentile(values: Weighted[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((x, y) => x.v - y.v);
  let total = 0;
  for (const e of s) total += e.w;
  let acc = 0;
  for (const e of s) {
    acc += e.w;
    if (acc >= p * total) return e.v;
  }
  return s[s.length - 1].v;
}

/**
 * Material for drawing the model in the swarm: depth occlusion plus a vertex-shader
 * walk cycle. Per instance `aAnim` = (gait phase, moving 0..1, antenna phase).
 * Legs are everything outside the body width and low down; they swing fore/aft in an
 * alternating tripod (front+hind of one side with the middle leg of the other side).
 */
export function swarmMaterial(source: Material, model: RoachModel): Material {
  const base = source as MeshStandardMaterial;
  const mat = withOcclusion(base.clone());
  const occlusionPatch = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    occlusionPatch.call(mat, shader, renderer);
    shader.uniforms.uBodyW = { value: model.bodyHalfWidth };
    shader.uniforms.uBodyL = { value: model.bodyLength };
    shader.uniforms.uBodyH = { value: model.height };
    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        `attribute vec3 aAnim;
uniform float uBodyW;
uniform float uBodyL;
uniform float uBodyH;
void main() {`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  {
    float side = transformed.x >= 0.0 ? 1.0 : -1.0;
    float ax = abs(transformed.x);
    float zn = transformed.z / uBodyL;
    // Leg weight: 0 at the hip (body edge), 1 at the foot; only the low part of the model.
    float legW = smoothstep(uBodyW * 0.9, uBodyW * 2.2, ax) * (1.0 - smoothstep(uBodyH * 0.45, uBodyH * 0.8, transformed.y));
    // Middle legs move opposite to front/hind legs; blends smoothly so nothing tears.
    float zoneSign = 1.0 - 2.0 * (smoothstep(-0.26, -0.12, zn) - smoothstep(0.08, 0.2, zn));
    float ph = aAnim.x + (side > 0.0 ? 0.0 : 3.14159265);
    float swing = sin(ph) * zoneSign;
    float lift = max(0.0, cos(ph) * zoneSign);
    transformed.z += swing * 0.11 * uBodyL * legW * aAnim.y;
    transformed.y += lift * 0.06 * uBodyL * legW * aAnim.y;
    // Antennae: whatever sticks out in front of the head sweeps sideways and bobs.
    float antW = smoothstep(0.55, 1.4, zn);
    transformed.x += sin(aAnim.z + side * 1.3) * 0.22 * uBodyL * antW * antW;
    transformed.y += cos(aAnim.z * 0.7 + side) * 0.06 * uBodyL * antW * antW;
  }`,
      );
  };
  mat.customProgramCacheKey = () => 'occlusion-roach-glb';
  return mat;
}
