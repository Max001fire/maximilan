const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
process.env.DATA_FILE = path.join(os.tmpdir(), `kc-test-${process.pid}.json`);
const WebSocket = require('ws');
const { server } = require('../server');

let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
test.after(() => { server.closeAllConnections(); server.close(); });

const post = (p, body, method = 'POST') => fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (p) => fetch(base + p).then((r) => r.json());

test('Nutzer, Freunde, Spots, Gruppenfahrt, Live-Position, Bestenliste', async () => {
  const anna = await post('/api/users', { name: 'Anna', vehicle: 'motorcycle' });
  const ben = await post('/api/users', { name: 'Ben', vehicle: 'car' });
  assert.ok(anna.code && ben.code);

  const f = await post(`/api/users/${anna.id}/friends`, { code: ben.code.toLowerCase() });
  assert.equal(f.name, 'Ben');
  assert.equal((await get(`/api/users/${ben.id}/friends`))[0].name, 'Anna');

  const spot = await post('/api/spots', { userId: anna.id, name: 'Kesselberg', start: { lat: 47.6, lng: 11.35 }, end: { lat: 47.62, lng: 11.36 }, difficulty: 4 });
  assert.equal(spot.difficulty, 4);
  assert.equal((await get('/api/spots')).length, 1);

  const ride = await post('/api/rides', { userId: anna.id, name: 'Sonntagstour' });
  assert.equal(ride.code.length, 5);

  // Zwei WebSocket-Clients: Ben sieht Annas Position
  const wsUrl = base.replace('http', 'ws') + '/ws';
  const open = (u) => new Promise((r) => { const w = new WebSocket(wsUrl); w.on('open', () => { w.send(JSON.stringify({ type: 'join', code: ride.code, userId: u.id })); r(w); }); });
  const wa = await open(anna);
  const wb = await open(ben);
  await new Promise((r) => setTimeout(r, 100));
  const got = new Promise((r) => wb.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'member' && m.member.lat) r(m.member); }));
  wa.send(JSON.stringify({ type: 'pos', lat: 47.61, lng: 11.35, speed: 80, lean: -38, recording: true }));
  const m = await got;
  assert.equal(m.name, 'Anna');
  assert.equal(m.lean, -38);
  wa.close(); wb.close();

  await post('/api/sessions', { userId: anna.id, rideCode: ride.code, vehicle: 'motorcycle', distance: 42000, maxSpeed: 140, avgSpeed: 62, maxLeanLeft: 41, maxLeanRight: 44 });
  await post('/api/sessions', { userId: ben.id, rideCode: ride.code, vehicle: 'car', distance: 42000, maxSpeed: 150, avgSpeed: 66, maxLatG: 0.9, maxTotalG: 1.0 });

  const lbMoto = await get(`/api/leaderboard?vehicle=motorcycle&userId=${ben.id}`);
  assert.equal(lbMoto[0].maxLean, 44);
  const lbCar = await get(`/api/leaderboard?vehicle=car&userId=${anna.id}`);
  assert.equal(lbCar[0].maxTotalG, 1.0);
  assert.equal((await get(`/api/rides/${ride.code}/results`)).length, 2);
});
