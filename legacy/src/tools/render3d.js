/**
 * Making something in three dimensions (v1.75).
 *
 * She writes a self-contained HTML file that renders a real WebGL scene — one
 * file, Three.js from a CDN, no build step, opens in any browser and works
 * offline once cached. The same shape as everything else Forge makes, because
 * that shape has proven itself: nothing to install, nothing to serve, and he
 * can send it to someone.
 *
 * WHY A SCENE AND NOT AN IMAGE: a still is what an image generator is for. A
 * scene he can spin, light and re-frame is the thing a still cannot do — a
 * merch mockup he can turn around, a stage layout he can walk, a logo he can
 * light from a different angle. If he wants a picture, he takes a screenshot
 * of it, and the tool says so.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, sep, join, basename } from 'node:path';
import { config } from '../config.js';
import { registerTool } from './registry.js';

const SHELL = (title, body, note) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  html,body{margin:0;height:100%;background:#0d0f13;overflow:hidden;
    font:13px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;color:#ece9e4}
  canvas{display:block}
  #hud{position:fixed;left:16px;bottom:14px;color:#8a867f;font-size:11.5px;
    letter-spacing:.04em;pointer-events:none}
  #hud b{color:#f0a03a;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
    display:block;margin-bottom:3px;font-size:10px}
</style></head><body>
<div id="hud"><b>${title}</b>drag to turn · scroll to zoom${note ? ' · ' + note : ''}</div>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"}}</script>
<script type="module">
import * as THREE from 'three';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f13);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200);
camera.position.set(4, 3, 6);
camera.lookAt(0, 0.5, 0);

/* Turning the camera by hand — OrbitControls is not in the core build, and one
   file that needs nothing else is worth more than a smoother orbit. */
let dragging = false, px = 0, py = 0;
let yaw = Math.atan2(camera.position.x, camera.position.z);
let pitch = Math.asin(camera.position.y / camera.position.length());
let dist = camera.position.length();
const place = () => {
  camera.position.set(
    dist * Math.cos(pitch) * Math.sin(yaw),
    dist * Math.sin(pitch),
    dist * Math.cos(pitch) * Math.cos(yaw));
  camera.lookAt(0, 0.5, 0);
};
addEventListener('pointerdown', (e) => { dragging = true; px = e.clientX; py = e.clientY; });
addEventListener('pointerup', () => { dragging = false; });
addEventListener('pointermove', (e) => {
  if (!dragging) return;
  yaw -= (e.clientX - px) * 0.006;
  pitch = Math.max(-1.35, Math.min(1.35, pitch + (e.clientY - py) * 0.006));
  px = e.clientX; py = e.clientY; place();
});
addEventListener('wheel', (e) => {
  e.preventDefault();
  dist = Math.max(1.6, Math.min(40, dist * (e.deltaY > 0 ? 1.1 : 1 / 1.1)));
  place();
}, { passive: false });
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

/* Light it like a room, not like a torch: a key, a cool fill from the other
   side, and a soft ambient so nothing goes to pure black. */
scene.add(new THREE.AmbientLight(0xffffff, 0.35));
const key = new THREE.DirectionalLight(0xfff2e0, 2.1);
key.position.set(5, 8, 4); key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
scene.add(key);
const fill = new THREE.DirectionalLight(0x88bbff, 0.7);
fill.position.set(-6, 3, -4);
scene.add(fill);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(14, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x14171d, roughness: 0.95, metalness: 0 }));
ground.receiveShadow = true;
scene.add(ground);

/* ---- the subject ---- */
${body}

renderer.setAnimationLoop(() => {
  if (typeof tick === 'function') tick(performance.now() / 1000);
  renderer.render(scene, camera);
});
place();
</script></body></html>`;

registerTool({
  name: 'create_3d_scene',
  description:
    'Build a real 3D scene Shahyd can turn, zoom and light — a merch mockup he ' +
    'can spin, a stage or studio layout, a logo in three dimensions, a product ' +
    'shot. Use when he asks for something in 3D, a render, or a mockup he wants ' +
    'to see from other angles. You write the Three.js that makes the subject; ' +
    'the camera, lighting, ground and controls are already there. Define a ' +
    'function called tick(t) if anything should move. For a flat picture use ' +
    'generate_image instead — this is for something he can move around.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'What to call the file, e.g. "tee-mockup".' },
      title: { type: 'string', description: 'Shown on screen, e.g. "Legacy tee — mockup".' },
      scene: {
        type: 'string',
        description:
          'Three.js building the subject. THREE and scene are in scope; meshes ' +
          'should castShadow. Sit things on y=0 (the ground). Optionally define ' +
          'function tick(t) { ... } to animate. Do NOT create a renderer, ' +
          'camera, lights or controls — they exist.',
      },
      note: { type: 'string', description: 'A short hint for the corner, e.g. "screenshot it for a still".' },
    },
    required: ['name', 'title', 'scene'],
  },
  handler: async ({ name, title, scene, note }) => {
    const root = config.workspace?.root?.trim();
    if (!root) return 'The workspace folder is not set in config.json, so I have nowhere to put it.';
    if (!scene?.trim()) return 'I need the scene code — what is actually in it?';

    // A scene that creates its own renderer or camera will fight the shell and
    // render nothing, which looks like a mystery rather than a mistake.
    const clash = ['new THREE.WebGLRenderer', 'new THREE.PerspectiveCamera', 'setAnimationLoop']
      .find((p) => scene.includes(p));
    if (clash) {
      return `That scene creates its own ${clash.replace('new THREE.', '')} — the file already has one, and two would fight. ` +
        'Write only the subject: geometry, materials, meshes, and optionally tick(t).';
    }

    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'scene';
    const dir = join(resolve(root), 'Renders');
    const file = join(dir, `${slug}.html`);
    if (!file.startsWith(resolve(root) + sep)) return 'That name resolves outside your workspace.';

    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, SHELL(String(title).slice(0, 60), scene, note));
    } catch (e) { return `I could not write it: ${e.message}`; }

    // IT OPENS ON THE BUILD SURFACE (v1.86), not in a new window. Throwing him
    // into a separate tab at the moment the work arrives pulls him out of
    // Legacy exactly when he wants to look at what she made.
    try {
      const { stage } = await import('../stage.js');
      stage('build.file', { name: `Renders/${slug}.html`, meta: title, body: scene.slice(0, 2500) });
      stage('build.preview', { name: title, url: `/render?f=${encodeURIComponent(`${slug}.html`)}` });
    } catch { /* the file is written either way */ }

    return `${title} is on the build surface — drag to turn it, scroll to zoom. ` +
      `It is saved as Renders/${slug}.html if you want to send it to someone.`;
  },
});
