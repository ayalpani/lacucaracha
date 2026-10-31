import { Vector3 } from 'three';
import type { Roach } from './swarm';

const VOICES = 4;

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: PannerNode;
  roachId: number;
}

/**
 * All sounds are synthesised at runtime (no audio files):
 * spatial skittering per nearby roach, a swarm bed that grows with the
 * population, hisses, and a crunchy squash.
 */
export class RoachAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private bed!: GainNode;
  private scuttle!: AudioBuffer;
  private noise!: AudioBuffer;
  private voices: Voice[] = [];
  private muted = false;
  private nextHiss = 3;
  private readonly tmp = new Vector3();

  /** Must be called from a user gesture (browser autoplay rules). */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    this.master.connect(comp).connect(ctx.destination);

    this.scuttle = makeScuttleBuffer(ctx);
    this.noise = makeNoiseBuffer(ctx, 1);

    for (let i = 0; i < VOICES; i++) {
      const source = ctx.createBufferSource();
      source.buffer = this.scuttle;
      source.loop = true;
      source.playbackRate.value = 0.85 + Math.random() * 0.35;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 2600 + Math.random() * 1500;
      filter.Q.value = 0.5;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const panner = this.makePanner();
      source.connect(filter).connect(gain).connect(panner).connect(this.master);
      source.start(0, Math.random() * this.scuttle.duration);
      this.voices.push({ source, gain, panner, roachId: -1 });
    }

    // Non-spatial "many legs everywhere" bed.
    const bedSrc = ctx.createBufferSource();
    bedSrc.buffer = this.scuttle;
    bedSrc.loop = true;
    bedSrc.playbackRate.value = 1.3;
    const bedFilter = ctx.createBiquadFilter();
    bedFilter.type = 'highpass';
    bedFilter.frequency.value = 2500;
    this.bed = ctx.createGain();
    this.bed.gain.value = 0;
    bedSrc.connect(bedFilter).connect(this.bed).connect(this.master);
    bedSrc.start();
  }

  stop(): void {
    void this.ctx?.suspend();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  private makePanner(): PannerNode {
    const p = this.ctx!.createPanner();
    // Equal-power instead of HRTF: HRTF convolution crackles on mid-range phones while ARCore runs.
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 0.25;
    p.rolloffFactor = 1.6;
    p.maxDistance = 20;
    return p;
  }

  /** Call once per frame with the camera pose. */
  update(dt: number, roaches: readonly Roach[], camPos: Vector3, camForward: Vector3, camUp: Vector3): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.setTargetAtTime(camPos.x, t, 0.02);
      l.positionY.setTargetAtTime(camPos.y, t, 0.02);
      l.positionZ.setTargetAtTime(camPos.z, t, 0.02);
      l.forwardX.setTargetAtTime(camForward.x, t, 0.02);
      l.forwardY.setTargetAtTime(camForward.y, t, 0.02);
      l.forwardZ.setTargetAtTime(camForward.z, t, 0.02);
      l.upX.setTargetAtTime(camUp.x, t, 0.02);
      l.upY.setTargetAtTime(camUp.y, t, 0.02);
      l.upZ.setTargetAtTime(camUp.z, t, 0.02);
    } else {
      l.setPosition(camPos.x, camPos.y, camPos.z);
      l.setOrientation(camForward.x, camForward.y, camForward.z, camUp.x, camUp.y, camUp.z);
    }

    // Give the voices to the nearest moving roaches.
    const alive = roaches.filter((r) => r.squashed < 0);
    const nearest = alive
      .map((r) => ({ r, d: r.position.distanceToSquared(camPos) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, VOICES);

    this.voices.forEach((v, i) => {
      const entry = nearest[i];
      if (!entry) {
        v.gain.gain.setTargetAtTime(0, t, 0.08);
        v.roachId = -1;
        return;
      }
      const r = entry.r;
      v.roachId = r.id;
      v.panner.positionX.setTargetAtTime(r.position.x, t, 0.03);
      v.panner.positionY.setTargetAtTime(r.position.y, t, 0.03);
      v.panner.positionZ.setTargetAtTime(r.position.z, t, 0.03);
      const level = Math.min(1, r.speed / 0.25) * (0.5 + r.scale * 0.5);
      v.gain.gain.setTargetAtTime(level * 0.5, t, 0.06);
      
    });

    // Swarm bed grows with the population.
    const bedLevel = alive.length <= 6 ? 0 : Math.min(0.25, Math.log10(alive.length / 6) * 0.18);
    this.bed.gain.setTargetAtTime(bedLevel, t, 0.5);

    // Occasional hiss from a nearby roach.
    this.nextHiss -= dt;
    if (this.nextHiss <= 0 && nearest.length) {
      this.nextHiss = 2 + Math.random() * 6 / Math.max(1, Math.sqrt(alive.length / 4));
      const pick = nearest[(Math.random() * Math.min(3, nearest.length)) | 0].r;
      this.hiss(pick.position);
    }
  }

  hiss(at: Vector3): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.9 + Math.random() * 0.3;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 5200 + Math.random() * 2500;
    hp.Q.value = 1.4;
    const g = ctx.createGain();
    const dur = 0.25 + Math.random() * 0.45;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.04);
    // Two puffs, like a hissing roach pushing air through its spiracles.
    g.gain.linearRampToValueAtTime(0.06, t + dur * 0.45);
    g.gain.linearRampToValueAtTime(0.15, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const p = this.makePanner();
    this.place(p, at);
    src.connect(hp).connect(g).connect(p).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  squish(at: Vector3): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const p = this.makePanner();
    p.refDistance = 0.5;
    this.place(p, at);
    p.connect(this.master);

    // Crunch: a few sharp cracks.
    for (let i = 0; i < 4; i++) {
      const s = ctx.createBufferSource();
      s.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1800 + Math.random() * 2500;
      f.Q.value = 2;
      const g = ctx.createGain();
      const start = t + i * (0.012 + Math.random() * 0.02);
      g.gain.setValueAtTime(0.9, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.03);
      s.connect(f).connect(g).connect(p);
      s.start(start, Math.random() * 0.8);
      s.stop(start + 0.04);
    }
    // Squelch: wet low thud with a falling pitch.
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1400, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.22);
    lp.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1.2, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    s.connect(lp).connect(g).connect(p);
    s.start(t);
    s.stop(t + 0.3);
  }

  private place(p: PannerNode, at: Vector3): void {
    this.tmp.copy(at);
    p.positionX.value = this.tmp.x;
    p.positionY.value = this.tmp.y;
    p.positionZ.value = this.tmp.z;
  }
}

function makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Loopable bed of tiny, irregular leg clicks plus a faint rustle. */
function makeScuttleBuffer(ctx: AudioContext): AudioBuffer {
  const seconds = 2;
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, sr * seconds, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.02; // rustle
  let t = 0;
  while (t < seconds) {
    // Clicks come in little bursts (tripod steps), ~45 per second overall.
    const burst = 1 + ((Math.random() * 3) | 0);
    for (let k = 0; k < burst; k++) {
      const start = Math.floor((t + k * 0.004) * sr);
      const len = Math.floor(sr * (0.0008 + Math.random() * 0.0015));
      const amp = 0.15 + Math.random() * 0.35;
      for (let j = 0; j < len && start + j < d.length; j++) {
        d[start + j] += (Math.random() * 2 - 1) * amp * Math.exp((-j / len) * 5);
      }
    }
    t += 0.012 + Math.random() * 0.04;
  }
  // Crossfade the ends so the loop has no click seam.
  const fade = Math.floor(sr * 0.02);
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    d[i] = d[i] * w + d[d.length - fade + i] * (1 - w);
  }
  return buf;
}
