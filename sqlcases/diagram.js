/**
 * diagram.js — The inferred schema read as a shape instead of a list.
 *
 * The Schema pane already states everything this module draws: the tables,
 * their columns, which column is the identity and which one points at another
 * table. What a list cannot show is the shape of those pointers — which table
 * is the hub, which one hangs off the end, how far a join has to travel. That
 * is the whole reason to draw it, so the diagram carries no fact of its own:
 * it is a second reading of `inferSchema()` output, and if the inference is
 * wrong the picture is wrong in exactly the same way the list is.
 *
 * The module is split in two on purpose:
 *
 *   planDiagram()  — pure. Tables in, nodes with a column/row and links out.
 *                    No DOM, so selftest.mjs can assert the layering.
 *   mountDiagram() — the surface. Builds the boxes, draws the links, and owns
 *                    the pan/zoom/drag gestures until it is destroyed.
 *
 * Everything the surface listens on goes through one AbortController, because
 * the diagram is rebuilt on every run (the schema behind it changes with the
 * query) and a listener left on `window` would outlive the boxes it moves.
 */

import { t } from './i18n.js';

// ---- geometry -------------------------------------------------------------
//
// The box width matches `.dgm-table` in sqlcases.css. It is repeated here
// rather than measured because the layout has to be decided before the boxes
// exist; the real width is read back afterwards, so a change to the stylesheet
// shifts the spacing rather than breaking it.

const BOX_W = 236;
const GAP_X = 104;   // room for a link to bend without crossing a neighbour
const GAP_Y = 26;
const PAD = 48;
const FOOT = 13;     // length of the crow's foot at the many end
const SPREAD = 6;    // how far its outer prongs sit from the line
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;

const lc = (s) => String(s ?? '').toLowerCase();
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Decide what to draw and where it belongs, without drawing it.
 *
 * Tables are laid out in columns by how far they sit from a table that points
 * at nothing: a table holding no foreign key is column 0, and a table sits one
 * column right of the furthest table it points at. That puts the thing being
 * referenced on the left and the thing referencing it on the right, which is
 * how a foreign key reads in the query itself — `orders.user_id = users.id`.
 *
 * @param {Array} tables — `inferSchema().tables`, or nothing at all
 * @returns {{nodes: Array, links: Array}}
 */
export function planDiagram(tables) {
  const list = (Array.isArray(tables) ? tables : []).filter(tbl => tbl && tbl.name);
  if (!list.length) return { nodes: [], links: [] };

  // A self-join puts the same name in the list twice. The inference records a
  // foreign key by table *name*, so it cannot tell those two apart either; a
  // link resolves to the first box of that name rather than guessing.
  const byName = new Map();
  list.forEach(tbl => { if (!byName.has(lc(tbl.name))) byName.set(lc(tbl.name), tbl); });

  const links = [];
  const pointsAt = new Map(list.map(tbl => [tbl, new Set()]));
  list.forEach(tbl => {
    (tbl.columns || []).forEach(col => {
      if (!col.fk) return;
      const target = byName.get(lc(col.fk.table));
      // A key naming a table the query never mentions has no box to reach, so
      // it is left off the picture rather than drawn into empty space.
      if (!target || target === tbl) return;
      links.push({
        from: { table: tbl.name, column: col.name },
        to: { table: target.name, column: col.fk.column }
      });
      pointsAt.get(tbl).add(target);
    });
  });

  // Longest path to a table that points at nothing. `seen` is the ring guard:
  // two tables holding each other key is not something the inference produces
  // today, but the walk must stop rather than recurse forever if it ever does
  // — the pair then lands in adjacent columns, which is as good an answer as a
  // ring has.
  const depth = new Map();
  const rank = (tbl, seen) => {
    if (depth.has(tbl)) return depth.get(tbl);
    if (seen.has(tbl)) return 0;
    seen.add(tbl);
    let d = 0;
    pointsAt.get(tbl).forEach(target => { d = Math.max(d, rank(target, seen) + 1); });
    seen.delete(tbl);
    depth.set(tbl, d);
    return d;
  };
  list.forEach(tbl => rank(tbl, new Set()));

  // That walk gives every table the earliest column it may occupy, which
  // strands a table whose only child is far to the right: in a star schema the
  // dimensions all pile into column 0 while the fact table sits three columns
  // away, and every link crosses the tables in between. So each table is now
  // slid as far right as its own children allow — never past its earliest
  // column, which keeps a ring from chasing itself — and the links shorten to
  // one column wherever the shape permits.
  const children = new Map(list.map(tbl => [tbl, []]));
  pointsAt.forEach((targets, tbl) => targets.forEach(target => children.get(target).push(tbl)));
  [...list]
    .sort((a, b) => depth.get(b) - depth.get(a))
    .forEach(tbl => {
      const kids = children.get(tbl);
      if (!kids.length) return;
      depth.set(tbl, Math.max(depth.get(tbl), Math.min(...kids.map(k => depth.get(k))) - 1));
    });

  // A pure ring never reaches zero, so the whole diagram slides left until the
  // first column is column 0.
  const floor = Math.min(...list.map(tbl => depth.get(tbl)));

  const filled = new Map();
  const nodes = list.map((tbl, i) => {
    const column = depth.get(tbl) - floor;
    const row = filled.get(column) || 0;
    filled.set(column, row + 1);
    return { id: `n${i}`, key: tbl.name, table: tbl, column, row };
  });

  return { nodes, links };
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgNode(tag, className) {
  const n = document.createElementNS(SVG_NS, tag);
  if (className) n.setAttribute('class', className);
  return n;
}

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/**
 * Columns in the order a reader looks for them: identity, then the keys that
 * leave the table, then everything else. The Schema pane keeps discovery order
 * because it is a record of what was inferred; the diagram is about the links,
 * so the linked columns go where the eye lands first.
 */
function orderedColumns(tbl) {
  const rankOf = (c) => (c.isPk ? 0 : c.fk ? 1 : 2);
  return [...(tbl.columns || [])]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rankOf(a.c) - rankOf(b.c) || a.i - b.i)
    .map(x => x.c);
}

/**
 * The PK / FK / NOT NULL badge, built the same way wherever a column is drawn.
 *
 * Two things used to keep it from looking the same twice running. The target of
 * a foreign key is as long as the table it points at, and a Vietnamese label
 * runs half again as long as its English one — so a badge carrying either grew
 * until it wrapped its row, while the badge above it stayed on one line. The
 * badge is split instead: a code that is the same two letters in every locale,
 * and a target segment that ellipsises rather than wrap. The full, translated
 * reading is on the title either way.
 *
 * @param {object} col — a column from `inferSchema()`
 * @param {object} [opts]
 * @param {boolean} [opts.showTarget] — spell the FK target out beside the code
 * @param {boolean} [opts.showNotNull] — badge the columns that cannot be null
 * @returns {HTMLElement|null} — null when the column carries no badge
 */
export function keyTag(col, { showTarget = false, showNotNull = false } = {}) {
  if (col.isPk) return badge('sc-tag-pk', t('dg.pkShort'), null, t('dg.pk'));
  if (col.fk) {
    const target = `${col.fk.table}.${col.fk.column}`;
    // Most inferred joins compare a column against one of the same name, so
    // `orders.order_id` off an `order_id` names the column twice. Dropping the
    // half that adds nothing is what keeps the badge on its row.
    const shown = lc(col.fk.column) === lc(col.name) ? col.fk.table : target;
    return badge('sc-tag-fk', t('dg.fkShort'), showTarget ? shown : null, t('dg.fk', { target }));
  }
  if (showNotNull && !col.nullable) return badge('sc-tag-nn', t('dg.notNull'), null, null);
  return null;
}

function badge(cls, code, target, title) {
  const tag = node('span', `sc-tag ${cls}`);
  tag.append(node('span', 'sc-tag-code', code));
  if (target) tag.append(node('span', 'sc-tag-to', `→ ${target}`));
  if (title) tag.title = title;
  return tag;
}

/** One table as a box, with the row element of each column kept for measuring. */
function buildBox(entry) {
  const box = node('div', 'dgm-table');

  const head = node('div', 'dgm-th');
  head.append(node('span', 'dgm-tname', entry.name));
  if (entry.alias && entry.alias !== entry.name) head.append(node('span', 'dgm-alias', entry.alias));
  box.append(head);

  const body = node('div', 'dgm-tb');
  const rows = new Map();
  orderedColumns(entry).forEach(col => {
    const row = node('div', 'dgm-row');
    const name = node('span', 'dgm-cn', col.name);
    if (col.isPk || col.fk) name.classList.add('is-key');
    row.append(name);
    row.append(node('span', 'dgm-ct', col.type || ''));
    // Code alone here: the diagram already draws the target as a line, so
    // spelling it out beside the badge would say it twice and widen every box.
    const tag = keyTag(col);
    if (tag) row.append(tag);
    body.append(row);
    rows.set(lc(col.name), row);
  });
  box.append(body);

  return { box, rows };
}

/**
 * Draw the plan onto a stage and keep it interactive.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.stage — the clipping viewport; owns the gestures
 * @param {HTMLElement} opts.world — the surface that is panned and scaled
 * @param {SVGElement}  opts.svg — where links are drawn, inside the world
 * @param {Array} opts.tables — `inferSchema().tables`
 * @param {Function} [opts.onZoom] — called with the scale whenever it changes
 * @returns {{tables: number, links: number, fit: Function, zoomBy: Function, destroy: Function}}
 */
export function mountDiagram({ stage, world, svg, tables, onZoom }) {
  const plan = planDiagram(tables);
  const ac = new AbortController();
  const { signal } = ac;

  // The world is reused across runs, so anything a previous diagram left
  // behind goes first — everything except the <svg>, which is part of the page.
  [...world.children].forEach(child => { if (child !== svg) child.remove(); });
  svg.replaceChildren();

  // --- boxes, measured where they will actually be seen -------------------
  //
  // Height depends on the column count and on the font the browser settled on,
  // so it is read back rather than computed. That only works because the modal
  // is already visible when this runs: a box inside `hidden` measures nothing.
  const nodes = plan.nodes.map(n => {
    const { box, rows } = buildBox(n.table);
    world.append(box);
    return { ...n, box, rows, x: 0, y: 0, w: BOX_W, h: 0, anchors: new Map() };
  });

  nodes.forEach(n => {
    n.w = n.box.offsetWidth || BOX_W;
    n.h = n.box.offsetHeight;
    n.rows.forEach((row, key) => n.anchors.set(key, row.offsetTop + row.offsetHeight / 2));
  });

  // --- placement ----------------------------------------------------------
  const columns = [];
  nodes.forEach(n => { (columns[n.column] ||= []).push(n); });
  columns.forEach(col => col.sort((a, b) => a.row - b.row));

  const heights = columns.map(col =>
    col.reduce((sum, n) => sum + n.h, 0) + GAP_Y * Math.max(0, col.length - 1));
  const tallest = Math.max(0, ...heights);

  let x = PAD;
  columns.forEach((col, i) => {
    // Columns are centred against the tallest one, so a lone table beside a
    // stack of four sits opposite their middle rather than level with the top.
    let y = PAD + (tallest - heights[i]) / 2;
    col.forEach(n => {
      n.x = x;
      n.y = y;
      y += n.h + GAP_Y;
    });
    x += Math.max(...col.map(n => n.w)) + GAP_X;
  });

  const place = (n) => {
    n.box.style.left = `${n.x}px`;
    n.box.style.top = `${n.y}px`;
  };
  nodes.forEach(place);

  function resizeWorld() {
    const w = Math.max(0, ...nodes.map(n => n.x + n.w)) + PAD;
    const h = Math.max(0, ...nodes.map(n => n.y + n.h)) + PAD;
    world.style.width = `${w}px`;
    world.style.height = `${h}px`;
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    return { w, h };
  }
  let size = resizeWorld();

  // --- links --------------------------------------------------------------
  const byKey = new Map();
  nodes.forEach(n => { if (!byKey.has(lc(n.key))) byKey.set(lc(n.key), n); });

  const edges = plan.links.map(link => {
    const from = byKey.get(lc(link.from.table));
    const to = byKey.get(lc(link.to.table));
    if (!from || !to) return null;

    const g = svgNode('g', 'dgm-link');
    const edge = svgNode('path', 'dgm-edge');
    const foot = svgNode('path', 'dgm-foot');
    const dot = svgNode('circle', 'dgm-dot');
    dot.setAttribute('r', '3.4');
    g.append(edge, foot, dot);
    svg.append(g);
    return { link, from, to, g, edge, foot, dot };
  }).filter(Boolean);

  function drawEdges() {
    edges.forEach(e => {
      const { from, to } = e;
      const ay = from.y + (from.anchors.get(lc(e.link.from.column)) ?? from.h / 2);
      const by = to.y + (to.anchors.get(lc(e.link.to.column)) ?? to.h / 2);
      // Each end leaves by the face pointing at the other box, so dragging a
      // child to the left of its parent flips the line rather than looping it
      // back through the box it came out of.
      const rightward = (to.x + to.w / 2) >= (from.x + from.w / 2);
      const dir = rightward ? 1 : -1;
      const ax = rightward ? from.x + from.w : from.x;
      const bx = rightward ? to.x : to.x + to.w;

      const sx = ax + dir * FOOT;
      const bend = Math.max(42, Math.abs(bx - sx) * 0.45);
      e.edge.setAttribute('d',
        `M ${sx} ${ay} C ${sx + dir * bend} ${ay}, ${bx - dir * bend} ${by}, ${bx} ${by}`);
      // Crow's foot on the key-holding side, a single dot on the key it names:
      // many rows of the child for one row of the parent.
      e.foot.setAttribute('d',
        `M ${ax} ${ay - SPREAD} L ${sx} ${ay} M ${ax} ${ay} L ${sx} ${ay} M ${ax} ${ay + SPREAD} L ${sx} ${ay}`);
      e.dot.setAttribute('cx', String(bx));
      e.dot.setAttribute('cy', String(by));
    });
  }
  drawEdges();

  // --- view ---------------------------------------------------------------
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let gridX = 0;
  let gridY = 0;

  function applyView() {
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  /**
   * Keep the surface anchored under its content.
   *
   * A box lives at a positive offset inside the world, so clamping a drag at
   * the origin gave the reader a wall: a table could be pushed right without
   * limit but stopped after the layout padding going left. Nothing is clamped
   * now. Instead the whole layout slides until the leftmost, topmost box is
   * back at `PAD`, and the view slides the opposite way by the same amount.
   * The two cancel exactly, so nothing on screen moves — the dragged box
   * included — and the drag has no left-hand wall to hit.
   */
  function reanchor() {
    const sx = PAD - Math.min(...nodes.map(n => n.x));
    const sy = PAD - Math.min(...nodes.map(n => n.y));
    if (!sx && !sy) return;

    nodes.forEach(n => { n.x += sx; n.y += sy; place(n); });
    tx -= sx * scale;
    ty -= sy * scale;
    applyView();

    // The grid is painted on the world, so it would slide out from under the
    // tables as the world moves. Offsetting it by the same shift keeps every
    // dot where it was relative to the boxes rather than crawling during a drag.
    gridX += sx;
    gridY += sy;
    world.style.backgroundPosition = `${gridX}px ${gridY}px`;

    // A drag is measured from where its box started, so that origin moves too.
    if (gesture?.kind === 'table') { gesture.ox += sx; gesture.oy += sy; }
    size = resizeWorld();
  }

  function setScale(next, px, py) {
    const capped = clamp(next, MIN_SCALE, MAX_SCALE);
    if (capped === scale) return;
    // Hold the point under the cursor still: zoom that drifts away from where
    // the reader is looking makes a large diagram impossible to explore.
    const k = capped / scale;
    tx = px - (px - tx) * k;
    ty = py - (py - ty) * k;
    scale = capped;
    applyView();
    onZoom?.(scale);
  }

  function fit() {
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    size = resizeWorld();
    // Never magnify to fill the window — a two-table schema blown up to 240%
    // is harder to read than the same schema at its natural size.
    const next = clamp(Math.min((rect.width - 24) / size.w, (rect.height - 24) / size.h), MIN_SCALE, 1);
    scale = next;
    tx = (rect.width - size.w * scale) / 2;
    ty = (rect.height - size.h * scale) / 2;
    applyView();
    onZoom?.(scale);
  }

  function zoomBy(factor) {
    const rect = stage.getBoundingClientRect();
    setScale(scale * factor, rect.width / 2, rect.height / 2);
  }

  applyView();

  // --- gestures -----------------------------------------------------------
  //
  // One pointer at a time, captured by the stage so a drag that leaves it
  // still ends cleanly instead of leaving a box stuck to the cursor.
  // `gesture` is null whenever nothing is being moved.
  let gesture = null;

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    // Exponential, so a notch is the same proportional step in both
    // directions: zooming in and back out returns to where it started.
    setScale(scale * Math.exp(-e.deltaY * 0.0016), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false, signal });

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || gesture) return;
    const box = e.target.closest?.('.dgm-table');
    const hit = box && nodes.find(n => n.box === box);

    if (hit) {
      gesture = { kind: 'table', node: hit, x: e.clientX, y: e.clientY, ox: hit.x, oy: hit.y };
      hit.box.classList.add('is-held');
      // The held box goes last in the world so it passes over its neighbours
      // rather than sliding underneath them.
      world.append(hit.box);
      stage.classList.add('is-dragging');
    } else {
      gesture = { kind: 'pan', x: e.clientX, y: e.clientY, ox: tx, oy: ty };
      stage.classList.add('is-panning');
    }
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, { signal });

  stage.addEventListener('pointermove', (e) => {
    if (!gesture) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    if (gesture.kind === 'pan') {
      tx = gesture.ox + dx;
      ty = gesture.oy + dy;
      applyView();
      return;
    }
    // The pointer moves in screen pixels, the box lives in world ones, so the
    // delta is divided by the scale — without which a drag at 50% zoom moves
    // the box twice as far as the cursor went.
    const n = gesture.node;
    n.x = gesture.ox + dx / scale;
    n.y = gesture.oy + dy / scale;
    place(n);
    reanchor();
    drawEdges();
  }, { signal });

  const endGesture = (e) => {
    if (!gesture) return;
    if (gesture.kind === 'table') {
      gesture.node.box.classList.remove('is-held');
      // A box dragged past the old edge grows the surface under it, so the
      // grid keeps running beneath it and `fit` still frames the whole thing.
      size = resizeWorld();
    }
    stage.classList.remove('is-panning', 'is-dragging');
    gesture = null;
    if (e?.pointerId !== undefined && stage.hasPointerCapture?.(e.pointerId)) {
      stage.releasePointerCapture(e.pointerId);
    }
  };
  stage.addEventListener('pointerup', endGesture, { signal });
  stage.addEventListener('pointercancel', endGesture, { signal });
  window.addEventListener('blur', () => endGesture(), { signal });

  // --- hover: what does this table touch? ---------------------------------
  const neighbours = new Map(nodes.map(n => [n, new Set([n])]));
  edges.forEach(e => {
    neighbours.get(e.from).add(e.to);
    neighbours.get(e.to).add(e.from);
  });

  function light(hit) {
    // Dimming is done in CSS off `is-lit`; this only says what stays lit.
    stage.classList.toggle('is-lit', !!hit);
    nodes.forEach(n => n.box.classList.toggle('is-near', !!hit && neighbours.get(hit).has(n)));
    edges.forEach(e => e.g.classList.toggle('is-near', !!hit && (e.from === hit || e.to === hit)));
  }

  nodes.forEach(n => {
    n.box.addEventListener('pointerenter', () => { if (!gesture) light(n); }, { signal });
    n.box.addEventListener('pointerleave', () => { if (!gesture) light(null); }, { signal });
  });

  return {
    tables: nodes.length,
    links: edges.length,
    fit,
    zoomBy,
    destroy() {
      ac.abort();
      light(null);
      stage.classList.remove('is-panning', 'is-dragging');
      nodes.forEach(n => n.box.remove());
      svg.replaceChildren();
      world.style.transform = '';
      world.style.width = '';
      world.style.height = '';
      world.style.backgroundPosition = '';
    }
  };
}
