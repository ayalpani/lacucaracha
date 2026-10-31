# La Cucaracha 🪳

AR-Streich-App: Handy auf den Raum halten, und plötzlich krabbeln Kakerlaken über Boden, Möbel und Wände, vermehren sich und rascheln.

Dieser Stand ist ein **WebXR-Prototyp** (TypeScript, three.js, Vite). Er läuft in Chrome auf ARCore-fähigen Android-Handys (z. B. Galaxy A54), ohne Installation.

## Bedienung

- **Kakerlaken loslassen**: startet AR. Handy langsam über Boden und Möbel bewegen; sobald genug Fläche erkannt ist, kommen die ersten.
- Tippen auf eine Kakerlake zerquetscht sie, Tippen daneben setzt neue.
- `+🪳` mehr Kakerlaken, `⏸` Vermehrung anhalten, `🔊` Ton, `✕` beenden.
- **Demo ohne AR**: virtuelles Wohnzimmer zum Testen am Rechner (Ziehen dreht die Kamera).

## Entwicklung

```bash
npm install
npm run dev       # http://localhost:5173 (Demo-Modus am Mac)
npm run build     # Typecheck + Build nach dist/
```

AR auf dem Handy direkt vom Mac testen (WebXR braucht HTTPS oder localhost):
USB-Debugging am A54 an, in Chrome am Mac `chrome://inspect` → *Port forwarding* `5173 → localhost:5173`, dann am Handy `http://localhost:5173` öffnen.

## Wie es funktioniert

- `src/worlds.ts`: Ein Fächer aus 30 WebXR-Hit-Tests (ARCore-Ebenen, waagrecht und senkrecht) tastet bei jedem Frame die Umgebung ab. Der Demo-Raum macht dasselbe mit Raycasts.
- `src/surfaces.ts`: Die Treffer landen in einer Voxel-Karte aus kleinen Flächenstücken („Surfels“) mit Position und Normale.
- `src/swarm.ts`: Jede Kakerlake läuft auf dieser Karte, wechselt an Kanten auf Wände/Möbelseiten, flieht vor dem Handy, legt Pausen ein und vermehrt sich (ca. alle 9 s pro erwachsenem Tier, max. 220).
- `src/roachRenderer.ts`: Prozedurales 3D-Modell mit Dreifuß-Gang, tastenden Fühlern, Kontaktschatten. Alles über wenige Instanced Meshes, damit 200+ Tiere flüssig laufen.
- `src/audio.ts`: Alle Geräusche werden synthetisiert (Krabbeln räumlich per HRTF, Schwarm-Rascheln, Fauchen, Zerquetschen).

## Nächste Schritte

- Verdeckung durch echte Möbel (WebXR Depth Sensing bzw. ARCore Depth API)
- Native App mit Unity AR Foundation für Android und iOS (Play Store / App Store)
