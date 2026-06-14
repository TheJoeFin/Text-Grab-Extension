// Full-page scrolling capture: scroll the page viewport-by-viewport,
// capture each frame with tabs.captureVisibleTab (rate-limited ~2/sec),
// stitch into one PNG, save via chrome.downloads, and return the
// absolute file path for handoff to Text Grab.

import { MSG } from '../lib/messages.js';
import { stitchFrames, stitchRegionFrames } from './stitch.js';

const MIN_CAPTURE_INTERVAL_MS = 600;
const MAX_FRAMES = 60;

/**
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<{ filePath: string, frameCount: number, downscaled: boolean }>}
 */
export async function runFullPageCapture(tab) {
  const send = (msg) => chrome.tabs.sendMessage(tab.id, msg);

  // captureVisibleTab shoots the active tab of the window, so make sure
  // the target tab is the one in front.
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true });

  const page = await send({ type: MSG.CAPTURE_PREPARE });
  if (!page?.ok) throw new Error(page?.error ?? 'could not prepare page for capture');

  const { scrollHeight, viewportHeight } = page;
  let steps = Math.max(1, Math.ceil(scrollHeight / viewportHeight));
  if (steps > MAX_FRAMES) steps = MAX_FRAMES; // very tall pages get truncated

  const frames = [];
  let lastCaptureTime = 0;
  try {
    for (let i = 0; i < steps; i++) {
      const targetY = Math.min(i * viewportHeight, Math.max(0, scrollHeight - viewportHeight));
      const scrolled = await send({ type: MSG.CAPTURE_SCROLL_TO, y: targetY });
      if (!scrolled?.ok) throw new Error('page stopped responding during capture');

      const waitMs = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureTime);
      if (waitMs > 0) await sleep(waitMs);
      const dataUrl = await captureVisibleWithRetry(tab.windowId);
      lastCaptureTime = Date.now();

      frames.push({ dataUrl, y: scrolled.actualY });
      // Page refused to scroll further (shorter than reported, or scroll trapped)
      if (i > 0 && scrolled.actualY <= frames[i - 1].y) {
        frames.pop();
        break;
      }
    }
  } finally {
    try {
      await send({ type: MSG.CAPTURE_RESTORE });
    } catch {
      // page may have navigated away mid-capture
    }
  }

  if (frames.length === 0) throw new Error('no frames captured');

  const { blob, downscaled } = await stitchFrames(frames, { scrollHeight, viewportHeight });
  const filePath = await downloadPng(blob);
  return { filePath, frameCount: frames.length, downscaled };
}

async function captureVisibleWithRetry(windowId, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      const message = String(err?.message ?? err);
      const isQuota = message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
      if (!isQuota || attempt >= attempts) throw err;
      await sleep(400 * attempt);
    }
  }
}

/**
 * Capture a region taller than the viewport: scroll it past the screen band
 * by band, capture each frame, crop to the region, and stitch into one PNG.
 * Vertical scrolling only; regions wider than the viewport are clipped.
 * @param {chrome.tabs.Tab} tab
 * @param {{x:number, y:number, width:number, height:number}} pageRect document CSS px
 * @param {number} viewportWidth CSS px (fallback if the page doesn't report it)
 * @returns {Promise<string>} absolute file path of the saved PNG
 */
export async function runTallRegionCapture(tab, pageRect, viewportWidth) {
  const send = (msg) => chrome.tabs.sendMessage(tab.id, msg);
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true });

  const page = await send({ type: MSG.CAPTURE_PREPARE });
  if (!page?.ok) throw new Error(page?.error ?? 'could not prepare page for capture');

  const viewportHeight = page.viewportHeight;
  const vpWidth = page.viewportWidth ?? viewportWidth;
  const maxScrollY = Math.max(0, page.scrollHeight - viewportHeight);
  const maxScrollX = Math.max(0, (page.scrollWidth ?? vpWidth) - vpWidth);
  // Left-align the region horizontally (vertical-only scope), clamped to the page.
  const scrollX = Math.min(Math.max(0, Math.round(pageRect.x)), maxScrollX);

  const steps = Math.min(MAX_FRAMES, Math.max(1, Math.ceil(pageRect.height / viewportHeight)));

  const frames = [];
  let lastCaptureTime = 0;
  try {
    for (let i = 0; i < steps; i++) {
      const targetY = Math.min(pageRect.y + i * viewportHeight, maxScrollY);
      const scrolled = await send({ type: MSG.CAPTURE_SCROLL_TO, x: scrollX, y: targetY });
      if (!scrolled?.ok) throw new Error('page stopped responding during capture');

      const waitMs = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureTime);
      if (waitMs > 0) await sleep(waitMs);
      const dataUrl = await captureVisibleWithRetry(tab.windowId);
      lastCaptureTime = Date.now();

      frames.push({ dataUrl, x: scrolled.actualX ?? scrollX, y: scrolled.actualY });
      // Page refused to scroll further down: the last frame already reaches
      // the bottom of the region, so stop and drop the duplicate.
      if (i > 0 && scrolled.actualY <= frames[i - 1].y) {
        frames.pop();
        break;
      }
    }
  } finally {
    try {
      await send({ type: MSG.CAPTURE_RESTORE });
    } catch {
      // page may have navigated away mid-capture
    }
  }

  if (frames.length === 0) throw new Error('no frames captured');

  const { blob } = await stitchRegionFrames(frames, {
    pageRect,
    viewportWidth: vpWidth,
    viewportHeight,
  });
  return downloadPng(blob, 'region');
}

/**
 * Capture the visible viewport and crop it to a region rectangle
 * (viewport CSS px), then save the PNG and return its absolute path.
 */
export async function runRegionCapture(tab, rect, viewportWidth) {
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true });

  const dataUrl = await captureVisibleWithRetry(tab.windowId);
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    // Derive the device pixel ratio from the capture itself.
    const scale = bitmap.width / viewportWidth;
    const sx = Math.max(0, Math.round(rect.x * scale));
    const sy = Math.max(0, Math.round(rect.y * scale));
    const sw = Math.min(bitmap.width - sx, Math.round(rect.width * scale));
    const sh = Math.min(bitmap.height - sy, Math.round(rect.height * scale));
    if (sw < 1 || sh < 1) throw new Error('the region is outside the visible viewport');

    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const png = await canvas.convertToBlob({ type: 'image/png' });
    return downloadPng(png, 'region');
  } finally {
    bitmap.close();
  }
}

/**
 * Fetch the image at a URL and save it locally for handoff to Text Grab,
 * returning its absolute path. Decodable images are re-encoded to PNG so the
 * app can always read them; anything that can't be decoded (e.g. SVG) is saved
 * with its original bytes and extension.
 * @param {string} srcUrl the image source URL (http(s) or data:)
 * @returns {Promise<string>} absolute local file path
 */
export async function saveImageForGrab(srcUrl) {
  if (!srcUrl) throw new Error('no image source');
  // Hand the image URL straight to chrome.downloads, which fetches cross-origin
  // sources without host permissions. Text Grab decodes the original bytes, so
  // we no longer re-encode to PNG here (which had required a same-origin fetch).
  return downloadUrlToTextGrab(srcUrl, 'image', imageExtension(srcUrl));
}

/** Best-effort file extension from a data: URL's MIME type or the URL path. */
function imageExtension(srcUrl) {
  const dataMatch = /^data:image\/([a-z0-9.+-]+)[;,]/i.exec(srcUrl);
  if (dataMatch) {
    const sub = dataMatch[1].toLowerCase();
    return { jpeg: 'jpg', 'svg+xml': 'svg' }[sub] ?? sub;
  }
  const match = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(srcUrl);
  return match ? match[1].toLowerCase() : 'png';
}

/** Save a PNG blob to Downloads/TextGrab and resolve its absolute path. */
async function downloadPng(blob, prefix = 'capture', ext = 'png') {
  return downloadUrlToTextGrab(await blobToDataUrl(blob), prefix, ext);
}

/** Download any URL (data:, http(s):, file:) into Downloads/TextGrab and
 * resolve its absolute local path. */
async function downloadUrlToTextGrab(url, prefix = 'capture', ext = 'png') {
  const stamp = new Date()
    .toISOString()
    .replaceAll(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const downloadId = await withTimeout(
    chrome.downloads.download({
      url,
      filename: `TextGrab/${prefix}-${stamp}.${ext}`,
      conflictAction: 'uniquify',
      saveAs: false,
    }),
    15_000,
    'could not start the download'
  );

  await waitForDownloadComplete(downloadId);
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (!item?.filename) throw new Error('download finished but file path is unknown');
  return item.filename; // absolute local path
}

function waitForDownloadComplete(downloadId, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('download timed out'));
    }, timeoutMs);

    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') {
        cleanup();
        resolve();
      } else if (delta.state.current === 'interrupted') {
        cleanup();
        reject(new Error('download was interrupted'));
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
    };

    chrome.downloads.onChanged.addListener(onChanged);
    // The download may already be done by the time the listener attaches.
    chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (item?.state === 'complete') {
        cleanup();
        resolve();
      } else if (item?.state === 'interrupted') {
        cleanup();
        reject(new Error('download was interrupted'));
      }
    });
  });
}

// URL.createObjectURL and FileReader are unavailable in MV3 service
// workers, so base64-encode the blob into a data: URL by hand.
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}
