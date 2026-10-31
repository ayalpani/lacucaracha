import {
  CanvasTexture,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import type { Roach } from './swarm';

const Y = new Vector3(0, 1, 0);
const SEGMENTS_PER_ROACH = 18; // 6 legs x 2 + 2 antennae x 2 + 2 cerci

interface LegDef {
  hip: Vector3;
  foot: Vector3;
  phaseOffset: number;
}

const legs: LegDef[] = [];
{
  const hips = [
    [0.0035, 0.012],
    [0.004, 0.009],
    [0.004, 0.005],
  ];
  const feet = [
    [0.012, 0.023],
    [0.017, 0.004],
    [0.016, -0.017],
  ];
  for (const side of [1, -1]) {
    for (let i = 0; i < 3; i++) {
      // Alternating tripod gait: L-front, R-middle, L-hind move together.
      const group = (i + (side > 0 ? 0 : 1)) % 2;
      legs.push({
        hip: new Vector3(hips[i][0] * side, 0.0045, hips[i][1]),
        foot: new Vector3(feet[i][0] * side, 0, feet[i][1]),
        phaseOffset: group * Math.PI,
      });
    }
  }
}

/** Draws all roaches with a handful of instanced meshes (a few draw calls, regardless of swarm size). */
export class RoachRenderer {
  readonly group = new Group();
  private readonly abdomen: InstancedMesh;
  private readonly thorax: InstancedMesh;
  private readonly head: InstancedMesh;
  private readonly segments: InstancedMesh;
  private readonly shadows: InstancedMesh;
  private readonly stains: InstancedMesh;

  private readonly mRoach = new Matrix4();
  private readonly mLocal = new Matrix4();
  private readonly mOut = new Matrix4();
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly v2 = new Vector3();
  private readonly s = new Vector3();
  private readonly right = new Vector3();
  private readonly fwd = new Vector3();
  private readonly knee = new Vector3();
  private readonly foot = new Vector3();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();

  constructor(private readonly capacity: number) {
    const chitin = (hex: string, rough: number): MeshPhysicalMaterial =>
      new MeshPhysicalMaterial({
        color: new Color(hex),
        roughness: rough,
        metalness: 0.05,
        clearcoat: 1,
        clearcoatRoughness: 0.3,
      });

    this.abdomen = this.instanced(taperedEllipsoid(), chitin('#5b2a10', 0.42), capacity);
    this.thorax = this.instanced(new SphereGeometry(1, 14, 8), chitin('#3a1a0b', 0.38), capacity);
    this.head = this.instanced(new SphereGeometry(1, 10, 6), chitin('#24110a', 0.5), capacity);
    const segGeo = new CylinderGeometry(1, 0.6, 1, 5, 1).translate(0, 0.5, 0);
    this.segments = this.instanced(segGeo, chitin('#3d1d0d', 0.55), capacity * SEGMENTS_PER_ROACH);

    const shadowGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const shadowMat = new MeshBasicMaterial({
      map: radialTexture(),
      color: 0x000000,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.shadows = this.instanced(shadowGeo, shadowMat, capacity);
    this.shadows.renderOrder = -1;

    const stainMat = new MeshBasicMaterial({
      map: splatTexture(),
      color: 0x7a6526,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    this.stains = this.instanced(shadowGeo, stainMat, capacity);
    this.stains.renderOrder = -1;
  }

  private instanced(geo: BufferGeometry, mat: Material, count: number): InstancedMesh {
    const mesh = new InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.group.add(mesh);
    return mesh;
  }

  update(roaches: readonly Roach[]): void {
    let body = 0;
    let seg = 0;
    let stain = 0;

    for (const r of roaches) {
      if (body >= this.capacity) break;
      const squashT = r.squashed;
      const squashed = squashT >= 0;

      this.fwd.copy(r.heading);
      this.right.crossVectors(r.normal, this.fwd).normalize();
      this.mRoach.makeBasis(this.right, r.normal, this.fwd);
      this.mRoach.setPosition(r.position);
      const scale = r.scale;
      this.mRoach.scale(this.s.set(scale, scale, scale));

      // Squashed: flatten and fade out by sinking into the surface.
      const flat = squashed ? 0.28 : 1;
      const wide = squashed ? 1.25 : 1;
      const sink = squashed ? Math.max(0, squashT - 7) * 0.002 : 0;

      // Breathing / body bob while walking.
      const bob = squashed ? 0 : Math.sin(r.gait * 2) * 0.0003 * Math.min(1, r.speed / 0.05);

      this.setPart(this.abdomen, body, 0, (0.0052 + bob) * flat - sink, -0.004, 0.0105 * wide, 0.0048 * flat, 0.0165 * wide);
      this.setPart(this.thorax, body, 0, (0.0058 + bob) * flat - sink, 0.0105, 0.0092 * wide, 0.0034 * flat, 0.0062 * wide);
      this.setPart(this.head, body, 0, 0.0045 * flat - sink, 0.0168, 0.0038 * wide, 0.0032 * flat, 0.0036);

      // Contact shadow sits just above the surface.
      this.mLocal.makeScale(0.03 * wide, 1, 0.048 * wide).setPosition(0, 0.0006, 0);
      this.shadows.setMatrixAt(body, this.mOut.multiplyMatrices(this.mRoach, this.mLocal));

      if (squashed && stain < this.capacity) {
        const grow = Math.min(1, squashT * 6);
        this.mLocal.makeScale(0.05 * grow, 1, 0.055 * grow).setPosition(0, 0.0009, 0);
        this.stains.setMatrixAt(stain++, this.mOut.multiplyMatrices(this.mRoach, this.mLocal));
      }

      // Legs.
      const moving = squashed ? 0 : Math.min(1, r.speed / 0.04);
      for (const leg of legs) {
        const p = r.gait + leg.phaseOffset;
        const side = Math.sign(leg.hip.x);
        this.foot.copy(leg.foot);
        if (squashed) {
          this.foot.x *= 1.35;
          this.foot.z *= 1.15;
        } else {
          this.foot.z += Math.sin(p) * 0.0055 * moving;
          this.foot.y += Math.max(0, Math.cos(p)) * 0.0035 * moving;
        }
        this.a.copy(leg.hip);
        this.a.y = this.a.y * flat - sink;
        this.knee.addVectors(this.a, this.foot).multiplyScalar(0.5);
        this.knee.y += squashed ? 0.001 : 0.0068;
        this.knee.x += side * 0.002;
        this.foot.y -= sink;
        this.setSegment(seg++, this.a, this.knee, 0.00075);
        this.setSegment(seg++, this.knee, this.foot, 0.0005);
      }

      // Antennae: long, constantly feeling around.
      for (const side of [1, -1]) {
        const w = squashed ? 0 : Math.sin(r.antennaPhase + side * 1.3);
        const w2 = squashed ? 0 : Math.cos(r.antennaPhase * 0.7 + side);
        this.a.set(side * 0.0015, 0.0048 * flat - sink, 0.0195);
        this.b.set(side * (0.006 + w * 0.0025), (0.0085 + w2 * 0.002) * flat - sink, 0.033);
        this.c.set(side * (0.0135 + w * 0.006), (0.0075 + w2 * 0.004) * flat - sink, 0.049 + w2 * 0.002);
        this.setSegment(seg++, this.a, this.b, 0.0003);
        this.setSegment(seg++, this.b, this.c, 0.0002);
      }

      // Cerci at the back.
      for (const side of [1, -1]) {
        this.a.set(side * 0.002, 0.004 * flat - sink, -0.019);
        this.b.set(side * 0.0042, 0.0048 * flat - sink, -0.0255);
        this.setSegment(seg++, this.a, this.b, 0.0005);
      }

      body++;
    }

    for (const m of [this.abdomen, this.thorax, this.head, this.shadows]) {
      m.count = body;
      m.instanceMatrix.needsUpdate = true;
    }
    this.segments.count = seg;
    this.segments.instanceMatrix.needsUpdate = true;
    this.stains.count = stain;
    this.stains.instanceMatrix.needsUpdate = true;
  }

  private setPart(mesh: InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
    this.mLocal.makeScale(sx, sy, sz).setPosition(x, y, z);
    mesh.setMatrixAt(i, this.mOut.multiplyMatrices(this.mRoach, this.mLocal));
  }

  private setSegment(i: number, from: Vector3, to: Vector3, radius: number): void {
    this.v.subVectors(to, from);
    const len = this.v.length();
    this.q.setFromUnitVectors(Y, this.v2.copy(this.v).divideScalar(len || 1));
    this.mLocal.compose(from, this.q, this.s.set(radius, len, radius));
    this.segments.setMatrixAt(i, this.mOut.multiplyMatrices(this.mRoach, this.mLocal));
  }
}

/** Unit sphere, narrower at the back end: reads as a roach abdomen with folded wings. */
function taperedEllipsoid(): SphereGeometry {
  const g = new SphereGeometry(1, 18, 10);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const taper = z < 0 ? 1 + z * 0.35 : 1;
    pos.setX(i, pos.getX(i) * taper);
    pos.setY(i, pos.getY(i) * (z < 0 ? 1 + z * 0.25 : 1));
  }
  g.computeVertexNormals();
  return g;
}

function radialTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

function splatTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'white';
  ctx.beginPath();
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 30 + Math.random() * 22;
    const x = 64 + Math.cos(a) * r;
    const y = 64 + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.quadraticCurveTo(64 + Math.cos(a - 0.2) * (r + 8), 64 + Math.sin(a - 0.2) * (r + 8), x, y);
  }
  ctx.fill();
  for (let i = 0; i < 9; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 46 + Math.random() * 14;
    ctx.beginPath();
    ctx.arc(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 2 + Math.random() * 5, 0, Math.PI * 2);
    ctx.fill();
  }
  return new CanvasTexture(c);
}
