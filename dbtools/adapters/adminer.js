/**
 * adapters/adminer.js — everything that knows what Adminer's HTML looks like.
 *
 * All the version-sensitive knowledge lives in this one file so the rest of the
 * feature can be written against plain objects. Adminer is a single PHP script
 * that people run in many versions, often behind a theme or a plugin, so every
 * reader here follows the same contract: recognise the shape it expects, or
 * return `{ ok: false, reason }` and let the caller disable itself. It never
 * throws into the page and never assumes a node exists.
 *
 * The shapes it reads:
 *
 *   ?edit=<table>&where[..]   a row form — `fields[<col>]` inputs, and a
 *                             `function[<col>]` select whose value is `NULL`
 *                             when the column is null. This is where the
 *                             "before" values come from, for free, at load.
 *   ?select=<table>           the grid; its per-row edit links are the most
 *                             version-proof statement of which columns key the
 *                             table, so key discovery reads them rather than
 *                             parsing the structure page.
 *   ?sql=                     the SQL command page: a `query` textarea, the CSRF
 *                             `token`, and a result table after submission.
 *
 * `document` is passed in rather than used globally, because the same parsers run
 * against pages fetched in the background through DOMParser.
 */

import { parseAdminerUrl } from '../params.js';

/* === Detection ═══════════════════════════════════════════════════════════ */

/**
 * Is this page Adminer?
 *
 * The obvious check — a `generator` meta — is not there: 4.8.1 emits none, so
 * detection leans on the masthead Adminer puts in its own menu, which does carry
 * the version. Everything else is a weak signal and two are required, so a page
 * that merely links to something called "adminer" is not adopted.
 */
export function detect(doc = document) {
  const generator = doc.querySelector('meta[name="generator"]');
  const gen = generator ? String(generator.content || '') : '';
  if (/^Adminer/i.test(gen)) {
    const version = (gen.match(/Adminer\s+([\d.]+)/i) || [])[1] || '';
    return { ok: true, version, via: 'generator' };
  }

  const masthead = doc.querySelector('a#h1[href*="adminer.org"], #h1 a[href*="adminer.org"]');
  if (masthead) {
    const label = doc.querySelector('#menu .version, #h1 .version, .version');
    return { ok: true, version: label ? label.textContent.trim() : '', via: 'masthead' };
  }

  let weak = 0;
  if (doc.getElementById('content') && doc.getElementById('menu')) weak++;
  if (doc.querySelector('link[rel="stylesheet"][href*="adminer"]')) weak++;
  if (/\bAdminer\b/.test(doc.title || '')) weak++;
  if (doc.querySelector('input[name="token"]') && doc.querySelector('#menu')) weak++;
  return weak >= 2
    ? { ok: true, version: '', via: 'heuristic' }
    : { ok: false, reason: 'not-adminer' };
}

/** The CSRF token Adminer puts in every one of its forms. */
export function readToken(doc = document) {
  const input = doc.querySelector('input[name="token"]');
  return input ? input.value : '';
}

/* === The row edit form ═══════════════════════════════════════════════════ */

const FIELD_RE = /^fields\[([^\]]+)\](\[\])?$/;

/** Every control that carries a column value, grouped by column. */
function fieldControls(form) {
  const byCol = new Map();
  for (const el of form.querySelectorAll('[name^="fields["]')) {
    const match = FIELD_RE.exec(el.getAttribute('name') || '');
    if (!match) continue;
    const col = match[1];
    if (!byCol.has(col)) byCol.set(col, []);
    byCol.get(col).push(el);
  }
  return byCol;
}

/** Read one column's current value out of its control(s). */
function readControls(form, col, controls) {
  // A SET column is several checkboxes sharing `fields[col][]`; its value is the
  // comma-joined list MySQL itself would store.
  if (controls.length > 1 && controls.every((c) => c.type === 'checkbox')) {
    const on = controls.filter((c) => c.checked).map((c) => c.value);
    return { value: on.join(','), kind: 'set' };
  }

  const el = controls[0];
  const tag = el.tagName.toLowerCase();

  if (tag === 'textarea') return { value: el.value, kind: 'text' };
  if (tag === 'select') return { value: el.value, kind: 'select' };
  if (el.type === 'file') return { value: null, kind: 'file', unreadable: true };
  if (el.type === 'checkbox') {
    // Adminer submits nothing for an unchecked box, and the column ends up 0/''.
    // Recorded as the value it would store, and flagged, because which of the two
    // it is depends on the column type.
    return { value: el.checked ? (el.value || '1') : '0', kind: 'checkbox', flag: 'checkbox-column' };
  }
  if (el.type === 'radio') {
    const on = controls.find((c) => c.checked);
    return { value: on ? on.value : '', kind: 'radio' };
  }
  return { value: el.value, kind: 'input' };
}

/** Is this column currently NULL, according to the form? */
function readNull(form, col) {
  const fn = form.querySelector(`[name="function[${cssEscape(col)}]"]`);
  if (fn && String(fn.value).toUpperCase() === 'NULL') return true;
  const box = form.querySelector(`input[type="checkbox"][name="null[${cssEscape(col)}]"]`);
  if (box && box.checked) return true;
  return false;
}

/** The function Adminer will apply on save (`now`, `md5`, …), or ''. */
function readFunction(form, col) {
  const fn = form.querySelector(`[name="function[${cssEscape(col)}]"]`);
  if (!fn) return '';
  const value = String(fn.value || '');
  return value.toUpperCase() === 'NULL' ? '' : value;
}

/** CSS.escape is not in every context this runs in; column names are tame. */
function cssEscape(name) {
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(name);
  return String(name).replace(/["\\\]]/g, '\\$&');
}

/** The form on an `?edit=` page — the one that holds `fields[...]` controls. */
export function findEditForm(doc = document) {
  for (const form of doc.querySelectorAll('form')) {
    if (form.querySelector('[name^="fields["]')) return form;
  }
  return null;
}

/**
 * Read a row form into { values, functions, unreadable, flags }.
 *
 * `values` maps column → string or null. That map is both the "before" snapshot
 * taken at load and the "after" snapshot taken at submit, so the two are always
 * produced by the same code and cannot disagree about, say, what an empty
 * textarea means.
 */
export function readEditForm(doc = document, form = null) {
  const target = form || findEditForm(doc);
  if (!target) return { ok: false, reason: 'no-edit-form' };

  const values = {};
  const functions = {};
  const unreadable = [];
  const flags = [];
  const controls = fieldControls(target);
  if (!controls.size) return { ok: false, reason: 'no-fields' };

  for (const [col, list] of controls) {
    if (readNull(target, col)) {
      values[col] = null;
    } else {
      const read = readControls(target, col, list);
      if (read.unreadable) {
        unreadable.push(col);
        continue;
      }
      values[col] = read.value;
      if (read.flag) flags.push(`${read.flag}:${col}`);
    }
    const fn = readFunction(target, col);
    if (fn) {
      functions[col] = fn;
      flags.push(`function:${col}=${fn}`);
    }
  }

  return { ok: true, form: target, values, functions, unreadable, flags };
}

/**
 * An `?edit=` page with no `where[...]` in its URL is the insert form, and an
 * insert has no "before" to record.
 */
export function isInsertForm(href) {
  const info = parseAdminerUrl(href);
  return info.page === 'edit' && !Object.keys(info.where).length;
}

/* === Key discovery ═══════════════════════════════════════════════════════ */

/**
 * Which columns identify a row, read off any edit link on a select page.
 *
 * Adminer builds those links from the table's primary or first unique key, which
 * makes them a far better source than parsing the structure page: the link shape
 * has been stable across versions while the structure markup has not.
 */
export function keyColsFromDoc(doc) {
  for (const a of doc.querySelectorAll('a[href*="edit="]')) {
    const href = a.getAttribute('href') || '';
    if (!/[?&](edit=)/.test(href)) continue;
    const info = parseAdminerUrl(new URL(href, doc.baseURI || 'http://x/').href);
    const cols = Object.keys(info.where);
    if (cols.length) return cols;
  }
  return null;
}

/* === Result tables ═══════════════════════════════════════════════════════ */

/**
 * The column name out of a header cell.
 *
 * A grid header is not just text: Adminer hangs a sort link and a hidden
 * per-column menu (`↓`, `=`) inside the `th`, so `textContent` reads "id ↓ =".
 * The menu is removed from a clone and the sort link's own label is preferred.
 */
function headerName(th) {
  const clone = th.cloneNode(true);
  for (const extra of clone.querySelectorAll('.column, script')) extra.remove();
  const link = clone.querySelector('a');
  return (link ? link.textContent : clone.textContent).trim();
}

/** Adminer renders a NULL cell as an italic "NULL" rather than as empty text. */
function cellValue(td) {
  const italic = td.querySelector('i');
  if (italic && italic.textContent.trim() === 'NULL' && td.textContent.trim() === 'NULL') return null;
  return td.textContent;
}

/**
 * The first real result grid on the page → { columns, rows }.
 *
 * "Real" means it has a header row and at least one body row, which skips the
 * layout tables Adminer uses for its own forms.
 */
export function parseResultTable(doc) {
  const scope = doc.getElementById('content') || doc.body || doc;
  if (!scope) return { ok: false, reason: 'no-content' };

  for (const table of scope.querySelectorAll('table')) {
    const headCells = table.querySelectorAll('thead th, tr:first-child th');
    if (!headCells.length) continue;
    const columns = [...headCells].map(headerName);
    const bodyRows = [...table.querySelectorAll('tr')].filter((tr) => tr.querySelector('td'));
    if (!bodyRows.length) continue;

    const rows = [];
    for (const tr of bodyRows) {
      const cells = [...tr.querySelectorAll('td')];
      if (cells.length !== columns.length) continue;
      const row = {};
      columns.forEach((col, i) => { row[col] = cellValue(cells[i]); });
      rows.push(row);
    }
    if (rows.length) return { ok: true, columns, rows };
  }
  return { ok: false, reason: 'no-result-table' };
}

/* === Messages ════════════════════════════════════════════════════════════ */

/** Error text Adminer reported on this page, if any. */
export function readErrors(doc = document) {
  return [...doc.querySelectorAll('.error, #content .error')]
    .map((el) => el.textContent.trim())
    .filter(Boolean);
}

/** Success text ("Item has been updated.", "Query executed OK…"). */
export function readMessages(doc = document) {
  return [...doc.querySelectorAll('.message, #content .message')]
    .map((el) => el.textContent.trim())
    .filter(Boolean);
}

/** Rows affected, when Adminer says so. Returns null when it does not. */
export function affectedRows(doc = document) {
  for (const text of readMessages(doc)) {
    const match = text.match(/(\d+)\s+row/i);
    if (match) return Number(match[1]);
  }
  return null;
}

/* === The SQL command page ════════════════════════════════════════════════ */

export function findSqlForm(doc = document) {
  const area = doc.querySelector('textarea[name="query"]');
  if (!area) return null;
  const form = area.closest('form');
  return form ? { form, textarea: area } : null;
}

/**
 * The query the user is about to run.
 *
 * `textarea[name=query]` is not it. Adminer hides that textarea behind a
 * `<pre contenteditable>` highlighter and only copies the text across in the
 * form's own `onsubmit`, so the textarea holds whatever was submitted *last*.
 * Reading it would capture the previous statement and roll back rows the new one
 * never touched — so the editor wins whenever there is one, exactly as it does
 * for Adminer itself.
 */
export function readSqlQuery(found) {
  if (!found) return '';
  const { form, textarea } = found;
  const editor =
    form.querySelector('pre.sqlarea[contenteditable="true"], pre[contenteditable="true"]') ||
    (textarea.previousElementSibling && textarea.previousElementSibling.isContentEditable
      ? textarea.previousElementSibling
      : null);
  if (editor) return editor.innerText ?? editor.textContent ?? '';
  return textarea.value || '';
}
