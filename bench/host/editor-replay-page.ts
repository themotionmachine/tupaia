// Page side of the G-E editor replay (bench/host/editor-replay.ts). Every export is passed to page.evaluate, which
// serializes the function source: each must be self-contained (no imports, no module-level helpers). installReplay
// puts everything on window.__rp; the other exports only call into it.
/* eslint-disable @typescript-eslint/no-explicit-any */

export function installReplay(config: { arm: string; editors: string[] }) {
  const w = globalThis as any;
  if (w.__rp) return;
  const rp: any = (w.__rp = { arm: config.arm, step: null as any, errors: [] as string[] });

  // ---------------------------------------------------------------- hashing (cyrb53-style, two 32-bit lanes)
  const hasher = () => {
    let h1 = 0xdeadbeef ^ 0;
    let h2 = 0x41c6ce57 ^ 0;
    const api = {
      int(v: number) {
        h1 = Math.imul(h1 ^ v, 2654435761);
        h2 = Math.imul(h2 ^ v, 1597334677);
      },
      str(s: string) {
        for (let i = 0; i < s.length; i++) api.int(s.charCodeAt(i));
        api.int(s.length);
      },
      bytes(view: ArrayBufferView) {
        const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        const words = Math.floor(u8.length / 4);
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        for (let i = 0; i < words; i++) api.int(dv.getInt32(i * 4, true));
        for (let i = words * 4; i < u8.length; i++) api.int(u8[i]);
        api.int(u8.length);
      },
      done() {
        const a = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        const b = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
        return (b >>> 0).toString(16).padStart(8, "0") + (a >>> 0).toString(16).padStart(8, "0");
      }
    };
    return api;
  };
  const hashValue = (value: unknown) => {
    const h = hasher();
    const seen = new WeakSet<object>();
    const walk = (v: any) => {
      if (v === null) return h.int(1);
      switch (typeof v) {
        case "undefined":
          return h.int(2);
        case "boolean":
          return h.int(v ? 3 : 4);
        case "number":
          h.int(5);
          return h.str(Object.is(v, -0) ? "0" : String(v));
        case "string":
          h.int(6);
          return h.str(v);
        case "bigint":
          h.int(7);
          return h.str(String(v));
        case "function":
        case "symbol":
          return h.int(8);
      }
      if (ArrayBuffer.isView(v)) {
        h.int(9);
        return h.bytes(v as ArrayBufferView);
      }
      if (typeof Node !== "undefined" && v instanceof Node) return h.int(10);
      if (seen.has(v)) return h.int(11);
      seen.add(v);
      if (Array.isArray(v)) {
        h.int(12);
        h.int(v.length);
        for (const item of v) walk(item);
        return;
      }
      if (v instanceof Map) {
        h.int(13);
        for (const [k, item] of v) {
          walk(k);
          walk(item);
        }
        return;
      }
      if (v instanceof Set) {
        h.int(14);
        for (const item of v) walk(item);
        return;
      }
      h.int(15);
      for (const key of Object.keys(v).sort()) {
        h.str(key);
        walk(v[key]);
      }
    };
    walk(value);
    return h.done();
  };
  rp.hashValue = hashValue;
  const hashText = (text: string) => {
    const h = hasher();
    h.str(text);
    return h.done();
  };

  // pack/grid/notes, one hash per section; the per-cell and per-vertex tables one hash per array
  const SPLIT = new Set(["cells", "vertices"]);
  rp.modelHashes = () => {
    const out: Record<string, string> = {};
    for (const [rootName, root] of [
      ["pack", w.pack],
      ["grid", w.grid]
    ] as [string, any][]) {
      if (!root) continue;
      for (const key of Object.keys(root).sort()) {
        const value = root[key];
        if (SPLIT.has(key) && value && typeof value === "object" && !Array.isArray(value))
          for (const sub of Object.keys(value).sort()) out[`${rootName}.${key}.${sub}`] = hashValue(value[sub]);
        else out[`${rootName}.${key}`] = hashValue(value);
      }
    }
    out.notes = hashValue(w.notes ?? null);
    // Model that lives in top-level `let`s of the classic main.js (global bindings, not window properties), outside
    // pack/grid: the biomes editor renames and adds biomes in biomesData, the world configurator sets the climate and
    // map position in options, the namesbase editor edits nameBases.
    for (const name of ["biomesData", "options", "mapCoordinates", "nameBases"])
      out[name] = hashValue((0, eval)(`typeof ${name} === 'undefined' ? null : ${name}`));
    return out;
  };

  // ---------------------------------------------------------------- model DOM
  // Renderer-owned or animated state that is not model: the camera transform the GPU writes to #viewbox, the transient
  // viewport-culled class (label/emblem culling), blob: URLs (fresh per page), the running trade animation, and the
  // dense-zoom handoff (src/renderers/dense-zoom.ts: past a zoom threshold a compact raster such as the relief image is
  // hidden, data-zoom-hidden/data-zoom-visibility, and a [data-dense-zoom] overlay group draws it instead; it follows
  // the camera and lands whenever the zoom handler runs, so recording and replay saw it in different steps).
  const EXCLUDED = new Set(["tradeAnimation"]);
  const ZOOM_ATTRS = new Set(["data-zoom-hidden", "data-zoom-visibility"]);
  const ZOOM_STYLE = /\s*visibility:\s*hidden;?/g;
  const inOverlay = (el: Element | null) => Boolean(el?.closest?.("[data-dense-zoom]"));
  // a layer's HTML without the dense-zoom handoff: overlays dropped, hidden images as they are without it
  const zoomFree = (el: Element): string => {
    if (!el.querySelector("[data-dense-zoom], [data-zoom-hidden]") && !el.matches("[data-zoom-hidden]")) return el.outerHTML;
    const copy = el.cloneNode(true) as Element;
    for (const overlay of copy.querySelectorAll("[data-dense-zoom]")) overlay.remove();
    for (const image of [copy, ...copy.querySelectorAll("[data-zoom-hidden]")]) {
      if (!image.hasAttribute("data-zoom-hidden")) continue;
      for (const name of ZOOM_ATTRS) image.removeAttribute(name);
      const style = (image.getAttribute("style") ?? "").replace(ZOOM_STYLE, "").trim();
      if (style) image.setAttribute("style", style);
      else image.removeAttribute("style");
    }
    return copy.outerHTML;
  };
  const normClass = (value: string) =>
    value
      .split(/\s+/)
      .filter(name => name && name !== "viewport-culled")
      .join(" ");
  const normHtml = (html: string) =>
    html
      .replace(/blob:[^"')\s]+/g, "blob:")
      .replace(/ class="([^"]*)"/g, (_m, value) => {
        const kept = normClass(value);
        return kept ? ` class="${kept}"` : "";
      });
  const mapRoot = () => document.querySelector("svg#map") as SVGSVGElement;
  const excluded = (el: Element) => {
    for (let e: Element | null = el; e && e.id !== "map"; e = e.parentElement) if (EXCLUDED.has(e.id)) return true;
    return false;
  };
  const pathOf = (el: Element | null): string => {
    const parts: string[] = [];
    for (let e = el; e; e = e.parentElement) {
      if (e.id) {
        parts.unshift("#" + e.id);
        break;
      }
      const parent: Element | null = e.parentElement;
      // sibling index, not counting dense-zoom overlays (they come and go with the zoom)
      const siblings = parent ? [...parent.children].filter(kid => kid === e || !kid.matches("[data-dense-zoom]")) : [];
      parts.unshift(e.tagName.toLowerCase() + ":" + (parent ? siblings.indexOf(e) : 0));
      if (!parent) break;
    }
    return parts.join(">");
  };
  rp.pathOf = pathOf;
  // Pixels of the 2d canvases inside svg#map (the manual-assignment paint overlay, the heightmap editor's #heights):
  // outerHTML does not carry them, so an undo that only repaints one would be invisible to the DOM hash. The
  // renderer's own canvas lives outside svg#map; dense-zoom overlays are presentation.
  rp.canvasHashes = () => {
    const out: Record<string, string> = {};
    const root = mapRoot();
    if (!root) return out;
    for (const canvas of root.querySelectorAll("canvas")) {
      if (inOverlay(canvas)) continue;
      const key = "canvas " + pathOf(canvas);
      try {
        const context = (canvas as HTMLCanvasElement).getContext("2d");
        if (!context) {
          out[key] = "not-2d";
          continue;
        }
        const h = hasher();
        h.int(canvas.width);
        h.int(canvas.height);
        h.bytes(context.getImageData(0, 0, canvas.width, canvas.height).data);
        out[key] = h.done();
      } catch (error) {
        out[key] = "unreadable";
      }
    }
    return out;
  };
  rp.domHashes = () => {
    const out: Record<string, string> = {};
    const root = mapRoot();
    if (!root) return out;
    Object.assign(out, rp.canvasHashes());
    const attrs = [...root.attributes].map(a => a.name + "=" + a.value).sort();
    out["svg#map@attrs"] = hashText(attrs.join("\n"));
    for (const child of root.children) {
      if (child.id === "viewbox") {
        const vb = [...child.attributes].filter(a => a.name !== "transform").map(a => a.name + "=" + a.value).sort();
        out["#viewbox@attrs"] = hashText(vb.join("\n"));
        for (const layer of child.children)
          if (!EXCLUDED.has(layer.id)) out["#viewbox>" + (layer.id ? "#" + layer.id : pathOf(layer))] = hashText(normHtml(zoomFree(layer)));
      } else out[child.id ? "#" + child.id : pathOf(child)] = hashText(normHtml(zoomFree(child)));
    }
    return out;
  };

  // net model-DOM delta of a step, from a MutationObserver over svg#map
  rp.track = () => {
    const attrs = new Map<Element, Map<string, string | null>>();
    const lists = new Set<Element>();
    const texts = new Set<Element>();
    const handle = (records: MutationRecord[]) => {
      for (const r of records) {
        if (r.type === "attributes") {
          const el = r.target as Element;
          let map = attrs.get(el);
          if (!map) attrs.set(el, (map = new Map()));
          if (!map.has(r.attributeName!)) map.set(r.attributeName!, r.oldValue);
        } else if (r.type === "childList") {
          // a list change that only adds or removes dense-zoom overlays is presentation, not model
          const nodes = [...r.addedNodes, ...r.removedNodes];
          if (!nodes.every(n => n instanceof Element && n.matches("[data-dense-zoom]"))) lists.add(r.target as Element);
        }
        else if (r.type === "characterData") {
          const parent = (r.target as Node).parentElement;
          if (parent) texts.add(parent);
        }
      }
    };
    const observer = new MutationObserver(handle);
    observer.observe(mapRoot(), { subtree: true, attributes: true, attributeOldValue: true, childList: true, characterData: true });
    return () => {
      handle(observer.takeRecords());
      observer.disconnect();
      const root = mapRoot();
      const live = (el: Element) => el.isConnected && root.contains(el) && !excluded(el) && !inOverlay(el);
      const out: string[] = [];
      for (const [el, map] of attrs) {
        if (!live(el)) continue;
        for (const [name, old] of map) {
          if ((el.id === "viewbox" && name === "transform") || ZOOM_ATTRS.has(name)) continue;
          let now = el.getAttribute(name);
          let before = old;
          if (name === "class") {
            now = now == null ? null : normClass(now) || null;
            before = before == null ? null : normClass(before) || null;
          }
          // the handoff's visibility:hidden on an image it hid (now, or before the step)
          if (name === "style" && (el.hasAttribute("data-zoom-hidden") || map.has("data-zoom-hidden"))) {
            now = now == null ? null : now.replace(ZOOM_STYLE, "").trim() || null;
            before = before == null ? null : before.replace(ZOOM_STYLE, "").trim() || null;
          }
          if (now !== before) out.push(`${pathOf(el)} @${name}=${now == null ? "<removed>" : now.length > 120 ? "#" + hashText(normHtml(now)) : now}`);
        }
      }
      for (const el of lists)
        if (live(el)) {
          const kids = [...el.children].filter(kid => !kid.matches("[data-dense-zoom]") && !EXCLUDED.has(kid.id));
          out.push(`${pathOf(el)} children=${kids.length} #${hashText(normHtml(kids.map(zoomFree).join("")))}`);
        }
      for (const el of texts) if (live(el)) out.push(`${pathOf(el)} text#${hashText(el.textContent ?? "")}`);
      return out.sort();
    };
  };

  // ---------------------------------------------------------------- dispatch counting
  const WRAPPED = ["dispatchClick", ...config.editors];
  rp.calls = {} as Record<string, number>;
  rp.wrap = () => {
    for (const name of WRAPPED) {
      const fn = w[name];
      if (typeof fn !== "function" || fn.__rp) continue;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        w.__rp.calls[name] = (w.__rp.calls[name] ?? 0) + 1;
        return fn.apply(this, args);
      };
      (wrapped as any).__rp = true;
      w[name] = wrapped;
    }
  };

  // ---------------------------------------------------------------- camera
  const mapEl = () => document.getElementById("map")!;
  rp.camera = () => {
    const t = w.d3.zoomTransform(mapEl());
    return { k: t.k, x: t.x, y: t.y };
  };
  const sameCamera = (a: any, b: any) => a.k === b.k && a.x === b.x && a.y === b.y;
  rp.gpuView = () => {
    const v = w.gpuRenderer?.view;
    return v ? { k: v.k, x: v.x, y: v.y } : null;
  };
  // every pointer move during a step is compared with the step's starting camera (d3 zoom and the GPU camera)
  window.addEventListener(
    "mousemove",
    () => {
      const step = w.__rp.step;
      if (!step) return;
      const view = w.__rp.gpuView();
      if (!sameCamera(w.__rp.camera(), step.camera) || (view && step.gpuView && !sameCamera(view, step.gpuView))) step.cameraMoves++;
    },
    true
  );
  // trusted clicks on the event clock: the close input that starts the resume timer
  window.addEventListener("click", event => {
    if (event.isTrusted) w.__rp.lastClickAt = event.timeStamp;
  }, true);
  window.addEventListener("error", event => w.__rp.errors.push(String(event.message)));

  // ---------------------------------------------------------------- deterministic Math.random per step
  const native = Math.random;
  rp.seed = (seed: number) => {
    let s = seed >>> 0 || 1;
    Math.random = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  rp.unseed = () => (Math.random = native);
  // The heightmap brush drops every move whose event time stamp is not a multiple of 5 ms ("slow down the edit":
  // `~~d3.event.sourceEvent.timeStamp % 5 != 0`), so which cells a stroke edits depends on the wall clock. During a
  // step, mousemove time stamps read as multiples of 5 in every arm (all moves of a stroke count; the moves themselves
  // are the same frozen points). Other events, and every trusted click's stamp the resume timer uses, are untouched.
  const stamp = Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp")!;
  Object.defineProperty(MouseEvent.prototype, "timeStamp", {
    configurable: true,
    get(this: MouseEvent) {
      const t = stamp.get!.call(this) as number;
      return this.type === "mousemove" && w.__rp?.step ? Math.round(t / 5) * 5 : t;
    }
  });

  // ---------------------------------------------------------------- targets
  const branchOf = (el: Element | null) => {
    const parent = el?.parentElement;
    const grand = parent?.parentElement;
    const great = grand?.parentElement;
    const ancestor = great?.parentElement;
    if (!el || !parent || !grand || !great || !ancestor) return "ignored";
    if (grand.id === "emblems") return "emblems";
    if (parent.id === "rivers") return "rivers";
    if (grand.id === "routes") return "routes";
    if (ancestor.id === "labels" && el.tagName === "tspan") return "labels";
    if (grand.id === "burgLabels") return "burgLabels";
    if (grand.id === "burgIcons") return "burgIcons";
    if (parent.id === "ice") return "ice";
    if (parent.id === "terrain") return "terrain";
    if (grand.id === "markers" || great.id === "markers") return "markers";
    if (grand.id === "markets" && el.tagName !== "path") return "markets";
    if (grand.id === "goodsIcons") return "goodsIcons";
    if (parent.id === "goodsCells") return "goodsCells";
    if (grand.id === "goodsBurgs") return "goodsBurgs";
    if (grand.id === "coastline") return "coastline";
    if (grand.id === "lakes") return "lakes";
    if (great.id === "armies") return "armies";
    return "fallback";
  };
  rp.branchOf = branchOf;
  const VIEW = { left: 24, top: 24, right: 1256, bottom: 696 };
  const inView = (x: number, y: number) => x >= VIEW.left && x <= VIEW.right && y >= VIEW.top && y <= VIEW.bottom;
  const hit = (x: number, y: number) => document.elementFromPoint(x, y);
  const toWorld = (x: number, y: number) => {
    const p = new DOMPoint(x, y).matrixTransform((document.getElementById("viewbox") as any).getScreenCTM().inverse());
    return [p.x, p.y] as [number, number];
  };
  const toScreen = (wx: number, wy: number) => {
    const p = new DOMPoint(wx, wy).matrixTransform((document.getElementById("viewbox") as any).getScreenCTM());
    return [p.x, p.y] as [number, number];
  };
  rp.toWorld = toWorld;
  rp.toScreen = toScreen;
  // Candidate client points on an element: along a path from its middle outwards (with the path's screen normal, so a
  // dashed stroke is probed across the stroke, not into a dash gap), then its box from the centre out.
  const candidates = (el: Element) => {
    const out: [number, number, number, number][] = [];
    const geometry = el as SVGGeometryElement;
    if (el.tagName === "path" && typeof geometry.getTotalLength === "function") {
      const length = geometry.getTotalLength();
      const ctm = geometry.getScreenCTM();
      if (ctm && length > 0) {
        const at = (f: number) => geometry.getPointAtLength(length * Math.min(1, Math.max(0, f))).matrixTransform(ctm);
        for (let i = 0; i <= 90; i++) {
          const f = 0.5 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.01;
          const p = at(f);
          const a = at(f - 0.002);
          const b = at(f + 0.002);
          const tx = b.x - a.x;
          const ty = b.y - a.y;
          const n = Math.hypot(tx, ty) || 1;
          out.push([p.x, p.y, -ty / n, tx / n]);
        }
      }
    }
    const r = el.getBoundingClientRect();
    const grid: [number, number, number][] = [];
    for (let i = 1; i <= 9; i++) for (let j = 1; j <= 9; j++) grid.push([r.left + (r.width * i) / 10, r.top + (r.height * j) / 10, (i - 5) ** 2 + (j - 5) ** 2]);
    grid.sort((a, b) => a[2] - b[2]);
    for (const [x, y] of grid) out.push([x, y, 0, 0]);
    return out;
  };
  const robustOn = (el: Element, accept: (h: Element | null) => boolean) => {
    for (const [fx, fy, nx, ny] of candidates(el)) {
      const x = Math.round(fx);
      const y = Math.round(fy);
      if (!inView(x, y)) continue;
      if (!accept(hit(x, y))) continue;
      const near: [number, number][] = nx || ny
        ? [[Math.round(fx + 2 * nx), Math.round(fy + 2 * ny)], [Math.round(fx - 2 * nx), Math.round(fy - 2 * ny)]]
        : [[x + 2, y], [x - 2, y], [x, y + 2], [x, y - 2]];
      if (!near.every(([px, py]) => accept(hit(px, py)))) continue;
      return { x, y };
    }
    return null;
  };
  const elementOf = (target: any): Element | null => {
    if ("burg" in target) return document.querySelector(`#burgLabels text[data-id="${target.burg}"]`);
    if ("label" in target) return document.querySelector(`#labels text#${CSS.escape(target.label)}`);
    if ("route" in target) return document.querySelector(`#routes path#route${target.route}`);
    if ("marker" in target) return document.querySelector(`#markers svg#marker${target.marker}`);
    if ("selected" in target) return (0, eval)("typeof elSelected === 'undefined' || !elSelected ? null : elSelected.node()");
    if ("css" in target) {
      const all = [...document.querySelectorAll(`svg#map ${target.css}`)];
      const nth = target.nth ?? 0;
      return all[nth === "middle" ? Math.floor(all.length / 2) : nth === "last" ? all.length - 1 : nth] ?? null;
    }
    return null;
  };
  // world point of a focus (camera aim, or a point target)
  rp.focusWorld = (focus: any): [number, number] => {
    if ("world" in focus) return focus.world;
    if ("burg" in focus) {
      const b = w.pack.burgs[focus.burg];
      if (!b || b.removed) throw new Error(`no burg ${focus.burg}`);
      return [b.x, b.y];
    }
    if ("marker" in focus) {
      const m = w.pack.markers.find((m: any) => m.i === focus.marker);
      if (!m) throw new Error(`no marker ${focus.marker}`);
      return [m.x, m.y];
    }
    if ("route" in focus) {
      const r = w.pack.routes.find((r: any) => r.i === focus.route);
      if (!r) throw new Error(`no route ${focus.route}`);
      const p = r.points[Math.floor(r.points.length / 2)];
      return [p[0], p[1]];
    }
    if ("css" in focus) {
      const el = document.querySelector(`svg#map ${focus.css}`);
      if (!el) throw new Error(`no element ${focus.css}`);
      const r = el.getBoundingClientRect();
      // a culled or hidden element has an empty box: aiming at it would aim at the world origin
      if (!r.width || !r.height) throw new Error(`focus element ${focus.css} has an empty box (culled or hidden); use a world point`);
      return toWorld(r.left + r.width / 2, r.top + r.height / 2);
    }
    throw new Error("bad focus " + JSON.stringify(focus));
  };
  // a target's frozen client point (svg arm, recording) and the canonical element there
  rp.resolve = (target: any) => {
    if ("point" in target) {
      const [wx, wy] = rp.focusWorld(target.point);
      const [sx, sy] = toScreen(wx, wy);
      const x = Math.round(sx + (target.offset?.[0] ?? 0));
      const y = Math.round(sy + (target.offset?.[1] ?? 0));
      if (!inView(x, y)) throw new Error(`point target ${JSON.stringify(target)} is off screen at ${x},${y}`);
      return { x, y, hitKey: pathOf(hit(x, y)) };
    }
    if ("relief" in target) {
      const raster = document.querySelector("#terrain > image[data-relief]");
      if (!raster) throw new Error("no compact relief raster");
      const sprites = JSON.parse(raster.getAttribute("data-relief") || "[]") as { i: string; x: number; y: number; s: number }[];
      const ranked = sprites
        .map(s => {
          const [sx, sy] = toScreen(s.x + s.s / 2, s.y + s.s / 2);
          return { s, x: Math.round(sx), y: Math.round(sy), d: (sx - 640) ** 2 + (sy - 360) ** 2 };
        })
        .filter(c => inView(c.x, c.y))
        .sort((a, b) => a.d - b.d);
      for (const { s, x, y } of ranked) {
        const h = hit(x, y);
        if (branchOf(h) !== "fallback") continue;
        const [qx, qy] = toWorld(x, y);
        if (w.pickBurg?.(qx, qy) != null) continue;
        if (w.peekRelief?.(qx, qy)?.key !== "|" + s.i + "@" + s.x + "," + s.y) continue;
        return { x, y, hitKey: pathOf(h), relief: s };
      }
      throw new Error("no clickable relief sprite in view");
    }
    const el = elementOf(target);
    if (!el) throw new Error(`target ${JSON.stringify(target)} not found`);
    const accept = (h: Element | null) => !!h && el.contains(h) && (!("label" in target) || h.tagName === "tspan");
    const point = robustOn(el, accept);
    if (!point) {
      // what covers it: the hits at its first candidate points (the script then picks another camera or target)
      const seen = candidates(el)
        .filter((_c, i, all) => i % Math.max(1, Math.floor(all.length / 40)) === 0)
        .map(([x, y]) => [Math.round(x), Math.round(y)])
        .filter(([x, y]) => inView(x, y))
        .map(([x, y]) => pathOf(hit(x, y)));
      const counts: Record<string, number> = {};
      for (const key of seen) counts[key] = (counts[key] ?? 0) + 1;
      const r = el.getBoundingClientRect();
      const what = `${el.tagName}#${el.id} in ${pathOf(el.parentElement)} ${[...el.attributes].map(a => a.name + "=" + a.value.slice(0, 40)).join(" ")}`;
      throw new Error(`target ${JSON.stringify(target)} (${what}) has no robust click point in view; box ${[r.left, r.top, r.width, r.height].map(Math.round)}; hits ${JSON.stringify(counts).slice(0, 600)}`);
    }
    return { ...point, hitKey: pathOf(hit(point.x, point.y)) };
  };
  rp.hitKey = (x: number, y: number) => pathOf(hit(x, y));

  // ---------------------------------------------------------------- dialogs, GPU state
  rp.dialogs = () =>
    [...document.querySelectorAll(".ui-dialog-content")]
      .filter(el => el.id && w.$(el).dialog("instance") && w.$(el).dialog("isOpen"))
      .map(el => "#" + el.id)
      .sort();
  rp.gpuState = () => {
    const s = w.rendererStatus?.();
    const g = s?.gpu;
    return {
      active: s?.active ?? null,
      fallbackReason: s?.fallbackReason || null,
      state: g?.state ?? null,
      suspendedReason: g?.suspendedReason || null,
      canvasVisible: g?.canvasVisible ?? null,
      pending: g?.pending ?? null,
      // ms the post-action settle waited for the GPU (suspended+hidden, or a current frame); null = not reached
      settledMs: w.__rp.settledMs ?? null
    };
  };
  const status = () => w.rendererStatus?.()?.gpu;
  const current = (g: any) => g && g.canvasVisible && !g.pending && !g.suspendedReason && g.windows?.coverage === "covered" && g.state === "active";
  const refined = (g: any) => current(g) && !g.refinementPending && !g.moving;
  const frame = () => new Promise(done => requestAnimationFrame(done));
  const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
  // D13 (LIFE2): after an editor that changed the model closes, a GPU frame older than the latest DOM revision must
  // never be on screen. Every canvas style write (the only way it is revealed) and every frame the resume polls is
  // checked against the renderer's revision; hits are kept with their time on the event clock.
  rp.staleShows = [] as { at: number; frameRevision: number; revision: number; via: string }[];
  rp.staleCheck = (via: string) => {
    const g = status();
    if (!g?.canvasVisible || g.frameRevision == null || g.frameRevision === g.revision) return;
    if (rp.staleShows.length < 50) rp.staleShows.push({ at: performance.now(), frameRevision: g.frameRevision, revision: g.revision, via });
  };
  new MutationObserver(records => {
    if (records.some(record => (record.target as HTMLElement).dataset?.gpuRenderer !== undefined)) rp.staleCheck("reveal");
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["style"] });
  // Polled once per animation frame from the close input: the first current frame, then the first refined one.
  rp.resume = async (limitMs: number) => {
    const t0 = w.__rp.lastClickAt ?? performance.now();
    const prepares0 = status()?.prepares ?? null;
    let currentAt: number | null = null;
    let refinedAt: number | null = null;
    while (performance.now() - t0 < limitMs) {
      const g = status();
      if (w.rendererStatus?.()?.active !== "gpu") break;
      rp.staleCheck("frame");
      const now = performance.now();
      if (currentAt == null && current(g)) currentAt = now;
      if (refined(g)) {
        refinedAt = now;
        if (currentAt == null) currentAt = now;
        break;
      }
      await frame();
    }
    const g = status();
    const stale = rp.staleShows.filter((entry: { at: number }) => entry.at >= t0);
    return {
      staleShown: stale.length,
      staleFirst: stale.length ? { ...stale[0], at: Math.round(stale[0].at - t0) } : null,
      currentMs: currentAt == null ? null : Math.round(currentAt - t0),
      refinedMs: refinedAt == null ? null : Math.round(refinedAt - t0),
      timedOut: refinedAt == null,
      prepares: prepares0 == null || g?.prepares == null ? null : g.prepares - prepares0,
      lastPrepareMs: g?.lastPrepareMs ?? null,
      lastPrepare: g?.lastPrepare ? { ...g.lastPrepare, reuse: g.lastPrepare.reuse ?? undefined } : null
    };
  };
  // DOM quiet for `ms` (editors finish async work), bounded
  rp.quiet = async (ms = 250, limit = 5000) => {
    let last = performance.now();
    const observer = new MutationObserver(() => (last = performance.now()));
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const begin = performance.now();
    try {
      while (performance.now() - last < ms && performance.now() - begin < limit) await sleep(40);
    } finally {
      observer.disconnect();
    }
  };
  // After an action: the app settled and the DOM quiet. On GPU arms, also the renderer: with an editor open, suspended
  // with the canvas hidden (bounded by `suspendMs`: it should take a frame or two, and a canvas left on screen is a
  // finding the step reports, not something to wait out); otherwise a current frame (bounded by `limitMs`). Replay
  // clicks hit the canonical SVG, and gpu-select routing needs the current frame, not its refinement, so steps do not
  // wait for refinement (the close step's resume measures it).
  rp.settle = async (limitMs: number, suspendMs = 3000) => {
    w.__rp.settledMs = undefined;
    await frame();
    await frame();
    await w.__tupaia?.settle?.();
    await rp.quiet();
    if (w.__rp.arm === "svg") return;
    const begin = performance.now();
    while (true) {
      const s = w.rendererStatus?.();
      if (s?.active !== "gpu") return;
      const g = s.gpu;
      const open = rp.dialogs().length > 0;
      if (open ? !!g?.suspendedReason && !g.canvasVisible : current(g)) {
        w.__rp.settledMs = Math.round(performance.now() - begin);
        break;
      }
      if (performance.now() - begin > (open ? suspendMs : limitMs)) {
        w.__rp.settledMs = null;
        break;
      }
      await frame();
    }
    await frame();
  };
  rp.stopTrade = () => {
    w.TradeAnimation?.stop?.();
    w.d3?.select("#tradeAnimation").selectAll("*").interrupt();
  };
  rp.telemetry = () => {
    const sum: Record<string, number> = {};
    for (const counts of Object.values(w.gpuClickTelemetry?.byKind ?? {}) as Record<string, number>[])
      for (const key of ["routed", "resynced", "dropped", "legacy"]) sum[key] = (sum[key] ?? 0) + (counts[key] ?? 0);
    return sum;
  };
}

// Starts a step's observation: camera reference, dispatch counters, DOM tracker, seeded Math.random.
export function beginStep(arg: { index: number; seed: number }) {
  const rp = (globalThis as any).__rp;
  rp.wrap();
  rp.calls = {};
  rp.errors = [];
  rp.seed(arg.seed);
  rp.step = {
    index: arg.index,
    camera: rp.camera(),
    gpuView: rp.gpuView(),
    cameraMoves: 0,
    canvases: rp.canvasHashes(),
    stop: rp.track(),
    telemetry: rp.telemetry(),
    model: rp.lastModel ?? rp.modelHashes()
  };
}

// Ends a step after the action and its settle: the observation (minus point/hitKey, which the node side adds).
export function endStep() {
  const rp = (globalThis as any).__rp;
  const step = rp.step;
  rp.step = null;
  rp.unseed();
  const domDelta: string[] = step.stop();
  const model = rp.modelHashes();
  rp.lastModel = model;
  const canvases = rp.canvasHashes();
  const canvasChanged = [...new Set([...Object.keys(canvases), ...Object.keys(step.canvases)])].filter(k => canvases[k] !== step.canvases[k]).sort();
  const after = rp.telemetry();
  const routes: Record<string, number> = {};
  for (const key of Object.keys(after)) if (after[key] !== (step.telemetry[key] ?? 0)) routes[key] = after[key] - (step.telemetry[key] ?? 0);
  return {
    camera: rp.camera(),
    cameraMoves: step.cameraMoves,
    model,
    modelChanged: Object.keys(model).filter(k => model[k] !== step.model[k]).sort(),
    dom: rp.domHashes(),
    // a delta list can be long (a brush touches hundreds of elements): kept whole for the comparison
    domDelta,
    domDeltaCount: domDelta.length,
    canvasChanged,
    calls: { ...rp.calls },
    dialogs: rp.dialogs(),
    errors: [...rp.errors],
    gpu: rp.arm === "svg" ? undefined : rp.gpuState(),
    routes: rp.arm === "gpu-select" ? routes : undefined
  };
}
