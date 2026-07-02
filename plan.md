Prompt: Entwicklung eines universellen Speedreaders als Tampermonkey-Skript

Entwickle ein vollständig dokumentiertes, hochwertiges Tampermonkey-Skript mit dem Namen Universal SpeedReader, das auf möglichst allen textbasierten Webseiten funktioniert. Das Ergebnis soll produktionsreif, modular aufgebaut und leicht erweiterbar sein. Es soll kein Prototyp, sondern ein langfristig wartbares Projekt werden.

Ziel

Das Skript soll einen frei auswählbaren HTML-Container analysieren und dessen Inhalt als RSVP-/ORP-Speedreader darstellen. Gleichzeitig soll der ursprüngliche Container automatisch und synchron mit dem Lesefortschritt gescrollt werden.

⸻

Allgemeine Anforderungen

* ES2022+ JavaScript
* Tampermonkey-kompatibel
* Eine importierbare .user.js-Datei
* Modularer Aufbau innerhalb der Datei (Klassen und klar getrennte Bereiche)
* Umfangreiche Kommentare und Dokumentation
* Gute Lesbarkeit und Wartbarkeit
* Performanceoptimiert
* Keine externen Bibliotheken oder Frameworks
* Speicherung der Einstellungen über GM_getValue und GM_setValue

⸻

Container-Auswahl

Nach dem Laden der Seite erscheint ein kleiner Floating-Button.

Beim Anklicken:

* Auswahlmodus aktivieren
* Container unter der Maus hervorheben
* Klick auf einen Container startet den Reader
* Auswahlmodus abbrechbar (ESC)

⸻

DOM-Parser

Analysiere den ausgewählten Container rekursiv.

Erkenne mindestens:

* Überschriften
* Paragraphen
* Listen
* Tabellen
* Bilder
* Videos
* Codeblöcke
* Inline-Code
* Blockquotes
* Details/Summary
* MathJax/KaTeX (wenn vorhanden)
* SVG
* Canvas
* Fußnoten
* Zitate

Erzeuge daraus ein internes Blockmodell.

Jeder Block enthält mindestens:

* DOM-Element
* Typ
* Position
* Höhe
* Wortliste
* Zeichenanzahl
* Wortanzahl
* Geschwindigkeitsfaktor
* Sichtbarkeit
* Scrollanker

⸻

Tokenizer

Der Tokenizer soll:

* Wörter korrekt trennen
* Satzzeichen erkennen
* Zahlen erkennen
* Abkürzungen möglichst korrekt behandeln
* Sonderzeichen berücksichtigen
* Unicode vollständig unterstützen

⸻

Reader Engine

Implementiere einen vollständigen RSVP-Reader.

Funktionen:

* Start
* Pause
* Stop
* Vor
* Zurück
* Springen
* Fortschritt
* Restzeit
* Kapitel
* Aktuelle Position

⸻

ORP (Optimal Recognition Point)

Direkt implementieren.

Anforderungen:

* Berechnung des optimalen Fokusbuchstabens
* Hervorhebung des Fokusbuchstabens
* Referenzlinie
* Zentrierung des Fokuspunkts
* Aktivierbar/deaktivierbar
* Funktioniert bei allen Wortlängen

⸻

Adaptive Lesegeschwindigkeit

Standardgeschwindigkeit:

* frei einstellbare WPM

Automatische Anpassung bei:

* Überschriften
* Bildern
* Tabellen
* Code
* Formeln
* Listen
* Blockquotes

Zusätzliche Pausen bei:

* .
* !
* ?
* :
* ;

Kleinere Pause bei:

* ,

Optional:

* Zahlen etwas länger anzeigen
* Lange Wörter etwas länger anzeigen

⸻

Scroll Engine

Nicht scrollIntoView() verwenden.

Implementiere stattdessen:

* kontinuierliches Scrollen
* sanfte Animation
* Synchronisation mit der Reader-Position
* konfigurierbare Zielposition im Container
* automatische Nachführung

Der Reader soll stets synchron mit dem angezeigten Wort bleiben.

⸻

Benutzeroberfläche

Sticky Toolbar innerhalb des Containers.

Enthalten:

* ORP-Anzeige
* Referenzlinie
* Fortschrittsbalken
* Kapitel
* Wörter gelesen
* Wörter gesamt
* Prozent
* Restzeit
* aktuelle WPM

Buttons:

* Start
* Pause
* Stop
* Vor
* Zurück

Regler:

* WPM

Schalter:

* ORP
* AutoScroll
* Adaptive Geschwindigkeit
* Satzzeichenpausen
* Position (oben/unten)

⸻

Tastatursteuerung

Mindestens:

Leertaste

* Pause

Pfeil links

* zurück

Pfeil rechts

* vor

Pfeil hoch

* schneller

Pfeil runter

* langsamer

ESC

* schließen

⸻

Einstellungen

Persistente Speicherung mit GM_setValue.

Mindestens:

* WPM
* Theme
* ORP
* Toolbarposition
* Scrollmodus
* Geschwindigkeitsfaktoren
* Hotkeys
* Letzte Leseposition

⸻

Statistik

Nach Ende anzeigen:

* Gesamtzeit
* Durchschnittliche WPM
* Effektive WPM
* Anzahl Wörter
* Anzahl Bilder
* Anzahl Tabellen
* Anzahl Codeblöcke
* Geschätzte Zeitersparnis

⸻

Performance

Das Skript soll auch mit sehr großen Dokumenten funktionieren.

Implementiere nach Möglichkeit:

* Lazy Parsing
* MutationObserver
* effiziente DOM-Zugriffe
* minimierte Reflows
* Caching
* requestAnimationFrame für Animationen

⸻

Codequalität

* Keine globalen Variablen
* Keine doppelten Funktionen
* Saubere Klassenstruktur
* Klare Trennung von Parser, Reader, Scroll Engine und UI
* Umfangreiche Kommentare
* Fehlerbehandlung
* Robuste DOM-Erkennung
* Hohe Wartbarkeit

⸻

Entwicklungsstrategie

Das Projekt soll nicht als Prototyp, sondern als vollständige Software entwickelt werden.

Arbeite iterativ in klar abgegrenzten Modulen.

Jedes Modul soll vollständig funktionsfähig sein, bevor das nächste implementiert wird.

Die Architektur soll spätere Erweiterungen ohne größere Umbauten ermöglichen.

⸻

Optionale Erweiterungen

Falls die Architektur es zulässt, berücksichtige bereits Erweiterungspunkte für:

* EPUB-Unterstützung
* PDF-Unterstützung
* Browser-Erweiterung statt Tampermonkey
* KI-gestützte Geschwindigkeitsanpassung
* Lesefortschritt-Synchronisation
* Mehrsprachige Oberfläche
* Barrierefreiheit
* Dyslexie-Schriftarten
* Cloud-Synchronisation

⸻

Erwartetes Ergebnis

Erstelle keinen Beispielcode und keinen Prototypen.

Erstelle stattdessen eine vollständige, produktionsreife Implementierung, die direkt als Tampermonkey-Skript installiert werden kann.

Die Entwicklung soll schrittweise erfolgen, wobei jede Ausbaustufe vollständig lauffähig ist und auf der vorherigen aufbaut.