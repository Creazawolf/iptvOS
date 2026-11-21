/*
 * I18n — the launcher's UI language. Dictionaries live in js/i18n/<lang>.js and call I18n.add().
 *
 *   tr('common.retry')                      "Try again" / "Försök igen"
 *   tr('tv.favAdded', { name: ch.name })    "{name} added to favourites"
 *   tr('common.minutes', { n: 5 })          value { one, other } is picked by n
 *   I18n.lang                               'en' | 'sv'  (the active language)
 *   I18n.locale                             BCP 47 tag for Intl / toLocale*: 'en-GB', 'sv-SE', …
 *   I18n.pref()                             'auto' | 'en' | 'sv'  (what the user chose)
 *   I18n.set('sv')                          save the choice and reload the app
 *   I18n.langs                              [{ id, name }] for the language picker
 *
 * 'auto' follows the TV's menu language (navigator.languages) and falls back to English.
 * A missing key falls back to English, then to the key itself, and is recorded in I18n.missing.
 * To add a language: copy js/i18n/en.js, translate it, add a <script> tag and an entry in LANGS.
 */
(function (global) {
  'use strict';

  const LANGS = [
    { id: 'en', name: 'English', locale: 'en-GB' },
    { id: 'sv', name: 'Svenska', locale: 'sv-SE' }
  ];
  const FALLBACK = 'en';
  const SETTINGS_KEY = 'g3:settings:v1';

  const dicts = {};
  const missing = new Set();
  const known = (id) => LANGS.some((l) => l.id === id);
  const base = (tag) => String(tag || '').toLowerCase().split(/[-_]/)[0];

  function systemTags() {
    const n = global.navigator || {};
    const list = n.languages && n.languages.length ? Array.from(n.languages) : [n.language];
    return list.filter(Boolean);
  }

  // Launchers installed before the language setting existed were Swedish-only: keep them Swedish.
  (function migrate() {
    if (!global.Store) return;
    let raw = null;
    try { raw = JSON.parse(global.localStorage.getItem(SETTINGS_KEY)); } catch (e) { /* none */ }
    if (raw && raw.i18n != null) return;
    if (raw && typeof raw === 'object' && raw.language == null) global.Store.set('language', 'sv');
    global.Store.set('i18n', 1);
  })();

  function pref() {
    const p = global.Store ? global.Store.get('language') : null;
    return known(p) ? p : 'auto';
  }

  function resolve() {
    const p = pref();
    if (p !== 'auto') return p;
    const hit = systemTags().map(base).find(known);
    return hit || FALLBACK;
  }

  const lang = resolve();
  const locale = (function () {
    const sys = systemTags().find((tag) => base(tag) === lang);
    return sys && /-/.test(sys) ? sys : LANGS.find((l) => l.id === lang).locale;
  })();

  let plural = null;
  try { plural = new Intl.PluralRules(locale); } catch (e) { /* old engine */ }

  function lookup(dict, key) {
    if (!dict) return undefined;
    if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
    let o = dict;
    for (const part of key.split('.')) {
      if (!o || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o, part)) return undefined;
      o = o[part];
    }
    return o;
  }

  function fill(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (m, name) => (vars[name] == null ? m : String(vars[name])));
  }

  function tr(key, vars) {
    let v = lookup(dicts[lang], key);
    if (v == null && lang !== FALLBACK) v = lookup(dicts[FALLBACK], key);
    if (v == null) {
      if (!missing.has(key)) { missing.add(key); console.warn('[i18n] missing', lang + ':' + key); }
      return key;
    }
    if (v && typeof v === 'object') {
      const n = vars && typeof vars.n === 'number' ? vars.n : 0;
      const form = plural ? plural.select(n) : (n === 1 ? 'one' : 'other');
      v = v[form] != null ? v[form] : v.other;
      if (v == null) return key;
    }
    return fill(String(v), vars);
  }

  function merge(into, from) {
    Object.keys(from).forEach((k) => {
      const a = into[k];
      const b = from[k];
      const isGroup = (x) => x && typeof x === 'object' && !('other' in x);
      if (isGroup(a) && isGroup(b)) merge(a, b);
      else into[k] = b;
    });
    return into;
  }

  function add(id, dict) {
    dicts[id] = merge(dicts[id] || {}, dict || {});
  }

  function set(id) {
    if (id !== 'auto' && !known(id)) return;
    global.Store.set('language', id);
    if (global.Store.flush) global.Store.flush();
    global.location.reload();
  }

  const has = (key) => lookup(dicts[lang], key) != null || lookup(dicts[FALLBACK], key) != null;

  if (global.document && global.document.documentElement) global.document.documentElement.lang = lang;

  global.I18n = { lang, locale, langs: LANGS.map((l) => ({ id: l.id, name: l.name })), pref, set, add, has, missing, t: tr, dicts };
  global.tr = tr;
})(window);
