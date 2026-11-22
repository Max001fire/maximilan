// Baut den Web-Teil für die native App (Capacitor) nach ./www
//   KC_SERVER=https://dein-server.de npm run build:mobile
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'www');
const server = (process.env.KC_SERVER || '').replace(/\/$/, '');
if (!/^https:\/\//.test(server)) {
  console.warn('⚠️  KC_SERVER ist nicht gesetzt (oder kein https). Die App braucht die Adresse deines Servers, z. B.:');
  console.warn('    KC_SERVER=https://kurvencrew.example.de npm run build:mobile');
}
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), out, { recursive: true });
fs.rmSync(path.join(out, 'sw.js'), { force: true }); // Service Worker nur im Browser
fs.cpSync(path.join(root, 'node_modules/leaflet/dist'), path.join(out, 'vendor/leaflet'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules/@capacitor/core/dist/capacitor.js'), path.join(out, 'vendor/capacitor.js'));
fs.writeFileSync(path.join(out, 'config.js'), `window.KC_SERVER = ${JSON.stringify(server)};\n`);
console.log(`www/ gebaut (Server: ${server || '— nicht gesetzt —'})`);
