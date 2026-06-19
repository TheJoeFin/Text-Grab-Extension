// Text Grab Extension service worker: context menus, keyboard commands,
// full-page capture orchestration, and launching the Text Grab app via
// the text-grab:// protocol.

import { MSG, REGION_MODE, FORMAT, TEXT_GRAB_URI } from '../lib/messages.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';
import {
  runFullPageCapture,
  runRegionCapture,
  runTallRegionCapture,
  saveImageForGrab,
} from './capture.js';

const MENU = {
  SELECT_REGION: 'tg-select-region',
  GRAB_TEXT_IMAGE: 'tg-grab-text-image',
  GRAB_FRAME_IMAGE: 'tg-grab-frame-image',
};

// Text Grab is a Windows-only app reached via the text-grab:// protocol, which
// does not exist on macOS/Linux. We gate every handoff surface on the OS so
// non-Windows users only see the cross-platform clipboard features.
let platformOsPromise;
async function isWindows() {
  platformOsPromise ??= chrome.runtime.getPlatformInfo();
  return (await platformOsPromise).os === 'win';
}

// v0.2 launch surface: region selection is the one front-door feature.
// The other capabilities (table copy, clean text, Markdown, links/images,
// full-page capture) remain implemented and message-reachable, but are not
// surfaced in menus or commands yet.
chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus();
});

async function setupContextMenus() {
  const onWindows = await isWindows();
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU.SELECT_REGION,
    title: onWindows
      ? 'Select region (screenshot, text, or table)'
      : 'Select region (copy text or table)',
    contexts: ['page', 'selection', 'link', 'image'],
  });
  // Image-only actions hand the right-clicked image to Text Grab — Windows only.
  if (onWindows) {
    chrome.contextMenus.create({
      id: MENU.GRAB_TEXT_IMAGE,
      title: 'Grab Text (OCR image to clipboard)',
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: MENU.GRAB_FRAME_IMAGE,
      title: 'Grab Frame (open image in Grab Frame)',
      contexts: ['image'],
    });
  }
}

// No popup: clicking the toolbar icon starts region selection directly.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    if (await fileAccessBlocks(tab)) return;
    await ensureContentAndSend(tab.id, { type: MSG.START_REGION_SELECT });
  } catch (err) {
    console.warn('[Text Grab Extension] cannot start region select here:', err);
  }
});

/**
 * Detect the one case where a grab silently does nothing: the tab is a local
 * file:// page but the user has not enabled "Allow access to file URLs" for the
 * extension. Without it Chrome blocks both the content-script injection and the
 * viewer's reads, so nothing can run in the tab to even report the problem.
 * When that's the situation, open a help page explaining the toggle and return
 * true so the caller skips the (doomed) normal path.
 */
async function fileAccessBlocks(tab) {
  if (!tab?.url?.startsWith('file://')) return false;
  try {
    if (await chrome.extension.isAllowedFileSchemeAccess()) return false;
  } catch {
    return false; // can't tell — let the normal path try
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL('help/file-access.html') });
  return true;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    if (info.menuItemId === MENU.SELECT_REGION) {
      if (await fileAccessBlocks(tab)) return;
      await ensureContentAndSend(tab.id, { type: MSG.START_REGION_SELECT });
    } else if (info.menuItemId === MENU.GRAB_TEXT_IMAGE) {
      await grabImage(info, tab, true);
    } else if (info.menuItemId === MENU.GRAB_FRAME_IMAGE) {
      await grabImage(info, tab, false);
    }
  } catch (err) {
    console.warn('[Text Grab Extension] menu action failed:', err);
  }
});

/**
 * Download the right-clicked image and hand it to Text Grab: OCR straight to
 * the clipboard (text-grab://grab-text) or open it in Grab Frame.
 */
async function grabImage(info, tab, asText) {
  const srcUrl = info.srcUrl;
  if (!srcUrl) {
    await toastTab(tab.id, 'No image source found here');
    return;
  }
  await toastTab(tab.id, asText ? 'Grabbing text from image…' : 'Opening image in Grab Frame…');
  try {
    const filePath = await saveImageForGrab(srcUrl);
    const uri = asText ? TEXT_GRAB_URI.GRAB_TEXT : TEXT_GRAB_URI.GRAB_FRAME;
    await launchTextGrab(tab.id, `${uri}?path=${encodeURIComponent(filePath)}`);
  } catch (err) {
    console.warn('[Text Grab Extension] image grab failed:', err);
    await toastTab(tab.id, `Could not grab the image: ${err.message}`);
  }
}

/** Best-effort page toast; silently ignored where the content script can't run. */
async function toastTab(tabId, text) {
  try {
    await sendToTab(tabId, { type: MSG.SHOW_TOAST, text });
  } catch {
    // content script unavailable (e.g. strict-CSP page) — app feedback covers it
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab?.id) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
  }
  try {
    if (command === 'select-region') {
      if (await fileAccessBlocks(tab)) return;
      await ensureContentAndSend(tab.id, { type: MSG.START_REGION_SELECT });
    }
  } catch (err) {
    console.warn('[Text Grab Extension] command failed:', err);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      // Bootstrap protocol: the content script asks the SW to inject its
      // classic modules (CSP-safe, unlike page-context import()) and to hand
      // over the shared constants (single source: lib/messages.js).
      case 'tg-inject': {
        if (typeof sender.tab?.id !== 'number') throw new Error('inject requires a tab');
        const files = injectableFiles(message.files);
        if (files.length === 0) throw new Error('no injectable files requested');
        await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
          files,
          injectImmediately: true,
        });
        return { ok: true };
      }
      case 'tg-constants':
        return {
          ok: true,
          consts: {
            MSG,
            REGION_MODE,
            FORMAT,
            TEXT_GRAB_URI,
            DEFAULT_SETTINGS,
            isWindows: await isWindows(),
          },
        };
      case MSG.LAUNCH_TEXT_GRAB: {
        const tabId = message.tabId ?? sender.tab?.id;
        await launchTextGrab(tabId, message.uri);
        return { ok: true };
      }
      case MSG.START_FULL_PAGE_CAPTURE: {
        const tabId = message.tabId ?? sender.tab?.id;
        const tab = await chrome.tabs.get(tabId);
        return captureFullPage(tab);
      }
      case MSG.REGION_SCREENSHOT: {
        const tab = sender.tab;
        if (!tab?.id) throw new Error('region capture must come from a tab');
        const filePath = await runRegionCapture(tab, message.rect, message.viewportWidth);
        await launchTextGrab(
          tab.id,
          `${TEXT_GRAB_URI.GRAB_FRAME}?path=${encodeURIComponent(filePath)}`
        );
        return { ok: true, filePath };
      }
      case MSG.REGION_SCREENSHOT_TALL: {
        const tab = sender.tab;
        if (!tab?.id) throw new Error('region capture must come from a tab');
        const filePath = await runTallRegionCapture(tab, message.rect, message.viewportWidth);
        await launchTextGrab(
          tab.id,
          `${TEXT_GRAB_URI.GRAB_FRAME}?path=${encodeURIComponent(filePath)}`
        );
        return { ok: true, filePath };
      }
      case MSG.OPEN_PDF_VIEWER:
        return openPdfViewer(message);
      case MSG.GET_PDF_BYTES: {
        const entry = pendingPdfs.get(message.id);
        if (!entry) return { ok: false, error: 'no pending PDF for this id' };
        pendingPdfs.delete(message.id);
        return { ok: true, base64: entry.base64, url: entry.url, name: entry.name };
      }
      default:
        return undefined;
    }
  })()
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true;
});

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

/**
 * Send a message to the tab's content script, injecting the bootstrap first so
 * it works even when no content script is present — e.g. a single-page app
 * (Reddit) tab that has not done a full page load since the extension was
 * (re)loaded, or any tab opened before install. Injecting content.js again on
 * a tab that already has it is a no-op (its load guard skips re-init).
 */
async function ensureContentAndSend(tabId, message) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
  } catch (err) {
    // Our own PDF viewer (an extension page) can't be injected, but it runs its
    // own message listener, so fall through and message it directly. Other
    // restricted pages (chrome://, the Web Store) simply have no listener and
    // the send below is a harmless no-op.
    console.warn('[Text Grab Extension] cannot inject into this tab:', err?.message ?? err);
  }
  try {
    await sendToTab(tabId, message);
  } catch (err) {
    console.warn('[Text Grab Extension] cannot reach this tab:', err?.message ?? err);
  }
}

// PDF bytes awaiting pickup by a just-opened viewer tab, keyed by a one-shot id.
// The viewer fetches them via GET_PDF_BYTES immediately on load; the entry is
// deleted on pickup. (The service worker may unload between handoff and pickup,
// in which case the viewer falls back to refetching the URL — see loadBytes.)
const pendingPdfs = new Map();
let pdfSeq = 0;

/**
 * Open the PDF in our own pdf.js viewer in a new tab. The content script
 * fetched the bytes same-origin (cookies/auth apply) when it could; we stash
 * them for the viewer to collect and also pass the URL as a fallback source.
 */
async function openPdfViewer({ pdfBase64, url, name, mode }) {
  const id = `pdf-${Date.now()}-${pdfSeq++}`;
  pendingPdfs.set(id, { base64: pdfBase64 ?? null, url: url ?? null, name: name ?? null });

  const params = new URLSearchParams({ id });
  if (name) params.set('name', name);
  if (mode) params.set('mode', mode);
  // A plain http(s)/file URL is a safe, cheap refetch fallback; data:/blob: are
  // not (origin-scoped or huge), so those rely on the stashed bytes only.
  if (url && /^(https?|file):/i.test(url)) params.set('url', url);

  const viewerUrl = chrome.runtime.getURL(`viewer/viewer.html?${params.toString()}`);
  await chrome.tabs.create({ url: viewerUrl });
  return { ok: true };
}

// Only allow injecting the extension's own module scripts, in case anything
// other than our content script ever reaches this handler.
const INJECTABLE = /^(lib|content|vendor)\/[\w-]+\.js$/;
function injectableFiles(files) {
  return Array.isArray(files) ? files.filter((f) => typeof f === 'string' && INJECTABLE.test(f)) : [];
}

/**
 * Launch the Text Grab app via its text-grab:// protocol. Navigating the
 * current tab to a custom scheme shows Chrome's external-protocol dialog
 * (one-time per origin with "Always allow") and leaves the page in place.
 */
async function launchTextGrab(tabId, uri) {
  if (typeof tabId !== 'number') {
    [{ id: tabId } = {}] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (typeof tabId !== 'number') throw new Error('no tab available to launch protocol');
  await chrome.tabs.update(tabId, { url: uri });
}

let captureInProgress = false;
async function captureFullPage(tab) {
  if (captureInProgress) return { ok: false, error: 'capture already running' };
  captureInProgress = true;
  try {
    await sendToTab(tab.id, { type: MSG.SHOW_TOAST, text: 'Capturing full page…' });
    const { filePath, frameCount } = await runFullPageCapture(tab);
    await sendToTab(tab.id, {
      type: MSG.SHOW_TOAST,
      text: `Captured ${frameCount} frames — opening in Text Grab`,
    });
    await launchTextGrab(
      tab.id,
      `${TEXT_GRAB_URI.GRAB_FRAME}?path=${encodeURIComponent(filePath)}`
    );
    return { ok: true, filePath };
  } catch (err) {
    console.warn('[Text Grab Extension] capture failed:', err);
    try {
      await sendToTab(tab.id, { type: MSG.CAPTURE_RESTORE });
      await sendToTab(tab.id, { type: MSG.SHOW_TOAST, text: `Capture failed: ${err.message}` });
    } catch {
      // tab may be gone
    }
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    captureInProgress = false;
  }
}
