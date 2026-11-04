import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ---------- Fichiers statiques ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (url === '/') file = path.join(__dirname, 'public', 'index.html');
  else if (url.startsWith('/vendor/three/')) file = path.join(__dirname, 'node_modules/three/build', path.basename(url));
  else file = path.join(__dirname, 'public', path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- Constantes de jeu (mètres) ----------
const L = 2.74, W = 1.525, TH = 0.76, R = 0.04, NETH = 0.1525;
const G = 6;                  // gravité réduite : la raquette "flotte"
const PZ = L / 2 + 0.35;      // profondeur de la balle du joueur derrière le bord de table
const HIT_R = 0.32;           // tolérance de frappe
const SIDE_A = 3.0;           // courbe latérale max (m/s²) due à l'effet latéral
const TOP_A = 3.5;            // plongée (lifté) / flottement (coupé) max (m/s²)
const WIN = 7;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);
const sgn = (p) => (p === 0 ? 1 : -1); // joueur 0 côté z>0, joueur 1 côté z<0

const BOT_LEVELS = {
  facile: { speed: 1.3, err: 0.40, react: 0.30 },
  moyen: { speed: 2.0, err: 0.34, react: 0.20 },
  difficile: { speed: 3.0, err: 0.28, react: 0.10 },
};

// Intègre la physique d'un objet volant (gravité + effet). Renvoie true si rebond sur la table.
// b: {x,y,z,vx,vy,vz,ss,ts} — ss = effet latéral (-1..1, sens x monde), ts = lifté(+)/coupé(-)
function integrate(b, dt) {
  b.vx += b.ss * SIDE_A * dt;
  b.vy += (-G - b.ts * TOP_A) * dt;
  const py = b.y;
  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
  const k = Math.exp(-0.25 * dt); b.ss *= k; b.ts *= k;
  if (b.vy < 0 && b.y - R <= TH && py - R >= TH - 0.15 && Math.abs(b.x) <= W / 2 && Math.abs(b.z) <= L / 2) {
    b.y = TH + R; b.vy = -b.vy * 0.88; b.vx *= 0.98; b.vz *= 0.98;
    // l'effet "mord" la table : le lifté accélère, le coupé freine, le latéral dévie
    b.vz += Math.sign(b.vz) * b.ts * 0.9;
    b.vx += b.ss * 0.7;
    b.ss *= 0.5; b.ts *= 0.5;
    return true;
  }
  return false;
}

// Prédit où l'objet traversera le plan z = zp (utilisé par le bot)
function predict(src, zp) {
  const b = { ...src };
  for (let t = 0; t < 3; t += 1 / 120) {
    const pz = b.z, px = b.x, py = b.y;
    integrate(b, 1 / 120);
    if ((pz - zp) * (b.z - zp) <= 0) {
      const f = (zp - pz) / ((b.z - pz) || 1e-6);
      return { x: px + (b.x - px) * f, y: py + (b.y - py) * f, t };
    }
    if (b.y < 0) return null;
  }
  return null;
}

class Game {
  constructor(onState, botLevel = null) {
    this.onState = onState;
    this.bot = botLevel ? BOT_LEVELS[botLevel] || BOT_LEVELS.moyen : null;
    this.score = [0, 0];
    this.pad = [0, 1].map(() => ({ x: 0, y: TH + 0.2, px: 0, py: TH + 0.2, vx: 0, vy: 0 }));
    this.ball = { x: 0, y: TH + 0.5, z: 0, vx: 0, vy: 0, vz: 0, ss: 0, ts: 0 };
    this.phase = 'wait';
    this.server = 0; this.lastHitter = 0; this.stage = '';
    this.winner = -1; this.lastScorer = -1; this.timer = 0;
    this.ev = [];
    this.botT = 0; this.botErr = { x: 0, y: 0 }; this.botServeX = 0;
    this.lat = [0, 0];        // ping aller-retour de chaque joueur (s)
    this.pending = null;      // frappe "en attente" : la balle a passé le joueur, son geste peut encore arriver
    this.deferred = null;     // point mis en attente pendant ce temps
    this.last = Date.now();
    this.loop = setInterval(() => this.tick(), 1000 / 60);
  }
  stop() { clearInterval(this.loop); }

  begin() { this.score = [0, 0]; this.server = 0; this.toServe(); }
  toServe() { this.phase = 'serve'; this.stage = ''; this.pending = null; this.deferred = null; this.botT = 1.3; this.botServeX = rnd(-0.4, 0.4); }

  setPad(p, lx, ly, vx, vy) {
    const s = sgn(p), pad = this.pad[p];
    pad.x = clamp(lx, -1, 1) * s;
    pad.y = clamp(ly, TH - 0.25, TH + 0.9);
    // vitesse du geste mesurée côté joueur : sur Internet les messages arrivent par paquets,
    // la recalculer ici donnerait de faux pics (et donc de l'effet / du feu au hasard)
    if (Number.isFinite(vx) && Number.isFinite(vy)) { pad.cvx = clamp(vx, -6, 6) * s; pad.cvy = clamp(vy, -6, 6); pad.cv = true; }
  }

  serve(p) {
    if (this.phase === 'over') { this.begin(); return; }
    if (this.phase !== 'serve' || p !== this.server) return;
    const sg = sgn(p), b = this.ball;
    b.vx = 0; b.vy = 0; b.vz = -sg * 2.4; b.ss = 0; b.ts = 0;
    this.phase = 'rally'; this.stage = 'serveOwn'; this.lastHitter = p;
    this.ev.push('hit');
  }

  point(winner) {
    if (this.phase !== 'rally') return;
    if (this.pending) { this.deferred = winner; return; }
    this.score[winner]++;
    this.lastScorer = winner;
    this.timer = 1.8;
    if (this.score[winner] >= WIN) { this.winner = winner; this.phase = 'over'; }
    else this.phase = 'point';
    this.ev.push('point');
  }
  fault(hitter) { this.point(1 - hitter); }

  // Frappe : l'effet vient du geste (vitesse de la balle du joueur au contact).
  // La visée est corrigée en simulant le vol, pour que le tir courbe MAIS retombe sur la table.
  hit(p) {
    const b = this.ball, pad = this.pad[p], sg = sgn(p);
    const ss = clamp(pad.vx / 2.5, -1, 1);   // geste latéral -> effet latéral
    const ts = clamp(pad.vy / 2.0, -1, 1);   // geste vers le haut -> lifté, vers le bas -> coupé
    const power = clamp(Math.hypot(pad.vx, pad.vy), 0, 3);
    const tx = clamp((b.x - pad.x) * 2.5, -0.5, 0.5);
    const tz = -sg * (0.6 + 0.12 * power);
    const T = clamp(0.75 - 0.04 * power, 0.62, 0.75);
    let vx = (tx - b.x) / T, vz = (tz - b.z) / T, vy = (TH + R - b.y + 0.5 * G * T * T) / T;
    for (let it = 0; it < 10; it++) {
      const sim = { x: b.x, y: b.y, z: b.z, vx, vy, vz, ss, ts };
      let t = 0, yNet = Infinity;
      while (t < 2.5) {
        const pz = sim.z;
        sim.vx += sim.ss * SIDE_A / 240; sim.vy += (-G - sim.ts * TOP_A) / 240;
        sim.x += sim.vx / 240; sim.y += sim.vy / 240; sim.z += sim.vz / 240;
        const k = Math.exp(-0.25 / 240); sim.ss *= k; sim.ts *= k;
        t += 1 / 240;
        if ((pz > 0) !== (sim.z > 0)) yNet = sim.y;
        if (sim.vy < 0 && sim.y <= TH + R) break;
      }
      if (yNet < TH + NETH + R + 0.04) { vy += 0.25; continue; }
      const ex = tx - sim.x, ez = tz - sim.z;
      if (Math.abs(ex) < 0.01 && Math.abs(ez) < 0.01) break;
      vx += ex / t; vz += ez / t;
    }
    Object.assign(b, { vx, vy, vz, ss, ts });
    this.pending = null; this.deferred = null;
    this.lastHitter = p; this.stage = 'needOpp';
    this.ev.push('hit');
    if (this.bot && p === 0) {
      this.botT = this.bot.react;
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * this.bot.err;
      this.botErr = { x: Math.cos(a) * r, y: Math.sin(a) * r };
    }
  }

  // IA du bot (joueur 1, côté z<0)
  botThink(dt) {
    const pad = this.pad[1], lv = this.bot;
    let tx = pad.x, ty = pad.y;
    if (this.phase === 'serve' && this.server === 1) {
      tx = this.botServeX; ty = TH + 0.25;
      if ((this.botT -= dt) <= 0) this.serve(1);
    } else if (this.phase === 'rally' && this.lastHitter === 0) {
      if ((this.botT -= dt) <= 0) {
        const pr = predict(this.ball, -PZ);
        if (pr) { tx = pr.x + this.botErr.x; ty = pr.y + this.botErr.y; }
      }
    } else { tx = 0; ty = TH + 0.25; }
    const dx = tx - pad.x, dy = ty - pad.y, d = Math.hypot(dx, dy), m = lv.speed * dt;
    if (d > m) { pad.x += dx / d * m; pad.y += dy / d * m; } else { pad.x = tx; pad.y = ty; }
    pad.x = clamp(pad.x, -1, 1); pad.y = clamp(pad.y, TH - 0.25, TH + 0.9);
  }

  step(dt) {
    const b = this.ball;
    if (this.phase === 'serve') {
      const sg = sgn(this.server);
      b.x = clamp(this.pad[this.server].x, -0.6, 0.6); b.y = TH + 0.3; b.z = sg * 1.1;
      b.vx = b.vy = b.vz = b.ss = b.ts = 0;
      return;
    }
    if (this.phase === 'wait') return;
    const px = b.x, py = b.y, pz = b.z;
    const bounced = integrate(b, dt);
    const live = this.phase === 'rally';

    // filet
    if ((pz > 0) !== (b.z > 0) && b.y - R < TH + NETH && b.y > TH - 0.05 && Math.abs(b.x) < W / 2 + 0.15) {
      b.z = pz; b.vz *= -0.15; b.vx *= 0.3;
      this.ev.push('net');
      if (live) this.fault(this.lastHitter);
    }
    if (bounced) { this.ev.push('bounce'); if (live) this.onTable(b.z > 0 ? 0 : 1); }
    // sol
    if (b.y <= R && b.vy < 0) {
      b.y = R; b.vy = -b.vy * 0.5; b.vx *= 0.8; b.vz *= 0.8; b.ss = b.ts = 0;
      if (live) {
        if (this.stage === 'bouncedOpp') this.point(this.lastHitter);
        else this.fault(this.lastHitter);
      }
    }
    // frappe du receveur
    if (live && this.stage === 'bouncedOpp') {
      const r = 1 - this.lastHitter, sg = sgn(r), zp = sg * PZ;
      if ((pz - zp) * (b.z - zp) <= 0 && b.vz * sg > 0) {
        const f = (zp - pz) / ((b.z - pz) || 1e-6);
        const cx = px + (b.x - px) * f, cy = py + (b.y - py) * f;
        const pad = this.pad[r];
        if (Math.hypot(cx - pad.x, cy - pad.y) < HIT_R) {
          b.x = cx; b.y = cy; b.z = zp;
          this.hit(r);
        } else {
          // le joueur voit la raquette avec du retard : on lui laisse le temps (son ping + l'affichage) de la toucher
          this.pending = { r, cx, cy, zp, age: 0, max: clamp(this.lat[r] + 0.12, 0.08, 0.45) };
        }
      }
    }
  }

  onTable(side) {
    const h = this.lastHitter;
    if (this.stage === 'serveOwn') {
      if (side === h) this.stage = 'needOpp'; else this.fault(h);
    } else if (this.stage === 'needOpp') {
      if (side !== h) this.stage = 'bouncedOpp'; else this.fault(h);
    } else if (this.stage === 'bouncedOpp') {
      if (side !== h) this.point(h);
    }
  }

  tick() {
    const now = Date.now();
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    if (dt <= 0) return;
    if (this.bot) this.botThink(dt);
    for (const p of this.pad) {
      if (p.cv) { p.vx = p.cvx; p.vy = p.cvy; }
      else { p.vx += ((p.x - p.px) / dt - p.vx) * 0.4; p.vy += ((p.y - p.py) / dt - p.vy) * 0.4; }
      p.px = p.x; p.py = p.y;
    }
    const n = Math.ceil(dt / (1 / 120));
    for (let i = 0; i < n; i++) this.step(dt / n);
    const pd = this.pending;
    if (pd) {
      pd.age += dt;
      const pad = this.pad[pd.r];
      if (this.phase === 'rally' && Math.hypot(pd.cx - pad.x, pd.cy - pad.y) < HIT_R) {
        Object.assign(this.ball, { x: pd.cx, y: pd.cy, z: pd.zp });
        this.hit(pd.r);
      } else if (pd.age > pd.max) {
        this.pending = null;
        if (this.deferred !== null) { const w = this.deferred; this.deferred = null; this.point(w); }
      }
    }
    if (this.phase === 'point' && (this.timer -= dt) <= 0) {
      this.server = Math.floor((this.score[0] + this.score[1]) / 2) % 2;
      this.toServe();
    }
    const r3 = (v) => Math.round(v * 1000) / 1000, r2 = (v) => Math.round(v * 100) / 100;
    const b = this.ball;
    this.onState({
      t: 's', ts: now, b: [r3(b.x), r3(b.y), r3(b.z)], sp: [r2(b.ss), r2(b.ts)],
      p: this.pad.map((p) => [r3(p.x), r3(p.y)]),
      sc: this.score, ph: this.phase, sv: this.server, lh: this.lastHitter,
      w: this.phase === 'over' ? this.winner : this.lastScorer,
      ev: this.ev.splice(0),
    });
  }
}

// ---------- Salles + WebSocket ----------
const rooms = new Map();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => {
  let c;
  do { c = Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join(''); } while (rooms.has(c));
  return c;
};
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  room.game?.stop();
  rooms.delete(room.code);
  for (const o of room.players) if (o !== ws && o.readyState === 1) { o.room = null; send(o, { t: 'left' }); }
}

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.room = null;
  const pinger = setInterval(() => send(ws, { t: 'ping', ts: Date.now() }), 1000);
  ws.on('close', () => clearInterval(pinger));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'create') {
      leave(ws);
      const code = newCode();
      const room = { code, players: [ws], game: null };
      rooms.set(code, room); ws.room = room; ws.idx = 0;
      send(ws, { t: 'created', code });
    } else if (m.t === 'bot') {
      leave(ws);
      const level = BOT_LEVELS[m.level] ? m.level : 'moyen';
      const room = { code: 'BOT-' + newCode(), players: [ws], game: null };
      rooms.set(room.code, room); ws.room = room; ws.idx = 0;
      room.game = new Game((st) => send(ws, st), level);
      send(ws, { t: 'start', you: 0, bot: level });
      room.game.begin();
    } else if (m.t === 'join') {
      leave(ws);
      const room = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!room || room.game) return send(ws, { t: 'err', msg: room ? 'Partie déjà complète.' : 'Code introuvable.' });
      room.players.push(ws); ws.room = room; ws.idx = 1;
      room.game = new Game((st) => room.players.forEach((p) => send(p, st)));
      room.players.forEach((p, i) => send(p, { t: 'start', you: i }));
      room.game.begin();
    } else if (m.t === 'leave') {
      leave(ws);
    } else if (m.t === 'pad' && ws.room?.game) {
      if (Number.isFinite(m.x) && Number.isFinite(m.y)) ws.room.game.setPad(ws.idx, m.x, m.y, m.vx, m.vy);
    } else if (m.t === 'pong' && Number.isFinite(m.ts)) {
      const rtt = clamp((Date.now() - m.ts) / 1000, 0, 1);
      ws.rtt = ws.rtt === undefined ? rtt : ws.rtt * 0.7 + rtt * 0.3;
      if (ws.room?.game) ws.room.game.lat[ws.idx] = ws.rtt;
    } else if (m.t === 'serve' && ws.room?.game) {
      ws.room.game.serve(ws.idx);
    }
  });
  ws.on('close', () => leave(ws));
});

server.listen(PORT, () => console.log(`Ping Pong prêt : http://localhost:${PORT}`));
