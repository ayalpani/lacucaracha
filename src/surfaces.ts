import { Vector3 } from 'three';

/** A small oriented patch of real-world surface, learned from hit tests. */
export interface Surfel {
  readonly position: Vector3;
  readonly normal: Vector3;
  /** Seconds (scene clock) when this surfel was last confirmed. */
  seen: number;
  /** How many hits were averaged into it; more = more trustworthy. */
  hits: number;
}

export interface SurfaceSample {
  position: Vector3;
  normal: Vector3;
}

const CELL = 0.04; // 4 cm voxels
const MAX_SURFELS = 30000;
const X_AXIS = new Vector3(1, 0, 0);
const Y_AXIS = new Vector3(0, 1, 0);
const RING: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.7, 0.7],
  [-0.7, 0.7],
  [0.7, -0.7],
  [-0.7, -0.7],
];
const tmpT1 = new Vector3();
const tmpT2 = new Vector3();
const tmpP = new Vector3();

/**
 * Sparse voxel hash of surfels. Both AR (WebXR hit tests) and the demo room
 * (three.js raycasts) feed it, so roach locomotion is identical in both modes.
 */
export class SurfelMap {
  private readonly cells = new Map<number, Surfel[]>();
  private count = 0;

  get size(): number {
    return this.count;
  }

  /** Numeric cell key (no string garbage in the hot path); covers ±40 m around the origin. */
  private key(ix: number, iy: number, iz: number): number {
    return ((ix + 1024) * 2048 + (iy + 1024)) * 2048 + (iz + 1024);
  }

  private cellOf(p: Vector3): [number, number, number] {
    return [Math.floor(p.x / CELL), Math.floor(p.y / CELL), Math.floor(p.z / CELL)];
  }

  /** Merge a hit into the map; surfels in one cell with similar normals are averaged. */
  add(position: Vector3, normal: Vector3, now: number): void {
    const [ix, iy, iz] = this.cellOf(position);
    const k = this.key(ix, iy, iz);
    let list = this.cells.get(k);
    if (!list) {
      list = [];
      this.cells.set(k, list);
    }
    for (const s of list) {
      if (s.normal.dot(normal) > 0.8) {
        const w = 1 / Math.min(s.hits + 1, 12);
        s.position.lerp(position, w);
        s.normal.lerp(normal, w).normalize();
        s.hits++;
        s.seen = now;
        return;
      }
    }
    if (this.count >= MAX_SURFELS || list.length >= 3) return;
    list.push({ position: position.clone(), normal: normal.clone().normalize(), seen: now, hits: 1 });
    this.count++;
  }

  /**
   * Add a hit plus a small ring around it on the same plane. Hit tests are sparse,
   * so this densifies the map enough for roaches to find footing between samples.
   */
  addPatch(position: Vector3, normal: Vector3, now: number, radius = CELL): void {
    this.add(position, normal, now);
    const t1 = tmpT1.crossVectors(normal, Math.abs(normal.y) > 0.9 ? X_AXIS : Y_AXIS).normalize();
    const t2 = tmpT2.crossVectors(normal, t1);
    for (const [a, b] of RING) {
      tmpP.copy(position).addScaledVector(t1, a * radius).addScaledVector(t2, b * radius);
      this.add(tmpP, normal, now);
    }
  }

  /** All surfels within `radius` of `p` (radius should be <= 2 * CELL for speed). */
  query(p: Vector3, radius: number, out: Surfel[] = []): Surfel[] {
    out.length = 0;
    const r2 = radius * radius;
    const span = Math.ceil(radius / CELL);
    const [cx, cy, cz] = this.cellOf(p);
    for (let x = cx - span; x <= cx + span; x++) {
      for (let y = cy - span; y <= cy + span; y++) {
        for (let z = cz - span; z <= cz + span; z++) {
          const list = this.cells.get(this.key(x, y, z));
          if (!list) continue;
          for (const s of list) {
            if (s.position.distanceToSquared(p) <= r2) out.push(s);
          }
        }
      }
    }
    return out;
  }

  /** A random surfel, optionally restricted to those near `near`. */
  random(near?: Vector3, radius = 0.5): Surfel | null {
    if (near) {
      const candidates = this.query(near, Math.min(radius, CELL * 6));
      if (candidates.length) return candidates[(Math.random() * candidates.length) | 0];
    }
    if (this.count === 0) return null;
    // Reservoir sample over cells; fine for occasional calls.
    let chosen: Surfel | null = null;
    let seenN = 0;
    for (const list of this.cells.values()) {
      for (const s of list) {
        seenN++;
        if (Math.random() * seenN < 1) chosen = s;
      }
    }
    return chosen;
  }

  clear(): void {
    this.cells.clear();
    this.count = 0;
  }
}
