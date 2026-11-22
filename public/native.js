// Brücke zur nativen App (iOS/Android via Capacitor) und zu CarPlay.
// Im normalen Browser sind alle Funktionen harmlose No-ops.

const cap = window.Capacitor;
export const isNative = !!cap?.isNativePlatform?.();
const registerPlugin = window.capacitorExports?.registerPlugin || cap?.registerPlugin;
// CarPlay-Plugin gibt es nur in der iOS-App
const CarPlay = isNative && cap.getPlatform?.() === 'ios' && registerPlugin ? registerPlugin('KCCarPlay') : null;

// Server-Adresse: im Browser derselbe Host, in der App aus config.js
export const SERVER = (window.KC_SERVER || '').replace(/\/$/, '');
export const apiUrl = (path) => `${SERVER}/api${path}`;
export const wsUrl = () => {
  if (SERVER) return SERVER.replace(/^http/, 'ws') + '/ws';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
};
export const inviteUrl = (code) => (SERVER ? `${SERVER}/?join=${code}` : `${location.origin}${location.pathname}?join=${code}`);

let lastPush = 0;
let pending = null;
let timer = null;

// Zustand an CarPlay senden (max. 1×/Sekunde – CarPlay mag keine Dauerupdates)
export function pushToCarPlay(data) {
  if (!CarPlay) return;
  pending = data;
  const wait = 1000 - (Date.now() - lastPush);
  if (wait <= 0) flush();
  else if (!timer) timer = setTimeout(flush, wait);
}
function flush() {
  timer = null;
  if (!pending) return;
  lastPush = Date.now();
  const d = pending;
  pending = null;
  CarPlay.update(d).catch(() => {});
}

// Aktionen aus CarPlay (Aufzeichnung starten/stoppen, Nullpunkt setzen)
export function onCarPlayAction(cb) {
  CarPlay?.addListener('action', (e) => cb(e.action));
}

// Bildschirm während der Fahrt anlassen
let wakeLock = null;
export async function keepAwake(on) {
  try {
    if (CarPlay) await CarPlay.keepAwake({ on });
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock?.released === true) keepAwake(true);
});
