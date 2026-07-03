// ==UserScript==
// @name         Universal SpeedReader
// @namespace    https://github.com/hubmey/tm_speedreader.git
// @version      1.10.0
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
    displayFontSize: 30,      // Schriftgröße (px) der Wortanzeige
    minFontSize: 14,
    maxFontSize: 72,
    focusMode: 'off',         // 'off' | 'dim' | 'blur' | 'hide' – Behandlung von Elementen außerhalb des Containers
    highlightSourceWord: true, // aktuelles Wort dezent im Original-Quelltext hervorheben
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

  // ===========================================================================
  // 1. UTILS
  // ===========================================================================

  /**
   * Sammlung zustandsloser Hilfsfunktionen. Statische Klasse statt loser
   * Funktionen, damit nichts in den globalen Scope der Seite entweicht.
   */
  class Utils {
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
    static visibleTextContent(element) {
      let text = '';
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
          return Utils.isElementVisible(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      let node;
      while ((node = walker.nextNode())) text += node.nodeValue;
      return text;
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
    constructor({ element, type, text, speedFactor, highlightable = false, isPlaceholder = false }) {
      this.id = Utils.uuid();
      this.element = element;
      this.type = type;
      this.tokens = Tokenizer.tokenizeText(text);
      this.charCount = text.length;
      this.wordCount = this.tokens.length;
      this.speedFactor = speedFactor;
      this.visible = true;
      this.highlightable = highlightable;
      this.isPlaceholder = isPlaceholder;
      this._cachedRect = null;
      this._wordRanges = null;
    }

    /**
     * Liefert je Token eine DOM-Range, die exakt das entsprechende Wort im
     * Original-Text abdeckt (für die Live-Hervorhebung im Quelltext).
     * Nur für Blöcke möglich, deren Anzeigetext 1:1 aus element.textContent
     * stammt (kein synthetischer/überschriebener Text wie bei Bild-Alt-Texten).
     * Lazy berechnet und gecacht, da ein TreeWalker-Durchlauf nötig ist.
     */
    getWordRanges() {
      if (this._wordRanges) return this._wordRanges;
      const ranges = [];
      if (!this.highlightable) {
        this._wordRanges = ranges;
        return ranges;
      }

      const walker = document.createTreeWalker(this.element, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
          // Muss exakt denselben Filter wie Utils.visibleTextContent() anwenden,
          // sonst driften Ranges und Token-Liste auseinander (Wörter unter
          // verschachtelten unsichtbaren Nachfahren dürfen hier nicht auftauchen).
          return Utils.isElementVisible(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });

      let currentStart = null;
      let lastNode = null;
      const flush = (endNode, endOffset) => {
        if (currentStart) ranges.push({ startNode: currentStart.node, startOffset: currentStart.offset, endNode, endOffset });
        currentStart = null;
      };

      let node;
      while ((node = walker.nextNode())) {
        lastNode = node;
        const text = node.nodeValue.replace(/ /g, ' ');
        for (let i = 0; i < text.length; i++) {
          if (/\s/.test(text[i])) {
            flush(node, i);
          } else if (currentStart === null) {
            currentStart = { node, offset: i };
          }
        }
      }
      if (lastNode) flush(lastNode, lastNode.nodeValue.length);

      // Sicherheitsnetz: bei Diskrepanz zur Tokenliste (z. B. exotische
      // Whitespace-Sonderfälle) lieber keine Hervorhebung als eine falsche.
      this._wordRanges = ranges.length === this.tokens.length ? ranges : [];
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
      if (!mapped) return null;

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

    _isFootnote(element) {
      const id = (element.id || '').toLowerCase();
      const cls = (element.className && typeof element.className === 'string' ? element.className : '').toLowerCase();
      return /footnote|fn-|fnref/.test(id) || /footnote/.test(cls) || element.getAttribute('role') === 'doc-footnote';
    }

    _makeBlock(element, type, speedFactor, overrideText, isPlaceholder = false) {
      // Nur wenn der Anzeigetext 1:1 dem Element-Textinhalt entspricht (kein
      // überschriebener/synthetischer Text) kann später im Quelltext hervorgehoben werden.
      const highlightable = overrideText === undefined;
      const text = overrideText ?? (element.getAttribute?.('alt') || Utils.visibleTextContent(element) || '');
      if (!text || !text.trim()) {
        // Bilder ohne Alt-Text erhalten einen Platzhalter, damit sie als Pause im Lesefluss erscheinen.
        if (type === BlockType.IMAGE || type === BlockType.VIDEO || type === BlockType.CANVAS || type === BlockType.SVG) {
          return new Block({ element, type, text: '[Bild]', speedFactor, highlightable: false, isPlaceholder: true });
        }
        return null;
      }
      return new Block({ element, type, text, speedFactor, highlightable, isPlaceholder });
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
    constructor(settings) {
      this.settings = settings;
      this._ctx = null;
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

    playTick() {
      if (!this.settings.get('clickSoundEnabled')) return;
      const ctx = this._ensureContext();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 1100;
      gain.gain.setValueAtTime(0.05, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.025);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.03);
    }

    dispose() {
      this._ctx?.close();
      this._ctx = null;
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
      this._easing = 0.18; // Anteil der Distanz, der pro Frame zurückgelegt wird.
      this._lastSetScrollTop = null;
      this._userScrollHandler = null;
      this._userScrollTarget = null;
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
        const current = this._getScrollTop();
        if (this._lastSetScrollTop != null && Math.abs(current - this._lastSetScrollTop) < 2) return;
        this.stop();
        onUserScroll();
      };
      target.addEventListener('scroll', this._userScrollHandler, { passive: true });
      this._userScrollTarget = target;
    }

    unwatchUserScroll() {
      if (this._userScrollTarget && this._userScrollHandler) {
        this._userScrollTarget.removeEventListener('scroll', this._userScrollHandler);
      }
      this._userScrollHandler = null;
      this._userScrollTarget = null;
    }

    /** Setzt das Scroll-Ziel anhand eines Blocks/Elements und startet die Animation. */
    scrollToElement(element) {
      if (!this._scrollParent || this.settings.get('scrollMode') === 'off') return;
      const ratio = this.settings.get('scrollTargetRatio');
      const parentRect = this._getParentViewportRect();
      const elRect = element.getBoundingClientRect();

      const currentScrollTop = this._getScrollTop();
      const elementTopRelativeToParent = elRect.top - parentRect.top + currentScrollTop;
      const desiredOffsetInViewport = parentRect.height * ratio;

      this._targetTop = Utils.clamp(
        elementTopRelativeToParent - desiredOffsetInViewport,
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
      const step = () => {
        if (this._targetTop == null) {
          this._rafId = null;
          return;
        }
        const current = this._getScrollTop();
        const delta = this._targetTop - current;
        if (Math.abs(delta) < 0.5) {
          this._setScrollTop(this._targetTop);
          this._rafId = null;
          return;
        }
        this._setScrollTop(current + delta * this._easing);
        this._rafId = requestAnimationFrame(step);
      };
      this._rafId = requestAnimationFrame(step);
    }

    stop() {
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = null;
      this._targetTop = null;
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
      }
      .${NS}-toolbar.usr-pos-top { top: 8px; }
      .${NS}-toolbar.usr-pos-bottom { bottom: 8px; }
      .${NS}-toolbar.usr-theme-light { --usr-bg: #f9fafb; --usr-fg: #111827; box-shadow: 0 4px 18px rgba(0,0,0,.12); }

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
        background: rgba(255,255,255,.08); color: inherit; border: none; border-radius: 6px;
        padding: 6px 10px; cursor: pointer; font-size: 13px; line-height: 1;
      }
      .${NS}-toolbar.usr-theme-light .${NS}-btn { background: rgba(0,0,0,.06); }
      .${NS}-btn:hover { background: rgba(255,255,255,.18); }
      .${NS}-toolbar.usr-theme-light .${NS}-btn:hover { background: rgba(0,0,0,.12); }
      .${NS}-btn.usr-active { background: #4f46e5; color: #fff; }

      .${NS}-slider { width: 120px; }
      .${NS}-toggle { display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; user-select: none; }
      .${NS}-stat { font-size: 11px; opacity: .85; white-space: nowrap; }
      .${NS}-spacer { flex: 1 1 auto; }
      .${NS}-select {
        background: rgba(255,255,255,.08); color: inherit; border: none; border-radius: 6px;
        padding: 5px 8px; font-size: 12px; cursor: pointer;
      }
      .${NS}-toolbar.usr-theme-light .${NS}-select { background: rgba(0,0,0,.06); }

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
    }

    _build() {
      const s = this.settings;
      const posClass = s.get('toolbarPosition') === 'bottom' ? 'usr-pos-bottom' : 'usr-pos-top';
      const themeClass = s.get('theme') === 'light' ? 'usr-theme-light' : '';

      this.wordBefore = Utils.el('span', { class: `${NS}-word-before` });
      this.wordFocus = Utils.el('span', { class: `${NS}-orp-focus` });
      this.wordAfter = Utils.el('span', { class: `${NS}-word-after` });
      this.refLine = Utils.el('div', { class: `${NS}-refline` });

      this.display = Utils.el('div', {
        class: `${NS}-display${s.get('orpFixedPoint') ? ' usr-orp-fixed' : ''}`,
        style: `font-size: ${s.get('displayFontSize')}px;`,
      }, [
        this.refLine, this.wordBefore, this.wordFocus, this.wordAfter,
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

      this.btnPrevChapter = Utils.el('button', { class: `${NS}-btn`, text: '⏪', title: 'Vorherige Überschrift (PageUp)', onclick: () => this.bus.emit('ui:prev-chapter') });
      this.btnPrev = Utils.el('button', { class: `${NS}-btn`, text: '⏮', title: 'Zurück', onclick: () => this.bus.emit('ui:prev') });
      this.btnStart = Utils.el('button', { class: `${NS}-btn`, text: '▶', title: 'Start/Pause', onclick: () => this.bus.emit('ui:toggle') });
      this.btnStop = Utils.el('button', { class: `${NS}-btn`, text: '⏹', title: 'Stopp', onclick: () => this.bus.emit('ui:stop') });
      this.btnNext = Utils.el('button', { class: `${NS}-btn`, text: '⏭', title: 'Vor', onclick: () => this.bus.emit('ui:next') });
      this.btnNextChapter = Utils.el('button', { class: `${NS}-btn`, text: '⏩', title: 'Nächste Überschrift (PageDown)', onclick: () => this.bus.emit('ui:next-chapter') });
      this.btnClose = Utils.el('button', { class: `${NS}-btn`, text: '✕', title: 'Schließen', onclick: () => this.bus.emit('ui:close') });

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
      this.toggleClickSound = this._makeToggle('Klickton', 'clickSoundEnabled', 'ui:toggle-click-sound');

      this.togglePosition = Utils.el('button', {
        class: `${NS}-btn`, text: s.get('toolbarPosition') === 'top' ? '⬇ Position' : '⬆ Position',
        title: 'Toolbar-Position wechseln',
        onclick: () => this.bus.emit('ui:toggle-position'),
      });

      this.btnFullscreen = Utils.el('button', {
        class: `${NS}-btn`, text: '⛶', title: 'Vollbild',
        onclick: () => this.bus.emit('ui:toggle-fullscreen'),
      });

      const controlsRow = Utils.el('div', { class: `${NS}-row` }, [
        this.btnPrevChapter, this.btnPrev, this.btnStart, this.btnStop, this.btnNext, this.btnNextChapter,
        Utils.el('span', { class: `${NS}-stat`, text: 'WPM' }), this.wpmSlider, this.statWpm,
        Utils.el('span', { class: `${NS}-stat`, text: 'Schrift' }), this.fontSizeSlider, this.statFontSize,
        Utils.el('span', { class: `${NS}-stat`, text: 'Platzh.-Pause' }), this.placeholderPauseSlider, this.statPlaceholderPause,
        Utils.el('div', { class: `${NS}-spacer` }),
        this.btnFullscreen, this.togglePosition, this.btnClose,
      ]);

      const toggleRow = Utils.el('div', { class: `${NS}-row` }, [
        this.toggleOrp, this.toggleOrpFixed, this.toggleScroll, this.toggleAdaptive, this.togglePunct,
        this.toggleCaptions, this.toggleCitations, this.toggleTables, this.toggleSourceHighlight,
        this.toggleClickSound, this.focusModeSelect,
      ]);

      const statsRow = Utils.el('div', { class: `${NS}-row` }, [
        this.statChapter, this.statWords, this.statPercent, this.statRemaining,
      ]);

      return Utils.el('div', { class: `${NS}-toolbar ${NS}-ui ${posClass} ${themeClass}` }, [
        this.display, this.progressTrack, controlsRow, toggleRow, statsRow,
      ]);
    }

    _makeToggle(label, settingKey, eventName) {
      const input = Utils.el('input', {
        type: 'checkbox',
        onchange: (e) => this.bus.emit(eventName, { value: e.target.checked }),
      });
      input.checked = !!this.settings.get(settingKey);
      const wrapper = Utils.el('label', { class: `${NS}-toggle` }, [input, document.createTextNode(label)]);
      wrapper._input = input;
      return wrapper;
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
      this._fullscreenChangeHandler = () => {
        const active = !!document.fullscreenElement;
        this.btnFullscreen.textContent = active ? '⛶ ✕' : '⛶';
        this.btnFullscreen.classList.toggle('usr-active', active);
      };
      document.addEventListener('fullscreenchange', this._fullscreenChangeHandler);
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
      const baseFontSize = this.settings.get('displayFontSize');
      const availableWidth = Math.max(0, this.display.clientWidth - 24);
      // + letter-spacing (0.5px/Zeichen, siehe CSS), das Canvas measureText nicht einrechnet.
      const fullWidth = this._measureTextWidth(text, baseFontSize) + text.length * 0.5;
      const minFontSize = Math.max(12, baseFontSize * 0.35);
      const fontSize = fullWidth > availableWidth && availableWidth > 0
        ? Math.max(minFontSize, baseFontSize * (availableWidth / fullWidth))
        : baseFontSize;
      this.display.style.fontSize = `${fontSize}px`;
    }

    _renderToken({ token, index, total, progress, remainingSeconds, chapter }) {
      this._applyFittingFontSize(token.text);
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
      this.btnStart.textContent = state === ReaderState.PLAYING ? '⏸' : '▶';
      this.btnStart.classList.toggle('usr-active', state === ReaderState.PLAYING);
    }

    dispose() {
      document.removeEventListener('fullscreenchange', this._fullscreenChangeHandler);
      this.element.remove();
    }
  }

  /** Zeigt am Ende einer Lesesession eine Statistik-Übersicht als modales Overlay. */
  class StatsPanel {
    static show(stats, theme, onClose) {
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
      document.addEventListener('keydown', this._handler, true);
    }

    disable() {
      this._active = false;
      document.removeEventListener('keydown', this._handler, true);
    }

    _handleKeydown(evt) {
      // Keine Hotkeys auslösen, wenn Nutzer gerade in Formularfeldern tippt.
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) {
        if (evt.code !== 'Escape') return;
      }

      // preventDefault + stopPropagation zusammen: verhindert nicht nur die
      // native Browser-Aktion (z. B. Seiten-Scroll bei Pfeiltasten), sondern
      // auch eigene Tastatur-/Scroll-Handler der Seite, die sonst gleichzeitig
      // reagieren und den Lesefluss stören könnten (z. B. Pfeil hoch/runter,
      // die zusätzlich zum Tempo-Wechsel den Container hoch-/runterscrollen).
      const hotkeys = this.settings.get('hotkeys');
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
      }
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
        this.scrollEngine.attach(container);
        this.scrollEngine.watchUserScroll(() => this.reader.pause());

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
        this.scrollEngine.scrollToElement(entry.block.element);
      }
    }

    _teardownSession() {
      if (document.fullscreenElement) document.exitFullscreen?.();
      this.reader.stop();
      this.scrollEngine.stop();
      this.scrollEngine.unwatchUserScroll();
      this.keyboard.disable();
      this._mutationObserver?.disconnect();
      this.domParser.dispose();
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
        this.reader.togglePause();
        // Nach manuellem Scrollen (das den Reader pausiert hat) beim Fortsetzen
        // wieder zur korrekten Leseposition zurückscrollen.
        if (this.reader.state === ReaderState.PLAYING) this._resyncScroll();
      });
      this.bus.on('ui:stop', () => { this.reader.stop(); this._persistPosition(); });
      this.bus.on('ui:next', () => { this.reader.pause(); this.reader.next(); });
      this.bus.on('ui:prev', () => { this.reader.pause(); this.reader.prev(); });
      this.bus.on('ui:next-chapter', () => { this.reader.pause(); this.reader.nextChapter(); });
      this.bus.on('ui:prev-chapter', () => { this.reader.pause(); this.reader.prevChapter(); });
      this.bus.on('ui:wpm-set', ({ wpm }) => { this.settings.set('wpm', wpm); this.bus.emit('reader:wpm', { wpm }); });
      this.bus.on('ui:wpm-delta', ({ delta }) => this.reader.changeSpeed(delta));

      this.bus.on('ui:seek-ratio', ({ ratio }) => {
        this.reader.pause();
        this.reader.seekToIndex(Math.floor(ratio * this.reader.totalWords));
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

      this.bus.on('ui:font-size-set', ({ size }) => {
        this.settings.set('displayFontSize', size);
        this.bus.emit('settings:font-size-changed', { size });
      });

      this.bus.on('ui:placeholder-pause-set', ({ ms }) => {
        this.settings.set('placeholderPauseMs', ms);
        this.bus.emit('settings:placeholder-pause-changed', { ms });
      });

      this.bus.on('ui:toggle-click-sound', ({ value }) => this.settings.set('clickSoundEnabled', value));

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

      this.bus.on('ui:close', () => {
        this._persistPosition();
        this._teardownSession();
      });

      // Synchronisiert bei jedem angezeigten Wort den Ursprungscontainer via ScrollEngine.
      this.bus.on('reader:token', (data) => {
        if (this.settings.get('autoScroll') && data.block?.element) {
          this.scrollEngine.scrollToElement(data.block.element);
        }
        if (this.settings.get('highlightSourceWord')) {
          this.sourceHighlighter.highlight(data.block, data.localIndex);
        } else {
          this.sourceHighlighter.clear();
        }
        this.soundEngine.playTick();
      });

      this.bus.on('reader:finished', (stats) => {
        this._persistPosition();
        StatsPanel.show(stats, this.settings.get('theme'), () => {});
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
