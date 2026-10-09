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
  // form one cluster. A cluster is a real change when it holds at least NOISE_MIN_PX pixels, or is
  // a small SOLID blob (at least SOLID_MIN_PX pixels filling most of a box that is at least
  // SOLID_MIN_SIDE wide and high: a single redrawn icon or cell at low zoom). What is left are
  // lone pixels and sparse speckle (anti-aliasing flicker, a stroke that drew a pixel
  // differently), which is noise and is reported as `speckle`. The box spans every real
  // cluster, and the clusters themselves are returned (largest first) so a caller can tell
  // one change from several far apart.
  const TILE_SHIFT = 2;
  const TILE = 1 << TILE_SHIFT;
  const GAP = 3;
  const NOISE_MIN_PX = 48;
  const SOLID_MIN_PX = 9;
  const SOLID_MIN_SIDE = 3;
  const SOLID_FILL = 0.6;
  const MIN_CROP = 128;
  const MAX_CLUSTERS = 6;

  const isRealCluster = c => {
    if (c.px >= NOISE_MIN_PX) return true;
    const w = c.x1 - c.x0;
    const h = c.y1 - c.y0;
    return c.px >= SOLID_MIN_PX && w >= SOLID_MIN_SIDE && h >= SOLID_MIN_SIDE && c.px >= w * h * SOLID_FILL;
  };

  /**
   * Bounding box of the changed pixels of two RGBA buffers.
   * Returns {changed, significant, speckle, clusters:[{px, box}], box:[x0,y0,x1,y1]|null}; boxes
   * are in pixels with x1/y1 exclusive, null when nothing changed or only noise did. clusters
   * holds the real change clusters, largest first.
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
    if (!changed) return { changed, significant: 0, speckle: 0, clusters: [], box: null };
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
    const real = clusters.filter(isRealCluster).sort((p, q) => q.px - p.px);
    if (!real.length) return { changed, significant: 0, speckle: changed, clusters: [], box: null };
    let significant = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    for (const c of real) {
      significant += c.px;
      if (c.x0 < x0) x0 = c.x0;
      if (c.y0 < y0) y0 = c.y0;
      if (c.x1 > x1) x1 = c.x1;
      if (c.y1 > y1) y1 = c.y1;
    }
    return {
      changed,
      significant,
      speckle: changed - significant,
      clusters: real.map(c => ({ px: c.px, box: [c.x0, c.y0, c.x1, c.y1] })),
      box: [x0, y0, x1, y1]
    };
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
      box: r.box,
      clusterCount: r.clusters.length,
      clusters: r.clusters.slice(0, MAX_CLUSTERS)
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
    out.sheet = { cw, ch, gap, scale: canvas.width / tw };
    out.crop = encodeCanvas(canvas, a.format || "jpeg", a.quality);
    return out;
  };

  // The trade layer animates wagons and ships along the trade routes with d3 transitions that run
  // for minutes (a map load with the layer on starts them), so two shots of the same view differ
  // by ~100 px of moving markers. They are hidden for the length of a capture. Other motion (d3
  // transitions on the map, running Web Animations) is waited for instead.
  const FREEZE_ID = "tupaia-shot-freeze";
  const FREEZE_CSS = "#tradeAnimation{visibility:hidden!important}";

  function activeMotion() {
    let n = 0;
    try {
      for (const an of document.getAnimations()) if (an.playState === "running") n++;
    } catch {
      // getAnimations is not available: only d3 transitions count
    }
    const map = document.getElementById("map");
    if (map) {
      for (const el of map.querySelectorAll("*")) {
        if (el.__transition && !el.closest("#tradeAnimation")) n++;
      }
    }
    return n;
  }

  /**
   * Hide the trade animation and wait (at most maxMs, default 1500) until nothing else on the page
   * is still animating, so a shot taken right after an edit shows the finished drawing and two
   * shots of the same view match. Returns {waitedMs, active}: active > 0 means the wait ran out.
   * Pair with thaw.
   */
  FNS.freeze = async a => {
    if (!document.getElementById(FREEZE_ID)) {
      const st = document.createElement("style");
      st.id = FREEZE_ID;
      st.textContent = FREEZE_CSS;
      document.head.appendChild(st);
    }
    const t0 = Date.now();
    const end = t0 + (a?.maxMs ?? 1500);
    let active = activeMotion();
    while (active && Date.now() < end) {
      await new Promise(r => setTimeout(r, 50));
      active = activeMotion();
    }
    return { waitedMs: Date.now() - t0, active };
  };

  FNS.thaw = () => {
    document.getElementById(FREEZE_ID)?.remove();
    return { frozen: false };
  };

  T.tokens = { changedBox, padBox, activeMotion };
})(globalThis);
