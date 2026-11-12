import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const V2 = THREE.Vector2, V3 = THREE.Vector3;

// ---------------------------------------------------------------------------
// World layout (meters, Y up)
// ---------------------------------------------------------------------------
const PASTURE = { x0: -60, x1: 60, z0: -46, z1: 46 };
const EAST_GATE = { z0: -5, z1: 5 };
const SOUTH_GATE = { x0: -5, x1: 5 };
const FARM = { x: -32, z: -24, s: 9, groundY: -0.359 };
const FARM_RECT = { x0: FARM.x - 9.3, x1: FARM.x + 8.7, z0: FARM.z - 8.6, z1: FARM.z + 8.7 };
const WHEAT_FIELD = { x0: 66, x1: 200, z0: -75, z1: 75 };
const WHEAT_PATCH = { x0: 22, x1: 52, z0: 18, z1: 40 };
const PATH = { x0: 38, x1: 205, z0: -2.2, z1: 2.2 };
const ROAD = { x0: -340, x1: 340, z0: -128, z1: -114 };
const WORLD_RADIUS = 420;
// Meshy buildings. Each model faces +Z locally; hx/hz are footprint half sizes in meters.
const BARN = { file: 'barn', x: 32, z: -31, s: 7, yaw: 0, hx: 6.0, hz: 6.7, pad: 0 };
const CHAPEL = { file: 'chapel', x: -95, z: 72, s: 24, yaw: Math.atan2(95, -72), hx: 10.6, hz: 23, pad: 28 };
const MILL = { file: 'windmill', x: 122, z: 98, s: 8, yaw: Math.atan2(-22, -98), hx: 3.8, hz: 3.8, pad: 9 };
// Farmhouse faces +X locally; the door points back toward the pasture.
const HOUSE = { file: 'house', x: 44, z: 72, s: 10, yaw: Math.atan2(72, -44), hx: 9.6, hz: 2.9, pad: 14 };
const BUILDINGS = [BARN, CHAPEL, MILL, HOUSE];

const WALK_SPEED = 1.3;
const TROT_SPEED = 6.2;

// ---------------------------------------------------------------------------
// Terrain + masks. The GLSL copy below must stay identical to these.
// ---------------------------------------------------------------------------
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function baseTerrain(x, z) {
  const d = Math.hypot(x, z);
  const m = sstep(80, 180, d);
  const h = 6 * Math.sin(x * 0.013 + 1.3) * Math.cos(z * 0.011 - 0.7) + 3 * Math.sin(x * 0.029 + z * 0.021)
    + 1.2 * Math.sin(z * 0.053 - x * 0.037 + 2.0) + 3;
  return m * h + sstep(380, 700, d) * 70;
}
// Flat building pads blended into the hills
const PADS = BUILDINGS.filter((b) => b.pad > 0).map((b) => ({ x: b.x, z: b.z, r: b.pad, h: baseTerrain(b.x, b.z) }));
function terrainH(x, z) {
  let h = baseTerrain(x, z);
  for (const p of PADS) h += (p.h - h) * (1 - sstep(p.r, p.r + 16, Math.hypot(x - p.x, z - p.z)));
  return h;
}
function bldgMask(x, z) {
  let m = 0;
  for (const b of BUILDINGS) {
    const dx = x - b.x, dz = z - b.z, c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const lx = c * dx - s * dz, lz = s * dx + c * dz;
    m = Math.max(m, rectMask(lx, lz, { x0: -b.hx, x1: b.hx, z0: -b.hz, z1: b.hz }, 1.2));
  }
  return m;
}
const rectMask = (x, z, r, e) =>
  sstep(r.x0 - e, r.x0 + e, x) * (1 - sstep(r.x1 - e, r.x1 + e, x)) * sstep(r.z0 - e, r.z0 + e, z) * (1 - sstep(r.z1 - e, r.z1 + e, z));
const pathMask = (x, z) => rectMask(x, z, PATH, 1.0);
const roadMask = (x, z) => rectMask(x, z, ROAD, 0.6);
const wheatMask = (x, z) => Math.max(rectMask(x, z, WHEAT_FIELD, 2), rectMask(x, z, WHEAT_PATCH, 1.5)) * (1 - pathMask(x, z));
const farmMask = (x, z) => rectMask(x, z, FARM_RECT, 1.5);

const f = (n) => Number(n).toFixed(3);
const rv = (r) => `vec4(${f(r.x0)}, ${f(r.x1)}, ${f(r.z0)}, ${f(r.z1)})`;
const GLSL_WORLD = /* glsl */`
float sstep(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float baseTerrain(vec2 p) {
  float d = length(p);
  float m = sstep(80.0, 180.0, d);
  float h = 6.0 * sin(p.x * 0.013 + 1.3) * cos(p.y * 0.011 - 0.7) + 3.0 * sin(p.x * 0.029 + p.y * 0.021)
          + 1.2 * sin(p.y * 0.053 - p.x * 0.037 + 2.0) + 3.0;
  return m * h + sstep(380.0, 700.0, d) * 70.0;
}
float terrainH(vec2 p) {
  float h = baseTerrain(p);
  ${PADS.map((q) => `h += (${f(q.h)} - h) * (1.0 - sstep(${f(q.r)}, ${f(q.r + 16)}, length(p - vec2(${f(q.x)}, ${f(q.z)}))));`).join('\n  ')}
  return h;
}
float rectMask(vec2 p, vec4 r, float e) {
  return sstep(r.x - e, r.x + e, p.x) * (1.0 - sstep(r.y - e, r.y + e, p.x)) * sstep(r.z - e, r.z + e, p.y) * (1.0 - sstep(r.w - e, r.w + e, p.y));
}
float pathMask(vec2 p) { return rectMask(p, ${rv(PATH)}, 1.0); }
float roadMask(vec2 p) { return rectMask(p, ${rv(ROAD)}, 0.6); }
float wheatMask(vec2 p) { return max(rectMask(p, ${rv(WHEAT_FIELD)}, 2.0), rectMask(p, ${rv(WHEAT_PATCH)}, 1.5)) * (1.0 - pathMask(p)); }
float farmMask(vec2 p) { return rectMask(p, ${rv(FARM_RECT)}, 1.5); }
float bldgMask(vec2 p) {
  float m = 0.0;
  vec2 d;
  ${BUILDINGS.map((b) => `d = p - vec2(${f(b.x)}, ${f(b.z)});
  m = max(m, rectMask(vec2(${f(Math.cos(b.yaw))} * d.x - ${f(Math.sin(b.yaw))} * d.y, ${f(Math.sin(b.yaw))} * d.x + ${f(Math.cos(b.yaw))} * d.y), vec4(${f(-b.hx)}, ${f(b.hx)}, ${f(-b.hz)}, ${f(b.hz)}), 1.2));`).join('\n  ')}
  return m;
}
float grassMask(vec2 p) { return (1.0 - wheatMask(p) * 0.97) * (1.0 - pathMask(p)) * (1.0 - roadMask(p)) * (1.0 - farmMask(p) * 0.6) * (1.0 - bldgMask(p)); }
`;

function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const rand = mulberry32(20261111);
const lerpAngle = (a, b, t) => { let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * t; };

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const FOG_COLOR = new THREE.Color('#a4d6f5');
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0019);
scene.background = FOG_COLOR;
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 3000);

const hemi = new THREE.HemisphereLight(0xd6ecff, 0x56732f, 1.15);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d2, 2.7);
const SUN_DIR = new V3(0.55, 0.78, 0.32).normalize();
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 300 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

// ---------------------------------------------------------------------------
// Nublado → soleado → atardecer → nublado con lluvia → noche → mañana
// ---------------------------------------------------------------------------
const DAY_SECONDS = 480;
const C = (h) => new THREE.Color(h);
const DAY_KEYS = [
  { t: 0.00, name: 'Nublado', rain: 0, tint: C('#c8ccd1'), top: C('#7d8894'), fog: C('#6e787f'), glow: C('#000000'), cloud: 1, stars: 0, sunI: 0.35, sunC: C('#dfe6ee'), hemiI: 1.45, hemiS: C('#d5dde5'), hemiG: C('#4f5f3c'), exp: 1.0, env: 0.45, el: 0.55, fogD: 0.0022 },
  { t: 0.12, name: 'Soleado', rain: 0, tint: C('#ffffff'), top: C('#1267c2'), fog: C('#5f94b8'), glow: C('#fff2d0'), cloud: 0, stars: 0, sunI: 2.7, sunC: C('#fff0d2'), hemiI: 1.15, hemiS: C('#d6ecff'), hemiG: C('#56732f'), exp: 1.05, env: 0.35, el: 0.89, fogD: 0.0010 },
  { t: 0.40, name: 'Soleado', rain: 0, tint: C('#ffffff'), top: C('#1267c2'), fog: C('#5f94b8'), glow: C('#fff2d0'), cloud: 0, stars: 0, sunI: 2.7, sunC: C('#fff0d2'), hemiI: 1.15, hemiS: C('#d6ecff'), hemiG: C('#56732f'), exp: 1.05, env: 0.35, el: 0.72, fogD: 0.0010 },
  { t: 0.46, name: 'Atardecer', rain: 0, tint: C('#ffb98c'), top: C('#33508a'), fog: C('#c47a52'), glow: C('#ff8a40'), cloud: 0.25, stars: 0.05, sunI: 1.7, sunC: C('#ff9a5a'), hemiI: 0.7, hemiS: C('#ffc6a0'), hemiG: C('#47532a'), exp: 0.95, env: 0.22, el: 0.12, fogD: 0.0015 },
  { t: 0.58, name: 'Nublado', rain: 1, tint: C('#b7bcc2'), top: C('#6d7884'), fog: C('#5e686f'), glow: C('#000000'), cloud: 1, stars: 0, sunI: 0.28, sunC: C('#d5dde6'), hemiI: 1.35, hemiS: C('#c9d2db'), hemiG: C('#465636'), exp: 0.95, env: 0.4, el: 0.4, fogD: 0.0026 },
  { t: 0.70, name: 'Noche', rain: 0, tint: C('#1f2747'), top: C('#050b1e'), fog: C('#10182c'), glow: C('#000000'), cloud: 0.1, stars: 1, sunI: 0.4, sunC: C('#9fb8ff'), hemiI: 0.35, hemiS: C('#5070b0'), hemiG: C('#1c2618'), exp: 0.9, env: 0.08, el: 0.5, fogD: 0.0016 },
  { t: 0.86, name: 'Mañana', rain: 0, tint: C('#fff0dc'), top: C('#2f74c4'), fog: C('#7eabca'), glow: C('#ffd8a0'), cloud: 0.05, stars: 0, sunI: 2.3, sunC: C('#ffe0b8'), hemiI: 1.0, hemiS: C('#e2ecff'), hemiG: C('#56732f'), exp: 1.0, env: 0.3, el: 0.42, fogD: 0.0012 },
];
const SKY_U = {
  uTop: { value: new THREE.Color() }, uTint: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() },
  uSunDir: { value: SUN_DIR }, uCloud: { value: 0 }, uStars: { value: 0 },
};
const day = { t: 0, name: 'Nublado', rain: false };
const _ca = new THREE.Color(), _cb = new THREE.Color();
function updateDay(dt) {
  day.t = (day.t + dt / DAY_SECONDS) % 1;
  let i = DAY_KEYS.length - 1;
  while (i > 0 && DAY_KEYS[i].t > day.t) i--;
  const a = DAY_KEYS[i], b = DAY_KEYS[(i + 1) % DAY_KEYS.length];
  const span = ((b.t - a.t) + 1) % 1 || 1;
  const u = (((day.t - a.t) + 1) % 1) / span;
  const edge = Math.min(0.65, (20 / DAY_SECONDS) / span);
  const k = u <= 1 - edge ? 0 : sstep(1 - edge, 1, u);
  const lerp = (x, y) => x + (y - x) * k;
  const col = (key, out) => out.copy(a[key]).lerp(b[key], k);
  day.name = a.name;
  day.rain = !!a.rain;

  col('fog', FOG_COLOR); scene.fog.color.copy(FOG_COLOR);
  scene.fog.density = lerp(a.fogD, b.fogD);
  col('top', SKY_U.uTop.value); col('tint', SKY_U.uTint.value); col('glow', SKY_U.uGlow.value);
  SKY_U.uCloud.value = lerp(a.cloud, b.cloud);
  SKY_U.uStars.value = lerp(a.stars, b.stars);
  sun.intensity = lerp(a.sunI, b.sunI); col('sunC', sun.color);
  hemi.intensity = lerp(a.hemiI, b.hemiI); col('hemiS', hemi.color); col('hemiG', hemi.groundColor);
  renderer.toneMappingExposure = lerp(a.exp, b.exp);
  scene.environmentIntensity = lerp(a.env, b.env);
  const el = lerp(a.el, b.el), az = 1.04 + (day.t - 0.25) * 2.4;
  SUN_DIR.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  sun.shadow.radius = 1 + SKY_U.uCloud.value * 6;
}

// Shared uniforms for wind / trampling
const U = {
  uTime: { value: 0 },
  uCow: { value: new V3() },
  uCenter: { value: new V2() },
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
const loadBar = document.getElementById('loadBar');
const loadText = document.getElementById('loadText');
const progress = {};
const EXPECTED = { cow: 5.8e6, farm: 2.3e6, wheat: 9.0e6, grass: 14.5e6, barn: 18.6e6, chapel: 8.7e6, windmill: 2.4e6, birch_mid: 3.2e6, birch_far: 0.9e6, bare: 0.55e6, house: 7.9e6, bale: 0.33e6, bull: 4.82e6, tractor: 6.7e6, harvest: 5.13e6, truck: 4.5e6, trough: 4.6e6, bus: 5.4e6, shelter: 8.6e6, horse: 2.29e6, pig: 1.24e6, duck: 1.53e6 };
function updateProgress() {
  const total = Object.values(EXPECTED).reduce((a, b) => a + b, 0);
  const done = Object.entries(progress).reduce((a, [k, v]) => a + Math.min(v, EXPECTED[k]), 0);
  loadBar.style.width = `${Math.round(done / total * 100)}%`;
  loadText.textContent = `Cargando el campo… ${(done / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`;
}
const gltfLoader = new GLTFLoader();
const loadGLB = (name) => new Promise((res, rej) => gltfLoader.load(`assets/${name}.glb`, res, (e) => { progress[name] = e.loaded; updateProgress(); }, rej));
const texLoader = new THREE.TextureLoader();
const loadTex = (url) => new Promise((res, rej) => texLoader.load(url, res, undefined, rej));

// ---------------------------------------------------------------------------
// Procedural canvas textures
// ---------------------------------------------------------------------------
function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
const woodTex = canvasTex(256, 64, (g, w, h) => {
  g.fillStyle = '#a38a6c'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 90; i++) {
    g.strokeStyle = `rgba(${60 + rand() * 40},${45 + rand() * 30},${30 + rand() * 20},${0.15 + rand() * 0.25})`;
    g.lineWidth = 1 + rand() * 2; const y = rand() * h;
    g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(w * 0.3, y + (rand() - 0.5) * 8, w * 0.7, y + (rand() - 0.5) * 8, w, y + (rand() - 0.5) * 4); g.stroke();
  }
});
// ---------------------------------------------------------------------------
// Sky dome (user sky photo, mirrored to loop around the horizon)
// ---------------------------------------------------------------------------
function buildSky(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  const mat = new THREE.ShaderMaterial({
    uniforms: Object.assign(SKY_U, { tSky: { value: tex }, uHorizon: { value: FOG_COLOR }, uTime: U.uTime }),
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() { vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tSky; uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uTint; uniform vec3 uGlow;
      uniform vec3 uSunDir; uniform float uCloud; uniform float uStars; uniform float uTime;
      varying vec3 vDir;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        float el = asin(clamp(d.y, -1.0, 1.0));
        float u = atan(d.x, d.z) / 6.2831853 * 3.0 + uTime * 0.004;
        float v = (el + 0.03) / 0.56;
        vec3 c = texture2D(tSky, vec2(u, clamp(v, 0.004, 0.996))).rgb;
        float lum = dot(c, vec3(0.3, 0.59, 0.11));
        c = mix(c * uTint, uHorizon * (0.72 + lum * 0.45), uCloud);
        c = mix(c, uTop, smoothstep(0.86, 1.3, v));
        float low = 1.0 - smoothstep(0.0, 0.55, v);
        c = mix(c, mix(uHorizon, uTop, 0.4), low * 0.72);
        float sd = max(dot(d, uSunDir), 0.0);
        c += uGlow * (pow(sd, 6.0) * 0.55 + pow(sd, 400.0) * 1.5) * (1.0 - uCloud * 0.8);
        if (uStars > 0.0) {
          vec3 grid = d * 720.0;
          vec3 cell = floor(grid);
          float h = hash(cell);
          float tw = 0.4 + 0.2 * sin(uTime * (2.0 + h * 5.0) + h * 60.0);
          float point = smoothstep(0.38, 0.0, length(fract(grid) - 0.5));
          c += vec3(0.72, 0.8, 1.0) * step(0.9968, h) * point * tw * 0.45 * uStars * (1.0 - uCloud) * smoothstep(0.08, 0.35, d.y);
          c += vec3(0.85, 0.9, 1.0) * smoothstep(0.99955, 0.9997, sd) * uStars;
        }
        c = mix(uHorizon, c, smoothstep(-0.04, 0.2, v));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 48, 24), mat);
  sky.frustumCulled = false; sky.renderOrder = -1;
  scene.add(sky);
  return sky;
}

// ---------------------------------------------------------------------------
// Ground (user grass texture, de-tiled with two scales + masks)
// ---------------------------------------------------------------------------
function buildGround(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;
  const geo = new THREE.PlaneGeometry(1600, 1600, 320, 320);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, terrainH(p.getX(i), p.getZ(i)));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  mat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\n' + GLSL_WORLD)
      .replace('#include <map_fragment>', /* glsl */`
        vec2 wp = vWPos.xz;
        vec2 uv = vec2(wp.x / 3.2, wp.y / 1.8);
        vec3 g = texture2D(map, uv).rgb;
        vec3 tA = g;
        float lum = dot(g, vec3(0.3, 0.6, 0.1));
        g = mix(g, vec3(lum) * vec3(2.3, 1.7, 0.75), wheatMask(wp) * 0.75);
        vec3 dirt = vec3(0.17, 0.11, 0.055) * (0.75 + tA.g * 1.4);
        g = mix(g, dirt, max(pathMask(wp) * 0.92, max(farmMask(wp), bldgMask(wp)) * 0.5));
        float rd = roadMask(wp);
        vec3 asphalt = vec3(0.16, 0.16, 0.18);
        float dash = step(0.55, abs(sin(wp.x * 0.45)));
        float lane = 1.0 - smoothstep(0.12, 0.4, abs(wp.y - -121.0));
        asphalt = mix(asphalt, vec3(0.9, 0.78, 0.22), dash * lane);
        g = mix(g, asphalt, rd);
        diffuseColor.rgb *= g;`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// ---------------------------------------------------------------------------
// Impostors: render a GLB (grass / wheat) from 3 angles into one atlas, then
// use it on thousands of star-shaped cards so whole fields stay cheap.
// ---------------------------------------------------------------------------
const VIEWS = 3;
function makeImpostor(obj, fringe, width = 1024) {
  const src = obj.clone(true);
  src.position.set(0, 0, 0); src.rotation.set(0, 0, 0); src.scale.set(1, 1, 1);
  src.traverse((o) => {
    if (o.isMesh) o.material = new THREE.MeshBasicMaterial({ map: o.material.map, color: o.material.color, side: THREE.DoubleSide });
  });
  src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src);
  const size = box.getSize(new V3());
  const R = Math.hypot(Math.max(-box.min.x, box.max.x), Math.max(-box.min.z, box.max.z));
  const height = Math.round(width * size.y / (2 * R));
  const rt = new THREE.WebGLRenderTarget(width * VIEWS, height, { samples: 4, type: THREE.HalfFloatType });
  rt.texture.generateMipmaps = true;
  rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
  const cam = new THREE.OrthographicCamera(-R, R, box.max.y, box.min.y, 0.01, R * 2 + 2);
  cam.position.set(0, 0, R + 1);
  const tmp = new THREE.Scene(); tmp.add(src);
  const prevColor = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(fringe, 0); renderer.clear();
  rt.scissorTest = true;
  for (let i = 0; i < VIEWS; i++) {
    src.rotation.y = -i * Math.PI / VIEWS;
    rt.viewport.set(i * width, 0, width, height); rt.scissor.set(i * width, 0, width, height);
    renderer.setRenderTarget(rt);
    renderer.render(tmp, cam);
  }
  rt.scissorTest = false;
  rt.viewport.set(0, 0, width * VIEWS, height);
  renderer.setRenderTarget(null);
  renderer.setClearColor(prevColor, prevAlpha);
  return { texture: rt.texture, aspect: (2 * R) / size.y };
}

// items: [{x, y, z, rot, h, tint}]. With opts.wrap, x/z are offsets inside a
// tile that follows the player (infinite carpet) and y comes from the terrain.
function buildCardField(imp, items, { wrap = 0, tint = [1, 1, 1], ao = 0.55, ground = null } = {}) {
  const base = [], uv = [];
  for (let q = 0; q < VIEWS; q++) {
    const a = q * Math.PI / VIEWS, c = Math.cos(a), s = Math.sin(a);
    for (const [x, y] of [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]]) { base.push(x * c, y, -x * s); uv.push((q + x + 0.5) / VIEWS, y); }
  }
  const index = [];
  for (let q = 0; q < VIEWS; q++) { const o = q * 4; index.push(o, o + 1, o + 2, o, o + 2, o + 3); }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(base, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(base.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(index);
  const a1 = new Float32Array(items.length * 4), a2 = new Float32Array(items.length * 3);
  items.forEach((it, i) => {
    a1.set([it.x, it.y, it.z, it.rot], i * 4);
    a2.set([it.h * imp.aspect, it.h, it.tint], i * 3);
  });
  geo.setAttribute('aInst', new THREE.InstancedBufferAttribute(a1, 4));
  geo.setAttribute('aInst2', new THREE.InstancedBufferAttribute(a2, 3));
  geo.instanceCount = items.length;
  const mat = new THREE.MeshLambertMaterial({ map: imp.texture, side: THREE.DoubleSide, alphaTest: 0.45, alphaToCoverage: true });
  mat.defines = {};
  if (wrap) mat.defines.WRAP = '';
  if (ground) mat.defines.GROUND = '';
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, U, { uTile: { value: wrap }, uTint: { value: new V3(...tint) }, uAO: { value: ao }, uGround: { value: ground } });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aInst; attribute vec3 aInst2;
        uniform float uTime; uniform vec3 uCow; uniform vec2 uCenter; uniform float uTile;
        varying float vH; varying float vTint; varying vec2 vWp;
        ${GLSL_WORLD}`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', /* glsl */`
        #ifdef WRAP
          vec2 wp = aInst.xz + uTile * floor((uCenter - aInst.xz) / uTile + 0.5);
          float k = (1.0 - sstep(uTile * 0.3, uTile * 0.5, length(wp - uCenter))) * grassMask(wp);
          vec3 origin = vec3(wp.x, terrainH(wp) - 0.05, wp.y);
        #else
          vec2 wp = aInst.xz;
          float k = 1.0;
          vec3 origin = aInst.xyz;
        #endif
        float sr = sin(aInst.w), cr = cos(aInst.w);
        vec3 p = vec3(position.x * aInst2.x, position.y * aInst2.y, position.z * aInst2.x) * k;
        p = vec3(cr * p.x + sr * p.z, p.y, -sr * p.x + cr * p.z);
        float hy = position.y;
        float sway = (sin(uTime * 1.3 + wp.x * 0.21 + wp.y * 0.17) + 0.5 * sin(uTime * 2.7 + wp.x * 0.5)) * 0.07 * aInst2.y * k;
        p.x += sway * hy * hy; p.z += sway * 0.5 * hy * hy;
        vec2 toC = wp - uCow.xz; float dC = length(toC);
        float push = 1.0 - smoothstep(0.5, 1.7, dC);
        p.xz += (toC / max(dC, 0.001)) * push * hy * 0.8 * aInst2.y * k;
        p.y *= 1.0 - push * 0.4;
        vec3 transformed = p + origin;
        vH = hy; vTint = aInst2.z; vWp = wp;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uTint; uniform float uAO; uniform sampler2D uGround;
        varying float vH; varying float vTint; varying vec2 vWp;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        #ifdef GROUND
          vec3 blade = vec3(0.25, 0.29, 0.075);
          float lum = dot(diffuseColor.rgb, vec3(0.33));
          float shade = mix(0.45, 1.5, smoothstep(0.03, 0.3, lum)) * mix(0.65, 1.15, vH);
          diffuseColor.rgb = blade * shade;
        #else
          diffuseColor.rgb *= mix(uAO, 1.08, vH) * vTint * uTint;
        #endif`)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
  };
  mat.customProgramCacheKey = () => (wrap ? 'w' : 'c') + (ground ? 'g' : '');
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

// Real 3D copies of the GLB foliage, swaying with the same wind as the cards.
const nearFoliage = [];
function addWindToMaterial(mat, yMin, height, scale) {
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, U, { uYMin: { value: yMin }, uHeight: { value: height }, uInvScale: { value: 1 / scale } });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec3 uCow; uniform float uYMin; uniform float uHeight; uniform float uInvScale;')
      .replace('#include <begin_vertex>', /* glsl */`
        vec3 transformed = vec3(position);
        float hy = clamp((position.y - uYMin) / uHeight, 0.0, 1.0);
        vec2 wp = vec2(modelMatrix[3][0], modelMatrix[3][2]);
        float sway = (sin(uTime * 1.3 + wp.x * 0.21 + wp.y * 0.17) + 0.5 * sin(uTime * 2.7 + wp.x * 0.5)) * 0.07 * uHeight;
        vec3 wdir = (inverse(mat3(modelMatrix)) * vec3(1.0, 0.0, 0.5));
        transformed += wdir * sway * hy * hy;`);
  };
  mat.customProgramCacheKey = () => 'wind';
}
function placeRealFoliage(gltf, scale, spots) {
  const root = gltf.scene;
  const box = new THREE.Box3().setFromObject(root);
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    o.material.side = THREE.DoubleSide;
    o.material.metalness = 0;
    addWindToMaterial(o.material, box.min.y, box.max.y - box.min.y, 1);
  });
  for (const s of spots) {
    const c = root.clone(true);
    c.scale.setScalar(scale * s.k);
    c.rotation.y = s.rot;
    c.position.set(s.x, terrainH(s.x, s.z) - box.min.y * scale * s.k - 0.03, s.z);
    c.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(c);
    nearFoliage.push(c);
  }
}

// ---------------------------------------------------------------------------
// Collision world
// ---------------------------------------------------------------------------
const segs = [];
const circles = [];
const addSeg = (ax, az, bx, bz, r = 0.12) => segs.push({ ax, az, bx, bz, r });
const addBox = (x0, z0, x1, z1) => { addSeg(x0, z0, x1, z0, 0); addSeg(x1, z0, x1, z1, 0); addSeg(x1, z1, x0, z1, 0); addSeg(x0, z1, x0, z0, 0); };
const _push = new V2();
function pushOut(x, z, r) {
  _push.set(0, 0);
  for (const s of segs) {
    const dx = s.bx - s.ax, dz = s.bz - s.az;
    const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (dx * dx + dz * dz)));
    const cx = s.ax + dx * t, cz = s.az + dz * t;
    const ex = x - cx, ez = z - cz, d = Math.hypot(ex, ez), min = r + s.r;
    if (d < min && d > 1e-6) { _push.x += ex / d * (min - d); _push.y += ez / d * (min - d); x += ex / d * (min - d); z += ez / d * (min - d); }
  }
  for (const c of circles) {
    if (Math.abs(x - c.x) > c.r + r || Math.abs(z - c.z) > c.r + r) continue;
    const ex = x - c.x, ez = z - c.z, d = Math.hypot(ex, ez), min = r + c.r;
    if (d < min && d > 1e-6) { _push.x += ex / d * (min - d); _push.y += ez / d * (min - d); x += ex / d * (min - d); z += ez / d * (min - d); }
  }
  return _push;
}
// A cow is long, so collide with two circles (chest and hips).
function collideCow(pos, yaw, size = 1) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  for (let it = 0; it < 2; it++) {
    for (const k of [0.75 * size, -0.75 * size]) {
      const p = pushOut(pos.x + fx * k, pos.z + fz * k, 0.6 * size);
      pos.x += p.x; pos.z += p.y;
    }
  }
  const d = Math.hypot(pos.x, pos.z);
  if (d > WORLD_RADIUS) { pos.x *= WORLD_RADIUS / d; pos.z *= WORLD_RADIUS / d; }
}

// ---------------------------------------------------------------------------
// Fences (big pasture), gates, hay, trough, trees
// ---------------------------------------------------------------------------
function buildPastureFence() {
  const { x0, x1, z0, z1 } = PASTURE;
  const pieces = [
    [x0, z0, x1, z0],
    [x1, z0, x1, EAST_GATE.z0], [x1, EAST_GATE.z1, x1, z1],
    [x1, z1, SOUTH_GATE.x1, z1], [SOUTH_GATE.x0, z1, x0, z1],
    [x0, z1, x0, z0],
  ];
  const posts = [], rails = [];
  for (const [ax, az, bx, bz] of pieces) {
    addSeg(ax, az, bx, bz);
    const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / 3));
    for (let i = 0; i <= n; i++) posts.push([ax + (bx - ax) * i / n, az + (bz - az) * i / n]);
    for (let i = 0; i < n; i++) rails.push([ax + (bx - ax) * i / n, az + (bz - az) * i / n, ax + (bx - ax) * (i + 1) / n, az + (bz - az) * (i + 1) / n]);
  }
  // Gates swung open outward
  const gates = [
    [x1, EAST_GATE.z1, x1 + 4.6, EAST_GATE.z1 + 0.6], [x1, EAST_GATE.z0, x1 + 4.6, EAST_GATE.z0 - 0.6],
    [SOUTH_GATE.x1, z1, SOUTH_GATE.x1 + 0.6, z1 + 4.6], [SOUTH_GATE.x0, z1, SOUTH_GATE.x0 - 0.6, z1 + 4.6],
  ];
  for (const g of gates) { addSeg(...g); posts.push([g[2], g[3]]); }

  const wood = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.95, metalness: 0 });
  const postGeo = new THREE.CylinderGeometry(0.09, 0.11, 1.55, 8); postGeo.translate(0, 0.775, 0);
  const postMesh = new THREE.InstancedMesh(postGeo, wood, posts.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new V3(1, 1, 1);
  posts.forEach(([x, z], i) => { m.compose(new V3(x, terrainH(x, z) - 0.05, z), q.setFromAxisAngle(new V3(0, 1, 0), rand() * 6), sc); postMesh.setMatrixAt(i, m); });
  const railGeo = new THREE.BoxGeometry(1, 0.13, 0.06);
  const railH = [0.45, 0.85, 1.25];
  const allRails = [...rails.map((r) => [...r, railH]), ...gates.map((g) => [...g, [0.35, 0.7, 1.05, 1.35]])];
  const railCount = allRails.reduce((a, r) => a + r[4].length, 0);
  const railMesh = new THREE.InstancedMesh(railGeo, wood, railCount);
  let k = 0;
  for (const [ax, az, bx, bz, hs] of allRails) {
    const len = Math.hypot(bx - ax, bz - az), yaw = Math.atan2(-(bz - az), bx - ax);
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    for (const h of hs) {
      m.compose(new V3(mx, terrainH(mx, mz) + h + (rand() - 0.5) * 0.04, mz), q.setFromAxisAngle(new V3(0, 1, 0), yaw), new V3(len + 0.2, 1, 1));
      railMesh.setMatrixAt(k++, m);
    }
  }
  for (const mesh of [postMesh, railMesh]) { mesh.castShadow = true; mesh.receiveShadow = true; scene.add(mesh); }
}

const BALES = [
  { x: -17, z: -30, rot: 0.4 }, { x: -15.1, z: -31.5, rot: 1.3 }, { x: -16.9, z: -33, rot: 2.3 },
  { x: -16.1, z: -31.1, rot: 0.7 }, { x: -16.1, z: -31.1, rot: 1.9, up: 1 },
  { x: 8, z: -38, rot: 0.2 }, { x: 10.1, z: -36.8, rot: 1.7 }, { x: -48, z: 30, rot: 0.9 },
  { x: 49.5, z: 68.6, rot: 0.5 }, { x: 51.6, z: 66.4, rot: 1.6 }, { x: 47.6, z: 67.2, rot: 2.4 },
  { x: 58, z: 12, rot: 0.3 }, { x: 60.4, z: 13.6, rot: 1.2 },
];
// ---------------------------------------------------------------------------
// Tractor: drives a slow loop around the wheat field. The GLB is one mesh,
// so the wheels are spun in the vertex shader by their position.
// ---------------------------------------------------------------------------
const TRACTOR = { s: 2.4, speed: 2.2, loop: { x0: 64, x1: 203, z0: -79, z1: 79, r: 9 } };
const tractor = { group: null, route: [], len: 0, dist: 0, yaw: 0, pitch: 0, roll: 0, pos: new V3(), uSpin: { value: 0 } };

function buildTractor(gltf) {
  const { x0, x1, z0, z1, r } = TRACTOR.loop;
  const corners = [[x1 - r, z0 + r, -Math.PI / 2], [x1 - r, z1 - r, 0], [x0 + r, z1 - r, Math.PI / 2], [x0 + r, z0 + r, Math.PI]];
  const pts = [];
  for (const [cx, cz, a0] of corners) for (let i = 0; i <= 12; i++) { const a = a0 + (i / 12) * Math.PI / 2; pts.push(new V2(cx + Math.cos(a) * r, cz + Math.sin(a) * r)); }
  pts.push(pts[0].clone());
  let len = 0;
  tractor.route = pts.map((p, i) => { if (i) len += p.distanceTo(pts[i - 1]); return { p, d: len }; });
  tractor.len = len;

  const model = gltf.scene;
  model.rotation.y = Math.PI / 2;
  model.position.y = 0.512;
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    o.material.side = THREE.FrontSide;
    o.material.onBeforeCompile = (sh) => {
      sh.uniforms.uSpin = tractor.uSpin;
      const spin = `
        uniform float uSpin;
        vec2 spinWheel(vec2 p, vec2 c, float r, float zmin, float az) {
          if (az < zmin || distance(p, c) > r) return vec2(1.0, 0.0);
          float a = uSpin / r;
          return vec2(cos(a), sin(a));
        }
        vec2 wheelRot(vec3 p) {
          float az = abs(p.z);
          vec2 r = spinWheel(p.xy, vec2(0.165, -0.237), 0.28, 0.2, az);
          if (r.y == 0.0) r = spinWheel(p.xy, vec2(-0.632, -0.288), 0.228, 0.2, az);
          return r;
        }
        vec2 wheelCenter(vec3 p) { return p.x > -0.3 ? vec2(0.165, -0.237) : vec2(-0.632, -0.288); }`;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + spin)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          vec2 wr = wheelRot(position);
          objectNormal.xy = mat2(wr.x, wr.y, -wr.y, wr.x) * objectNormal.xy;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          if (wr.y != 0.0 || wr.x != 1.0) {
            vec2 wc = wheelCenter(position);
            transformed.xy = wc + mat2(wr.x, wr.y, -wr.y, wr.x) * (position.xy - wc);
          }`);
    };
  });
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';
  group.scale.setScalar(TRACTOR.s);
  group.add(model);
  scene.add(group);
  tractor.group = group;
  tractor.dist = len * 0.62;
  updateTractor(0);
}

function routeAt(d) {
  const R = tractor.route;
  d = ((d % tractor.len) + tractor.len) % tractor.len;
  let i = 1;
  while (i < R.length - 1 && R[i].d < d) i++;
  const a = R[i - 1], b = R[i], k = (d - a.d) / Math.max(1e-6, b.d - a.d);
  return _rp.set(a.p.x + (b.p.x - a.p.x) * k, a.p.y + (b.p.y - a.p.y) * k);
}
const _rp = new V2();

function updateTractor(dt) {
  const step = TRACTOR.speed * dt;
  tractor.dist += step;
  tractor.uSpin.value += step / TRACTOR.s;
  const { x, y: z } = routeAt(tractor.dist);
  tractor.pos.set(x, 0, z);
  const ahead = routeAt(tractor.dist + 2.5);
  const want = Math.atan2(ahead.x - x, ahead.y - z);
  tractor.yaw = dt === 0 ? want : lerpAngle(tractor.yaw, want, Math.min(1, dt * 3));
  const fx = Math.sin(tractor.yaw), fz = Math.cos(tractor.yaw);
  const H = (u, v) => terrainH(x + fx * u + fz * v, z + fz * u - fx * v);
  tractor.pos.y = terrainH(x, z);
  const pitch = Math.atan2(H(1.6, 0) - H(-1.6, 0), 3.2), roll = Math.atan2(H(0, 0.9) - H(0, -0.9), 1.8);
  const k = dt === 0 ? 1 : Math.min(1, dt * 4);
  tractor.pitch += (pitch - tractor.pitch) * k;
  tractor.roll += (roll - tractor.roll) * k;
  tractor.group.position.copy(tractor.pos);
  tractor.group.rotation.set(-tractor.pitch, tractor.yaw, tractor.roll);
}

function pushFromTractor(pos) {
  const fx = Math.sin(tractor.yaw), fz = Math.cos(tractor.yaw);
  for (const k of [1.4, -1.1]) {
    const cx = tractor.pos.x + fx * k, cz = tractor.pos.z + fz * k;
    const dx = pos.x - cx, dz = pos.z - cz, d = Math.hypot(dx, dz), min = 2.0;
    if (d < min && d > 1e-4) { pos.x += dx / d * (min - d); pos.z += dz / d * (min - d); }
  }
}

// Bound harvest bundles: the only thing the cow scores by eating. A few
// start in the pasture and more show up near her as time passes.
const HARVEST_S = 1.15, HARVEST_MAX = 40;
const harvest = { mesh: null, slots: [], timer: 8, m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new V3(), s: new V3(), ring: null, ringTex: null };

function buildHarvest(gltf) {
  let geo, mat;
  gltf.scene.traverse((o) => { if (o.isMesh) { geo = o.geometry; mat = o.material; } });
  mat.metalness = 0;
  const mesh = new THREE.InstancedMesh(geo, mat, HARVEST_MAX);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  scene.add(mesh);
  harvest.mesh = mesh;
  const cnv = document.createElement('canvas'); cnv.width = cnv.height = 256;
  harvest.ringTex = new THREE.CanvasTexture(cnv);
  harvest.ringTex.colorSpace = THREE.SRGBColorSpace;
  const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: harvest.ringTex, transparent: true, depthWrite: false }));
  ring.scale.set(0.72, 0.72, 1);
  ring.visible = false;
  ring.renderOrder = 2;
  scene.add(ring);
  harvest.ring = ring;
  for (const [x, z] of [[-18, 18], [12, -14], [-34, -6], [4, 26], [-6, -26], [22, 8]]) addHarvest(x, z, true);
  for (let i = 0; i < 20; i++) spawnHarvestAnywhere();
}

function drawEatRing(p) {
  const g = harvest.ringTex.image.getContext('2d'), w = 256, c = 128, r = 92;
  g.clearRect(0, 0, w, w);
  g.beginPath(); g.arc(c, c, 78, 0, 7); g.fillStyle = 'rgba(28, 36, 16, .42)'; g.fill();
  g.beginPath(); g.arc(c, c, r, 0, 7); g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 16; g.stroke();
  g.beginPath(); g.arc(c, c, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
  g.strokeStyle = '#ffe27a'; g.lineWidth = 16; g.lineCap = 'round'; g.stroke();
  g.beginPath(); g.arc(c, c, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 4; g.stroke();
  harvest.ringTex.needsUpdate = true;
}

function harvestOk(x, z) {
  if (Math.hypot(x, z) > WORLD_RADIUS - 20) return false;
  if (wheatMask(x, z) > 0.15 || pathMask(x, z) > 0.15 || roadMask(x, z) > 0.2 || bldgMask(x, z) > 0.1 || rectMask(x, z, FARM_RECT, 0) > 0.5) return false;
  return !harvest.slots.some((h) => h.alive && Math.hypot(h.x - x, h.z - z) < 8);
}

function addHarvest(x, z, force = false) {
  if (harvest.slots.filter((h) => h.alive).length >= HARVEST_MAX) return;
  if (!force && !harvestOk(x, z)) return;
  harvest.slots.push({ x, z, yaw: rand() * Math.PI, alive: true });
  syncHarvest();
}

function spawnHarvestAnywhere() {
  for (let i = 0; i < 40; i++) {
    const a = rand() * Math.PI * 2, d = rand() < 0.4 ? 8 + rand() * 50 : 20 + rand() * 230;
    const x = Math.sin(a) * d, z = Math.cos(a) * d;
    if (harvestOk(x, z)) { addHarvest(x, z); return; }
  }
}

function makeTag() {
  const cnv = document.createElement('canvas'); cnv.width = 128; cnv.height = 64;
  const tex = new THREE.CanvasTexture(cnv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(0.7, 0.35, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 3;
  scene.add(sprite);
  return { sprite, cnv, tex, n: -1 };
}

function drawTag(tag, n) {
  if (!tag || tag.n === n) return;
  tag.n = n;
  const g = tag.cnv.getContext('2d');
  g.clearRect(0, 0, 128, 64);
  g.font = '700 52px Inter, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#fff6d0';
  g.fillText(String(n), 64, 34);
  tag.tex.needsUpdate = true;
}

function syncHarvest() {
  let n = 0;
  for (const h of harvest.slots) {
    if (!h.alive && !(h.vanish > 0)) continue;
    const k = h.alive ? 1 : Math.max(0.001, h.vanish / 0.45);
    const chew = (h === eatBite || h.chewing) ? 0.9 + 0.1 * Math.sin(eatTimer * 14) : 1;
    harvest.p.set(h.x, terrainH(h.x, h.z) + 0.411 * HARVEST_S * k, h.z);
    harvest.q.setFromAxisAngle(AXES.Y, h.yaw + (1 - k) * 1.4);
    harvest.s.set(HARVEST_S * k, HARVEST_S * k * chew, HARVEST_S * k);
    harvest.mesh.setMatrixAt(n++, harvest.m.compose(harvest.p, harvest.q, harvest.s));
  }
  harvest.mesh.count = n;
  harvest.mesh.instanceMatrix.needsUpdate = true;
}

function updateHarvest(dt, t) {
  if (!harvest.mesh) return;
  let moving = false;
  for (const h of harvest.slots) {
    if (h.vanish > 0) { h.vanish -= dt; moving = true; }
  }
  if (moving) harvest.slots = harvest.slots.filter((h) => h.alive || h.vanish > 0);
  if (eatBite || moving) syncHarvest();
  const ring = harvest.ring;
  if (eatBite && ring) {
    ring.visible = true;
    ring.position.set(eatBite.x, terrainH(eatBite.x, eatBite.z) + 1.4 + Math.sin(t * 5) * 0.035, eatBite.z);
    drawEatRing(Math.min(1, eatTimer / EAT_HOLD));
  } else if (needs.drink > 0 && ring && player) {
    ring.visible = true;
    ring.position.set(player.pos.x, player.pos.y + 2.15, player.pos.z);
    drawEatRing(Math.min(1, needs.drink / DRINK_HOLD));
  } else if (player && player.asleep > 0 && ring) {
    ring.visible = true;
    ring.position.set(player.pos.x, player.pos.y + 2.25, player.pos.z);
    drawEatRing(Math.min(1, (SLEEP_TIME - player.asleep) / SLEEP_TIME));
  } else if (ring) ring.visible = false;
  if (player) for (const c of [player, ...npcs]) {
    if (!c.tag) continue;
    c.tag.sprite.position.set(c.pos.x, c.pos.y + 1.9 - (c.kneel || 0) * 0.7, c.pos.z);
    c.tag.sprite.visible = !(c === player && (needs.drink > 0 || eatBite));
  }
}

function nearestHarvest() {
  let best = null, bd = 2.2;
  for (const h of harvest.slots) {
    if (!h.alive) continue;
    const d = Math.hypot(h.x - player.pos.x, h.z - player.pos.z);
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}

function buildBales(gltf) {
  let src = null;
  gltf.scene.traverse((o) => { if (o.isMesh && !src) src = o; });
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const s = 1.15, dia = (box.max.y - box.min.y) * s;
  src.material.metalness = 0;
  const mesh = new THREE.InstancedMesh(src.geometry, src.material, BALES.length);
  mesh.castShadow = mesh.receiveShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  BALES.forEach((b, i) => {
    m.compose(new V3(b.x, terrainH(b.x, b.z) - box.min.y * s + (b.up || 0) * dia * 0.98, b.z), q.setFromAxisAngle(new V3(0, 1, 0), b.rot), new V3(s, s, s));
    mesh.setMatrixAt(i, m);
    if (!b.up) circles.push({ x: b.x, z: b.z, r: 0.95 });
  });
  scene.add(mesh);
}
function buildProps() {
  // Water trough
  const tx = -14, tz = -12;
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a949c, metalness: 0.6, roughness: 0.45 });
  const trough = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.7, 0.95), metal); shell.position.y = 0.35;
  const water = new THREE.Mesh(new THREE.PlaneGeometry(3.05, 0.8), new THREE.MeshStandardMaterial({ color: 0x3f86b8, roughness: 0.08, metalness: 0.1 }));
  water.rotation.x = -Math.PI / 2; water.position.y = 0.66;
  shell.castShadow = shell.receiveShadow = true;
  trough.add(shell, water); trough.position.set(tx, terrainH(tx, tz), tz); trough.rotation.y = 0.4;
  scene.add(trough);
  const c = Math.cos(0.4), s = Math.sin(0.4);
  addSeg(tx - 1.5 * c, tz + 1.5 * s, tx + 1.5 * c, tz - 1.5 * s, 0.5);
}

const TRUCK_S = 6.5;
const truck = { group: null, x: -80, dir: 1, yaw: 0, pos: new V3() };
function buildTruck(gltf) {
  const model = gltf.scene;
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.material.metalness = 0.15; } });
  const group = new THREE.Group();
  model.position.y = 0.244;
  group.scale.setScalar(TRUCK_S);
  group.add(model);
  scene.add(group);
  truck.group = group;
  updateTruck(0);
}
function updateTruck(dt) {
  if (!truck.group) return;
  truck.x += truck.dir * 6 * dt;
  if (truck.x > 300) truck.dir = -1;
  if (truck.x < -300) truck.dir = 1;
  truck.yaw = truck.dir > 0 ? Math.PI : 0;
  const z = (ROAD.z0 + ROAD.z1) / 2;
  truck.pos.set(truck.x, terrainH(truck.x, z), z);
  truck.group.position.set(truck.pos.x, truck.pos.y, truck.pos.z);
  truck.group.rotation.y = truck.yaw;
}
function vehicleOverlap(pos, veh, hx, hz) {
  if (!veh.group || !veh.group.visible) return null;
  const fx = Math.cos(veh.yaw), fz = -Math.sin(veh.yaw);
  const lx = (pos.x - veh.pos.x) * fx + (pos.z - veh.pos.z) * fz;
  const lz = (pos.x - veh.pos.x) * fz - (pos.z - veh.pos.z) * fx;
  if (Math.abs(lx) >= hx || Math.abs(lz) >= hz) return null;
  return { lx, lz, fx, fz, hx, hz };
}
function pushFromVehicle(pos, veh, hx, hz) {
  const hit = vehicleOverlap(pos, veh, hx, hz);
  if (!hit) return;
  if (hit.hx - Math.abs(hit.lx) < hit.hz - Math.abs(hit.lz)) {
    pos.x += Math.sign(hit.lx || 1) * hit.fx * (hit.hx - Math.abs(hit.lx) + 0.05);
    pos.z += Math.sign(hit.lx || 1) * hit.fz * (hit.hx - Math.abs(hit.lx) + 0.05);
  } else {
    pos.x += Math.sign(hit.lz || 1) * hit.fz * (hit.hz - Math.abs(hit.lz) + 0.05);
    pos.z -= Math.sign(hit.lz || 1) * hit.fx * (hit.hz - Math.abs(hit.lz) + 0.05);
  }
}

const BUS_S = 6.4;
const bus = { group: null, x: 360, dir: -1, yaw: 0, pos: new V3(), active: false, wait: 8 };
function buildBus(gltf) {
  const model = gltf.scene;
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.material.metalness = 0.12; } });
  const group = new THREE.Group();
  model.position.y = 0.33;
  group.scale.setScalar(BUS_S);
  group.add(model);
  group.visible = false;
  scene.add(group);
  bus.group = group;
}
function updateBus(dt) {
  if (!bus.group) return;
  if (!bus.active) {
    bus.wait -= dt;
    if (bus.wait > 0) return;
    bus.active = true;
    bus.dir = rand() < 0.5 ? 1 : -1;
    bus.x = bus.dir > 0 ? -340 : 340;
    bus.group.visible = true;
  }
  bus.x += bus.dir * 10 * dt;
  bus.yaw = bus.dir > 0 ? Math.PI : 0;
  const z = (ROAD.z0 + ROAD.z1) / 2;
  bus.pos.set(bus.x, terrainH(bus.x, z), z);
  bus.group.position.set(bus.pos.x, bus.pos.y, bus.pos.z);
  bus.group.rotation.y = bus.yaw;
  if ((bus.dir > 0 && bus.x > 340) || (bus.dir < 0 && bus.x < -340)) {
    bus.active = false;
    bus.group.visible = false;
    bus.wait = 16 + rand() * 22;
  }
}

const SHELTERS = [
  { x: -40, z: 32, yaw: 0.4 },
  { x: 6, z: -18, yaw: -0.5 },
  { x: 50, z: 8, yaw: 1.2 },
  { x: -10, z: -36, yaw: 0.2 },
];
const SHELTER_S = 5.6;
const RAIN_PLAN = [0, 0, 1];
function buildShelters(gltf) {
  const src = gltf.scene;
  src.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.material.metalness = 0.04; } });
  for (const s of SHELTERS) {
    const model = src.clone(true);
    model.position.y = 0.392;
    const group = new THREE.Group();
    group.scale.setScalar(SHELTER_S);
    group.rotation.y = s.yaw;
    group.add(model);
    group.position.set(s.x, terrainH(s.x, s.z), s.z);
    scene.add(group);
    s.group = group;
  }
}
function shelterPoint(s, slot) {
  return { x: s.x + Math.cos(s.yaw) * slot, z: s.z - Math.sin(s.yaw) * slot };
}
function npcsAt(s) {
  let n = 0;
  for (const c of npcs) {
    if (c.shelter !== s) continue;
    if (Math.hypot(c.pos.x - s.x, c.pos.z - s.z) < 6) n++;
  }
  return n;
}

const rain = { on: false, left: 0, used: false, fade: 0, pts: null, pos: null, vel: null };
function buildRain() {
  const N = 650;
  const pos = new Float32Array(N * 3);
  const vel = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (rand() - 0.5) * 40;
    pos[i * 3 + 1] = rand() * 16;
    pos[i * 3 + 2] = (rand() - 0.5) * 40;
    vel[i] = 8 + rand() * 5;
  }
  const cnv = document.createElement('canvas'); cnv.width = 16; cnv.height = 64;
  const g = cnv.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 64);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.45, 'rgba(232,242,255,0.9)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(6, 0, 3, 64);
  const tex = new THREE.CanvasTexture(cnv);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    map: tex, color: 0xf4f8ff, size: 0.42, transparent: true, opacity: 0.45, depthWrite: false, sizeAttenuation: true,
  }));
  pts.frustumCulled = false;
  pts.visible = false;
  scene.add(pts);
  rain.pts = pts; rain.pos = pos; rain.vel = vel;
}
function beginRain() {
  rain.on = true;
  rain.left = 30;
  rain.used = true;
  npcs.forEach((c, i) => {
    c.shelter = SHELTERS[RAIN_PLAN[i]];
    c.slot = RAIN_PLAN[i] === 0 ? (i === 0 ? -1.5 : 1.5) : 0;
    c.asleep = 0;
    if (c.food && c.food.claimer === c) { c.food.claimer = null; c.food.chewing = false; }
    c.food = null;
  });
}
function updateRain(dt) {
  if (!rain.pts) return;
  if (!day.rain) rain.used = false;
  if (!rain.on && day.rain && !rain.used) beginRain();
  rain.fade += ((rain.on ? 1 : 0) - rain.fade) * Math.min(1, dt * 0.7);
  rain.pts.material.opacity = 0.45 * rain.fade;
  rain.pts.visible = rain.fade > 0.03;
  if (rain.on) {
    rain.left -= dt;
    if (rain.left <= 0) {
      rain.on = false;
      for (const c of npcs) c.shelter = null;
    }
  }
  if (!rain.on && rain.fade <= 0.03) return;
  const p = rain.pos;
  for (let i = 0; i < rain.vel.length; i++) {
    p[i * 3 + 1] -= rain.vel[i] * dt;
    if (p[i * 3 + 1] < 0) {
      p[i * 3] = (rand() - 0.5) * 40;
      p[i * 3 + 1] = 14 + rand() * 3;
      p[i * 3 + 2] = (rand() - 0.5) * 40;
    }
  }
  rain.pts.geometry.attributes.position.needsUpdate = true;
  rain.pts.position.set(camera.position.x, 0, camera.position.z);
}

const BEDS = [{ x: -6, z: 24 }, { x: 28, z: 14 }, { x: -26, z: -4 }];
const POND_AT = { x: -38, z: 13 };
const SLEEP_TIME = 30, DRINK_HOLD = 10;
const needs = { waterIn: 45, thirsty: false, sleepIn: 70, sleepy: false, drink: 0 };
let qHeld = false;
const markers = { arrow: null, zzz: null };

function canvasSprite(w, h, draw, sx, sy) {
  const cnv = document.createElement('canvas');
  cnv.width = w; cnv.height = h;
  draw(cnv.getContext('2d'));
  const tex = new THREE.CanvasTexture(cnv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(sx, sy, 1);
  sp.center.set(0.5, 0);
  sp.renderOrder = 4;
  sp.visible = false;
  scene.add(sp);
  return sp;
}
function buildTrough(gltf, zzzTex) {
  const model = gltf.scene;
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.material.metalness = 0.04; o.material.roughness = 0.72; } });
  const S = 2.6;
  model.scale.setScalar(S);
  model.position.y = 0.346 * S;
  const group = new THREE.Group();
  group.add(model);
  group.position.set(POND_AT.x, terrainH(POND_AT.x, POND_AT.z), POND_AT.z);
  scene.add(group);
  circles.push({ x: POND_AT.x, z: POND_AT.z, r: 2.3 });
  markers.arrow = canvasSprite(128, 128, (g) => {
    g.fillStyle = '#ffe14a';
    g.strokeStyle = '#6d4e08';
    g.lineWidth = 10;
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(64, 116);
    g.lineTo(14, 16);
    g.lineTo(114, 16);
    g.closePath();
    g.fill();
    g.stroke();
  }, 1.7, 1.5);
  zzzTex.colorSpace = THREE.SRGBColorSpace;
  const zzz = new THREE.Sprite(new THREE.SpriteMaterial({ map: zzzTex, transparent: true, depthWrite: false }));
  const za = zzzTex.image.height / zzzTex.image.width;
  zzz.scale.set(1.15, 1.15 * za, 1);
  zzz.center.set(0.5, 0);
  zzz.renderOrder = 4;
  zzz.visible = false;
  scene.add(zzz);
  markers.zzz = zzz;
}
function updateMarkers(t) {
  const arrow = markers.arrow, zzz = markers.zzz;
  if (!arrow || !zzz) return;
  const thirsty = !!(started && player && needs.thirsty && !(player.asleep > 0) && !(player.hurt > 0));
  arrow.visible = thirsty;
  if (thirsty) {
    const hop = Math.abs(Math.sin(t * 3.2));
    arrow.position.set(POND_AT.x, terrainH(POND_AT.x, POND_AT.z) + 2.15 + hop * 0.85, POND_AT.z);
    const s = 1 + hop * 0.12;
    arrow.scale.set(1.7 * s, 1.5 * s, 1);
  }
  const sleeping = !!(player && player.asleep > 0 && !(player.hurt > 0));
  zzz.visible = sleeping;
  if (sleeping) {
    const bob = Math.sin(t * 2.2) * 0.05;
    zzz.position.set(player.pos.x, player.pos.y + 3.5 - (player.kneel || 0) * 0.55 + bob, player.pos.z);
  }
}

function pickTreeSpots() {
  const spots = BIRCHES.map((b) => ({ ...b }));
  let guard = 0;
  while (spots.length < 30 && guard++ < 6000) {
    const a = rand() * Math.PI * 2, d = 85 + rand() * 300;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (x > 55 && x < 215 && z > -90 && z < 90) continue;
    if (roadMask(x, z) > 0) continue;
    if (BUILDINGS.some((b) => Math.hypot(b.x - x, b.z - z) < Math.max(b.hx, b.hz) + 10)) continue;
    if (BARE_TREES.some((b) => Math.hypot(b.x - x, b.z - z) < 10)) continue;
    if (BALES.some((b) => Math.hypot(b.x - x, b.z - z) < 6)) continue;
    if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 8)) continue;
    spots.push({ x, z, s: 5.5 + rand() * 2.5, rot: rand() * Math.PI * 2 });
  }
  return spots;
}

// ---------------------------------------------------------------------------
// Farm GLB (barn + shed + small corral). Gate is cut open so you can enter.
// ---------------------------------------------------------------------------
function buildFarm(gltf) {
  const farm = gltf.scene;
  farm.scale.setScalar(FARM.s);
  farm.position.set(FARM.x, -FARM.groundY * FARM.s + 0.01, FARM.z);
  const gateCut = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLocal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLocal;')
      .replace('void main() {', 'void main() {\nif (vLocal.x > 0.86 && vLocal.z > -0.145 && vLocal.z < 0.125) discard;');
  };
  farm.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    o.material.metalness = 0;
    o.material.onBeforeCompile = gateCut;
    o.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    o.customDepthMaterial.onBeforeCompile = gateCut;
  });
  scene.add(farm);

  const L = (x, z) => [FARM.x + x * FARM.s, FARM.z + z * FARM.s];
  const seg = (a, b) => addSeg(...L(...a), ...L(...b));
  seg([-1.03, -0.95], [0.95, -0.95]);
  seg([-1.03, -0.95], [-1.03, 0.97]);
  seg([-1.03, 0.97], [0.95, 0.97]);
  seg([0.95, -0.95], [0.95, -0.17]);
  seg([0.95, 0.15], [0.95, 0.97]);
  addBox(...L(-1.05, 0.05), ...L(-0.30, 0.53));
  addBox(...L(-1.05, 0.63), ...L(-0.40, 0.93));
}

// ---------------------------------------------------------------------------
// Chapel, barn and windmill (uncompressed GLBs)
// ---------------------------------------------------------------------------
const MILL_HUB = { x: 0.003, y: 0.344, zMin: 0.315, yMin: -0.45, r: 0.95 };
function spinSails(s) {
  s.uniforms.uTime = U.uTime;
  const inSails = `(position.z > ${f(MILL_HUB.zMin)} && position.y > ${f(MILL_HUB.yMin)} && length(position.xy - vec2(${f(MILL_HUB.x)}, ${f(MILL_HUB.y)})) < ${f(MILL_HUB.r)})`;
  s.vertexShader = s.vertexShader
    .replace('#include <common>', `#include <common>
      uniform float uTime;
      vec3 sailRot(vec3 v, bool isPoint) {
        float a = -uTime * 0.7, c = cos(a), s = sin(a);
        vec2 hub = isPoint ? vec2(${f(MILL_HUB.x)}, ${f(MILL_HUB.y)}) : vec2(0.0);
        vec2 q = v.xy - hub;
        return vec3(c * q.x - s * q.y + hub.x, s * q.x + c * q.y + hub.y, v.z);
      }`)
    .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      if ${inSails} objectNormal = sailRot(objectNormal, false);`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      if ${inSails} transformed = sailRot(transformed, true);`);
}

function addOrientedBox(cx, cz, hx, hz, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const P = (lx, lz) => [cx + c * lx + s * lz, cz - s * lx + c * lz];
  const pts = [P(-hx, -hz), P(hx, -hz), P(hx, hz), P(-hx, hz)];
  for (let i = 0; i < 4; i++) addSeg(...pts[i], ...pts[(i + 1) % 4], 0);
}

function buildBuildings(models) {
  for (const b of BUILDINGS) {
    const root = models[b.file].scene;
    const box = new THREE.Box3().setFromObject(root);
    root.scale.setScalar(b.s);
    root.rotation.y = b.yaw;
    root.position.set(b.x, terrainH(b.x, b.z) - box.min.y * b.s - 0.08, b.z);
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = true;
      if (b === MILL) {
        o.material.onBeforeCompile = spinSails;
        o.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
        o.customDepthMaterial.onBeforeCompile = spinSails;
      }
    });
    scene.add(root);
    if (b === MILL) circles.push({ x: b.x, z: b.z, r: 3.4 });
    else addOrientedBox(b.x, b.z, b.hx - 0.4, b.hz - 0.4, b.yaw);
  }
}

// Birch trees: hand-placed ones plus a forest. Two simplified LODs of the
// Sunlit Birch model, swapped by distance on InstancedMeshes.
const BIRCHES = [
  { x: 14, z: -4, s: 6.5, rot: 0.3 }, { x: -50, z: 20, s: 7, rot: 2.1 }, { x: 54, z: 10, s: 6, rot: 4.0 },
  { x: -83, z: 35, s: 7.5, rot: 1.2 }, { x: -124, z: 94, s: 6.8, rot: 5.1 }, { x: 104, z: 108, s: 7.2, rot: 2.8 },
  { x: -72, z: -62, s: 6.6, rot: 0.9 }, { x: 16, z: 64, s: 7, rot: 3.6 },
  { x: 46, z: -12, s: 7.2, rot: 1.7 },
];
const BARE_TREES = [
  { x: -28, z: 28, s: 7.2, rot: 0.4 }, { x: 38, z: -44, s: 6.4, rot: 1.5 }, { x: 6, z: -82, s: 7.6, rot: 2.4 },
  { x: -120, z: -28, s: 8.0, rot: 0.9 }, { x: -155, z: 36, s: 7.0, rot: 3.3 }, { x: 44, z: 96, s: 6.8, rot: 1.8 },
  { x: 156, z: 124, s: 7.5, rot: 4.4 }, { x: -36, z: -142, s: 7.2, rot: 5.1 }, { x: 128, z: -108, s: 6.6, rot: 2.7 },
  { x: 78, z: -96, s: 7.8, rot: 0.6 },
];
function buildBareTrees(gltf) {
  let src = null;
  gltf.scene.traverse((o) => { if (o.isMesh && !src) src = o; });
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const trunk = box.getCenter(new V3());
  const mat = src.material;
  mat.side = THREE.DoubleSide;
  mat.metalness = 0;
  const mesh = new THREE.InstancedMesh(src.geometry, mat, BARE_TREES.length);
  mesh.castShadow = mesh.receiveShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new V3(0, 1, 0);
  BARE_TREES.forEach((t, i) => {
    const off = new V3(-trunk.x, 0, -trunk.z).applyAxisAngle(up, t.rot).multiplyScalar(t.s);
    m.compose(new V3(t.x + off.x, terrainH(t.x, t.z) - box.min.y * t.s - 0.1, t.z + off.z), q.setFromAxisAngle(up, t.rot), new V3(t.s, t.s, t.s));
    mesh.setMatrixAt(i, m);
    circles.push({ x: t.x, z: t.z, r: 0.45 });
  });
  scene.add(mesh);
}
const BIRCH_MID_DIST = 90, BIRCH_FAR_DIST = 330;
const forest = { spots: [], mid: null, far: null, timer: 0 };
function buildBirches(midG, farG, spots) {
  const firstMesh = (g) => { let m = null; g.scene.traverse((o) => { if (o.isMesh && !m) m = o; }); return m; };
  const box = new THREE.Box3().setFromObject(midG.scene);
  const trunk = box.getCenter(new V3());
  const make = (g, shadow) => {
    const src = firstMesh(g);
    const mat = src.material;
    mat.side = THREE.DoubleSide;
    mat.color.setScalar(1.3);
    mat.metalness = 0;
    const im = new THREE.InstancedMesh(src.geometry, mat, spots.length);
    im.count = 0;
    im.castShadow = shadow; im.receiveShadow = true;
    im.frustumCulled = false;
    scene.add(im);
    return im;
  };
  forest.mid = make(midG, true);
  forest.far = make(farG, false);
  const q = new THREE.Quaternion(), up = new V3(0, 1, 0);
  forest.spots = spots.map((t) => {
    const off = new V3(-trunk.x, 0, -trunk.z).applyAxisAngle(up, t.rot).multiplyScalar(t.s);
    const pos = new V3(t.x + off.x, terrainH(t.x, t.z) - box.min.y * t.s - 0.15, t.z + off.z);
    circles.push({ x: t.x, z: t.z, r: 0.5 });
    return { x: t.x, z: t.z, matrix: new THREE.Matrix4().compose(pos, q.setFromAxisAngle(up, t.rot), new V3(t.s, t.s, t.s)) };
  });
  updateForest(0, true);
}
function updateForest(dt, force = false) {
  forest.timer -= dt;
  if (!force && forest.timer > 0) return;
  forest.timer = 0.25;
  let nm = 0, nf = 0;
  for (const t of forest.spots) {
    const d = Math.hypot(t.x - camera.position.x, t.z - camera.position.z);
    if (d < BIRCH_MID_DIST) forest.mid.setMatrixAt(nm++, t.matrix);
    else if (d < BIRCH_FAR_DIST) forest.far.setMatrixAt(nf++, t.matrix);
  }
  forest.mid.count = nm; forest.far.count = nf;
  forest.mid.instanceMatrix.needsUpdate = true; forest.far.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Cow rig: procedural animation on the Meshy SmartRig skeleton (no clips)
// ---------------------------------------------------------------------------
const AXES = { X: new V3(1, 0, 0), Y: new V3(0, 1, 0), Z: new V3(0, 0, 1) };
const _q = new THREE.Quaternion();
const TAIL = ['Bone_008', 'Bone_007', 'Bone_006', 'Bone_005', 'Bone_004', 'Bone_003', 'Bone_002'];

class CowRig {
  constructor(model) {
    this.model = model;
    model.updateMatrixWorld(true);
    const bones = {};
    model.traverse((o) => { if (o.isBone) bones[o.name] = o; });
    this.bones = bones;
    this.ctl = {};
    const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
    const modelQ = new THREE.Quaternion().setFromRotationMatrix(inv);
    for (const name of Object.keys(bones)) {
      const b = bones[name];
      const pq = new THREE.Quaternion(); b.parent.getWorldQuaternion(pq); pq.premultiply(modelQ);
      const pinv = pq.clone().invert();
      this.ctl[name] = {
        bone: b, rest: b.quaternion.clone(),
        axes: { X: AXES.X.clone().applyQuaternion(pinv), Y: AXES.Y.clone().applyQuaternion(pinv), Z: AXES.Z.clone().applyQuaternion(pinv) },
      };
    }
    const wx = (n) => (bones[n] ? bones[n].getWorldPosition(new V3()).applyMatrix4(inv).x : 0);
    // Cow faces +Z, so its left side is +X.
    const [fl, fr] = wx('Bone_034') > wx('Bone_041') ? ['034', '041'] : ['041', '034'];
    const front = { '034': ['Bone_034', 'Bone_033', 'Bone_032', 'Bone_031'], '041': ['Bone_041', 'Bone_040', 'Bone_039', 'Bone_038'] };
    const hindA = { hip: ['Bone_019', 0.6], up: ['Bone_018', 0.4], hock: 'Bone_017', x: wx('Bone_018') };
    const hindB = { hip: null, up: ['Bone_013', 1.0], hock: 'Bone_012', x: wx('Bone_013') };
    const [hl, hr] = hindA.x > hindB.x ? [hindA, hindB] : [hindB, hindA];
    this.legs = [
      { kind: 'hind', d: hl, walk: 0.0, trot: 0.0 },
      { kind: 'front', d: front[fl], walk: 0.25, trot: 0.5 },
      { kind: 'hind', d: hr, walk: 0.5, trot: 0.5 },
      { kind: 'front', d: front[fr], walk: 0.75, trot: 0.0 },
    ];
    this.phase = 0;
    this.earT = [1, 2.5];
    this.ear = [0, 0];
    this.swish = 0; this.swishT = 3;
    this.lookT = 2; this.look = 0; this.lookTarget = 0;
    this.chew = 0;
  }
  rot(name, x = 0, y = 0, z = 0) {
    const c = this.ctl[name]; if (!c) return;
    c.bone.quaternion.copy(c.rest);
    if (x) c.bone.quaternion.premultiply(_q.setFromAxisAngle(c.axes.X, x));
    if (y) c.bone.quaternion.premultiply(_q.setFromAxisAngle(c.axes.Y, y));
    if (z) c.bone.quaternion.premultiply(_q.setFromAxisAngle(c.axes.Z, z));
  }
  update(dt, t, { speed, eat = 0, moo = 0, turn = 0, kneel = 0 }) {
    const k = Math.max(0, Math.min(1, kneel));
    const gait = sstep(WALK_SPEED * 1.1, TROT_SPEED * 0.9, Math.abs(speed));
    const stride = 1.5 + gait * 3.6;
    this.phase += (speed / stride) * dt;
    const move = Math.min(1, Math.abs(speed) / 0.6) * (1 - k);
    const amp = (0.26 + gait * 0.16) * move;
    const lift = (0.45 + gait * 0.3) * move;
    for (const leg of this.legs) {
      const ph = (this.phase + leg.walk + (leg.trot - leg.walk) * gait) * Math.PI * 2;
      const sw = Math.sin(ph) * amp;
      const lf = Math.max(0, -Math.cos(ph)) * lift;
      if (leg.kind === 'front') {
        const [sh, up, el, kn] = leg.d;
        this.rot(sh, sw * 0.45);
        this.rot(up, sw * 0.55 + k * 0.85);
        this.rot(el, -lf * 0.25 - k * 0.3);
        this.rot(kn, lf + k * 1.55);
      } else {
        const d = leg.d;
        if (d.hip) this.rot(d.hip[0], sw * d.hip[1] - k * 0.35);
        this.rot(d.up[0], sw * d.up[1] + lf * 0.2 + k * 0.9);
        this.rot(d.hock, -lf * 0.7 - k * 1.7);
      }
    }
    const bob = Math.sin(this.phase * Math.PI * 4);
    this.rot('Bone_023', 0, 0, Math.sin(this.phase * Math.PI * 2) * 0.03 * move);
    this.rot('Bone_021', 0, turn * 0.12, 0);

    // Head: idle glances, walking nod, grazing, mooing
    this.lookT -= dt;
    if (this.lookT < 0) { this.lookT = 2 + Math.random() * 4; this.lookTarget = (Math.random() - 0.5) * 0.9 * (1 - move * 0.7); }
    this.look += (this.lookTarget + turn * 0.25 - this.look) * Math.min(1, dt * 2.5);
    const nod = bob * 0.04 * move;
    this.chew += dt * 9;
    const chew = eat * 0.12 * Math.max(0, Math.sin(this.chew));
    this.rot('Bone_027', eat * 0.8 + nod - moo * 0.1 - k * 0.45, this.look * 0.45, 0);
    this.rot('Bone_026', eat * 0.15 + nod * 0.5 - moo * 0.15 - k * 0.25, this.look * 0.3, 0);
    this.rot('Bone_025', eat * 0.03 - moo * 0.2, this.look * 0.25, 0);
    this.rot('Bone_043', moo * 0.35 + chew, 0, 0);

    // Ears twitch
    ['Bone_047', 'Bone_049'].forEach((n, i) => {
      this.earT[i] -= dt;
      if (this.earT[i] < 0) { this.earT[i] = 1.5 + Math.random() * 5; this.ear[i] = 1; }
      this.ear[i] = Math.max(0, this.ear[i] - dt * 4);
      const tw = Math.sin(this.ear[i] * Math.PI * 3) * this.ear[i] * 0.35;
      this.rot(n, tw, 0, (i ? 1 : -1) * tw);
    });

    // Tail sway + occasional fly swish
    this.swishT -= dt;
    if (this.swishT < 0) { this.swishT = 3 + Math.random() * 6; this.swish = 1; }
    this.swish = Math.max(0, this.swish - dt * 0.9);
    TAIL.forEach((n, i) => {
      const a = (0.06 + 0.06 * move) * Math.sin(t * 2.2 - i * 0.55) + this.swish * 0.28 * Math.sin(t * 9 - i * 0.7) * (i / TAIL.length + 0.3);
      this.rot(n, i === 0 ? 0.05 * move : 0, 0, a);
    });
    return bob;
  }
}

// Bull: same Meshy SmartRig family, different bone numbering. Faces +Z, left is +X.
const BULL_TAIL = ['Bone_010', 'Bone_009', 'Bone_008', 'Bone_007', 'Bone_006', 'Bone_005', 'Bone_004', 'Bone_003', 'Bone_002'];
const BULL_SCALE = 1.2;
class BullRig extends CowRig {
  constructor(model) {
    super(model);
    const front = (a) => [`Bone_0${a}`, `Bone_0${a - 1}`, `Bone_0${a - 2}`, `Bone_0${a - 3}`];
    const hind = (a) => ({ hip: [`Bone_0${a}`, 0.6], up: [`Bone_0${a - 1}`, 0.4], hock: `Bone_0${a - 2}` });
    this.legs = [
      { kind: 'hind', d: hind(22), walk: 0.0, trot: 0.0 },
      { kind: 'front', d: front(46), walk: 0.25, trot: 0.5 },
      { kind: 'hind', d: hind(16), walk: 0.5, trot: 0.5 },
      { kind: 'front', d: front(39), walk: 0.75, trot: 0.0 },
    ];
  }
  // speed in m/s of the scaled bull; the rig works in cow-sized units
  update(dt, t, { speed, eat = 0, turn = 0 }) {
    const s = speed / BULL_SCALE;
    const gait = sstep(0.8, 2.0, Math.abs(s));
    this.phase += (s / (1.4 + gait * 1.8)) * dt;
    const move = Math.min(1, Math.abs(s) / 0.4);
    const amp = (0.26 + gait * 0.2) * move, lift = (0.45 + gait * 0.35) * move;
    for (const leg of this.legs) {
      const ph = (this.phase + leg.walk + (leg.trot - leg.walk) * gait) * Math.PI * 2;
      const sw = Math.sin(ph) * amp, lf = Math.max(0, -Math.cos(ph)) * lift;
      if (leg.kind === 'front') {
        const [sh, up, el, kn] = leg.d;
        this.rot(sh, sw * 0.45); this.rot(up, sw * 0.55); this.rot(el, -lf * 0.25); this.rot(kn, lf);
      } else {
        const d = leg.d;
        this.rot(d.hip[0], sw * d.hip[1]);
        this.rot(d.up[0], sw * d.up[1] + lf * 0.2);
        this.rot(d.hock, -lf * 0.7);
      }
    }
    const bob = Math.sin(this.phase * Math.PI * 4);
    this.rot('Bone_026', 0, turn * 0.1, Math.sin(this.phase * Math.PI * 2) * 0.03 * move);
    this.lookT -= dt;
    if (this.lookT < 0) { this.lookT = 2 + Math.random() * 4; this.lookTarget = (Math.random() - 0.5) * 0.8 * (1 - move * 0.8); }
    this.look += (this.lookTarget + turn * 0.25 - this.look) * Math.min(1, dt * 2.5);
    const nod = bob * 0.04 * move;
    this.rot('Bone_024', eat * 0.55 + nod, this.look * 0.4, 0);
    this.rot('Bone_032', eat * 0.25 + nod * 0.5, this.look * 0.3, 0);
    this.rot('Bone_031', eat * 0.05, this.look * 0.2, 0);
    this.swishT -= dt;
    if (this.swishT < 0) { this.swishT = 3 + Math.random() * 6; this.swish = 1; }
    this.swish = Math.max(0, this.swish - dt * 0.9);
    BULL_TAIL.forEach((n, i) => {
      const a = (0.05 + 0.08 * move) * Math.sin(t * 2.2 - i * 0.5) + this.swish * 0.25 * Math.sin(t * 9 - i * 0.6) * (i / BULL_TAIL.length + 0.3);
      this.rot(n, i === 0 ? 0.08 * move : 0, 0, a);
    });
    return bob;
  }
}

function makeBull(gltf) {
  const model = SkeletonUtils.clone(gltf.scene);
  model.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; o.material.metalness = 0; }
  });
  const rig = new BullRig(model);
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';
  group.scale.setScalar(BULL_SCALE);
  group.add(model);
  scene.add(group);
  return { group, model, rig, pos: new V3(), yaw: 0, speed: 0, turn: 0, eat: 0, pitch: 0,
    state: 'graze', timer: 3 + rand() * 6, goal: new V2() };
}

// Horse: same SmartRig family, but the model faces -X, so pitch is about Z and
// roll about X. -Z is the horse's right side.
const HORSE_SCALE = 1.58;
const HORSE_TAIL = ['Bone_009', 'Bone_008', 'Bone_007', 'Bone_006'];
const HORSE_TINTS = [[1, 1, 1], [0.62, 0.58, 0.56], [1.15, 1.08, 0.98]];
class HorseRig extends CowRig {
  constructor(model) {
    super(model);
    const leg = (a) => [`Bone_0${a}`, `Bone_0${a - 1}`, `Bone_0${a - 2}`, `Bone_0${a - 3}`];
    this.legs = [
      { front: false, d: leg(21), walk: 0.0, trot: 0.0, run: 0.12 },
      { front: true, d: leg(38), walk: 0.25, trot: 0.5, run: 0.55 },
      { front: false, d: leg(15), walk: 0.5, trot: 0.5, run: 0.0 },
      { front: true, d: leg(32), walk: 0.75, trot: 0.0, run: 0.42 },
    ];
    this.shake = 0; this.shakeT = 5 + Math.random() * 8;
    this.bounce = 0;
    // The neck is too short to reach the grass, so it stretches while grazing.
    this.neck = ['Bone_025', 'Bone_024', 'Bone_023'].map((n) => ({ bone: this.bones[n], rest: this.bones[n].position.clone() }));
  }
  P(name, pitch = 0, yaw = 0, roll = 0) { this.rot(name, roll, yaw, pitch); }
  // speed in m/s of the scaled horse; the rig works in model units
  update(dt, t, { speed, eat = 0, turn = 0 }) {
    const s = Math.abs(speed / HORSE_SCALE);
    const trot = sstep(1.0, 2.0, s), run = sstep(3.0, 4.6, s);
    this.phase += (speed / HORSE_SCALE / (1.25 + trot * 1.0 + run * 1.4)) * dt;
    const move = Math.min(1, s / 0.4);
    const amp = (0.3 + trot * 0.12 + run * 0.25) * move;
    const lift = (0.5 + trot * 0.35 + run * 0.3) * move;
    const cyc = this.phase * Math.PI * 2;
    for (const L of this.legs) {
      const off = L.walk + (L.trot - L.walk) * trot;
      const ph = (this.phase + off + (L.run - off) * run) * Math.PI * 2;
      const sw = Math.sin(ph) * amp, lf = Math.max(0, -Math.cos(ph)) * lift;
      const [a, b, c, d] = L.d;
      if (L.front) {
        const stance = eat * (L.d[0] === 'Bone_038' ? -0.22 : 0.08);
        this.P(a, sw * 0.9 + stance);
        this.P(b, -lf * 0.55);
        this.P(c, lf * 1.5);
        this.P(d, lf * 0.5);
      } else {
        this.P(a, sw * 0.8 - lf * 0.15);
        this.P(b, lf * 0.55);
        this.P(c, -lf * 1.1);
        this.P(d, lf * 0.45);
      }
    }
    const bob = Math.sin(cyc * 2);
    this.bounce = (Math.abs(bob) * 0.02 * trot * (1 - run) + (0.5 + 0.5 * Math.sin(cyc + 2.2)) * 0.07 * run) * move;
    this.P('Bone_000', Math.sin(cyc + 0.8) * 0.07 * run + eat * 0.05, 0, Math.sin(cyc) * 0.025 * move * (1 - run));
    this.P('Bone_004', Math.sin(cyc) * 0.05 * run, turn * 0.08, 0);

    // Head: glances, walking nod, galloping reach, grazing, an occasional shake
    this.lookT -= dt;
    if (this.lookT < 0) { this.lookT = 2 + Math.random() * 4; this.lookTarget = (Math.random() - 0.5) * 0.9 * (1 - move * 0.7); }
    this.look += (this.lookTarget * (1 - eat) + turn * 0.25 - this.look) * Math.min(1, dt * 2.5);
    this.shakeT -= dt;
    if (this.shakeT < 0) { this.shakeT = 6 + Math.random() * 10; if (move < 0.5) this.shake = 1; }
    this.shake = Math.max(0, this.shake - dt * 1.2);
    const toss = Math.sin(t * 15) * this.shake * this.shake;
    const nod = bob * 0.07 * move * (1 - run) + Math.sin(cyc + 1.6) * 0.12 * run;
    this.chew += dt * 7;
    const chew = eat * 0.05 * Math.sin(this.chew);
    this.P('Bone_026', eat * 1.2 + nod * 0.5 + run * 0.35 - this.shake * 0.25, this.look * 0.35);
    this.P('Bone_025', eat * 0.6 + nod * 0.3, this.look * 0.3, toss * 0.12);
    this.P('Bone_024', eat * 0.45 + nod * 0.2, this.look * 0.2 + toss * 0.2);
    this.P('Bone_023', -eat * 1.05 + chew - run * 0.15, this.look * 0.15 + toss * 0.3, toss * 0.25);
    for (const n of this.neck) n.bone.position.copy(n.rest).multiplyScalar(1 + eat * 0.4);

    // Tail sway, fly swish, lifted at a gallop
    this.swishT -= dt;
    if (this.swishT < 0) { this.swishT = 3 + Math.random() * 6; this.swish = 1; }
    this.swish = Math.max(0, this.swish - dt * 0.9);
    HORSE_TAIL.forEach((n, i) => {
      const a = (0.05 + 0.06 * move) * Math.sin(t * 2 - i * 0.6) + this.swish * 0.3 * Math.sin(t * 8 - i * 0.7) * (i / HORSE_TAIL.length + 0.3);
      this.P(n, i === 0 ? 0.15 * trot + 0.6 * run : 0.06 * run, 0, a);
    });
    return bob;
  }
}

function makeHorse(gltf, i) {
  const model = SkeletonUtils.clone(gltf.scene);
  const tint = HORSE_TINTS[i % HORSE_TINTS.length];
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
    o.material = o.material.clone(); o.material.metalness = 0;
    o.material.color.setRGB(...tint);
  });
  const rig = new HorseRig(model);
  const face = new THREE.Group();
  face.rotation.y = Math.PI / 2;
  face.add(model);
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';
  group.scale.setScalar(HORSE_SCALE);
  group.add(face);
  scene.add(group);
  return { group, model, rig, horse: true, pos: new V3(), yaw: rand() * 6.28, speed: 0, turn: 0, eat: 0, pitch: 0,
    state: 'graze', timer: 2 + rand() * 6, goal: new V2(), munch: 0, seed: i * 7.3 };
}

// Pig and duck: small SmartRig animals that face +Z like the cow, so pitch is about X.
const PIG_SCALE = 0.42, DUCK_SCALE = 0.24;
class PigRig extends CowRig {
  constructor(model) {
    super(model);
    this.legs = [
      { front: false, d: ['Bone_016', 'Bone_015', 'Bone_014'], ph: 0.0 },
      { front: true, d: ['Bone_046', 'Bone_045', 'Bone_044'], ph: 0.25 },
      { front: false, d: ['Bone_022', 'Bone_021', 'Bone_020'], ph: 0.5 },
      { front: true, d: ['Bone_052', 'Bone_051', 'Bone_050'], ph: 0.75 },
    ];
    this.bounce = 0;
  }
  update(dt, t, { speed, eat = 0 }) {
    const s = speed / PIG_SCALE;
    this.phase += (s / 1.7) * dt;
    const move = Math.min(1, Math.abs(s) / 0.5);
    for (const L of this.legs) {
      const ph = (this.phase + L.ph) * Math.PI * 2;
      const sw = Math.sin(ph) * 0.38 * move, lf = Math.max(0, -Math.cos(ph)) * 0.55 * move;
      const [a, b, c] = L.d;
      this.rot(a, sw);
      if (L.front) { this.rot(b, lf * 0.7); this.rot(c, lf * 0.3); }
      else { this.rot(b, lf * 0.35); this.rot(c, -lf * 0.7); }
    }
    const bob = Math.sin(this.phase * Math.PI * 4);
    this.bounce = Math.abs(bob) * 0.03 * move;
    this.rot('Bone_030', 0, 0, Math.sin(this.phase * Math.PI * 2) * 0.04 * move);
    this.lookT -= dt;
    if (this.lookT < 0) { this.lookT = 1.5 + Math.random() * 3; this.lookTarget = (Math.random() - 0.5) * 0.7; }
    this.look += (this.lookTarget - this.look) * Math.min(1, dt * 3);
    this.chew += dt * 10;
    const root = eat * (0.7 + 0.1 * Math.sin(this.chew));
    this.rot('Bone_041', root + bob * 0.04 * move, this.look * 0.5, 0);
    this.rot('Bone_039', eat * 0.15, this.look * 0.2, 0);
    const flop = bob * 0.12 * move + Math.sin(t * 1.7) * 0.04;
    this.rot('Bone_055', flop, 0, flop * 0.5);
    this.rot('Bone_057', flop, 0, -flop * 0.5);
    ['Bone_011', 'Bone_010', 'Bone_009', 'Bone_008'].forEach((n, i) => this.rot(n, 0, Math.sin(t * 6 - i * 0.9) * 0.25, 0));
    return bob;
  }
}

class DuckRig extends CowRig {
  constructor(model) {
    super(model);
    this.legs = [
      { d: ['Bone_012', 'Bone_011', 'Bone_010'], ph: 0.0 },
      { d: ['Bone_016', 'Bone_015', 'Bone_014'], ph: 0.5 },
    ];
    this.bounce = 0;
    this.peck = 0; this.peckT = 2 + Math.random() * 3;
    this.wag = 0;
  }
  update(dt, t, { speed, eat = 0 }) {
    const s = speed / DUCK_SCALE;
    this.phase += (s / 0.75) * dt;
    const move = Math.min(1, Math.abs(s) / 0.4);
    for (const L of this.legs) {
      const ph = (this.phase + L.ph) * Math.PI * 2;
      const sw = Math.sin(ph) * 0.5 * move, lf = Math.max(0, -Math.cos(ph)) * 0.6 * move;
      const [a, b, c] = L.d;
      this.rot(a, sw - lf * 0.3);
      this.rot(b, lf * 0.6);
      this.rot(c, -lf * 0.4);
    }
    const sway = Math.sin(this.phase * Math.PI * 2);
    this.bounce = Math.abs(Math.cos(this.phase * Math.PI * 2)) * 0.03 * move;
    this.rot('Bone_000', 0, sway * 0.08 * move, sway * 0.16 * move);
    // Pecking at the ground while idle, head bob while walking
    this.peckT -= dt;
    if (this.peckT < 0) { this.peckT = 1.2 + Math.random() * 3; if (eat > 0.5) this.peck = 1; }
    this.peck = Math.max(0, this.peck - dt * 1.6);
    const dip = Math.sin(this.peck * Math.PI) * eat;
    const bobble = Math.sin(this.phase * Math.PI * 4) * 0.14 * move;
    this.rot('Bone_008', dip * 0.9 + bobble, 0, 0);
    this.rot('Bone_007', dip * 0.6 - bobble * 0.5, 0, 0);
    this.rot('Bone_005', dip * 0.3, 0, 0);
    this.lookT -= dt;
    if (this.lookT < 0) { this.lookT = 0.8 + Math.random() * 2.5; this.lookTarget = (Math.random() - 0.5) * 1.2; }
    this.look += (this.lookTarget - this.look) * Math.min(1, dt * 6);
    this.rot('Bone_004', -dip * 0.4, this.look * 0.6, 0);
    if (Math.random() < dt * 0.25) this.wag = 1;
    this.wag = Math.max(0, this.wag - dt * 1.5);
    this.rot('Bone_020', 0, Math.sin(t * 22) * 0.35 * this.wag + sway * 0.1 * move, 0);
    return sway;
  }
}

function makeCritter(gltf, Rig, scale, kind, i) {
  const model = SkeletonUtils.clone(gltf.scene);
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
    o.material.metalness = 0;
  });
  const rig = new Rig(model);
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';
  group.scale.setScalar(scale);
  group.add(model);
  scene.add(group);
  return { group, model, rig, kind, pos: new V3(), yaw: rand() * 6.28, speed: 0, turn: 0, eat: 0, pitch: 0,
    state: 'idle', timer: 1 + rand() * 4, goal: new V2(), seed: i * 5.1 };
}

function makeCow(gltf) {
  const model = SkeletonUtils.clone(gltf.scene);
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
      o.material = o.material.clone(); o.material.metalness = 0;
    }
  });
  const rig = new CowRig(model);
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';
  group.add(model);
  scene.add(group);
  return { group, model, rig, pos: new V3(), yaw: 0, speed: 0, turn: 0, eat: 0, moo: 0, pitch: 0 };
}

function placeCow(cow, dt) {
  const fx = Math.sin(cow.yaw), fz = Math.cos(cow.yaw);
  cow.pos.y = terrainH(cow.pos.x, cow.pos.z);
  const pitch = Math.atan2(terrainH(cow.pos.x + fx * 1.1, cow.pos.z + fz * 1.1) - terrainH(cow.pos.x - fx * 1.1, cow.pos.z - fz * 1.1), 2.2);
  cow.pitch += (pitch - cow.pitch) * Math.min(1, dt * 6);
  const kneel = cow.kneel || 0;
  cow.group.position.copy(cow.pos);
  cow.group.position.y -= kneel * 0.8;
  cow.group.rotation.set(-cow.pitch * (1 - kneel), cow.yaw, 0);
}

// ---------------------------------------------------------------------------
// Audio: synthesized moo, wind and birds
// ---------------------------------------------------------------------------
let actx = null, master = null;
const mooBufs = [];
function initAudio() {
  actx = new (window.AudioContext || window.webkitAudioContext)();
  master = actx.createGain(); master.gain.value = 0.8; master.connect(actx.destination);
  const len = actx.sampleRate * 2, buf = actx.createBuffer(1, len, actx.sampleRate), d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) { last = last * 0.98 + (Math.random() * 2 - 1) * 0.02; d[i] = last * 6; }
  const noise = actx.createBufferSource(); noise.buffer = buf; noise.loop = true;
  const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
  const wg = actx.createGain(); wg.gain.value = 0.032;
  const lfo = actx.createOscillator(); lfo.frequency.value = 0.13; const lfoG = actx.createGain(); lfoG.gain.value = 0.018;
  lfo.connect(lfoG).connect(wg.gain); lfo.start();
  noise.connect(lp).connect(wg).connect(master); noise.start();
  const bird = () => {
    const t = actx.currentTime, n = 2 + Math.floor(Math.random() * 3), base = 2400 + Math.random() * 1500;
    const g = actx.createGain(); g.gain.value = 0; g.connect(master);
    const o = actx.createOscillator(); o.type = 'sine'; o.connect(g);
    for (let i = 0; i < n; i++) {
      const s = t + i * 0.14;
      o.frequency.setValueAtTime(base, s); o.frequency.exponentialRampToValueAtTime(base * 1.35, s + 0.05); o.frequency.exponentialRampToValueAtTime(base * 0.9, s + 0.1);
      g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.015, s + 0.02); g.gain.linearRampToValueAtTime(0, s + 0.1);
    }
    o.start(t); o.stop(t + n * 0.14 + 0.1);
    setTimeout(bird, 2500 + Math.random() * 7000);
  };
  setTimeout(bird, 2000);
  const loadBuf = async (url) => actx.decodeAudioData(await (await fetch(url)).arrayBuffer());
  Promise.all(['assets/cow1.mp3', 'assets/cow2.mp3'].map(loadBuf)).then((bufs) => mooBufs.push(...bufs)).catch((e) => console.warn(e));
  loadBuf('assets/heno.mp3').then((buf) => { henoBuf = buf; }).catch((e) => console.warn(e));
}
let henoBuf = null;
function playBuf(buf, volume, rate = 1) {
  if (!actx || !buf || volume < 0.01) return;
  const src = actx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const g = actx.createGain();
  g.gain.value = volume;
  src.connect(g).connect(master);
  src.start();
}
function playMoo(volume = 1, rate = 1) {
  if (!mooBufs.length) return;
  playBuf(mooBufs[Math.floor(Math.random() * mooBufs.length)], volume, rate);
}
function playHay() { playBuf(henoBuf, 0.4); }

// ---------------------------------------------------------------------------
// Input + camera
// ---------------------------------------------------------------------------
const keys = {};
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) moo(); }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

const cam = { yaw: 0, pitch: 0.36, dist: 13, lastDrag: -10, lastLog: -10, target: new V3() };
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; try { canvas.setPointerCapture(e.pointerId); } catch (err) {} canvas.classList.add('dragging'); });
canvas.addEventListener('pointerup', (e) => { dragging = false; canvas.releasePointerCapture(e.pointerId); canvas.classList.remove('dragging'); });
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  cam.yaw -= (e.clientX - lastX) * 0.005;
  cam.pitch = Math.min(1.25, Math.max(-0.05, cam.pitch + (e.clientY - lastY) * 0.004));
  lastX = e.clientX; lastY = e.clientY; cam.lastDrag = clock.elapsedTime;
});
canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = Math.min(45, Math.max(4, cam.dist * (1 + Math.sign(e.deltaY) * 0.1))); cam.lastDrag = clock.elapsedTime; }, { passive: false });

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
let player = null, bull = null;
const npcs = [];
let started = false;
let booted = false;
let cowGltf = null;
let eaten = 0, eatTimer = 0, eatBite = null;
const EAT_HOLD = 1.7;
let mooT = 0;
const clock = new THREE.Clock();
function moo() {
  if (!player || mooT > 0) return;
  mooT = 1.8;
  playMoo(0.2, 1);
}

// ---------------------------------------------------------------------------
// Other players: each connection is a cow, spawned apart, synced over websocket
// ---------------------------------------------------------------------------
const REMOTE_TINTS = [
  [1, 0.97, 0.9],
  [0.9, 0.95, 1],
  [1, 0.92, 0.9],
  [0.93, 1, 0.9],
  [0.98, 0.94, 0.84],
  [0.9, 0.98, 0.96],
];
const net = { ws: null, id: null, spawn: null, placed: false, acc: 0, tries: 0, status: 'off' };
const remotes = new Map();
const queued = new Map();
window.__net = net;
window.__remotes = remotes;

function wsUrl() {
  if (location.protocol === 'file:') return null;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
function setOnline(text) {
  const el = document.getElementById('online');
  if (el) el.textContent = text;
}
function refreshOnline() {
  const n = 1 + remotes.size + queued.size;
  if (net.status === 'wait') setOnline('Conectando…');
  else if (net.status !== 'on') setOnline('Sin conexión');
  else setOnline(n <= 1 ? 'En línea · solo tú' : `En línea · ${n} vacas`);
}
function connectNet() {
  const url = wsUrl();
  if (!url) { net.status = 'off'; refreshOnline(); return; }
  net.status = 'wait';
  refreshOnline();
  let ws;
  try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
  net.ws = ws;
  ws.onopen = () => { net.status = 'on'; net.tries = 0; refreshOnline(); };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'w') onWelcome(msg);
    else if (msg.t === 's') onRemoteState(msg);
    else if (msg.t === 'l') removeRemote(msg.id);
  };
  ws.onclose = () => {
    if (net.ws === ws) net.ws = null;
    net.status = 'off';
    refreshOnline();
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch (err) {} };
}
function scheduleReconnect() {
  net.tries += 1;
  const wait = Math.min(8000, 1000 * net.tries);
  setTimeout(() => {
    if (!net.ws || net.ws.readyState === WebSocket.CLOSING || net.ws.readyState === WebSocket.CLOSED) connectNet();
  }, wait);
}
function onWelcome(msg) {
  net.id = msg.id;
  net.spawn = { x: Number(msg.x), z: Number(msg.z), yaw: Number(msg.y) };
  for (const id of [...remotes.keys()]) removeRemote(id);
  queued.clear();
  applyNetSpawn();
  for (const p of (Array.isArray(msg.peers) ? msg.peers : [])) onRemoteState(p);
  refreshOnline();
}
function onRemoteState(p) {
  if (!p || p.id == null || p.id === net.id) return;
  const x = Number(p.x), z = Number(p.z), yaw = Number(p.y);
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) return;
  const state = {
    id: p.id, x, z, yaw,
    speed: Number(p.v) || 0,
    eat: Number(p.e) || 0,
    moo: Number(p.m) || 0,
    kneel: Number(p.k) || 0,
    got: p.g | 0,
  };
  if (!cowGltf) { queued.set(p.id, state); refreshOnline(); return; }
  let cow = remotes.get(p.id);
  if (!cow) {
    cow = spawnRemote(state);
    remotes.set(p.id, cow);
    refreshOnline();
    return;
  }
  const prevMoo = cow.net.moo;
  cow.net = state;
  if (prevMoo < 0.45 && state.moo > 0.55 && player && actx) {
    const d = Math.hypot(state.x - player.pos.x, state.z - player.pos.z);
    playMoo(Math.max(0, 1 - d / 55) * 0.22, 0.95 + (Math.abs(state.id | 0) % 5) * 0.02);
  }
}
function spawnRemote(state) {
  const cow = makeCow(cowGltf);
  cow.net = state;
  cow.pos.set(state.x, 0, state.z);
  cow.yaw = state.yaw;
  cow.got = state.got;
  cow.tag = makeTag();
  drawTag(cow.tag, state.got);
  const tint = REMOTE_TINTS[Math.abs(state.id | 0) % REMOTE_TINTS.length];
  cow.model.traverse((o) => { if (o.isMesh) o.material.color.setRGB(tint[0], tint[1], tint[2]); });
  placeCow(cow, 1);
  return cow;
}
function removeRemote(id) {
  queued.delete(id);
  const cow = remotes.get(id);
  if (!cow) { refreshOnline(); return; }
  remotes.delete(id);
  scene.remove(cow.group);
  cow.model.traverse((o) => { if (o.isMesh && o.material) o.material.dispose(); });
  if (cow.tag) {
    scene.remove(cow.tag.sprite);
    cow.tag.tex.dispose();
    cow.tag.sprite.material.dispose();
  }
  refreshOnline();
}
function flushRemotes() {
  if (!cowGltf) return;
  for (const state of queued.values()) {
    if (!remotes.has(state.id)) remotes.set(state.id, spawnRemote(state));
  }
  queued.clear();
  refreshOnline();
}
function applyNetSpawn() {
  if (!player || !net.spawn || net.placed) return;
  const moved = started && Math.hypot(player.pos.x - 2, player.pos.z - 8) > 1.5;
  net.placed = true;
  if (moved) return;
  player.pos.set(net.spawn.x, 0, net.spawn.z);
  player.yaw = net.spawn.yaw;
  placeCow(player, 1);
  if (booted && !started) {
    const look = new V3(player.pos.x, terrainH(player.pos.x, player.pos.z) + 1.35, player.pos.z);
    const off = camera.position.clone().sub(cam.target);
    cam.target.copy(look);
    camera.position.copy(look).add(off);
    camera.lookAt(look);
  }
}
function sendState() {
  if (!player || !net.ws || net.ws.readyState !== 1) return;
  net.ws.send(JSON.stringify({
    t: 's',
    x: +player.pos.x.toFixed(2),
    z: +player.pos.z.toFixed(2),
    y: +player.yaw.toFixed(3),
    v: +player.speed.toFixed(2),
    e: +Math.min(1, player.eat).toFixed(2),
    m: +Math.min(1, player.moo).toFixed(2),
    k: +Math.min(1, player.kneel || 0).toFixed(2),
    g: eaten | 0,
  }));
}
function updateRemotes(dt, t) {
  const k = 1 - Math.exp(-dt * 12);
  for (const cow of remotes.values()) {
    const n = cow.net;
    if (Math.hypot(n.x - cow.pos.x, n.z - cow.pos.z) > 12) {
      cow.pos.x = n.x; cow.pos.z = n.z; cow.yaw = n.yaw;
    } else {
      cow.pos.x += (n.x - cow.pos.x) * k;
      cow.pos.z += (n.z - cow.pos.z) * k;
      cow.yaw = lerpAngle(cow.yaw, n.yaw, k);
    }
    cow.speed += (n.speed - cow.speed) * k;
    cow.eat += (n.eat - cow.eat) * Math.min(1, dt * 6);
    cow.moo += (n.moo - cow.moo) * Math.min(1, dt * 8);
    cow.kneel = (cow.kneel || 0) + (n.kneel - (cow.kneel || 0)) * Math.min(1, dt * 4);
    if ((cow.got | 0) !== (n.got | 0)) { cow.got = n.got | 0; drawTag(cow.tag, cow.got); }
    const bob = cow.rig.update(dt, t + (Math.abs(n.id | 0) % 7), { speed: cow.speed, eat: cow.eat, moo: cow.moo, turn: 0, kneel: cow.kneel || 0 });
    placeCow(cow, dt);
    cow.model.position.y = Math.abs(bob) * 0.015 * Math.min(1, Math.abs(cow.speed));
    cow.tag.sprite.position.set(cow.pos.x, cow.pos.y + 1.9 - (cow.kneel || 0) * 0.7, cow.pos.z);
  }
}

function zoneName(x, z) {
  if (rectMask(x, z, FARM_RECT, 0) > 0.5) return 'En el corral de la granja';
  if (Math.hypot(x - CHAPEL.x, z - CHAPEL.z) < 42) return 'Junto a la capilla';
  if (Math.hypot(x - MILL.x, z - MILL.z) < 18) return 'Junto al molino';
  if (Math.hypot(x - BARN.x, z - BARN.z) < 14) return 'Junto al establo';
  if (Math.hypot(x - HOUSE.x, z - HOUSE.z) < 24) return 'Junto a la casa';
  if (wheatMask(x, z) > 0.5) return 'En el trigal';
  if (pathMask(x, z) > 0.5) return 'En el camino de tierra';
  if (x > PASTURE.x0 && x < PASTURE.x1 && z > PASTURE.z0 && z < PASTURE.z1) return 'En el potrero';
  return 'Campo abierto';
}

function nearPond() { return Math.hypot(POND_AT.x - player.pos.x, POND_AT.z - player.pos.z) < 4.6; }
function easeKneel(cow, dt) {
  const want = cow.asleep > 0 ? 1 : 0;
  cow.kneel = (cow.kneel || 0) + (want - (cow.kneel || 0)) * Math.min(1, dt * 2.2);
}
let flashEl = null;
function runOver() {
  if (player.hurt > 0) return;
  player.hurt = 0.85;
  player.speed = 0;
  player.asleep = 0;
  if (!flashEl) {
    flashEl = document.createElement('div');
    flashEl.style.cssText = 'position:fixed;inset:0;background:#2a0505;opacity:0;pointer-events:none;z-index:8;transition:opacity .2s';
    document.body.appendChild(flashEl);
  }
  flashEl.style.opacity = '0.78';
}
function respawn() {
  eaten = 0;
  player.got = 0;
  if (player.tag) drawTag(player.tag, 0);
  const home = net.spawn || { x: 2, z: 8, yaw: Math.atan2(FARM.x - 2, FARM.z - 8) + 0.5 };
  player.pos.set(home.x, 0, home.z);
  player.yaw = home.yaw;
  player.speed = 0;
  player.turn = 0;
  player.asleep = 0;
  player.kneel = 0;
  needs.waterIn = 45; needs.thirsty = false;
  needs.sleepIn = 70; needs.sleepy = false; needs.drink = 0;
  eatTimer = 0; eatBite = null;
  if (flashEl) flashEl.style.opacity = '0';
  showNeeds();
}
function blockFullShelter() {
  if (!rain.on) return;
  for (const s of SHELTERS) {
    if (npcsAt(s) < 2) continue;
    const dx = player.pos.x - s.x, dz = player.pos.z - s.z, d = Math.hypot(dx, dz);
    if (d < 5.8 && d > 0.05) { player.pos.x = s.x + dx / d * 6; player.pos.z = s.z + dz / d * 6; }
  }
}

function updatePlayer(dt, t) {
  const eNow = !!keys.KeyE;
  const qNow = !!keys.KeyQ, qTap = qNow && !qHeld;
  qHeld = qNow;
  if (player.hurt > 0) {
    player.hurt -= dt;
    player.speed = 0;
    easeKneel(player, dt);
    player.rig.update(dt, t, { speed: 0, eat: 0, moo: 0, turn: 0, kneel: player.kneel || 0 });
    placeCow(player, dt);
    if (player.hurt <= 0) respawn();
    return;
  }
  if (qTap && needs.sleepy) {
    player.asleep = SLEEP_TIME;
    needs.sleepy = false;
    player.speed = 0;
    eatTimer = 0;
    eatBite = null;
  }
  if (player.asleep > 0) {
    player.asleep -= dt;
    player.speed = 0;
    easeKneel(player, dt);
    player.rig.update(dt, t, { speed: 0, eat: 0, moo: player.moo, turn: 0, kneel: player.kneel || 0 });
    placeCow(player, dt);
    if (player.asleep <= 0) { player.asleep = 0; needs.sleepIn = 80 + rand() * 40; needs.sleepy = false; }
    showNeeds();
    return;
  }
  if (!needs.thirsty) { needs.waterIn -= dt; if (needs.waterIn <= 0) needs.thirsty = true; }
  if (day.name !== 'Noche') { needs.sleepy = false; if (!(player.asleep > 0)) needs.sleepIn = 12; }
  else if (!needs.sleepy) { needs.sleepIn -= dt; if (needs.sleepIn <= 0) needs.sleepy = true; }
  const fwd = keys.KeyW || keys.ArrowUp, back = keys.KeyS || keys.ArrowDown;
  const left = keys.KeyA || keys.ArrowLeft, right = keys.KeyD || keys.ArrowRight;
  const run = keys.ShiftLeft || keys.ShiftRight;
  const eating = keys.KeyE && Math.abs(player.speed) < 0.4;
  player.eat += ((eating ? 1 : 0) - player.eat) * Math.min(1, dt * 3);
  let target = 0;
  if (!keys.KeyE) { if (fwd) target = run ? TROT_SPEED : WALK_SPEED; else if (back) target = -0.6; }
  player.speed += (target - player.speed) * Math.min(1, dt * (target === 0 ? 3 : run ? 3.4 : 1.6));
  const turnIn = (left ? 1 : 0) - (right ? 1 : 0);
  player.turn += (turnIn - player.turn) * Math.min(1, dt * 4);
  player.yaw += player.turn * (0.85 + 0.25 * Math.min(1, Math.abs(player.speed))) * dt;
  player.pos.x += Math.sin(player.yaw) * player.speed * dt;
  player.pos.z += Math.cos(player.yaw) * player.speed * dt;
  collideCow(player.pos, player.yaw);

  mooT = Math.max(0, mooT - dt);
  player.moo += ((mooT > 0.2 ? 1 : 0) - player.moo) * Math.min(1, dt * 6);
  easeKneel(player, dt);
  const bob = player.rig.update(dt, t, { speed: player.speed, eat: player.eat, moo: player.moo, turn: player.turn, kneel: player.kneel || 0 });
  placeCow(player, dt);
  player.model.position.y = Math.abs(bob) * 0.015 * Math.min(1, Math.abs(player.speed));

  const bite = keys.KeyE && Math.abs(player.speed) < 0.4 ? nearestHarvest() : null;
  if (bite) {
    eatTimer += dt;
    eatBite = bite;
    if (eatTimer >= EAT_HOLD) {
      eatTimer = 0; eatBite = null;
      bite.alive = false; bite.vanish = 0.45; bite.chewing = false;
      if (bite.claimer && bite.claimer !== player) bite.claimer.food = null;
      bite.claimer = null;
      eaten++;
      player.got = eaten; drawTag(player.tag, eaten);
      playHay();
    }
  } else { eatTimer = 0; eatBite = null; }

  if (needs.thirsty && nearPond() && eNow && !bite) {
    needs.drink += dt;
    if (needs.drink >= DRINK_HOLD) { needs.drink = 0; needs.thirsty = false; needs.waterIn = 70 + rand() * 35; }
  } else needs.drink = 0;
  blockFullShelter();
  showNeeds();
}
const needAguaEl = document.getElementById('needAgua'), needDormirEl = document.getElementById('needDormir');
function showNeeds() {
  needAguaEl.classList.toggle('on', needs.thirsty);
  needDormirEl.classList.toggle('on', needs.sleepy);
}

function randomPastureSpot() {
  for (;;) {
    const x = PASTURE.x0 + 6 + rand() * (PASTURE.x1 - PASTURE.x0 - 12);
    const z = PASTURE.z0 + 6 + rand() * (PASTURE.z1 - PASTURE.z0 - 12);
    if (rectMask(x, z, FARM_RECT, 0) > 0 || Math.hypot(x + 14, z + 12) < 4 || bldgMask(x, z) > 0) continue;
    if (Math.abs(x - BARN.x) < BARN.hx + 4 && Math.abs(z - BARN.z) < BARN.hz + 4) continue;
    if (Math.abs(x - FARM.x) < 14 && Math.abs(z - FARM.z) < 14) continue;
    return new V2(x, z);
  }
}

function foodFor(c) {
  const kept = c.food && c.food.alive && c.food !== eatBite && (!c.food.claimer || c.food.claimer === c);
  if (kept) return c.food;
  if (c.food && c.food.claimer === c) { c.food.claimer = null; c.food.chewing = false; }
  c.food = null;
  let best = null, bd = 75;
  for (const h of harvest.slots) {
    if (!h.alive || h === eatBite || (h.claimer && h.claimer !== c)) continue;
    const d = Math.hypot(h.x - c.pos.x, h.z - c.pos.z);
    if (d < bd) { bd = d; best = h; }
  }
  if (best) { best.claimer = c; c.food = best; }
  return best;
}

function steerCow(c, tx, tz, dt, pace) {
  const dx = tx - c.pos.x, dz = tz - c.pos.z, d = Math.hypot(dx, dz);
  const want = Math.atan2(dx, dz);
  let diff = ((want - c.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  c.yaw += diff * Math.min(1, dt * 2.4);
  c.speed += ((d < 0.45 ? 0 : pace) - c.speed) * Math.min(1, dt * 2);
  c.pos.x += Math.sin(c.yaw) * c.speed * dt;
  c.pos.z += Math.cos(c.yaw) * c.speed * dt;
  collideCow(c.pos, c.yaw);
  return d;
}

function updateNpc(c, dt, t) {
  if (rain.on && c.shelter) {
    c.asleep = 0;
    const spot = shelterPoint(c.shelter, c.slot || 0);
    const pace = WALK_SPEED * (0.55 + ((c.seed * 0.17) % 1) * 0.5);
    const d = steerCow(c, spot.x, spot.z, dt, pace);
    if (d < 0.7) c.speed = 0;
    easeKneel(c, dt);
    c.rig.update(dt, t + c.seed, { speed: c.speed, eat: 0, moo: 0, turn: 0, kneel: c.kneel || 0 });
    placeCow(c, dt);
    return;
  }
  if (c.asleep > 0) {
    c.asleep -= dt; c.speed = 0;
    easeKneel(c, dt);
    c.rig.update(dt, t + c.seed, { speed: 0, eat: 0, moo: 0, turn: 0, kneel: c.kneel || 0 });
    placeCow(c, dt);
    if (c.asleep <= 0) c.napIn = 40 + rand() * 35;
    return;
  }
  if (c.napIn == null) c.napIn = 16 + rand() * 18;
  c.napIn -= dt;
  if (c.napIn <= 0 && day.name === 'Noche') {
    const bed = BEDS[Math.abs(Math.floor(c.seed)) % BEDS.length];
    const dx = bed.x - c.pos.x, dz = bed.z - c.pos.z, d = Math.hypot(dx, dz);
    if (d < 2.2) { c.pos.x = bed.x; c.pos.z = bed.z; c.asleep = SLEEP_TIME; easeKneel(c, dt); placeCow(c, dt); return; }
    if (c.food && c.food.claimer === c) { c.food.claimer = null; c.food.chewing = false; c.food = null; }
    const want = Math.atan2(dx, dz);
    let diff = ((want - c.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    c.yaw += diff * Math.min(1, dt * 2);
    c.speed += (WALK_SPEED * 0.8 - c.speed) * Math.min(1, dt * 2);
    c.pos.x += Math.sin(c.yaw) * c.speed * dt;
    c.pos.z += Math.cos(c.yaw) * c.speed * dt;
    collideCow(c.pos, c.yaw);
    easeKneel(c, dt);
    c.rig.update(dt, t + c.seed, { speed: c.speed, eat: 0, moo: 0, turn: 0, kneel: c.kneel || 0 });
    placeCow(c, dt);
    return;
  }
  c.timer -= dt;
  const food = foodFor(c);
  const reach = food ? Math.hypot(food.x - c.pos.x, food.z - c.pos.z) : 99;
  if (food && reach < 1.7) {
    c.state = 'munch';
    food.chewing = true;
    c.speed += (0 - c.speed) * Math.min(1, dt * 4);
    const want = Math.atan2(food.x - c.pos.x, food.z - c.pos.z);
    let diff = ((want - c.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    c.yaw += diff * Math.min(1, dt * 3);
    c.munch = (c.munch || 0) + dt;
    if (c.munch >= EAT_HOLD) {
      food.alive = false; food.vanish = 0.45; food.chewing = false; food.claimer = null;
      c.got = (c.got || 0) + 1; c.food = null; c.munch = 0;
      c.state = 'graze'; c.timer = 2 + rand() * 3;
      drawTag(c.tag, c.got);
    }
  } else if (food) {
    food.chewing = false;
    c.munch = 0;
    c.state = 'seek';
    const want = Math.atan2(food.x - c.pos.x, food.z - c.pos.z);
    let diff = ((want - c.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    c.turn += (Math.max(-1, Math.min(1, diff * 2)) - c.turn) * Math.min(1, dt * 3);
    c.yaw += c.turn * 1.1 * dt;
    const target = Math.abs(diff) > 1.1 ? 0.4 : WALK_SPEED;
    c.speed += (target - c.speed) * Math.min(1, dt * 1.8);
  } else if (c.state === 'walk') {
    const dx = c.goal.x - c.pos.x, dz = c.goal.y - c.pos.z, d = Math.hypot(dx, dz);
    const want = Math.atan2(dx, dz);
    let diff = ((want - c.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    c.turn += (Math.max(-1, Math.min(1, diff * 2)) - c.turn) * Math.min(1, dt * 3);
    c.yaw += c.turn * 0.7 * dt;
    const target = Math.abs(diff) > 1.2 ? 0.35 : WALK_SPEED * 0.75;
    c.speed += (target - c.speed) * Math.min(1, dt * 1.5);
    if (d < 2.5 || c.timer < 0) { c.state = rand() < 0.7 ? 'graze' : 'idle'; c.timer = 4 + rand() * 10; }
  } else {
    c.speed += (0 - c.speed) * Math.min(1, dt * 3);
    c.turn *= 0.9;
    if (c.timer < 0) { c.state = 'walk'; c.goal = randomPastureSpot(); c.timer = 40; }
  }
  c.eat += (((c.state === 'munch' || c.state === 'graze') && c.speed < 0.3 ? 1 : 0) - c.eat) * Math.min(1, dt * 2);
  c.pos.x += Math.sin(c.yaw) * c.speed * dt;
  c.pos.z += Math.cos(c.yaw) * c.speed * dt;
  collideCow(c.pos, c.yaw);
  c.mooT -= dt;
  if (c.mooT < 0) {
    c.mooT = 35 + rand() * 50; c.mooing = 1.6;
    const d = c.pos.distanceTo(player.pos);
    playMoo(Math.max(0, 1 - d / 55) * 0.22, 0.92 + rand() * 0.1);
  }
  c.mooing = Math.max(0, c.mooing - dt);
  c.moo += ((c.mooing > 0.2 ? 1 : 0) - c.moo) * Math.min(1, dt * 6);
  easeKneel(c, dt);
  c.rig.update(dt, t + c.seed, { speed: c.speed, eat: c.eat, moo: c.moo, turn: c.turn, kneel: c.kneel || 0 });
  placeCow(c, dt);
}

const BULL_HOME = { x: -22, z: 16, r: 12 };

function updateBull(b, dt, t) {
  b.timer -= dt;
  let want = b.yaw, target = 0;
  if (b.state === 'walk') {
    want = Math.atan2(b.goal.x - b.pos.x, b.goal.y - b.pos.z);
    target = WALK_SPEED * 0.8;
    if (Math.hypot(b.goal.x - b.pos.x, b.goal.y - b.pos.z) < 2 || b.timer < 0) { b.state = 'graze'; b.timer = 8 + rand() * 14; }
  } else if (b.timer < 0) {
    const a = rand() * Math.PI * 2, d = rand() * BULL_HOME.r;
    b.goal.set(BULL_HOME.x + Math.sin(a) * d, BULL_HOME.z + Math.cos(a) * d);
    b.state = 'walk'; b.timer = 25;
  }

  const diff = ((want - b.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  b.turn += (Math.max(-1, Math.min(1, diff * 2)) - b.turn) * Math.min(1, dt * 3);
  b.yaw += b.turn * 0.6 * dt;
  if (Math.abs(diff) > 1.2) target *= 0.4;
  b.speed += (target - b.speed) * Math.min(1, dt * 1.5);
  b.pos.x += Math.sin(b.yaw) * b.speed * dt;
  b.pos.z += Math.cos(b.yaw) * b.speed * dt;
  collideCow(b.pos, b.yaw, BULL_SCALE);

  b.eat += ((b.state === 'graze' && b.speed < 0.3 ? 1 : 0) - b.eat) * Math.min(1, dt * 1.5);
  const bob = b.rig.update(dt, t, { speed: b.speed, eat: b.eat, turn: b.turn });
  placeCow(b, dt);
  b.model.position.y = Math.abs(bob) * 0.015 * Math.min(1, b.speed);
}

const horses = [];
const HORSE_SPOTS = [[-10, 38], [0, -36], [42, 6]];
const HORSE_EAT = 5, HORSE_RUN = 8.5;

function steerHorse(h, tx, tz, pace, dt) {
  const dx = tx - h.pos.x, dz = tz - h.pos.z;
  const diff = ((Math.atan2(dx, dz) - h.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  h.turn += (Math.max(-1, Math.min(1, diff * 2)) - h.turn) * Math.min(1, dt * 3);
  h.yaw += h.turn * (h.state === 'run' ? 1.1 : 0.8) * dt;
  const target = Math.abs(diff) > 1.1 ? Math.min(pace, h.state === 'run' ? 3 : 0.5) : pace;
  h.speed += (target - h.speed) * Math.min(1, dt * (target > h.speed ? 1.1 : 2));
  return Math.hypot(dx, dz);
}

function bolt(h, awayX, awayZ) {
  if (h.food && h.food.claimer === h) { h.food.claimer = null; h.food.chewing = false; }
  h.food = null; h.munch = 0;
  let best = randomPastureSpot();
  for (let i = 0; i < 6; i++) {
    const s = randomPastureSpot();
    const far = Math.hypot(s.x - h.pos.x, s.y - h.pos.z) > 22;
    const away = awayX == null || (s.x - h.pos.x) * awayX + (s.y - h.pos.z) * awayZ > 0;
    if (far && away) { best = s; break; }
  }
  h.goal.copy(best);
  h.state = 'run'; h.timer = 14;
}

function updateHorse(h, dt, t) {
  h.timer -= dt;
  const pd = Math.hypot(player.pos.x - h.pos.x, player.pos.z - h.pos.z);
  if (h.state !== 'run' && started && pd < 3.6 && Math.abs(player.speed) > 3) bolt(h, h.pos.x - player.pos.x, h.pos.z - player.pos.z);

  const food = h.state === 'run' ? null : foodFor(h);
  const reach = food ? Math.hypot(food.x - h.pos.x, food.z - h.pos.z) : 99;
  if (h.state === 'run') {
    const d = steerHorse(h, h.goal.x, h.goal.y, HORSE_RUN, dt);
    if (d < 6 || h.timer < 0) { h.state = 'walk'; h.goal = randomPastureSpot(); h.timer = 20; }
  } else if (food && reach < 2.1) {
    h.state = 'munch';
    food.chewing = true;
    h.speed += (0 - h.speed) * Math.min(1, dt * 4);
    const diff = ((Math.atan2(food.x - h.pos.x, food.z - h.pos.z) - h.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    h.yaw += diff * Math.min(1, dt * 3);
    if (h.eat > 0.8) h.munch += dt;
    if (h.munch >= HORSE_EAT) {
      food.alive = false; food.vanish = 0.45; food.chewing = false; food.claimer = null;
      h.food = null; h.munch = 0;
      h.state = 'graze'; h.timer = 3 + rand() * 5;
    }
  } else if (food) {
    food.chewing = false;
    h.munch = 0;
    h.state = 'seek';
    steerHorse(h, food.x, food.z, reach > 30 ? 3.4 : 1.6, dt);
  } else if (h.state === 'walk') {
    const d = steerHorse(h, h.goal.x, h.goal.y, 1.6, dt);
    if (d < 2.5 || h.timer < 0) { h.state = rand() < 0.7 ? 'graze' : 'idle'; h.timer = 4 + rand() * 10; }
  } else {
    h.speed += (0 - h.speed) * Math.min(1, dt * 3);
    h.turn *= 0.9;
    if (h.timer < 0) {
      if (rand() < 0.3) bolt(h);
      else { h.state = 'walk'; h.goal = randomPastureSpot(); h.timer = 40; }
    }
  }
  h.eat += (((h.state === 'munch' || h.state === 'graze') && h.speed < 0.3 ? 1 : 0) - h.eat) * Math.min(1, dt * 1.6);
  h.pos.x += Math.sin(h.yaw) * h.speed * dt;
  h.pos.z += Math.cos(h.yaw) * h.speed * dt;
  collideCow(h.pos, h.yaw, 1.36);
  h.rig.update(dt, t + h.seed, { speed: h.speed, eat: h.eat, turn: h.turn });
  placeCow(h, dt);
  h.model.position.y = h.rig.bounce;
}

// Pigs and ducks stay in the small corral; the barn and shed sit in its west corner.
const critters = [];
const YARD = { x0: FARM.x - 0.9 * FARM.s, x1: FARM.x + 0.82 * FARM.s, z0: FARM.z - 0.86 * FARM.s, z1: FARM.z + 0.88 * FARM.s };
const CRITTER = {
  pig: { pace: 0.75, size: 0.45, rad: 0.55, rest: [3, 8] },
  duck: { pace: 0.45, size: 0.22, rad: 0.3, rest: [1.5, 5] },
};
function yardSpot() {
  for (;;) {
    const x = YARD.x0 + rand() * (YARD.x1 - YARD.x0), z = YARD.z0 + rand() * (YARD.z1 - YARD.z0);
    if ((x - FARM.x) / FARM.s < -0.22 && (z - FARM.z) / FARM.s > -0.05) continue;
    return new V2(x, z);
  }
}

function updateCritter(a, dt, t) {
  const cfg = CRITTER[a.kind];
  a.timer -= dt;
  if (a.state === 'walk') {
    const dx = a.goal.x - a.pos.x, dz = a.goal.y - a.pos.z, d = Math.hypot(dx, dz);
    const diff = ((Math.atan2(dx, dz) - a.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    a.yaw += diff * Math.min(1, dt * 2.5);
    const target = Math.abs(diff) > 1.2 ? cfg.pace * 0.3 : cfg.pace;
    a.speed += (target - a.speed) * Math.min(1, dt * 3);
    if (d < 0.6 || a.timer < 0) { a.state = 'idle'; a.timer = cfg.rest[0] + rand() * (cfg.rest[1] - cfg.rest[0]); }
  } else {
    a.speed += (0 - a.speed) * Math.min(1, dt * 4);
    if (a.timer < 0) { a.state = 'walk'; a.goal = yardSpot(); a.timer = 20; }
  }
  a.eat += ((a.state === 'idle' && a.speed < 0.15 ? 1 : 0) - a.eat) * Math.min(1, dt * 2);
  a.pos.x += Math.sin(a.yaw) * a.speed * dt;
  a.pos.z += Math.cos(a.yaw) * a.speed * dt;
  collideCow(a.pos, a.yaw, cfg.size);
  a.pos.x = Math.min(YARD.x1, Math.max(YARD.x0, a.pos.x));
  a.pos.z = Math.min(YARD.z1, Math.max(YARD.z0, a.pos.z));
  a.rig.update(dt, t + a.seed, { speed: a.speed, eat: a.eat });
  placeCow(a, dt);
  a.model.position.y = a.rig.bounce;
}

function separateCows() {
  const all = [player, ...npcs, ...horses, ...critters];
  const rad = (c) => (c.horse ? 1.47 : c.kind ? CRITTER[c.kind].rad : 0.95);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i].pos, b = all[j].pos, dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), min = rad(all[i]) + rad(all[j]);
    if (d < min && d > 1e-4) { const p = (min - d) / 2; a.x -= dx / d * p; a.z -= dz / d * p; b.x += dx / d * p; b.z += dz / d * p; }
  }
  for (const r of remotes.values()) {
    for (const c of all) {
      const a = c.pos, b = r.pos, dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), min = rad(c) + 0.95;
      if (d < min && d > 1e-4) { const p = min - d; a.x -= dx / d * p; a.z -= dz / d * p; }
    }
  }
  for (const c of all) {
    const dx = c.pos.x - bull.pos.x, dz = c.pos.z - bull.pos.z, d = Math.hypot(dx, dz), min = c.horse ? 2.2 : 1.4 * BULL_SCALE;
    if (d < min && d > 1e-4) { c.pos.x += dx / d * (min - d); c.pos.z += dz / d * (min - d); }
  }
}

const _desired = new V3(), _tgt = new V3();
function updateCamera(dt, t) {
  const behind = player.yaw + Math.PI;
  if (t - cam.lastDrag > 1.8 && Math.abs(player.speed) > 0.15) cam.yaw = lerpAngle(cam.yaw, behind, Math.min(1, dt * 1.4));
  _tgt.set(player.pos.x, player.pos.y + 1.35, player.pos.z);
  cam.target.lerp(_tgt, 1 - Math.exp(-dt * 8));
  const cp = Math.cos(cam.pitch);
  _desired.set(cam.target.x + Math.sin(cam.yaw) * cp * cam.dist, cam.target.y + Math.sin(cam.pitch) * cam.dist, cam.target.z + Math.cos(cam.yaw) * cp * cam.dist);
  const floor = terrainH(_desired.x, _desired.z) + 0.5;
  if (_desired.y < floor) _desired.y = floor;
  camera.position.lerp(_desired, 1 - Math.exp(-dt * 7));
  camera.lookAt(cam.target);
}

// ---------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------
let treeSpots = [];

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function init() {
  connectNet();
  const [cowG, farmG, wheatG, grassG, barnG, chapelG, millG, birchMidG, birchFarG, bareG, houseG, baleG, bullG, tractorG, harvestG, truckG, troughG, busG, shelterG, horseG, pigG, duckG, skyT, grassT, zzzT] = await Promise.all([
    loadGLB('cow'), loadGLB('farm'), loadGLB('wheat'), loadGLB('grass'),
    loadGLB('barn'), loadGLB('chapel'), loadGLB('windmill'), loadGLB('birch_mid'), loadGLB('birch_far'), loadGLB('bare'), loadGLB('house'), loadGLB('bale'), loadGLB('bull'), loadGLB('tractor'), loadGLB('harvest'), loadGLB('truck'), loadGLB('trough'), loadGLB('bus'), loadGLB('shelter'), loadGLB('horse'), loadGLB('pig'), loadGLB('duck'),
    loadTex('assets/cielo_loop.jpg'), loadTex('assets/suelo.png'), loadTex('assets/zzz.png'),
  ]);
  loadText.textContent = 'Plantando el trigo…';
  await new Promise((r) => setTimeout(r, 30));

  buildSky(skyT);
  updateDay(0);
  buildGround(grassT);
  buildBuildings({ barn: barnG, chapel: chapelG, windmill: millG, house: houseG });
  buildBales(baleG);
  buildTractor(tractorG);
  buildTruck(truckG);
  buildBus(busG);
  buildShelters(shelterG);
  buildTrough(troughG, zzzT);
  buildRain();
  buildHarvest(harvestG);
  buildFarm(farmG);
  buildPastureFence();
  buildProps();
  treeSpots = pickTreeSpots();
  buildBirches(birchMidG, birchFarG, treeSpots);
  buildBareTrees(bareG);

  // Wheat: impostor field + real 3D bunches flanking the path and the inner patch
  const wheatImp = makeImpostor(wheatG.scene, new THREE.Color('#b99a55'));
  const realWheat = [];
  for (let x = 62; x < 80; x += 2.3) for (const side of [-1, 1]) realWheat.push({ x: x + rand() * 0.6, z: side * (3.4 + rand() * 0.8), rot: rand() * 6, k: 0.85 + rand() * 0.3 });
  for (let i = 0; i < 6; i++) realWheat.push({ x: WHEAT_PATCH.x0 + 1 + rand() * 4, z: WHEAT_PATCH.z0 + 2 + i * 3.4, rot: rand() * 6, k: 0.9 + rand() * 0.2 });
  const wheatCards = [];
  for (const r of [WHEAT_FIELD, WHEAT_PATCH]) {
    for (let x = r.x0 - 2; x < r.x1 + 2; x += 0.62) for (let z = r.z0 - 2; z < r.z1 + 2; z += 0.62) {
      const px = x + (rand() - 0.5) * 0.6, pz = z + (rand() - 0.5) * 0.6;
      const m = wheatMask(px, pz);
      if (m < 0.15 + rand() * 0.6) continue;
      if (realWheat.some((w) => Math.abs(w.x - px) < 0.8 && Math.abs(w.z - pz) < 0.8)) continue;
      wheatCards.push({ x: px, y: terrainH(px, pz) - 0.08, z: pz, rot: rand() * Math.PI, h: (1.15 + rand() * 0.45) * Math.min(1, m + 0.4), tint: 1.05 + rand() * 0.3 });
    }
  }
  buildCardField(wheatImp, wheatCards);
  placeRealFoliage(wheatG, 0.72, realWheat);

  // Grass from the Трава GLB: a dense carpet that follows the cow + scattered tufts far away
  const grassImp = makeImpostor(grassG.scene, new THREE.Color('#5d7f3a'));
  const CARPET_TILE = 100, carpet = [];
  for (let i = 0; i < 70000; i++) {
    carpet.push({ x: rand() * CARPET_TILE, y: 0, z: rand() * CARPET_TILE, rot: rand() * Math.PI, h: 0.17 + rand() * rand() * 0.18, tint: 1 });
  }
  buildCardField(grassImp, carpet, { wrap: CARPET_TILE, ground: grassT });
  const tufts = [];
  const okTuft = (x, z) => wheatMask(x, z) < 0.1 && pathMask(x, z) < 0.1 && roadMask(x, z) < 0.2 && rectMask(x, z, FARM_RECT, 0) < 0.5 && bldgMask(x, z) < 0.1 && Math.hypot(x - POND_AT.x, z - POND_AT.z) > 3.6 && !SHELTERS.some((s) => Math.hypot(x - s.x, z - s.z) < 5) && Math.hypot(x, z) < 330;
  for (let i = 0; i < 8000; i++) {
    const inside = i < 1500;
    const x = inside ? PASTURE.x0 + rand() * 120 : (rand() - 0.5) * 640, z = inside ? PASTURE.z0 + rand() * 92 : (rand() - 0.5) * 640;
    if (!okTuft(x, z)) continue;
    tufts.push({ x, y: terrainH(x, z) - 0.05, z, rot: rand() * Math.PI, h: 0.4 + rand() * 0.4, tint: 1 });
  }
  buildCardField(grassImp, tufts, { ground: grassT });

  // Cows
  cowGltf = cowG;
  player = makeCow(cowG);
  if (net.spawn) {
    player.pos.set(net.spawn.x, 0, net.spawn.z);
    player.yaw = net.spawn.yaw;
    net.placed = true;
  } else {
    player.pos.set(2, 0, 8);
    player.yaw = Math.atan2(FARM.x - 2, FARM.z - 8) + 0.5;
  }
  const npcSpots = [[-8, -8], [18, -20], [28, 14]];
  npcSpots.forEach(([x, z], i) => {
    const c = makeCow(cowG);
    Object.assign(c, { state: 'graze', timer: 2 + rand() * 6, goal: randomPastureSpot(), mooT: 6 + rand() * 20, mooing: 0, seed: i * 13.7 });
    c.pos.set(x, 0, z); c.yaw = rand() * 6.28;
    c.model.traverse((o) => { if (o.isMesh) o.material.color.setScalar(0.92 + i * 0.03); });
    npcs.push(c);
  });
  for (const c of [player, ...npcs]) { c.got = 0; c.tag = makeTag(); drawTag(c.tag, 0); }
  flushRemotes();

  bull = makeBull(bullG);
  bull.pos.set(BULL_HOME.x, 0, BULL_HOME.z); bull.yaw = rand() * 6.28;
  HORSE_SPOTS.forEach(([x, z], i) => {
    const h = makeHorse(horseG, i);
    h.pos.set(x, 0, z);
    horses.push(h);
  });
  for (let i = 0; i < 5; i++) {
    const a = i < 2 ? makeCritter(pigG, PigRig, PIG_SCALE, 'pig', i) : makeCritter(duckG, DuckRig, DUCK_SCALE, 'duck', i);
    const s = yardSpot();
    a.pos.set(s.x, 0, s.y);
    critters.push(a);
  }
  for (const c of [player, ...npcs, ...horses, ...critters]) placeCow(c, 1);
  const look = new V3(player.pos.x, player.pos.y + 1.35, player.pos.z);
  const off = new V3(6.7, 2.05, 5.3);
  const horiz = Math.hypot(off.x, off.z);
  cam.dist = off.length();
  cam.pitch = Math.atan2(off.y, horiz);
  cam.yaw = Math.atan2(off.x, off.z);
  cam.target.copy(look);
  camera.position.copy(look).add(off);
  camera.lookAt(look);
  U.uCenter.value.set(player.pos.x, player.pos.z);
  renderer.compile(scene, camera);
  renderer.render(scene, camera);

  loadBar.style.width = '100%';
  loadText.textContent = '';
  const play = document.getElementById('play');
  play.style.display = 'block';
  play.onclick = () => {
    document.getElementById('intro').classList.add('hidden');
    document.getElementById('hud').style.display = 'block';
    started = true;
    try { initAudio(); } catch (e) { console.warn(e); }
  };
  window.__game = { player, npcs, horses, critters, bull, tractor, harvest, day, camera, scene, renderer, cam, needs, rain, bus, truck, SHELTERS, net, remotes };
  booted = true;
  applyNetSpawn();
  renderer.setAnimationLoop(frame);
}

function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;
  U.uTime.value = t;
  if (started) {
    updateDay(dt);
    harvest.timer -= dt;
    if (harvest.timer < 0) { harvest.timer = 4 + rand() * 4; spawnHarvestAnywhere(); }
  }
  if (started) updatePlayer(dt, t);
  else { player.rig.update(dt, t, { speed: 0 }); placeCow(player, dt); }
  for (const c of npcs) updateNpc(c, dt, t);
  updateBull(bull, dt, t);
  for (const h of horses) updateHorse(h, dt, t);
  for (const a of critters) updateCritter(a, dt, t);
  updateTractor(dt);
  updateTruck(dt);
  updateBus(dt);
  if (started) updateRain(dt);
  updateHarvest(dt, t);
  if (started && !(player.hurt > 0) && (vehicleOverlap(player.pos, truck, 6.0, 1.55) || vehicleOverlap(player.pos, bus, 5.6, 1.7))) runOver();
  for (const c of [player, ...npcs, bull, ...horses]) {
    pushFromTractor(c.pos);
    if (c === player && player.hurt > 0) continue;
    pushFromVehicle(c.pos, truck, 6.0, 1.55);
    pushFromVehicle(c.pos, bus, 5.6, 1.7);
  }
  updateMarkers(t);
  updateRemotes(dt, t);
  separateCows();
  if (player) {
    net.acc += dt;
    if (net.acc >= 1 / 15) { net.acc = 0; sendState(); }
  }
  updateCamera(dt, t);
  U.uCow.value.copy(player.pos);
  U.uCenter.value.set(player.pos.x, player.pos.z);

  sun.target.position.copy(player.pos);
  sun.position.copy(player.pos).addScaledVector(SUN_DIR, 120);
  for (const o of nearFoliage) o.visible = o.position.distanceToSquared(camera.position) < 90 * 90;
  updateForest(dt);

  if (started) {
    if ((dragging || t - cam.lastDrag < 0.35) && t - cam.lastLog > 0.15) {
      cam.lastLog = t;
      const p = camera.position;
      console.log(`Cámara  x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}  z ${p.z.toFixed(1)}`);
    }
  }
  renderer.render(scene, camera);
  sealAlpha();
}

// Some browsers keep an alpha channel on the canvas anyway; alpha-to-coverage
// grass would then let the page background show through blade edges.
function sealAlpha() {
  const gl = renderer.getContext();
  gl.colorMask(false, false, false, true);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.colorMask(true, true, true, true);
  renderer.state.reset();
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

init().catch((e) => { console.error(e); loadText.textContent = 'Error cargando: ' + e.message; });
