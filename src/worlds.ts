import {
  BoxGeometry,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
  type Object3D,
} from 'three';
import type { SurfaceSample, SurfelMap } from './surfaces';

/** Feeds the surfel map from the environment and reports the surface under the screen centre. */
export interface World {
  /** Learn surfaces visible this frame; returns the hit straight ahead, if any. */
  scan(now: number, frame: XRFrame | null): SurfaceSample | null;
  /** Camera pose this frame, in world space. */
  cameraPose(frame: XRFrame | null, outPos: Vector3, outQuat: Quaternion): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// AR: WebXR hit tests (ARCore planes, horizontal and vertical).
// ---------------------------------------------------------------------------

const FAN_X = [-0.5, -0.25, 0, 0.25, 0.5];
const FAN_Y = [-0.8, -0.5, -0.25, 0, 0.25, 0.5];

export class ArWorld implements World {
  private readonly sources: XRHitTestSource[] = [];
  private center: XRHitTestSource | null = null;
  private readonly m = new Matrix4();
  private readonly p = new Vector3();
  private readonly n = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();

  private constructor(
    private readonly map: SurfelMap,
    private readonly getRefSpace: () => XRReferenceSpace | null,
  ) {}

  static async create(
    session: XRSession,
    map: SurfelMap,
    getRefSpace: () => XRReferenceSpace | null,
  ): Promise<ArWorld> {
    const world = new ArWorld(map, getRefSpace);
    const viewer = await session.requestReferenceSpace('viewer');
    const request = (x: number, y: number): Promise<XRHitTestSource | undefined> => {
      const offsetRay = new XRRay({ x: 0, y: 0, z: 0, w: 1 }, { x, y, z: -1, w: 0 });
      return session.requestHitTestSource?.({ space: viewer, offsetRay, entityTypes: ['plane'] }) ?? Promise.resolve(undefined);
    };
    world.center = (await request(0, 0)) ?? null;
    const fan = await Promise.allSettled(FAN_X.flatMap((x) => FAN_Y.map((y) => request(x, y))));
    for (const r of fan) if (r.status === 'fulfilled' && r.value) world.sources.push(r.value);
    return world;
  }

  scan(now: number, frame: XRFrame | null): SurfaceSample | null {
    const ref = this.getRefSpace();
    if (!frame || !ref) return null;
    for (const src of this.sources) {
      const hit = this.read(frame, src, ref);
      if (hit) this.map.addPatch(hit.position, hit.normal, now);
    }
    const c = this.center ? this.read(frame, this.center, ref) : null;
    if (c) this.map.addPatch(c.position, c.normal, now);
    return c ? { position: c.position.clone(), normal: c.normal.clone() } : null;
  }

  private read(frame: XRFrame, src: XRHitTestSource, ref: XRReferenceSpace): SurfaceSample | null {
    const results = frame.getHitTestResults(src);
    if (!results.length) return null;
    const pose = results[0].getPose(ref);
    if (!pose) return null;
    this.m.fromArray(pose.transform.matrix);
    this.m.decompose(this.p, this.q, this.s);
    // Hit pose Y axis is the surface normal.
    this.n.set(0, 1, 0).applyQuaternion(this.q).normalize();
    return { position: this.p, normal: this.n };
  }

  cameraPose(frame: XRFrame | null, outPos: Vector3, outQuat: Quaternion): void {
    const ref = this.getRefSpace();
    const pose = frame && ref ? frame.getViewerPose(ref) : null;
    if (!pose) return;
    const { position: p, orientation: o } = pose.transform;
    outPos.set(p.x, p.y, p.z);
    outQuat.set(o.x, o.y, o.z, o.w);
  }

  dispose(): void {
    for (const s of this.sources) s.cancel();
    this.center?.cancel();
    this.sources.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Demo: a little living room, scanned with raycasts the same way AR is.
// ---------------------------------------------------------------------------

export class DemoWorld implements World {
  readonly room = new Group();
  private readonly solids: Object3D[] = [];
  private readonly ray = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly n = new Vector3();

  constructor(
    private readonly map: SurfelMap,
    private readonly camera: PerspectiveCamera,
  ) {
    this.buildRoom();
  }

  private box(w: number, h: number, d: number, x: number, y: number, z: number, color: string): Mesh {
    const mesh = new Mesh(
      new BoxGeometry(w, h, d),
      new MeshStandardMaterial({ color: new Color(color), roughness: 0.85 }),
    );
    mesh.position.set(x, y, z);
    this.room.add(mesh);
    this.solids.push(mesh);
    return mesh;
  }

  private buildRoom(): void {
    // Floor, two walls.
    this.box(4, 0.02, 4, 0, -0.01, 0, '#a07a55');
    this.box(4, 2.6, 0.02, 0, 1.3, -2, '#e8e1d6');
    this.box(0.02, 2.6, 4, -2, 1.3, 0, '#ddd4c5');
    // Table with legs.
    this.box(1.2, 0.04, 0.7, 0.3, 0.74, -0.3, '#6b4a2e');
    for (const [x, z] of [
      [-0.25, -0.6],
      [0.85, -0.6],
      [-0.25, 0.0],
      [0.85, 0.0],
    ]) {
      this.box(0.05, 0.72, 0.05, x, 0.36, z, '#5a3d25');
    }
    // Schrankwand against the back wall.
    this.box(1.8, 2.0, 0.45, -0.9, 1.0, -1.77, '#c9b79c');
    // Low sideboard on the left wall.
    this.box(0.45, 0.6, 1.2, -1.77, 0.3, 0.6, '#8c6f52');
  }

  scan(now: number): SurfaceSample | null {
    for (let i = 0; i < 40; i++) {
      this.ndc.set(Math.random() * 1.8 - 0.9, Math.random() * 1.8 - 0.9);
      const hit = this.cast();
      if (hit) this.map.addPatch(hit.position, hit.normal, now);
    }
    this.ndc.set(0, 0);
    const c = this.cast();
    if (c) this.map.addPatch(c.position, c.normal, now);
    return c;
  }

  /** Surface under a screen point (NDC), used for taps. */
  castAt(ndcX: number, ndcY: number): SurfaceSample | null {
    this.ndc.set(ndcX, ndcY);
    return this.cast();
  }

  private cast(): SurfaceSample | null {
    this.ray.setFromCamera(this.ndc, this.camera);
    const hit = this.ray.intersectObjects(this.solids, false)[0];
    if (!hit?.face) return null;
    this.n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
    return { position: hit.point.clone(), normal: this.n.clone() };
  }

  cameraPose(_frame: XRFrame | null, outPos: Vector3, outQuat: Quaternion): void {
    outPos.copy(this.camera.position);
    outQuat.copy(this.camera.quaternion);
  }

  dispose(): void {
    this.room.removeFromParent();
  }
}
