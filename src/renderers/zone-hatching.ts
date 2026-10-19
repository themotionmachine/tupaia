const FILL = "data-zone-hatch-fill";
const CLONE = "data-zone-hatch-clone";
interface Redirect {
  original: string;
  cloneURL: string;
}
interface Hatch {
  original: SVGPatternElement;
  clone: SVGPatternElement;
  transform: string;
}
let map: SVGSVGElement | null = null;
let zoneLayer: Element | null = null;
let defs: Element | null = null;
let paths: SVGElement[] = [];
let redirects = new Map<SVGElement, Redirect>();
let hatches = new Map<SVGPatternElement, Hatch>();
let observer: MutationObserver | undefined;
let pathsDirty = true,
  fillsDirty = true,
  lastScale = NaN,
  serial = 0;
function reference(fill: string): string | undefined {
  return /^url\(\s*(["']?)#([^\s"'()]+)\1\s*\)$/.exec(fill)?.[2];
}
function ancestry(pattern: SVGPatternElement): SVGPatternElement[] | undefined {
  const chain: SVGPatternElement[] = [];
  const seen = new Set<Element>();
  let current: SVGPatternElement | null = pattern;
  while (current) {
    if (seen.has(current)) return;
    seen.add(current);
    chain.push(current);
    const href = current.getAttribute("href") || current.getAttribute("xlink:href");
    if (!href) return chain;
    if (!href.startsWith("#")) return;
    const parent = document.getElementById(href.slice(1));
    if (!parent || parent.tagName.toLowerCase() !== "pattern") return;
    current = parent as unknown as SVGPatternElement;
  }
  return chain;
}
function inherited(chain: SVGPatternElement[], name: string): string {
  return chain.find(pattern => pattern.hasAttribute(name))?.getAttribute(name) || "";
}
function restoreRedirect(path: SVGElement, previous: Redirect): void {
  const id = reference(previous.cloneURL);
  if (reference(path.style.fill) === id) path.style.fill = previous.original;
  if (reference(path.getAttribute("fill") || "") === id) path.setAttribute("fill", previous.original);
}
function discard(path: SVGElement): void {
  const previous = redirects.get(path);
  if (previous) restoreRedirect(path, previous);
  path.removeAttribute(FILL);
  redirects.delete(path);
}
function fill(path: SVGElement): { value: string; inline: boolean } {
  return path.style.fill
    ? { value: path.style.fill, inline: true }
    : { value: path.getAttribute("fill") || "", inline: false };
}
function write(path: SVGElement, value: string): void {
  if (path.style.fill) path.style.fill = value;
  else path.setAttribute("fill", value);
}
export function restoreZoneHatching(root: ParentNode): void {
  const clones = [...root.querySelectorAll<SVGPatternElement>(`pattern[${CLONE}]`)];
  const ids = new Set(clones.map(pattern => pattern.id));
  for (const path of root.querySelectorAll<SVGElement>(`[${FILL}]`)) {
    const original = path.getAttribute(FILL)!;
    if (ids.has(reference(path.style.fill) || "")) path.style.fill = original;
    if (ids.has(reference(path.getAttribute("fill") || "") || "")) path.setAttribute("fill", original);
    path.removeAttribute(FILL);
  }
  for (const pattern of clones) pattern.remove();
  if (root === map) {
    redirects.clear();
    hatches.clear();
    pathsDirty = fillsDirty = true;
    lastScale = NaN;
  }
}
export function normalizeZoneHatching(root: ParentNode, fullMap: boolean): void {
  if (fullMap) {
    restoreZoneHatching(root);
    return;
  }
  for (const path of root.querySelectorAll(`[${FILL}]`)) path.removeAttribute(FILL);
  for (const pattern of root.querySelectorAll(`pattern[${CLONE}]`)) pattern.removeAttribute(CLONE);
}
function mutations(records: MutationRecord[]): void {
  for (const record of records) {
    if (record.type === "childList") {
      pathsDirty = fillsDirty = true;
      continue;
    }
    const path = record.target as SVGElement,
      saved = redirects.get(path);
    // Our own fill redirects are observer-visible, but require no second update.
    if (saved && reference(fill(path).value) === reference(saved.cloneURL)) continue;
    fillsDirty = true;
  }
}
function synchronizeRoot(): void {
  const next = document.getElementById("map") as unknown as SVGSVGElement | null;
  if (next !== map) {
    observer?.disconnect();
    if (map) restoreZoneHatching(map);
    map = next;
    defs = null;
    zoneLayer = null;
    paths = [];
    redirects = new Map();
    hatches = new Map();
    pathsDirty = fillsDirty = true;
    lastScale = NaN;
    if (map) {
      restoreZoneHatching(map);
      defs = map.querySelector(":scope > defs");
    }
  }
  const candidate = document.getElementById("zones");
  const zones = candidate && map?.contains(candidate) ? candidate : null;
  if (zones !== zoneLayer) {
    observer?.disconnect();
    zoneLayer = zones;
    pathsDirty = fillsDirty = true;
    if (zoneLayer) {
      observer = new MutationObserver(mutations);
      observer.observe(zoneLayer, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["fill", "style"]
      });
    }
  }
  mutations(observer?.takeRecords() || []);
}
export function updateZoneHatching(k: number): void {
  if (!Number.isFinite(k) || k <= 0) return;
  synchronizeRoot();
  if (!map || !zoneLayer || !defs) return;
  if (k === lastScale && !pathsDirty && !fillsDirty) return;
  if (pathsDirty) {
    paths = [...zoneLayer.querySelectorAll<SVGElement>("[fill], [style]")];
    if (zoneLayer.hasAttribute("fill") || zoneLayer.hasAttribute("style")) paths.unshift(zoneLayer as SVGElement);
    const live = new Set(paths);
    for (const path of redirects.keys())
      if (!live.has(path)) {
        discard(path);
      }
    pathsDirty = false;
  }
  if (fillsDirty) {
    const used = new Set<Hatch>();
    for (const path of paths) {
      const current = fill(path).value,
        previous = redirects.get(path);
      const ownFill = previous && reference(current) === reference(previous.cloneURL);
      if (previous && !ownFill) restoreRedirect(path, previous);
      const original = ownFill ? previous.original : current;
      const id = reference(original),
        pattern = id ? document.getElementById(id) : null;
      const chain =
        pattern?.tagName.toLowerCase() === "pattern" ? ancestry(pattern as unknown as SVGPatternElement) : undefined;
      if (!chain || inherited(chain, "patternUnits") !== "userSpaceOnUse") {
        discard(path);
        continue;
      }
      const originalPattern = chain[0];
      let hatch = hatches.get(originalPattern);
      if (!hatch || hatch.clone.parentElement !== defs) {
        const clone = originalPattern.cloneNode(true) as SVGPatternElement;
        let name: string;
        do {
          name = `zone-hatch-${++serial}`;
        } while (document.getElementById(name));
        clone.id = name;
        clone.setAttribute(CLONE, "1");
        defs.appendChild(clone);
        hatch = {
          original: originalPattern,
          clone,
          transform: inherited(chain, "patternTransform")
        };
        hatches.set(originalPattern, hatch);
      }
      const cloneURL = `url(#${hatch.clone.id})`;
      redirects.set(path, { original, cloneURL });
      if (path.getAttribute(FILL) !== original) path.setAttribute(FILL, original);
      if (reference(current) !== reference(cloneURL)) write(path, cloneURL);
      used.add(hatch);
    }
    for (const [pattern, hatch] of hatches)
      if (!used.has(hatch)) {
        hatch.clone.remove();
        hatches.delete(pattern);
      }
    fillsDirty = false;
  }
  for (const { clone, transform } of hatches.values()) {
    const value = `scale(${1 / k})${transform ? ` ${transform}` : ""}`;
    if (clone.getAttribute("patternTransform") !== value) clone.setAttribute("patternTransform", value);
  }
  lastScale = k;
}
declare global {
  interface Window {
    updateZoneHatching: typeof updateZoneHatching;
    restoreZoneHatching: typeof restoreZoneHatching;
    normalizeZoneHatching: typeof normalizeZoneHatching;
  }
}
window.updateZoneHatching = updateZoneHatching;
window.restoreZoneHatching = restoreZoneHatching;
window.normalizeZoneHatching = normalizeZoneHatching;
