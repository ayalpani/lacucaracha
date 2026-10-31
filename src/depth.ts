import { DataTexture, FloatType, Matrix4, NearestFilter, RedFormat, Vector3 } from 'three';
import type { SurfelMap } from './surfaces';

/**
 * Turns the ARCore depth map (WebXR depth-sensing, CPU path) into
 *  1. surfels for arbitrary shapes (chair legs, sofa, plant pot …), not just planes, and
 *  2. a depth texture so roaches behind real objects are hidden (occlusion).
 *
 * The depth map is small (~160×90) and noisy; we sample a grid, reject
 * depth discontinuities and let the surfel map average repeated observations.
 */
export class DepthScanner {
  /** Metric depth along the view axis, in the depth buffer's own layout. */
  texture: DataTexture | null = null;
  /** Maps normalized view coords (0..1, y down) to depth buffer UVs. */
  readonly uvTransform = new Matrix4();
  active = false;
  samplesLastScan = 0;

  private frameNo = 0;
  private floatData: Float32Array | null = null;
  private readonly viewMatrix = new Matrix4();
  private readonly camPos = new Vector3();
  private readonly toCam = new Vector3();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly n = new Vector3();
  private grid: Float32Array = new Float32Array(0); // xyz per grid cell, NaN = invalid
  private depths: Float32Array = new Float32Array(0);

  constructor(
    private readonly gridW = 48,
    private readonly gridH = 64,
  ) {}

  update(frame: XRFrame, ref: XRReferenceSpace, map: SurfelMap, now: number): void {
    const pose = frame.getViewerPose(ref);
    const view = pose?.views[0];
    if (!view) return;
    let info: XRCPUDepthInformation | null | undefined;
    try {
      info = frame.getDepthInformation?.(view);
    } catch {
      info = null; // depth not ready / not granted
    }
    if (!info || !info.width) {
      this.active = false;
      return;
    }
    this.active = true;
    this.uvTransform.fromArray(info.normDepthBufferFromNormView.matrix);
    this.updateTexture(info);

    // Surfels: every 3rd frame is plenty, the map accumulates.
    if (this.frameNo++ % 3 === 0) this.sampleSurfels(info, view, map, now);
  }

  private updateTexture(info: XRCPUDepthInformation): void {
    const { width, height } = info;
    const count = width * height;
    if (!this.floatData || this.floatData.length !== count) {
      this.floatData = new Float32Array(count);
      this.texture?.dispose();
      this.texture = new DataTexture(this.floatData, width, height, RedFormat, FloatType);
      this.texture.magFilter = NearestFilter;
      this.texture.minFilter = NearestFilter;
      this.texture.flipY = false;
    }
    const scale = info.rawValueToMeters;
    const out = this.floatData;
    if (info.data.byteLength >= count * 4) {
      const src = new Float32Array(info.data, 0, count);
      for (let i = 0; i < count; i++) out[i] = src[i] * scale;
    } else {
      const src = new Uint16Array(info.data, 0, count);
      for (let i = 0; i < count; i++) out[i] = src[i] * scale;
    }
    this.texture!.needsUpdate = true;
  }

  private sampleSurfels(info: XRCPUDepthInformation, view: XRView, map: SurfelMap, now: number): void {
    const W = this.gridW;
    const H = this.gridH;
    if (this.grid.length !== W * H * 3) {
      this.grid = new Float32Array(W * H * 3);
      this.depths = new Float32Array(W * H);
    }
    const P = view.projectionMatrix;
    this.viewMatrix.fromArray(view.transform.matrix);
    this.camPos.setFromMatrixPosition(this.viewMatrix);
    const e = this.viewMatrix.elements;

    for (let gy = 0; gy < H; gy++) {
      for (let gx = 0; gx < W; gx++) {
        const i = gy * W + gx;
        const u = (gx + 0.5) / W;
        const v = (gy + 0.5) / H;
        let d = 0;
        try {
          d = info.getDepthInMeters(u, v);
        } catch {
          d = 0;
        }
        this.depths[i] = d;
        if (!(d > 0.15 && d < 3.5)) {
          this.grid[i * 3] = NaN;
          continue;
        }
        // Unproject normalized view coords + view-axis depth into view space, then world.
        const ndcX = u * 2 - 1;
        const ndcY = 1 - v * 2;
        const x = ((ndcX + P[8]) * d) / P[0];
        const y = ((ndcY + P[9]) * d) / P[5];
        const z = -d;
        this.grid[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
        this.grid[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        this.grid[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
    }

    let added = 0;
    for (let gy = 1; gy < H - 1; gy++) {
      for (let gx = 1; gx < W - 1; gx++) {
        const i = gy * W + gx;
        if (Number.isNaN(this.grid[i * 3])) continue;
        const d = this.depths[i];
        const l = i - 1, r = i + 1, t = i - W, btm = i + W;
        if ([l, r, t, btm].some((k) => Number.isNaN(this.grid[k * 3]) || Math.abs(this.depths[k] - d) > d * 0.06)) {
          continue; // object boundary: no reliable normal here
        }
        this.a.set(this.grid[r * 3] - this.grid[l * 3], this.grid[r * 3 + 1] - this.grid[l * 3 + 1], this.grid[r * 3 + 2] - this.grid[l * 3 + 2]);
        this.b.set(this.grid[btm * 3] - this.grid[t * 3], this.grid[btm * 3 + 1] - this.grid[t * 3 + 1], this.grid[btm * 3 + 2] - this.grid[t * 3 + 2]);
        this.n.crossVectors(this.a, this.b);
        if (this.n.lengthSq() < 1e-10) continue;
        this.n.normalize();
        const p = this.a.set(this.grid[i * 3], this.grid[i * 3 + 1], this.grid[i * 3 + 2]);
        this.toCam.subVectors(this.camPos, p);
        if (this.n.dot(this.toCam) < 0) this.n.negate();
        // Grazing angles give garbage normals.
        if (this.n.dot(this.toCam.normalize()) < 0.25) continue;
        map.add(p, this.n, now);
        added++;
      }
    }
    this.samplesLastScan = added;
  }
}
