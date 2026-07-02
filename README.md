# Universal SpeedReader

Ein produktionsreifes Tampermonkey-Skript für RSVP-/ORP-Speedreading auf nahezu
jeder textbasierten Webseite. Wählt einen beliebigen HTML-Container, zerlegt
dessen Inhalt in Wörter/Blöcke und zeigt sie im RSVP-Tempo an — synchron mit
Auto-Scroll des Originalcontainers.

## Installation

1. [Tampermonkey](https://www.tampermonkey.net/) (oder kompatiblen Userscript-
   Manager) installieren.
2. [`universal-speedreader.user.js`](universal-speedreader.user.js) importieren
   (Tampermonkey-Dashboard → "Neues Skript" → Inhalt einfügen, oder Datei direkt
   öffnen).

## Nutzung

1. Auf der Zielseite erscheint ein schwebender ⚡-Button unten rechts.
2. Klick aktiviert den Auswahlmodus — Container unter der Maus werden
   hervorgehoben, ESC bricht ab.
3. Klick auf einen Container startet den Reader.
4. Steuerung über die fixierte Toolbar oder Tastatur:
   - `Leertaste` — Pause/Weiter
   - `←` / `→` — Wort zurück/vor
   - `PageUp` / `PageDown` — vorherige/nächste Überschrift
   - `↑` / `↓` — schneller/langsamer
   - `Esc` — Reader schließen

Pro Seite kann jeweils nur eine Reader-Session aktiv sein.

## Funktionen

- DOM-Parser erkennt Überschriften, Absätze, Listen, Tabellen, Bilder, Videos,
  Code(-blöcke), Blockquotes, Details/Summary, MathJax/KaTeX, SVG, Canvas,
  Fußnoten und Zitate.
- ORP (Optimal Recognition Point) mit optional fixiertem Fokuspunkt.
- Adaptive Lesegeschwindigkeit je Blocktyp sowie Satzzeichen-Pausen.
- Einstellbare Schriftgröße.
- Fokusmodus: Elemente außerhalb des gewählten Containers abdunkeln,
  verwischen oder ausblenden.
- Bildunterschriften und Quellenangaben/Fußnoten optional überspringen.
- Kontinuierliches, sanftes Auto-Scrolling des Originalcontainers.
- Statistik nach Sitzungsende (Gesamtzeit, Ø-WPM, Wortzahl, geschätzte
  Zeitersparnis, …).
- Alle Einstellungen persistieren über `GM_setValue`/`GM_getValue`, inklusive
  letzter Leseposition je Seite.

## Architektur

Einzelne `.user.js`-Datei, intern in klar getrennte ES2022-Klassen gegliedert
(Utils, SettingsManager, EventBus, Tokenizer, Block-Modell, DomParser,
SpeedModel, ORP, ScrollEngine, ReaderEngine, UI-Komponenten,
KeyboardController, App). Details siehe Kopfkommentar in
[`universal-speedreader.user.js`](universal-speedreader.user.js) und
[`plan.md`](plan.md) für die ursprüngliche Spezifikation.

## Lizenz

[MIT](LICENSE)
