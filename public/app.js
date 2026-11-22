import { Telemetry, haversine, bearing } from './telemetry.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const VEH = { motorcycle: { icon: '🏍️', label: 'Motorrad' }, car: { icon: '🚗', label: 'Auto' } };
const fmt = (n, d = 0) => Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtTime = (sec) => {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Fehler ${r.status}`);
  return data;
}

// ---------- Zustand ----------
const state = {
  user: null,
  vehicle: 'motorcycle',
  ride: null, // { code, name, hostId, route }
  members: new Map(),
  spots: [],
  route: null, // { coordinates, distance, duration, spotIds }
  routeStart: null,
  routeDest: null,
  selectedSpots: new Set(),
  pick: null, // 'start' | 'dest' | 'spotStart' | 'spotEnd'
  newSpot: null,
  recording: false,
  follow: true,
  cmp: { vehicle: 'motorcycle', scope: 'friends', metric: null },
};
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('kc_' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('kc_' + k, JSON.stringify(v)); } catch {} },
};

// ---------- Karte ----------
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([47.6, 11.3], 9);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 19, subdomains: 'abcd',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
}).addTo(map);
const layers = {
  spots: L.layerGroup().addTo(map),
  route: L.layerGroup().addTo(map),
  riders: L.layerGroup().addTo(map),
  track: L.polyline([], { color: '#2ec4b6', weight: 4, opacity: 0.8 }).addTo(map),
  marks: L.layerGroup().addTo(map),
};
let meMarker = null;

function riderIcon(m, isMe) {
  const v = VEH[m.vehicle] || VEH.motorcycle;
  const speed = m.speed ? ` · ${Math.round(m.speed)} km/h` : '';
  return L.divIcon({
    className: '',
    iconSize: [80, 56], iconAnchor: [40, 18],
    html: `<div class="rider-marker"><div class="pin" style="background:${esc(m.color || '#ff5a36')}">${v.icon}</div>
      <div class="label">${isMe ? 'Ich' : esc(m.name)}${speed}</div></div>`,
  });
}

function updateMe() {
  const p = tele.live.pos;
  if (!p || !state.user) return;
  const m = { ...state.user, vehicle: state.vehicle, speed: tele.live.speed };
  if (!meMarker) meMarker = L.marker(p, { icon: riderIcon(m, true), zIndexOffset: 1000 }).addTo(map);
  else meMarker.setLatLng(p).setIcon(riderIcon(m, true));
  if (state.follow && (state.recording || !updateMe.centered)) {
    map.setView(p, Math.max(map.getZoom(), state.recording ? 15 : 12), { animate: true });
    updateMe.centered = true;
  }
}

function renderMembers() {
  layers.riders.clearLayers();
  const list = $('#memberList');
  list.innerHTML = '';
  for (let m of state.members.values()) {
    const isMe = m.userId === state.user?.id;
    if (isMe && tele.live.pos) m = { ...m, ...tele.live.pos, speed: tele.live.speed, vehicle: state.vehicle, recording: state.recording, updatedAt: Date.now() };
    if (!isMe && m.lat != null) {
      L.marker([m.lat, m.lng], { icon: riderIcon(m, false) })
        .bindPopup(`<b>${esc(m.name)}</b><br>${VEH[m.vehicle]?.label}<br>${Math.round(m.speed)} km/h` +
          (m.vehicle === 'motorcycle' ? `<br>Schräglage ${Math.abs(Math.round(m.lean))}°` : `<br>${fmt(m.g, 2)} g`))
        .addTo(layers.riders);
    }
    const ago = Math.round((Date.now() - m.updatedAt) / 1000);
    const dist = !isMe && m.lat != null && tele.live.pos ? ` · ${fmt(haversine(tele.live.pos, m) / 1000, 1)} km entfernt` : '';
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:${esc(m.color)}"></span>
      <div class="grow"><b>${esc(m.name)}${isMe ? ' (du)' : ''}</b>
      <small>${VEH[m.vehicle]?.icon} ${m.lat == null ? 'noch kein GPS' : `${Math.round(m.speed)} km/h${dist}${ago > 30 ? ` · vor ${ago}s` : ''}`}${m.recording ? ' · 🔴 zeichnet auf' : ''}</small></div>`;
    if (!isMe && m.lat != null) {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = 'Zeigen';
      b.onclick = () => { state.follow = false; map.setView([m.lat, m.lng], 15); };
      li.append(b);
    }
    list.append(li);
  }
}

// ---------- Telemetrie ----------
const tele = new Telemetry(({ live, stats, error }) => {
  if (error) { $('#sensorHint').textContent = error; return; }
  updateMe();
  updateHud(live, stats);
  sendPos();
  if (state.recording && tele.track.length) {
    const last = tele.track[tele.track.length - 1];
    const ll = layers.track.getLatLngs();
    const prev = ll[ll.length - 1];
    if (!prev || prev.lat !== last[0] || prev.lng !== last[1]) layers.track.addLatLng([last[0], last[1]]);
  }
});

function gaugeSvg(live) {
  if (state.vehicle === 'motorcycle') {
    const lean = Math.max(-65, Math.min(65, live.lean || 0));
    const a = (lean * Math.PI) / 180;
    const cx = 75, cy = 78, r = 62;
    const x = cx + Math.sin(a) * r, y = cy - Math.cos(a) * r;
    const arc = (deg) => [cx + Math.sin((deg * Math.PI) / 180) * r, cy - Math.cos((deg * Math.PI) / 180) * r];
    const [lx, ly] = arc(-65), [rx, ry] = arc(65);
    const ticks = [-60, -45, -30, -15, 0, 15, 30, 45, 60].map((d) => {
      const [x1, y1] = arc(d);
      const x2 = cx + Math.sin((d * Math.PI) / 180) * (r - 8), y2 = cy - Math.cos((d * Math.PI) / 180) * (r - 8);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#4a5563" stroke-width="2"/>`;
    }).join('');
    const col = Math.abs(lean) > 45 ? '#e5484d' : Math.abs(lean) > 30 ? '#ffbf00' : '#2ec4b6';
    return `<svg viewBox="0 0 150 84"><path d="M${lx} ${ly} A${r} ${r} 0 0 1 ${rx} ${ry}" fill="none" stroke="#2f3843" stroke-width="6" stroke-linecap="round"/>
      ${ticks}<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${col}" stroke-width="5" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="5" fill="${col}"/>
      <text x="${cx}" y="${cy - 22}" text-anchor="middle" fill="#eef2f6" font-size="20" font-weight="800">${Math.abs(Math.round(lean))}°</text>
      <text x="10" y="82" fill="#94a0ad" font-size="10">L</text><text x="134" y="82" fill="#94a0ad" font-size="10">R</text></svg>`;
  }
  // G-Kreis fürs Auto: x = quer, y = längs (Bremsen unten)
  const s = 36 / 1.2;
  const gx = Math.max(-1.2, Math.min(1.2, live.latG || 0)), gy = Math.max(-1.2, Math.min(1.2, live.lonG || 0));
  return `<svg viewBox="0 0 150 84"><g transform="translate(42 42)">
    <circle r="36" fill="none" stroke="#2f3843" stroke-width="2"/><circle r="${s * 0.5}" fill="none" stroke="#2f3843"/><circle r="${s}" fill="none" stroke="#2f3843" stroke-dasharray="2 3"/>
    <line x1="-38" x2="38" stroke="#2f3843"/><line y1="-38" y2="38" stroke="#2f3843"/>
    <circle cx="${gx * s}" cy="${-gy * s}" r="6" fill="#ff5a36"/></g>
    <text x="90" y="38" fill="#eef2f6" font-size="22" font-weight="800">${fmt(live.totalG, 2)}</text>
    <text x="90" y="54" fill="#94a0ad" font-size="11">g gesamt</text>
    <text x="90" y="72" fill="#94a0ad" font-size="10">quer ${fmt(Math.abs(gx), 2)}</text></svg>`;
}

function updateHud(live, stats) {
  if (!state.recording) return;
  $('#hudSpeed').textContent = Math.round(live.speed);
  $('#hudMax').textContent = Math.round(stats.maxSpeed);
  $('#hudAvg').textContent = Math.round(stats.avgSpeed);
  $('#hudDist').textContent = fmt(stats.distance / 1000, 1);
  $('#hudTime').textContent = fmtTime(stats.startedAt ? (Date.now() - stats.startedAt) / 1000 : 0);
  $('#hudGauge').innerHTML = gaugeSvg(live);
  $('#hudPeaks').textContent = state.vehicle === 'motorcycle'
    ? `Max. Schräglage ◀ ${Math.round(stats.maxLeanLeft)}°  |  ${Math.round(stats.maxLeanRight)}° ▶`
    : `Max: quer ${fmt(stats.maxLatG, 2)} g · Bremsen ${fmt(stats.maxBrakeG, 2)} g · Beschl. ${fmt(stats.maxAccelG, 2)} g`;
}

async function toggleRecording() {
  if (!state.recording) {
    await tele.requestPermissions();
    tele.startSensors();
    tele.startRecording(state.vehicle);
    state.recording = true;
    state.follow = true;
    layers.track.setLatLngs([]);
    $('#hud').classList.remove('hidden');
    $('#recordBtn').textContent = '■ Fahrt beenden';
    $('#recordBtn').classList.add('recording');
    $('#hudGauge').innerHTML = gaugeSvg(tele.live);
    $('#sensorHint').textContent = tele.demo ? 'Demo-Modus aktiv – simulierte Fahrt entlang der Route.' : 'Handy kurz still halten – Sensoren werden kalibriert …';
    setTimeout(() => {
      if (!state.recording || tele.demo) return;
      $('#sensorHint').textContent = tele.hasMotion
        ? '✅ Bewegungssensoren aktiv.'
        : '⚠️ Keine Bewegungssensoren – Schräglage/G-Kräfte werden grob aus dem GPS-Kurs geschätzt.';
    }, 3000);
    hudTimer = setInterval(() => updateHud(tele.live, tele.stats), 1000);
    sendPos(true);
  } else {
    const { stats, track } = tele.stopRecording();
    state.recording = false;
    clearInterval(hudTimer);
    $('#hud').classList.add('hidden');
    $('#recordBtn').textContent = '▶ Fahrt starten';
    $('#recordBtn').classList.remove('recording');
    $('#sensorHint').textContent = '';
    sendPos(true);
    if (stats.distance < 50 && !confirm('Die Fahrt war sehr kurz. Trotzdem speichern?')) return;
    try {
      await api('/sessions', { body: { userId: state.user.id, rideCode: state.ride?.code, vehicle: state.vehicle, ...stats, track } });
    } catch (e) { toast('Speichern fehlgeschlagen: ' + e.message); }
    showSummary(stats);
  }
}
let hudTimer = null;

async function showSummary(stats) {
  const moto = state.vehicle === 'motorcycle';
  const cells = [
    ['Distanz', `${fmt(stats.distance / 1000, 1)} km`],
    ['Fahrzeit', fmtTime(stats.duration)],
    ['Höchstgeschw.', `${Math.round(stats.maxSpeed)} km/h`],
    ['Ø Geschw.', `${Math.round(stats.avgSpeed)} km/h`],
    ...(moto
      ? [['Schräglage links', `${Math.round(stats.maxLeanLeft)}°`], ['Schräglage rechts', `${Math.round(stats.maxLeanRight)}°`]]
      : [['Max. Quer-G', `${fmt(stats.maxLatG, 2)} g`], ['Max. Brems-G', `${fmt(stats.maxBrakeG, 2)} g`], ['Max. Beschl.-G', `${fmt(stats.maxAccelG, 2)} g`], ['Max. Gesamt-G', `${fmt(stats.maxTotalG, 2)} g`]]),
  ];
  let html = `<div class="stat-grid">${cells.map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('')}</div>`;
  if (state.ride) {
    try {
      const results = (await api(`/rides/${state.ride.code}/results`)).filter((r) => r.vehicle === state.vehicle);
      if (results.length > 1) html += `<h3>Gruppe: ${esc(state.ride.name)}</h3>` + resultsTable(results);
    } catch {}
  }
  $('#summaryBody').innerHTML = html;
  $('#summary').classList.remove('hidden');
}

function resultsTable(rows) {
  const moto = rows[0]?.vehicle === 'motorcycle';
  rows.sort((a, b) => b.maxSpeed - a.maxSpeed);
  return `<table class="board"><tr><th>Fahrer</th><th class="num">Max</th><th class="num">Ø</th><th class="num">${moto ? 'Schräg' : 'G'}</th></tr>
    ${rows.map((r) => `<tr class="${r.userId === state.user.id ? 'me' : ''}"><td>${esc(r.userName)}</td><td class="num">${Math.round(r.maxSpeed)}</td><td class="num">${Math.round(r.avgSpeed)}</td>
    <td class="num">${moto ? Math.round(Math.max(r.maxLeanLeft, r.maxLeanRight)) + '°' : fmt(r.maxTotalG, 2)}</td></tr>`).join('')}</table>`;
}

// ---------- Live-Gruppe (WebSocket) ----------
let ws = null;
let wsRetry = 0;
function connectRide(code) {
  if (ws) { ws.onclose = null; ws.close(); }
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { wsRetry = 0; ws.send(JSON.stringify({ type: 'join', code, userId: state.user.id })); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'joined') {
      state.ride = msg.ride;
      state.members = new Map(msg.members.map((m) => [m.userId, m]));
      store.set('ride', msg.ride.code);
      renderRide();
      if (msg.ride.route && msg.ride.hostId !== state.user.id) applyRoute(msg.ride.route, true);
      sendPos(true);
    } else if (msg.type === 'member') {
      const isNew = !state.members.has(msg.member.userId);
      state.members.set(msg.member.userId, msg.member);
      if (isNew) toast(`${msg.member.name} ist dabei 👋`);
      renderMembers();
    } else if (msg.type === 'left') {
      const m = state.members.get(msg.userId);
      state.members.delete(msg.userId);
      if (m) toast(`${m.name} hat die Gruppe verlassen`);
      renderMembers();
    } else if (msg.type === 'route') {
      applyRoute(msg.route, true);
      toast('Neue Route vom Gastgeber erhalten 🗺️');
    } else if (msg.type === 'error') {
      toast(msg.error);
      leaveRide();
    }
  };
  ws.onclose = () => {
    if (!state.ride) return;
    setTimeout(() => state.ride && connectRide(state.ride.code), Math.min(10000, 1000 * 2 ** wsRetry++));
  };
}

let lastSent = 0;
function sendPos(force) {
  if (!ws || ws.readyState !== 1 || !tele.live.pos) return;
  const now = Date.now();
  if (!force && now - lastSent < 2000) return;
  lastSent = now;
  renderMembers();
  const l = tele.live;
  ws.send(JSON.stringify({ type: 'pos', lat: l.pos.lat, lng: l.pos.lng, speed: l.speed, heading: l.heading, lean: l.lean, g: l.totalG, vehicle: state.vehicle, recording: state.recording }));
}

function renderRide() {
  const r = state.ride;
  $('#rideNone').classList.toggle('hidden', !!r);
  $('#rideActive').classList.toggle('hidden', !r);
  $('#rideChip').classList.toggle('hidden', !r);
  if (!r) { layers.riders.clearLayers(); return; }
  $('#rideName').textContent = r.name;
  $('#rideCode').textContent = r.code;
  $('#rideChip').textContent = `👥 ${r.code}`;
  $('#pushRouteBtn').classList.toggle('hidden', r.hostId !== state.user.id);
  renderMembers();
}

async function createRide() {
  const name = prompt('Name der Tour:', `${state.user.name}s Kurventour`);
  if (name === null) return;
  try {
    const ride = await api('/rides', { body: { userId: state.user.id, name, route: state.route } });
    connectRide(ride.code);
    setTimeout(shareInvite, 400);
  } catch (e) { toast(e.message); }
}

async function joinRide(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return;
  try {
    await api(`/rides/${code}`);
    connectRide(code);
  } catch (e) { toast(e.message); }
}

function leaveRide() {
  if (ws) { ws.onclose = null; try { ws.send(JSON.stringify({ type: 'leave' })); } catch {} ws.close(); }
  ws = null;
  state.ride = null;
  state.members.clear();
  store.set('ride', null);
  renderRide();
}

async function shareInvite() {
  if (!state.ride) return;
  const url = `${location.origin}${location.pathname}?join=${state.ride.code}`;
  const text = `Fahr mit mir: „${state.ride.name}“ – Code ${state.ride.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'KurvenCrew', text, url });
    else { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Einladungslink kopiert 📋'); }
  } catch {}
}

// ---------- Kurvenspots ----------
async function loadSpots() {
  try { state.spots = await api('/spots'); } catch (e) { toast(e.message); }
  renderSpots();
}

function spotPopup(s) {
  const liked = s.likes.includes(state.user?.id);
  return `<b>🌀 ${esc(s.name)}</b><br><small>${'●'.repeat(s.difficulty)}${'○'.repeat(5 - s.difficulty)} · von ${esc(s.creatorName)}</small>
    ${s.description ? `<p style="margin:6px 0">${esc(s.description)}</p>` : '<br>'}
    <small>${s.vehicles.map((v) => VEH[v].icon).join(' ')} · ❤️ ${s.likes.length}</small><br>
    <button class="btn small" data-spot-route="${s.id}" style="margin-top:6px">${state.selectedSpots.has(s.id) ? '✓ In Route' : '+ In Route'}</button>
    <button class="btn small" data-spot-like="${s.id}" style="margin-top:6px">${liked ? '💔' : '❤️'}</button>`;
}

function renderSpots() {
  layers.spots.clearLayers();
  const icon = (e) => L.divIcon({ className: 'spot-marker', html: e, iconSize: [24, 24], iconAnchor: [12, 12] });
  for (const s of state.spots) {
    const g = L.layerGroup().addTo(layers.spots);
    const sel = state.selectedSpots.has(s.id);
    if (s.end) {
      L.polyline([s.start, s.end], { color: sel ? '#ffbf00' : '#ff5a36', weight: 3, dashArray: '6 6' }).addTo(g);
      L.marker(s.end, { icon: icon('🏁') }).bindPopup(() => spotPopup(s)).addTo(g);
    }
    L.marker(s.start, { icon: icon(sel ? '⭐' : '🌀') }).bindPopup(() => spotPopup(s)).addTo(g);
  }
  const here = tele.live.pos || map.getCenter();
  const sorted = [...state.spots].sort((a, b) => haversine(here, a.start) - haversine(here, b.start));
  const visible = sorted.filter((s) => s.vehicles.includes(state.vehicle));
  $('#spotList').innerHTML = visible.length ? '' : '<li><span class="grow">Noch keine Spots für dein Fahrzeug. Trag den ersten ein! 🌀</span></li>';
  $('#routeSpotList').innerHTML = '';
  for (const s of visible) {
    const km = fmt(haversine(here, s.start) / 1000, 1);
    const li = document.createElement('li');
    li.innerHTML = `<div class="grow"><b>${esc(s.name)}</b><small>${km} km · ${'●'.repeat(s.difficulty)}${'○'.repeat(5 - s.difficulty)} · ❤️ ${s.likes.length} · ${esc(s.creatorName)}</small></div>`;
    const show = document.createElement('button');
    show.className = 'btn small';
    show.textContent = 'Karte';
    show.onclick = () => { state.follow = false; map.setView(s.start, 14); };
    li.append(show);
    if (s.creatorId === state.user?.id) {
      const del = document.createElement('button');
      del.className = 'btn small danger';
      del.textContent = '🗑';
      del.onclick = async () => {
        if (!confirm(`„${s.name}“ löschen?`)) return;
        try { await api(`/spots/${s.id}?userId=${state.user.id}`, { method: 'DELETE' }); state.selectedSpots.delete(s.id); loadSpots(); } catch (e) { toast(e.message); }
      };
      li.append(del);
    }
    $('#spotList').append(li);

    const li2 = document.createElement('li');
    li2.innerHTML = `<label class="check grow" style="margin:0"><input type="checkbox" ${state.selectedSpots.has(s.id) ? 'checked' : ''} />
      <span><b>${esc(s.name)}</b><small>${km} km entfernt</small></span></label>`;
    li2.querySelector('input').onchange = (e) => { e.target.checked ? state.selectedSpots.add(s.id) : state.selectedSpots.delete(s.id); renderSpots(); };
    $('#routeSpotList').append(li2);
  }
}

map.on('popupopen', (e) => {
  const el = e.popup.getElement();
  el.querySelector('[data-spot-route]')?.addEventListener('click', (ev) => {
    const sid = ev.target.dataset.spotRoute;
    state.selectedSpots.has(sid) ? state.selectedSpots.delete(sid) : state.selectedSpots.add(sid);
    map.closePopup();
    renderSpots();
    toast(state.selectedSpots.has(sid) ? 'Spot zur Route hinzugefügt – im Tab „Route“ berechnen' : 'Spot aus Route entfernt');
  });
  el.querySelector('[data-spot-like]')?.addEventListener('click', async (ev) => {
    try { await api(`/spots/${ev.target.dataset.spotLike}/like`, { body: { userId: state.user.id } }); map.closePopup(); loadSpots(); } catch (err) { toast(err.message); }
  });
});

function startAddSpot() {
  state.newSpot = { start: null, end: null };
  state.pick = 'spotStart';
  $('#spotForm').classList.remove('hidden');
  $('#addSpotBtn').classList.add('hidden');
  $('#spotHint').innerHTML = 'Tippe auf der Karte auf den <b>Anfang</b> der Kurvenstrecke.';
  setSheetMin(true);
}
function endAddSpot() {
  state.newSpot = null;
  state.pick = null;
  layers.marks.clearLayers();
  $('#spotForm').classList.add('hidden');
  $('#spotForm').reset();
  $('#diffVal').textContent = '3';
  $('#addSpotBtn').classList.remove('hidden');
  drawRouteMarks();
}

// ---------- Routenplanung ----------
function drawRouteMarks() {
  layers.marks.clearLayers();
  const pin = (e) => L.divIcon({ className: 'spot-marker', html: e, iconSize: [24, 24], iconAnchor: [12, 22] });
  if (state.routeStart) L.marker(state.routeStart, { icon: pin('🟢') }).addTo(layers.marks);
  if (state.routeDest) L.marker(state.routeDest, { icon: pin('🏁') }).addTo(layers.marks);
  if (state.newSpot?.start) L.marker(state.newSpot.start, { icon: pin('🌀') }).addTo(layers.marks);
  if (state.newSpot?.end) {
    L.marker(state.newSpot.end, { icon: pin('🏁') }).addTo(layers.marks);
    L.polyline([state.newSpot.start, state.newSpot.end], { color: '#ffbf00', dashArray: '6 6' }).addTo(layers.marks);
  }
}

// Spots, die nah an der Luftlinie Start→Ziel liegen, in Fahrtreihenfolge
function autoPickSpots() {
  const a = state.routeStart || tele.live.pos;
  const b = state.routeDest;
  if (!a) return toast('Start unbekannt – GPS aktivieren oder Start wählen');
  const maxKm = Number($('#detour').value);
  const round = $('#roundTrip').checked || !b;
  const cands = state.spots.filter((s) => s.vehicles.includes(state.vehicle));
  let picked = 0;
  for (const s of cands) {
    const d = round || !b ? haversine(a, s.start) / 1000 / 2.5 : distToSegment(s.start, a, b) / 1000;
    if (d <= maxKm) { state.selectedSpots.add(s.id); picked++; }
  }
  renderSpots();
  toast(picked ? `${picked} Kurvenspot(s) ausgewählt` : 'Keine Spots im Umkreis gefunden');
}

// Abstand Punkt–Strecke (lokale ebene Näherung, Meter)
function distToSegment(p, a, b) {
  const k = Math.cos((a.lat * Math.PI) / 180) * 111320;
  const ax = a.lng * k, ay = a.lat * 110540, bx = b.lng * k, by = b.lat * 110540, px = p.lng * k, py = p.lat * 110540;
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function orderSpots(start, dest, spots) {
  // Greedy: immer der nächste Spot, Ende des Spots ist neuer Ausgangspunkt
  const left = [...spots];
  const out = [];
  let cur = start;
  while (left.length) {
    let bi = 0, bd = Infinity, flip = false;
    left.forEach((s, i) => {
      const d1 = haversine(cur, s.start);
      const d2 = s.end ? haversine(cur, s.end) : Infinity;
      // Ziel berücksichtigen: Spots näher am Start zuerst
      const bias = dest ? haversine(s.start, dest) * 0.3 : 0;
      if (Math.min(d1, d2) + bias < bd) { bd = Math.min(d1, d2) + bias; bi = i; flip = d2 < d1; }
    });
    const s = left.splice(bi, 1)[0];
    const pts = s.end ? (flip ? [s.end, s.start] : [s.start, s.end]) : [s.start];
    out.push(...pts);
    if (s.end && $('#spotsBothWays').checked) out.push(pts[0]); // hoch & runter
    cur = out[out.length - 1];
  }
  return out;
}

async function calcRoute() {
  const start = state.routeStart || tele.live.pos;
  if (!start) return toast('Start unbekannt – GPS aktivieren oder Start auf der Karte wählen');
  const spots = state.spots.filter((s) => state.selectedSpots.has(s.id));
  const round = $('#roundTrip').checked;
  const dest = state.routeDest || (round ? start : null);
  if (!dest && !spots.length) return toast('Ziel wählen oder Kurvenspots auswählen');
  const points = [start, ...orderSpots(start, state.routeDest, spots)];
  if (dest) points.push(dest);
  $('#calcRouteBtn').disabled = true;
  $('#calcRouteBtn').textContent = 'Berechne …';
  try {
    const r = await api('/route', { body: { points } });
    r.spotIds = spots.map((s) => s.id);
    applyRoute(r);
    store.set('route', r);
    if (state.ride && state.ride.hostId === state.user.id) pushRoute();
  } catch (e) { toast(e.message); }
  $('#calcRouteBtn').disabled = false;
  $('#calcRouteBtn').textContent = 'Route berechnen';
}

// Kurvigkeit: Summe der Richtungswechsel pro km (auf ~25 m geglättet)
function curviness(coords) {
  let total = 0, sum = 0, last = null, prevB = null;
  for (const [lat, lng] of coords) {
    const p = { lat, lng };
    if (!last) { last = p; continue; }
    const d = haversine(last, p);
    if (d < 25) continue;
    const b = bearing(last, p);
    if (prevB !== null) { let dh = Math.abs(b - prevB); if (dh > 180) dh = 360 - dh; if (dh < 120) sum += dh; }
    prevB = b; total += d; last = p;
  }
  return total > 0 ? sum / (total / 1000) : 0;
}

function applyRoute(r, fromGroup) {
  state.route = r;
  layers.route.clearLayers();
  if (!r?.coordinates?.length) { $('#routeInfo').classList.add('hidden'); return; }
  L.polyline(r.coordinates, { color: '#000', weight: 9, opacity: 0.5 }).addTo(layers.route);
  const line = L.polyline(r.coordinates, { color: fromGroup ? '#9b5de5' : '#ff5a36', weight: 5 }).addTo(layers.route);
  if (!state.recording) map.fitBounds(line.getBounds(), { padding: [30, 30] });
  const c = curviness(r.coordinates);
  const label = c > 90 ? '🔥 Kurvenparadies' : c > 55 ? '😎 Schön kurvig' : c > 30 ? '🙂 Etwas kurvig' : '😴 Eher gerade';
  $('#routeInfo').innerHTML = `<div><b>${fmt(r.distance / 1000, 1)}</b><small>km</small></div>
    <div><b>${fmtTime(r.duration).replace(/:\d\d$/, '')}</b><small>${r.duration >= 3600 ? 'Std' : 'Min'}</small></div>
    <div><b>${Math.round(c)}</b><small>Kurven-Score</small></div>
    <div class="full"><small>${label} · ${r.spotIds?.length || 0} Kurvenspot(s)${fromGroup ? ' · Gruppenroute' : ''}</small></div>`;
  $('#routeInfo').classList.remove('hidden');
}

async function pushRoute() {
  if (!state.ride || !state.route) return toast('Erst eine Route berechnen');
  try { await api(`/rides/${state.ride.code}/route`, { method: 'PUT', body: { userId: state.user.id, route: state.route } }); toast('Route an Gruppe gesendet ✅'); }
  catch (e) { toast(e.message); }
}

let geoTimer = null;
function geoSearch(input, target) {
  clearTimeout(geoTimer);
  const q = input.value.trim();
  if (q.length < 3) { $('#geoResults').innerHTML = ''; return; }
  geoTimer = setTimeout(async () => {
    try {
      const res = await api('/geocode?q=' + encodeURIComponent(q));
      $('#geoResults').innerHTML = '';
      for (const r of res) {
        const li = document.createElement('li');
        li.textContent = r.name;
        li.onclick = () => {
          state[target] = { lat: r.lat, lng: r.lng };
          input.value = r.name.split(',').slice(0, 2).join(',');
          $('#geoResults').innerHTML = '';
          drawRouteMarks();
          map.setView(r, 11);
        };
        $('#geoResults').append(li);
      }
    } catch (e) { toast(e.message); }
  }, 500);
}

// ---------- Karteninteraktion ----------
map.on('click', (e) => {
  const p = { lat: e.latlng.lat, lng: e.latlng.lng };
  const label = `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
  if (state.pick === 'start') { state.routeStart = p; $('#startInput').value = label; }
  else if (state.pick === 'dest') { state.routeDest = p; $('#destInput').value = label; }
  else if (state.pick === 'spotStart') {
    state.newSpot.start = p;
    state.pick = 'spotEnd';
    $('#spotHint').innerHTML = 'Jetzt auf das <b>Ende</b> der Strecke tippen (oder direkt speichern für einen einzelnen Punkt).';
    drawRouteMarks();
    return;
  } else if (state.pick === 'spotEnd') {
    state.newSpot.end = p;
    state.pick = null;
    $('#spotHint').innerHTML = '✅ Strecke markiert. Name eingeben und speichern.';
    setSheetMin(false);
    drawRouteMarks();
    return;
  } else return;
  state.pick = null;
  setSheetMin(false);
  drawRouteMarks();
});
map.on('dragstart', () => (state.follow = false));

// ---------- UI-Verdrahtung ----------
function setSheetMin(min) { document.body.classList.toggle('sheet-min', min); setTimeout(() => map.invalidateSize(), 300); }
$('#sheetHandle').onclick = () => setSheetMin(!document.body.classList.contains('sheet-min'));

$$('.tabs button').forEach((b) => (b.onclick = () => {
  $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === b.dataset.tab));
  setSheetMin(false);
  if (b.dataset.tab === 'compare') loadCompare();
  if (b.dataset.tab === 'profile') loadFriends();
  if (b.dataset.tab === 'spots' || b.dataset.tab === 'route') renderSpots();
}));

function setVehicle(v, persist = true) {
  if (state.recording) return toast('Während der Aufzeichnung nicht möglich');
  state.vehicle = v;
  state.cmp.vehicle = v;
  $('#vehicleChip').textContent = `${VEH[v].icon} ${VEH[v].label}`;
  $$('#profileVehicle button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  if (persist && state.user) api(`/users/${state.user.id}`, { method: 'PUT', body: { vehicle: v } }).then((u) => (state.user = u)).catch(() => {});
  sendPos(true);
  renderSpots();
  updateMe();
}
$('#vehicleChip').onclick = () => setVehicle(state.vehicle === 'car' ? 'motorcycle' : 'car');
$$('#profileVehicle button').forEach((b) => (b.onclick = () => setVehicle(b.dataset.v)));

$('#recordBtn').onclick = toggleRecording;
$('#createRideBtn').onclick = createRide;
$('#joinBtn').onclick = () => joinRide($('#joinCode').value);
$('#leaveBtn').onclick = leaveRide;
$('#shareBtn').onclick = shareInvite;
$('#rideChip').onclick = shareInvite;
$('#pushRouteBtn').onclick = pushRoute;
$('#locateBtn').onclick = async () => {
  state.follow = true;
  if (tele.live.pos) map.setView(tele.live.pos, Math.max(map.getZoom(), 14));
  else { await tele.requestPermissions(); tele.startSensors(); toast('Suche GPS …'); }
};
$('#summaryClose').onclick = () => $('#summary').classList.add('hidden');

$$('[data-pick]').forEach((b) => (b.onclick = () => {
  state.pick = b.dataset.pick;
  setSheetMin(true);
  toast(b.dataset.pick === 'start' ? 'Tippe auf der Karte auf den Start' : 'Tippe auf der Karte auf das Ziel');
}));
$('#destInput').oninput = (e) => geoSearch(e.target, 'routeDest');
$('#startInput').oninput = (e) => { if (!e.target.value) state.routeStart = null; geoSearch(e.target, 'routeStart'); };
$('#autoSpotsBtn').onclick = autoPickSpots;
$('#calcRouteBtn').onclick = calcRoute;
$('#clearRouteBtn').onclick = () => {
  state.routeStart = state.routeDest = null;
  state.selectedSpots.clear();
  $('#startInput').value = $('#destInput').value = '';
  applyRoute(null);
  store.set('route', null);
  drawRouteMarks();
  renderSpots();
};

$('#addSpotBtn').onclick = startAddSpot;
$('#cancelSpotBtn').onclick = endAddSpot;
$('#spotDiff').oninput = (e) => ($('#diffVal').textContent = e.target.value);
$('#spotForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!state.newSpot?.start) return toast('Bitte zuerst den Anfang auf der Karte antippen');
  const vehicles = [$('#spotMoto').checked && 'motorcycle', $('#spotCar').checked && 'car'].filter(Boolean);
  if (!vehicles.length) return toast('Mindestens ein Fahrzeug wählen');
  try {
    await api('/spots', { body: { userId: state.user.id, name: $('#spotName').value, description: $('#spotDesc').value, difficulty: +$('#spotDiff').value, start: state.newSpot.start, end: state.newSpot.end, vehicles } });
    toast('Kurvenspot gespeichert 🌀');
    endAddSpot();
    loadSpots();
  } catch (err) { toast(err.message); }
};

// ---------- Vergleich ----------
const METRICS = {
  motorcycle: [['maxLean', 'Max. Schräglage', (v) => `${Math.round(v)}°`], ['maxSpeed', 'Höchstgeschw.', (v) => `${Math.round(v)} km/h`], ['avgSpeed', 'Beste Ø-Geschw.', (v) => `${Math.round(v)} km/h`], ['distance', 'Gesamt-km', (v) => fmt(v / 1000, 0)]],
  car: [['maxTotalG', 'Max. G gesamt', (v) => `${fmt(v, 2)} g`], ['maxLatG', 'Max. Quer-G', (v) => `${fmt(v, 2)} g`], ['maxBrakeG', 'Max. Brems-G', (v) => `${fmt(v, 2)} g`], ['maxSpeed', 'Höchstgeschw.', (v) => `${Math.round(v)} km/h`], ['avgSpeed', 'Beste Ø-Geschw.', (v) => `${Math.round(v)} km/h`], ['distance', 'Gesamt-km', (v) => fmt(v / 1000, 0)]],
};

async function loadCompare() {
  const c = state.cmp;
  $$('#cmpVehicle button').forEach((b) => b.classList.toggle('on', b.dataset.v === c.vehicle));
  $$('#cmpScope button').forEach((b) => b.classList.toggle('on', b.dataset.s === c.scope));
  const metrics = METRICS[c.vehicle];
  if (!metrics.some((m) => m[0] === c.metric)) c.metric = metrics[0][0];
  $('#cmpMetric').innerHTML = metrics.map(([k, l]) => `<option value="${k}" ${k === c.metric ? 'selected' : ''}>${l}</option>`).join('');
  try {
    const rows = await api(`/leaderboard?vehicle=${c.vehicle}&scope=${c.scope}&userId=${state.user.id}`);
    const [key, , f] = metrics.find((m) => m[0] === c.metric);
    rows.sort((a, b) => b[key] - a[key]);
    const second = metrics.find((m) => m[0] !== key && m[0] !== 'distance');
    $('#board').innerHTML = rows.length
      ? `<tr><th class="rank">#</th><th>Fahrer</th><th class="num">${metrics.find((m) => m[0] === key)[1]}</th><th class="num">${second[1]}</th><th class="num">Fahrten</th></tr>` +
        rows.map((r, i) => `<tr class="${r.userId === state.user.id ? 'me' : ''}"><td class="rank">${['🥇', '🥈', '🥉'][i] || i + 1}</td>
          <td><span class="dot" style="display:inline-block;background:${esc(r.color)}"></span> ${esc(r.name)}</td>
          <td class="num">${f(r[key])}</td><td class="num">${second[2](r[second[0]])}</td><td class="num">${r.rides}</td></tr>`).join('')
      : `<tr><td class="hint">Noch keine ${VEH[c.vehicle].label}-Fahrten${c.scope === 'friends' ? ' von dir oder deinen Freunden' : ''}.</td></tr>`;
  } catch (e) { toast(e.message); }
  try {
    const hist = (await api(`/users/${state.user.id}/sessions`)).filter((s) => s.vehicle === c.vehicle);
    $('#historyList').innerHTML = hist.length ? '' : '<li class="hint">Noch keine Fahrten aufgezeichnet.</li>';
    for (const s of hist.slice(0, 30)) {
      const li = document.createElement('li');
      const extra = s.vehicle === 'motorcycle' ? `◀${Math.round(s.maxLeanLeft)}° ${Math.round(s.maxLeanRight)}°▶` : `${fmt(s.maxTotalG, 2)} g`;
      li.innerHTML = `<div class="grow"><b>${new Date(s.startedAt).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })} · ${fmt(s.distance / 1000, 1)} km</b>
        <small>Max ${Math.round(s.maxSpeed)} · Ø ${Math.round(s.avgSpeed)} km/h · ${extra}${s.rideCode ? ' · 👥 ' + s.rideCode : ''}</small></div>`;
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = 'Strecke';
      b.onclick = async () => {
        const full = await api(`/sessions/${s.id}`);
        if (!full.track.length) return toast('Keine GPS-Punkte gespeichert');
        layers.track.setLatLngs(full.track.map((p) => [p[0], p[1]]));
        state.follow = false;
        map.fitBounds(layers.track.getBounds(), { padding: [30, 30] });
        setSheetMin(true);
      };
      li.append(b);
      $('#historyList').append(li);
    }
  } catch {}
}
$$('#cmpVehicle button').forEach((b) => (b.onclick = () => { state.cmp.vehicle = b.dataset.v; loadCompare(); }));
$$('#cmpScope button').forEach((b) => (b.onclick = () => { state.cmp.scope = b.dataset.s; loadCompare(); }));
$('#cmpMetric').onchange = (e) => { state.cmp.metric = e.target.value; loadCompare(); };

// ---------- Profil & Freunde ----------
async function loadFriends() {
  $('#profileName').value = state.user.name;
  $('#myCode').textContent = state.user.code;
  try {
    const friends = await api(`/users/${state.user.id}/friends`);
    $('#friendList').innerHTML = friends.length ? '' : '<li class="hint">Noch keine Freunde. Tausche Codes mit deinen Kollegen aus!</li>';
    for (const f of friends) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="dot" style="background:${esc(f.color)}"></span><div class="grow"><b>${esc(f.name)}</b><small>${VEH[f.vehicle].icon} ${VEH[f.vehicle].label} · ${f.code}</small></div>`;
      const b = document.createElement('button');
      b.className = 'btn small danger';
      b.textContent = 'Entfernen';
      b.onclick = async () => { if (confirm(`${f.name} entfernen?`)) { await api(`/users/${state.user.id}/friends/${f.id}`, { method: 'DELETE' }); loadFriends(); } };
      li.append(b);
      $('#friendList').append(li);
    }
  } catch (e) { toast(e.message); }
}
$('#addFriendBtn').onclick = async () => {
  try {
    const f = await api(`/users/${state.user.id}/friends`, { body: { code: $('#friendCode').value.trim() } });
    toast(`${f.name} ist jetzt dein Freund 🤝`);
    $('#friendCode').value = '';
    loadFriends();
  } catch (e) { toast(e.message); }
};
$('#saveNameBtn').onclick = async () => {
  try { state.user = await api(`/users/${state.user.id}`, { method: 'PUT', body: { name: $('#profileName').value } }); toast('Gespeichert'); } catch (e) { toast(e.message); }
};
$('#calibrateBtn').onclick = () => { tele.calibrate(); toast('Handy 2 Sekunden still halten …'); };
$('#demoBtn').onclick = () => {
  if (tele.demo) {
    tele.stopDemo();
    tele.startSensors();
    $('#demoBtn').textContent = 'Demo-Fahrt (Simulation)';
    toast('Demo beendet');
    return;
  }
  let coords = state.route?.coordinates;
  if (!coords?.length) {
    // Kleine kurvige Teststrecke um den Kartenmittelpunkt
    const c = map.getCenter();
    coords = [];
    for (let i = 0; i <= 400; i++) {
      const t = (i / 400) * Math.PI * 2;
      const r = 0.012 + 0.004 * Math.sin(t * 7);
      coords.push([c.lat + r * Math.sin(t), c.lng + (r * Math.cos(t)) / Math.cos((c.lat * Math.PI) / 180)]);
    }
  }
  tele.startDemo(coords, state.vehicle);
  $('#demoBtn').textContent = 'Demo stoppen';
  toast('Demo läuft – starte jetzt die Fahrt im Tab „Fahrt“');
};

// ---------- Start ----------
async function onboarding() {
  return new Promise((resolve) => {
    let v = 'motorcycle';
    $('#onboarding').classList.remove('hidden');
    $$('.vehicle-pick button').forEach((b) => (b.onclick = () => {
      v = b.dataset.v;
      $$('.vehicle-pick button').forEach((x) => x.classList.toggle('on', x === b));
    }));
    $('#obGo').onclick = async () => {
      const name = $('#obName').value.trim();
      if (!name) return toast('Bitte gib deinen Namen ein');
      try {
        const u = await api('/users', { body: { name, vehicle: v } });
        store.set('userId', u.id);
        $('#onboarding').classList.add('hidden');
        resolve(u);
      } catch (e) { toast(e.message); }
    };
  });
}

async function init() {
  const uid = store.get('userId');
  if (uid) { try { state.user = await api(`/users/${uid}`); } catch {} }
  if (!state.user) state.user = await onboarding();
  setVehicle(state.user.vehicle, false);
  loadSpots();
  const savedRoute = store.get('route');
  if (savedRoute) applyRoute(savedRoute);

  // GPS sofort (ohne Aufzeichnung) für Karte & Live-Position
  if ('geolocation' in navigator) tele.startSensors();

  const join = new URLSearchParams(location.search).get('join') || store.get('ride');
  if (join) {
    history.replaceState(null, '', location.pathname);
    joinRide(join);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
