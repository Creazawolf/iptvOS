// The hub's own texts (error messages, statuses, default names) in English or Swedish.
// Dictionaries live in lib/locales/<lang>.mjs.
//
//   tr('errors.badToken', null, lang)        text in a language (default: the hub's language)
//   msg('catalog.step.live')                 { key, vars }: a message to store and translate when read
//   text(m, lang)                            a message or a plain (old, stored) string → text
//   new LocalError('providers.notM3u')       an error whose message is translated when shown
//   langOf(req)                              ?lang=, then Accept-Language, then the hub's language
//
// A request's language only changes what is shown; the hub's language (settings.language) is the
// fallback and drives content defaults (TMDB language, Bing market, default names).
import en from './locales/en.mjs';
import sv from './locales/sv.mjs';

export const LANGS = ['en', 'sv'];
const DICTS = { en, sv };
const LOCALES = { en: 'en-GB', sv: 'sv-SE' };
const REGIONS = { en: 'en-US', sv: 'sv-SE' }; // TMDB language and Bing market

export const isLang = (l) => LANGS.includes(l);
const base = (tag) => String(tag || '').trim().toLowerCase().split(/[-_]/)[0];

let hubLanguage = () => 'en';
// server.mjs: setHubLanguage(() => store.settings.language)
export function setHubLanguage(fn) {
  hubLanguage = fn;
}
export function hubLang() {
  const l = hubLanguage();
  return isLang(l) ? l : 'en';
}

export const localeOf = (lang = hubLang()) => LOCALES[lang] || LOCALES.en;
export const regionOf = (lang = hubLang()) => REGIONS[lang] || REGIONS.en;

export function langOf(req) {
  if (req) {
    const q = /[?&]lang=([\w-]+)/.exec(req.url || '');
    if (q && isLang(base(q[1]))) return base(q[1]);
    const header = req.headers && req.headers['accept-language'];
    if (header) {
      const tags = String(header).split(',').map((part, i) => {
        const [tag, ...params] = part.split(';');
        const qp = params.map((s) => s.trim()).find((s) => s.startsWith('q='));
        const weight = qp ? Number(qp.slice(2)) : 1;
        return { lang: base(tag), weight: Number.isFinite(weight) ? weight : 0, i };
      }).filter((t) => t.weight > 0).sort((a, b) => b.weight - a.weight || a.i - b.i);
      const hit = tags.find((t) => isLang(t.lang));
      if (hit) return hit.lang;
    }
  }
  return hubLang();
}

function lookup(dict, key) {
  let o = dict;
  for (const part of key.split('.')) {
    if (!o || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o, part)) return undefined;
    o = o[part];
  }
  return o;
}

const plurals = {};
function pluralForm(lang, n) {
  try {
    if (!plurals[lang]) plurals[lang] = new Intl.PluralRules(localeOf(lang));
    return plurals[lang].select(n);
  } catch {
    return n === 1 ? 'one' : 'other';
  }
}

export function tr(key, vars, lang = hubLang()) {
  if (!isLang(lang)) lang = hubLang();
  let v = lookup(DICTS[lang], key);
  if (v == null && lang !== 'en') v = lookup(DICTS.en, key);
  if (v == null) return key;
  if (typeof v === 'object') {
    const n = vars && typeof vars.n === 'number' ? vars.n : 0;
    v = v[pluralForm(lang, n)] ?? v.other;
    if (v == null) return key;
  }
  return String(v).replace(/\{(\w+)\}/g, (m, name) => (vars && vars[name] != null ? text(vars[name], lang) : m));
}

export const msg = (key, vars) => (vars ? { key, vars } : { key });

export function text(m, lang) {
  if (m == null || typeof m === 'string') return m;
  if (typeof m === 'object' && typeof m.key === 'string') return tr(m.key, m.vars, lang);
  return String(m);
}

// e.message is English (for the log); e.key and e.vars are translated for whoever sees it.
export class LocalError extends Error {
  constructor(key, vars) {
    super(tr(key, vars, 'en'));
    this.key = key;
    if (vars) this.vars = vars;
  }
}

// What to store or pass on from a caught error: its message key when it has one, else its text.
export const msgOf = (e) => (e && e.key ? msg(e.key, e.vars) : (e && e.message) || String(e));
