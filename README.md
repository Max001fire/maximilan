# KurvenCrew 🏍️🚗

Touren-App für Motorrad- und Autofahrer: gemeinsam fahren, Freunde live auf der Karte sehen,
Kurvenspots eintragen, Routen durch Kurven planen und Fahrwerte vergleichen.

## Funktionen

- **Fahrzeugwahl** – Motorrad oder Auto (beim Start und jederzeit oben rechts umschaltbar).
- **Gruppenfahrt** – Fahrt erstellen, per Link/Code einladen (`?join=CODE`). Alle Teilnehmer sehen sich
  live auf der Karte (Name, Fahrzeug, Geschwindigkeit, Entfernung).
- **Kurvenspots** – Strecken (Anfang + Ende) mit Name, Beschreibung, Schwierigkeit und Fahrzeugtyp
  eintragen, liken und teilen.
- **Routenplanung durch Kurven** – Start/Ziel per Suche oder Kartenklick, Spots manuell oder automatisch
  („Spots auf dem Weg“) einbauen, optional Rundtour und Spots „hoch & runter“ fahren.
  Jede Route bekommt einen Kurven-Score. Der Gastgeber kann die Route an die Gruppe senden.
- **Aufzeichnung**
  - Motorrad: Höchstgeschwindigkeit, Ø-Geschwindigkeit, max. Schräglage links/rechts
  - Auto: Höchstgeschwindigkeit, Ø-Geschwindigkeit, Quer-G, Brems-G, Beschleunigungs-G, Gesamt-G (G-Kreis)
- **Vergleich** – Bestenliste mit Freunden oder allen, Gruppenergebnis nach jeder Gruppenfahrt,
  eigene Fahrtenhistorie mit Strecke auf der Karte.
- **Freunde** – über einen 6-stelligen Freundes-Code.
- **Demo-Modus** (Profil) – simuliert eine Fahrt entlang der Route, zum Ausprobieren am PC.

## Starten

```bash
npm install
npm start          # http://localhost:3000
npm test
```

Die Daten liegen in `data/db.json`. Umgebungsvariablen: `PORT`, `DATA_FILE`, `OSRM_URL`, `NOMINATIM_URL`.

**Auf dem Handy:** GPS und Bewegungssensoren funktionieren im Browser nur über **HTTPS**.
Also z. B. auf einem Server hinter einem HTTPS-Proxy (Caddy, nginx) betreiben oder zum Testen einen
Tunnel nutzen (`npx localtunnel --port 3000` o. ä.). Danach kann die App über „Zum Startbildschirm
hinzufügen“ wie eine normale App installiert werden (PWA).

## Wie werden Schräglage und G-Kräfte gemessen?

Ein Handy-Beschleunigungssensor zeigt in einer Motorrad-Kurve immer „senkrecht zum Motorrad“
(Schwer- und Fliehkraft heben sich auf) – die Schräglage lässt sich daraus nicht direkt ablesen.
KurvenCrew rechnet deshalb physikalisch:

- Beim Losfahren wird die Hochachse aus der Schwerkraftrichtung kalibriert (Handy in der Halterung,
  2 Sekunden still). Die Montage-Ausrichtung ist dadurch egal.
- Das Gyroskop misst die Drehrate ω um diese Achse, das GPS die Geschwindigkeit v.
- Motorrad: `sin(Schräglage) = v · ω / g`  ·  Auto: `Quer-G = v · ω / g`, `Längs-G = Δv/Δt`.
- Ohne Gyroskop wird ω grob aus der GPS-Kursänderung geschätzt.

Die Werte sind Schätzungen aus Handy-Sensoren, keine geeichten Messwerte.
Bitte fahrt verantwortungsvoll und haltet euch an die Verkehrsregeln.

## Technik

- Server: Node.js, Express, WebSocket (`ws`), JSON-Datei als Speicher
- Client: Vanilla JS (PWA), Leaflet, Kartenkacheln von CARTO/OpenStreetMap
- Routing: OSRM, Ortssuche: Nominatim (über den Server geproxied). Für viele Nutzer eigene
  Instanzen oder einen kommerziellen Anbieter verwenden – die öffentlichen Demo-Server sind limitiert.
