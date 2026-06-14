// Multi-format clipboard writing from a content script.
//
// Primary path: intercept the copy event and set both text/html and
// text/plain synchronously via execCommand('copy'). This is the most
// reliable way to write multiple formats and works in response to
// extension messages (no focus quirks).
//
// Fallback: async navigator.clipboard.write, which requires document focus.
//
// Classic script injected on demand by the service worker; registers on the
// shared isolated-world namespace instead of using ES exports (see content.js).
(() => {
  const TG = (globalThis.__TGX ??= {});

  /**
   * @param {{ html?: string, text: string }} data
   * @returns {Promise<boolean>} true if the clipboard was written
   */
  async function copyMultiFormat({ html, text }) {
    if (copyViaExecCommand({ html, text })) return true;
    return copyViaAsyncClipboard({ html, text });
  }

  function copyViaExecCommand({ html, text }) {
    let wroteData = false;
    const onCopy = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation(); // beat page-level copy hijackers
      if (html) e.clipboardData.setData('text/html', html);
      e.clipboardData.setData('text/plain', text);
      wroteData = true;
    };
    document.addEventListener('copy', onCopy, { capture: true });
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } finally {
      document.removeEventListener('copy', onCopy, { capture: true });
    }
    return ok && wroteData;
  }

  async function copyViaAsyncClipboard({ html, text }) {
    try {
      window.focus();
      const item = {
        'text/plain': new Blob([text], { type: 'text/plain' }),
      };
      if (html) item['text/html'] = new Blob([html], { type: 'text/html' });
      await navigator.clipboard.write([new ClipboardItem(item)]);
      return true;
    } catch (err) {
      console.warn('[Text Grab Extension] clipboard write failed:', err);
      return false;
    }
  }

  TG.clipboard = { copyMultiFormat };
})();
