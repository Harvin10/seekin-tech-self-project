// Runs before first paint: theme, display mode and the owner's colour (ported from
// seekin-tech-erp apps/web/src/design/{theme,brand,color,display-mode}.ts).
(function () {
  'use strict';
  var root = document.documentElement;
  function read(k) { try { return localStorage.getItem('pp:' + k); } catch (e) { return null; } }
  function write(k, v) { try { localStorage.setItem('pp:' + k, v); } catch (e) { /* private mode */ } }

  var WHITE = { r: 255, g: 255, b: 255 }, BLACK = { r: 0, g: 0, b: 0 };
  function parseHex(input) {
    var hex = String(input || '').trim().replace(/^#/, '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  }
  function toHex(c) { return '#' + [c.r, c.g, c.b].map(function (v) { return v.toString(16).padStart(2, '0'); }).join(''); }
  function ch(c) { var s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
  function lum(c) { return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b); }
  function contrast(a, b) { var x = lum(a), y = lum(b); var hi = Math.max(x, y), lo = Math.min(x, y); return (hi + 0.05) / (lo + 0.05); }
  function mix(f, t, a) { function s(p, q) { return Math.round(p + (q - p) * a); } return { r: s(f.r, t.r), g: s(f.g, t.g), b: s(f.b, t.b) }; }
  function rgba(c, a) { return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + a + ')'; }
  function readableOn(bg) { return contrast(bg, WHITE) >= contrast(bg, BLACK) ? WHITE : BLACK; }
  function textVariant(color, surface, min) {
    min = min || 4.5;
    if (contrast(color, surface) >= min) return color;
    var target = lum(surface) > 0.5 ? BLACK : WHITE;
    for (var a = 0.05; a < 1; a += 0.05) { var c = mix(color, target, a); if (contrast(c, surface) >= min) return c; }
    return target;
  }

  var DEFAULT_BRAND = '#0f766e';
  var LIGHT_PAGE = { r: 243, g: 245, b: 246 }, DARK_SURFACE = { r: 24, g: 27, b: 31 };
  var LIGHT_INVERSE = { r: 42, g: 46, b: 51 }, DARK_INVERSE = { r: 230, g: 233, b: 236 };
  function brandTokens(hex) {
    var b = parseHex(hex) || parseHex(DEFAULT_BRAND);
    var on = readableOn(b);
    return {
      '--brand': toHex(b),
      '--on-brand': toHex(on),
      '--on-brand-tint': rgba(on === WHITE ? BLACK : WHITE, 0.16),
      '--brand-text-light': toHex(textVariant(b, mix(b, LIGHT_PAGE, 0.88))),
      '--brand-text-dark': toHex(textVariant(b, mix(b, DARK_SURFACE, 0.88))),
      '--inverse-brand-light': toHex(textVariant(b, LIGHT_INVERSE)),
      '--inverse-brand-dark': toHex(textVariant(b, DARK_INVERSE)),
      '--brand-tint-soft': rgba(b, 0.06),
      '--brand-tint': rgba(b, 0.12),
      '--brand-glow': rgba(b, 0.26),
      '--brand-shadow': rgba(b, 0.36),
      '--brand-light': toHex(mix(b, WHITE, 0.22)),
      '--brand-dark': toHex(mix(b, BLACK, 0.25)),
    };
  }
  function applyBrand(hex) {
    var t = brandTokens(hex);
    for (var k in t) root.style.setProperty(k, t[k]);
  }

  var PAGE = { light: '#f3f5f6', dark: '#0f1113' };
  var dark = window.matchMedia('(prefers-color-scheme: dark)');
  function resolved(pref) { return pref === 'light' || pref === 'dark' ? pref : (dark.matches ? 'dark' : 'light'); }
  function applyTheme(pref) {
    if (pref === 'light' || pref === 'dark') root.dataset.theme = pref; else delete root.dataset.theme;
  }
  function setThemeColor(c) { var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', c); }

  function autoPerf() {
    var n = navigator;
    var conn = n.connection || {};
    if (conn.saveData) return 'performance';
    if (n.deviceMemory && n.deviceMemory <= 2) return 'performance';
    if (n.hardwareConcurrency && n.hardwareConcurrency <= 4 && n.deviceMemory && n.deviceMemory <= 4) return 'performance';
    if (/^(slow-2g|2g)$/.test(conn.effectiveType || '')) return 'performance';
    return 'beautify';
  }
  function applyPerf(mode) { if (mode === 'performance') root.dataset.perf = 'performance'; else delete root.dataset.perf; }

  var prefs = {
    theme: read('theme') || 'system',
    perf: read('perf') || autoPerf(),
    brand: parseHex(read('brand') || '') ? read('brand') : DEFAULT_BRAND,
  };
  applyTheme(prefs.theme);
  applyPerf(prefs.perf);
  applyBrand(prefs.brand);

  window.PP = {
    prefs: prefs,
    DEFAULT_BRAND: DEFAULT_BRAND,
    setTheme: function (p) { prefs.theme = p; write('theme', p); applyTheme(p); },
    setPerf: function (m) { prefs.perf = m; write('perf', m); applyPerf(m); },
    setBrand: function (h) { prefs.brand = h; write('brand', h); applyBrand(h); },
    resolvedTheme: function () { return resolved(prefs.theme); },
    pageColor: function () { return PAGE[resolved(prefs.theme)]; },
    setThemeColor: setThemeColor,
    watchSystemTheme: function (fn) { dark.addEventListener('change', fn); },
    read: read,
    write: write,
  };
})();
