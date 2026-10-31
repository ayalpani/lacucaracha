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

## Tests

`npm run build && npx vite preview --port 4173` und dann `npm run test:ar`: simuliertes AR-Handy (Boden, Wand, Säule, Hit-Tests, Tiefendaten).

## Wie es funktioniert

- `src/worlds.ts`: Ein Fächer aus 30 WebXR-Hit-Tests (ARCore-Ebenen, waagrecht und senkrecht) tastet bei jedem Frame die Umgebung ab. Der Demo-Raum macht dasselbe mit Raycasts.
- `src/depth.ts`: Liest die ARCore-Tiefenkarte (WebXR Depth Sensing), macht daraus Flächenstücke für beliebige Formen (Stuhlbeine, Sofa, Blumentopf) und eine Tiefentextur, mit der Kakerlaken hinter echten Möbeln verdeckt werden (`src/occlusion.ts`).
- `src/surfaces.ts`: Die Treffer landen in einer Voxel-Karte aus kleinen Flächenstücken („Surfels“) mit Position und Normale.
- `src/swarm.ts`: Jede Kakerlake läuft nur auf beobachteten Flächen (keine Sprünge durch die Luft), läuft gern an Kanten entlang, klettert an Wänden/Möbelbeinen hoch, wenn sie sie berührt, flieht vor dem Handy, legt Pausen ein und vermehrt sich (ca. alle 9 s pro erwachsenem Tier, max. 220).
- `src/roachRenderer.ts`: Prozedurales 3D-Modell mit Dreifuß-Gang, tastenden Fühlern, Kontaktschatten. Alles über wenige Instanced Meshes, damit 200+ Tiere flüssig laufen.
- `src/audio.ts`: Alle Geräusche werden synthetisiert (Krabbeln räumlich per HRTF, Schwarm-Rascheln, Fauchen, Zerquetschen).

## Nächste Schritte

- Native App mit Unity AR Foundation für Android und iOS (Play Store / App Store)

## Eigenes 3D-Modell (GLB)

Die App nimmt das erste verfügbare Modell:
1. ein auf dem Gerät gespeichertes eigenes Modell (IndexedDB, `saveCustomModel` in `src/modelStore.ts`),
2. `public/models/roach.glb`,
3. sonst die eingebaute, prozedurale Kakerlake.

Das GLB darf statisch sein. `src/roachModel.ts` legt alle Meshes zusammen, skaliert auf 3,6 cm Körperlänge,
stellt die Füße auf den Boden, dreht die lange Achse nach vorn und animiert Beine (Dreifuß-Gang) und Fühler
im Vertex-Shader. Falsch herum? `setOrientation(name, { yaw, pitch })` (Vierteldrehungen).

Weg vom Bild zum Modell:
1. Konzeptbild mit einem Bild-Modell erzeugen (einzelne Kakerlake, 3/4-Ansicht von oben, neutraler Hintergrund).
2. Image-to-3D: z. B. Meshy (meshy.ai), Tripo (tripo3d.ai) oder Hunyuan3D. Low-poly ~5.000 Dreiecke, Textur an, Export GLB.
3. Datei als `public/models/roach.glb` committen. Test-Modell zum Ausprobieren: `node tests/make-test-glb.mjs out.glb`.
