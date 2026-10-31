// Builds a crude static roach (body, 6 legs, antennae) as GLB, deliberately lying along -X,
// to test auto-orientation and the leg shader. Usage: node tests/make-test-glb.mjs out.glb
import { writeFileSync } from 'node:fs';
import { CylinderGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, Vector3, Quaternion } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); }); }
  readAsDataURL(blob) { blob.arrayBuffer().then((b) => { this.result = 'data:application/octet-stream;base64,' + Buffer.from(b).toString('base64'); this.onloadend?.(); }); }
};

const shell = new MeshStandardMaterial({ color: 0x7a3a15, roughness: 0.3 });
const leg = new MeshStandardMaterial({ color: 0x5a2a12, roughness: 0.5 });
const root = new Group();
const body = new Mesh(new SphereGeometry(1, 32, 16), shell);
body.scale.set(9, 4, 20); body.position.set(0, 7, 0); root.add(body);
const head = new Mesh(new SphereGeometry(3.5, 16, 12), shell);
head.position.set(0, 6, 21); root.add(head);
const seg = (a, b, r, mat) => {
  const d = new Vector3().subVectors(b, a); const len = d.length();
  const m = new Mesh(new CylinderGeometry(r, r, len, 6).translate(0, len / 2, 0), mat);
  m.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d.normalize()));
  m.position.copy(a); root.add(m);
};
for (const s of [1, -1]) {
  for (const [hz, fx, fz] of [[10, 18, 26], [2, 26, 4], [-6, 26, -30]]) {
    const hip = new Vector3(s * 7, 5, hz), knee = new Vector3(s * (fx * 0.6), 8, (hz + fz) / 2), foot = new Vector3(s * fx, 0, fz);
    seg(hip, knee, 0.9, leg); seg(knee, foot, 0.6, leg);
  }
  seg(new Vector3(s * 1.5, 7, 24), new Vector3(s * 14, 10, 60), 0.4, leg);
}
// Lie along -X like a sloppy export.
root.rotation.y = -Math.PI / 2;
root.updateMatrixWorld(true);
const glb = await new GLTFExporter().parseAsync(root, { binary: true });
writeFileSync(process.argv[2], Buffer.from(glb));
console.log('wrote', process.argv[2], glb.byteLength);
