// Telemetrie: GPS-Geschwindigkeit, Schräglage (Motorrad) und G-Kräfte (Auto)
//
// Schräglage: Beim Motorrad zeigt der Beschleunigungssensor in einer Kurve
// immer "senkrecht" zum Motorrad (Schwerkraft + Fliehkraft heben sich in
// Querrichtung auf). Daher wird die Schräglage physikalisch berechnet:
//     sin(φ) = v · ω_gemessen / g
// v = GPS-Geschwindigkeit, ω_gemessen = Drehrate (Gyroskop) um die Hochachse
// des Fahrzeugs (bei Kalibrierung aus der Schwerkraftrichtung bestimmt).
// Das funktioniert unabhängig davon, wie das Handy in der Halterung sitzt.
//
// Auto: Quer-G = v · ω / g, Längs-G = dv/dt aus GPS bzw. Beschleunigungssensor.

const G = 9.81;
const DEG = Math.PI / 180;

export function haversine(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function bearing(a, b) {
  const y = Math.sin((b.lng - a.lng) * DEG) * Math.cos(b.lat * DEG);
  const x = Math.cos(a.lat * DEG) * Math.sin(b.lat * DEG) - Math.sin(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.cos((b.lng - a.lng) * DEG);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lowpass = (prev, next, dt, tau) => prev + (next - prev) * (1 - Math.exp(-dt / tau));

export class Telemetry {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.vehicle = 'motorcycle';
    this.recording = false;
    this.live = { speed: 0, lean: 0, latG: 0, lonG: 0, totalG: 0, pos: null, heading: null, accuracy: null };
    this.up = null; // Hochachse im Geräte-Koordinatensystem
    this.calib = [];
    this.watchId = null;
    this.demo = null;
    this.reset();
    this._onMotion = this._onMotion.bind(this);
  }

  reset() {
    this.stats = {
      startedAt: null, duration: 0, movingTime: 0, distance: 0,
      maxSpeed: 0, avgSpeed: 0,
      maxLeanLeft: 0, maxLeanRight: 0,
      maxLatG: 0, maxAccelG: 0, maxBrakeG: 0, maxTotalG: 0,
    };
    this.track = [];
    this.lastPos = null;
    this.speedHist = [];
  }

  get hasMotion() { return this._motionSeen; }

  // Muss durch eine Nutzer-Aktion (Klick) ausgelöst werden (iOS-Berechtigung)
  async requestPermissions() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        const r = await DeviceMotionEvent.requestPermission();
        if (r !== 'granted') throw new Error('Bewegungssensoren nicht erlaubt');
      }
    } catch (e) {
      console.warn(e);
    }
  }

  startSensors() {
    if (this.watchId === null && 'geolocation' in navigator && !this.demo) {
      this.watchId = navigator.geolocation.watchPosition(
        (p) => this._onGps({
          lat: p.coords.latitude, lng: p.coords.longitude,
          speed: p.coords.speed, heading: p.coords.heading,
          accuracy: p.coords.accuracy, t: p.timestamp,
        }),
        (err) => this.onUpdate?.({ error: 'GPS: ' + err.message }),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      );
    }
    window.addEventListener('devicemotion', this._onMotion);
  }

  stopSensors() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    window.removeEventListener('devicemotion', this._onMotion);
  }

  calibrate() {
    this.up = null;
    this.calib = [];
  }

  startRecording(vehicle) {
    this.vehicle = vehicle;
    this.reset();
    this.stats.startedAt = Date.now();
    this.recording = true;
    this.calibrate();
  }

  stopRecording() {
    this.recording = false;
    this._finalize();
    return { stats: { ...this.stats }, track: this.track };
  }

  _finalize() {
    const s = this.stats;
    s.duration = s.startedAt ? (Date.now() - s.startedAt) / 1000 : 0;
    s.avgSpeed = s.movingTime > 0 ? (s.distance / s.movingTime) * 3.6 : 0;
  }

  // ---------- GPS ----------
  _onGps(p) {
    const prev = this.lastPos;
    let speed = Number.isFinite(p.speed) && p.speed !== null ? p.speed : null;
    if (prev) {
      const dt = (p.t - prev.t) / 1000;
      const d = haversine(prev, p);
      if (speed === null && dt > 0) speed = d / dt;
      if (dt > 0 && dt < 10 && speed !== null) {
        const dv = speed - (prev.speed || 0);
        const lonG = dv / dt / G;
        // Längsbeschleunigung aus GPS (geglättet)
        this.live.lonG = lowpass(this.live.lonG, lonG, dt, 1.0);
      }
      if (!Number.isFinite(p.heading) || p.heading === null) p.heading = d > 2 ? bearing(prev, p) : prev.heading;
      if (this.recording && p.accuracy < 35 && dt > 0 && dt < 30) {
        const moving = speed > 0.9; // > ~3 km/h
        if (moving && d < 120 * dt) {
          this.stats.distance += d;
          this.stats.movingTime += dt;
        }
      }
    }
    speed = Math.max(0, speed || 0);
    p.speed = speed;

    // Höchstgeschwindigkeit: Median über 3 Messungen gegen GPS-Ausreißer
    this.speedHist.push(speed);
    if (this.speedHist.length > 3) this.speedHist.shift();
    const med = [...this.speedHist].sort((a, b) => a - b)[Math.floor(this.speedHist.length / 2)];
    if (this.recording && p.accuracy < 25) this.stats.maxSpeed = Math.max(this.stats.maxSpeed, med * 3.6);

    this.live.speed = speed * 3.6;
    this.live.pos = { lat: p.lat, lng: p.lng };
    this.live.heading = p.heading;
    this.live.accuracy = p.accuracy;
    this.lastPos = p;

    // Ohne Gyroskop (z. B. Desktop/Demo): Drehrate aus GPS-Kursänderung
    if (!this._motionSeen && prev && prev.heading != null && p.heading != null) {
      const dt = (p.t - prev.t) / 1000;
      let dh = p.heading - prev.heading;
      if (dh > 180) dh -= 360;
      if (dh < -180) dh += 360;
      if (dt > 0 && dt < 5) this._applyYawRate((-dh * DEG) / dt, dt, 0.6, true); // links = positiv
    }

    if (this.recording) {
      const extra = this.vehicle === 'motorcycle' ? Math.round(this.live.lean) : Math.round(this.live.totalG * 100) / 100;
      this.track.push([+p.lat.toFixed(6), +p.lng.toFixed(6), Math.round(p.t / 1000), Math.round(this.live.speed), extra]);
      this._finalize();
    }
    this.onUpdate?.({ live: this.live, stats: this.stats });
  }

  // ---------- Bewegungssensoren ----------
  _onMotion(e) {
    const aig = e.accelerationIncludingGravity;
    const rr = e.rotationRate;
    if (this.demo || !aig || aig.x === null || !rr || rr.alpha === null) return;
    this._motionSeen = true;
    const now = performance.now();
    const dt = this._lastMotion ? Math.min(0.2, (now - this._lastMotion) / 1000) : 0.016;
    this._lastMotion = now;
    const gVec = [aig.x, aig.y, aig.z];

    // Kalibrieren: Schwerkraftrichtung (= Hochachse) mitteln, solange langsam
    if (!this.up) {
      if (this.live.speed < 8) this.calib.push(gVec);
      if (this.calib.length >= 60) {
        const sum = this.calib.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]);
        this.up = norm(sum);
      } else return;
    } else if (this.live.speed < 3) {
      // im Stand langsam nachführen (Handy evtl. neu eingesetzt)
      const n = norm(gVec);
      this.up = norm(this.up.map((u, i) => lowpass(u, n[i], dt, 3)));
    }

    // Drehrate um die Hochachse (Grad/s -> rad/s). alpha=z, beta=x, gamma=y
    const omega = dot([rr.beta, rr.gamma, rr.alpha], this.up) * DEG;
    this._applyYawRate(omega, dt, 0.25);

    // Gesamt-G horizontal direkt vom Beschleunigungssensor (für Auto)
    const a = e.acceleration;
    if (a && a.x !== null) {
      const lin = [a.x, a.y, a.z];
      const vert = dot(lin, this.up);
      const horiz = Math.hypot(lin[0] - vert * this.up[0], lin[1] - vert * this.up[1], lin[2] - vert * this.up[2]) / G;
      this._accHoriz = lowpass(this._accHoriz || 0, horiz, dt, 0.4);
    }
  }

  // worldYaw=true: ω ist die echte Kursänderung (GPS) -> tan(φ) = v·ω/g
  // sonst ω vom Gyro in Fahrzeug-Hochachse (um cos φ verkürzt) -> sin(φ) = v·ω/g
  _applyYawRate(omega, dt, tau, worldYaw = false) {
    const v = this.live.speed / 3.6;
    const ratio = (v * omega) / G;
    if (this.vehicle === 'motorcycle') {
      // links = negativ, rechts = positiv
      const phi = worldYaw ? Math.atan(ratio) : Math.asin(Math.max(-1, Math.min(1, ratio)));
      const lean = v > 4 ? -phi / DEG : 0;
      this.live.lean = lowpass(this.live.lean, lean, dt, tau);
      if (this.recording && v > 4) {
        const l = Math.min(65, Math.abs(this.live.lean));
        if (this.live.lean < 0) this.stats.maxLeanLeft = Math.max(this.stats.maxLeanLeft, l);
        else this.stats.maxLeanRight = Math.max(this.stats.maxLeanRight, l);
      }
    } else {
      const latG = v > 2 ? -(v * omega) / G : 0; // rechts positiv
      this.live.latG = lowpass(this.live.latG, latG, dt, tau);
      const combined = Math.hypot(this.live.latG, this.live.lonG);
      this.live.totalG = Math.max(combined, this._motionSeen ? Math.min(this._accHoriz || 0, combined + 0.3) : 0);
      if (this.recording && v > 2) {
        const s = this.stats;
        s.maxLatG = Math.max(s.maxLatG, Math.min(2.5, Math.abs(this.live.latG)));
        if (this.live.lonG > 0) s.maxAccelG = Math.max(s.maxAccelG, Math.min(2.5, this.live.lonG));
        else s.maxBrakeG = Math.max(s.maxBrakeG, Math.min(2.5, -this.live.lonG));
        s.maxTotalG = Math.max(s.maxTotalG, Math.min(3, this.live.totalG));
      }
    }
    if (this._motionSeen) this._throttledUpdate();
  }

  _throttledUpdate() {
    const now = performance.now();
    if (now - (this._lastUi || 0) < 100) return;
    this._lastUi = now;
    this.onUpdate?.({ live: this.live, stats: this.stats });
  }

  // ---------- Demo-Modus: simuliert eine Fahrt entlang einer Route ----------
  startDemo(coords, vehicle) {
    this.stopDemo();
    this.stopSensors();
    this.vehicle = vehicle;
    this._motionSeen = false;
    if (!coords || coords.length < 2) return false;
    // Strecke gleichmäßig auf Meterbasis
    const pts = coords.map(([lat, lng]) => ({ lat, lng }));
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
    let s = 0;
    let t = Date.now();
    let v = 10;
    const total = cum[cum.length - 1];
    const at = (dist) => {
      let i = cum.findIndex((c) => c >= dist);
      if (i <= 0) i = 1;
      const f = (dist - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      return { lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * f, lng: pts[i - 1].lng + (pts[i].lng - pts[i - 1].lng) * f };
    };
    this.demo = setInterval(() => {
      // Kurvenradius voraus -> physikalisch mögliche Geschwindigkeit
      let vTarget = vehicle === 'motorcycle' ? 33 : 30;
      for (const ahead of [0, 30, 60, 90]) {
        const a = at(Math.min(total, s + ahead)), b = at(Math.min(total, s + ahead + 30)), c = at(Math.min(total, s + ahead + 60));
        let turn = Math.abs(bearing(a, b) - bearing(b, c));
        if (turn > 180) turn = 360 - turn;
        const kappa = (turn * DEG) / 30; // 1/m
        const aMax = (vehicle === 'motorcycle' ? 0.75 : 0.85) * G * (0.8 + 0.2 * Math.random());
        if (kappa > 0) vTarget = Math.min(vTarget, Math.sqrt(aMax / kappa));
      }
      vTarget = Math.max(8, vTarget);
      v += Math.max(-7, Math.min(3, vTarget - v));
      s += v;
      t += 1000;
      if (s >= total) { s = 0; this.lastPos = null; }
      const p = at(s);
      this._onGps({ ...p, speed: v, heading: null, accuracy: 5, t });
    }, 1000);
    return true;
  }

  stopDemo() {
    if (this.demo) clearInterval(this.demo);
    this.demo = null;
  }
}
