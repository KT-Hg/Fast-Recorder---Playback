/**
 * export.js — CSV and JSON serialisation of a generated case list.
 *
 * CSV is written for Excel: a UTF-8 BOM so accented text and the ⋈/≠ symbols
 * in case titles survive a double-click open on Windows, CRLF line endings,
 * and every field quoted so a comma or newline inside a description cannot
 * shift the columns.
 */

import { toJSON as valueBookJson } from './valuebook.js';
import { t, getLang } from './i18n.js';

/** Column order for the CSV, and where each value comes from. */
export const CSV_COLUMNS = [
  ['csv.id', c => c.id],
  ['csv.technique', c => t('tech.code.' + c.technique)],
  ['csv.group', c => c.group],
  ['csv.target', c => c.target],
  ['csv.title', c => c.title],
  ['csv.condition', c => c.condition],
  ['csv.data', c => c.data],
  ['csv.expected', c => c.expected],
  ['csv.priority', c => t('prio.' + c.priority)],
  ['csv.notes', c => c.notes],
  ['csv.rationale', c => c.rationale],
  // Blank outside compare mode — c.impact is only set once generateComparison()
  // has tagged the case list.
  ['csv.impact', c => (c.impact ? t('ui.impact' + c.impact[0].toUpperCase() + c.impact.slice(1)) : '')]
];

function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * @param {Array} cases
 * @param {{bom?: boolean}} options
 * @returns {string} CSV text
 */
export function toCsv(cases, options = {}) {
  const rows = [CSV_COLUMNS.map(([h]) => csvField(t(h))).join(',')];
  cases.forEach(c => rows.push(CSV_COLUMNS.map(([, get]) => csvField(get(c))).join(',')));
  const body = rows.join('\r\n') + '\r\n';
  return options.bom === false ? body : '﻿' + body;
}

/**
 * Full JSON payload — the cases plus enough of the analysis to explain them.
 *
 * @param {string} sql
 * @param {object} result — from generateCases()
 * @returns {string} pretty-printed JSON
 */
export function toJson(sql, result) {
  const model = result.model || {};
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    generator: 'Fast Recorder & Playback — SQL Test Case Designer',
    language: getLang(),
    sql,
    // The values a reader cannot recover from the SQL: without these, a case
    // saying `balance = 501` has no visible origin.
    sampleValues: valueBookJson(),
    analysis: {
      statement: model.statement,
      tables: model.tables,
      joins: (model.joins || []).map(j => ({
        joinType: j.joinType,
        implicit: j.implicit,
        natural: j.natural,
        left: j.leftLabel,
        right: j.rightLabel,
        on: j.onSql,
        keys: j.keys
      })),
      conditions: [...(model.conditions || []), ...(model.havingConditions || []), ...(model.joinConditions || [])]
        .map(c => ({
          id: c.id,
          source: c.source,
          sql: c.sql,
          column: c.column ? c.column.raw : null,
          operator: c.operator,
          kind: c.kind,
          dataType: c.dataType,
          values: c.values.map(v => v.sql)
        })),
      grouping: model.grouping,
      paging: model.paging,
      params: model.params,
      writes: model.writes
    },
    coverage: result.coverage,
    findings: result.findings,
    stats: result.stats,
    cases: result.cases
  }, null, 2);
}

/** A filename-safe stem derived from the statement and the current date. */
export function suggestFilename(result, ext) {
  const model = result.model || {};
  const table = (model.tables && model.tables[0]?.name) || (model.writes && model.writes.table) || 'query';
  const safe = String(table).replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'query';
  const stamp = new Date().toISOString().slice(0, 10);
  return `testcases_${safe}_${stamp}.${ext}`;
}

/**
 * Hand a generated file to the user.
 *
 * `chrome.downloads` is used where it exists (the extension page) so the file
 * lands in the browser's download folder with a proper name; the anchor
 * fallback keeps the module usable when loaded outside the extension.
 */
export function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const revoke = () => setTimeout(() => URL.revokeObjectURL(url), 60000);

  if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
    chrome.downloads.download({ url, filename, saveAs: true }, () => revoke());
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  revoke();
}
