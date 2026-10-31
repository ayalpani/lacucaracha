import {
  CanvasTexture,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { withOcclusion } from './occlusion';
import { swarmMaterial, type RoachModel } from './roachModel';
import type { Roach } from './swarm';

const Y = new Vector3(0, 1, 0);
/** 6 legs × 3 segments + 2 antennae × 4 segments + 2 cerci. */
const SEGMENTS_PER_ROACH = 28;
/** At 1.0 the model is ~3.6 cm long (American cockroach size ~3.5–4 cm). */
const BODY_SCALE = 1.1;

interface LegDef {
  hip: Vector3;
  /** Resting foot position. */
  foot: Vector3;
  /** Knee direction (outward/up), relative. */
  kneeOut: number;
  phaseOffset: number;
  side: number;
}

const legs: LegDef[] = [];
{
  // Front legs short and forward, hind legs long and swept back — like the real thing.
  const hips = [
    [0.0028, 0.0125],
    [0.0034, 0.0085],
    [0.0036, 0.0045],
  ];
  const feet = [
    [0.009, 0.019],
    [0.0145, 0.002],
    [0.0155, -0.019],
  ];
  const kneeOut = [0.004, 0.006, 0.007];
  for (const side of [1, -1]) {
    for (let i = 0; i < 3; i++) {
      // Alternating tripod gait: L-front, R-middle, L-hind move together.
      const group = (i + (side > 0 ? 0 : 1)) % 2;
      legs.push({
        hip: new Vector3(hips[i][0] * side, 0.0032, hips[i][1]),
        foot: new Vector3(feet[i][0] * side, 0, feet[i][1]),
        kneeOut: kneeOut[i],
        phaseOffset: group * Math.PI,
        side,
      });
    }
  }
}

/** Draws all roaches with a handful of instanced meshes (a few draw calls, regardless of swarm size). */
export class RoachRenderer {
  readonly group = new Group();
  private readonly wings: InstancedMesh;
  private readonly pronotum: InstancedMesh;
  private readonly head: InstancedMesh;
  private readonly belly: InstancedMesh;
  private readonly segments: InstancedMesh;
  private readonly shadows: InstancedMesh;
  private readonly stains: InstancedMesh;
  private readonly procedural: InstancedMesh[];
  /** Loaded GLB model (one instanced mesh per material), replaces the procedural parts when set. */
  private model: { meshes: InstancedMesh[]; anim: InstancedBufferAttribute } | null = null;

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
  private readonly ankle = new Vector3();
  private readonly foot = new Vector3();
  private readonly hip = new Vector3();
  private readonly pts = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];

  constructor(private readonly capacity: number) {
    const glossy = (map: CanvasTexture | null, hex: string, rough: number): MeshStandardMaterial =>
      withOcclusion(new MeshStandardMaterial({ map, color: new Color(hex), roughness: rough, metalness: 0, envMapIntensity: 1.2 }));

    this.wings = this.instanced(shell(0.028, 0.21, 0.11, 0.3), glossy(wingTexture(), '#ffffff', 0.22), capacity);
    this.pronotum = this.instanced(shell(0.0095, 0.64, 0.16, -0.1), glossy(pronotumTexture(), '#ffffff', 0.28), capacity);
    this.head = this.instanced(new SphereGeometry(1, 10, 8), glossy(null, '#2a1208', 0.4), capacity);
    this.belly = this.instanced(new SphereGeometry(1, 12, 8), glossy(null, '#5a2a12', 0.6), capacity);
    const segGeo = new CylinderGeometry(1, 0.7, 1, 6, 1).translate(0, 0.5, 0);
    this.segments = this.instanced(segGeo, glossy(null, '#6e3416', 0.45), capacity * SEGMENTS_PER_ROACH);

    const shadowGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const shadowMat = withOcclusion(
      new MeshBasicMaterial({ map: radialTexture(), color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    this.shadows = this.instanced(shadowGeo, shadowMat, capacity);
    this.shadows.renderOrder = -1;

    const stainMat = withOcclusion(
      new MeshBasicMaterial({ map: splatTexture(), color: 0x6e5a22, transparent: true, opacity: 0.92, depthWrite: false }),
    );
    this.stains = this.instanced(shadowGeo, stainMat, capacity);
    this.stains.renderOrder = -1;
    this.procedural = [this.wings, this.pronotum, this.head, this.belly, this.segments];
  }

  /** Swap in a GLB roach (or null for the built-in procedural one). */
  setModel(model: RoachModel | null): void {
    if (this.model) {
      for (const m of this.model.meshes) {
        this.group.remove(m);
        (m.material as { dispose(): void }).dispose();
      }
      this.model = null;
    }
    for (const m of this.procedural) m.visible = !model;
    if (!model) return;
    const anim = new InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    anim.setUsage(DynamicDrawUsage);
    const meshes = model.parts.map((p) => {
      const geo = p.geometry.clone();
      geo.setAttribute('aAnim', anim);
      return this.instanced(geo, swarmMaterial(p.material, model), this.capacity);
    });
    this.model = { meshes, anim };
  }

  get usingModel(): boolean {
    return this.model !== null;
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
      const moving = squashed ? 0 : Math.min(1, r.speed / 0.04);

      // Tripod gait makes the body yaw a little from side to side.
      const wobble = Math.sin(r.gait) * 0.06 * moving;
      this.fwd.copy(r.heading).applyAxisAngle(r.normal, wobble);
      this.right.crossVectors(r.normal, this.fwd).normalize();
      this.mRoach.makeBasis(this.right, r.normal, this.fwd);
      this.mRoach.setPosition(r.position);
      const scale = r.scale * BODY_SCALE;
      this.mRoach.scale(this.s.set(scale, scale, scale));

      const flat = squashed ? 0.3 : 1;
      const wide = squashed ? 1.25 : 1;
      const sink = squashed ? Math.max(0, squashT - 7) * 0.002 : 0;
      const lift = 0.0018 + Math.sin(r.gait * 2) * 0.00015 * moving; // body rides just above the ground

      // Wings cover the abdomen; pronotum shield in front; head tucked underneath.
      this.setPart(this.belly, body, 0, (lift + 0.0006) * flat - sink, -0.004, 0.0048 * wide, 0.0016 * flat, 0.0145);
      this.setPart(this.wings, body, 0, (lift + 0.0009) * flat - sink, -0.0065, wide, flat, 1);
      this.setPart(this.pronotum, body, 0, (lift + 0.0016) * flat - sink, 0.0105, wide, flat, 1);
      this.setPart(this.head, body, 0, (lift + 0.0002) * flat - sink, 0.0155, 0.0028 * wide, 0.0024 * flat, 0.003);

      this.mLocal.makeScale(0.022 * wide, 1, 0.05 * wide).setPosition(0, 0.0005, -0.002);
      this.shadows.setMatrixAt(body, this.mOut.multiplyMatrices(this.mRoach, this.mLocal));

      if (squashed && stain < this.capacity) {
        const grow = Math.min(1, squashT * 6);
        this.mLocal.makeScale(0.05 * grow, 1, 0.055 * grow).setPosition(0, 0.0008, 0);
        this.stains.setMatrixAt(stain++, this.mOut.multiplyMatrices(this.mRoach, this.mLocal));
      }

      if (this.model) {
        const by = lift * flat - sink;
        this.mLocal.makeScale(wide, flat, wide).setPosition(0, by - 0.0018 * flat, 0);
        this.mOut.multiplyMatrices(this.mRoach, this.mLocal);
        for (const m of this.model.meshes) m.setMatrixAt(body, this.mOut);
        this.model.anim.setXYZ(body, r.gait, moving, r.antennaPhase);
        body++;
        continue;
      }

      // Legs: femur, tibia, tarsus.
      for (const leg of legs) {
        const p = r.gait + leg.phaseOffset;
        this.foot.copy(leg.foot);
        if (squashed) {
          this.foot.x *= 1.3;
          this.foot.z *= 1.1;
        } else {
          this.foot.z += Math.sin(p) * 0.005 * moving;
          this.foot.y += Math.max(0, Math.cos(p)) * 0.003 * moving;
        }
        this.hip.copy(leg.hip);
        this.hip.y = (lift + 0.0006) * flat - sink;
        // Knee sits high and out, ankle low near the foot: the typical splayed roach stance.
        this.knee.lerpVectors(this.hip, this.foot, 0.4);
        this.knee.x += leg.side * leg.kneeOut * 0.6;
        this.knee.y = squashed ? 0.0012 : 0.0046;
        this.ankle.lerpVectors(this.hip, this.foot, 0.82);
        this.ankle.x += leg.side * 0.0012;
        this.ankle.y = squashed ? 0.0004 : 0.0016 + this.foot.y * 0.6;
        this.foot.y -= sink;
        this.setSegment(seg++, this.hip, this.knee, 0.0008);
        this.setSegment(seg++, this.knee, this.ankle, 0.00045);
        this.setSegment(seg++, this.ankle, this.foot, 0.00025);
      }

      // Antennae: long (≈ body length), thin, sweeping.
      for (const side of [1, -1]) {
        const sweep = squashed ? 0 : Math.sin(r.antennaPhase + side * 1.3) * (r.mode === 'pause' ? 1 : 0.5);
        const bob = squashed ? 0 : Math.cos(r.antennaPhase * 0.7 + side);
        const [a, b, c, d, e] = this.pts;
        a.set(side * 0.0012, lift * flat - sink + 0.0006, 0.0172);
        b.set(side * (0.0032 + sweep * 0.0015), (0.004 + bob * 0.0008) * flat - sink, 0.026);
        c.set(side * (0.0065 + sweep * 0.004), (0.0055 + bob * 0.0016) * flat - sink, 0.035);
        d.set(side * (0.011 + sweep * 0.007), (0.0055 + bob * 0.0025) * flat - sink, 0.043);
        e.set(side * (0.0165 + sweep * 0.01), (0.0045 + bob * 0.0035) * flat - sink, 0.0495);
        this.setSegment(seg++, a, b, 0.00026);
        this.setSegment(seg++, b, c, 0.0002);
        this.setSegment(seg++, c, d, 0.00016);
        this.setSegment(seg++, d, e, 0.00012);
      }

      // Cerci at the back.
      for (const side of [1, -1]) {
        const [a, b] = this.pts;
        a.set(side * 0.0016, (lift + 0.0004) * flat - sink, -0.0205);
        b.set(side * 0.0034, (lift + 0.0012) * flat - sink, -0.0255);
        this.setSegment(seg++, a, b, 0.0004);
      }

      body++;
    }

    for (const m of [this.wings, this.pronotum, this.head, this.belly, this.shadows, ...(this.model?.meshes ?? [])]) {
      m.count = body;
      m.instanceMatrix.needsUpdate = true;
    }
    if (this.model) this.model.anim.needsUpdate = true;
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

/**
 * Flattened, roach-outline shell (top-view planar UVs so a painted texture maps cleanly).
 * Built at its final size (metres) so instance matrices only translate.
 * @param length  front-to-back length
 * @param widthRatio  max half-width / length
 * @param heightRatio  dome height / length
 * @param backTaper  how much narrower the back end is
 */
function shell(length: number, widthRatio: number, heightRatio: number, backTaper: number): SphereGeometry {
  const g = new SphereGeometry(1, 28, 16);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  const halfL = length / 2;
  const halfW = length * widthRatio;
  const h = length * heightRatio;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i); // -1 back … +1 front
    // Widest a bit behind the middle, rounded front, tapered back.
    const outline = z < 0 ? 1 - backTaper * z * z : 1 - 0.12 * z * z;
    const px = x * halfW * outline;
    const pz = z * halfL;
    // Low dome on top, almost flat underside.
    const py = y > 0 ? y * h : y * h * 0.25;
    pos.setXYZ(i, px, py, pz);
    uv.setXY(i, px / (2 * halfW) + 0.5, pz / length + 0.5);
  }
  g.computeVertexNormals();
  return g;
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Top view of folded wings: glossy reddish brown, amber edges, overlap seam, faint veins. Canvas top = front of the roach. */
function wingTexture(): CanvasTexture {
  return canvasTexture(256, 512, (ctx) => {
    const W = 256, H = 512;
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#a8642a');
    g.addColorStop(0.18, '#7a3a15');
    g.addColorStop(0.5, '#4f220b');
    g.addColorStop(0.82, '#7a3a15');
    g.addColorStop(1, '#a8642a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // Darker towards the front (under the pronotum), lighter tips at the back.
    const v = ctx.createLinearGradient(0, 0, 0, H);
    v.addColorStop(0, 'rgba(30,10,0,0.45)');
    v.addColorStop(0.4, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(190,110,50,0.35)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
    // Veins.
    ctx.strokeStyle = 'rgba(40,15,0,0.14)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 9; i++) {
      for (const side of [-1, 1]) {
        const x0 = W / 2 + side * (12 + i * 12);
        ctx.beginPath();
        ctx.moveTo(x0, H);
        ctx.quadraticCurveTo(x0 + side * 10, H * 0.5, W / 2 + side * (8 + i * 9), 10);
        ctx.stroke();
      }
    }
    // Overlap seam: right wing over left, slightly off-centre.
    ctx.strokeStyle = 'rgba(20,6,0,0.8)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(W / 2 + 6, H);
    ctx.quadraticCurveTo(W / 2 - 2, H * 0.45, W / 2 - 14, 0);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,200,140,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2 + 10, H);
    ctx.quadraticCurveTo(W / 2 + 2, H * 0.45, W / 2 - 10, 0);
    ctx.stroke();
  });
}

/** Pronotum shield: pale cream rim around a dark two-lobed centre (American cockroach marking). */
function pronotumTexture(): CanvasTexture {
  return canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#9c6c34';
    ctx.fillRect(0, 0, 256, 256);
    const g = ctx.createRadialGradient(128, 120, 10, 128, 120, 100);
    g.addColorStop(0, '#3a1607');
    g.addColorStop(0.75, '#5a260c');
    g.addColorStop(1, 'rgba(90,38,12,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(128, 122, 112, 100, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(25,8,0,0.7)';
    for (const dx of [-28, 28]) {
      ctx.beginPath();
      ctx.ellipse(128 + dx, 110, 26, 44, dx > 0 ? 0.3 : -0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function radialTexture(): CanvasTexture {
  return canvasTexture(64, 64, (ctx) => {
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
  });
}

function splatTexture(): CanvasTexture {
  return canvasTexture(128, 128, (ctx) => {
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
  });
}
