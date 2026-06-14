// Stitch captured viewport frames into one tall PNG with OffscreenCanvas
// (available in MV3 service workers — no offscreen document needed).

// Conservative per-dimension canvas limit shared by Chromium targets.
const MAX_CANVAS_DIMENSION = 16384;

/**
 * @param {{ dataUrl: string, y: number }[]} frames frames with their actual scroll offsets (CSS px)
 * @param {{ scrollHeight: number, viewportHeight: number }} page page metrics in CSS px
 * @returns {Promise<{ blob: Blob, downscaled: boolean }>}
 */
export async function stitchFrames(frames, { scrollHeight, viewportHeight }) {
  const bitmaps = await Promise.all(
    frames.map(async ({ dataUrl }) => {
      const blob = await (await fetch(dataUrl)).blob();
      return createImageBitmap(blob);
    })
  );

  try {
    // Derive the real device pixel ratio from the capture itself — more
    // reliable than the page-reported value under browser zoom.
    const dpr = bitmaps[0].height / viewportHeight;
    const width = bitmaps[0].width;
    const lastFrame = frames.at(-1);
    const contentHeight = Math.min(scrollHeight, lastFrame.y + viewportHeight);
    const fullHeight = Math.round(contentHeight * dpr);

    const scale = Math.min(1, MAX_CANVAS_DIMENSION / fullHeight, MAX_CANVAS_DIMENSION / width);
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(fullHeight * scale))
    );
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw keyed to each frame's actual scroll offset; later frames simply
    // overwrite any overlap with the previous one.
    for (let i = 0; i < bitmaps.length; i++) {
      const destY = Math.round(frames[i].y * dpr * scale);
      ctx.drawImage(
        bitmaps[i],
        0,
        destY,
        Math.round(width * scale),
        Math.round(bitmaps[i].height * scale)
      );
    }

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { blob, downscaled: scale < 1 };
  } finally {
    for (const bitmap of bitmaps) bitmap.close();
  }
}

/**
 * Stitch a tall region from band frames: each frame is the full viewport
 * captured at a known scroll offset; crop it to the region rectangle and draw
 * it into a region-sized canvas. Used by tall region capture.
 *
 * @param {{ dataUrl: string, x: number, y: number }[]} frames frames with actual scroll offsets (CSS px)
 * @param {{ pageRect: {x:number,y:number,width:number,height:number}, viewportWidth: number, viewportHeight: number }} ctx
 * @returns {Promise<{ blob: Blob, downscaled: boolean }>}
 */
export async function stitchRegionFrames(frames, { pageRect, viewportWidth, viewportHeight }) {
  const bitmaps = await Promise.all(
    frames.map(async ({ dataUrl }) => createImageBitmap(await (await fetch(dataUrl)).blob()))
  );

  try {
    // Derive the real device pixel ratio from the capture itself.
    const dpr = bitmaps[0].width / viewportWidth;
    const fullWidth = Math.round(pageRect.width * dpr);
    const fullHeight = Math.round(pageRect.height * dpr);

    const scale = Math.min(1, MAX_CANVAS_DIMENSION / fullWidth, MAX_CANVAS_DIMENSION / fullHeight);
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(fullWidth * scale)),
      Math.max(1, Math.round(fullHeight * scale))
    );
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < bitmaps.length; i++) {
      const bmp = bitmaps[i];
      const { x: actualX, y: actualY } = frames[i];

      // Region ∩ this frame's viewport, in document CSS px.
      const left = Math.max(pageRect.x, actualX);
      const top = Math.max(pageRect.y, actualY);
      const right = Math.min(pageRect.x + pageRect.width, actualX + viewportWidth);
      const bottom = Math.min(pageRect.y + pageRect.height, actualY + viewportHeight);
      const widthCss = right - left;
      const heightCss = bottom - top;
      if (widthCss <= 0 || heightCss <= 0) continue;

      const sx = Math.round((left - actualX) * dpr);
      const sy = Math.round((top - actualY) * dpr);
      const sw = Math.min(bmp.width - sx, Math.round(widthCss * dpr));
      const sh = Math.min(bmp.height - sy, Math.round(heightCss * dpr));
      if (sw <= 0 || sh <= 0) continue;

      const dx = Math.round((left - pageRect.x) * dpr * scale);
      const dy = Math.round((top - pageRect.y) * dpr * scale);
      ctx.drawImage(bmp, sx, sy, sw, sh, dx, dy, Math.round(sw * scale), Math.round(sh * scale));
    }

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { blob, downscaled: scale < 1 };
  } finally {
    for (const bitmap of bitmaps) bitmap.close();
  }
}
