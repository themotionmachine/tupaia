// Font embedding of the export clone (prepareMapClone; also the GPU compat clone): which declared fonts it embeds and
// the @font-face rule it writes for each.
type FontDefinition = (typeof fonts)[number];

// Family names in a CSS font-family list, unquoted ("'Almendra SC', serif" -> Almendra SC, serif).
export function fontFamilies(value: string): string[] {
  return value
    .split(",")
    .map(name =>
      name
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2")
        .trim()
    )
    .filter(Boolean);
}

// Every declared font the clone names: font-family attributes, inline styles (inlineStyle wrote the computed family
// of every group) and <style> rules, plus getUsedFonts' own picks. getUsedFonts alone reads only #labels groups,
// #provs and #legend, so text elsewhere (markers, burg labels styled by a rule, regiments, a font set on a single
// label) rendered in the fallback font in exports and GPU compat rasters.
export function cloneFonts(clone: SVGSVGElement): FontDefinition[] {
  const named = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (value) for (const family of fontFamilies(value)) named.add(family);
  };
  for (const element of clone.querySelectorAll("[font-family]")) add(element.getAttribute("font-family"));
  const declared = /font-family\s*:\s*([^;}<]+)/g;
  for (const element of clone.querySelectorAll("[style*='font-family']"))
    for (const match of (element.getAttribute("style") || "").matchAll(declared)) add(match[1]);
  for (const style of clone.querySelectorAll("style"))
    for (const match of (style.textContent || "").matchAll(declared)) add(match[1]);
  const legacy = new Set(getUsedFonts(clone));
  return fonts.filter(font => legacy.has(font) || named.has(font.family));
}

// An @font-face rule with valid descriptors only: `variant` holds the Google CSS font-style (fonts.ts), which the old
// rule emitted as `font-variant` (not a descriptor, dropped by the parser) next to an empty `unicode-range:` that
// invalidated nothing but itself.
export function fontFace({ family, src, unicodeRange, variant }: FontDefinition): string {
  const descriptors = [`font-family: "${family}"`, `src: ${src}`];
  if (unicodeRange?.trim()) descriptors.push(`unicode-range: ${unicodeRange}`);
  if (variant && variant !== "normal") descriptors.push(`font-style: ${variant}`);
  return `@font-face {${descriptors.join("; ")};}`;
}
