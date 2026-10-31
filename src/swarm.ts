import { Quaternion, Vector3 } from 'three';
import type { Surfel, SurfelMap } from './surfaces';

export type RoachMode = 'run' | 'pause' | 'flee';

export interface Roach {
  readonly id: number;
  readonly position: Vector3;
  /** Surface normal the roach currently stands on ("up" for the roach). */
  readonly normal: Vector3;
  /** Unit tangent the roach faces. Always perpendicular to `normal`. */
  readonly heading: Vector3;
  speed: number;
  targetSpeed: number;
  mode: RoachMode;
  modeTime: number;
  turnRate: number;
  /** Walking cycle phase in radians, drives the leg animation. */
  gait: number;
  /** Visual size, babies grow towards `adultScale`. */
  scale: number;
  adultScale: number;
  breedIn: number;
  /** 0..1, how happily the roach switches onto surfaces with a different normal (walls, cabinet sides). */
  climbiness: number;
  /** Distance walked without known surface below; bounded so roaches don't wander into thin air. */
  unsupported: number;
  /** Seconds since squashed, or -1 while alive. */
  squashed: number;
  antennaPhase: number;
}

export interface SwarmOptions {
  maxRoaches: number;
  /** Seconds between births per adult roach, randomised ±40 %. */
  breedInterval: number;
}

const UP = new Vector3(0, 1, 0);
const SUPPORT_RADIUS = 0.06;
const SEARCH_RADIUS = 0.12;
const MAX_UNSUPPORTED = 0.14;
const FLEE_DISTANCE = 0.3;
const SQUASH_LINGER = 10;

const rand = (a: number, b: number): number => a + Math.random() * (b - a);

/** Simulates every roach: wandering, surface following, fleeing the phone, breeding, squashing. */
export class Swarm {
  readonly roaches: Roach[] = [];
  breeding = true;
  private nextId = 1;
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpQ = new Quaternion();
  private readonly nearby: Surfel[] = [];

  /** Fires for births so audio/haptics can react. */
  onBirth?: (r: Roach) => void;

  constructor(
    private readonly map: SurfelMap,
    private readonly options: SwarmOptions,
  ) {}

  get aliveCount(): number {
    let n = 0;
    for (const r of this.roaches) if (r.squashed < 0) n++;
    return n;
  }

  spawn(position: Vector3, normal: Vector3, scale = rand(0.85, 1.15), heading?: Vector3): Roach | null {
    if (this.aliveCount >= this.options.maxRoaches) return null;
    const n = normal.clone().normalize();
    const h = heading ? heading.clone() : randomTangent(n);
    h.addScaledVector(n, -h.dot(n)).normalize();
    const roach: Roach = {
      id: this.nextId++,
      position: position.clone(),
      normal: n,
      heading: h,
      speed: 0,
      targetSpeed: rand(0.1, 0.3),
      mode: 'run',
      modeTime: rand(0.5, 2),
      turnRate: 0,
      gait: Math.random() * Math.PI * 2,
      scale: scale,
      adultScale: rand(0.85, 1.2),
      breedIn: this.nextBreedTime() * (scale < 0.8 ? 1.6 : 0.6),
      climbiness: Math.random(),
      unsupported: 0,
      squashed: -1,
      antennaPhase: Math.random() * 10,
    };
    this.roaches.push(roach);
    return roach;
  }

  /** Spawns a cluster that scatters from `center`, used for the first appearance and the "+" button. */
  burst(center: Vector3, normal: Vector3, count: number): number {
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      const offset = randomTangent(normal).multiplyScalar(rand(0, 0.05));
      const p = center.clone().add(offset);
      const r = this.spawn(p, normal, rand(0.8, 1.15), offset.lengthSq() > 0 ? offset : undefined);
      if (!r) break;
      r.targetSpeed = rand(0.25, 0.4);
      r.mode = 'run';
      r.modeTime = rand(0.6, 1.5);
      spawned++;
    }
    return spawned;
  }

  /** Squash the roach closest to the ray, if any is within `tolerance` metres of it. */
  squashAlongRay(origin: Vector3, dir: Vector3, tolerance = 0.03): Roach | null {
    let best: Roach | null = null;
    let bestT = Infinity;
    for (const r of this.roaches) {
      if (r.squashed >= 0) continue;
      const toRoach = this.tmpA.subVectors(r.position, origin);
      const t = toRoach.dot(dir);
      if (t < 0) continue;
      const closest = this.tmpB.copy(origin).addScaledVector(dir, t);
      const tol = tolerance + 0.015 * r.scale + t * 0.01; // easier to hit far away
      if (closest.distanceTo(r.position) < tol && t < bestT) {
        best = r;
        bestT = t;
      }
    }
    if (best) {
      best.squashed = 0;
      best.speed = 0;
    }
    return best;
  }

  update(dt: number, cameraPosition: Vector3): void {
    dt = Math.min(dt, 0.05);
    const births: Roach[] = [];

    for (let i = this.roaches.length - 1; i >= 0; i--) {
      const r = this.roaches[i];
      if (r.squashed >= 0) {
        r.squashed += dt;
        if (r.squashed > SQUASH_LINGER) this.roaches.splice(i, 1);
        continue;
      }
      this.think(r, dt, cameraPosition);
      this.move(r, dt);

      r.scale += (r.adultScale - r.scale) * Math.min(1, dt * 0.08);
      r.gait += r.speed * dt * 420; // ~13 steps per 10 cm, roaches are busy little legs
      r.antennaPhase += dt * (r.mode === 'pause' ? 3 : 7);

      if (this.breeding && r.scale > 0.75) {
        r.breedIn -= dt;
        if (r.breedIn <= 0) {
          r.breedIn = this.nextBreedTime();
          births.push(r);
        }
      }
    }

    for (const parent of births) {
      const behind = parent.heading.clone().multiplyScalar(-0.025);
      const side = this.tmpA.crossVectors(parent.normal, parent.heading).multiplyScalar(rand(-0.02, 0.02));
      const p = parent.position.clone().add(behind).add(side);
      const child = this.spawn(p, parent.normal, rand(0.45, 0.6));
      if (child) {
        child.targetSpeed = rand(0.25, 0.4);
        this.onBirth?.(child);
      }
    }
  }

  clear(): void {
    this.roaches.length = 0;
  }

  private nextBreedTime(): number {
    return this.options.breedInterval * rand(0.6, 1.4);
  }

  private think(r: Roach, dt: number, cam: Vector3): void {
    const away = this.tmpA.subVectors(r.position, cam);
    const dist = away.length();
    if (dist < FLEE_DISTANCE) {
      // Phone too close: dart away along the surface.
      away.addScaledVector(r.normal, -away.dot(r.normal));
      if (away.lengthSq() > 1e-6) {
        away.normalize();
        steerTowards(r, away, dt * 6);
      }
      if (r.mode !== 'flee') {
        r.mode = 'flee';
        r.modeTime = rand(0.8, 1.6);
      }
      r.targetSpeed = 0.45;
    }

    r.modeTime -= dt;
    if (r.modeTime <= 0) {
      const roll = Math.random();
      if (roll < 0.62) {
        r.mode = 'run';
        r.targetSpeed = rand(0.08, 0.32);
        r.modeTime = rand(0.4, 2.8);
      } else {
        r.mode = 'pause';
        r.targetSpeed = 0;
        r.modeTime = rand(0.2, 1.8);
      }
      if (Math.random() < 0.35) r.turnRate = rand(-6, 6); // sudden zig
    }

    if (r.mode !== 'pause') {
      r.turnRate += rand(-14, 14) * dt;
      r.turnRate *= 1 - Math.min(1, dt * 2.5);
      r.heading.applyAxisAngle(r.normal, r.turnRate * dt);
    }

    const accel = r.targetSpeed > r.speed ? 3.5 : 6;
    r.speed += (r.targetSpeed - r.speed) * Math.min(1, dt * accel);
  }

  private move(r: Roach, dt: number): void {
    if (r.speed < 1e-4) return;
    const next = this.tmpB.copy(r.position).addScaledVector(r.heading, r.speed * dt);
    const support = this.map.query(next, SUPPORT_RADIUS, this.nearby);

    if (support.length > 0) {
      r.unsupported = 0;
      // Prefer the surface we're on, unless this roach is in a climbing mood.
      const switchPenalty = 0.01 + (1 - r.climbiness) * 0.08;
      let best = support[0];
      let bestScore = Infinity;
      for (const s of support) {
        const score = s.position.distanceTo(next) + (1 - s.normal.dot(r.normal)) * switchPenalty;
        if (score < bestScore) {
          bestScore = score;
          best = s;
        }
      }
      // Average the plane over surfels agreeing with the best one to smooth out noise.
      const avgP = new Vector3();
      const avgN = new Vector3();
      let wSum = 0;
      for (const s of support) {
        if (s.normal.dot(best.normal) < 0.85) continue;
        const w = Math.min(s.hits, 8) / (s.position.distanceTo(next) + 0.01);
        avgP.addScaledVector(s.position, w);
        avgN.addScaledVector(s.normal, w);
        wSum += w;
      }
      avgP.divideScalar(wSum);
      avgN.normalize();

      const offPlane = next.clone().sub(avgP).dot(avgN);
      next.addScaledVector(avgN, -offPlane * Math.min(1, dt * 18));
      this.rotateOntoNormal(r, avgN, Math.min(1, dt * 14));
    } else {
      r.unsupported += r.speed * dt;
      const far = this.map.query(next, SEARCH_RADIUS, this.nearby);
      if (far.length > 0) {
        const target = this.tmpA.subVectors(far[(Math.random() * far.length) | 0].position, r.position);
        target.addScaledVector(r.normal, -target.dot(r.normal));
        if (target.lengthSq() > 1e-6) steerTowards(r, target.normalize(), dt * 10);
      }
      if (r.unsupported > MAX_UNSUPPORTED) {
        // Edge of the known world: turn back.
        r.heading.applyAxisAngle(r.normal, Math.PI + rand(-0.8, 0.8));
        r.unsupported = 0;
        return;
      }
    }
    r.position.copy(next);
  }

  /** Tilt the roach towards a new surface normal, carrying its heading over the edge. */
  private rotateOntoNormal(r: Roach, target: Vector3, t: number): void {
    const newNormal = this.tmpA.copy(r.normal).lerp(target, t).normalize();
    this.tmpQ.setFromUnitVectors(r.normal, newNormal);
    r.heading.applyQuaternion(this.tmpQ);
    r.normal.copy(newNormal);
    r.heading.addScaledVector(r.normal, -r.heading.dot(r.normal)).normalize();
  }
}

function steerTowards(r: Roach, dir: Vector3, t: number): void {
  r.heading.lerp(dir, Math.min(1, t));
  r.heading.addScaledVector(r.normal, -r.heading.dot(r.normal));
  if (r.heading.lengthSq() < 1e-6) r.heading.copy(randomTangent(r.normal));
  r.heading.normalize();
}

export function randomTangent(normal: Vector3): Vector3 {
  const ref = Math.abs(normal.dot(UP)) > 0.9 ? new Vector3(1, 0, 0) : UP;
  const t = new Vector3().crossVectors(normal, ref).normalize();
  return t.applyAxisAngle(normal, Math.random() * Math.PI * 2);
}
