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

  TG.formats = { gridToTsv, toCleanHtmlTable, gridToMarkdownTable };
})();
