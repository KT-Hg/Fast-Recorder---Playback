/**
 * i18n.js — Message catalog lookup for the SQL Test Case Designer.
 *
 * Case text is produced in the active language at generation time rather than
 * translated afterwards: generation is pure and takes a few milliseconds, so
 * switching language simply re-runs it. That keeps one code path instead of a
 * fragile post-hoc string-matching layer, and it means an export always matches
 * what is on screen.
 *
 * Stable codes stay English wherever they are logic rather than prose —
 * `technique`, `priority`, the CSV column keys. Those are localised only at the
 * point of display, so filtering, sorting and the JSON export keep working
 * regardless of the language on screen.
 *
 * A key with no entry in either catalog falls back to the key itself and is
 * recorded, so `selftest.mjs` can assert that no such key exists.
 */

import { EN } from './i18n/en.js';
import { VI } from './i18n/vi.js';

const CATALOGS = { en: EN, vi: VI };
export const LANGUAGES = [
  { code: 'vi', label: 'Tiếng Việt', short: 'VI' },
  { code: 'en', label: 'English', short: 'EN' }
];

export const DEFAULT_LANG = 'vi';

let lang = DEFAULT_LANG;
const missing = new Set();

/** Switch the language every later `t()` call resolves against. */
export function setLang(code) {
  lang = CATALOGS[code] ? code : DEFAULT_LANG;
  return lang;
}

export function getLang() {
  return lang;
}

/** Keys that resolved to nothing since load — asserted empty by the self-test. */
export function missingKeys() {
  return [...missing];
}

export function clearMissingKeys() {
  missing.clear();
}

/**
 * Look up `key` and substitute `{name}` placeholders from `params`.
 *
 * Falls back to English before falling back to the key, so a catalog that is
 * only partly translated degrades to mixed language rather than to raw keys.
 *
 * @param {string} key
 * @param {object} [params]
 * @returns {string}
 */
export function t(key, params) {
  let template = CATALOGS[lang]?.[key];
  if (template === undefined) template = EN[key];
  if (template === undefined) {
    missing.add(key);
    return key;
  }
  return format(template, params);
}

function format(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    (params[name] === undefined || params[name] === null) ? whole : String(params[name]));
}

/**
 * The same message in the languages that are *not* on screen — the longest of
 * them when there is more than one.
 *
 * Layout, not display: a control that carries a label reserves the width of
 * this string as well as of the one it shows (see `data-i18n-alt` in
 * sqlcases.css), so switching language re-letters the chrome without moving
 * it. With two catalogs the pair is exact, since the browser measures both
 * strings itself; past two, character count picks the candidate.
 *
 * A key missing from the other catalogs yields '', which reserves nothing —
 * unlike `t`, a width measurement has no business reporting a missing key.
 */
export function tAlt(key, params) {
  let widest = '';
  for (const [code, catalog] of Object.entries(CATALOGS)) {
    if (code === lang) continue;
    const template = catalog[key];
    if (template === undefined) continue;
    const text = format(template, params);
    if (text.length > widest.length) widest = text;
  }
  return widest;
}

/**
 * Pick one of two messages on a count.
 *
 * Vietnamese does not inflect for number, so both keys usually resolve to the
 * same string there; the split exists for English.
 */
export function tPlural(count, oneKey, manyKey, params) {
  return t(count === 1 ? oneKey : manyKey, { ...params, n: count });
}
