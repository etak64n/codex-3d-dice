import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import RAPIER, * as RAPIER_TYPES from '@dimforge/rapier3d-compat';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';

// Tunables (中央寄りの動き・画面内に収めるための境界や物理値)
// 物理の外枠はカメラ外へ（十分に外側） — 天井は高めに
const ARENA = { halfX: 8.0, halfZ: 6.0, wallH: 2.2, wallT: 0.12, ceilY: 4.2 } as const;
const PHYS = {
  worldHz: 120,
  startY: 3.0,
  startX: 0.25,
  startZ: 0.15,
  // ダンピングを弱めて空気抵抗感を減らす
  linDamp: 0.12,
  angDamp: 0.22,
  // 水平スピードを少し上げる
  speedMin: 4.2,
  speedMax: 6.2,
  // 初期Yインパルスを下向きにして素早く落下
  tossYMin: -0.9,
  tossYMax: -0.5,
  torque: 2.6,
  // 回転速度も少しアップ
  angVelMax: 5.0,
  jitter: 0.25
} as const;

// Table dimensions and frame specs (used across rendering and physics)
// 奥行きを出す: 幅控えめ・奥行き深め
const FELT_X = 7.2, FELT_Z = 9.6; // felt area size (X: width, Z: depth)
const FRAME_T = 0.30, FRAME_H = 0.90; // thicker and higher rails to keep dice in
const BASE_MARGIN = 0.9; // base margin around felt
const BASE_X = FELT_X + BASE_MARGIN*2, BASE_Z = FELT_Z + BASE_MARGIN*2; // larger wooden base

// 画面内に収めるためのソフト境界（フェルト内側・余白あり）
const BOUNDS = { halfX: (FELT_X/2 - 0.4), halfZ: (FELT_Z/2 - 0.4), k: 1.0, maxImpulse: 0.2 } as const;

// Canvas / Renderer
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.4;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

let composer: EffectComposer | undefined;
let ssaoPass: SSAOPass | undefined;

// Scene / Camera
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
// さらに遠目・高めにして盤面全体を確実に収める
camera.position.set(0.2, 4.8, 10.6);
camera.lookAt(0, 0.6, 0);

// Resize
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth * dpr;
  const h = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
  }
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.updateProjectionMatrix();
  if (composer) {
    composer.setSize(w, h);
    ssaoPass && ssaoPass.setSize(w, h);
  }
}
new ResizeObserver(resize).observe(canvas);

// Lights
const hemi = new THREE.HemisphereLight(0xfff7ea, 0x7a3b21, 1.05);
scene.add(hemi);
const spot = new THREE.SpotLight(0xffffff, 2.2, 30, THREE.MathUtils.degToRad(40), 0.55, 1.2);
spot.position.set(-1.6, 7.2, 4.2);
spot.penumbra = 0.4;
spot.castShadow = true;
spot.shadow.radius = 4;
spot.shadow.mapSize.set(2048, 2048);
spot.shadow.bias = -0.0005;
spot.shadow.normalBias = 0.005;
// tighten shadow camera to reduce peter-panning
spot.shadow.camera.near = 1;
spot.shadow.camera.far = 10;
// @ts-ignore — update method exists on shadow camera
spot.shadow.camera.updateProjectionMatrix && spot.shadow.camera.updateProjectionMatrix();
scene.add(spot);
scene.add(spot.target);
spot.target.position.set(0, 0.4, 0);
// Gentle fill light from front-right
const fill = new THREE.DirectionalLight(0xffffff, 0.6);
fill.position.set(2.5, 2.2, 4.0);
scene.add(fill);
// Ambient soft room glow
scene.add(new THREE.AmbientLight(0xffffff, 0.35));
// Warm accent lights (bar-counter mood, red-leaning)
const warm1 = new THREE.PointLight(0xff5a4d, 0.55, 20); warm1.position.set(-3.2, 5.4,  2.6); scene.add(warm1);
const warm2 = new THREE.PointLight(0xff8a4d, 0.40, 18); warm2.position.set( 3.0, 4.8, -2.2); scene.add(warm2);

// Environment (procedural)
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
pmrem.dispose();
// Casino-like blurred bokeh background
scene.background = makeCasinoBokehTexture();

// Postprocessing: Render + SSAO for contact shadow realism
composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
ssaoPass = new SSAOPass(scene, camera, canvas.clientWidth, canvas.clientHeight);
// 明るさ優先のため、SSAOは無効化（中央の怪しい陰影を避ける）
ssaoPass.enabled = false;
composer.addPass(ssaoPass);

// Table: felt + wood base + leather rails + gold trim (casino style)
const table = new THREE.Group();
scene.add(table);
// dimensions are defined earlier (FELT_X/Z, FRAME_T/H, BASE_* are globals)
// Felt
const feltGeom = new THREE.PlaneGeometry(FELT_X, FELT_Z);
const feltTex = makeFeltTexture();
const feltRough = makeNoiseTexture(256, 0.7, 0.18);
const feltBump = makeNoiseTexture(256, 0.6, 0.25);
feltTex.wrapS = feltTex.wrapT = THREE.RepeatWrapping; feltTex.repeat.set(3,2);
const feltMat = new THREE.MeshPhysicalMaterial({ color: 0x0f8a3c, map: feltTex, roughness: 0.94, metalness: 0.0, roughnessMap: feltRough, bumpMap: feltBump, bumpScale: 0.07 });
// add fabric sheen for realism (typed via any for TS compat)
(feltMat as any).sheen = 0.5;
(feltMat as any).sheenRoughness = 0.9;
(feltMat as any).sheenColor = new THREE.Color(0x0f7433);
const felt = new THREE.Mesh(feltGeom, feltMat);
felt.rotation.x = -Math.PI/2; felt.position.y = 0.0; felt.receiveShadow = false; // use shadow catcher instead
table.add(felt);
// Shadow catcher (overlay)
const shadowMat = new THREE.ShadowMaterial({ opacity: 0.10 });
shadowMat.transparent = true;
const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(FELT_X, FELT_Z), shadowMat);
shadowCatcher.rotation.x = -Math.PI/2; shadowCatcher.position.y = 0.0001;
shadowCatcher.receiveShadow = true;
table.add(shadowCatcher);
// Base wood (polished)
const woodTex = makeWoodTexture(1024);
woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping; woodTex.repeat.set(2,2);
// Deep mahogany with a polished clearcoat for bar-counter vibe
const woodMat = new THREE.MeshPhysicalMaterial({
  color: 0x6b2018,
  map: woodTex,
  roughness: 0.46,
  metalness: 0.15,
  clearcoat: 0.45,
  clearcoatRoughness: 0.3,
  envMapIntensity: 0.9
});
const base = new THREE.Mesh(new THREE.PlaneGeometry(BASE_X, BASE_Z), woodMat);
base.rotation.x = -Math.PI/2; base.position.y = -0.02; base.receiveShadow = true;
table.add(base);
// Leather rails (padded)
const leatherTex = makeLeatherTexture(512);
leatherTex.wrapS = leatherTex.wrapT = THREE.RepeatWrapping; leatherTex.repeat.set(2,2);
// Oxblood leather tone with subtle sheen
const leatherMat = new THREE.MeshStandardMaterial({ color: 0x3a0d12, map: leatherTex, roughness: 0.66, metalness: 0.06, bumpMap: leatherTex, bumpScale: 0.08 });
const R = Math.min(0.18, FRAME_T*0.7);
const railLong = new THREE.Mesh(new RoundedBoxGeometry(FELT_X + FRAME_T*2, FRAME_H, FRAME_T, 5, R), leatherMat);
const railShort = new THREE.Mesh(new RoundedBoxGeometry(FRAME_T, FRAME_H, FELT_Z + FRAME_T*2, 5, R), leatherMat);
const yRail = FRAME_H/2;
const leftRail = railShort.clone(); leftRail.position.set(-(FELT_X/2 + FRAME_T/2), yRail, 0); leftRail.castShadow = true; leftRail.receiveShadow = true; table.add(leftRail);
const rightRail = railShort.clone(); rightRail.position.set( (FELT_X/2 + FRAME_T/2), yRail, 0); rightRail.castShadow = true; rightRail.receiveShadow = true; table.add(rightRail);
const frontRail = railLong.clone(); frontRail.position.set(0, yRail,  (FELT_Z/2 + FRAME_T/2)); frontRail.castShadow = true; frontRail.receiveShadow = true; table.add(frontRail);
const backRail  = railLong.clone(); backRail.position.set(0, yRail, -(FELT_Z/2 + FRAME_T/2)); backRail.castShadow = true; backRail.receiveShadow = true; table.add(backRail);
// Gold trim lines inside rails
const trimMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, roughness: 0.42, metalness: 1.0, envMapIntensity: 0.7 });
const ty = FRAME_H - 0.04;
const trimFront = new THREE.Mesh(new THREE.BoxGeometry(FELT_X + FRAME_T*2 - 0.06, 0.02, 0.015), trimMat); trimFront.position.set(0, ty, FELT_Z/2 + FRAME_T - 0.03); table.add(trimFront);
const trimBack  = trimFront.clone(); trimBack.position.z = -(FELT_Z/2 + FRAME_T - 0.03); table.add(trimBack);
const trimLeft  = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.02, FELT_Z + FRAME_T*2 - 0.06), trimMat); trimLeft.position.set(-(FELT_X/2 + FRAME_T - 0.03), ty, 0); table.add(trimLeft);
const trimRight = trimLeft.clone(); trimRight.position.x =  (FELT_X/2 + FRAME_T - 0.03); table.add(trimRight);

// Dice
const DIE = { HALF: 0.30, CLEARCOAT: 0.6, CC_ROUGH: 0.25 };
function pipTexture(n: 1|2|3|4|5|6) {
  const size = 256; const c = document.createElement('canvas'); c.width = c.height = size; const ctx = c.getContext('2d')!;
  // 背景は透明にし、ボディの白を見せて色味を一致させる
  ctx.clearRect(0,0,size,size);
  // 1だけ大きめ、その他は一段小さく
  const g = size / 4;               // 64px グリッド
  const center = 2 * g;             // 128px
  const r1 = Math.round(g * 0.48);  // 1用: 大きめ
  const rN = Math.round(g * 0.40);  // 2-6用: 少し小さく
  const r = (n === 1 ? r1 : rN);
  const P: Record<number, [number,number][]> = {
    1: [[center, center]],
    2: [[g, g],[3*g, 3*g]],
    3: [[g, g],[center, center],[3*g, 3*g]],
    4: [[g, g],[3*g, g],[g, 3*g],[3*g, 3*g]],
    5: [[g, g],[3*g, g],[center, center],[g, 3*g],[3*g, 3*g]],
    6: [[g, g],[3*g, g],[g, center],[3*g, center],[g, 3*g],[3*g, 3*g]]
  };
  for (const [x,y] of P[n]) { ctx.beginPath(); ctx.fillStyle = (n===1?'#d41616':'#0d0f13'); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); }
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = renderer.capabilities.getMaxAnisotropy(); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function makeSticker(n: 1|2|3|4|5|6, size: number) {
  // 面の平坦部分に収まる程度に（角のRに重なりすぎない）
  const g = new THREE.PlaneGeometry(size*1.60, size*1.60);
  // 背景は透明（ボディが見える）。pipsのみ表示。
  const m = new THREE.MeshPhysicalMaterial({
    map: pipTexture(n),
    color: 0xffffff,
    roughness: 0.16,
    metalness: 0.02,
    clearcoat: 0.8,
    clearcoatRoughness: 0.08,
    envMapIntensity: 0.9,
    specularIntensity: 0.4,
    side: THREE.DoubleSide,
    transparent: true,
    alphaTest: 0.5,
    depthWrite: false
  });
  m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2; // avoid z-fighting
  const mesh = new THREE.Mesh(g, m);
  mesh.castShadow = false; mesh.receiveShadow = false;
  return mesh;
}
function makeDie() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new RoundedBoxGeometry(DIE.HALF*2, DIE.HALF*2, DIE.HALF*2, 5, 0.08),
    // Slight micro-roughness and micro-bump for realism
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.22,
      metalness: 0.02,
      clearcoat: 0.75,
      clearcoatRoughness: 0.12,
      envMapIntensity: 1.1,
      ior: 1.5,
      specularIntensity: 0.4,
      specularColor: new THREE.Color(0xffffff),
      roughnessMap: diceRough,
      bumpMap: diceBump,
      bumpScale: 0.006
    })
  );
  body.castShadow = true;
  group.add(body);
  // stickers
  // 浮きが目立たないようオフセットをさらに薄く（polygonOffsetでz-fighting回避）
  const eps = 0.0010;
  const top = makeSticker(1, DIE.HALF); top.position.set(0, DIE.HALF+eps, 0); top.rotation.x = -Math.PI/2; group.add(top);
  const bottom = makeSticker(6, DIE.HALF); bottom.position.set(0, -DIE.HALF-eps, 0); bottom.rotation.x = Math.PI/2; group.add(bottom);
  const right = makeSticker(3, DIE.HALF); right.position.set(DIE.HALF+eps, 0, 0); right.rotation.y = -Math.PI/2; group.add(right);
  const left = makeSticker(4, DIE.HALF); left.position.set(-DIE.HALF-eps, 0, 0); left.rotation.y = Math.PI/2; group.add(left);
  const front = makeSticker(2, DIE.HALF); front.position.set(0, 0, DIE.HALF+eps); group.add(front);
  const back = makeSticker(5, DIE.HALF); back.position.set(0, 0, -DIE.HALF-eps); back.rotation.y = Math.PI; group.add(back);
  return group;
}

// Rapier world
let world: RAPIER_TYPES.World;
const bodies: RAPIER_TYPES.RigidBody[] = [];
const diceMeshes: THREE.Group[] = [];

async function initPhysics() {
  await RAPIER.init(); // load WASM module
  // 重力を強めて落下をキビキビさせる（約1.6g）
  world = new RAPIER.World({ x: 0, y: -16.0, z: 0 });
  world.timestep = 1 / PHYS.worldHz;
  // ground (big flat cuboid)
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.02, 0));
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(20, 0.02, 20)
      .setFriction(0.9)
      .setRestitution(0.2),
    groundBody
  );
  // walls（さらに狭くして中央寄りに）+ 天井（高め）
  const w = ARENA.halfX, h = ARENA.wallH, d = ARENA.wallT, z = ARENA.halfZ;
  const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(w, h, d).setTranslation(0, h/2, -z).setFriction(0.6).setRestitution(0.3));
  world.createCollider(RAPIER.ColliderDesc.cuboid(w, h, d).setTranslation(0, h/2, z).setFriction(0.6).setRestitution(0.3));
  world.createCollider(RAPIER.ColliderDesc.cuboid(d, h, z).setTranslation(-w, h/2, 0).setFriction(0.6).setRestitution(0.3));
  world.createCollider(RAPIER.ColliderDesc.cuboid(d, h, z).setTranslation(w, h/2, 0).setFriction(0.6).setRestitution(0.3));
  // ceiling
  world.createCollider(RAPIER.ColliderDesc.cuboid(w, d, z).setTranslation(0, ARENA.ceilY, 0));
  // Inner visible rails as physical blockers (keep dice on the felt)
  {
    const hx = FELT_X/2, hz = FELT_Z/2; const t = FRAME_T, hInner = FRAME_H;
    const wallBodyInner = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    // left/right
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(t/2, hInner/2, hz + t)
        .setTranslation(-(hx + t/2), hInner/2, 0)
        .setFriction(0.6)
        .setRestitution(0.25),
      wallBodyInner
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(t/2, hInner/2, hz + t)
        .setTranslation((hx + t/2), hInner/2, 0)
        .setFriction(0.6)
        .setRestitution(0.25),
      wallBodyInner
    );
    // front/back
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx + t, hInner/2, t/2)
        .setTranslation(0, hInner/2, (hz + t/2))
        .setFriction(0.6)
        .setRestitution(0.25),
      wallBodyInner
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx + t, hInner/2, t/2)
        .setTranslation(0, hInner/2, -(hz + t/2))
        .setFriction(0.6)
        .setRestitution(0.25),
      wallBodyInner
    );
    // Optional invisible lip above rails to further prevent escape
    const lipH = 0.3; const lipY = hInner + lipH/2;
    const wallBodyLip = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(t/2, lipH/2, hz + t)
        .setTranslation(-(hx + t/2), lipY, 0), wallBodyLip);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(t/2, lipH/2, hz + t)
        .setTranslation((hx + t/2), lipY, 0), wallBodyLip);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx + t, lipH/2, t/2)
        .setTranslation(0, lipY, (hz + t/2)), wallBodyLip);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx + t, lipH/2, t/2)
        .setTranslation(0, lipY, -(hz + t/2)), wallBodyLip);
  }

  // dice bodies + meshes
  for (let i = 0; i < 2; i++) {
    const mesh = makeDie(); scene.add(mesh); diceMeshes.push(mesh);
    const rb = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation((i ? PHYS.startX : -PHYS.startX), PHYS.startY, (i ? -PHYS.startZ : PHYS.startZ))
        .setCanSleep(true)
    );
    rb.setLinearDamping(PHYS.linDamp); rb.setAngularDamping(PHYS.angDamp);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(DIE.HALF, DIE.HALF, DIE.HALF)
        .setFriction(0.5)
        .setRestitution(0.25),
      rb
    );
    bodies.push(rb);
  }
}

// Roll control
let running = false;

function roll() {
  if (!world) return;
  // 途中でも即時振り直し可能にするため、静止判定をリセット
  stillFrames = 0;
  for (let i = 0; i < bodies.length; i++) {
    const rb = bodies[i];
    // 念のため最新のダンピング値を反映
    rb.setLinearDamping(PHYS.linDamp);
    rb.setAngularDamping(PHYS.angDamp);
    rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const sx = (i ? PHYS.startX : -PHYS.startX), sz = (i ? -PHYS.startZ : PHYS.startZ);
    rb.setTranslation({ x: sx, y: PHYS.startY, z: sz }, true);
    // ランダム姿勢から落とす
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      Math.random()*Math.PI*2,
      Math.random()*Math.PI*2,
      Math.random()*Math.PI*2
    ));
    rb.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    const speed = PHYS.speedMin + Math.random() * (PHYS.speedMax - PHYS.speedMin);
    const dirToCenter = Math.atan2(-sz, -sx);
    const jitter = (Math.random()-0.5) * PHYS.jitter;
    const ang = dirToCenter + jitter;
    // 高い位置から重力で落とす + わずかな水平インパルス
    rb.applyImpulse({ x: Math.cos(ang) * speed, y: PHYS.tossYMin + Math.random()*(PHYS.tossYMax - PHYS.tossYMin), z: Math.sin(ang) * speed }, true);
    const av = {
      x: (Math.random()-0.5) * PHYS.angVelMax,
      y: (Math.random()-0.5) * PHYS.angVelMax,
      z: (Math.random()-0.5) * PHYS.angVelMax
    };
    rb.setAngvel(av, true);
  }
  running = true;
}

// タッチ主体で素早く反応するよう pointerdown を使用
canvas.addEventListener('pointerdown', roll);
window.addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); roll(); } });

// Animation loop
let last = performance.now();
let stillFrames = 0;
// 実時間に追従するためのサブステップ蓄積
let acc = 0;
function tick(now: number) {
  const dt = Math.min(1 / 30, (now - last) / 1000);
  last = now;
  if (world) {
    acc += dt;
    const h = world.timestep;
    // 実時間に追従するまで 1/PHYS.worldHz 刻みで複数回 step
    while (acc >= h) {
      world.step();
      acc -= h;
    }
    syncMeshes();
    // 画面外に出ないように、外側なら中心へ弱く押し戻す
    if (running) nudgeWithinBounds();
  }
  if (composer) composer.render(); else renderer.render(scene, camera);
  if (running && world) checkSettle();
  requestAnimationFrame(tick);
}

function syncMeshes() {
  for (let i = 0; i < bodies.length; i++) {
    const rb = bodies[i]; const m = diceMeshes[i];
    const t = rb.translation(); const r = rb.rotation();
    m.position.set(t.x, t.y, t.z); m.quaternion.set(r.x, r.y, r.z, r.w);
  }
}

function checkSettle() {
  const still = bodies.every(b => {
    const lv = b.linvel(), av = b.angvel();
    const t = b.translation();
    const inside = Math.abs(t.x) <= BOUNDS.halfX && Math.abs(t.z) <= BOUNDS.halfZ;
    return inside && Math.hypot(lv.x, lv.y, lv.z) < 0.05 && Math.max(Math.abs(av.x), Math.abs(av.y), Math.abs(av.z)) < 0.1 && t.y < 0.5;
  });
  if (!still) { stillFrames = 0; return; }
  if (++stillFrames < 10) return; // 安定を複数フレーム確認
  stillFrames = 0; running = false;
  // 出目の表示等は行わない（UI排除）
}

function nudgeWithinBounds() {
  for (const rb of bodies) {
    const t = rb.translation();
    let fx = 0, fz = 0;
    if (t.x > BOUNDS.halfX) fx -= Math.min(BOUNDS.maxImpulse, (t.x - BOUNDS.halfX) * BOUNDS.k);
    else if (t.x < -BOUNDS.halfX) fx += Math.min(BOUNDS.maxImpulse, (-BOUNDS.halfX - t.x) * BOUNDS.k);
    if (t.z > BOUNDS.halfZ) fz -= Math.min(BOUNDS.maxImpulse, (t.z - BOUNDS.halfZ) * BOUNDS.k);
    else if (t.z < -BOUNDS.halfZ) fz += Math.min(BOUNDS.maxImpulse, (-BOUNDS.halfZ - t.z) * BOUNDS.k);
    if (fx || fz) rb.applyImpulse({ x: fx, y: 0, z: fz }, true);
  }
}

const FACE_DIRS = [
  new THREE.Vector3(0, 1, 0),  // top -> 1
  new THREE.Vector3(0,-1, 0),  // bottom -> 6
  new THREE.Vector3(1, 0, 0),  // right -> 3
  new THREE.Vector3(-1,0, 0),  // left  -> 4
  new THREE.Vector3(0, 0, 1),  // front -> 2
  new THREE.Vector3(0, 0,-1)   // back  -> 5
];
const FACE_MAP = [1,6,3,4,2,5];
function topFaceValue(q: THREE.Quaternion) {
  let best = -Infinity, idx = 0; const up = new THREE.Vector3(0,1,0);
  for (let i = 0; i < FACE_DIRS.length; i++) {
    const v = FACE_DIRS[i].clone().applyQuaternion(q);
    const d = v.dot(up); if (d > best) { best = d; idx = i; }
  }
  return FACE_MAP[idx];
}

// Canonical orientation quaternions for each top face
function orientationForTop(n: number): THREE.Quaternion {
  const q = new THREE.Quaternion();
  switch(n){
    case 1: q.setFromEuler(new THREE.Euler(0,0,0)); break;
    case 2: q.setFromEuler(new THREE.Euler(-Math.PI/2,0,0)); break; // front up
    case 3: q.setFromEuler(new THREE.Euler(0,0, Math.PI/2)); break; // right up
    case 4: q.setFromEuler(new THREE.Euler(0,0,-Math.PI/2)); break; // left up
    case 5: q.setFromEuler(new THREE.Euler(Math.PI/2,0,0)); break; // back up
    case 6: q.setFromEuler(new THREE.Euler(Math.PI,0,0)); break; // bottom up
    default: q.identity();
  }
  return q;
}

function makeFeltTexture() {
  const s = 512; const c = document.createElement('canvas'); c.width = c.height = s; const ctx = c.getContext('2d')!;
  // deep casino green base
  ctx.fillStyle = '#0c7f36'; ctx.fillRect(0,0,s,s);
  // felt noise (coarse+fine)
  const img = ctx.getImageData(0,0,s,s); const d = img.data;
  for (let i=0;i<d.length;i+=4){
    const coarse = (Math.random()*16)|0; const fine = (Math.random()*8)|0;
    d[i] += coarse + fine; d[i+1] += coarse + fine; d[i+2] += coarse + fine;
  }
  ctx.putImageData(img,0,0);
  // subtle suit pattern (diamonds + clubs)
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = '#063d1b';
  const step = 64; const off = 16;
  for (let y = off; y < s; y += step) {
    for (let x = off; x < s; x += step) {
      if (((x+y)/step) % 2 < 1) drawDiamond(ctx, x, y, 12); else drawClub(ctx, x, y, 12);
    }
  }
  ctx.restore();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function drawDiamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number){
  ctx.beginPath();
  ctx.moveTo(cx, cy-r);
  ctx.lineTo(cx+r, cy);
  ctx.lineTo(cx, cy+r);
  ctx.lineTo(cx-r, cy);
  ctx.closePath();
  ctx.fill();
}
function drawClub(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number){
  const rr = r*0.45; const stemW = r*0.28; const stemH = r*0.55;
  ctx.beginPath();
  ctx.arc(cx-rr*0.9, cy-rr*0.2, rr, 0, Math.PI*2);
  ctx.arc(cx+rr*0.9, cy-rr*0.2, rr, 0, Math.PI*2);
  ctx.arc(cx, cy+rr*0.8, rr, 0, Math.PI*2);
  ctx.moveTo(cx - stemW/2, cy + rr*1.4);
  ctx.lineTo(cx + stemW/2, cy + rr*1.4);
  ctx.lineTo(cx, cy + rr*1.4 + stemH);
  ctx.closePath();
  ctx.fill();
}

// 汎用ノイズテクスチャ（粗さ/バンプ用）: meanを中心に±varでランダム
function makeNoiseTexture(size=256, mean=0.7, variation=0.2) {
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d')!;
  const img = g.createImageData(size, size); const d = img.data;
  const base = Math.floor(mean*255), amp = Math.floor(variation*255);
  for (let y=0;y<size;y++){
    for (let x=0;x<size;x++){
      const n = base + Math.floor((Math.random()*2-1)*amp);
      const i = (y*size+x)*4; d[i]=d[i+1]=d[i+2]=Math.max(0,Math.min(255,n)); d[i+3]=255;
    }
  }
  g.putImageData(img,0,0);
  const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(2,2); tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

// ダイス用ノイズ
const diceRough = makeNoiseTexture(256, 0.8, 0.1);
const diceBump = makeNoiseTexture(256, 0.5, 0.18);

// Casino bokeh background (blurred warm lights over deep burgundy)
function makeCasinoBokehTexture(){
  const s=1024; const c=document.createElement('canvas'); c.width=c.height=s; const g=c.getContext('2d')!;
  // bright warm gradient（怖くならない明るい背景）
  const lg=g.createLinearGradient(0,0,0,s);
  lg.addColorStop(0,'#fff4e8'); lg.addColorStop(1,'#ffe3d2');
  g.fillStyle=lg; g.fillRect(0,0,s,s);
  // blurred bokeh dots
  g.save();
  const dots = 160;
  for(let i=0;i<dots;i++){
    const x = Math.random()*s, y = Math.random()*s*0.9;
    const r = 10 + Math.random()*60;
    // warm hues biased to orange/gold
    const hue = 25 + Math.random()*35; // 25-60
    g.fillStyle = `hsla(${hue}, 85%, 66%, ${0.10 + Math.random()*0.16})`;
    g.beginPath();
    g.shadowColor = g.fillStyle;
    g.shadowBlur = 28 + Math.random()*48;
    g.arc(x,y,r,0,Math.PI*2);
    g.fill();
  }
  g.restore();
  // vignette は撤去（周辺の暗さをなくす）
  const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; return t;
}

// Leather texture (subtle grain + gradient highlight)
function makeLeatherTexture(size=512){
  const c=document.createElement('canvas'); c.width=c.height=size; const g=c.getContext('2d')!;
  const grad=g.createLinearGradient(0,0,0,size);
  grad.addColorStop(0,'#1d1d1d'); grad.addColorStop(0.5,'#2a2a2a'); grad.addColorStop(1,'#1c1c1c');
  g.fillStyle=grad; g.fillRect(0,0,size,size);
  const img=g.getImageData(0,0,size,size); const d=img.data;
  for(let i=0;i<d.length;i+=4){
    const n = (Math.random()*14)|0; d[i]+=n; d[i+1]+=n; d[i+2]+=n;
  }
  g.putImageData(img,0,0);
  return new THREE.CanvasTexture(c);
}

// Simple wood grain
function makeWoodTexture(size=1024){
  const c=document.createElement('canvas'); c.width=c.height=size; const g=c.getContext('2d')!;
  for(let y=0;y<size;y++){
    for(let x=0;x<size;x++){
      const nx = x/size; const ny=y/size;
      const stripes = Math.sin((nx*48) + Math.sin(ny*6)*0.5);
      const n = 0.5 + 0.5*stripes + (Math.random()*0.06);
      // bias to deep red mahogany
      const r = Math.floor(110 + n*110), gr = Math.floor(35 + n*55), b = Math.floor(28 + n*40);
      g.fillStyle = `rgb(${r},${gr},${b})`;
      g.fillRect(x,y,1,1);
    }
  }
  return new THREE.CanvasTexture(c);
}

// Boot
resize();
(async () => {
  await initPhysics();
  requestAnimationFrame(tick);
})();
