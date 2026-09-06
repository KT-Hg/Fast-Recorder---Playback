/**
 * explain.js — A longer, plain-language rationale for each generated case.
 *
 * The technique modules already say WHAT to test (title/data/expected); this
 * module adds WHY it matters — the SQL-semantics reason the case exists and
 * the concrete symptom a reviewer would see if the query were wrong.
 *
 * It classifies a case from fields every case already carries — `technique`,
 * `group`, `target`, `condition`, `seq` — rather than requiring each of the
 * ~150 case-creation call sites across the four technique modules to hand
 * over a bespoke sentence. That matters because `condition` (and most of
 * `group`) is rendered SQL, never localized text, so the same regex-based
 * classifier works unchanged under any UI language; only the rationale
 * sentence itself is looked up per language, the same way every other piece
 * of case text is.
 */

import { t } from './i18n.js';

// ---- classification signals ----------------------------------------------
//
// These all match literal SQL keywords or internal (non-localized) group
// prefixes such as "JOIN ·" or "GROUP BY ·" — never the translated prose in
// title/data/expected/notes.

const RX = {
  between: /\bBETWEEN\b/i,
  inSubquery: /\bIN\s*\(\s*SELECT\b/i,
  notInSubquery: /\bNOT\s+IN\s*\(\s*SELECT\b/i,
  inList: /\bIN\s*\(/i,
  like: /\bI?LIKE\b/i,
  isNull: /\bIS\s+(NOT\s+)?NULL\b/i,
  existsOrQuantified: /\bEXISTS\b|\b(ANY|ALL|SOME)\s*\(/i,
  notEqual: /(!=|<>)/,
  equalsLiteralNull: /(=|<>|!=)\s*NULL\b/i,
  ordered: /[<>]/,
  equals: /=/,
  funcCall: /^[A-Za-z_][A-Za-z0-9_]*\s*\(/,
  groupByPrefix: /^GROUP BY\b/i,
  orderByPrefix: /^ORDER BY\b/i,
  writePrefix: /^(INSERT INTO|SET)\b/i,
  joinGroup: /^JOIN\s*·/,
  groupByGroup: /^GROUP BY\s*·/,
  orderByGroup: /^ORDER BY\s*·/,
  setopGroup: /^(UNION|INTERSECT|EXCEPT)\b/,
  dmlGroup: /^(UPDATE|DELETE|INSERT)\s*·/,
  cteGroup: /^CTE\s*·/,
  divGroup: /^DIV\s*·/
};

/** EP and BVA both test a single predicate; only the wording differs. */
function classifyPredicate(cond, prefix) {
  if (RX.between.test(cond)) return `${prefix}.range`;
  if (RX.notInSubquery.test(cond) || RX.inSubquery.test(cond) || RX.existsOrQuantified.test(cond)) return `${prefix}.subquery`;
  if (RX.inList.test(cond)) return `${prefix}.list`;
  if (RX.like.test(cond)) return `${prefix}.pattern`;
  if (RX.isNull.test(cond)) return `${prefix}.nullCheck`;
  if (RX.notEqual.test(cond)) return `${prefix}.notEqual`;
  if (RX.ordered.test(cond)) return `${prefix}.threshold`;
  if (RX.equals.test(cond)) return `${prefix}.equality`;
  return `${prefix}.generic`;
}

function classifyNull(cond, group) {
  // Checked ahead of funcCall below: a divisor expression can itself start
  // like a function call (`NULLIF(cost, 0) / revenue`), which would
  // otherwise be misclassified as an aggregate-NULL case.
  if (RX.divGroup.test(group)) return 'n3.division';
  if (RX.joinGroup.test(group)) return 'n3.joinKey';
  if (RX.groupByPrefix.test(cond) || RX.orderByPrefix.test(cond)) return 'n3.groupOrder';
  if (RX.equalsLiteralNull.test(cond)) return 'n3.equalsLiteral';
  if (RX.notInSubquery.test(cond) || /\bNOT\s+IN\b/i.test(cond)) return 'n3.notInSubquery';
  if (RX.writePrefix.test(cond)) return 'n3.write';
  if (RX.funcCall.test(cond)) return 'n3.aggregate';
  return 'n3.generic';
}

function classifyStructure(cond, group, target) {
  if (RX.joinGroup.test(group)) return 'st.join';
  if (RX.groupByGroup.test(group) || RX.groupByPrefix.test(cond)) return 'st.grouping';
  if (RX.orderByGroup.test(group)) return 'st.ordering';
  if (group === 'LIMIT / OFFSET') return 'st.paging';
  if (RX.setopGroup.test(group)) return 'st.setop';
  if (RX.dmlGroup.test(group)) return 'st.dml';
  if (target === 'SELECT *' || cond === 'SELECT *') return 'st.selectStar';
  if (RX.cteGroup.test(group)) return 'st.cte';
  if (group === 'DISTINCT') return 'st.distinct';
  return 'st.generic';
}

// A case folded in from a CTE body carries `CTE · name · ` ahead of its own
// group text (see generate.js's foldCteCases) so the results table shows
// where it comes from — but every RX above matches on the group *as the
// technique module that built it wrote it*, anchored at the start of the
// string. Stripping the CTE tag back off before classifying is what keeps a
// join case found inside a CTE still reading as "this is about a join"
// instead of falling through to the generic CTE rationale.
const CTE_TAG = /^CTE\s*·\s*[^·]+\s*·\s*/;

/**
 * A case tagged with more than one technique (technique 'EP+BVA', or more
 * codes joined the same way — see mergeCoincidentCases() in generate.js)
 * gets its own rationale rather than falling through to one technique's
 * classifier, which would silently credit only the first code involved.
 * EP+BVA specifically is common enough to word precisely; any other
 * combination — a rarer coincidence — gets a rationale that just says two
 * techniques agree, without guessing at a technique-specific reason.
 */
function classifyMerged(technique, cond) {
  const codes = technique.split('+');
  if (codes.length === 2 && codes.includes('EP') && codes.includes('BVA')) return classifyPredicate(cond, 'epbva');
  return 'case.merged';
}

/** Which rationale key a case falls under. */
function classify(c) {
  const cond = c.condition || '';
  const group = c.cte ? (c.group || '').replace(CTE_TAG, '') : (c.group || '');
  const target = c.target || '';

  if (c.technique.includes('+')) return classifyMerged(c.technique, cond);

  switch (c.technique) {
    case 'EP': return classifyPredicate(cond, 'ep');
    case 'BVA': return classifyPredicate(cond, 'bva');
    case 'Decision Table':
    case 'Pairwise':
    case 'MC/DC':
      // Rule rows carry an explicit sequence (their table position); a masked
      // condition does not, because it never won a row of its own.
      return c.seq !== undefined ? 'dt.rule' : 'dt.masked';
    case 'Branch Coverage': return 'dt.branch';
    case 'NULL / 3VL': return classifyNull(cond, group);
    case 'Structure': return classifyStructure(cond, group, target);
    default: return null;
  }
}

/** The rationale sentence(s) for one generated case. */
export function explainCase(c) {
  const key = classify(c);
  const params = { col: c.target, cond: c.condition, group: c.group, technique: t('tech.code.' + c.technique) };
  return t(key ? `rationale.${key}` : 'rationale.generic', params);
}

/** Attach `.rationale` to every case in a list. */
export function attachRationale(cases) {
  return cases.map(c => ({ ...c, rationale: explainCase(c) }));
}
