// Decide what is ACTUALLY visible, accounting for scrolling/clipping ancestors.
//
// getBoundingClientRect() reports an element's geometric box even when an
// ancestor with overflow other than `visible` (a scrolling list, a fixed-height
// overflow:auto panel, an overflow:hidden card) has clipped it out of view. The
// capture paths used to test region overlap against that raw box, so content
// scrolled out of a list still got copied when the drawn region happened to
// cover its off-screen position. These helpers clip a rect to every such
// ancestor and report null when nothing of it remains on screen.
//
// Classic script injected on demand; registers on the shared namespace.
(() => {
  const TG = (globalThis.__TGX ??= {});

  /**
   * Clip a viewport rect to the content boxes of `startEl` and its ancestors
   * that clip overflow. Pass the element whose overflow can hide the rect:
   *   - an element's own box:  clipToScrollAncestors(el.getBoundingClientRect(), el.parentElement)
   *   - a text node's rect:    clipToScrollAncestors(textRect, node.parentElement)
   * (an element does not clip its own border box, so start at the parent).
   * @param {{left:number,top:number,right:number,bottom:number}} rect viewport CSS px
   * @param {Element|null} startEl ancestor walk start (inclusive)
   * @returns {{left,top,right,bottom,width,height}|null} null when fully clipped away
   */
  function clipToScrollAncestors(rect, startEl) {
    let { left, top, right, bottom } = rect;
    for (let p = startEl; p instanceof Element; p = p.parentElement) {
      const s = p.ownerDocument.defaultView.getComputedStyle(p);
      const clipsX = s.overflowX !== 'visible';
      const clipsY = s.overflowY !== 'visible';
      if (!clipsX && !clipsY) continue;
      const pr = p.getBoundingClientRect();
      if (clipsX) {
        left = Math.max(left, pr.left);
        right = Math.min(right, pr.right);
      }
      if (clipsY) {
        top = Math.max(top, pr.top);
        bottom = Math.min(bottom, pr.bottom);
      }
      if (right <= left || bottom <= top) return null;
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  /**
   * The on-screen rect of an element, clipped to its scrolling ancestors, or
   * null when it is scrolled/clipped entirely out of view.
   * @param {Element} el
   * @returns {{left,top,right,bottom,width,height}|null}
   */
  function visibleRect(el) {
    if (!(el instanceof Element)) return null;
    const r = clipToScrollAncestors(el.getBoundingClientRect(), el.parentElement);
    return r && r.width > 0 && r.height > 0 ? r : null;
  }

  TG.visibility = { clipToScrollAncestors, visibleRect };
})();
