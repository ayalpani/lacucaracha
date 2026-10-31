import {
  AmbientLight,
  DirectionalLight,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  RingGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  Color,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoachAudio } from './audio';
import { RoachRenderer } from './roachRenderer';
import { SurfelMap, type SurfaceSample } from './surfaces';
import { Swarm } from './swarm';
import { ArWorld, DemoWorld, type World } from './worlds';
import './style.css';

const MAX_ROACHES = 220;
const FIRST_WAVE = 4;
const MORE_WAVE = 6;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
let debug = new URLSearchParams(location.search).has('debug');
const ui = {
  start: $('start'),
  hud: $('hud'),
  btnAr: $<HTMLButtonElement>('btn-ar'),
  btnDemo: $<HTMLButtonElement>('btn-demo'),
  arHint: $('ar-hint'),
  count: $('count'),
  status: $('status'),
  centerHint: $('reticle-hint'),
  btnMute: $<HTMLButtonElement>('btn-mute'),
  btnMore: $<HTMLButtonElement>('btn-more'),
  btnPause: $<HTMLButtonElement>('btn-pause'),
  btnExit: $<HTMLButtonElement>('btn-exit'),
  debug: $('debug'),
};
if (debug) ui.debug.classList.remove('hidden');
// Tap the counter to show/hide the diagnostics line.
ui.count.addEventListener('click', () => {
  debug = !debug;
  ui.debug.classList.toggle('hidden', !debug);
});
window.addEventListener('error', (e) => showError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));

// --- three.js setup --------------------------------------------------------

const canvas = $<HTMLCanvasElement>('scene');
const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.xr.enabled = true;

const scene = new Scene();
const camera = new PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 50);

const hemi = new HemisphereLight(0xfff4e6, 0x3a2a1c, 1.6);
const sun = new DirectionalLight(0xffffff, 1.4);
sun.position.set(0.5, 2, 0.8);
const ambient = new AmbientLight(0xffffff, 0.2);
scene.add(hemi, sun, ambient);

const reticle = new Mesh(
  new RingGeometry(0.035, 0.045, 32).rotateX(-Math.PI / 2),
  new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthTest: false }),
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

const map = new SurfelMap();
const swarm = new Swarm(map, { maxRoaches: MAX_ROACHES, breedInterval: 9 });
const roachView = new RoachRenderer(MAX_ROACHES + 40);
scene.add(roachView.group);
const audio = new RoachAudio();

// --- state -----------------------------------------------------------------

let world: World | null = null;
let arWorld: ArWorld | null = null;
let demo: DemoWorld | null = null;
let controls: OrbitControls | null = null;
let session: XRSession | null = null;
let lastReticle: SurfaceSample | null = null;
/** Last surface seen under the screen centre; sticky so a dropped hit-test frame doesn't reset anything. */
let lastSurface: SurfaceSample | null = null;
let surfaceSeenFor = 0;
let lastErr = '';
let fps = 0;
let audioAccum = 0;
let invaded = false;
let lastTime = 0;
let lastUiUpdate = 0;

const camPos = new Vector3();
const camQuat = new Quaternion();
const camFwd = new Vector3();
const camUp = new Vector3();
const reticleMatrix = new Matrix4();
const Y_UP = new Vector3(0, 1, 0);

swarm.onBirth = (r) => {
  if (Math.random() < 0.15) audio.hiss(r.position);
};

window.addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- AR availability -------------------------------------------------------

async function checkAr(): Promise<void> {
  const supported = (await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false)) ?? false;
  if (supported) {
    ui.btnAr.disabled = false;
    ui.btnAr.textContent = 'Kakerlaken loslassen';
  } else {
    ui.btnAr.textContent = 'AR nicht verfügbar';
    ui.arHint.textContent = window.isSecureContext
      ? 'Öffne die Seite in Chrome auf einem ARCore-Handy (z. B. Galaxy A54).'
      : 'AR braucht eine HTTPS-Verbindung.';
  }
}
void checkAr();

// --- sessions --------------------------------------------------------------

async function startAr(): Promise<void> {
  audio.start();
  const xr = navigator.xr;
  if (!xr) return;
  try {
    session = await xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      // No light estimation: its reflection cube maps cost far too much on mid-range phones.
      optionalFeatures: ['dom-overlay', 'plane-detection'],
      domOverlay: { root: ui.hud },
    });
  } catch (err) {
    ui.arHint.textContent = `AR konnte nicht starten: ${(err as Error).message}`;
    return;
  }

  try {
    // Render below native resolution: the camera image is composited separately,
    // so this mainly saves fill rate for our few small roaches.
    renderer.xr.setFramebufferScaleFactor(0.6);
    renderer.xr.setReferenceSpaceType('local');
    // Set the loop BEFORE the session starts: three.js then drives it from the XR
    // session only. Setting it afterwards also starts a window rAF loop, which ran
    // every frame twice (once without XRFrame) and kept resetting the scan.
    renderer.setAnimationLoop(onFrame);
    await renderer.xr.setSession(session);
    arWorld = await ArWorld.create(session, map, () => renderer.xr.getReferenceSpace());
    world = arWorld;
  } catch (err) {
    showError(err);
    void session.end();
    return;
  }

  session.addEventListener('select', (ev) => onArSelect(ev));
  session.addEventListener('end', () => resetToStart());
  // Taps on HUD buttons must not also squash/spawn in the scene.
  for (const b of [ui.btnMute, ui.btnMore, ui.btnPause, ui.btnExit, ui.count]) {
    b.addEventListener('beforexrselect', (e) => e.preventDefault());
  }

  enterHud(false);
}

function startDemo(): void {
  audio.start();
  scene.background = new Color(0x1a120c);
  demo = new DemoWorld(map, camera);
  scene.add(demo.room);
  world = demo;
  camera.position.set(1.6, 1.5, 1.8);
  controls = new OrbitControls(camera, canvas);
  controls.target.set(-0.3, 0.6, -0.8);
  controls.enableDamping = true;
  controls.minDistance = 0.3;
  controls.maxDistance = 4;
  controls.update();
  enterHud(true);
}

function enterHud(startLoop: boolean): void {
  ui.start.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  ui.status.textContent = 'Scanne die Umgebung …';
  ui.centerHint.classList.remove('hidden');
  ui.centerHint.textContent = 'Bewege das Handy langsam über Boden und Möbel';
  invaded = false;
  surfaceSeenFor = 0;
  lastSurface = null;
  lastTime = 0;
  if (startLoop) renderer.setAnimationLoop(onFrame);
}

function resetToStart(): void {
  renderer.setAnimationLoop(null);
  world?.dispose();
  world = null;
  arWorld = null;
  demo = null;
  controls?.dispose();
  controls = null;
  session = null;
  swarm.clear();
  map.clear();
  reticle.visible = false;
  scene.background = null;
  audio.stop();
  roachView.update([]);
  renderer.clear();
  ui.hud.classList.add('hidden');
  ui.start.classList.remove('hidden');
}

// --- frame loop ------------------------------------------------------------

function onFrame(time: number, frame?: XRFrame): void {
  const now = time / 1000;
  const dt = lastTime ? now - lastTime : 0;
  // Safety net: while in AR, only XR frames count.
  if (renderer.xr.isPresenting && !frame) return;
  lastTime = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.1;
  if (!world) return;

  try {
    tick(now, dt, frame ?? null);
  } catch (err) {
    showError(err);
  }
  renderer.render(scene, camera);
}

function tick(now: number, dt: number, frame: XRFrame | null): void {
  controls?.update();
  world!.cameraPose(frame, camPos, camQuat);
  camFwd.set(0, 0, -1).applyQuaternion(camQuat);
  camUp.set(0, 1, 0).applyQuaternion(camQuat);

  lastReticle = world!.scan(now, frame);
  if (lastReticle) lastSurface = lastReticle;
  updateReticle(lastReticle ?? lastSurface);

  // Start once a surface has been under the centre for ~1 s in total (gaps allowed).
  if (!invaded && lastReticle) {
    surfaceSeenFor += dt;
    if (surfaceSeenFor > 0.8) startInvasion(lastReticle);
  }

  swarm.update(dt, camPos);
  roachView.update(swarm.roaches);

  // Audio params don't need 60 Hz updates; fewer automation events = no crackle.
  audioAccum += dt;
  if (audioAccum > 0.066) {
    audio.update(audioAccum, swarm.roaches, camPos, camFwd, camUp);
    audioAccum = 0;
  }

  if (now - lastUiUpdate > 0.25) {
    lastUiUpdate = now;
    const n = swarm.aliveCount;
    ui.count.textContent = `🪳 ${n}`;
    if (invaded) {
      ui.status.textContent =
        n >= MAX_ROACHES ? 'Befall komplett' : swarm.breeding ? (n > 40 ? 'Sie vermehren sich …' : 'Tippe drauf zum Zerquetschen') : 'Vermehrung pausiert';
    } else {
      ui.status.textContent = lastReticle ? 'Fläche gefunden …' : 'Scanne die Umgebung …';
    }
    if (debug) {
      const st = arWorld?.stats;
      ui.debug.textContent =
        `${fps.toFixed(0)} fps · Flächenpunkte ${map.size}` +
        (st ? ` · Hits ${st.hitsLastFrame}/${st.sources} · Ebenen ${st.planes}` : '') +
        ` · Tiere ${n}` +
        (lastErr ? `\n⚠ ${lastErr}` : st?.error ? `\n⚠ ${st.error}` : '');
    }
  }
}

function showError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === lastErr) return;
  lastErr = msg;
  console.error(err);
  debug = true;
  ui.debug.classList.remove('hidden');
  ui.debug.textContent = `⚠ ${msg}`;
}

function updateReticle(hit: SurfaceSample | null): void {
  reticle.visible = !invaded && hit !== null;
  if (!hit) return;
  const q = new Quaternion().setFromUnitVectors(Y_UP, hit.normal);
  reticleMatrix.compose(hit.position.clone().addScaledVector(hit.normal, 0.002), q, new Vector3(1, 1, 1));
  reticle.matrix.copy(reticleMatrix);
}

function startInvasion(at: SurfaceSample): void {
  invaded = true;
  ui.centerHint.classList.add('hidden');
  // They come from slightly off-centre, as if out of a gap.
  swarm.burst(at.position, at.normal, FIRST_WAVE);
  audio.hiss(at.position);
  navigator.vibrate?.([30, 40, 30]);
}

function spawnMore(): void {
  const target = lastReticle ?? lastSurface ?? (() => {
    const s = map.random();
    return s ? { position: s.position, normal: s.normal } : null;
  })();
  if (!target) return;
  if (!invaded) startInvasion(target);
  else swarm.burst(target.position, target.normal, MORE_WAVE);
}

function squashOrSpawn(origin: Vector3, dir: Vector3, surface: SurfaceSample | null): void {
  const hit = swarm.squashAlongRay(origin, dir);
  if (hit) {
    audio.squish(hit.position);
    navigator.vibrate?.(45);
    return;
  }
  if (surface) {
    if (!invaded) startInvasion(surface);
    else swarm.burst(surface.position, surface.normal, 2);
  }
}

function onArSelect(ev: XRInputSourceEvent): void {
  const ref = renderer.xr.getReferenceSpace();
  if (!ref) return;
  const pose = ev.frame.getPose(ev.inputSource.targetRaySpace, ref);
  if (!pose) return;
  const m = new Matrix4().fromArray(pose.transform.matrix);
  const origin = new Vector3().setFromMatrixPosition(m);
  const dir = new Vector3(0, 0, -1).transformDirection(m);
  squashOrSpawn(origin, dir, lastReticle ?? lastSurface);
}

// Demo taps (ignore drags used for orbiting).
let downAt: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
canvas.addEventListener('pointerup', (e) => {
  if (!demo || !downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 8) return;
  const ndcX = (e.clientX / window.innerWidth) * 2 - 1;
  const ndcY = -(e.clientY / window.innerHeight) * 2 + 1;
  const surface = demo.castAt(ndcX, ndcY);
  const dir = new Vector3(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
  squashOrSpawn(camera.position.clone(), dir, surface);
});

// --- buttons ---------------------------------------------------------------

ui.btnAr.addEventListener('click', () => void startAr());
ui.btnDemo.addEventListener('click', startDemo);
ui.btnMore.addEventListener('click', spawnMore);
ui.btnMute.addEventListener('click', () => {
  const muted = audio.toggleMute();
  ui.btnMute.textContent = muted ? '🔇' : '🔊';
});
ui.btnPause.addEventListener('click', () => {
  swarm.breeding = !swarm.breeding;
  ui.btnPause.textContent = swarm.breeding ? '⏸' : '▶';
});
ui.btnExit.addEventListener('click', () => {
  if (session) void session.end();
  else resetToStart();
});

// Debug/test hook (used by the headless smoke test).
(window as unknown as { __roaches: () => number }).__roaches = () => swarm.aliveCount;
(window as unknown as { __view: (x: number, y: number, z: number, tx: number, ty: number, tz: number) => void }).__view = (
  x, y, z, tx, ty, tz,
) => {
  camera.position.set(x, y, z);
  controls?.target.set(tx, ty, tz);
  controls?.update();
};
