// Convert a live <table> element into a rectangular grid of strings,
// expanding colspan/rowspan with an occupancy matrix the way Excel does
// when pasting HTML (spanned slots become empty cells).
//
// Classic script injected on demand; registers on the shared namespace.
(() => {
const TG = (globalThis.__TGX ??= {});

// Private-use sentinel marking intentional line breaks (<br>, block edges)
// so they survive whitespace collapsing.
const LINE_BREAK = '\uE000';

// Many modern web apps (Microsoft Partner Center, data grids, etc.) build
// tabular UI out of <div>s wearing ARIA roles instead of a real <table>. We
// treat those grids exactly like native tables so they are detectable and
// copyable. TABLE_SELECTOR matches both kinds of container.
const TABLE_SELECTOR = 'table, [role="grid"], [role="table"], [role="treegrid"]';
const ARIA_ROW_SELECTOR = '[role="row"]';
const ARIA_CELL_SELECTOR =
  '[role="gridcell"], [role="cell"], [role="columnheader"], [role="rowheader"]';

const isNativeTable = (el) => el.tagName === 'TABLE';

// Nearest enclosing table-like container for a row/cell, used to ignore the
// rows and cells of grids nested inside this one.
const ownerTable = (el) => el.parentElement?.closest(TABLE_SELECTOR) ?? null;

// colspan/rowspan for either native cells (numeric .colSpan/.rowSpan, always
// present, default 1) or ARIA cells (aria-colspan/aria-rowspan attributes).
function getColSpan(cell) {
  if (Number.isFinite(cell.colSpan)) return cell.colSpan;
  const aria = parseInt(cell.getAttribute('aria-colspan'), 10);
  return Number.isFinite(aria) ? aria : 1;
}

function getRowSpan(cell) {
  if (Number.isFinite(cell.rowSpan)) return cell.rowSpan;
  const aria = parseInt(cell.getAttribute('aria-rowspan'), 10);
  return Number.isFinite(aria) ? aria : 1;
}

/**
 * @param {HTMLTableElement} table
 * @param {{ clipRect?: {x:number, y:number, width:number, height:number} }} [options]
 *   clipRect (viewport CSS px) limits the result to the bounding slice of
 *   rows/columns whose cells intersect the rectangle.
 * @returns {{ grid: string[][], rowCount: number, colCount: number, caption: string }}
 */
function tableToGrid(table, { clipRect } = {}) {
  const rows = collectRows(table);
  const grid = [];
  // occupied[r][c] === true means the slot is filled by a value or covered by a span
  const occupied = [];
  // Bounding slot range of cells intersecting clipRect
  let clip = clipRect ? { minR: Infinity, maxR: -1, minC: Infinity, maxC: -1 } : null;

  for (let r = 0; r < rows.length; r++) {
    grid[r] ??= [];
    occupied[r] ??= [];
    const cells = collectCells(rows[r], table);

    let c = 0;
    for (const cell of cells) {
      while (occupied[r][c]) c++;

      const colspan = clampSpan(getColSpan(cell), 1000);
      // rowspan="0" means "spans to the end of the table section"
      const rowVal = getRowSpan(cell);
      const rowspan = rowVal === 0
        ? rows.length - r
        : clampSpan(rowVal, rows.length - r);

      grid[r][c] = cellText(cell);
      for (let dr = 0; dr < rowspan; dr++) {
        const rr = r + dr;
        grid[rr] ??= [];
        occupied[rr] ??= [];
        for (let dc = 0; dc < colspan; dc++) {
          occupied[rr][c + dc] = true;
          if (dr > 0 || dc > 0) grid[rr][c + dc] ??= '';
        }
      }

      // Region clipping tests the cell's VISIBLE rect (clipped to scrolling
      // ancestors) so cells scrolled out of a table body with its own scrollbar
      // are not pulled in just because the region covers their off-screen box.
      // When the helper is present, null means "clipped away" — honor it rather
      // than falling back to the raw box.
      const clipCellRect = !clip
        ? null
        : TG.visibility
          ? TG.visibility.visibleRect(cell)
          : cell.getBoundingClientRect();
      if (clip && clipCellRect && rectIntersects(clipCellRect, clipRect)) {
        clip.minR = Math.min(clip.minR, r);
        clip.maxR = Math.max(clip.maxR, r + rowspan - 1);
        clip.minC = Math.min(clip.minC, c);
        clip.maxC = Math.max(clip.maxC, c + colspan - 1);
      }

      c += colspan;
    }
  }

  // Rectangularize: pad every row to the widest row.
  let colCount = grid.reduce((max, row) => Math.max(max, row.length), 0);
  for (const row of grid) {
    for (let c = 0; c < colCount; c++) row[c] ??= '';
  }

  let result = grid;
  if (clip) {
    if (clip.maxR < 0) {
      result = [];
      colCount = 0;
    } else {
      result = grid
        .slice(clip.minR, clip.maxR + 1)
        .map((row) => row.slice(clip.minC, Math.min(clip.maxC, colCount - 1) + 1));
      colCount = result[0]?.length ?? 0;
    }
  }

  return {
    grid: result,
    rowCount: result.length,
    colCount,
    caption: captionFor(table),
  };
}

function rectIntersects(rect, region) {
  if (rect.width === 0 && rect.height === 0) return false;
  return (
    rect.left < region.x + region.width &&
    rect.right > region.x &&
    rect.top < region.y + region.height &&
    rect.bottom > region.y
  );
}

/** Rows of this table only (not nested tables), in render order: thead, tbodies, tfoot. */
function collectRows(table) {
  // ARIA grid: any descendant role="row" whose nearest grid ancestor is this
  // container (so rows of nested grids are left to those grids).
  if (!isNativeTable(table)) {
    return [...table.querySelectorAll(ARIA_ROW_SELECTOR)].filter(
      (row) => ownerTable(row) === table && isVisible(row)
    );
  }
  const sections = [
    ...(table.tHead ? [table.tHead] : []),
    ...table.tBodies,
    ...(table.tFoot ? [table.tFoot] : []),
  ];
  // Rows directly under <table> land in tBodies during HTML parsing, but
  // XHTML/DOM-built tables can have direct child rows.
  const rows = sections.flatMap((s) => [...s.rows]);
  const directRows = [...table.children].filter((el) => el.tagName === 'TR');
  const all = rows.length > 0 || directRows.length === 0 ? rows : directRows;
  return all.filter((row) => row.closest('table') === table && isVisible(row));
}

function collectCells(row, table) {
  // ARIA grid: cells whose nearest enclosing row is THIS row (skipping the
  // cells of any grid nested inside the row).
  if (!isNativeTable(table)) {
    return [...row.querySelectorAll(ARIA_CELL_SELECTOR)].filter(
      (cell) => cell.closest(ARIA_ROW_SELECTOR) === row && isVisible(cell)
    );
  }
  return [...row.cells].filter((cell) => cell.closest('table') === table && isVisible(cell));
}

function isVisible(el) {
  const style = el.ownerDocument.defaultView.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function clampSpan(span, max) {
  if (!Number.isFinite(span) || span < 1) return 1;
  return Math.min(span, Math.max(1, max));
}

/**
 * Extract readable text from a cell: <br> and block boundaries become newlines,
 * hidden elements and script/style are dropped, whitespace is collapsed.
 */
function cellText(cell) {
  const clone = cell.cloneNode(true);
  // Computed style is unavailable on detached clones, so find hidden
  // descendants on the live cell and remove their clones by index.
  const liveAll = [...cell.querySelectorAll('*')];
  const cloneAll = [...clone.querySelectorAll('*')];
  for (let i = liveAll.length - 1; i >= 0; i--) {
    if (!isVisible(liveAll[i])) cloneAll[i]?.remove();
  }

  // Replace each <slot> with the light-DOM nodes projected into it. Web-component
  // grids (e.g. Partner Center's <he-data-grid>) render real cell values this
  // way, and those nodes live in another tree — a plain clone only carries the
  // slot's fallback content. The index maps above still reference the right
  // nodes after the removals (we never re-query). Empty slots keep their
  // fallback children untouched. assignedNodes is a no-op outside shadow DOM.
  for (let i = 0; i < liveAll.length; i++) {
    if (liveAll[i].localName !== 'slot') continue;
    const target = cloneAll[i];
    if (!target) continue;
    const assigned = (liveAll[i].assignedNodes?.({ flatten: true }) ?? []).filter(
      (n) => n.nodeType !== Node.ELEMENT_NODE || isVisible(n)
    );
    if (assigned.length) target.replaceWith(...assigned.map((n) => n.cloneNode(true)));
  }

  for (const el of clone.querySelectorAll('script, style, noscript, template')) el.remove();
  for (const br of clone.querySelectorAll('br')) br.replaceWith(LINE_BREAK);
  // Nested-table cells get a space boundary so their texts don't run together.
  for (const nestedCell of clone.querySelectorAll('td, th')) nestedCell.append(' ');
  // Block-level boundaries inside a cell also act as line breaks.
  for (const block of clone.querySelectorAll('p, div, li, tr')) block.append(LINE_BREAK);

  const raw = clone.textContent ?? '';
  return raw
    .replaceAll(/[ \t\r\n\u00A0]+/g, ' ')
    .replaceAll(new RegExp(` ?${LINE_BREAK}+ ?`, 'g'), '\n')
    .replaceAll(/\n{2,}/g, '\n')
    .replace(/^\n+|\n+$/g, '')
    .trim();
}

function captionFor(table) {
  const caption = table.caption?.textContent?.trim();
  if (caption) return caption.replaceAll(/\s+/g, ' ');
  const ariaLabel = table.getAttribute('aria-label')?.trim();
  if (ariaLabel) return ariaLabel;
  const labelledBy = table.getAttribute('aria-labelledby');
  if (labelledBy) {
    const label = labelledBy
      .split(/\s+/)
      .map((id) => table.ownerDocument.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(' ');
    if (label) return label;
  }
  return '';
}

/**
 * Every cell of a table-like element across all its rows (native or ARIA),
 * excluding the cells of any grid nested inside it. Used for region hit-testing.
 */
function tableCells(table) {
  if (!isNativeTable(table)) {
    return [...table.querySelectorAll(ARIA_CELL_SELECTOR)].filter(
      (cell) => ownerTable(cell.closest(ARIA_ROW_SELECTOR) ?? cell) === table
    );
  }
  return [...table.querySelectorAll('th, td')].filter((cell) => cell.closest('table') === table);
}

/**
 * All table-like containers in/under `root`, descending through OPEN shadow
 * roots so tables rendered inside web components (e.g. Microsoft Partner
 * Center's <he-data-grid>) are found. Closed shadow roots — including our own
 * overlay — are opaque and skipped. Order is approximately document order.
 * @param {Document|ShadowRoot|Element} [root]
 * @returns {Element[]}
 */
function allTables(root = document) {
  const out = [];
  const visit = (node) => {
    if (!node.querySelectorAll) return;
    out.push(...node.querySelectorAll(TABLE_SELECTOR));
    for (const el of node.querySelectorAll('*')) {
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(root);
  return out;
}

/**
 * True for tables worth offering to copy: at least 2x2 of visible cells
 * and not marked as layout-only.
 */
function isDataTable(table) {
  const role = table.getAttribute('role');
  if (role === 'presentation' || role === 'none') return false;
  if (!isVisible(table)) return false;
  const rows = collectRows(table);
  if (rows.length < 2) return false;
  const maxCells = rows.reduce((max, row) => Math.max(max, collectCells(row, table).length), 0);
  return maxCells >= 2;
}

TG.tableGrid = {
  tableToGrid,
  cellText,
  isDataTable,
  tableCells,
  allTables,
  collectRows,
  collectCells,
  getColSpan,
  getRowSpan,
  TABLE_SELECTOR,
};
})();
