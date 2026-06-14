// Convert the current selection to normalized plain text: hidden elements
// and script/style dropped, block boundaries become newlines, list items
// get "- " bullets, whitespace collapsed.
//
// Classic script injected on demand; registers on the shared namespace.
(() => {
  const TG = (globalThis.__TGX ??= {});

  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL',
    'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2',
    'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P',
    'PRE', 'SECTION', 'TABLE', 'TR', 'UL',
  ]);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'SVG']);

  function selectionToCleanText() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return '';

    const parts = [];
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);
      const text = rangeToCleanText(range);
      if (text) parts.push(text);
    }
    return parts.join('\n\n');
  }

  function rangeToCleanText(range) {
    // Walk the live range (not a detached clone) so computed styles are
    // available for hidden-element checks.
    let node = range.commonAncestorContainer;
    if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement ?? document.body;

    const out = [];
    walk(node, range, out);
    return out
      .join('')
      .replaceAll(/[ \t]*\n[ \t]*/g, '\n')
      .replaceAll(/\n{3,}/g, '\n\n')
      .replaceAll(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function walk(node, range, out) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!range.intersectsNode(node)) return;
      let text = node.nodeValue ?? '';
      // Clip the boundary text nodes to the selected portion.
      if (node === range.startContainer) text = text.slice(range.startOffset);
      if (node === range.endContainer) {
        const end = node === range.startContainer
          ? range.endOffset - range.startOffset
          : range.endOffset;
        text = text.slice(0, end);
      }
      const isPre = node.parentElement
        ? getComputedStyle(node.parentElement).whiteSpace.startsWith('pre')
        : false;
      out.push(isPre ? text : text.replaceAll(/[\s ]+/g, ' '));
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (!range.intersectsNode(node)) return;
    const tag = node.tagName;
    if (SKIP_TAGS.has(tag)) return;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return;

    if (tag === 'BR') {
      out.push('\n');
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag) || style.display === 'block' || style.display === 'list-item';
    if (isBlock) out.push('\n');
    if (tag === 'LI') out.push('- ');

    for (const child of node.childNodes) walk(child, range, out);

    if (isBlock) out.push('\n');
  }

  TG.cleanText = { selectionToCleanText };
})();
