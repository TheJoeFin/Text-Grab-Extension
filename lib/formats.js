// Serialize an extracted grid (string[][]) into clipboard-ready formats:
// TSV for text/plain, a clean standalone <table> for text/html, and a
// Markdown table. Chromium adds CF_HTML headers to text/html automatically.
//
// Classic script injected on demand; registers on the shared namespace.
// Depends on TG.tableGrid (lib/table-to-grid.js) for cellText — ensure that
// file is injected first.
(() => {
  const TG = (globalThis.__TGX ??= {});

  /**
   * Grid to tab-separated values using the Excel quoting convention:
   * cells containing tab, newline, or a double quote are wrapped in quotes
   * with embedded quotes doubled, so multi-line cells paste as single cells.
   * @param {string[][]} grid
   * @param {{ flattenNewlines?: boolean }} [options]
   */
  function gridToTsv(grid, { flattenNewlines = false } = {}) {
    return grid
      .map((row) => row.map((cell) => tsvCell(cell, flattenNewlines)).join('\t'))
      .join('\r\n');
  }

  function tsvCell(value, flattenNewlines) {
    let v = value ?? '';
    if (flattenNewlines) v = v.replaceAll(/\s*\n\s*/g, ' ');
    if (/[\t\n"]/.test(v)) {
      return '"' + v.replaceAll('"', '""') + '"';
    }
    return v;
  }

  /**
   * Rebuild a clean standalone <table> from the original element, preserving
   * colspan/rowspan (Excel, Google Sheets, and Text Grab handle merges
   * natively) but dropping classes, styles, and non-text content.
   * Falls back to serializing from the expanded grid when no element is given.
   * @param {HTMLTableElement|null} table
   * @param {string[][]} grid
   */
  function toCleanHtmlTable(table, grid) {
    // ARIA grids (role="grid"/"table" on <div>s) have no .rows/.cells API, so
    // there is nothing to walk — serialize the already-expanded grid instead.
    if (!table || table.tagName !== 'TABLE') return gridToHtmlTable(grid);

    const cellText = TG.tableGrid.cellText;
    const rows = [];
    for (const row of table.rows) {
      if (row.closest('table') !== table || isHidden(row)) continue;
      const cells = [];
      for (const cell of row.cells) {
        if (cell.closest('table') !== table || isHidden(cell)) continue;
        const tag = cell.tagName === 'TH' ? 'th' : 'td';
        const attrs =
          (cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : '') +
          (cell.rowSpan !== 1 ? ` rowspan="${cell.rowSpan}"` : '');
        cells.push(`<${tag}${attrs}>${escapeHtmlMultiline(cellText(cell))}</${tag}>`);
      }
      if (cells.length > 0) rows.push(`<tr>${cells.join('')}</tr>`);
    }
    return `<table>${rows.join('')}</table>`;
  }

  /**
   * Drop every row and column whose cells are all blank (empty or whitespace).
   * Returns a NEW grid; the input is never mutated. A grid with nothing left
   * becomes []. Columns are judged across all rows, so a column is kept as soon
   * as any single cell in it (header or body) has text.
   * @param {string[][]} grid
   * @returns {string[][]}
   */
  function trimEmptyGrid(grid) {
    if (!grid || grid.length === 0) return [];
    const colCount = grid.reduce((max, row) => Math.max(max, row.length), 0);
    const blank = (v) => !v || !String(v).trim();

    const keptCols = [];
    for (let c = 0; c < colCount; c++) {
      if (grid.some((row) => !blank(row[c]))) keptCols.push(c);
    }

    const out = [];
    for (const row of grid) {
      if (keptCols.every((c) => blank(row[c]))) continue; // whole row blank
      out.push(keptCols.map((c) => row[c] ?? ''));
    }
    return out;
  }

  function gridToHtmlTable(grid) {
    const rows = grid.map(
      (row) => `<tr>${row.map((c) => `<td>${escapeHtmlMultiline(c)}</td>`).join('')}</tr>`
    );
    return `<table>${rows.join('')}</table>`;
  }

  /**
   * Grid to a GitHub-flavored Markdown table. Markdown cannot express merged
   * cells, so spanned slots stay empty. First row is treated as the header.
   * @param {string[][]} grid
   */
  /**
   * Build the clipboard payload for a grid in the requested output format,
   * the single place the table/list copy paths choose what lands on the
   * clipboard:
   *   - 'spreadsheet' (Returns & Tab): rendered text/html table + TSV text/plain
   *   - 'markdown': Markdown text/plain only (so the source survives a paste)
   *   - 'html': rendered text/html table + the raw <table> markup as text/plain
   * Format strings mirror lib/messages.js FORMAT; unknown values fall back to
   * spreadsheet.
   * @param {string[][]} grid
   * @param {{ format?: string, htmlSource?: HTMLTableElement|null, flattenNewlines?: boolean }} [options]
   * @returns {{ html?: string, text: string }}
   */
  function gridToClipboard(grid, { format = 'spreadsheet', htmlSource = null, flattenNewlines = false } = {}) {
    if (format === 'markdown') {
      return { text: gridToMarkdownTable(grid) };
    }
    const html = toCleanHtmlTable(htmlSource, grid);
    if (format === 'html') {
      return { html, text: html };
    }
    return { html, text: gridToTsv(grid, { flattenNewlines }) };
  }

  function gridToMarkdownTable(grid) {
    if (grid.length === 0) return '';
    const colCount = grid[0].length;
    const header = grid[0];
    const body = grid.slice(1);
    const line = (cells) =>
      '| ' + cells.map((c) => mdCell(c)).join(' | ') + ' |';
    const separator = '| ' + Array(colCount).fill('---').join(' | ') + ' |';
    return [line(header), separator, ...body.map(line)].join('\n');
  }

  function mdCell(value) {
    return (value ?? '')
      .replaceAll('\\', '\\\\')
      .replaceAll('|', '\\|')
      .replaceAll(/\s*\n\s*/g, '<br>');
  }

  function escapeHtml(value) {
    return (value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function escapeHtmlMultiline(value) {
    return escapeHtml(value).replaceAll('\n', '<br>');
  }

  function isHidden(el) {
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden';
  }

  TG.formats = { gridToTsv, toCleanHtmlTable, gridToMarkdownTable, gridToClipboard, trimEmptyGrid };
})();
