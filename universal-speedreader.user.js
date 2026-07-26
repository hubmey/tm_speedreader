// ==UserScript==
// @name         Universal SpeedReader
// @namespace    https://github.com/hubmey/tm_speedreader.git
// @version      1.28.0
// @description  RSVP/ORP Speedreader für nahezu jede textbasierte Webseite, mit synchronem Auto-Scroll des Originalcontainers.
// @author       Hubertus Meyer
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/hubmey/tm_speedreader/main/universal-speedreader.user.js
// @downloadURL  https://raw.githubusercontent.com/hubmey/tm_speedreader/main/universal-speedreader.user.js
// ==/UserScript==

/**
 * =============================================================================
 *  UNIVERSAL SPEEDREADER
 * =============================================================================
 *
 *  Architektur-Übersicht
 *  ----------------------
 *  Das Skript ist in klar getrennte Module (ES2022-Klassen) gegliedert, die
 *  jeweils in einem eigenen Abschnitt dieser Datei liegen:
 *
 *    1. Utils              – generische Helferfunktionen (keine globalen Leaks)
 *    2. SettingsManager     – Persistenz über GM_getValue/GM_setValue
 *    3. EventBus            – einfaches Pub/Sub für lose Kopplung der Module
 *    4. Tokenizer           – zerlegt Text in Wörter/Satzzeichen (Unicode-fest)
 *    5. Block-Modell        – Datenstruktur je erkanntem DOM-Abschnitt
 *    6. DomParser            – rekursive Analyse des gewählten Containers
 *    7. SpeedModel          – adaptive Geschwindigkeits-/Pausenlogik
 *    8. ORP                 – Berechnung des Optimal Recognition Point
 *    9. ScrollEngine         – rAF-basiertes, sanftes Container-Scrolling
 *   10. ReaderEngine         – RSVP-Zustandsautomat (Start/Pause/Stop/Seek…)
 *   11. UI-Komponenten       – FloatingButton, SelectionOverlay, Toolbar, Stats
 *   12. KeyboardController   – Tastatursteuerung
 *   13. App                  – Orchestrierung / Bootstrap
 *
 *  Erweiterungspunkte (bewusst vorbereitet, siehe Kommentare "EXTENSION POINT"):
 *    - Alternative "Content Sources" statt Live-DOM (EPUB/PDF-Import)
 *    - Alternative "Renderer" statt DOM-Overlay (Browser-Extension-Popup)
 *    - Austauschbares SpeedModel (z. B. KI-gestützte Anpassung)
 *    - i18n-Layer für die UI-Strings
 *    - Cloud-Sync-Adapter anstelle von GM_setValue
 *
 *  Alle Module kommunizieren ausschließlich über den EventBus oder explizite
 *  Konstruktor-Injektion – es gibt keine globalen Variablen außerhalb der
 *  einen IIFE-Kapselung.
 * =============================================================================
 */

(() => {
  'use strict';

  // ===========================================================================
  // 0. KONSTANTEN & DEFAULT-KONFIGURATION
  // ===========================================================================

  /** Eindeutiges Präfix für alle DOM-IDs/Klassen/Storage-Keys, verhindert Kollisionen. */
  const NS = 'usr-speedreader';

  /** Default-Einstellungen, die beim ersten Start persistiert werden. */
  const DEFAULT_SETTINGS = Object.freeze({
    wpm: 350,                 // Wörter pro Minute
    minWpm: 80,
    maxWpm: 1200,
    theme: 'dark',            // 'dark' | 'light'
    orpEnabled: true,
    orpFixedPoint: true,      // Fokusbuchstabe bleibt an fester Bildschirmposition (statt Referenzlinie nachzuführen)
    toolbarPosition: 'top',   // 'top' | 'bottom'
    scrollMode: 'smooth',     // 'smooth' | 'instant' | 'off'
    scrollTargetRatio: 0.35,  // Zielposition des aktuellen Blocks im Viewport (0=oben,1=unten)
    adaptiveSpeed: true,
    punctuationPauses: true,
    autoScroll: true,
    skipImageCaptions: false, // Bildunterschriften (figcaption/alt) beim Lesen überspringen
    skipCitations: false,     // Quellenangaben/Fußnoten (cite, .footnote) komplett auslassen
    skipTables: false,        // Tabelleninhalt nicht vorlesen, nur kurz "[Tabelle]" als Pausenplatzhalter anzeigen
    placeholderPauseMs: 1000, // Mindest-Anzeigedauer für Platzhalter (übersprungene Tabellen/Bilder ohne Text)
    minPlaceholderPauseMs: 300,
    maxPlaceholderPauseMs: 3000,
    clickSoundEnabled: false, // kurzer Klickton bei jedem neuen Wort
    clickSoundVariant: 'click', // 'click' | 'soft' | 'blip' | 'wood' | 'bell' | 'klassik'
    readAloudMode: false,     // reiner Vorlesemodus: Sprachausgabe steuert das Tempo, WPM wird ignoriert
    readAloudRate: 1,         // Sprechgeschwindigkeit der Sprachausgabe (0.5–2), unabhängig von WPM
    minReadAloudRate: 0.5,
    maxReadAloudRate: 2,
    readAloudVoiceURI: '',    // gewählte Stimme; '' = automatisch beste (Premium bevorzugt)
    displayFontSize: 30,      // Schriftgröße (px) der Wortanzeige
    minFontSize: 14,
    maxFontSize: 72,
    focusMode: 'off',         // 'off' | 'dim' | 'blur' | 'hide' – Behandlung von Elementen außerhalb des Containers
    highlightSourceWord: true, // aktuelles Wort dezent im Original-Quelltext hervorheben
    listZebraStripes: false,  // Wortanzeige-Hintergrund je nach <li>-Position abwechselnd einfärben
    viewMode: 'full',         // 'full' = alles | 'compact' = nur Wort+Fortschritt+Infoleiste | 'focus' = nur das Wort
    showStatsOnFinish: true,  // Zusammenfassung nach Sitzungsende anzeigen
    autoCloseAfterFinish: false, // Reader nach Sitzungsende automatisch schließen
    autoCloseDelayMs: 4000,   // Verzögerung bis Auto-Schließen, falls Statistik noch angezeigt wird
    speedFactors: {
      heading: 0.55,
      image: 0.30,
      table: 0.45,
      code: 0.60,
      formula: 0.45,
      list: 0.85,
      blockquote: 0.75,
      footnote: 0.70,
      default: 1.0,
    },
    punctuationDelayMs: {
      strong: 220,   // . ! ? :
      medium: 140,   // ; –
      soft: 90,      // ,
    },
    longWordThreshold: 9,
    longWordExtraMs: 65,
    numberExtraMs: 60,
    hotkeys: {
      togglePause: 'Space',
      prev: 'ArrowLeft',
      next: 'ArrowRight',
      faster: 'ArrowUp',
      slower: 'ArrowDown',
      nextChapter: 'PageDown',
      prevChapter: 'PageUp',
      close: 'Escape',
      // Buchstaben-Hotkeys als evt.key (layout-abhängig, z. B. 'f'/'z'), NICHT
      // evt.code – "KeyZ" ist die QWERTY-Position, die auf QWERTZ-Tastaturen
      // (Y/Z vertauscht) nie durch Drücken der Z-Taste ausgelöst würde.
      fullscreen: 'f',
      superFocus: 'z',
      toggleSound: 'k',    // Klickton ein/aus (layout-unabhängig via evt.key)
    },
    lastPosition: {}, // { [urlHash]: { tokenIndex, url, title, timestamp } }
  });

  /** Regex-Wortgrenzen: Unicode-Buchstaben/Ziffern inkl. Bindestrich/Apostroph innerhalb Wörtern. */
  const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

  /** Bekannte Abkürzungen, nach denen ein "." NICHT als Satzende gilt (De/En Auswahl, erweiterbar). */
  const ABBREVIATIONS = new Set([
    'z.b', 'z.b.', 'u.a', 'u.a.', 'd.h', 'd.h.', 'bzw', 'bzw.', 'etc', 'etc.',
    'ca', 'ca.', 'inkl', 'inkl.', 'exkl', 'exkl.', 'usw', 'usw.', 'evtl', 'evtl.',
    'dr', 'dr.', 'prof', 'prof.', 'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.',
    'vs', 'vs.', 'e.g', 'e.g.', 'i.e', 'i.e.', 'no', 'no.', 'nr', 'nr.',
  ]);

  /**
   * Kompaktes, einheitliches Icon-Set (Strichzeichnungen, 24x24 viewBox,
   * currentColor) für Toolbar-Buttons – ersetzt die zuvor uneinheitlichen
   * Emoji-Symbole (die je nach OS/Browser unterschiedlich aussahen und z. B.
   * bei Wort- vs. Kapitel-Navigation nicht eindeutig unterscheidbar waren).
   * Einfacher/doppelter Chevron = Wort- vs. Kapitelsprung (konsistente Konvention).
   */
  const ICONS = {
    play: '<path d="M8 5v14l11-7z" fill="currentColor"/>',
    pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>',
    chevronLeft: '<polyline points="15 5 8 12 15 19" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>',
    chevronRight: '<polyline points="9 5 16 12 9 19" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>',
    chevronsLeft: '<polyline points="18 5 11 12 18 19" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><polyline points="11 5 4 12 11 19" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>',
    chevronsRight: '<polyline points="6 5 13 12 6 19" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><polyline points="13 5 20 12 13 19" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>',
    close: '<line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>',
    maximize: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
    minimize: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
    updown: '<polyline points="7 9 12 4 17 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="7 15 12 20 17 15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/>',
    help: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.2 9.3a2.8 2.8 0 1 1 3.7 2.65c-.7.27-1.15.9-1.15 1.65v.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.2" r="1.1" fill="currentColor"/>',
    soundOn: '<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 8.5a4 4 0 0 1 0 7M18.5 6a7 7 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    soundOff: '<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><line x1="16" y1="9" x2="21" y2="15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="21" y1="9" x2="16" y2="15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    readAloud: '<path d="M4 5.5A2 2 0 0 1 6 4h5v15H6a2 2 0 0 0-2 2V5.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M20 5.5A2 2 0 0 0 18 4h-5v15h5a2 2 0 0 1 2 2V5.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  };

  /** Erzeugt ein kleines Inline-SVG-Icon aus ICONS[name]. */
  function makeIcon(name, size = 15) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    svg.style.display = 'block';
    svg.innerHTML = ICONS[name] || '';
    return svg;
  }

  /** Menschenlesbare Kurzform für Hotkey-Werte (evt.code ODER einzelne evt.key-Buchstaben), für Tooltips/Hints. */
  const HOTKEY_LABELS = {
    Space: 'Leertaste', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    PageUp: 'Bild ↑', PageDown: 'Bild ↓', Escape: 'Esc',
  };
  function hotkeyLabel(code) {
    if (HOTKEY_LABELS[code]) return HOTKEY_LABELS[code];
    if (code && code.length === 1) return code.toUpperCase();
    return code || '';
  }

  // ===========================================================================
  // 1. UTILS
  // ===========================================================================

  /**
   * Sammlung zustandsloser Hilfsfunktionen. Statische Klasse statt loser
   * Funktionen, damit nichts in den globalen Scope der Seite entweicht.
   */
  class Utils {
    /** Block-Level-Elemente, an deren Grenzen visibleTextContent() eine Wortgrenze erzwingt. */
    static BLOCK_TAGS = 'li, p, div, br, tr, td, th, dt, dd, h1, h2, h3, h4, h5, h6, blockquote, section, article, header, footer, figure, figcaption, ul, ol, table, pre';

    static clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    static debounce(fn, wait) {
      let timer = null;
      return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
      };
    }

    static throttle(fn, wait) {
      let last = 0;
      let scheduled = null;
      return (...args) => {
        const now = performance.now();
        const remaining = wait - (now - last);
        if (remaining <= 0) {
          last = now;
          fn(...args);
        } else {
          clearTimeout(scheduled);
          scheduled = setTimeout(() => {
            last = performance.now();
            fn(...args);
          }, remaining);
        }
      };
    }

    static uuid() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }

    /** Einfacher, schneller Hash (nicht kryptographisch) für URL+Titel als Storage-Key. */
    static hashString(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
      }
      return (hash >>> 0).toString(36);
    }

    static formatTime(seconds) {
      const s = Math.max(0, Math.round(seconds));
      const m = Math.floor(s / 60);
      const r = s % 60;
      return `${m}:${String(r).padStart(2, '0')}`;
    }

    static isElementVisible(el) {
      if (!el || !el.isConnected) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    /**
     * Wie element.textContent, aber Text unter unsichtbaren Nachfahren
     * (verschachteltes display:none/visibility:hidden, z. B. ein <span
     * style="display:none"> innerhalb eines ansonsten sichtbaren <p>) wird
     * ausgeschlossen. isElementVisible() prüft dank getBoundingClientRect()
     * automatisch die gesamte Vorfahrenkette (ein von einem unsichtbaren
     * Ahnen "erdrückter" Knoten hat immer eine 0x0-Rect), daher genügt die
     * Prüfung des direkten Textknoten-Elternteils.
     */
    /**
     * Einmaliger Durchlauf durch die sichtbaren Textknoten eines Elements, der
     * PARALLEL Rohwörter und ihre DOM-Ranges liefert (gleicher Index = gleiches
     * Wort). Das ist die einzige Stelle, an der Wortgrenzen (Whitespace +
     * Block-Element-Wechsel, z. B. dicht gepackte <li>/<p> ohne Zeilenumbruch
     * im Markup) bestimmt werden – Tokenizer-Eingabe und Highlight-/Zebra-Ranges
     * greifen beide auf dieses Ergebnis zu und können dadurch nie mehr
     * auseinanderdriften (vorher: zwei separat gepflegte TreeWalker-Implementierungen,
     * die bei sehr verschachteltem/komplexem Markup lautlos divergieren konnten).
     */
    static extractWords(element) {
      const words = [];
      const ranges = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
          return Utils.isElementVisible(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });

      let buffer = '';
      let currentStart = null;
      let lastNode = null;
      let lastBlock = null;
      const flush = (endNode, endOffset) => {
        if (currentStart && buffer) {
          words.push(buffer);
          ranges.push({ startNode: currentStart.node, startOffset: currentStart.offset, endNode, endOffset });
        }
        buffer = '';
        currentStart = null;
      };

      let node;
      while ((node = walker.nextNode())) {
        const block = node.parentElement.closest(Utils.BLOCK_TAGS) || element;
        if (lastBlock !== null && block !== lastBlock) {
          flush(lastNode, lastNode ? lastNode.nodeValue.length : 0);
        }
        lastNode = node;
        lastBlock = block;

        const text = node.nodeValue.replace(/ /g, ' ');
        for (let i = 0; i < text.length; i++) {
          if (/\s/.test(text[i])) {
            flush(node, i);
          } else {
            if (currentStart === null) currentStart = { node, offset: i };
            buffer += text[i];
          }
        }
      }
      if (lastNode) flush(lastNode, lastNode.nodeValue.length);

      return { words, ranges };
    }

    /** Bequemlichkeits-Wrapper um extractWords() für Aufrufer, die nur den Text brauchen (keine Ranges). */
    static visibleTextContent(element) {
      return Utils.extractWords(element).words.join(' ');
    }

    /** Erstellt ein DOM-Element mit Attributen/Kindern in einem Aufruf (kein Framework nötig). */
    static el(tag, attrs = {}, children = []) {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (value !== undefined && value !== null) {
          node.setAttribute(key, value);
        }
      }
      for (const child of [].concat(children)) {
        if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      }
      return node;
    }

    /** Tiefe Zusammenführung für verschachtelte Settings-Objekte (Defaults <- gespeicherte Werte). */
    static deepMerge(base, override) {
      if (typeof base !== 'object' || base === null) return override ?? base;
      const result = Array.isArray(base) ? [...base] : { ...base };
      if (override && typeof override === 'object') {
        for (const key of Object.keys(override)) {
          result[key] = Utils.deepMerge(base[key], override[key]);
        }
      }
      return result;
    }
  }

  // ===========================================================================
  // 2. SETTINGS MANAGER
  // ===========================================================================

  /**
   * Kapselt sämtliche Persistenz. Nach außen wird ein synchrones, gemergtes
   * Settings-Objekt bereitgestellt; Schreibzugriffe werden gedebounced, um
   * GM_setValue nicht bei jedem Slider-Tick aufzurufen.
   *
   * EXTENSION POINT: Ein CloudSyncSettingsManager könnte dieselbe Schnittstelle
   * (get/set/save/load) implementieren und GM_setValue durch einen Netzwerk-
   * Adapter ersetzen, ohne dass Reader/UI angepasst werden müssen.
   */
  class SettingsManager {
    static STORAGE_KEY = `${NS}:settings`;

    constructor() {
      this.values = this._load();
      this._persist = Utils.debounce(() => this._save(), 400);
    }

    _load() {
      let stored = {};
      try {
        const raw = GM_getValue(SettingsManager.STORAGE_KEY, null);
        stored = raw ? JSON.parse(raw) : {};
      } catch (err) {
        console.warn(`[${NS}] Einstellungen konnten nicht geladen werden, nutze Defaults.`, err);
        stored = {};
      }
      return Utils.deepMerge(DEFAULT_SETTINGS, stored);
    }

    _save() {
      try {
        GM_setValue(SettingsManager.STORAGE_KEY, JSON.stringify(this.values));
      } catch (err) {
        console.warn(`[${NS}] Einstellungen konnten nicht gespeichert werden.`, err);
      }
    }

    get(path) {
      return path.split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), this.values);
    }

    set(path, value) {
      const keys = path.split('.');
      let target = this.values;
      for (let i = 0; i < keys.length - 1; i++) {
        if (typeof target[keys[i]] !== 'object' || target[keys[i]] === null) target[keys[i]] = {};
        target = target[keys[i]];
      }
      target[keys[keys.length - 1]] = value;
      this._persist();
    }

    saveLastPosition(urlKey, data) {
      this.values.lastPosition[urlKey] = { ...data, timestamp: Date.now() };
      this._persist();
    }

    getLastPosition(urlKey) {
      return this.values.lastPosition[urlKey] || null;
    }
  }

  // ===========================================================================
  // 3. EVENT BUS
  // ===========================================================================

  /** Minimalistischer Publish/Subscribe-Mechanismus zur losen Kopplung der Module. */
  class EventBus {
    constructor() {
      this._listeners = new Map();
    }

    on(event, handler) {
      if (!this._listeners.has(event)) this._listeners.set(event, new Set());
      this._listeners.get(event).add(handler);
      return () => this.off(event, handler);
    }

    off(event, handler) {
      this._listeners.get(event)?.delete(handler);
    }

    emit(event, payload) {
      this._listeners.get(event)?.forEach((handler) => {
        try {
          handler(payload);
        } catch (err) {
          console.error(`[${NS}] Fehler im Event-Handler für "${event}":`, err);
        }
      });
    }
  }

  // ===========================================================================
  // 4. TOKENIZER
  // ===========================================================================

  /**
   * Zerlegt Fließtext in "Token" – im Wesentlichen Wörter (inkl. angehängter
   * Satzzeichen-Metadaten). Unterstützt vollständige Unicode-Wortzeichen
   * (\p{L}, \p{N}), erkennt Zahlen, Abkürzungen und mehrfache Satzzeichen.
   *
   * Jedes Token-Objekt:
   *   { text, isNumber, endsSentence, punctuation: 'strong'|'medium'|'soft'|null }
   */
  class Tokenizer {
    /** Zerlegt einen Text-String in ein Array von Roh-Wörtern (ohne umgebenden Whitespace). */
    static splitWords(text) {
      if (!text) return [];
      // Whitespace (inkl. geschützter Leerzeichen, Zeilenumbrüche) als Trenner.
      return text
        .replace(/ /g, ' ')
        .split(/\s+/)
        .map((w) => w.trim())
        .filter(Boolean);
    }

    /** Baut aus einem rohen Wort (mit evtl. anhängenden Satzzeichen) ein Token-Objekt. */
    static tokenize(rawWord) {
      const trimmed = rawWord.trim();
      if (!trimmed) return null;

      const lower = trimmed.toLowerCase();
      const isAbbreviation = ABBREVIATIONS.has(lower.replace(/[,;:]+$/, ''));

      // Satzzeichen am Wortende extrahieren (kann mehrere sein, z. B. "wirklich?!").
      const trailingPunctMatch = trimmed.match(/[.,;:!?…"'”’)\]]+$/u);
      const trailingPunct = trailingPunctMatch ? trailingPunctMatch[0] : '';

      let punctuation = null;
      if (!isAbbreviation && trailingPunct) {
        if (/[.!?…]/.test(trailingPunct)) punctuation = 'strong';
        else if (/[;:]/.test(trailingPunct)) punctuation = 'medium';
        else if (/[,]/.test(trailingPunct)) punctuation = 'soft';
      }

      const endsSentence = !isAbbreviation && /[.!?…]$/.test(trailingPunct);

      // Zahlenerkennung: reine Ziffern, Dezimal-/Tausendertrennzeichen, Prozent, Einheiten-Suffixe.
      const isNumber = /^[+-]?\d[\d.,]*\s?%?$/u.test(trimmed.replace(/[.,;:!?…]+$/u, ''));

      // Reine Wortzeichen zählen (für Länge / adaptive Anzeigezeit), Satzzeichen zählen separat.
      const letters = [...trimmed].filter((ch) => WORD_CHAR_RE.test(ch)).length;

      return {
        text: trimmed,
        length: trimmed.length,
        letterCount: letters,
        isNumber,
        endsSentence,
        punctuation,
      };
    }

    /** Komfort-Methode: Text -> Token-Liste in einem Schritt. */
    static tokenizeText(text) {
      return Tokenizer.splitWords(text)
        .map((w) => Tokenizer.tokenize(w))
        .filter(Boolean);
    }
  }

  // ===========================================================================
  // 5. BLOCK-MODELL
  // ===========================================================================

  /** Enum-artige Konstante der erkannten Blocktypen. */
  const BlockType = Object.freeze({
    HEADING: 'heading',
    PARAGRAPH: 'paragraph',
    LIST: 'list',
    TABLE: 'table',
    IMAGE: 'image',
    VIDEO: 'video',
    CODE_BLOCK: 'code-block',
    INLINE_CODE: 'inline-code',
    BLOCKQUOTE: 'blockquote',
    DETAILS: 'details',
    MATH: 'math',
    SVG: 'svg',
    CANVAS: 'canvas',
    FOOTNOTE: 'footnote',
    CITATION: 'citation',
    GENERIC_TEXT: 'text',
  });

  /**
   * Repräsentiert einen einzelnen erkannten Inhaltsblock. Enthält alle vom
   * Lastenheft geforderten Felder plus Scroll-Anker-Erzeugung on demand
   * (Position/Höhe werden lazy via getBoundingClientRect ermittelt und
   * gecacht, um Reflows zu minimieren).
   */
  class Block {
    constructor({ element, type, text, words, ranges, speedFactor, highlightable = false, isPlaceholder = false }) {
      this.id = Utils.uuid();
      this.element = element;
      this.type = type;
      this.speedFactor = speedFactor;
      this.visible = true;
      this.highlightable = highlightable;
      this.isPlaceholder = isPlaceholder;
      this._cachedRect = null;

      if (highlightable && words) {
        // Tokens und Ranges stammen aus DEMSELBEN Utils.extractWords()-Durchlauf
        // (gleicher Index = gleiches Wort) und koennen dadurch nie mehr auseinander-
        // driften - vorher zwei separat gepflegte TreeWalker-Implementierungen,
        // die bei sehr verschachteltem/komplexem Markup (viele Custom-Elemente,
        // Icons, leere Anker etc.) lautlos divergieren und Highlighting/Zebra
        // per Sicherheitsnetz stumm abschalten konnten.
        this.tokens = [];
        this._wordRanges = [];
        words.forEach((w, i) => {
          const tok = Tokenizer.tokenize(w);
          if (tok) {
            this.tokens.push(tok);
            this._wordRanges.push(ranges[i]);
          }
        });
        this.charCount = words.join(' ').length;
      } else {
        this.tokens = Tokenizer.tokenizeText(text);
        this.charCount = text.length;
        this._wordRanges = [];
      }
      this.wordCount = this.tokens.length;
    }

    /**
     * Liefert je Token eine DOM-Range, die exakt das entsprechende Wort im
     * Original-Text abdeckt (fuer die Live-Hervorhebung im Quelltext/Zebrastreifen).
     * Nur fuer Bloecke moeglich, deren Anzeigetext 1:1 aus dem Element stammt
     * (kein synthetischer/ueberschriebener Text wie bei Bild-Alt-Texten) - siehe Konstruktor.
     */
    getWordRanges() {
      return this._wordRanges;
    }

    /** Liefert eine gecachte BoundingRect, invalidiert via invalidateLayout(). */
    getRect() {
      if (!this._cachedRect) {
        this._cachedRect = this.element.getBoundingClientRect();
      }
      return this._cachedRect;
    }

    invalidateLayout() {
      this._cachedRect = null;
    }

    /** Scrollanker: Element selbst dient als Referenz für die ScrollEngine. */
    getScrollAnchor() {
      return this.element;
    }
  }

  // ===========================================================================
  // 6. DOM PARSER
  // ===========================================================================

  /**
   * Analysiert rekursiv einen Container und erzeugt eine flache Liste von
   * Block-Instanzen. Erkennt die im Lastenheft geforderten Elementtypen und
   * ignoriert dabei script/style/UI-eigene Elemente sowie unsichtbare Knoten.
   *
   * Performance: Es wird ein einziger TreeWalker-Durchlauf verwendet;
   * IntersectionObserver aktualisiert lazy die Sichtbarkeits-Flags der Blöcke,
   * ohne bei jedem Scroll-Event teure layout-reads zu erzwingen.
   */
  class DomParser {
    static SKIP_TAGS = new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'svg' /* svg separat behandelt */,
    ]);

    static BLOCK_TAG_MAP = {
      H1: BlockType.HEADING, H2: BlockType.HEADING, H3: BlockType.HEADING,
      H4: BlockType.HEADING, H5: BlockType.HEADING, H6: BlockType.HEADING,
      P: BlockType.PARAGRAPH,
      UL: BlockType.LIST, OL: BlockType.LIST,
      TABLE: BlockType.TABLE,
      IMG: BlockType.IMAGE, PICTURE: BlockType.IMAGE, FIGURE: BlockType.IMAGE,
      VIDEO: BlockType.VIDEO,
      PRE: BlockType.CODE_BLOCK,
      CODE: BlockType.INLINE_CODE,
      BLOCKQUOTE: BlockType.BLOCKQUOTE,
      DETAILS: BlockType.DETAILS,
      SVG: BlockType.SVG,
      CANVAS: BlockType.CANVAS,
      CITE: BlockType.CITATION,
    };

    /** CSS-Selektor aller bekannten Block-Tags, zur Prüfung ob ein generischer
     * Container (z. B. <div>) noch "echte" Block-Nachfahren enthält. */
    static KNOWN_BLOCK_SELECTOR = Object.keys(DomParser.BLOCK_TAG_MAP).join(',');

    constructor(eventBus, settings) {
      this.bus = eventBus;
      this.settings = settings;
      this._intersectionObserver = null;
    }

    /**
     * Hauptmethode: Container -> Array<Block>.
     * Reiner Lesevorgang; DOM wird nicht verändert.
     */
    parse(container) {
      const blocks = [];
      const factors = this.settings.get('speedFactors');
      const visited = new WeakSet();

      const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (node) => {
          if (DomParser.SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
          if (node.closest?.(`.${NS}-ui`)) return NodeFilter.FILTER_REJECT;
          // Von der Seite selbst ausgeblendete Bereiche (display:none, visibility:hidden,
          // zusammengeklappte Tabs/Akkordeons, opacity:0, 0x0-Layout …) komplett überspringen –
          // inkl. Nachfahren, sonst würde unsichtbarer Text mitgelesen/mitgezählt.
          // <img> ist ausgenommen, da Lazy-Load-Bilder vor dem Laden oft (noch) unsichtbar sind.
          if (node.tagName !== 'IMG' && !Utils.isElementVisible(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      let node = container;
      // Container selbst zuerst prüfen, danach TreeWalker für Nachfahren.
      const candidates = [];
      if (!DomParser.SKIP_TAGS.has(container.tagName)) candidates.push(container);
      while ((node = walker.nextNode())) candidates.push(node);

      for (const candidate of candidates) {
        if (visited.has(candidate)) continue;
        const block = this._classify(candidate, factors);
        if (!block) continue;
        // Verhindert doppelte Erfassung von Nachfahren bereits klassifizierter Blöcke
        // (z. B. <p> innerhalb <blockquote>, <li> innerhalb <ul>).
        candidate.querySelectorAll('*').forEach((child) => visited.add(child));
        blocks.push(block);
      }

      this._setupIntersectionObserver(blocks);
      this.bus.emit('parser:complete', { blockCount: blocks.length });
      return blocks;
    }

    _classify(element, factors) {
      // Footnote-Erkennung: typische Marker/Attribute (role, id-Muster, .footnote-Klassen).
      if (this._isFootnote(element)) {
        if (this.settings.get('skipCitations')) return null;
        return this._makeBlock(element, BlockType.FOOTNOTE, factors.footnote);
      }

      // MathJax / KaTeX
      if (element.classList?.contains('katex') || element.tagName === 'MJX-CONTAINER' ||
          element.classList?.contains('MathJax')) {
        return this._makeBlock(element, BlockType.MATH, factors.formula, Utils.visibleTextContent(element) || element.getAttribute('aria-label') || 'Formel');
      }

      const mapped = DomParser.BLOCK_TAG_MAP[element.tagName];
      if (!mapped) return this._classifyGenericFallback(element);

      switch (mapped) {
        case BlockType.IMAGE: {
          const figcaption = element.querySelector?.('figcaption');
          const captionText = figcaption ? Utils.visibleTextContent(figcaption) : '';
          const skipCaptions = this.settings.get('skipImageCaptions');
          const altOrCaption = element.getAttribute('alt') || captionText;
          const overrideText = skipCaptions ? '[Bild]' : (altOrCaption || 'Bild');
          // Platzhalter (kein echter Alt-/Caption-Text bzw. bewusst übersprungen) bekommt
          // eine erzwungene Mindestpause; echte Beschriftungen werden normal vorgelesen.
          return this._makeBlock(element, BlockType.IMAGE, factors.image, overrideText, skipCaptions || !altOrCaption);
        }
        case BlockType.VIDEO:
          return this._makeBlock(element, BlockType.VIDEO, factors.image, 'Video', true);
        case BlockType.CANVAS:
          return this._makeBlock(element, BlockType.CANVAS, factors.image, 'Canvas-Grafik', true);
        case BlockType.SVG: {
          const label = element.getAttribute('aria-label') || element.querySelector?.('title')?.textContent;
          return this._makeBlock(element, BlockType.SVG, factors.image, label || 'Grafik', !label);
        }
        case BlockType.TABLE: {
          // Bei aktiviertem Überspringen wird statt des vollen Zellinhalts nur ein
          // kurzer Platzhalter angezeigt – mit erzwungener Mindestpause (statt nur dem
          // Tabellen-Geschwindigkeitsfaktor), damit klar spürbar kurz pausiert wird.
          const skip = this.settings.get('skipTables');
          return this._makeBlock(element, BlockType.TABLE, factors.table, skip ? '[Tabelle]' : undefined, skip);
        }
        case BlockType.CODE_BLOCK:
          return this._makeBlock(element, BlockType.CODE_BLOCK, factors.code);
        case BlockType.INLINE_CODE:
          // Inline-Code nur eigenständig behandeln, wenn nicht in einem <pre> verschachtelt.
          if (element.closest('pre')) return null;
          return this._makeBlock(element, BlockType.INLINE_CODE, factors.code);
        case BlockType.BLOCKQUOTE:
          return this._makeBlock(element, BlockType.BLOCKQUOTE, factors.blockquote);
        case BlockType.CITATION:
          if (this.settings.get('skipCitations')) return null;
          return this._makeBlock(element, BlockType.CITATION, factors.footnote);
        case BlockType.DETAILS: {
          const summary = element.querySelector('summary');
          const summaryText = summary ? Utils.visibleTextContent(summary) : '';
          const bodyText = Array.from(element.childNodes)
            .filter((n) => n.nodeName !== 'SUMMARY')
            .map((n) => (n.nodeType === Node.ELEMENT_NODE ? Utils.visibleTextContent(n) : n.textContent))
            .join(' ');
          return this._makeBlock(element, BlockType.DETAILS, factors.list, `${summaryText}. ${bodyText}`);
        }
        case BlockType.LIST:
          return this._makeBlock(element, BlockType.LIST, factors.list);
        case BlockType.HEADING:
          return this._makeBlock(element, BlockType.HEADING, factors.heading);
        case BlockType.PARAGRAPH:
        default: {
          const text = element.textContent?.trim();
          if (!text || text.length < 1) return null;
          return this._makeBlock(element, mapped, factors.default);
        }
      }
    }

    /**
     * Fallback für Elemente ohne bekannte Semantik (z. B. <div class="stamp">Text</div>
     * statt <p>Text</p>, wie es manche CMS/Fachportale ausgeben). Ohne diesen Fallback
     * würde solcher "loser" Text nie erfasst, weil der TreeWalker nur Elemente besucht
     * und reiner Text nur über textContent eines KLASSIFIZIERTEN Vorfahren erfasst wird.
     * Greift nur, wenn der Container selbst keine weiteren block-fähigen Nachfahren
     * enthält – sonst würde deren Inhalt doppelt erfasst (die werden separat besucht).
     */
    _classifyGenericFallback(element) {
      if (DomParser.SKIP_TAGS.has(element.tagName)) return null;
      if (element.querySelector?.(DomParser.KNOWN_BLOCK_SELECTOR)) return null;
      return this._makeBlock(element, BlockType.GENERIC_TEXT, this.settings.get('speedFactors').default);
    }

    _isFootnote(element) {
      const id = (element.id || '').toLowerCase();
      const cls = (element.className && typeof element.className === 'string' ? element.className : '').toLowerCase();
      return /footnote|fn-|fnref/.test(id) || /footnote/.test(cls) || element.getAttribute('role') === 'doc-footnote';
    }

    _makeBlock(element, type, speedFactor, overrideText, isPlaceholder = false) {
      // Nur wenn der Anzeigetext 1:1 dem Element-Textinhalt entspricht (kein
      // überschriebener/synthetischer Text) kann später im Quelltext hervorgehoben werden.
      // In diesem Fall Wörter+Ranges aus DEMSELBEN Durchlauf beziehen (Utils.extractWords),
      // statt Text separat zu extrahieren und Ranges später nochmal eigenständig zu berechnen.
      if (overrideText === undefined) {
        const { words, ranges } = Utils.extractWords(element);
        if (words.length === 0) {
          if (type === BlockType.IMAGE || type === BlockType.VIDEO || type === BlockType.CANVAS || type === BlockType.SVG) {
            return new Block({ element, type, text: '[Bild]', speedFactor, highlightable: false, isPlaceholder: true });
          }
          return null;
        }
        return new Block({ element, type, words, ranges, speedFactor, highlightable: true, isPlaceholder });
      }

      if (!overrideText || !overrideText.trim()) {
        if (type === BlockType.IMAGE || type === BlockType.VIDEO || type === BlockType.CANVAS || type === BlockType.SVG) {
          return new Block({ element, type, text: '[Bild]', speedFactor, highlightable: false, isPlaceholder: true });
        }
        return null;
      }
      return new Block({ element, type, text: overrideText, speedFactor, highlightable: false, isPlaceholder });
    }

    /** Aktualisiert Block.visible via IntersectionObserver statt teurer Scroll-Handler. */
    _setupIntersectionObserver(blocks) {
      this._intersectionObserver?.disconnect();
      this._intersectionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const block = blocks.find((b) => b.element === entry.target);
          if (block) block.visible = entry.isIntersecting;
        }
      }, { threshold: 0 });
      for (const block of blocks) this._intersectionObserver.observe(block.element);
    }

    dispose() {
      this._intersectionObserver?.disconnect();
    }
  }

  // ===========================================================================
  // 7. SPEED MODEL (adaptive Geschwindigkeit / Pausenlogik)
  // ===========================================================================

  /**
   * Berechnet für jedes Token die Anzeigedauer in Millisekunden, basierend auf
   * Basis-WPM, Blocktyp-Geschwindigkeitsfaktor und Satzzeichen-/Sonderregeln.
   *
   * EXTENSION POINT: Eine KI-gestützte Variante könnte dieselbe Schnittstelle
   * `computeDelay(token, block, baseWpm)` implementieren (z. B. basierend auf
   * Wortkomplexität/Lesbarkeitsscores) und per Dependency Injection in die
   * ReaderEngine gereicht werden.
   */
  class SpeedModel {
    constructor(settings) {
      this.settings = settings;
    }

    /** Basiszeit pro Wort in ms bei gegebenem WPM. */
    _baseMsPerWord(wpm) {
      return 60000 / Math.max(1, wpm);
    }

    computeDelay(token, block, wpm) {
      const s = this.settings;
      let ms = this._baseMsPerWord(wpm);

      if (s.get('adaptiveSpeed') && block) {
        ms /= (block.speedFactor || 1);
      }

      if (s.get('punctuationPauses') && token.punctuation) {
        const pauses = s.get('punctuationDelayMs');
        ms += pauses[token.punctuation] || 0;
      }

      // Zahlen/lange Wörter länger anzeigen gehört inhaltlich zur adaptiven
      // Geschwindigkeit (siehe Lastenheft) – daher an denselben Schalter gekoppelt.
      if (s.get('adaptiveSpeed') && token.isNumber) {
        ms += s.get('numberExtraMs');
      }

      const longThreshold = s.get('longWordThreshold');
      if (s.get('adaptiveSpeed') && token.letterCount >= longThreshold) {
        const extra = s.get('longWordExtraMs');
        const overflow = token.letterCount - longThreshold;
        ms += extra + overflow * 9;
      }

      // Platzhalter (übersprungene Tabellen/Bilder ohne Beschriftung) sollen lange
      // genug stehen bleiben, um bewusst kurz zu pausieren, unabhängig vom Geschwindigkeitsfaktor.
      if (block?.isPlaceholder) {
        ms = Math.max(ms, s.get('placeholderPauseMs'));
      }

      return Utils.clamp(ms, 40, 5000);
    }
  }

  /**
   * Erzeugt einen sehr kurzen, dezenten Klickton bei jedem neuen Wort – rein
   * synthetisch via Web Audio API (kein Audio-Asset nötig). Der AudioContext
   * wird lazy beim ersten Ton erzeugt (Browser verlangen eine Nutzergeste,
   * die durch den vorherigen Start-Klick bereits vorliegt).
   */
  class SoundEngine {
    /** Klangfarben-Presets: Oszillatortyp, Grundfrequenz, Ausklingdauer, Lautstärke. */
    static VARIANTS = {
      click: { type: 'square', freq: 1100, duration: 0.03, gain: 0.05 },
      soft: { type: 'sine', freq: 600, duration: 0.05, gain: 0.06 },
      blip: { type: 'triangle', freq: 1800, duration: 0.02, gain: 0.05 },
      wood: { type: 'square', freq: 220, duration: 0.02, gain: 0.07 },
      bell: { type: 'sine', freq: 1400, duration: 0.12, gain: 0.04 },
    };

    /**
     * Easter-Egg „Klassik": jedes Wort spielt die nächste Note einer gemeinfreien
     * klassischen Melodie. 20 Werke (alle > 100 Jahre alt, damit gemeinfrei) als
     * Notennamen-Sequenz; sie werden in zufälliger Reihenfolge nacheinander
     * vollständig durchgespielt (ganze Hauptthemen, nicht nur Anfangsmotive).
     */
    static MELODIES = {
      'Für Elise – Beethoven': [
        'E5','D#5','E5','D#5','E5','B4','D5','C5','A4','C4','E4','A4','B4','E4','G#4','B4','C5',
        'E5','D#5','E5','D#5','E5','B4','D5','C5','A4','C4','E4','A4','B4','E4','C5','B4','A4',
        'B4','C5','D5','E5','G4','F5','E5','D5','F4','E5','D5','C5','E4','D5','C5','B4',
        'E4','E5','D#5','E5','D#5','E5','B4','D5','C5','A4','C4','E4','A4','B4','E4','G#4','B4','C5',
        'E5','D#5','E5','D#5','E5','B4','D5','C5','A4','C4','E4','A4','B4','E4','C5','B4','A4',
      ],
      'Ode an die Freude – Beethoven': [
        'E4','E4','F4','G4','G4','F4','E4','D4','C4','C4','D4','E4','E4','D4','D4',
        'E4','E4','F4','G4','G4','F4','E4','D4','C4','C4','D4','E4','D4','C4','C4',
        'D4','D4','E4','C4','D4','E4','F4','E4','C4','D4','E4','F4','E4','D4','C4','D4','G3',
        'E4','E4','F4','G4','G4','F4','E4','D4','C4','C4','D4','E4','D4','C4','C4',
      ],
      'Symphonie Nr. 5 – Beethoven': [
        'G4','G4','G4','D#4','F4','F4','F4','D4',
        'G4','G4','G4','D#4','F4','F4','F4','D4',
        'G4','G4','G4','C5','A#4','A#4','A#4','G4','A#4','A#4','A#4','G4','D5','D5','D5','G4',
        'G4','G4','G4','D#4','F4','F4','F4','D4',
      ],
      'Eine kleine Nachtmusik – Mozart': [
        'G4','D4','G4','D4','G4','D4','G5','D5','G5','D5','G5','D5',
        'G5','A5','B5','C6','D6','D6','D6','B5','C6','D6','B5','G5',
        'C6','B5','A5','B5','A5','G5','F#5','G5','A5','B5','D5','C5','B4','A4',
        'D5','G4','B4','D5','G5','F#5','G5','A5','D5','C5','B4','A4','G4',
      ],
      'Menuett in G – Petzold/Bach': [
        'D5','G4','A4','B4','C5','D5','G4','G4','E5','C5','D5','E5','F#5','G5','G4','G4',
        'C5','D5','C5','B4','A4','B4','C5','B4','A4','G4','F#4','G4','A4','B4','G4','A4',
        'D5','G4','A4','B4','C5','D5','G4','G4','E5','C5','D5','E5','F#5','G5','G4','G4',
        'C5','D5','C5','B4','A4','B4','C5','A4','B4','C5','D5','A4','B4','G4','A4','G4',
      ],
      'Türkischer Marsch – Mozart': [
        'B4','A4','G#4','A4','C5','D5','C5','B4','C5','E5','F5','E5','D#5','E5','B5','A5',
        'G#5','A5','B5','A5','G#5','A5','C6','B5','A5','G5','A5','C6','B5','A5','G5','A5',
        'B5','A5','G#5','A5','C6','B5','A5','G5','A5','B4','A4','G#4','A4','C5','D5','C5','B4',
      ],
      'Ave Maria – Schubert': [
        'F4','F4','G4','A4','A4','G4','F4','A4','A#4','A4','G4','F4','G4','A4','F4','F4',
        'C5','A#4','A4','G4','F4','E4','F4','G4','F4','A4','C5','F5','E5','D5','C5','A4',
      ],
      'Can-Can – Offenbach': [
        'D5','D5','C5','A#4','A4','G4','A4','A#4','G4','D5','C5','A#4','A4','G4','A4','A#4',
        'A4','G4','F4','G4','A4','A#4','A4','G4','F4','E4','F4','G4','A4','D5','C5','A#4','A4','G4',
      ],
      'An der schönen blauen Donau – Strauss': [
        'D4','G4','B4','B4','A4','B4','D5','D5','C5','B4','A4','G4','B4','A4','G4','F#4',
        'A4','G4','B4','D5','G5','G5','F#5','E5','D5','C5','B4','A4','G4','B4','D5','G5',
      ],
      'Walkürenritt – Wagner': [
        'B3','E4','G4','B3','E4','G4','B4','G4','E4','B3','E4','G4','B4','D5','B4','G4',
        'E4','G4','B4','E5','D5','B4','G4','B4','E5','B4','G4','E4','B3','E4','G4','B4',
      ],
      'Toccata und Fuge d-Moll – Bach': [
        'A5','G5','A5','G5','F5','E5','D5','C#5','D5','A4','A4','A4','G4','F4','E4','D4',
        'C#4','D4','E4','F4','G4','A4','A4','G4','F4','E4','D4','C#4','D4','A4','D5','A4',
      ],
      'In der Halle des Bergkönigs – Grieg': [
        'B3','C#4','D4','E4','F#4','D4','F#4','F4','D4','F4','E4','C#4','E4','B3','C#4','D4',
        'E4','F#4','D4','F#4','A4','G#4','A4','F#4','A4','B4','C#5','D5','E5','F#5','D5','F#5',
      ],
      'Morgenstimmung – Grieg': [
        'G5','E5','D5','C5','D5','E5','G5','E5','D5','C5','D5','E5','G5','A5','E5','A5',
        'G5','E5','D5','C5','D5','E5','G5','E5','A5','G5','E5','D5','E5','G5','A5','B5',
      ],
      'Kanon in D-Dur – Pachelbel': [
        'F#5','E5','D5','C#5','B4','A4','B4','C#5','D5','C#5','B4','A4','G4','F#4','G4','E4',
        'D4','F#4','A4','G4','F#4','D4','F#4','E4','D4','B4','D5','A4','B4','C#5','D5','F#4',
      ],
      'Ouvertüre Wilhelm Tell – Rossini': [
        'E4','E4','E4','E4','E4','E4','E4','G4','C5','A4','G4','E4','G4','E4','C4','E4',
        'E4','E4','E4','E4','E4','E4','E4','G4','C5','A4','G4','E4','G4','C5','C5','G4',
      ],
      'Habanera (Carmen) – Bizet': [
        'D5','C#5','C5','B4','A#4','A4','G#4','G4','F#4','F4','E4','F4','F#4','G4','G#4','A4',
        'A#4','B4','C5','C#5','D5','A4','A4','D5','C#5','C5','B4','A#4','A4','G#4','G4','F#4',
      ],
      'Frühling (Vier Jahreszeiten) – Vivaldi': [
        'E5','E5','E5','B4','B4','E5','E5','E5','B4','B4','E5','F#5','E5','D#5','E5','B4',
        'G#5','G#5','A5','F#5','F#5','G#5','E5','E5','E5','B4','B4','E5','F#5','G#5','A5','B5',
      ],
      'Greensleeves – traditionell': [
        'A4','C5','D5','E5','F5','E5','D5','B4','G4','A4','B4','C5','A4','A4','G#4','A4',
        'B4','G#4','E4','A4','C5','D5','E5','F5','E5','D5','B4','G4','A4','B4','C5','B4','A4','G#4','A4',
      ],
      'Wiegenlied – Brahms': [
        'E5','E5','G5','E5','E5','G5','E5','G5','C6','B5','A5','A5','G5','D5','E5','F5',
        'D5','D5','E5','F5','D5','F5','B5','A5','G5','B5','C6','C6','G5','E5','G5','C6',
      ],
      'Tanz der Zuckerfee – Tschaikowski': [
        'E5','B4','G#4','B4','E5','B4','G#4','B4','E5','G#5','G5','F#5','E5','B4','G#4','B4',
        'E5','B4','G#4','B4','A5','G#5','F#5','E5','D#5','E5','F#5','E5','B4','G#4','B4','E5',
      ],
    };

    /** Wikipedia-Artikel (deutsch) zum jeweiligen Werk, verlinkt in der Infoleiste. */
    static WIKI = {
      'Für Elise – Beethoven': 'https://de.wikipedia.org/wiki/F%C3%BCr_Elise',
      'Ode an die Freude – Beethoven': 'https://de.wikipedia.org/wiki/Ode_an_die_Freude',
      'Symphonie Nr. 5 – Beethoven': 'https://de.wikipedia.org/wiki/5._Sinfonie_(Beethoven)',
      'Eine kleine Nachtmusik – Mozart': 'https://de.wikipedia.org/wiki/Eine_kleine_Nachtmusik',
      'Menuett in G – Petzold/Bach': 'https://de.wikipedia.org/wiki/Menuett_G-Dur_(BWV_Anh._114_und_115)',
      'Türkischer Marsch – Mozart': 'https://de.wikipedia.org/wiki/Klaviersonate_Nr._11_(Mozart)',
      'Ave Maria – Schubert': 'https://de.wikipedia.org/wiki/Ave_Maria_(Schubert)',
      'Can-Can – Offenbach': 'https://de.wikipedia.org/wiki/Orpheus_in_der_Unterwelt',
      'An der schönen blauen Donau – Strauss': 'https://de.wikipedia.org/wiki/An_der_sch%C3%B6nen_blauen_Donau',
      'Walkürenritt – Wagner': 'https://de.wikipedia.org/wiki/Walk%C3%BCrenritt',
      'Toccata und Fuge d-Moll – Bach': 'https://de.wikipedia.org/wiki/Toccata_und_Fuge_d-Moll_BWV_565',
      'In der Halle des Bergkönigs – Grieg': 'https://de.wikipedia.org/wiki/Peer_Gynt_(Grieg)',
      'Morgenstimmung – Grieg': 'https://de.wikipedia.org/wiki/Peer_Gynt_(Grieg)',
      'Kanon in D-Dur – Pachelbel': 'https://de.wikipedia.org/wiki/Kanon_und_Gigue_in_D-Dur',
      'Ouvertüre Wilhelm Tell – Rossini': 'https://de.wikipedia.org/wiki/Wilhelm_Tell_(Rossini)',
      'Habanera (Carmen) – Bizet': 'https://de.wikipedia.org/wiki/Carmen',
      'Frühling (Vier Jahreszeiten) – Vivaldi': 'https://de.wikipedia.org/wiki/Die_vier_Jahreszeiten_(Vivaldi)',
      'Greensleeves – traditionell': 'https://de.wikipedia.org/wiki/Greensleeves',
      'Wiegenlied – Brahms': 'https://de.wikipedia.org/wiki/Wiegenlied_(Brahms)',
      'Tanz der Zuckerfee – Tschaikowski': 'https://de.wikipedia.org/wiki/Der_Nussknacker',
    };

    constructor(settings) {
      this.settings = settings;
      this._ctx = null;
      this._melodyQueue = [];   // gemischte Reihenfolge der Werke
      this._melody = null;      // aktuelle Notenliste
      this._melodyName = '';    // Titel des aktuellen Werks
      this._noteIndex = 0;
      this.onMelodyChange = null; // Callback(name), wenn ein neues Werk beginnt
    }

    /** Titel des gerade gespielten Klassik-Werks (leer, wenn nicht aktiv). */
    get currentMelodyName() {
      return this._melodyName;
    }

    _ensureContext() {
      if (!this._ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        this._ctx = new AudioCtx();
      }
      if (this._ctx.state === 'suspended') this._ctx.resume();
      return this._ctx;
    }

    /**
     * Wärmt die Audio-Ausgabe innerhalb einer Nutzergeste (Session-Start/Play) vor:
     * erzeugt/entsperrt den AudioContext (resume() ist asynchron) und spielt einen
     * unhörbaren Ton, damit die erste echte Note ohne Anlauf-Verzögerung erklingt.
     */
    warmUp() {
      const ctx = this._ensureContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.00001; // praktisch stumm, nur zum Aufwecken der Ausgabe
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.02);
    }

    /** Notenname (z. B. „D#5") → Frequenz in Hz (gleichstufige Stimmung, A4=440). */
    static noteToFreq(note) {
      const map = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
      const m = /^([A-G]#?)(\d)$/.exec(note);
      if (!m) return 440;
      const midi = (Number(m[2]) + 1) * 12 + map[m[1]];
      return 440 * Math.pow(2, (midi - 69) / 12);
    }

    /** Liefert die nächste Note der Klassik-Sequenz; mischt am Ende neu durch. */
    _nextClassicalFreq() {
      if (!this._melody || this._noteIndex >= this._melody.length) {
        if (this._melodyQueue.length === 0) {
          // Alle Werke einmal, dann in neuer Zufallsreihenfolge wiederholen.
          this._melodyQueue = Object.keys(SoundEngine.MELODIES).sort(() => Math.random() - 0.5);
        }
        this._melodyName = this._melodyQueue.shift();
        this._melody = SoundEngine.MELODIES[this._melodyName];
        this._noteIndex = 0;
        this.onMelodyChange?.(this._melodyName);
      }
      return SoundEngine.noteToFreq(this._melody[this._noteIndex++]);
    }

    playTick() {
      if (!this.settings.get('clickSoundEnabled')) return;
      const ctx = this._ensureContext();
      if (!ctx) return;

      if (this.settings.get('clickSoundVariant') === 'klassik') {
        // Klavierähnlicher Ton mit sanftem Ausklang je Note.
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = this._nextClassicalFreq();
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
        return;
      }

      const variant = SoundEngine.VARIANTS[this.settings.get('clickSoundVariant')] || SoundEngine.VARIANTS.click;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = variant.type;
      osc.frequency.value = variant.freq;
      gain.gain.setValueAtTime(variant.gain, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + variant.duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + variant.duration + 0.01);
    }

    dispose() {
      this._ctx?.close();
      this._ctx = null;
    }
  }

  /**
   * Reiner Vorlesemodus über die Web Speech API. Im Gegensatz zum früheren
   * (verworfenen) Wort-für-Wort-Ansatz wird hier der GESAMTE Text am Stück an die
   * Sprachausgabe übergeben (in wenige große, satzweise geschnittene Utterances),
   * damit die Ausgabe flüssig statt abgehackt klingt. Das `boundary`-Event liefert
   * die Zeichenposition je gesprochenem Wort – daraus wird der zugehörige Token
   * bestimmt und per Callback nach außen gemeldet (zum Markieren im Text und in
   * der Anzeige). Das WPM-Tempo wird ignoriert; es gilt allein `readAloudRate`.
   */
  class ReadAloudEngine {
    // Web-Speech-Engines kappen sehr lange Utterances; daher in handliche Stücke
    // schneiden – aber pro Stück viele Wörter (nicht pro Wort!), damit es flüssig bleibt.
    static MAX_CHUNK_CHARS = 240;

    constructor(bus, settings) {
      this.bus = bus;
      this.settings = settings;
      this._supported = 'speechSynthesis' in window;
      this._stream = [];
      this._index = 0;
      this._state = 'idle';        // 'idle' | 'playing' | 'paused' | 'finished'
      this.onIndex = null;         // Callback(globalTokenIndex)
      this.onStateChange = null;   // Callback(state)
      this._voices = [];
      if (this._supported) {
        this._loadVoices();
        window.speechSynthesis.addEventListener?.('voiceschanged', () => this._loadVoices());
      }
    }

    isSupported() { return this._supported; }
    get state() { return this._state; }
    get index() { return this._index; }

    _loadVoices() { this._voices = window.speechSynthesis.getVoices(); }
    getVoices() { return this._voices; }

    /** Sprache des Dokuments (2-Buchstaben-Code), Basis für Sortierung/Auto-Wahl. */
    static docLang() {
      return (document.documentElement.lang || navigator.language || 'de').slice(0, 2).toLowerCase();
    }

    /** macOS/Chrome liefern für jede Sprache eine niedrig aufgelöste „compact"-Stimme. */
    static isCompact(v) {
      return /compact/i.test(v.voiceURI || '');
    }

    /** Kennzeichnet eine Stimme als „Premium" (hochwertige, natürlichere Synthese). */
    static isPremium(v) {
      if (ReadAloudEngine.isCompact(v)) return false;
      const s = v.name + ' ' + (v.voiceURI || '');
      // Explizite Premium-Marker ODER Netz-Stimmen ODER nicht-„compact" Systemstimmen.
      return /premium|enhanced|neural|siri|natural|studio|wavenet|journey/i.test(s) ||
             !v.localService ||
             /(^|[.\/])(voice|siri)([.\/]|$)/i.test(v.voiceURI || '');
    }

    /** Qualitätsrang: Premium (2) > normal (1) > compact (0) – für Sortierung. */
    static quality(v) {
      if (ReadAloudEngine.isPremium(v)) return 2;
      if (ReadAloudEngine.isCompact(v)) return 0;
      return 1;
    }

    /**
     * Wählt die Stimme: explizit gewählte, sonst automatisch die beste – nach
     * Qualität (Premium zuerst) und passend zur Dokumentsprache.
     */
    _resolveVoice() {
      const chosen = this.settings.get('readAloudVoiceURI');
      if (chosen) {
        const v = this._voices.find((x) => x.voiceURI === chosen);
        if (v) return v;
      }
      if (this._voices.length === 0) return null;
      const docLang = ReadAloudEngine.docLang();
      const sameLang = (v) => (v.lang || '').slice(0, 2).toLowerCase() === docLang;
      const byQuality = (a, b) => ReadAloudEngine.quality(b) - ReadAloudEngine.quality(a);
      const same = this._voices.filter(sameLang).sort(byQuality);
      const rest = this._voices.filter((v) => !sameLang(v)).sort(byQuality);
      return same[0] || rest[0] || this._voices[0];
    }

    load(stream) {
      this._stream = stream || [];
      this._index = 0;
    }

    _setState(s) {
      this._state = s;
      this.onStateChange?.(s);
    }

    /**
     * Baut ab `fromIndex` aufeinanderfolgende Utterances: Tokens werden zu Stücken
     * gepackt (Satzende bevorzugt als Schnittstelle), pro Stück eine Range-Tabelle
     * (relativer Zeichen-Offset → globaler Token-Index) für das boundary-Mapping.
     */
    _buildChunks(fromIndex) {
      const chunks = [];
      let i = fromIndex;
      while (i < this._stream.length) {
        const starts = [];       // relativer Zeichen-Offset je Token
        const indices = [];      // globaler Token-Index
        let text = '';
        while (i < this._stream.length) {
          const tok = this._stream[i].token.text;
          const piece = text.length ? ' ' + tok : tok;
          if (text.length && text.length + piece.length > ReadAloudEngine.MAX_CHUNK_CHARS) break;
          starts.push(text.length ? text.length + 1 : 0);
          indices.push(i);
          text += piece;
          i++;
          // An Satzende früh umbrechen (natürliche Sprechpause, verhindert Überlänge).
          if (/[.!?…:]$/.test(tok) && text.length > ReadAloudEngine.MAX_CHUNK_CHARS * 0.5) break;
        }
        chunks.push({ text, starts, indices });
      }
      return chunks;
    }

    play(fromIndex = this._index) {
      if (!this._supported || this._stream.length === 0) return;
      window.speechSynthesis.cancel();
      this._index = Utils.clamp(fromIndex, 0, this._stream.length - 1);
      const chunks = this._buildChunks(this._index);
      if (chunks.length === 0) return;
      const rate = Utils.clamp(this.settings.get('readAloudRate') || 1, 0.1, 10);
      const voice = this._resolveVoice();

      chunks.forEach((chunk, ci) => {
        const u = new SpeechSynthesisUtterance(chunk.text);
        u.rate = rate;
        if (voice) { u.voice = voice; u.lang = voice.lang; }
        else u.lang = document.documentElement.lang || 'de-DE';
        u.onboundary = (e) => {
          if (e.name && e.name !== 'word') return;
          // Größten Token-Start <= charIndex finden.
          let lo = 0, hi = chunk.starts.length - 1, found = 0;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (chunk.starts[mid] <= e.charIndex) { found = mid; lo = mid + 1; } else hi = mid - 1;
          }
          this._index = chunk.indices[found];
          this.onIndex?.(this._index);
        };
        if (ci === chunks.length - 1) {
          u.onend = () => {
            if (this._state === 'playing') { this._setState('finished'); }
          };
        }
        window.speechSynthesis.speak(u);
      });
      this._setState('playing');
    }

    pause() {
      if (!this._supported || this._state !== 'playing') return;
      // Robuster als speechSynthesis.pause(): abbrechen und Position merken,
      // Fortsetzen startet neu ab dem aktuellen Token.
      window.speechSynthesis.cancel();
      this._setState('paused');
    }

    toggle() {
      if (this._state === 'playing') this.pause();
      else this.play(this._index);
    }

    stop() {
      if (this._supported) window.speechSynthesis.cancel();
      this._setState('idle');
    }
  }

  // ===========================================================================
  // 8. ORP (Optimal Recognition Point)
  // ===========================================================================

  /**
   * Statische Berechnung des optimal Recognition Point: jene Buchstaben-
   * Position in einem Wort, auf die das Auge fokussieren sollte, um das
   * Wort am schnellsten zu erfassen. Faustregel (angelehnt an bekannte
   * RSVP-Reader): ~35 % der Wortlänge, mit Sonderfällen für sehr kurze Wörter.
   */
  class ORP {
    static calculateIndex(word) {
      const len = word.length;
      if (len <= 1) return 0;
      if (len <= 4) return 1;
      if (len <= 9) return 2;
      if (len <= 13) return 3;
      return Math.min(len - 1, 4);
    }

    /** Zerlegt ein Wort in {before, focus, after} für die Anzeige mit Referenzlinie. */
    static split(word) {
      const idx = ORP.calculateIndex(word);
      return {
        before: word.slice(0, idx),
        focus: word.charAt(idx) || '',
        after: word.slice(idx + 1),
      };
    }
  }

  // ===========================================================================
  // 9. SCROLL ENGINE
  // ===========================================================================

  /**
   * Führt den ursprünglichen Container synchron mit dem Lesefortschritt nach.
   * Bewusst KEINE Verwendung von scrollIntoView() – stattdessen ein
   * requestAnimationFrame-Loop, der linear/eased zwischen aktueller und
   * Ziel-scrollTop-Position interpoliert. Dadurch bleibt volle Kontrolle über
   * Zielposition (konfigurierbares Ratio im Viewport) und Geschwindigkeit.
   */
  class ScrollEngine {
    constructor(settings) {
      this.settings = settings;
      this._scrollParent = null;
      this._targetTop = null;
      this._rafId = null;
      // Zeitbasierte Glättung: Anteil der Restdistanz, der PRO SEKUNDE zurückgelegt
      // wird (nicht pro Frame – dadurch framerate-unabhängig gleichmäßig statt
      // ruckartig bei schwankender FPS). ~0.12 → sanftes Nachziehen.
      this._smoothingPerSecond = 0.12;
      this._lastFrameTs = null;
      this._lastSetScrollTop = null;
      this._userScrollHandler = null;
      this._userScrollTarget = null;
      // Von der fixierten Toolbar verdeckte Randbereiche (px) – das Scroll-Ziel
      // positioniert das aktuelle Wort in den FREIEN Bereich dazwischen, nie
      // hinter die Toolbar.
      this._reservedTop = 0;
      this._reservedBottom = 0;
    }

    setReservedInsets(top, bottom) {
      this._reservedTop = top || 0;
      this._reservedBottom = bottom || 0;
    }

    /** Ermittelt das nächste scrollbare Vorfahrenelement (oder window). */
    static findScrollParent(element) {
      let node = element.parentElement;
      while (node) {
        const style = window.getComputedStyle(node);
        const canScrollY = /(auto|scroll)/.test(style.overflowY);
        if (canScrollY && node.scrollHeight > node.clientHeight + 4) return node;
        node = node.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    }

    attach(container) {
      this._scrollParent = ScrollEngine.findScrollParent(container);
    }

    /**
     * Erkennt manuelles Scrollen durch den Nutzer (Mausrad/Touch/Scrollbar),
     * unterscheidet es von unserer eigenen programmatischen Animation durch
     * Abgleich mit dem zuletzt selbst gesetzten scrollTop. Bei Erkennung wird
     * die eigene Animation sofort abgebrochen (Nutzer-Scroll nicht blockiert)
     * und der Callback aufgerufen (z. B. um den Reader zu pausieren).
     */
    watchUserScroll(onUserScroll) {
      this.unwatchUserScroll();
      if (!this._scrollParent) return;
      const isWindowScroller = this._scrollParent === document.scrollingElement || this._scrollParent === document.documentElement;
      const target = isWindowScroller ? window : this._scrollParent;

      this._userScrollHandler = () => {
        if (this._suppressUntil && performance.now() < this._suppressUntil) return;
        const current = this._getScrollTop();
        if (this._lastSetScrollTop != null && Math.abs(current - this._lastSetScrollTop) < 2) return;
        this.stop();
        onUserScroll();
      };
      target.addEventListener('scroll', this._userScrollHandler, { passive: true });
      this._userScrollTarget = target;
    }

    /**
     * Blendet die Nutzer-Scroll-Erkennung für kurze Zeit aus. Sicherheitsnetz für
     * Browser (v. a. Safari), bei denen preventDefault() auf Pfeiltasten/Space
     * das native Scrollen nicht immer zuverlässig unterdrückt – ein dadurch
     * ausgelöster minimaler Restscroll soll den Reader nicht fälschlich pausieren.
     */
    suppressUserScrollDetection(ms = 250) {
      this._suppressUntil = performance.now() + ms;
    }

    unwatchUserScroll() {
      if (this._userScrollTarget && this._userScrollHandler) {
        this._userScrollTarget.removeEventListener('scroll', this._userScrollHandler);
      }
      this._userScrollHandler = null;
      this._userScrollTarget = null;
    }

    /**
     * Setzt das Scroll-Ziel und startet die Animation. Bevorzugt die exakte
     * vertikale Position des aktuellen WORTES (via übergebener Range) statt nur
     * des Blockanfangs – dadurch wandert das Ziel bei langen Absätzen Zeile für
     * Zeile mit, statt am Blockanfang stehenzubleiben und dann sprunghaft zum
     * nächsten Block zu springen (Hauptursache der ruckartigen Bewegung).
     */
    scrollToElement(element, wordRange) {
      if (!this._scrollParent || this.settings.get('scrollMode') === 'off') return;
      const ratio = this.settings.get('scrollTargetRatio');
      const parentRect = this._getParentViewportRect();

      let refRect = null;
      if (wordRange?.startNode) {
        try {
          const r = document.createRange();
          r.setStart(wordRange.startNode, wordRange.startOffset);
          r.setEnd(wordRange.endNode, wordRange.endOffset);
          const rect = r.getBoundingClientRect();
          if (rect.height > 0 || rect.width > 0) refRect = rect;
        } catch { /* Range ungültig geworden – Fallback auf Element-Rect. */ }
      }
      if (!refRect) refRect = element.getBoundingClientRect();

      const currentScrollTop = this._getScrollTop();
      const refTopRelativeToParent = refRect.top - parentRect.top + currentScrollTop;
      // Wort im freien Bereich (Viewport minus oben/unten von der Toolbar
      // verdeckte Zonen) an der eingestellten Ratio positionieren – so landet
      // das aktuelle Wort nie hinter der Toolbar.
      const freeHeight = Math.max(0, parentRect.height - this._reservedTop - this._reservedBottom);
      const desiredOffsetInViewport = this._reservedTop + freeHeight * ratio;

      this._targetTop = Utils.clamp(
        refTopRelativeToParent - desiredOffsetInViewport,
        0,
        this._getScrollHeight() - parentRect.height
      );

      if (this.settings.get('scrollMode') === 'instant') {
        this._setScrollTop(this._targetTop);
        return;
      }
      this._ensureLoop();
    }

    _getParentViewportRect() {
      if (this._scrollParent === document.scrollingElement || this._scrollParent === document.documentElement) {
        return { top: 0, height: window.innerHeight };
      }
      return this._scrollParent.getBoundingClientRect();
    }

    _getScrollTop() {
      return this._scrollParent === document.scrollingElement || this._scrollParent === document.documentElement
        ? window.scrollY
        : this._scrollParent.scrollTop;
    }

    _getScrollHeight() {
      return this._scrollParent.scrollHeight;
    }

    _setScrollTop(value) {
      this._lastSetScrollTop = value;
      if (this._scrollParent === document.scrollingElement || this._scrollParent === document.documentElement) {
        window.scrollTo({ top: value, behavior: 'auto' });
      } else {
        this._scrollParent.scrollTop = value;
      }
    }

    _ensureLoop() {
      if (this._rafId) return;
      this._lastFrameTs = null;
      const step = (ts) => {
        if (this._targetTop == null) {
          this._rafId = null;
          this._lastFrameTs = null;
          return;
        }
        // Verstrichene Zeit seit letztem Frame → framerate-unabhängige Glättung.
        const dt = this._lastFrameTs == null ? 1 / 60 : Math.min(0.1, (ts - this._lastFrameTs) / 1000);
        this._lastFrameTs = ts;

        const current = this._getScrollTop();
        const delta = this._targetTop - current;
        if (Math.abs(delta) < 0.5) {
          this._setScrollTop(this._targetTop);
          this._rafId = null;
          this._lastFrameTs = null;
          return;
        }
        // Exponentielle Annäherung: Bruchteil der Restdistanz proportional zur
        // vergangenen Zeit, damit die Geschwindigkeit unabhängig von der FPS ist.
        const factor = 1 - Math.pow(1 - this._smoothingPerSecond, dt * 60);
        this._setScrollTop(current + delta * factor);
        this._rafId = requestAnimationFrame(step);
      };
      this._rafId = requestAnimationFrame(step);
    }

    stop() {
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = null;
      this._targetTop = null;
      this._lastFrameTs = null;
    }
  }

  // ===========================================================================
  // 10. READER ENGINE
  // ===========================================================================

  const ReaderState = Object.freeze({
    IDLE: 'idle',
    PLAYING: 'playing',
    PAUSED: 'paused',
    STOPPED: 'stopped',
    FINISHED: 'finished',
  });

  /**
   * Zustandsautomat, der die eigentliche RSVP-Wiedergabe steuert. Baut aus den
   * Blöcken einen flachen "TokenStream" (Token + Referenz auf Ursprungsblock),
   * berechnet Anzeigedauern über SpeedModel und feuert bei jedem Frame ein
   * 'reader:token' Event mit allen für die UI nötigen Infos.
   *
   * Timing-Strategie: statt vieler setTimeout-Ketten (die bei Tab-Wechsel
   * driften) wird requestAnimationFrame verwendet und die verstrichene Zeit
   * akkumuliert – robust gegenüber Drosselung im Hintergrund-Tab.
   */
  class ReaderEngine {
    constructor(eventBus, settings, speedModel) {
      this.bus = eventBus;
      this.settings = settings;
      this.speedModel = speedModel;

      this.blocks = [];
      this.stream = []; // [{ token, block, chapterIndex }]
      this.chapters = []; // [{ title, tokenIndex }]

      this.state = ReaderState.IDLE;
      this.index = 0;
      this._accumulatedMs = 0;
      this._lastFrameTime = 0;
      this._rafId = null;

      this._sessionStats = null;
    }

    /** Baut den Token-Stream aus den geparsten Blöcken auf (einmalig pro Container). */
    loadBlocks(blocks) {
      this.blocks = blocks;
      this.stream = [];
      this.chapters = [];

      for (const block of blocks) {
        if (block.type === BlockType.HEADING) {
          this.chapters.push({ title: block.tokens.map((t) => t.text).join(' '), tokenIndex: this.stream.length });
        }
        block.tokens.forEach((token, localIndex) => {
          this.stream.push({ token, block, localIndex });
        });
      }
      this.index = 0;
      this.bus.emit('reader:loaded', { totalWords: this.stream.length, chapters: this.chapters });
    }

    get totalWords() {
      return this.stream.length;
    }

    get currentWpm() {
      return this.settings.get('wpm');
    }

    seekToIndex(index) {
      this.index = Utils.clamp(index, 0, Math.max(0, this.stream.length - 1));
      this._emitCurrentToken();
    }

    start() {
      if (this.stream.length === 0) return;
      if (this.state === ReaderState.FINISHED || this.state === ReaderState.IDLE) {
        this.index = 0;
        this._sessionStats = this._createStatsAccumulator();
      }
      if (!this._sessionStats) this._sessionStats = this._createStatsAccumulator();
      this.state = ReaderState.PLAYING;
      this._sessionStats.resumedAt = performance.now();
      this._accumulatedMs = 0;
      this._lastFrameTime = performance.now();
      this.bus.emit('reader:state', { state: this.state });
      this._loop();
    }

    pause() {
      if (this.state !== ReaderState.PLAYING) return;
      this.state = ReaderState.PAUSED;
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = null;
      if (this._sessionStats) {
        this._sessionStats.activeMs += performance.now() - this._sessionStats.resumedAt;
      }
      this.bus.emit('reader:state', { state: this.state });
    }

    togglePause() {
      if (this.state === ReaderState.PLAYING) this.pause();
      else this.start();
    }

    stop() {
      this.state = ReaderState.STOPPED;
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = null;
      this.bus.emit('reader:state', { state: this.state });
    }

    next() {
      this.seekToIndex(this.index + 1);
    }

    prev() {
      this.seekToIndex(this.index - 1);
    }

    /** Springt zur nächsten Überschrift (Kapitel) nach der aktuellen Position. */
    nextChapter() {
      const target = this.chapters.find((c) => c.tokenIndex > this.index);
      if (target) this.seekToIndex(target.tokenIndex);
      else this.seekToIndex(this.stream.length - 1);
    }

    /** Springt zur vorherigen Überschrift; steht man bereits knapp dahinter, zur davor liegenden. */
    prevChapter() {
      const before = this.chapters.filter((c) => c.tokenIndex < this.index);
      if (before.length === 0) { this.seekToIndex(0); return; }
      this.seekToIndex(before[before.length - 1].tokenIndex);
    }

    changeSpeed(deltaWpm) {
      const s = this.settings;
      const newWpm = Utils.clamp(s.get('wpm') + deltaWpm, s.get('minWpm'), s.get('maxWpm'));
      s.set('wpm', newWpm);
      this.bus.emit('reader:wpm', { wpm: newWpm });
    }

    _createStatsAccumulator() {
      return {
        startedAt: performance.now(),
        resumedAt: performance.now(),
        activeMs: 0,
        wordsRead: 0,
        images: this.blocks.filter((b) => b.type === BlockType.IMAGE).length,
        tables: this.blocks.filter((b) => b.type === BlockType.TABLE).length,
        codeBlocks: this.blocks.filter((b) => b.type === BlockType.CODE_BLOCK).length,
      };
    }

    _loop() {
      const frame = (now) => {
        if (this.state !== ReaderState.PLAYING) return;
        const dt = now - this._lastFrameTime;
        this._lastFrameTime = now;
        this._accumulatedMs += dt;

        const entry = this.stream[this.index];
        if (!entry) {
          this._finish();
          return;
        }
        const delay = this.speedModel.computeDelay(entry.token, entry.block, this.currentWpm);

        if (this._accumulatedMs >= delay) {
          this._accumulatedMs = 0;
          this._sessionStats.wordsRead++;
          this.index++;
          if (this.index >= this.stream.length) {
            this._finish();
            return;
          }
          // Erst NACH dem Weiterzählen emittieren: die soeben abgelaufene Verzögerung
          // gehörte dem gerade sichtbaren Wort, nicht dem neuen. Sonst würde das neue
          // Wort (z. B. ein Tabellen-/Bild-Platzhalter mit erzwungener Pause) erst nach
          // der Pause statt davor eingeblendet.
          this._emitCurrentToken();
        }
        this._rafId = requestAnimationFrame(frame);
      };
      this._rafId = requestAnimationFrame(frame);
    }

    _finish() {
      this.state = ReaderState.FINISHED;
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = null;
      if (this._sessionStats) {
        this._sessionStats.activeMs += performance.now() - this._sessionStats.resumedAt;
      }
      this.bus.emit('reader:state', { state: this.state });
      this.bus.emit('reader:finished', this._buildStats());
    }

    _buildStats() {
      const stats = this._sessionStats;
      const totalSeconds = stats.activeMs / 1000;
      const avgWpm = totalSeconds > 0 ? (stats.wordsRead / totalSeconds) * 60 : 0;
      const readingWpmAssumedHuman = 200; // durchschnittliche menschliche Lesegeschwindigkeit als Baseline
      const estimatedHumanSeconds = (stats.wordsRead / readingWpmAssumedHuman) * 60;
      const timeSavedSeconds = Math.max(0, estimatedHumanSeconds - totalSeconds);

      return {
        totalTimeSeconds: totalSeconds,
        averageWpm: Math.round(avgWpm),
        effectiveWpm: Math.round(avgWpm),
        wordCount: stats.wordsRead,
        imageCount: stats.images,
        tableCount: stats.tables,
        codeBlockCount: stats.codeBlocks,
        timeSavedSeconds,
      };
    }

    _currentChapterIndex() {
      let chapterIdx = -1;
      for (let i = 0; i < this.chapters.length; i++) {
        if (this.chapters[i].tokenIndex <= this.index) chapterIdx = i;
        else break;
      }
      return chapterIdx;
    }

    _emitCurrentToken() {
      const entry = this.stream[this.index];
      if (!entry) return;
      const remainingWords = this.stream.length - this.index;
      const remainingSeconds = (remainingWords * 60) / this.currentWpm;
      const chapterIdx = this._currentChapterIndex();

      this.bus.emit('reader:token', {
        token: entry.token,
        block: entry.block,
        localIndex: entry.localIndex,
        index: this.index,
        total: this.stream.length,
        progress: this.stream.length ? this.index / this.stream.length : 0,
        remainingSeconds,
        chapter: chapterIdx >= 0 ? this.chapters[chapterIdx] : null,
        chapterIndex: chapterIdx,
        wpm: this.currentWpm,
      });
    }
  }

  // ===========================================================================
  // 11. UI-KOMPONENTEN
  // ===========================================================================

  /** Zentrale CSS-Injektion. Alle Klassen sind mit NS-Präfix versehen (keine Kollisionen). */
  function injectStyles() {
    GM_addStyle(`
      .${NS}-fab {
        position: fixed; z-index: 2147483000; bottom: 24px; right: 24px;
        width: 52px; height: 52px; border-radius: 50%;
        background: #4f46e5; color: #fff; border: none; cursor: pointer;
        font-size: 22px; box-shadow: 0 4px 14px rgba(0,0,0,.3);
        display: flex; align-items: center; justify-content: center;
        transition: transform .15s ease;
      }
      .${NS}-fab:hover { transform: scale(1.08); }

      .${NS}-hover-highlight {
        outline: 3px solid #4f46e5 !important;
        outline-offset: 2px;
        background: rgba(79,70,229,0.08) !important;
        cursor: crosshair !important;
      }

      .${NS}-overlay-hint {
        position: fixed; z-index: 2147483000; top: 16px; left: 50%; transform: translateX(-50%);
        background: #111827; color: #fff; padding: 8px 16px; border-radius: 8px;
        font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.35);
      }

      /* Fest im Viewport verankert (nicht mehr im Container), damit die Toolbar beim
         Auto-Scroll/Springen des Containers nicht mitwandert oder hin- und herspringt. */
      .${NS}-toolbar {
        position: fixed; z-index: 2147483000;
        left: 50%; transform: translateX(-50%);
        width: min(760px, 94vw);
        background: var(--usr-bg, #1f2937); color: var(--usr-fg, #f3f4f6);
        font: 13px/1.4 system-ui, -apple-system, sans-serif;
        padding: 10px 14px; border-radius: 10px;
        box-shadow: 0 4px 18px rgba(0,0,0,.25);
        display: flex; flex-direction: column; gap: 8px;
        transition: background-color .15s ease;
      }
      .${NS}-toolbar.usr-pos-top { top: 8px; }
      .${NS}-toolbar.usr-pos-bottom { bottom: 8px; }
      .${NS}-toolbar.usr-theme-light { --usr-bg: #f9fafb; --usr-fg: #111827; box-shadow: 0 4px 18px rgba(0,0,0,.12); }
      /* Listen-Zebra: nur ein schmaler Farbstreifen (10% Breite) links im
         Textbereich (Wortanzeige), NICHT die ganze Toolbar. Ebene = Farbfamilie
         (lvl-1/2/3, zyklisch), Parität der <li> = hell/dunkel (a/b). */
      /* Dezente Helligkeitsabstufung EINER Farbe (Akzent-Indigo, hsl ~244):
         Ebene = Helligkeitsstufe, <li>-Parität = kleiner Hell/Dunkel-Schritt. */
      .${NS}-display.${NS}-zebra-lvl-1.${NS}-zebra-a { --usr-zebra: hsl(244 60% 42%); }
      .${NS}-display.${NS}-zebra-lvl-1.${NS}-zebra-b { --usr-zebra: hsl(244 60% 52%); }
      .${NS}-display.${NS}-zebra-lvl-2.${NS}-zebra-a { --usr-zebra: hsl(244 58% 60%); }
      .${NS}-display.${NS}-zebra-lvl-2.${NS}-zebra-b { --usr-zebra: hsl(244 58% 70%); }
      .${NS}-display.${NS}-zebra-lvl-3.${NS}-zebra-a { --usr-zebra: hsl(244 56% 78%); }
      .${NS}-display.${NS}-zebra-lvl-3.${NS}-zebra-b { --usr-zebra: hsl(244 56% 86%); }
      .${NS}-display[class*="${NS}-zebra-lvl"]::before {
        content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 10%;
        background: var(--usr-zebra, transparent);
        border-radius: 8px 0 0 8px; pointer-events: none;
        transition: background-color .12s ease;
      }
      /* Ebenen-Markierung („-" je Ebene) im linken Farbstreifen, über dem Farbfeld. */
      .${NS}-zebra-marker {
        position: absolute; left: 0; top: 0; bottom: 0; width: 10%;
        display: flex; align-items: center; justify-content: center;
        color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.4);
        font-weight: 700; font-size: 14px; letter-spacing: 0;
        white-space: nowrap; overflow: hidden; pointer-events: none;
      }

      /* Vollbild: der Reader selbst füllt die komplette Seite statt einer kleinen
         Leiste – große, vertikal zentrierte Wortanzeige, Steuerung unten kompakt. */
      .${NS}-toolbar.usr-fullscreen-mode {
        inset: 0 !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
        transform: none !important; width: 100vw !important; height: 100vh !important; max-width: none;
        border-radius: 0; margin: 0; padding: 32px 5vw;
        justify-content: center;
      }
      .${NS}-toolbar.usr-fullscreen-mode .${NS}-display {
        flex: 1 1 auto; min-height: 0; height: auto; border-bottom: none;
      }

      /* Ansichten:
         - Kompakt (usr-view-compact): Regler/Optionen aus, Fortschritt + Infoleiste bleiben.
         - Fokus (usr-view-focus): nur das aktuelle Wort. Kombinierbar mit Vollbild. */
      .${NS}-toolbar.usr-view-compact .${NS}-hide-compact { display: none; }
      .${NS}-toolbar.usr-view-compact:not(.usr-fullscreen-mode) { padding: 8px 14px; }
      .${NS}-toolbar.usr-view-focus .${NS}-hide-compact,
      .${NS}-toolbar.usr-view-focus .${NS}-hide-focus { display: none; }
      .${NS}-toolbar.usr-view-focus .${NS}-display { border-bottom: none; padding-bottom: 0; }
      .${NS}-toolbar.usr-view-focus:not(.usr-fullscreen-mode) { padding: 14px 20px; }

      .${NS}-display {
        position: relative; display: flex; align-items: center; justify-content: center;
        overflow: hidden;
        height: 64px; font-size: 30px; font-weight: 600; letter-spacing: .5px;
        font-family: 'Courier New', ui-monospace, monospace;
        border-bottom: 1px solid rgba(255,255,255,.08);
        padding-bottom: 8px;
      }
      .${NS}-toolbar.usr-theme-light .${NS}-display { border-bottom-color: rgba(0,0,0,.08); }
      .${NS}-refline { position: absolute; top: 0; bottom: 0; width: 2px; background: #ef4444; opacity: .6; }
      .${NS}-orp-focus { color: #ef4444; }
      .${NS}-word-before, .${NS}-word-after { opacity: .92; white-space: pre; min-width: 0; }
      /* Fixpunkt-Modus: Fokusbuchstabe bleibt stets an fester Bildschirmposition (Mitte),
         indem Vor-/Nachwort-Spalten gleich breit sind und sich das Wort darunter verschiebt. */
      .${NS}-display.usr-orp-fixed .${NS}-word-before { flex: 1 1 0; text-align: right; }
      .${NS}-display.usr-orp-fixed .${NS}-word-after { flex: 1 1 0; text-align: left; }
      .${NS}-display.usr-orp-fixed .${NS}-orp-focus { flex: 0 0 auto; }
      .${NS}-display.usr-orp-fixed .${NS}-refline { left: 50%; transform: translateX(-1px); }

      .${NS}-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .${NS}-progress-track { flex: 1 1 auto; height: 6px; border-radius: 3px; background: rgba(255,255,255,.12); overflow: hidden; cursor: pointer; min-width: 80px; }
      .${NS}-toolbar.usr-theme-light .${NS}-progress-track { background: rgba(0,0,0,.1); }
      .${NS}-progress-fill { height: 100%; background: #4f46e5; width: 0%; transition: width .08s linear; }

      .${NS}-btn {
        display: inline-flex; align-items: center; justify-content: center;
        background: rgba(255,255,255,.08); color: inherit; border: none; border-radius: 7px;
        width: 30px; height: 30px; padding: 0; cursor: pointer; line-height: 1;
        transition: background .12s ease, transform .08s ease;
      }
      .${NS}-toolbar.usr-theme-light .${NS}-btn { background: rgba(0,0,0,.06); }
      .${NS}-btn:hover { background: rgba(255,255,255,.18); }
      .${NS}-toolbar.usr-theme-light .${NS}-btn:hover { background: rgba(0,0,0,.12); }
      .${NS}-btn:active { transform: scale(.92); }
      .${NS}-btn.usr-active { background: #4f46e5; color: #fff; }

      .${NS}-slider { width: 120px; accent-color: #4f46e5; }
      .${NS}-stat { font-size: 11px; opacity: .85; white-space: nowrap; }
      .${NS}-melody-link { color: inherit; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
      .${NS}-melody-link:hover { color: #a5b4fc; }
      .${NS}-spacer { flex: 1 1 auto; }
      .${NS}-select {
        background: rgba(255,255,255,.08); color: inherit; border: none; border-radius: 6px;
        padding: 5px 8px; font-size: 12px; cursor: pointer;
      }
      .${NS}-toolbar.usr-theme-light .${NS}-select { background: rgba(0,0,0,.06); }

      /* Icon-Toggle-Pills: Punkt-Indikator statt nativer Checkbox-Optik,
         gefüllt+farbig sobald aktiv (per :has() an den Checkbox-Zustand gekoppelt). */
      .${NS}-toggle {
        display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
        padding: 5px 10px 5px 8px; border-radius: 999px; background: rgba(255,255,255,.06);
        cursor: pointer; user-select: none; transition: background .12s ease;
      }
      .${NS}-toolbar.usr-theme-light .${NS}-toggle { background: rgba(0,0,0,.05); }
      .${NS}-toggle:hover { background: rgba(255,255,255,.12); }
      .${NS}-toolbar.usr-theme-light .${NS}-toggle:hover { background: rgba(0,0,0,.09); }
      .${NS}-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
      .${NS}-toggle-dot {
        width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto;
        background: rgba(255,255,255,.3); transition: background .12s ease, transform .12s ease;
      }
      .${NS}-toolbar.usr-theme-light .${NS}-toggle-dot { background: rgba(0,0,0,.22); }
      .${NS}-toggle:has(input:checked) { background: #4f46e5; color: #fff; }
      .${NS}-toggle:has(input:checked) .${NS}-toggle-dot { background: #fff; transform: scale(1.15); }

      /* Fokusmodus: Elemente außerhalb des gewählten Containers werden gedimmt/verwischt/versteckt. */
      .${NS}-focus-dim { opacity: .12 !important; transition: opacity .25s ease; }
      .${NS}-focus-blur { filter: blur(6px) !important; opacity: .5 !important; transition: filter .25s ease, opacity .25s ease; }
      .${NS}-focus-hide { visibility: hidden !important; }

      /* Sehr dezente Rosa-Hervorhebung des aktuell vorgelesenen Worts im Original-Quelltext.
         Nutzt die CSS Custom Highlight API (keine DOM-Mutation, kein MutationObserver-Trigger). */
      ::highlight(${NS}-current-word) { background-color: rgba(244, 63, 94, 0.22); }

      .${NS}-stats-modal {
        position: fixed; inset: 0; z-index: 2147483001;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,.55);
      }
      .${NS}-stats-card {
        background: var(--usr-bg, #1f2937); color: var(--usr-fg, #f3f4f6);
        border-radius: 12px; padding: 24px 28px; width: min(420px, 90vw);
        font: 14px/1.5 system-ui, sans-serif; box-shadow: 0 12px 40px rgba(0,0,0,.4);
      }
      .${NS}-stats-card h2 { margin: 0 0 12px; font-size: 18px; }
      .${NS}-stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; margin-bottom: 16px; }
      .${NS}-stats-grid div:nth-child(odd) { opacity: .75; }

      /* Gruppierung der Optionen: vertikaler Trenner + kleine Gruppenlabels. */
      .${NS}-divider { width: 1px; align-self: stretch; margin: 2px 4px; background: rgba(255,255,255,.14); }
      .${NS}-toolbar.usr-theme-light .${NS}-divider { background: rgba(0,0,0,.12); }
      .${NS}-group { display: inline-flex; align-items: center; gap: 6px; }
      .${NS}-group-label { font-size: 9px; text-transform: uppercase; letter-spacing: .06em; opacity: .5; margin-right: 2px; }
      /* Infoleiste nie umbrechen; der (potenziell lange) Melodietitel wird bei
         Platzmangel gekürzt (…), statt die Leiste auf zwei Zeilen zu drücken. */
      .${NS}-statsrow { font-variant-numeric: tabular-nums; flex-wrap: nowrap; }
      .${NS}-stat-melody { min-width: 0; flex: 0 1 auto; overflow: hidden; }
      .${NS}-melody-link {
        display: inline-block; max-width: 100%; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom;
      }
      /* Notausstiegs-Zeile nur im Superfokus (sonst liegen die Aktionen in Zeile 3). */
      .${NS}-exit-row { display: none; }
      .${NS}-toolbar.usr-view-focus .${NS}-exit-row { display: flex; }

      /* Verzögerte Hover-Hinweise. */
      .${NS}-tooltip {
        position: absolute; z-index: 2147483002; transform: translateX(-50%);
        max-width: 260px; padding: 6px 10px; border-radius: 8px;
        background: #0b1220; color: #f3f4f6; font: 12px/1.4 system-ui, sans-serif;
        box-shadow: 0 6px 20px rgba(0,0,0,.4); pointer-events: none;
        opacity: 0; transition: opacity .12s ease; white-space: normal; text-align: center;
      }
      .${NS}-tooltip.usr-tip-below { transform: translate(-50%, 0); }
      .${NS}-tooltip:not(.usr-tip-below) { transform: translate(-50%, -100%); }
      .${NS}-tooltip.usr-show { opacity: 1; }

      /* Hilfe-Overlay. */
      .${NS}-help-modal {
        position: fixed; inset: 0; z-index: 2147483002;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,.55);
      }
      .${NS}-help-card {
        background: var(--usr-bg, #1f2937); color: var(--usr-fg, #f3f4f6);
        border-radius: 12px; padding: 22px 26px; width: min(560px, 92vw);
        max-height: 82vh; overflow: auto;
        font: 13px/1.5 system-ui, sans-serif; box-shadow: 0 12px 40px rgba(0,0,0,.45);
      }
      .${NS}-help-card h2 { margin: 0 0 10px; font-size: 18px; }
      .${NS}-help-card h3 { margin: 16px 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
      .${NS}-help-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; align-items: start; }
      .${NS}-help-key, .${NS}-help-feat { font-weight: 700; white-space: nowrap; }
      .${NS}-help-key {
        font-family: ui-monospace, monospace; background: rgba(255,255,255,.1);
        padding: 1px 7px; border-radius: 5px; justify-self: start;
      }
      .${NS}-toolbar.usr-theme-light .${NS}-help-key, .${NS}-help-card.usr-theme-light .${NS}-help-key { background: rgba(0,0,0,.08); }
      .${NS}-help-close { width: auto; padding: 8px 16px; margin-top: 18px; }
    `);
  }

  /**
   * Kleiner, immer sichtbarer Floating-Button, der den Auswahlmodus startet.
   */
  class FloatingButton {
    constructor(onClick) {
      this.element = Utils.el('button', {
        class: `${NS}-fab`,
        title: 'Universal SpeedReader starten',
        text: '⚡',
        onclick: onClick,
      });
      document.body.appendChild(this.element);
    }

    hide() {
      this.element.style.display = 'none';
    }

    show() {
      this.element.style.display = 'flex';
    }

    dispose() {
      this.element.remove();
    }
  }

  /**
   * Aktiviert einen Auswahlmodus: Elemente unter dem Mauszeiger werden
   * hervorgehoben; Klick wählt den Container aus; ESC bricht ab.
   */
  class SelectionOverlay {
    constructor(onSelect, onCancel) {
      this.onSelect = onSelect;
      this.onCancel = onCancel;
      this._current = null;
      this._active = false;

      this._handleMove = Utils.throttle(this._handleMove_impl.bind(this), 40);
      this._handleClick = this._handleClick.bind(this);
      this._handleKey = this._handleKey.bind(this);
    }

    start() {
      this._active = true;
      this._hint = Utils.el('div', {
        class: `${NS}-overlay-hint`,
        text: 'Container wählen · Klick = auswählen · ESC = abbrechen',
      });
      document.body.appendChild(this._hint);

      document.addEventListener('mousemove', this._handleMove, true);
      document.addEventListener('click', this._handleClick, true);
      document.addEventListener('keydown', this._handleKey, true);
    }

    _handleMove_impl(evt) {
      if (!this._active) return;
      const target = document.elementFromPoint(evt.clientX, evt.clientY);
      if (!target || target === this._current) return;
      if (target.closest(`.${NS}-ui, .${NS}-fab, .${NS}-overlay-hint`)) return;

      this._current?.classList.remove(`${NS}-hover-highlight`);
      this._current = this._pickReasonableContainer(target);
      this._current?.classList.add(`${NS}-hover-highlight`);
    }

    /**
     * Heuristik: bevorzugt einen Vorfahren mit "genug" Textinhalt (article,
     * main, ansonsten das direkt getroffene Element), damit man nicht jedes
     * einzelne <span> auswählen muss.
     */
    _pickReasonableContainer(target) {
      const semantic = target.closest('article, main, [role="main"]');
      if (semantic && semantic.textContent.trim().length > 200) return semantic;
      let node = target;
      while (node && node.parentElement) {
        if ((node.textContent || '').trim().length > 400) return node;
        node = node.parentElement;
      }
      return target;
    }

    _handleClick(evt) {
      if (!this._active) return;
      evt.preventDefault();
      evt.stopPropagation();
      const chosen = this._current || evt.target;
      this._teardown();
      this.onSelect(chosen);
    }

    _handleKey(evt) {
      if (!this._active) return;
      if (evt.key === 'Escape') {
        evt.preventDefault();
        this._teardown();
        this.onCancel();
      }
    }

    _teardown() {
      this._active = false;
      this._current?.classList.remove(`${NS}-hover-highlight`);
      this._current = null;
      this._hint?.remove();
      document.removeEventListener('mousemove', this._handleMove, true);
      document.removeEventListener('click', this._handleClick, true);
      document.removeEventListener('keydown', this._handleKey, true);
    }
  }

  /**
   * Sticky Toolbar innerhalb des gewählten Containers: RSVP-Anzeige,
   * Fortschritt, Steuerung, Regler und Schalter. Rein UI-seitig, alle
   * Aktionen werden über den EventBus an ReaderEngine/Settings delegiert.
   */
  class Toolbar {
    constructor(eventBus, settings) {
      this.bus = eventBus;
      this.settings = settings;
      this.element = this._build();
      this._bindBusEvents();
      this._setupTooltips();
    }

    /**
     * Einheitliche, verzögerte Hover-Hinweise: verschiebt vorhandene title-Texte
     * in data-hint (verhindert doppelte native Tooltips) und zeigt nach ~550 ms
     * einen gestylten Tooltip beim überfahrenen Bedienelement.
     */
    _setupTooltips() {
      this.element.querySelectorAll('[title]').forEach((el) => {
        if (!el.getAttribute('data-hint')) el.setAttribute('data-hint', el.getAttribute('title'));
        el.removeAttribute('title');
      });
      this._tip = Utils.el('div', { class: `${NS}-tooltip` });
      this.element.appendChild(this._tip);
      let timer = null;
      const hide = () => { clearTimeout(timer); this._tip.classList.remove('usr-show'); };
      this.element.addEventListener('mouseover', (e) => {
        const target = e.target.closest('[data-hint]');
        if (!target || !this.element.contains(target)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          this._tip.textContent = target.getAttribute('data-hint');
          const tb = this.element.getBoundingClientRect();
          const rb = target.getBoundingClientRect();
          this._tip.style.left = `${Utils.clamp(rb.left - tb.left + rb.width / 2, 60, tb.width - 60)}px`;
          // Standardmäßig über dem Element; bei oberer Toolbar-Position darunter.
          const below = this.settings.get('toolbarPosition') === 'top';
          this._tip.style.top = below ? `${rb.bottom - tb.top + 8}px` : `${rb.top - tb.top - 8}px`;
          this._tip.classList.toggle('usr-tip-below', below);
          this._tip.classList.add('usr-show');
        }, 550);
      });
      this.element.addEventListener('mouseout', hide);
      this.element.addEventListener('click', hide, true);
    }

    _build() {
      const s = this.settings;
      const posClass = s.get('toolbarPosition') === 'bottom' ? 'usr-pos-bottom' : 'usr-pos-top';
      const themeClass = s.get('theme') === 'light' ? 'usr-theme-light' : '';

      this.wordBefore = Utils.el('span', { class: `${NS}-word-before` });
      this.wordFocus = Utils.el('span', { class: `${NS}-orp-focus` });
      this.wordAfter = Utils.el('span', { class: `${NS}-word-after` });
      this.refLine = Utils.el('div', { class: `${NS}-refline` });
      // Textmarkierung im linken Farbstreifen (ein „-" je Listenebene).
      this.zebraMarker = Utils.el('div', { class: `${NS}-zebra-marker` });

      this.display = Utils.el('div', {
        class: `${NS}-display${s.get('orpFixedPoint') ? ' usr-orp-fixed' : ''}`,
        style: `font-size: ${s.get('displayFontSize')}px;`,
      }, [
        this.refLine, this.zebraMarker, this.wordBefore, this.wordFocus, this.wordAfter,
      ]);

      this.progressFill = Utils.el('div', { class: `${NS}-progress-fill` });
      this.progressTrack = Utils.el('div', {
        class: `${NS}-progress-track`,
        onclick: (e) => this._handleSeekClick(e),
      }, [this.progressFill]);

      this.statChapter = Utils.el('span', { class: `${NS}-stat`, text: 'Kapitel: –' });
      this.statWords = Utils.el('span', { class: `${NS}-stat`, text: '0 / 0' });
      this.statPercent = Utils.el('span', { class: `${NS}-stat`, text: '0%' });
      this.statRemaining = Utils.el('span', { class: `${NS}-stat`, text: '--:--' });
      this.statWpm = Utils.el('span', { class: `${NS}-stat`, text: `${s.get('wpm')} WPM` });
      this.statListLevel = Utils.el('span', { class: `${NS}-stat`, title: 'Verschachtelungstiefe der aktuellen Liste' });
      this.statMelody = Utils.el('span', { class: `${NS}-stat ${NS}-stat-melody` });

      // Einheitliches Icon-Set statt gemischter Emoji/Symbole: einfacher Chevron = Wort-
      // Schritt, doppelter Chevron = Kapitel-Sprung – eindeutig unterscheidbar.
      const hotkeys = s.get('hotkeys');
      this.btnPrevChapter = Utils.el('button', {
        class: `${NS}-btn`, title: `Vorherige Überschrift (⇧${hotkeyLabel(hotkeys.prev)} oder ${hotkeyLabel(hotkeys.prevChapter)})`,
        onclick: () => this.bus.emit('ui:prev-chapter'),
      }, [makeIcon('chevronsLeft')]);
      this.btnPrev = Utils.el('button', {
        class: `${NS}-btn`, title: `Wort zurück (${hotkeyLabel(hotkeys.prev)})`,
        onclick: () => this.bus.emit('ui:prev'),
      }, [makeIcon('chevronLeft')]);
      this.btnStart = Utils.el('button', {
        class: `${NS}-btn`, title: `Start/Pause (${hotkeyLabel(hotkeys.togglePause)})`,
        'data-hint': `Startet bzw. pausiert das Lesen. Kürzel: ${hotkeyLabel(hotkeys.togglePause)}`,
        onclick: () => this.bus.emit('ui:toggle'),
      }, [makeIcon('play')]);
      this.btnNext = Utils.el('button', {
        class: `${NS}-btn`, title: `Wort vor (${hotkeyLabel(hotkeys.next)})`,
        onclick: () => this.bus.emit('ui:next'),
      }, [makeIcon('chevronRight')]);
      this.btnNextChapter = Utils.el('button', {
        class: `${NS}-btn`, title: `Nächste Überschrift (⇧${hotkeyLabel(hotkeys.next)} oder ${hotkeyLabel(hotkeys.nextChapter)})`,
        onclick: () => this.bus.emit('ui:next-chapter'),
      }, [makeIcon('chevronsRight')]);
      this.btnClose = Utils.el('button', {
        class: `${NS}-btn`, title: `Schließen (${hotkeyLabel(hotkeys.close)})`,
        onclick: () => this.bus.emit('ui:close'),
      }, [makeIcon('close')]);

      this.wpmSlider = Utils.el('input', {
        class: `${NS}-slider`, type: 'range', min: s.get('minWpm'), max: s.get('maxWpm'), value: s.get('wpm'),
        oninput: (e) => this.bus.emit('ui:wpm-set', { wpm: Number(e.target.value) }),
      });

      this.statFontSize = Utils.el('span', { class: `${NS}-stat`, text: `${s.get('displayFontSize')}px` });
      this.fontSizeSlider = Utils.el('input', {
        class: `${NS}-slider`, type: 'range', min: s.get('minFontSize'), max: s.get('maxFontSize'), value: s.get('displayFontSize'),
        oninput: (e) => this.bus.emit('ui:font-size-set', { size: Number(e.target.value) }),
      });

      this.statPlaceholderPause = Utils.el('span', { class: `${NS}-stat`, text: `${(s.get('placeholderPauseMs') / 1000).toFixed(1)}s` });
      this.placeholderPauseSlider = Utils.el('input', {
        class: `${NS}-slider`, type: 'range',
        min: s.get('minPlaceholderPauseMs'), max: s.get('maxPlaceholderPauseMs'), step: 100,
        value: s.get('placeholderPauseMs'),
        title: 'Mindestpause bei übersprungenen Tabellen/Bildern',
        oninput: (e) => this.bus.emit('ui:placeholder-pause-set', { ms: Number(e.target.value) }),
      });

      this.focusModeSelect = Utils.el('select', {
        class: `${NS}-select`, title: 'Fokusmodus: übrige Seite abdunkeln/verwischen/ausblenden',
        onchange: (e) => this.bus.emit('ui:focus-mode-set', { mode: e.target.value }),
      }, [
        Utils.el('option', { value: 'off', text: 'Fokus: Aus' }),
        Utils.el('option', { value: 'dim', text: 'Fokus: Abdunkeln' }),
        Utils.el('option', { value: 'blur', text: 'Fokus: Verschwommen' }),
        Utils.el('option', { value: 'hide', text: 'Fokus: Ausblenden' }),
      ]);
      this.focusModeSelect.value = s.get('focusMode');

      this.toggleOrp = this._makeToggle('ORP', 'orpEnabled', 'ui:toggle-orp');
      this.toggleOrpFixed = this._makeToggle('Fixpunkt', 'orpFixedPoint', 'ui:toggle-orp-fixed');
      this.toggleScroll = this._makeToggle('AutoScroll', 'autoScroll', 'ui:toggle-autoscroll');
      this.toggleAdaptive = this._makeToggle('Adaptiv', 'adaptiveSpeed', 'ui:toggle-adaptive');
      this.togglePunct = this._makeToggle('Satzz.-Pausen', 'punctuationPauses', 'ui:toggle-punct');
      this.toggleCaptions = this._makeToggle('Bildunterschr. überspr.', 'skipImageCaptions', 'ui:toggle-captions');
      this.toggleCitations = this._makeToggle('Quellen überspr.', 'skipCitations', 'ui:toggle-citations');
      this.toggleTables = this._makeToggle('Tabellen überspr.', 'skipTables', 'ui:toggle-tables');
      this.toggleSourceHighlight = this._makeToggle('Quelltext markieren', 'highlightSourceWord', 'ui:toggle-source-highlight');
      this.toggleListZebra = this._makeToggle('Listen-Streifen', 'listZebraStripes', 'ui:toggle-list-zebra');
      this.toggleClickSound = this._makeToggle('Klickton', 'clickSoundEnabled', 'ui:toggle-click-sound', hotkeys.toggleSound);
      this.toggleReadAloud = this._makeToggle('Vorlesen', 'readAloudMode', 'ui:toggle-read-aloud');
      this.toggleShowStats = this._makeToggle('Zusammenfassung', 'showStatsOnFinish', 'ui:toggle-show-stats');
      this.toggleAutoClose = this._makeToggle('Autom. schließen', 'autoCloseAfterFinish', 'ui:toggle-auto-close');

      this.statReadRate = Utils.el('span', { class: `${NS}-stat`, text: `${s.get('readAloudRate').toFixed(1)}×` });
      this.readRateSlider = Utils.el('input', {
        class: `${NS}-slider`, type: 'range',
        min: s.get('minReadAloudRate'), max: s.get('maxReadAloudRate'), step: 0.1, value: s.get('readAloudRate'),
        'data-hint': 'Sprechgeschwindigkeit im Vorlesemodus (unabhängig von WPM).',
        oninput: (e) => this.bus.emit('ui:read-aloud-rate-set', { rate: Number(e.target.value) }),
      });

      this.readVoiceSelect = Utils.el('select', {
        class: `${NS}-select`, title: 'Stimme/Sprache im Vorlesemodus (Premium bevorzugt)',
        onchange: (e) => this.bus.emit('ui:read-aloud-voice-set', { voiceURI: e.target.value }),
      });
      this._populateReadVoices();
      if ('speechSynthesis' in window) {
        window.speechSynthesis.addEventListener?.('voiceschanged', () => this._populateReadVoices());
      }

      this.clickSoundVariantSelect = Utils.el('select', {
        class: `${NS}-select`, title: 'Klangfarbe des Klicktons',
        onchange: (e) => this.bus.emit('ui:click-sound-variant-set', { variant: e.target.value }),
      }, [
        Utils.el('option', { value: 'click', text: 'Klick' }),
        Utils.el('option', { value: 'soft', text: 'Weich' }),
        Utils.el('option', { value: 'blip', text: 'Blip' }),
        Utils.el('option', { value: 'wood', text: 'Holz' }),
        Utils.el('option', { value: 'bell', text: 'Glocke' }),
        Utils.el('option', { value: 'klassik', text: 'Klassik 🎵' }),
      ]);
      this.clickSoundVariantSelect.value = s.get('clickSoundVariant');

      this.togglePosition = Utils.el('button', {
        class: `${NS}-btn`, title: 'Toolbar-Position oben/unten',
        'data-hint': 'Verschiebt die Leiste zwischen oberem und unterem Bildschirmrand.',
        onclick: () => this.bus.emit('ui:toggle-position'),
      }, [makeIcon('updown')]);

      this.btnFullscreen = Utils.el('button', {
        class: `${NS}-btn`, title: `Vollbild (${hotkeyLabel(hotkeys.fullscreen)})`,
        'data-hint': `Reader füllt die ganze Seite. Kürzel: ${hotkeyLabel(hotkeys.fullscreen)}`,
        onclick: () => this.bus.emit('ui:toggle-fullscreen'),
      }, [makeIcon('maximize')]);

      this.btnSuperFocus = Utils.el('button', {
        class: `${NS}-btn`, title: `Ansicht wechseln: Voll → Kompakt → Fokus (${hotkeyLabel(hotkeys.superFocus)})`,
        onclick: () => this.bus.emit('ui:cycle-view'),
      }, [makeIcon('eye')]);
      this.btnSuperFocus.classList.toggle('usr-active', s.get('viewMode') !== 'full');

      this.btnHelp = Utils.el('button', {
        class: `${NS}-btn`, title: 'Hilfe – Funktionen & Tastenkürzel',
        onclick: () => this.bus.emit('ui:toggle-help'),
      }, [makeIcon('help')]);

      // Klickton-Schnellschalter unten in der Leiste (zusätzlich zum Kürzel).
      this.btnSound = Utils.el('button', {
        class: `${NS}-btn`, title: `Klickton ein/aus (${hotkeyLabel(hotkeys.toggleSound)})`,
        onclick: () => this.bus.emit('ui:toggle-sound-hotkey'),
      }, [makeIcon(s.get('clickSoundEnabled') ? 'soundOn' : 'soundOff')]);
      this.btnSound.classList.toggle('usr-active', s.get('clickSoundEnabled'));

      // Schnellschalter für den Vorlesemodus (Sprachausgabe) unten in der Leiste.
      this.btnReadAloud = Utils.el('button', {
        class: `${NS}-btn`, title: 'Vorlesen (Sprachausgabe) ein/aus',
        onclick: () => this.bus.emit('ui:toggle-read-aloud', { value: !this.settings.get('readAloudMode') }),
      }, [makeIcon('readAloud')]);
      this.btnReadAloud.classList.toggle('usr-active', s.get('readAloudMode'));

      // Kleiner vertikaler Trenner zum optischen Gruppieren.
      const divider = () => Utils.el('div', { class: `${NS}-divider` });
      const group = (label, ...children) => Utils.el('div', { class: `${NS}-group` }, [
        Utils.el('span', { class: `${NS}-group-label`, text: label }), ...children,
      ]);

      // Zeile 1: Wiedergabe-Steuerung + Regler links, Aktions-Buttons rechts gruppiert.
      // usr-hide-compact = in Kompakt- UND Fokus-Ansicht ausgeblendet.
      const controlsRow = Utils.el('div', { class: `${NS}-row ${NS}-hide-compact` }, [
        this.btnPrevChapter, this.btnPrev, this.btnStart, this.btnNext, this.btnNextChapter,
        divider(),
        Utils.el('span', { class: `${NS}-stat`, text: 'WPM' }), this.wpmSlider,
        Utils.el('span', { class: `${NS}-stat`, text: 'Schrift' }), this.fontSizeSlider,
        Utils.el('span', { class: `${NS}-stat`, text: 'Pause' }), this.placeholderPauseSlider,
        Utils.el('span', { class: `${NS}-stat`, text: 'Vorlesetempo' }), this.readRateSlider, this.statReadRate,
        Utils.el('div', { class: `${NS}-spacer` }),
      ]);

      // Zeile 2: Optionen thematisch gruppiert (Anzeige · Tempo · Überspringen · Ton · Vorlesen).
      const toggleRow = Utils.el('div', { class: `${NS}-row ${NS}-hide-compact` }, [
        group('Anzeige', this.toggleOrp, this.toggleOrpFixed, this.toggleSourceHighlight, this.toggleListZebra),
        divider(),
        group('Tempo', this.toggleAdaptive, this.togglePunct, this.toggleScroll),
        divider(),
        group('Überspringen', this.toggleCaptions, this.toggleCitations, this.toggleTables),
        divider(),
        group('Ton', this.toggleClickSound, this.clickSoundVariantSelect),
        divider(),
        group('Vorlesen', this.toggleReadAloud, this.readVoiceSelect),
        divider(),
        group('Fokus', this.focusModeSelect),
        divider(),
        group('Ende', this.toggleShowStats, this.toggleAutoClose),
      ]);

      // Zeile 3 (letzte): alle Laufzeit-Infos inkl. Restzeit/Timer + Aktions-Buttons rechts.
      // usr-hide-focus = nur in der Fokus-Ansicht ausgeblendet (in Kompakt sichtbar).
      const statsRow = Utils.el('div', { class: `${NS}-row ${NS}-statsrow ${NS}-hide-focus` }, [
        this.statChapter, this.statWords, this.statPercent, this.statRemaining, this.statWpm, this.statListLevel, this.statMelody,
        Utils.el('div', { class: `${NS}-spacer` }),
        this.btnReadAloud, this.btnSound, this.btnHelp, this.btnSuperFocus, this.btnFullscreen, this.togglePosition, this.btnClose,
      ]);

      this.progressTrack.classList.add(`${NS}-hide-focus`);

      // Im Superfokus ist Zeile 3 ausgeblendet – deshalb eine schlanke, immer sichtbare
      // Aktionszeile, damit man den Modus/Reader jederzeit verlassen kann.
      this.btnSuperFocusExit = Utils.el('button', {
        class: `${NS}-btn`, title: `Ansicht wechseln (${hotkeyLabel(hotkeys.superFocus)})`,
        onclick: () => this.bus.emit('ui:cycle-view'),
      }, [makeIcon('eye')]);
      this.btnCloseExit = Utils.el('button', {
        class: `${NS}-btn`, title: `Schließen (${hotkeyLabel(hotkeys.close)})`,
        onclick: () => this.bus.emit('ui:close'),
      }, [makeIcon('close')]);
      const exitRow = Utils.el('div', { class: `${NS}-row ${NS}-exit-row` }, [
        Utils.el('div', { class: `${NS}-spacer` }),
        this.btnSuperFocusExit, this.btnCloseExit,
      ]);

      const viewClass = s.get('viewMode') === 'compact' ? ' usr-view-compact' : s.get('viewMode') === 'focus' ? ' usr-view-focus' : '';
      const raClass = s.get('readAloudMode') ? ' usr-read-aloud' : '';
      return Utils.el('div', { class: `${NS}-toolbar ${NS}-ui ${posClass} ${themeClass}${viewClass}${raClass}` }, [
        this.display, this.progressTrack, controlsRow, toggleRow, statsRow, exitRow,
      ]);
    }

    _makeToggle(label, settingKey, eventName, hotkeyCode) {
      const title = hotkeyCode ? `${label} (${hotkeyLabel(hotkeyCode)})` : label;
      const input = Utils.el('input', {
        type: 'checkbox',
        onchange: (e) => this.bus.emit(eventName, { value: e.target.checked }),
      });
      input.checked = !!this.settings.get(settingKey);
      // Punkt-Indikator statt nativer Checkbox-Optik: einheitliches Pill-Icon-Toggle
      // (grau = aus, gefüllt+Häkchen = an), Zustand per CSS :has() gesteuert.
      const dot = Utils.el('span', { class: `${NS}-toggle-dot` });
      const wrapper = Utils.el('label', { class: `${NS}-toggle`, title }, [input, dot, document.createTextNode(label)]);
      wrapper._input = input;
      return wrapper;
    }

    /**
     * Füllt die Stimmenauswahl: Stimmen der aktuellen Dokumentsprache zuoberst
     * (in einer eigenen Gruppe, Premium zuerst), danach die übrigen Sprachen.
     * ✦ = Premium/hochwertig, „(einfach)" = niedrig aufgelöste compact-Stimme,
     * ☁ = Netz-Stimme.
     */
    _populateReadVoices() {
      if (!('speechSynthesis' in window)) {
        this.readVoiceSelect.disabled = true;
        this.readVoiceSelect.replaceChildren(Utils.el('option', { value: '', text: 'Sprachausgabe n. verfügbar' }));
        return;
      }
      const voices = window.speechSynthesis.getVoices();
      const current = this.settings.get('readAloudVoiceURI');
      const docLang = ReadAloudEngine.docLang();
      const sameLang = (v) => (v.lang || '').slice(0, 2).toLowerCase() === docLang;
      // Premium zuerst, dann normale, dann compact; innerhalb alphabetisch.
      const byQualityName = (a, b) =>
        (ReadAloudEngine.quality(b) - ReadAloudEngine.quality(a)) ||
        (a.lang || '').localeCompare(b.lang || '') || a.name.localeCompare(b.name);
      const label = (v) => {
        const mark = ReadAloudEngine.isPremium(v) ? ' ✦' : ReadAloudEngine.isCompact(v) ? ' (einfach)' : v.localService ? '' : ' ☁';
        return `${v.name} (${v.lang})${mark}`;
      };
      const opt = (v) => Utils.el('option', { value: v.voiceURI, text: label(v) });

      const same = voices.filter(sameLang).sort(byQualityName);
      const rest = voices.filter((v) => !sameLang(v)).sort(byQualityName);
      const children = [Utils.el('option', { value: '', text: 'Auto (beste Stimme)' })];
      if (same.length) {
        children.push(Utils.el('optgroup', { label: `Aktuelle Sprache (${docLang.toUpperCase()})` }, same.map(opt)));
      }
      if (rest.length) {
        children.push(Utils.el('optgroup', { label: 'Weitere Sprachen' }, rest.map(opt)));
      }
      this.readVoiceSelect.replaceChildren(...children);
      this.readVoiceSelect.value = current || '';
    }

    _handleSeekClick(evt) {
      const rect = this.progressTrack.getBoundingClientRect();
      const ratio = Utils.clamp((evt.clientX - rect.left) / rect.width, 0, 1);
      this.bus.emit('ui:seek-ratio', { ratio });
    }

    _bindBusEvents() {
      this.bus.on('reader:token', (data) => this._renderToken(data));
      this.bus.on('reader:state', ({ state }) => this._renderState(state));
      this.bus.on('reader:wpm', ({ wpm }) => {
        this.wpmSlider.value = wpm;
        this.statWpm.textContent = `${wpm} WPM`;
      });
      this.bus.on('settings:orp-changed', ({ value }) => { this.display.style.visibility = 'visible'; this.toggleOrp._input.checked = value; });
      this.bus.on('settings:orp-fixed-changed', ({ value }) => {
        this.display.classList.toggle('usr-orp-fixed', value);
        this.toggleOrpFixed._input.checked = value;
      });
      this.bus.on('settings:font-size-changed', ({ size }) => {
        this.display.style.fontSize = `${size}px`;
        this.fontSizeSlider.value = size;
        this.statFontSize.textContent = `${size}px`;
      });
      this.bus.on('settings:placeholder-pause-changed', ({ ms }) => {
        this.placeholderPauseSlider.value = ms;
        this.statPlaceholderPause.textContent = `${(ms / 1000).toFixed(1)}s`;
      });

      // Icon/Zustand nachführen, auch wenn Vollbild anders verlassen wird (z. B. ESC).
      // Der Reader selbst füllt dabei die komplette Seite aus (nicht nur das
      // Browser-Chrome wird via Fullscreen API versteckt) – die Toolbar wechselt
      // in ein großflächiges Layout mit deutlich größerer Wortanzeige.
      this._fullscreenActive = false;
      this._fullscreenChangeHandler = () => {
        this._fullscreenActive = !!document.fullscreenElement;
        this.btnFullscreen.replaceChildren(makeIcon(this._fullscreenActive ? 'minimize' : 'maximize'));
        this.btnFullscreen.classList.toggle('usr-active', this._fullscreenActive);
        this.element.classList.toggle('usr-fullscreen-mode', this._fullscreenActive);
      };
      document.addEventListener('fullscreenchange', this._fullscreenChangeHandler);

      this.bus.on('settings:view-changed', ({ mode }) => {
        this.element.classList.toggle('usr-view-compact', mode === 'compact');
        this.element.classList.toggle('usr-view-focus', mode === 'focus');
        this.btnSuperFocus.classList.toggle('usr-active', mode !== 'full');
        this.btnSuperFocusExit.classList.toggle('usr-active', mode !== 'full');
      });
      this.bus.on('settings:click-sound-variant-changed', ({ variant }) => {
        this.clickSoundVariantSelect.value = variant;
        if (variant !== 'klassik') this.statMelody.textContent = '';
      });
      // Aktuell gespieltes Klassik-Werk in der Infoleiste anzeigen (nur im Klassik-Modus),
      // verlinkt auf den zugehörigen Wikipedia-Artikel.
      this.bus.on('sound:melody', ({ name, url }) => {
        const active = this.settings.get('clickSoundEnabled') && this.settings.get('clickSoundVariant') === 'klassik';
        if (!active) { this.statMelody.replaceChildren(); return; }
        if (url) {
          this.statMelody.replaceChildren(Utils.el('a', {
            class: `${NS}-melody-link`, href: url, target: '_blank', rel: 'noopener noreferrer',
            text: `🎵 ${name}`, title: 'Wikipedia-Artikel öffnen',
          }));
        } else {
          this.statMelody.textContent = `🎵 ${name}`;
        }
      });
      this.bus.on('settings:click-sound-changed', ({ value }) => {
        if (!value) this.statMelody.textContent = '';
        this.toggleClickSound._input.checked = value;
        this.btnSound.replaceChildren(makeIcon(value ? 'soundOn' : 'soundOff'));
        this.btnSound.classList.toggle('usr-active', value);
      });
      this.bus.on('settings:read-aloud-changed', ({ value }) => {
        this.toggleReadAloud._input.checked = value;
        this.btnReadAloud.classList.toggle('usr-active', value);
        this.element.classList.toggle('usr-read-aloud', value);
      });
      this.bus.on('settings:read-aloud-rate-changed', ({ rate }) => {
        this.readRateSlider.value = rate;
        this.statReadRate.textContent = `${rate.toFixed(1)}×`;
      });
    }

    /** Misst die Breite von Text bei gegebener Schriftgröße via Canvas (kein DOM-Reflow nötig). */
    _measureTextWidth(text, fontSize) {
      if (!this._measureCtx) this._measureCtx = document.createElement('canvas').getContext('2d');
      this._measureCtx.font = `600 ${fontSize}px 'Courier New', ui-monospace, monospace`;
      return this._measureCtx.measureText(text).width;
    }

    /**
     * Sehr lange (zusammengesetzte/mit Bindestrich getrennte) Wörter würden bei
     * fester Schriftgröße über die Toolbar hinauslaufen. Statt umzubrechen (das
     * würde den Ein-Fixationspunkt-Vorteil von RSVP zunichtemachen), wird die
     * Schriftgröße für dieses eine Wort so weit verkleinert, dass es einzeilig
     * bleibt – Referenzlinie/ORP-Zentrierung bleiben dadurch gültig.
     */
    _applyFittingFontSize(text) {
      // Im Fullscreen-Modus deutlich größer starten (die Anzeigefläche ist dort
      // ohnehin fast bildschirmgroß) – die konfigurierte Basisgröße bleibt dabei
      // proportional maßgeblich, damit die Nutzer-Einstellung weiter Wirkung zeigt.
      const configuredFontSize = this.settings.get('displayFontSize');
      const baseFontSize = this._fullscreenActive ? Math.round(configuredFontSize * 2.4) : configuredFontSize;
      const availableWidth = Math.max(0, this.display.clientWidth - 24);
      // + letter-spacing (0.5px/Zeichen, siehe CSS), das Canvas measureText nicht einrechnet.
      const fullWidth = this._measureTextWidth(text, baseFontSize) + text.length * 0.5;
      const minFontSize = Math.max(12, baseFontSize * 0.35);
      const fontSize = fullWidth > availableWidth && availableWidth > 0
        ? Math.max(minFontSize, baseFontSize * (availableWidth / fullWidth))
        : baseFontSize;
      this.display.style.fontSize = `${fontSize}px`;
    }

    /**
     * Färbt den Anzeigehintergrund abwechselnd ein, solange innerhalb einer <li>
     * gelesen wird (1., 3., 5. … Element = Variante A, 2., 4., 6. … = Variante B),
     * damit beim Vorlesen von Listen erkennbar bleibt, wo ein Punkt endet und der
     * nächste beginnt. Außerhalb von Listen wieder normaler Hintergrund.
     */
    _applyListZebra(block, localIndex) {
      // Dezenter, schmaler Farbstreifen links im Textbereich (Wortanzeige) statt
      // Einfärbung des gesamten Readers – Ebene über Farbe, Position/Parität über
      // hell/dunkel, ohne die ganze Toolbar umzufärben (weniger ablenkend).
      this.display.classList.remove(
        `${NS}-zebra-a`, `${NS}-zebra-b`,
        `${NS}-zebra-lvl-1`, `${NS}-zebra-lvl-2`, `${NS}-zebra-lvl-3`
      );
      if (this.statListLevel) this.statListLevel.textContent = '';
      if (this.zebraMarker) this.zebraMarker.textContent = '';
      if (!this.settings.get('listZebraStripes') || block?.type !== BlockType.LIST || localIndex == null) return;
      const range = block.getWordRanges()[localIndex];
      const li = range?.startNode?.parentElement?.closest('li');
      if (!li?.parentElement) return;
      const siblings = [...li.parentElement.children].filter((c) => c.tagName === 'LI');
      const liIndex = siblings.indexOf(li);
      if (liIndex < 0) return;

      // Verschachtelungstiefe: Anzahl umschließender <li> bis zur Blockwurzel
      // (die eigene <li> zählt als Ebene 1). Zusätzlich zur Hell/Dunkel-Alternierung
      // je Ebene eine eigene Farbe, damit Nesting sichtbar bleibt statt nur "a/b".
      let depth = 0;
      for (let node = li; node && node !== block.element; node = node.parentElement) {
        if (node.tagName === 'LI') depth++;
      }
      const level = ((depth - 1 + 3) % 3) + 1; // 1..3, zyklisch bei tieferer Verschachtelung

      this.display.classList.add(`${NS}-zebra-lvl-${level}`, liIndex % 2 === 0 ? `${NS}-zebra-a` : `${NS}-zebra-b`);
      if (this.statListLevel) this.statListLevel.textContent = '●'.repeat(depth) + ` Ebene ${depth}`;
      // Ein „-" je Ebene, mit Leerzeichen davor und danach, innerhalb des Farbfelds.
      if (this.zebraMarker) this.zebraMarker.textContent = ' - '.repeat(depth);
    }

    _renderToken({ token, block, localIndex, index, total, progress, remainingSeconds, chapter }) {
      this._applyFittingFontSize(token.text);
      this._applyListZebra(block, localIndex);
      const orpEnabled = this.settings.get('orpEnabled');
      if (orpEnabled) {
        const { before, focus, after } = ORP.split(token.text);
        this.wordBefore.textContent = before;
        this.wordFocus.textContent = focus;
        this.wordAfter.textContent = after;
        this.refLine.style.display = 'block';
        if (!this.settings.get('orpFixedPoint')) {
          // Variabler Modus: Referenzlinie an horizontaler Position des Fokusbuchstabens ausrichten.
          requestAnimationFrame(() => {
            const focusRect = this.wordFocus.getBoundingClientRect();
            const displayRect = this.display.getBoundingClientRect();
            const left = focusRect.left - displayRect.left + focusRect.width / 2;
            this.refLine.style.left = `${left}px`;
          });
        }
        // Fixpunkt-Modus: Referenzlinie sitzt per CSS fest in der Mitte, keine Neuberechnung nötig.
      } else {
        this.wordBefore.textContent = '';
        this.wordFocus.textContent = token.text;
        this.wordAfter.textContent = '';
        this.refLine.style.display = 'none';
      }

      this.progressFill.style.width = `${(progress * 100).toFixed(2)}%`;
      this.statWords.textContent = `${index + 1} / ${total}`;
      this.statPercent.textContent = `${Math.round(progress * 100)}%`;
      this.statRemaining.textContent = Utils.formatTime(remainingSeconds);
      this.statChapter.textContent = `Kapitel: ${chapter ? chapter.title.slice(0, 40) : '–'}`;
    }

    _renderState(state) {
      this.btnStart.replaceChildren(makeIcon(state === ReaderState.PLAYING ? 'pause' : 'play'));
      this.btnStart.classList.toggle('usr-active', state === ReaderState.PLAYING);
    }

    dispose() {
      document.removeEventListener('fullscreenchange', this._fullscreenChangeHandler);
      this.element.remove();
    }
  }

  /**
   * Hilfe-Overlay: erklärt kompakt Funktionen und Tastenkürzel. Ein-/ausblendbar
   * über das ?-Icon in der Toolbar. Singleton – erneuter Aufruf schließt es wieder.
   */
  class HelpPanel {
    static toggle(settings, theme) {
      const existing = document.querySelector(`.${NS}-help-modal`);
      if (existing) { existing.remove(); return; }
      const hk = settings.get('hotkeys');
      const themeClass = theme === 'light' ? 'usr-theme-light' : '';

      const shortcuts = [
        [hotkeyLabel(hk.togglePause), 'Start / Pause'],
        [`${hotkeyLabel(hk.prev)} / ${hotkeyLabel(hk.next)}`, 'Ein Wort zurück / vor'],
        [`⇧${hotkeyLabel(hk.prev)} / ⇧${hotkeyLabel(hk.next)}`, 'Vorherige / nächste Überschrift'],
        [`${hotkeyLabel(hk.prevChapter)} / ${hotkeyLabel(hk.nextChapter)}`, 'Überschrift (Alternative)'],
        [`${hotkeyLabel(hk.faster)} / ${hotkeyLabel(hk.slower)}`, 'Schneller / langsamer (WPM)'],
        [hotkeyLabel(hk.fullscreen), 'Vollbild an/aus'],
        [hotkeyLabel(hk.superFocus), 'Ansicht wechseln: Voll → Kompakt → Fokus'],
        [hotkeyLabel(hk.toggleSound), 'Klickton ein/aus'],
        [hotkeyLabel(hk.close), 'Reader schließen'],
      ];
      const features = [
        ['ORP', 'Optimaler Fixationspunkt – hebt den idealen Buchstaben hervor.'],
        ['Fixpunkt', 'Hält den Fokusbuchstaben an fester Position statt mitzuwandern.'],
        ['AutoScroll', 'Scrollt den Originaltext synchron mit; manuelles Scrollen pausiert.'],
        ['Adaptiv', 'Passt das Tempo je Inhalt an (Überschrift, Zahl, langes Wort …).'],
        ['Satzz.-Pausen', 'Kurze Extrapause nach Satzzeichen.'],
        ['Überspringen', 'Bildunterschriften, Quellen oder Tabellen beim Lesen auslassen.'],
        ['Quelltext markieren', 'Hebt das aktuelle Wort im Originaltext hervor.'],
        ['Listen-Streifen', 'Farbstreifen + „-" je Listenebene links im Textfeld.'],
        ['Klickton', 'Kurzer Ton je Wort, mit wählbarer Klangfarbe.'],
        ['Vorlesen', 'Reiner Vorlesemodus: die Sprachausgabe liest den Text am Stück vor (flüssig, nicht abgehackt), markiert die Stelle im Text und ignoriert WPM. Eigenes „Vorlesetempo".'],
        ['Fokus', 'Rest der Seite abdunkeln / verwischen / ausblenden.'],
        ['Ansichten', 'Voll (alles) → Kompakt (Wort + Fortschritt + Infoleiste) → Fokus (nur das Wort).'],
        ['Klassik-Ton', 'Easter-Egg: spielt je Wort eine Note eines gemeinfreien Werks; Titel in der Infoleiste.'],
        ['Pause-Regler', 'Mindest-Anzeigedauer für übersprungene Tabellen/Bilder.'],
      ];

      const mkList = (rows, keyClass) => Utils.el('div', { class: `${NS}-help-grid` },
        rows.flatMap(([k, v]) => [
          Utils.el('div', { class: keyClass, text: k }),
          Utils.el('div', { text: v }),
        ]));

      const card = Utils.el('div', { class: `${NS}-help-card ${themeClass}` }, [
        Utils.el('h2', { text: 'Universal SpeedReader – Hilfe' }),
        Utils.el('h3', { text: 'Tastenkürzel' }),
        mkList(shortcuts, `${NS}-help-key`),
        Utils.el('h3', { text: 'Funktionen' }),
        mkList(features, `${NS}-help-feat`),
        Utils.el('button', { class: `${NS}-btn ${NS}-help-close`, text: 'Schließen', onclick: () => modal.remove() }),
      ]);
      const modal = Utils.el('div', {
        class: `${NS}-help-modal ${NS}-ui ${themeClass}`,
        onclick: (e) => { if (e.target === modal) modal.remove(); },
      }, [card]);
      document.body.appendChild(modal);
    }
  }

  /** Zeigt am Ende einer Lesesession eine Statistik-Übersicht als modales Overlay. */
  class StatsPanel {
    static show(stats, theme, onClose, autoCloseMs = 0) {
      const themeClass = theme === 'light' ? 'usr-theme-light' : '';
      const rows = [
        ['Gesamtzeit', Utils.formatTime(stats.totalTimeSeconds)],
        ['Ø WPM', `${stats.averageWpm}`],
        ['Effektive WPM', `${stats.effectiveWpm}`],
        ['Wörter gesamt', `${stats.wordCount}`],
        ['Bilder', `${stats.imageCount}`],
        ['Tabellen', `${stats.tableCount}`],
        ['Codeblöcke', `${stats.codeBlockCount}`],
        ['Zeitersparnis (gesch.)', Utils.formatTime(stats.timeSavedSeconds)],
      ];

      const grid = Utils.el('div', { class: `${NS}-stats-grid` });
      for (const [label, value] of rows) {
        grid.appendChild(Utils.el('div', { text: label }));
        grid.appendChild(Utils.el('div', { text: value }));
      }

      const closeBtn = Utils.el('button', { class: `${NS}-btn`, text: 'Schließen', onclick: () => modal.remove() });
      const card = Utils.el('div', { class: `${NS}-stats-card ${themeClass}` }, [
        Utils.el('h2', { text: 'Lesestatistik' }),
        grid,
        closeBtn,
      ]);
      const modal = Utils.el('div', { class: `${NS}-stats-modal ${NS}-ui`, onclick: (e) => { if (e.target === modal) { modal.remove(); onClose?.(); } } }, [card]);
      closeBtn.addEventListener('click', () => onClose?.());
      document.body.appendChild(modal);

      if (autoCloseMs > 0) {
        setTimeout(() => {
          if (!modal.isConnected) return; // Nutzer hat bereits manuell geschlossen.
          modal.remove();
          onClose?.();
        }, autoCloseMs);
      }
    }
  }

  // ===========================================================================
  // 12. KEYBOARD CONTROLLER
  // ===========================================================================

  /** Bindet globale Tastatur-Shortcuts an EventBus-Events, solange der Reader aktiv ist. */
  class KeyboardController {
    constructor(eventBus, settings) {
      this.bus = eventBus;
      this.settings = settings;
      this._active = false;
      this._handler = this._handleKeydown.bind(this);
    }

    enable() {
      if (this._active) return;
      this._active = true;
      // Auf window statt document registrieren: In Safari greift preventDefault()
      // auf einem document-Capture-Listener bei Pfeiltasten/Space teils nicht
      // zuverlässig gegen das native Scrollen – window ist die früheste mögliche
      // Capture-Stufe und wird von WebKit konsistenter respektiert.
      window.addEventListener('keydown', this._handler, { capture: true, passive: false });
    }

    disable() {
      this._active = false;
      window.removeEventListener('keydown', this._handler, { capture: true });
    }

    _handleKeydown(evt) {
      // Keine Hotkeys auslösen, wenn Nutzer gerade in Formularfeldern tippt.
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) {
        if (evt.code !== 'Escape') return;
      }
      // Kombinationen mit Ctrl/Cmd/Alt gehören dem Browser/OS (z. B. Cmd+F = Suchen),
      // nicht uns – sonst würde z. B. das Vollbild-Hotkey "F" mit Strg/Cmd+F kollidieren.
      if ((evt.ctrlKey || evt.metaKey || evt.altKey) && evt.code !== 'Escape') return;

      // preventDefault + stopPropagation zusammen: verhindert nicht nur die
      // native Browser-Aktion (z. B. Seiten-Scroll bei Pfeiltasten), sondern
      // auch eigene Tastatur-/Scroll-Handler der Seite, die sonst gleichzeitig
      // reagieren und den Lesefluss stören könnten (z. B. Pfeil hoch/runter,
      // die zusätzlich zum Tempo-Wechsel den Container hoch-/runterscrollen).
      const hotkeys = this.settings.get('hotkeys');

      // Umschalt+Pfeil links/rechts = vorherige/nächste Überschrift. Alternative zu
      // Bild↑/Bild↓, die auf vielen Mac-Tastaturen fehlen. Vor dem normalen Wort-
      // Schritt (Pfeil ohne Umschalt) abfangen.
      if (evt.shiftKey && (evt.code === hotkeys.prev || evt.code === hotkeys.next)) {
        evt.preventDefault();
        evt.stopPropagation();
        this.bus.emit(evt.code === hotkeys.prev ? 'ui:prev-chapter' : 'ui:next-chapter');
        this.bus.emit('ui:hotkey-fired');
        return;
      }

      switch (evt.code) {
        case hotkeys.togglePause:
          evt.preventDefault();
          evt.stopPropagation();
          this.bus.emit('ui:toggle');
          break;
        case hotkeys.prev:
          evt.preventDefault();
          evt.stopPropagation();
          this.bus.emit('ui:prev');
          break;
        case hotkeys.next:
          evt.preventDefault();
          evt.stopPropagation();
          this.bus.emit('ui:next');
          break;
        case hotkeys.faster:
          evt.preventDefault();
          evt.stopPropagation();
          this.bus.emit('ui:wpm-delta', { delta: 25 });
          break;
        case hotkeys.slower:
          evt.preventDefault();
          evt.stopPropagation();
          this.bus.emit('ui:wpm-delta', { delta: -25 });
          break;
        case hotkeys.nextChapter:
          evt.preventDefault();
          evt.stopPropagation();
          this.bus.emit('ui:next-chapter');
          break;
        case hotkeys.prevChapter:
          evt.preventDefault();
          evt.stopPropagation();
          this.bus.emit('ui:prev-chapter');
          break;
        case hotkeys.close:
          evt.preventDefault();
          evt.stopPropagation();
          this.bus.emit('ui:close');
          break;
        default: {
          // Buchstaben-Hotkeys separat über evt.key matchen (layout-abhängig,
          // z. B. 'f'/'z') statt über evt.code (QWERTY-Tastenposition) – siehe
          // Kommentar bei DEFAULT_SETTINGS.hotkeys.fullscreen weiter oben.
          const key = (evt.key || '').toLowerCase();
          if (key && key === hotkeys.fullscreen) {
            evt.preventDefault();
            evt.stopPropagation();
            this.bus.emit('ui:toggle-fullscreen');
          } else if (key && key === hotkeys.superFocus) {
            evt.preventDefault();
            evt.stopPropagation();
            this.bus.emit('ui:cycle-view');
          } else if (key && key === hotkeys.toggleSound) {
            evt.preventDefault();
            evt.stopPropagation();
            this.bus.emit('ui:toggle-sound-hotkey');
          } else {
            return;
          }
        }
      }
      // Sicherheitsnetz für Browser, die einen minimalen Restscroll trotz
      // preventDefault() durchlassen (siehe Safari-Hinweis oben in enable()).
      this.bus.emit('ui:hotkey-fired');
    }
  }

  /**
   * Fokusmodus: dimmt/verwischt/versteckt alle DOM-Elemente außerhalb des
   * gewählten Lese-Containers, damit visuelle Ablenkung minimiert wird.
   *
   * Vorgehen: Ausgehend vom Container wird die Kette der Vorfahren bis zum
   * <html>-Element gebildet. Für jede Ebene dieser Kette werden alle
   * Geschwister-Elemente (die nicht selbst Teil der Kette sind) markiert.
   * So bleibt einzig der Pfad zum Container unangetastet sichtbar.
   */
  class FocusModeController {
    constructor() {
      this._modifiedElements = [];
      this._activeMode = 'off';
    }

    apply(container, mode) {
      this.clear();
      this._activeMode = mode;
      if (!container || mode === 'off') return;

      const chain = new Set();
      let el = container;
      while (el) {
        chain.add(el);
        if (el === document.documentElement) break;
        el = el.parentElement;
      }

      for (const ancestor of chain) {
        const parent = ancestor.parentElement;
        if (!parent) continue;
        for (const sibling of parent.children) {
          if (sibling === ancestor || chain.has(sibling)) continue;
          // Eigene UI-Elemente (FAB, Hinweise, Stats-Modal) sind body-Kinder außerhalb
          // der Container-Kette und dürfen nicht mitgedimmt werden.
          if (typeof sibling.className === 'string' && sibling.className.includes(NS)) continue;
          sibling.classList.add(`${NS}-focus-${mode}`);
          this._modifiedElements.push(sibling);
        }
      }
    }

    clear() {
      for (const el of this._modifiedElements) {
        el.classList.remove(`${NS}-focus-dim`, `${NS}-focus-blur`, `${NS}-focus-hide`);
      }
      this._modifiedElements = [];
      this._activeMode = 'off';
    }
  }

  /**
   * Hebt das aktuell vorgelesene Wort dezent im Original-Quelltext hervor.
   * Nutzt die CSS Custom Highlight API (Highlight/CSS.highlights), sofern der
   * Browser sie unterstützt – dadurch keine DOM-Mutation nötig (kein Risiko,
   * den MutationObserver für Lazy-Reparse auszulösen, keine Layout-Seiteneffekte).
   * Auf nicht unterstützten Browsern ist die Klasse ein No-Op.
   */
  class SourceHighlighter {
    static HIGHLIGHT_NAME = `${NS}-current-word`;

    constructor() {
      this._supported = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
      if (this._supported) {
        this._highlight = new Highlight();
        CSS.highlights.set(SourceHighlighter.HIGHLIGHT_NAME, this._highlight);
      }
    }

    /** Hebt das Wort mit gegebenem Block + block-lokalem Token-Index hervor. */
    highlight(block, localIndex) {
      if (!this._supported) return;
      this._highlight.clear();
      if (!block || localIndex == null) return;
      const wordRange = block.getWordRanges()[localIndex];
      if (!wordRange) return;
      try {
        const range = new Range();
        range.setStart(wordRange.startNode, wordRange.startOffset);
        range.setEnd(wordRange.endNode, wordRange.endOffset);
        this._highlight.add(range);
      } catch {
        // Range kann ungültig werden, falls die Seite den Text zwischenzeitlich verändert hat.
      }
    }

    clear() {
      if (!this._supported) return;
      this._highlight.clear();
    }

    dispose() {
      if (!this._supported) return;
      this._highlight.clear();
      CSS.highlights.delete(SourceHighlighter.HIGHLIGHT_NAME);
    }
  }

  // ===========================================================================
  // 13. APP (ORCHESTRIERUNG / BOOTSTRAP)
  // ===========================================================================

  /**
   * Oberste Orchestrierungsschicht. Verdrahtet alle Module über den EventBus,
   * verwaltet den Lebenszyklus einer Lese-Session (Auswahl -> Parsen -> Lesen
   * -> Aufräumen) und persistiert die letzte Position.
   */
  class App {
    constructor() {
      this.settings = new SettingsManager();
      this.bus = new EventBus();
      this.speedModel = new SpeedModel(this.settings);
      this.reader = new ReaderEngine(this.bus, this.settings, this.speedModel);
      this.scrollEngine = new ScrollEngine(this.settings);
      this.domParser = new DomParser(this.bus, this.settings);
      this.keyboard = new KeyboardController(this.bus, this.settings);
      this.focusMode = new FocusModeController();
      this.sourceHighlighter = new SourceHighlighter();
      this.soundEngine = new SoundEngine(this.settings);
      this.soundEngine.onMelodyChange = (name) => this.bus.emit('sound:melody', { name, url: SoundEngine.WIKI[name] || '' });
      this.readAloud = new ReadAloudEngine(this.bus, this.settings);
      // Sprachausgabe treibt Position: jedes gesprochene Wort markiert die Stelle
      // im Text und aktualisiert die Anzeige (über seekToIndex → reader:token).
      this.readAloud.onIndex = (i) => this.reader.seekToIndex(i);
      this.readAloud.onStateChange = (s) => {
        const map = { playing: ReaderState.PLAYING, paused: ReaderState.PAUSED, idle: ReaderState.STOPPED, finished: ReaderState.FINISHED };
        this.bus.emit('reader:state', { state: map[s] || ReaderState.STOPPED });
      };

      this.container = null;
      this.toolbar = null;
      this.selectionOverlay = null;
      this._mutationObserver = null;

      this._bindBusHandlers();
    }

    init() {
      injectStyles();
      this.floatingButton = new FloatingButton(() => this._enterSelectionMode());
      try {
        GM_registerMenuCommand?.('SpeedReader: Container wählen', () => this._enterSelectionMode());
      } catch { /* Menu-Command ist optional, manche Umgebungen unterstützen es nicht. */ }
    }

    // --- Auswahlmodus -------------------------------------------------------

    _enterSelectionMode() {
      // Pro Seite darf immer nur eine Reader-Session aktiv sein (verhindert doppelte
      // Toolbars/Sessions, die sich gegenseitig beim Auto-Scroll stören würden).
      if (this.container || this.selectionOverlay) return;
      this.selectionOverlay = new SelectionOverlay(
        (container) => { this.selectionOverlay = null; this._startSession(container); },
        () => { this.selectionOverlay = null; }
      );
      this.selectionOverlay.start();
    }

    // --- Session-Lebenszyklus ------------------------------------------------

    _startSession(container) {
      try {
        this.container = container;
        const blocks = this.domParser.parse(container);
        if (blocks.length === 0) {
          alert('Universal SpeedReader: Im gewählten Bereich wurde kein lesbarer Text gefunden.');
          return;
        }
        this.reader.loadBlocks(blocks);
        this.readAloud.load(this.reader.stream);
        this.scrollEngine.attach(container);
        this.scrollEngine.watchUserScroll(() => this.reader.pause());
        // Container-Auswahl ist eine Nutzergeste – hier den AudioContext vorwärmen,
        // damit der erste Klickton ohne Verzögerung kommt.
        this.soundEngine.warmUp();

        this.toolbar = new Toolbar(this.bus, this.settings);
        this._mountToolbar();
        this.keyboard.enable();
        this._observeMutations(container);
        this._restoreLastPosition();
        this.focusMode.apply(container, this.settings.get('focusMode'));
        this.floatingButton?.hide();

        this.bus.emit('reader:token', this._currentTokenSnapshot());
      } catch (err) {
        console.error(`[${NS}] Fehler beim Start der Session:`, err);
        alert('Universal SpeedReader: Beim Starten ist ein Fehler aufgetreten. Details in der Konsole.');
        this._teardownSession();
      }
    }

    _currentTokenSnapshot() {
      // Initiales Rendern des ersten Wortes ohne Zeitfortschritt zu triggern.
      const entry = this.reader.stream[0];
      return {
        token: entry?.token || { text: '', punctuation: null, isNumber: false, letterCount: 0 },
        block: entry?.block || null,
        localIndex: entry?.localIndex ?? 0,
        index: 0,
        total: this.reader.totalWords,
        progress: 0,
        remainingSeconds: (this.reader.totalWords * 60) / this.reader.currentWpm,
        chapter: this.reader.chapters[0] || null,
      };
    }

    _mountToolbar() {
      // Fest im Viewport (position: fixed via CSS) statt im Container verankert –
      // die Container-Referenz wird nicht mehr benötigt, top/bottom steuert nur noch die CSS-Klasse.
      if (!this.toolbar.element.isConnected) document.body.appendChild(this.toolbar.element);
      this._reserveSpaceForToolbar();
    }

    /**
     * Reserviert am oberen bzw. unteren Seitenrand Platz in Höhe der Toolbar,
     * damit der fixierte Reader keinen Seiteninhalt dauerhaft verdeckt. Die
     * Toolbar-Höhe variiert (Zeilenumbruch bei schmalem Viewport, Superfokus),
     * daher via ResizeObserver nachgeführt. Im Vollbildmodus keine Reservierung
     * (der Reader soll dort bewusst die ganze Seite einnehmen).
     */
    _reserveSpaceForToolbar() {
      if (!this.toolbar) return;
      const el = this.toolbar.element;
      if (this._originalBodyPadding == null) {
        this._originalBodyPadding = {
          top: document.body.style.paddingTop,
          bottom: document.body.style.paddingBottom,
        };
      }
      const apply = () => {
        // beide Seiten zunächst auf Ursprung zurücksetzen, dann die aktive setzen.
        document.body.style.paddingTop = this._originalBodyPadding.top;
        document.body.style.paddingBottom = this._originalBodyPadding.bottom;
        if (el.classList.contains('usr-fullscreen-mode')) {
          this.scrollEngine.setReservedInsets(0, 0);
          return;
        }
        const gap = el.getBoundingClientRect().height + 16;
        if (this.settings.get('toolbarPosition') === 'bottom') {
          document.body.style.paddingBottom = `${gap}px`;
          this.scrollEngine.setReservedInsets(0, gap);
        } else {
          document.body.style.paddingTop = `${gap}px`;
          this.scrollEngine.setReservedInsets(gap, 0);
        }
      };
      apply();
      this._toolbarResizeObserver?.disconnect();
      this._toolbarResizeObserver = new ResizeObserver(() => apply());
      this._toolbarResizeObserver.observe(el);
    }

    _releaseToolbarSpace() {
      this._toolbarResizeObserver?.disconnect();
      this._toolbarResizeObserver = null;
      this.scrollEngine.setReservedInsets(0, 0);
      if (this._originalBodyPadding) {
        document.body.style.paddingTop = this._originalBodyPadding.top;
        document.body.style.paddingBottom = this._originalBodyPadding.bottom;
        this._originalBodyPadding = null;
      }
    }

    _observeMutations(container) {
      // Lazy-Reparse bei dynamisch nachgeladenem Inhalt (z. B. Infinite Scroll),
      // gedrosselt um Performance-Einbußen bei sehr aktiven Seiten zu vermeiden.
      this._mutationObserver?.disconnect();
      this._debouncedReparse = Utils.debounce(() => this._reparseContainer(), 800);

      this._mutationObserver = new MutationObserver((mutations) => {
        const relevant = mutations.some((m) => m.addedNodes.length > 0 || m.removedNodes.length > 0);
        if (relevant) this._debouncedReparse();
      });
      this._mutationObserver.observe(container, { childList: true, subtree: true });
    }

    /** Erneutes Parsen des aktuellen Containers, z. B. bei Filter-Toggles (Bildunterschriften/Quellen). */
    _reparseContainer() {
      if (!this.container?.isConnected) return;
      const scrollRatio = this.reader.totalWords ? this.reader.index / this.reader.totalWords : 0;
      const blocks = this.domParser.parse(this.container);
      this.reader.loadBlocks(blocks);
      this.readAloud.load(this.reader.stream);
      this.reader.seekToIndex(Math.floor(scrollRatio * this.reader.totalWords));
    }

    _restoreLastPosition() {
      const key = Utils.hashString(location.href + document.title);
      const saved = this.settings.getLastPosition(key);
      if (saved && saved.tokenIndex < this.reader.totalWords) {
        this.reader.seekToIndex(saved.tokenIndex);
      }
      this._positionKey = key;
    }

    _persistPosition() {
      if (!this._positionKey) return;
      this.settings.saveLastPosition(this._positionKey, {
        tokenIndex: this.reader.index,
        url: location.href,
        title: document.title,
      });
    }

    _resyncScroll() {
      const entry = this.reader.stream[this.reader.index];
      if (this.settings.get('autoScroll') && entry?.block?.element) {
        const wordRange = entry.block.getWordRanges?.()[entry.localIndex];
        this.scrollEngine.scrollToElement(entry.block.element, wordRange);
      }
    }

    /**
     * Führt eine Positions-Bewegung (vor/zurück/Kapitel/Seek) einheitlich aus:
     * pausiert den RSVP-Reader, bewegt die Position, und setzt im Vorlesemodus
     * die Sprachausgabe an der neuen Stelle fort, falls sie gerade lief.
     */
    _navigate(move) {
      const wasReading = this.settings.get('readAloudMode') && this.readAloud.state === 'playing';
      this.reader.pause();
      move();
      if (wasReading) this.readAloud.play(this.reader.index);
    }

    _teardownSession() {
      if (document.fullscreenElement) document.exitFullscreen?.();
      this.reader.stop();
      this.readAloud.stop();
      this.scrollEngine.stop();
      this.scrollEngine.unwatchUserScroll();
      this.keyboard.disable();
      this._mutationObserver?.disconnect();
      this.domParser.dispose();
      this._releaseToolbarSpace();
      this.toolbar?.dispose();
      this.toolbar = null;
      this.container = null;
      this.focusMode.clear();
      this.sourceHighlighter.clear();
      this.floatingButton?.show();
    }

    // --- Bus-Handler ----------------------------------------------------------

    _bindBusHandlers() {
      this.bus.on('ui:toggle', () => {
        if (this.settings.get('readAloudMode')) {
          // Im Vorlesemodus steuert die Sprachausgabe; immer ab der aktuellen Stelle.
          if (this.readAloud.state === 'playing') this.readAloud.pause();
          else { this.readAloud.play(this.reader.index); this._resyncScroll(); }
          return;
        }
        this.reader.togglePause();
        // Nach manuellem Scrollen (das den Reader pausiert hat) beim Fortsetzen
        // wieder zur korrekten Leseposition zurückscrollen.
        if (this.reader.state === ReaderState.PLAYING) this._resyncScroll();
      });
      this.bus.on('ui:stop', () => { this.reader.stop(); this.readAloud.stop(); this._persistPosition(); });
      this.bus.on('ui:next', () => this._navigate(() => this.reader.next()));
      this.bus.on('ui:prev', () => this._navigate(() => this.reader.prev()));
      this.bus.on('ui:next-chapter', () => this._navigate(() => this.reader.nextChapter()));
      this.bus.on('ui:prev-chapter', () => this._navigate(() => this.reader.prevChapter()));
      this.bus.on('ui:wpm-set', ({ wpm }) => { this.settings.set('wpm', wpm); this.bus.emit('reader:wpm', { wpm }); });
      this.bus.on('ui:wpm-delta', ({ delta }) => this.reader.changeSpeed(delta));

      this.bus.on('ui:seek-ratio', ({ ratio }) => {
        this._navigate(() => this.reader.seekToIndex(Math.floor(ratio * this.reader.totalWords)));
      });

      this.bus.on('ui:toggle-orp', ({ value }) => { this.settings.set('orpEnabled', value); this.bus.emit('settings:orp-changed', { value }); });
      this.bus.on('ui:toggle-orp-fixed', ({ value }) => { this.settings.set('orpFixedPoint', value); this.bus.emit('settings:orp-fixed-changed', { value }); });
      this.bus.on('ui:toggle-autoscroll', ({ value }) => this.settings.set('autoScroll', value));
      this.bus.on('ui:toggle-adaptive', ({ value }) => this.settings.set('adaptiveSpeed', value));
      this.bus.on('ui:toggle-punct', ({ value }) => this.settings.set('punctuationPauses', value));

      this.bus.on('ui:toggle-captions', ({ value }) => { this.settings.set('skipImageCaptions', value); this._reparseContainer(); });
      this.bus.on('ui:toggle-citations', ({ value }) => { this.settings.set('skipCitations', value); this._reparseContainer(); });
      this.bus.on('ui:toggle-tables', ({ value }) => { this.settings.set('skipTables', value); this._reparseContainer(); });

      this.bus.on('ui:toggle-source-highlight', ({ value }) => {
        this.settings.set('highlightSourceWord', value);
        if (!value) this.sourceHighlighter.clear();
      });

      this.bus.on('ui:toggle-list-zebra', ({ value }) => this.settings.set('listZebraStripes', value));

      this.bus.on('ui:hotkey-fired', () => this.scrollEngine.suppressUserScrollDetection());

      this.bus.on('ui:font-size-set', ({ size }) => {
        this.settings.set('displayFontSize', size);
        this.bus.emit('settings:font-size-changed', { size });
      });

      this.bus.on('ui:placeholder-pause-set', ({ ms }) => {
        this.settings.set('placeholderPauseMs', ms);
        this.bus.emit('settings:placeholder-pause-changed', { ms });
      });

      this.bus.on('ui:toggle-click-sound', ({ value }) => {
        this.settings.set('clickSoundEnabled', value);
        if (value) this.soundEngine.warmUp();
        this.bus.emit('settings:click-sound-changed', { value });
      });

      this.bus.on('ui:toggle-sound-hotkey', () => {
        const v = !this.settings.get('clickSoundEnabled');
        this.settings.set('clickSoundEnabled', v);
        if (v) this.soundEngine.warmUp();
        this.bus.emit('settings:click-sound-changed', { value: v });
      });

      this.bus.on('ui:toggle-read-aloud', ({ value }) => {
        this.settings.set('readAloudMode', value);
        // Beim Umschalten laufende Wiedergabe/Sprachausgabe stoppen (sauberer Moduswechsel).
        this.reader.pause();
        this.readAloud.stop();
        this.bus.emit('settings:read-aloud-changed', { value });
      });
      this.bus.on('ui:read-aloud-rate-set', ({ rate }) => {
        this.settings.set('readAloudRate', rate);
        this.bus.emit('settings:read-aloud-rate-changed', { rate });
        // Bei laufender Ausgabe sofort mit neuem Tempo ab aktueller Stelle fortsetzen.
        if (this.settings.get('readAloudMode') && this.readAloud.state === 'playing') {
          this.readAloud.play(this.reader.index);
        }
      });
      this.bus.on('ui:read-aloud-voice-set', ({ voiceURI }) => {
        this.settings.set('readAloudVoiceURI', voiceURI);
        // Neue Stimme sofort übernehmen, falls gerade vorgelesen wird.
        if (this.settings.get('readAloudMode') && this.readAloud.state === 'playing') {
          this.readAloud.play(this.reader.index);
        }
      });

      this.bus.on('ui:focus-mode-set', ({ mode }) => {
        this.settings.set('focusMode', mode);
        if (this.container) this.focusMode.apply(this.container, mode);
      });

      this.bus.on('ui:toggle-position', () => {
        const current = this.settings.get('toolbarPosition');
        const next = current === 'top' ? 'bottom' : 'top';
        this.settings.set('toolbarPosition', next);
        if (this.toolbar && this.container) {
          this.toolbar.element.classList.remove('usr-pos-top', 'usr-pos-bottom');
          this.toolbar.element.classList.add(next === 'top' ? 'usr-pos-top' : 'usr-pos-bottom');
          this._mountToolbar();
        }
      });

      this.bus.on('ui:toggle-fullscreen', () => {
        // Ganzseiten-Vollbild statt nur den Container – Toolbar (an document.body
        // gehängt) und Container bleiben so beide sichtbar, da beide Nachfahren
        // von <html> sind (die Fullscreen API blendet alles andere aus).
        if (document.fullscreenElement) {
          document.exitFullscreen?.();
        } else {
          document.documentElement.requestFullscreen?.().catch((err) => {
            console.error(`[${NS}] Vollbild fehlgeschlagen:`, err);
          });
        }
      });

      this.bus.on('ui:cycle-view', () => {
        const order = ['full', 'compact', 'focus'];
        const cur = order.indexOf(this.settings.get('viewMode'));
        const next = order[(cur + 1) % order.length];
        this.settings.set('viewMode', next);
        this.bus.emit('settings:view-changed', { mode: next });
      });

      this.bus.on('ui:toggle-help', () => HelpPanel.toggle(this.settings, this.settings.get('theme')));

      this.bus.on('ui:click-sound-variant-set', ({ variant }) => {
        this.settings.set('clickSoundVariant', variant);
        this.bus.emit('settings:click-sound-variant-changed', { variant });
      });

      this.bus.on('ui:toggle-show-stats', ({ value }) => this.settings.set('showStatsOnFinish', value));
      this.bus.on('ui:toggle-auto-close', ({ value }) => this.settings.set('autoCloseAfterFinish', value));

      this.bus.on('ui:close', () => {
        this._persistPosition();
        this._teardownSession();
      });

      // Synchronisiert bei jedem angezeigten Wort den Ursprungscontainer via ScrollEngine.
      this.bus.on('reader:token', (data) => {
        if (this.settings.get('autoScroll') && data.block?.element) {
          const wordRange = data.block.getWordRanges?.()[data.localIndex];
          this.scrollEngine.scrollToElement(data.block.element, wordRange);
        }
        if (this.settings.get('highlightSourceWord')) {
          this.sourceHighlighter.highlight(data.block, data.localIndex);
        } else {
          this.sourceHighlighter.clear();
        }
        // Im Vorlesemodus keinen Klickton zusätzlich zur Sprachausgabe.
        if (!this.settings.get('readAloudMode')) this.soundEngine.playTick();
      });

      this.bus.on('reader:finished', (stats) => {
        this._persistPosition();
        const showStats = this.settings.get('showStatsOnFinish');
        const autoClose = this.settings.get('autoCloseAfterFinish');
        if (showStats) {
          StatsPanel.show(
            stats, this.settings.get('theme'),
            () => { if (autoClose) this._teardownSession(); },
            autoClose ? this.settings.get('autoCloseDelayMs') : 0
          );
        } else if (autoClose) {
          this._teardownSession();
        }
      });
    }
  }

  // ===========================================================================
  // BOOTSTRAP
  // ===========================================================================

  function bootstrap() {
    // Verhindert doppelte Initialisierung (z. B. Mehrfach-Injektion durch den
    // Userscript-Manager oder erneutes Ausführen bei SPA-Navigation).
    if (window[`__${NS}_loaded`]) return;
    window[`__${NS}_loaded`] = true;

    try {
      const app = new App();
      app.init();
    } catch (err) {
      console.error(`[${NS}] Initialisierung fehlgeschlagen:`, err);
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    bootstrap();
  } else {
    window.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  }
})();
