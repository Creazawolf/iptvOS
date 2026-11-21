/*
 * I18n — the web admin's language. Dictionaries live in i18n/<lang>.js and call I18n.add().
 *
 *   tr('common.save')                        "Save" / "Spara"
 *   tr('channels.resultsFor', { n, q })      placeholders: {n}, {q}
 *   tr('counts.channels', { n: 5, count })   value { one, other } is picked by n
 *   I18n.lang                                'en' | 'sv'  (the active language)
 *   I18n.locale                              BCP 47 tag for Intl / toLocale*: 'en-GB', 'sv-SE', …
 *   I18n.pref()                              'auto' | 'en' | 'sv'  (what was chosen in this browser)
 *   I18n.set('sv')                           save the choice and reload the page
 *   I18n.langs                               [{ id, name }] for the language picker
 *
 * 'auto' follows the browser's languages and falls back to English. The choice is stored per
 * browser in localStorage. A missing key falls back to English, then to the key itself.
 */
(function (global) {
  'use strict';

  const LANGS = [
    { id: 'en', name: 'English', locale: 'en-GB' },
    { id: 'sv', name: 'Svenska', locale: 'sv-SE' }
  ];
  const FALLBACK = 'en';
  const KEY = 'g3hub:lang';

  const dicts = {};
  const missing = new Set();
  const known = (id) => LANGS.some((l) => l.id === id);
  const base = (tag) => String(tag || '').toLowerCase().split(/[-_]/)[0];

  function systemTags() {
    const n = global.navigator || {};
    const list = n.languages && n.languages.length ? Array.from(n.languages) : [n.language];
    return list.filter(Boolean);
  }

  function pref() {
    let p = null;
    try { p = global.localStorage.getItem(KEY); } catch (e) { /* storage blocked */ }
    return known(p) ? p : 'auto';
  }

  function resolve() {
    const p = pref();
    if (p !== 'auto') return p;
    return systemTags().map(base).find(known) || FALLBACK;
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
    let o = dict;
    for (const part of key.split('.')) {
      if (!o || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o, part)) return undefined;
      o = o[part];
    }
    return o;
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
    if (!vars) return String(v);
    return String(v).replace(/\{(\w+)\}/g, (m, name) => (vars[name] == null ? m : String(vars[name])));
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
    try {
      if (id === 'auto') global.localStorage.removeItem(KEY);
      else global.localStorage.setItem(KEY, id);
    } catch (e) { /* storage blocked: the choice lasts until reload */ }
    global.location.reload();
  }

  if (global.document && global.document.documentElement) global.document.documentElement.lang = lang;

  global.I18n = { lang, locale, langs: LANGS.map((l) => ({ id: l.id, name: l.name })), pref, set, add, missing };
  global.tr = tr;
})(window);
