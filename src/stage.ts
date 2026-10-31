/**
 * Stage: a non-AR viewer to inspect the roach from every side in each behaviour state.
 * The roach stands still at the origin and the ground scrolls underneath it (treadmill),
 * so the camera can orbit freely while it "walks". Shows the procedural model used in
 * the AR app, or a loaded GLB (file picker, ?model=URL, or ./models/roach.glb if present).
 */
import {
  AmbientLight,
  AnimationMixer,
  Box3,
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  MathUtils,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type AnimationAction,
  type AnimationClip,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoachRenderer } from './roachRenderer';
import type { Roach, RoachMode } from './swarm';
import './style.css';
import './stage.css';

// --- states ----------------------------------------------------------------

type StateId = 'idle' | 'sneak' | 'walk' | 'flee' | 'turn' | 'climb' | 'squash' | 'auto';
type SurfaceId = 'floor' | 'wall';

interface StateDef {
  id: StateId;
  label: string;
  /** m/s; same units as the swarm simulation. */
  speed: number;
  /** rad/s around the surface normal. */
  turn: number;
  surface: SurfaceId;
  mode: RoachMode;
  /** Substrings tried in order to find a matching GLB animation clip. */
  clipHints: string[];
}

const STATES: StateDef[] = [
  { id: 'idle', label: 'Warten', speed: 0, turn: 0, surface: 'floor', mode: 'pause', clipHints: ['idle', 'wait', 'rest', 'stand'] },
  { id: 'sneak', label: 'Schleichen', speed: 0.07, turn: 0, surface: 'floor', mode: 'run', clipHints: ['sneak', 'walk', 'crawl'] },
  { id: 'walk', label: 'Laufen', speed: 0.18, turn: 0, surface: 'floor', mode: 'run', clipHints: ['walk', 'crawl'] },
  { id: 'flee', label: 'Flucht', speed: 0.45, turn: 0, surface: 'floor', mode: 'flee', clipHints: ['run', 'flee', 'sprint', 'walk'] },
  { id: 'turn', label: 'Drehen', speed: 0.06, turn: 2.6, surface: 'floor', mode: 'run', clipHints: ['turn', 'walk'] },
  { id: 'climb', label: 'Klettern', speed: 0.12, turn: 0, surface: 'wall', mode: 'run', clipHints: ['climb', 'walk'] },
  { id: 'squash', label: 'Zerquetscht', speed: 0, turn: 0, surface: 'floor', mode: 'pause', clipHints: ['squash', 'death', 'die', 'dead'] },
  { id: 'auto', label: 'Wie in der App', speed: 0, turn: 0, surface: 'floor', mode: 'run', clipHints: [] },
];
const stateById = new Map(STATES.map((s) => [s.id, s]));

/** States the "like in the app" mode switches between, with the swarm's own speed ranges. */
const AUTO_STEPS: { state: StateId; speed: [number, number]; time: [number, number] }[] = [
  { state: 'walk', speed: [0.06, 0.22], time: [0.4, 2.8] },
  { state: 'flee', speed: [0.3, 0.5], time: [0.4, 1.6] },
  { state: 'idle', speed: [0, 0], time: [0.2, 1.8] },
];

const SQUASH_LOOP = 4;
const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const UP = new Vector3(0, 1, 0);

// --- renderer / scene --------------------------------------------------------

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = SRGBColorSpace;

const BG = new Color('#1b130d');
const scene = new Scene();
scene.background = BG;
scene.fog = new Fog(BG, 0.22, 0.55);

const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
pmrem.dispose();

const sun = new DirectionalLight(0xffffff, 1.3);
sun.position.set(0.5, 2, 0.8);
scene.add(new HemisphereLight(0xfff4e6, 0x3a2a1c, 1.0), sun, new AmbientLight(0xffffff, 0.25));

const camera = new PerspectiveCamera(40, 1, 0.002, 5);
camera.position.set(0.07, 0.05, 0.09);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.025;
controls.maxDistance = 0.45;
controls.enablePan = false;
controls.autoRotateSpeed = 2.5;

// --- surfaces (treadmill) ---------------------------------------------------

const SURFACE_SIZE = 0.8;
const TILE_WORLD = 0.1; // one texture repeat = 10 cm (2×2 tiles of 5 cm)

interface Surface {
  mesh: Mesh;
  tex: CanvasTexture;
  normal: Vector3;
  /** World directions of the texture's u and v axes, for scrolling. */
  uAxis: Vector3;
  vAxis: Vector3;
}

function makeSurface(draw: (ctx: CanvasRenderingContext2D, s: number) => void, normal: Vector3, vAxis: Vector3): Surface {
  const tex = canvasTexture(512, (ctx) => draw(ctx, 512));
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(SURFACE_SIZE / TILE_WORLD, SURFACE_SIZE / TILE_WORLD);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const geo = new PlaneGeometry(SURFACE_SIZE, SURFACE_SIZE);
  if (normal.y > 0.5) geo.rotateX(-Math.PI / 2);
  // FrontSide only: looking from underneath, the surface vanishes and you see the belly.
  const mesh = new Mesh(geo, new MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 }));
  mesh.renderOrder = -2;
  scene.add(mesh);
  return { mesh, tex, normal, uAxis: new Vector3(1, 0, 0), vAxis };
}

const floor = makeSurface(drawTiles, new Vector3(0, 1, 0), new Vector3(0, 0, -1));
const wall = makeSurface(drawPlaster, new Vector3(0, 0, 1), new Vector3(0, 1, 0));
const surfaces: Record<SurfaceId, Surface> = { floor, wall };

// --- the one roach ------------------------------------------------------------

const roach: Roach = {
  id: 1,
  position: new Vector3(),
  normal: new Vector3(0, 1, 0),
  heading: new Vector3(0, 0, 1),
  speed: 0,
  targetSpeed: 0,
  mode: 'run',
  modeTime: 0,
  turnRate: 0,
  gait: 0,
  scale: 1,
  adultScale: 1,
  breedIn: Infinity,
  climbiness: 0,
  unsupported: 0,
  squashed: -1,
  antennaPhase: 0,
};

// --- models -----------------------------------------------------------------

interface StageModel {
  readonly label: string;
  readonly object: Object3D;
  update(r: Roach, state: StateDef, dt: number): void;
}

class ProceduralModel implements StageModel {
  readonly label = 'Prozedural';
  private readonly view = new RoachRenderer(1);
  readonly object = this.view.group;
  update(r: Roach): void {
    this.view.update([r]);
  }
}

/** Target body length for GLBs whose size isn't plausible in metres. */
const GLB_LENGTH = 0.045;

class GlbModel implements StageModel {
  readonly object = new Group();
  private readonly mixer: AnimationMixer;
  private current: AnimationAction | null = null;
  private currentState: StateId | null = null;
  private readonly basis = new Matrix4();
  private readonly right = new Vector3();

  constructor(
    readonly label: string,
    root: Object3D,
    private readonly clips: AnimationClip[],
  ) {
    // Normalise: glTF faces +Z with +Y up. Feet on y=0, centred on the origin.
    const box = new Box3().setFromObject(root);
    const size = box.getSize(new Vector3());
    const length = Math.max(size.x, size.z);
    const scale = length > 0.015 && length < 0.12 ? 1 : GLB_LENGTH / (length || 1);
    root.scale.multiplyScalar(scale);
    box.setFromObject(root);
    const c = box.getCenter(new Vector3());
    root.position.sub(new Vector3(c.x, box.min.y, c.z));
    this.object.add(root);
    this.object.matrixAutoUpdate = false;
    this.mixer = new AnimationMixer(root);
  }

  update(r: Roach, state: StateDef, dt: number): void {
    this.right.crossVectors(r.normal, r.heading).normalize();
    this.basis.makeBasis(this.right, r.normal, r.heading).setPosition(r.position);
    const s = r.scale;
    this.object.matrix.copy(this.basis).scale(new Vector3(s, s, s));
    this.object.matrixWorldNeedsUpdate = true;

    if (state.id !== this.currentState) {
      this.currentState = state.id;
      const clip = pickClip(this.clips, state.clipHints);
      if (clip !== this.current?.getClip()) {
        const next = clip ? this.mixer.clipAction(clip) : null;
        next?.reset().play();
        if (this.current && next) this.current.crossFadeTo(next, 0.2, false);
        else this.current?.stop();
        this.current = next;
      }
    }
    if (this.current) {
      // Locomotion clips play faster the faster the roach goes; others at normal speed.
      const loco = r.speed > 0.001 && state.speed > 0;
      this.current.timeScale = loco ? MathUtils.clamp(r.speed / 0.18, 0.3, 3) : 1;
    }
    this.mixer.update(dt);
  }
}

function pickClip(clips: AnimationClip[], hints: string[]): AnimationClip | null {
  for (const h of hints) {
    const c = clips.find((clip) => clip.name.toLowerCase().includes(h));
    if (c) return c;
  }
  return clips[0] ?? null;
}

const models: StageModel[] = [new ProceduralModel()];
let model: StageModel = models[0];
scene.add(model.object);

function setModel(m: StageModel): void {
  scene.remove(model.object);
  model = m;
  scene.add(m.object);
  ui.model.textContent = `Modell: ${m.label}`;
}

const loader = new GLTFLoader();
async function loadGlb(url: string, label: string, quiet = false): Promise<void> {
  try {
    const gltf = await loader.loadAsync(url);
    const m = new GlbModel(label, gltf.scene, gltf.animations);
    models.push(m);
    setModel(m);
    const names = gltf.animations.map((a) => a.name).join(', ');
    flash(names ? `${label}: Animationen ${names}` : `${label}: keine Animationen`);
  } catch (err) {
    if (!quiet) flash(`GLB konnte nicht geladen werden: ${(err as Error).message}`);
  }
}

// --- UI ----------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const ui = {
  states: $('states'),
  views: $('views'),
  info: $('info'),
  speed: $<HTMLInputElement>('speed'),
  speedVal: $('speed-val'),
  size: $<HTMLInputElement>('size'),
  sizeVal: $('size-val'),
  spin: $('t-spin'),
  ground: $('t-ground'),
  model: $('t-model'),
  file: $<HTMLInputElement>('glb-file'),
  panel: $('panel'),
  panelToggle: $('panel-toggle'),
};

const params = new URLSearchParams(location.search);
let state: StateDef = stateById.get(params.get('state') as StateId) ?? stateById.get('walk')!;
/** The concrete state currently animated (differs from `state` only in auto mode). */
let active: StateDef = state;
let autoTime = 0;
let tempo = 1;
let showGround = true;

for (const s of STATES) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = s.label;
  b.dataset.id = s.id;
  b.setAttribute('role', 'radio');
  b.addEventListener('click', () => selectState(s));
  ui.states.append(b);
}

type ViewId = 'angle' | 'top' | 'side' | 'front' | 'back' | 'bottom';
const VIEWS: { id: ViewId; label: string }[] = [
  { id: 'angle', label: 'Schräg' },
  { id: 'top', label: 'Oben' },
  { id: 'side', label: 'Seite' },
  { id: 'front', label: 'Vorne' },
  { id: 'back', label: 'Hinten' },
  { id: 'bottom', label: 'Unten' },
];
for (const v of VIEWS) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = v.label;
  b.addEventListener('click', () => goToView(v.id));
  ui.views.append(b);
}

ui.speed.addEventListener('input', () => {
  tempo = Number(ui.speed.value);
  ui.speedVal.textContent = tempo >= 0.999 ? '1×' : `${tempo.toFixed(2).replace(/0$/, '')}× Zeitlupe`;
});
ui.size.addEventListener('input', () => {
  const v = Number(ui.size.value);
  roach.scale = roach.adultScale = v;
  ui.sizeVal.textContent = v < 0.7 ? 'Baby' : v > 1.05 ? 'Groß' : 'Erwachsen';
});
ui.spin.addEventListener('click', () => {
  controls.autoRotate = !controls.autoRotate;
  ui.spin.setAttribute('aria-pressed', String(controls.autoRotate));
});
ui.ground.addEventListener('click', () => {
  showGround = !showGround;
  ui.ground.setAttribute('aria-pressed', String(showGround));
  updateSurfaces();
});
ui.model.addEventListener('click', () => {
  if (models.length === 1) {
    ui.file.click();
    return;
  }
  setModel(models[(models.indexOf(model) + 1) % models.length]);
});
ui.file.addEventListener('change', () => {
  const f = ui.file.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  void loadGlb(url, f.name.replace(/\.(glb|gltf)$/i, '')).finally(() => URL.revokeObjectURL(url));
  ui.file.value = '';
});
ui.panelToggle.addEventListener('click', () => {
  const hidden = ui.panel.classList.toggle('collapsed');
  ui.panelToggle.textContent = hidden ? '▴' : '▾';
  resize();
});

let flashTimer = 0;
function flash(text: string): void {
  ui.info.textContent = text;
  ui.info.classList.add('flash');
  flashTimer = 3;
}

function selectState(s: StateDef): void {
  const prevSurface = active.surface;
  state = s;
  for (const b of ui.states.querySelectorAll<HTMLButtonElement>('.chip')) {
    b.setAttribute('aria-checked', String(b.dataset.id === s.id));
  }
  autoTime = 0;
  applyActive(s.id === 'auto' ? stateById.get('walk')! : s);
  if (s.id === 'squash') roach.squashed = 0;
  if (active.surface !== prevSurface) {
    // Keep the camera's view relative to the roach when it moves onto the wall.
    const from = surfaces[prevSurface].normal;
    const to = surfaces[active.surface].normal;
    const off = camera.position.clone().sub(controls.target);
    off.applyQuaternion(new Quaternion().setFromUnitVectors(from, to));
    if (active.surface === 'floor' && off.y < 0.01) off.y = Math.abs(off.y) + 0.02;
    camera.position.copy(controls.target).add(off);
  }
  const q = new URLSearchParams(location.search);
  q.set('state', s.id);
  history.replaceState(null, '', `?${q}`);
}

function applyActive(s: StateDef, speed = s.speed): void {
  active = s;
  roach.mode = s.mode;
  roach.targetSpeed = speed;
  roach.turnRate = s.turn;
  if (s.id !== 'squash') roach.squashed = -1;
  const surface = surfaces[s.surface];
  roach.normal.copy(surface.normal);
  if (Math.abs(roach.heading.dot(roach.normal)) > 0.5 || s.surface === 'wall') {
    // Floor: face +Z. Wall: climb straight up.
    roach.heading.copy(s.surface === 'wall' ? UP : new Vector3(0, 0, 1));
  }
  updateSurfaces();
  updateInfo();
}

function updateSurfaces(): void {
  floor.mesh.visible = showGround && active.surface === 'floor';
  wall.mesh.visible = showGround && active.surface === 'wall';
}

function updateInfo(): void {
  if (flashTimer > 0) return;
  ui.info.classList.remove('flash');
  const auto = state.id === 'auto' ? `Auto · ${active.label}` : active.label;
  const cms = roach.speed * 100;
  ui.info.textContent = cms > 0.5 ? `${auto} · ${cms.toFixed(0)} cm/s` : auto;
}

// --- camera views ---------------------------------------------------------------

let camAnim: { from: Vector3; to: Vector3; dist: number; t: number } | null = null;

function goToView(id: ViewId): void {
  const n = roach.normal.clone();
  const h = roach.heading.clone();
  const r = new Vector3().crossVectors(n, h).normalize(); // roach's left
  const dir = new Vector3();
  switch (id) {
    case 'angle': dir.copy(h).multiplyScalar(0.7).addScaledVector(r, -0.6).addScaledVector(n, 0.55); break;
    case 'top': dir.copy(n).addScaledVector(h, -0.02); break;
    case 'side': dir.copy(r).multiplyScalar(-1).addScaledVector(n, 0.18); break;
    case 'front': dir.copy(h).addScaledVector(n, 0.12); break;
    case 'back': dir.copy(h).multiplyScalar(-1).addScaledVector(n, 0.15); break;
    case 'bottom': dir.copy(n).multiplyScalar(-1).addScaledVector(h, -0.02); break;
  }
  dir.normalize();
  // Orbit controls can't sit exactly on the up axis.
  if (Math.abs(dir.y) > 0.995) dir.x += 0.01;
  const dist = fitDistance();
  camAnim = { from: camera.position.clone().sub(controls.target).normalize(), to: dir.normalize(), dist, t: 0 };
}

/** Distance at which the whole roach incl. antennae (~6 cm) fits the narrower screen side. */
function fitDistance(): number {
  const halfV = MathUtils.degToRad(camera.fov / 2);
  const tanHalf = Math.min(Math.tan(halfV), Math.tan(halfV) * camera.aspect);
  return MathUtils.clamp((0.034 * roach.scale) / tanHalf, 0.08, 0.3);
}

// --- loop -----------------------------------------------------------------------

const target = new Vector3();
const delta = new Vector3();
let last = performance.now();

function frame(now: number): void {
  const realDt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const dt = realDt * tempo;

  if (flashTimer > 0) {
    flashTimer -= realDt;
    if (flashTimer <= 0) updateInfo();
  }

  // "Like in the app": random run/flee/pause switching with the swarm's speed ranges.
  if (state.id === 'auto') {
    autoTime -= dt;
    if (autoTime <= 0) {
      const step = AUTO_STEPS[Math.random() < 0.55 ? 0 : Math.random() < 0.4 ? 1 : 2];
      applyActive(stateById.get(step.state)!, rand(...step.speed));
      autoTime = rand(...step.time);
      roach.turnRate = step.state === 'idle' ? 0 : Math.random() < 0.35 ? rand(-6, 6) : 0;
    }
    if (active.id !== 'idle') {
      roach.turnRate += rand(-14, 14) * dt;
      roach.turnRate *= 1 - Math.min(1, dt * 2.5);
    }
  }

  // Same acceleration as the swarm: quick start, dead stop.
  const accel = roach.targetSpeed > roach.speed ? 8 : 20;
  roach.speed += (roach.targetSpeed - roach.speed) * Math.min(1, dt * accel);
  if (roach.turnRate !== 0) roach.heading.applyAxisAngle(roach.normal, roach.turnRate * dt).normalize();
  roach.gait += roach.speed * dt * 420;
  roach.antennaPhase += dt * (roach.mode === 'pause' ? 3 : 7);
  if (roach.squashed >= 0) {
    roach.squashed += dt;
    if (roach.squashed > SQUASH_LOOP) roach.squashed = 0; // replay
  }

  // Treadmill: the ground slides backwards under the roach.
  const surf = surfaces[active.surface];
  delta.copy(roach.heading).multiplyScalar(roach.speed * dt / TILE_WORLD);
  surf.tex.offset.x += delta.dot(surf.uAxis);
  surf.tex.offset.y += delta.dot(surf.vAxis);
  surf.tex.offset.x %= 1;
  surf.tex.offset.y %= 1;

  // Orbit around the middle of the body.
  target.copy(roach.normal).multiplyScalar(0.004 * roach.scale);
  controls.target.lerp(target, Math.min(1, realDt * 8));
  if (camAnim) {
    camAnim.t = Math.min(1, camAnim.t + realDt / 0.55);
    const k = camAnim.t * camAnim.t * (3 - 2 * camAnim.t);
    const dir = camAnim.from.clone().lerp(camAnim.to, k);
    if (dir.lengthSq() < 1e-4) dir.copy(camAnim.to); // opposite directions: jump
    camera.position.copy(controls.target).addScaledVector(dir.normalize(), camAnim.dist);
    if (camAnim.t >= 1) camAnim = null;
  }
  controls.update(realDt);

  model.update(roach, active, dt);
  if (now - lastInfo > 250) {
    lastInfo = now;
    updateInfo();
  }
  renderer.render(scene, camera);
}
let lastInfo = 0;

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  // Shift the picture up so the roach sits in the free area above a bottom panel.
  const panelH = ui.panel.classList.contains('collapsed') || w >= 900 ? 0 : ui.panel.offsetHeight;
  if (panelH > 0 && panelH < h * 0.7) camera.setViewOffset(w, h + panelH, 0, panelH, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(ui.panel);

selectState(state);
resize();
camera.position.normalize().multiplyScalar(fitDistance());
renderer.setAnimationLoop(frame);

// A GLB from the URL, or the project's default model once one is committed.
const modelParam = params.get('model');
if (modelParam) void loadGlb(modelParam, modelParam.split('/').pop()!.replace(/\.(glb|gltf)$/i, ''));
else void loadGlb('./models/roach.glb', 'roach.glb', true).then(() => setModel(models[0]));

// Expose for automated tests.
(window as unknown as { __stage: unknown }).__stage = { roach, selectState: (id: StateId) => selectState(stateById.get(id)!), goToView };

// --- textures -------------------------------------------------------------------

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D) => void): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** 2×2 kitchen tiles with grout and a bit of noise, so movement is easy to read. */
function drawTiles(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.fillStyle = '#8a8178';
  ctx.fillRect(0, 0, s, s);
  const half = s / 2;
  const grout = 6;
  const tones = ['#b3aa9e', '#aca397', '#b0a79b', '#b6ada1'];
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      ctx.fillStyle = tones[y * 2 + x];
      ctx.fillRect(x * half + grout / 2, y * half + grout / 2, half - grout, half - grout);
    }
  }
  noise(ctx, s, 2600, 0.05);
}

function drawPlaster(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.fillStyle = '#c4baab';
  ctx.fillRect(0, 0, s, s);
  noise(ctx, s, 9000, 0.07);
  // A faint pencil grid line every 10 cm so climbing reads as movement.
  ctx.strokeStyle = 'rgba(90,70,50,0.18)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, s - 2, s - 2);
}

function noise(ctx: CanvasRenderingContext2D, s: number, n: number, alpha: number): void {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha})`;
    const r = 1 + Math.random() * 2;
    ctx.fillRect(Math.random() * s, Math.random() * s, r, r);
  }
}
