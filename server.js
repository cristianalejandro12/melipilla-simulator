import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// Pasture spots, far enough apart that two cows never start on top of each other.
const SPAWNS = [
  [2, 8],
  [-22, 22],
  [36, -8],
  [-52, 30],
  [12, -34],
  [-16, 36],
  [50, 4],
  [-48, 18],
  [18, 28],
  [-36, 8],
  [8, 22],
  [-8, -36],
  [48, -28],
  [-28, -36],
  [32, 8],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
};

const players = new Map();
let seq = 1;

function clamp(n, a, b, fallback) {
  n = Number(n);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(b, Math.max(a, n));
}

function yawAt(x, z) {
  return Math.atan2(-32 - x, -24 - z) + (Math.random() - 0.5) * 0.8;
}

function pickSpawn() {
  const taken = [...players.values()];
  if (taken.length === 0) {
    const [x, z] = SPAWNS[0];
    return { x, z, yaw: yawAt(x, z) };
  }
  let best = SPAWNS[0];
  let bestD = -1;
  for (const [x, z] of SPAWNS) {
    let dmin = Infinity;
    for (const p of taken) dmin = Math.min(dmin, Math.hypot(p.x - x, p.z - z));
    if (dmin > bestD) {
      bestD = dmin;
      best = [x, z];
    }
  }
  let x = best[0];
  let z = best[1];
  if (bestD < 4) {
    const a = Math.random() * Math.PI * 2;
    const d = 5 + Math.random() * 4;
    x = Math.max(-54, Math.min(54, x + Math.sin(a) * d));
    z = Math.max(-40, Math.min(40, z + Math.cos(a) * d));
  }
  return { x, z, yaw: yawAt(x, z) };
}

function snapshot(p) {
  return { id: p.id, x: p.x, z: p.z, y: p.yaw, v: p.speed, e: p.eat, m: p.moo, k: p.kneel, g: p.got, a: p.animal || 'v' };
}

function broadcast(except, obj) {
  const raw = JSON.stringify(obj);
  for (const ws of players.keys()) {
    if (ws !== except && ws.readyState === 1) ws.send(raw);
  }
}

function safeFile(urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.resolve(ROOT, '.' + rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

const server = http.createServer((req, res) => {
  const full = safeFile(req.url || '/');
  if (!full) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': full.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(full).pipe(res);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const spawn = pickSpawn();
  const player = {
    id: seq++,
    x: spawn.x,
    z: spawn.z,
    yaw: spawn.yaw,
    speed: 0,
    eat: 0,
    moo: 0,
    kneel: 0,
    got: 0,
    animal: 'v',
  };
  players.set(ws, player);
  const peers = [];
  for (const other of players.values()) if (other !== player) peers.push(snapshot(other));
  ws.send(JSON.stringify({ t: 'w', ...snapshot(player), peers }));
  broadcast(ws, { t: 's', ...snapshot(player) });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const raw = typeof data === 'string' ? data : data.toString();
    if (raw.length > 500) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg) return;
    const p = players.get(ws);
    if (!p) return;
    if (msg.t === 'k') {
      const id = Number(msg.id);
      const fx = Number(msg.x), fz = Number(msg.z);
      if (!Number.isFinite(id) || id === p.id || !Number.isFinite(fx) || !Number.isFinite(fz)) return;
      let victim = null;
      for (const other of players.values()) if (other.id === id) victim = other;
      if (!victim || Math.hypot(victim.x - p.x, victim.z - p.z) > 4.5) return;
      const nowK = Date.now();
      if (p.knockAt && nowK - p.knockAt < 700) return;
      p.knockAt = nowK;
      const n = Math.hypot(fx, fz) || 1;
      broadcast(ws, { t: 'k', id, x: +(fx / n).toFixed(3), z: +(fz / n).toFixed(3), p: 40 });
      return;
    }
    if (msg.t !== 's') return;
    const nx = clamp(msg.x, -450, 450, p.x);
    const nz = clamp(msg.z, -450, 450, p.z);
    const now = Date.now();
    if (!p.seen || msg.j) {
      p.x = nx;
      p.z = nz;
      p.seen = true;
    } else {
      const dt = Math.min(0.5, Math.max(0.02, (now - (p.at || now)) / 1000));
      const maxD = (Math.abs(clamp(msg.v, -3, 12, 0)) + 8) * dt + 2;
      const dx = nx - p.x, dz = nz - p.z, d = Math.hypot(dx, dz);
      if (d > maxD && d > 0) {
        p.x += dx / d * maxD;
        p.z += dz / d * maxD;
      } else {
        p.x = nx;
        p.z = nz;
      }
    }
    p.at = now;
    p.yaw = clamp(msg.y, -100, 100, p.yaw);
    p.speed = clamp(msg.v, -3, 12, 0);
    p.eat = clamp(msg.e, 0, 1, 0);
    p.moo = clamp(msg.m, 0, 1, 0);
    p.kneel = clamp(msg.k, 0, 1, 0);
    p.got = Math.round(clamp(msg.g, 0, 9999, 0));
    p.animal = ['h', 'p', 'g', 'd'].includes(msg.a) ? msg.a : 'v';
    broadcast(ws, { t: 's', ...snapshot(p) });
  });

  const drop = () => {
    if (!players.has(ws)) return;
    const p = players.get(ws);
    players.delete(ws);
    broadcast(null, { t: 'l', id: p.id });
  };
  ws.on('close', drop);
  ws.on('error', drop);
});

const beat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(beat));

server.listen(PORT, HOST, () => {
  console.log(`Melipilla en http://localhost:${PORT}`);
});
