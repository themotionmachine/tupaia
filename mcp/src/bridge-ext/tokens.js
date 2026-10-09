// Tupaia MCP bridge extension: token savers. Injected after bridge.js and bridge-mutations.js
// as a classic init script. Same rules as the core bridge: bare app globals at call time, no
// locals that shadow app globals, every FNS function takes one args object.
//
// diffRegion: pixel-diff two same-size PNG captures like diffImages, but instead of repainting the
// whole frame it finds the BOUNDING BOX of the changed pixels and returns only that region
// cropped from the new capture (or before | after side by side).
(root => {
  const T = root.__tupaia;
  if (!T) return;
  const FNS = T.fns;
  const fail = T.fail;

  const rn = (v, d = 2) => {
    const m = 10 ** d;
    return Math.round(v * m) / m;
  };

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
    return out;
  }

  function decodePng(b64) {
    return createImageBitmap(new Blob([b64ToBytes(b64)], { type: "image/png" }));
  }

  function canvasOf(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  function encodeCanvas(canvas, format, quality) {
    const mime = format === "png" ? "image/png" : "image/jpeg";
    const url = canvas.toDataURL(mime, quality ?? 0.85);
    return { b64: url.slice(url.indexOf(",") + 1), mime, width: canvas.width, height: canvas.height };
  }

  // Changed pixels are counted per TILE x TILE block, and blocks within GAP blocks of each other
  // form one cluster. A change needs at least one solid cluster (NOISE_MIN_PX pixels): what is
  // left are lone pixels and small speckle (anti-aliasing flicker, a river stroke that drew a
  // pixel differently), which is noise. The box then spans the clusters that are not tiny next
  // to the largest one (at least MIN_CLUSTER_PX pixels and REL_FLOOR of the largest), so
  // speckle around a real change cannot stretch it over the whole frame. Everything left out
  // is reported as `speckle`.
  const TILE_SHIFT = 2;
  const TILE = 1 << TILE_SHIFT;
  const GAP = 3;
  const MIN_CLUSTER_PX = 6;
  const NOISE_MIN_PX = 48;
  const REL_FLOOR = 0.15;
  const MIN_CROP = 128;

  /**
   * Bounding box of the changed pixels of two RGBA buffers.
   * Returns {changed, significant, speckle, box:[x0,y0,x1,y1]|null}; box is in pixels with
   * x1/y1 exclusive, null when nothing changed or only noise did.
   */
  function changedBox(da, db, w, h, thr) {
    const tw = Math.ceil(w / TILE);
    const th = Math.ceil(h / TILE);
    const cnt = new Uint32Array(tw * th);
    const bx0 = new Int32Array(tw * th).fill(0x7fffffff);
    const by0 = new Int32Array(tw * th).fill(0x7fffffff);
    const bx1 = new Int32Array(tw * th).fill(-1);
    const by1 = new Int32Array(tw * th).fill(-1);
    let changed = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const trow = (y >> TILE_SHIFT) * tw;
      for (let x = 0; x < w; x++) {
        const p = (row + x) * 4;
        const d = Math.max(Math.abs(da[p] - db[p]), Math.abs(da[p + 1] - db[p + 1]), Math.abs(da[p + 2] - db[p + 2]));
        if (d <= thr) continue;
        changed++;
        const t = trow + (x >> TILE_SHIFT);
        cnt[t]++;
        if (x < bx0[t]) bx0[t] = x;
        if (x > bx1[t]) bx1[t] = x;
        if (y < by0[t]) by0[t] = y;
        if (y > by1[t]) by1[t] = y;
      }
    }
    if (!changed) return { changed, significant: 0, speckle: 0, box: null };
    // clusters of non-empty tiles (flood fill with a GAP-tile reach)
    const seen = new Uint8Array(tw * th);
    const clusters = [];
    const stack = [];
    for (let s0 = 0; s0 < cnt.length; s0++) {
      if (!cnt[s0] || seen[s0]) continue;
      seen[s0] = 1;
      stack.push(s0);
      let px = 0;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -1;
      let y1 = -1;
      while (stack.length) {
        const t = stack.pop();
        px += cnt[t];
        if (bx0[t] < x0) x0 = bx0[t];
        if (by0[t] < y0) y0 = by0[t];
        if (bx1[t] > x1) x1 = bx1[t];
        if (by1[t] > y1) y1 = by1[t];
        const ty = Math.floor(t / tw);
        const tx = t - ty * tw;
        for (let dy = -GAP; dy <= GAP; dy++) {
          const yy = ty + dy;
          if (yy < 0 || yy >= th) continue;
          for (let dx = -GAP; dx <= GAP; dx++) {
            const xx = tx + dx;
            if (xx < 0 || xx >= tw) continue;
            const n = yy * tw + xx;
            if (cnt[n] && !seen[n]) {
              seen[n] = 1;
              stack.push(n);
            }
          }
        }
      }
      clusters.push({ px, x0, y0, x1: x1 + 1, y1: y1 + 1 });
    }
    let largest = 0;
    for (const c of clusters) if (c.px > largest) largest = c.px;
    if (largest < NOISE_MIN_PX) return { changed, significant: 0, speckle: changed, box: null };
    const floor = Math.max(MIN_CLUSTER_PX, largest * REL_FLOOR);
    let significant = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    for (const c of clusters) {
      if (c.px < floor) continue;
      significant += c.px;
      if (c.x0 < x0) x0 = c.x0;
      if (c.y0 < y0) y0 = c.y0;
      if (c.x1 > x1) x1 = c.x1;
      if (c.y1 > y1) y1 = c.y1;
    }
    return { changed, significant, speckle: changed - significant, box: [x0, y0, x1, y1] };
  }

  /** Pad a box, keep it at least MIN_CROP wide/high where the frame allows, clamp to the frame. */
  function padBox(box, w, h, padPx) {
    const [x0, y0, x1, y1] = box;
    const longer = Math.max(x1 - x0, y1 - y0);
    const pad = padPx === undefined || padPx === null ? Math.max(12, Math.round(longer * 0.1)) : Math.round(padPx);
    let nx0 = x0 - pad;
    let ny0 = y0 - pad;
    let nx1 = x1 + pad;
    let ny1 = y1 + pad;
    const grow = (lo, hi, max) => {
      const need = Math.min(MIN_CROP, max) - (hi - lo);
      if (need > 0) {
        lo -= Math.floor(need / 2);
        hi += Math.ceil(need / 2);
      }
      if (lo < 0) {
        hi -= lo;
        lo = 0;
      }
      if (hi > max) {
        lo -= hi - max;
        hi = max;
      }
      return [Math.max(0, lo), Math.min(max, hi)];
    };
    [nx0, nx1] = grow(nx0, nx1, w);
    [ny0, ny1] = grow(ny0, ny1, h);
    return [nx0, ny0, nx1, ny1];
  }

  /**
   * a: before (b64 PNG), b: after (b64 PNG), same size. threshold: per-channel difference that
   * counts as changed (default 32). Returns {changed, total, changedPct, speckle, w, h, box,
   * crop?, cropBox?}: box = tight pixel box of the changed region (null when nothing changed
   * or only noise), cropBox = the padded box actually cut, crop = encoded image of it from b
   * (before | after side by side with sideBySide), downscaled to maxSide.
   */
  FNS.diffRegion = async a => {
    const [ia, ib] = await Promise.all([decodePng(a.a), decodePng(a.b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) {
      fail("SIZE_MISMATCH", `cannot compare ${ia.width}x${ia.height} with ${ib.width}x${ib.height}`);
    }
    const w = ia.width;
    const h = ia.height;
    const ca = canvasOf(w, h).getContext("2d");
    const cb = canvasOf(w, h).getContext("2d");
    ca.drawImage(ia, 0, 0);
    cb.drawImage(ib, 0, 0);
    const da = ca.getImageData(0, 0, w, h).data;
    const db = cb.getImageData(0, 0, w, h).data;
    const r = changedBox(da, db, w, h, a.threshold ?? 32);
    const total = w * h;
    const out = {
      w,
      h,
      changed: r.changed,
      total,
      changedPct: rn((r.changed / total) * 100, 3),
      speckle: r.speckle,
      box: r.box
    };
    if (!r.box) return out;
    const cropBox = padBox(r.box, w, h, a.padPx);
    const [cx0, cy0, cx1, cy1] = cropBox;
    const cw = cx1 - cx0;
    const ch = cy1 - cy0;
    const gap = a.sideBySide ? Math.max(4, Math.round(cw * 0.01)) : 0;
    const tw = a.sideBySide ? cw * 2 + gap : cw;
    const sheet = canvasOf(tw, ch);
    const sc = sheet.getContext("2d");
    sc.fillStyle = a.sideBySide ? "#808080" : "#ffffff";
    sc.fillRect(0, 0, tw, ch);
    if (a.sideBySide) {
      sc.drawImage(ia, cx0, cy0, cw, ch, 0, 0, cw, ch);
      sc.drawImage(ib, cx0, cy0, cw, ch, cw + gap, 0, cw, ch);
    } else {
      sc.drawImage(ib, cx0, cy0, cw, ch, 0, 0, cw, ch);
    }
    let canvas = sheet;
    const s = Math.min(1, (a.maxSide || 1024) / Math.max(tw, ch));
    if (s < 1) {
      const c2 = canvasOf(Math.max(1, Math.round(tw * s)), Math.max(1, Math.round(ch * s)));
      const c2x = c2.getContext("2d");
      c2x.imageSmoothingQuality = "high";
      c2x.drawImage(sheet, 0, 0, c2.width, c2.height);
      canvas = c2;
    }
    out.cropBox = cropBox;
    out.crop = encodeCanvas(canvas, a.format || "jpeg", a.quality);
    return out;
  };

  T.tokens = { changedBox, padBox };
})(globalThis);
