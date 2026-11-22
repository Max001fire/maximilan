// KurvenCrew – Server: REST-API + WebSocket für Live-Positionen
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');

// ---------- Mini-Datenbank (JSON-Datei) ----------
function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { users: {}, spots: {}, rides: {}, sessions: [] };
  }
}
const db = loadDb();
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  }, 200);
}

const id = () => crypto.randomUUID();
const shortCode = (len = 6) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(len)) s += chars[b % chars.length];
  return s;
};
const VEHICLES = ['motorcycle', 'car'];
const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const publicUser = (u) => u && { id: u.id, name: u.name, vehicle: u.vehicle, code: u.code, color: u.color };
const userByCode = (code) => Object.values(db.users).find((u) => u.code === String(code).toUpperCase());

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));

// ---------- Nutzer & Freunde ----------
const COLORS = ['#ff5a36', '#2ec4b6', '#ffbf00', '#9b5de5', '#00bbf9', '#f15bb5', '#80ed99', '#fb8500'];

app.post('/api/users', (req, res) => {
  const name = str(req.body.name, 30);
  if (!name) return res.status(400).json({ error: 'Name fehlt' });
  const vehicle = VEHICLES.includes(req.body.vehicle) ? req.body.vehicle : 'motorcycle';
  let code;
  do code = shortCode(); while (userByCode(code));
  const u = { id: id(), name, vehicle, code, color: COLORS[Object.keys(db.users).length % COLORS.length], friends: [], createdAt: Date.now() };
  db.users[u.id] = u;
  save();
  res.json(publicUser(u));
});

app.get('/api/users/:id', (req, res) => {
  const u = db.users[req.params.id];
  if (!u) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
  res.json(publicUser(u));
});

app.put('/api/users/:id', (req, res) => {
  const u = db.users[req.params.id];
  if (!u) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
  if (req.body.name) u.name = str(req.body.name, 30) || u.name;
  if (VEHICLES.includes(req.body.vehicle)) u.vehicle = req.body.vehicle;
  save();
  res.json(publicUser(u));
});

app.get('/api/users/:id/friends', (req, res) => {
  const u = db.users[req.params.id];
  if (!u) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
  res.json(u.friends.map((f) => publicUser(db.users[f])).filter(Boolean));
});

app.post('/api/users/:id/friends', (req, res) => {
  const u = db.users[req.params.id];
  if (!u) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
  const f = userByCode(req.body.code || '');
  if (!f) return res.status(404).json({ error: 'Kein Fahrer mit diesem Code' });
  if (f.id === u.id) return res.status(400).json({ error: 'Das bist du selbst 😉' });
  if (!u.friends.includes(f.id)) u.friends.push(f.id);
  if (!f.friends.includes(u.id)) f.friends.push(u.id); // Freundschaft beidseitig
  save();
  res.json(publicUser(f));
});

app.delete('/api/users/:id/friends/:friendId', (req, res) => {
  const u = db.users[req.params.id];
  const f = db.users[req.params.friendId];
  if (!u) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
  u.friends = u.friends.filter((x) => x !== req.params.friendId);
  if (f) f.friends = f.friends.filter((x) => x !== u.id);
  save();
  res.json({ ok: true });
});

// ---------- Kurvenspots ----------
function parsePoint(p) {
  if (!p) return null;
  const lat = num(p.lat, -90, 90);
  const lng = num(p.lng, -180, 180);
  return lat === null || lng === null ? null : { lat, lng };
}

app.get('/api/spots', (req, res) => {
  res.json(Object.values(db.spots).map((s) => ({ ...s, creatorName: db.users[s.creatorId]?.name || 'Unbekannt' })));
});

app.post('/api/spots', (req, res) => {
  const creator = db.users[req.body.userId];
  if (!creator) return res.status(401).json({ error: 'Unbekannter Nutzer' });
  const start = parsePoint(req.body.start);
  const end = parsePoint(req.body.end);
  const name = str(req.body.name, 60);
  if (!name || !start) return res.status(400).json({ error: 'Name und Startpunkt erforderlich' });
  const s = {
    id: id(),
    name,
    description: str(req.body.description, 500),
    start,
    end,
    difficulty: num(req.body.difficulty, 1, 5) || 3,
    vehicles: Array.isArray(req.body.vehicles) ? req.body.vehicles.filter((v) => VEHICLES.includes(v)) : VEHICLES,
    creatorId: creator.id,
    likes: [],
    createdAt: Date.now(),
  };
  db.spots[s.id] = s;
  save();
  res.json(s);
});

app.post('/api/spots/:id/like', (req, res) => {
  const s = db.spots[req.params.id];
  if (!s) return res.status(404).json({ error: 'Spot nicht gefunden' });
  if (!db.users[req.body.userId]) return res.status(401).json({ error: 'Unbekannter Nutzer' });
  const i = s.likes.indexOf(req.body.userId);
  if (i >= 0) s.likes.splice(i, 1);
  else s.likes.push(req.body.userId);
  save();
  res.json(s);
});

app.delete('/api/spots/:id', (req, res) => {
  const s = db.spots[req.params.id];
  if (!s) return res.status(404).json({ error: 'Spot nicht gefunden' });
  if (s.creatorId !== req.query.userId) return res.status(403).json({ error: 'Nur der Ersteller darf löschen' });
  delete db.spots[s.id];
  save();
  res.json({ ok: true });
});

// ---------- Gruppenfahrten ----------
app.post('/api/rides', (req, res) => {
  const host = db.users[req.body.userId];
  if (!host) return res.status(401).json({ error: 'Unbekannter Nutzer' });
  let code;
  do code = shortCode(5); while (db.rides[code]);
  const route = req.body.route && Array.isArray(req.body.route.coordinates)
    ? { coordinates: req.body.route.coordinates.slice(0, 20000), distance: Number(req.body.route.distance) || 0, duration: Number(req.body.route.duration) || 0, spotIds: (req.body.route.spotIds || []).slice(0, 50) }
    : null;
  const ride = { code, name: str(req.body.name, 60) || `Tour von ${host.name}`, hostId: host.id, route, createdAt: Date.now() };
  db.rides[code] = ride;
  save();
  res.json(ride);
});

app.get('/api/rides/:code', (req, res) => {
  const ride = db.rides[req.params.code.toUpperCase()];
  if (!ride) return res.status(404).json({ error: 'Fahrt nicht gefunden' });
  res.json({ ...ride, hostName: db.users[ride.hostId]?.name, online: roomMembers(ride.code) });
});

app.put('/api/rides/:code/route', (req, res) => {
  const ride = db.rides[req.params.code.toUpperCase()];
  if (!ride) return res.status(404).json({ error: 'Fahrt nicht gefunden' });
  if (ride.hostId !== req.body.userId) return res.status(403).json({ error: 'Nur der Gastgeber darf die Route ändern' });
  ride.route = req.body.route;
  save();
  broadcast(ride.code, { type: 'route', route: ride.route });
  res.json(ride);
});

// ---------- Aufgezeichnete Fahrten / Statistiken ----------
app.post('/api/sessions', (req, res) => {
  const u = db.users[req.body.userId];
  if (!u) return res.status(401).json({ error: 'Unbekannter Nutzer' });
  const b = req.body;
  const vehicle = VEHICLES.includes(b.vehicle) ? b.vehicle : u.vehicle;
  const s = {
    id: id(),
    userId: u.id,
    rideCode: b.rideCode && db.rides[b.rideCode] ? b.rideCode : null,
    vehicle,
    startedAt: num(b.startedAt, 0, 1e14) || Date.now(),
    duration: num(b.duration, 0, 1e9) || 0, // Sekunden (Fahrzeit)
    distance: num(b.distance, 0, 1e8) || 0, // Meter
    maxSpeed: num(b.maxSpeed, 0, 500) || 0, // km/h
    avgSpeed: num(b.avgSpeed, 0, 500) || 0, // km/h
    maxLeanLeft: vehicle === 'motorcycle' ? num(b.maxLeanLeft, 0, 70) || 0 : null,
    maxLeanRight: vehicle === 'motorcycle' ? num(b.maxLeanRight, 0, 70) || 0 : null,
    maxLatG: vehicle === 'car' ? num(b.maxLatG, 0, 5) || 0 : null,
    maxAccelG: vehicle === 'car' ? num(b.maxAccelG, 0, 5) || 0 : null,
    maxBrakeG: vehicle === 'car' ? num(b.maxBrakeG, 0, 5) || 0 : null,
    maxTotalG: vehicle === 'car' ? num(b.maxTotalG, 0, 5) || 0 : null,
    track: Array.isArray(b.track) ? b.track.slice(0, 20000) : [],
  };
  db.sessions.push(s);
  save();
  res.json({ id: s.id });
});

function summarize(s) {
  const { track, ...rest } = s;
  const u = db.users[s.userId];
  return { ...rest, userName: u?.name || 'Unbekannt', userColor: u?.color, points: track.length };
}

app.get('/api/users/:id/sessions', (req, res) => {
  res.json(db.sessions.filter((s) => s.userId === req.params.id).map(summarize).reverse());
});

app.get('/api/sessions/:id', (req, res) => {
  const s = db.sessions.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Fahrt nicht gefunden' });
  res.json({ ...summarize(s), track: s.track });
});

app.get('/api/rides/:code/results', (req, res) => {
  const code = req.params.code.toUpperCase();
  res.json(db.sessions.filter((s) => s.rideCode === code).map(summarize));
});

// Bestenliste: beste Werte pro Fahrer (du + Freunde oder alle)
app.get('/api/leaderboard', (req, res) => {
  const vehicle = VEHICLES.includes(req.query.vehicle) ? req.query.vehicle : 'motorcycle';
  const me = db.users[req.query.userId];
  let allowed = null;
  if (req.query.scope !== 'all') {
    if (!me) return res.status(401).json({ error: 'Unbekannter Nutzer' });
    allowed = new Set([me.id, ...me.friends]);
  }
  const best = {};
  for (const s of db.sessions) {
    if (s.vehicle !== vehicle || (allowed && !allowed.has(s.userId))) continue;
    const u = db.users[s.userId];
    if (!u) continue;
    const b = (best[s.userId] ||= {
      userId: u.id, name: u.name, color: u.color, rides: 0, distance: 0,
      maxSpeed: 0, avgSpeed: 0, maxLean: 0, maxLatG: 0, maxBrakeG: 0, maxAccelG: 0, maxTotalG: 0,
    });
    b.rides++;
    b.distance += s.distance;
    b.maxSpeed = Math.max(b.maxSpeed, s.maxSpeed);
    b.avgSpeed = Math.max(b.avgSpeed, s.avgSpeed);
    b.maxLean = Math.max(b.maxLean, s.maxLeanLeft || 0, s.maxLeanRight || 0);
    b.maxLatG = Math.max(b.maxLatG, s.maxLatG || 0);
    b.maxBrakeG = Math.max(b.maxBrakeG, s.maxBrakeG || 0);
    b.maxAccelG = Math.max(b.maxAccelG, s.maxAccelG || 0);
    b.maxTotalG = Math.max(b.maxTotalG, s.maxTotalG || 0);
  }
  res.json(Object.values(best));
});

// ---------- Proxy für Routing (OSRM) & Ortssuche (Nominatim) ----------
const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const UA = 'KurvenCrew/1.0 (self-hosted ride app)';
const cache = new Map();
async function cachedFetch(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.body;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de' } });
  if (!r.ok) throw new Error(`Upstream ${r.status}`);
  const body = await r.json();
  if (cache.size > 500) cache.clear();
  cache.set(url, { t: Date.now(), body });
  return body;
}

app.post('/api/route', async (req, res) => {
  const pts = (req.body.points || []).map(parsePoint).filter(Boolean);
  if (pts.length < 2 || pts.length > 60) return res.status(400).json({ error: '2–60 Wegpunkte nötig' });
  const coords = pts.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  try {
    const data = await cachedFetch(`${OSRM_URL}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`);
    if (data.code !== 'Ok' || !data.routes?.length) return res.status(422).json({ error: 'Keine Route gefunden' });
    const r = data.routes[0];
    res.json({ coordinates: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]), distance: r.distance, duration: r.duration });
  } catch (e) {
    res.status(502).json({ error: 'Routing-Dienst nicht erreichbar: ' + e.message });
  }
});

app.get('/api/geocode', async (req, res) => {
  const q = str(req.query.q, 200);
  if (!q) return res.json([]);
  try {
    const data = await cachedFetch(`${NOMINATIM_URL}/search?format=json&limit=6&q=${encodeURIComponent(q)}`);
    res.json(data.map((d) => ({ name: d.display_name, lat: Number(d.lat), lng: Number(d.lon) })));
  } catch (e) {
    res.status(502).json({ error: 'Ortssuche nicht erreichbar: ' + e.message });
  }
});

// ---------- WebSocket: Live-Karte ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map(); // code -> Map(userId -> {ws, state})

function roomMembers(code) {
  const room = rooms.get(code);
  if (!room) return [];
  return [...room.values()].map((m) => m.state);
}
function broadcast(code, msg, exceptUserId) {
  const room = rooms.get(code);
  if (!room) return;
  const data = JSON.stringify(msg);
  for (const [uid, m] of room) if (uid !== exceptUserId && m.ws.readyState === 1) m.ws.send(data);
}

wss.on('connection', (ws) => {
  let code = null;
  let userId = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'join') {
      const ride = db.rides[String(msg.code || '').toUpperCase()];
      const u = db.users[msg.userId];
      if (!ride || !u) return ws.send(JSON.stringify({ type: 'error', error: 'Fahrt oder Nutzer unbekannt' }));
      leave();
      code = ride.code;
      userId = u.id;
      if (!rooms.has(code)) rooms.set(code, new Map());
      const old = rooms.get(code).get(userId);
      if (old && old.ws !== ws) old.ws.close();
      const state = { userId, name: u.name, color: u.color, vehicle: u.vehicle, lat: null, lng: null, speed: 0, heading: null, lean: 0, g: 0, updatedAt: Date.now() };
      rooms.get(code).set(userId, { ws, state });
      ws.send(JSON.stringify({ type: 'joined', ride: { ...ride, hostName: db.users[ride.hostId]?.name }, members: roomMembers(code) }));
      broadcast(code, { type: 'member', member: state }, userId);
    } else if (msg.type === 'pos' && code) {
      const m = rooms.get(code)?.get(userId);
      if (!m) return;
      const lat = num(msg.lat, -90, 90);
      const lng = num(msg.lng, -180, 180);
      if (lat === null || lng === null) return;
      Object.assign(m.state, {
        lat, lng,
        speed: num(msg.speed, 0, 500) || 0,
        heading: num(msg.heading, 0, 360),
        lean: num(msg.lean, -90, 90) || 0,
        g: num(msg.g, 0, 10) || 0,
        recording: !!msg.recording,
        vehicle: VEHICLES.includes(msg.vehicle) ? msg.vehicle : m.state.vehicle,
        updatedAt: Date.now(),
      });
      broadcast(code, { type: 'member', member: m.state }, userId);
    } else if (msg.type === 'leave') {
      leave();
    }
  });

  function leave() {
    if (!code) return;
    const room = rooms.get(code);
    if (room && room.get(userId)?.ws === ws) {
      room.delete(userId);
      broadcast(code, { type: 'left', userId });
      if (!room.size) rooms.delete(code);
    }
    code = null;
  }
  ws.on('close', leave);
});

const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
pingInterval.unref();
wss.on('close', () => clearInterval(pingInterval));

if (require.main === module) {
  server.listen(PORT, () => console.log(`KurvenCrew läuft auf http://localhost:${PORT}`));
}
module.exports = { server, db };
