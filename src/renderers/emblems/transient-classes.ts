// Shared canonical class snapshots for save/export and the optional GPU presentation layer.
// This module has no GPU dependency and allocates no DOM or rendering resources.
export const TRANSIENT_EMBLEM_CLASS = "viewport-culled";
export const emblemClassSignature = (value: string | null) =>
  (value ?? "")
    .split(/\s+/)
    .filter(name => name && name !== TRANSIENT_EMBLEM_CLASS)
    .sort()
    .join(" ");

// Preserve absence of class as well as its value for author [class] selectors during synchronous pick extraction.
const sourceClasses = new WeakMap<Element, string | null>();
export function emblemSourceClass(element: Element): { value: string | null } | undefined {
  if (!sourceClasses.has(element)) return;
  const original = sourceClasses.get(element)!;
  const current = element.getAttribute("class");
  const value =
    emblemClassSignature(current) === emblemClassSignature(original)
      ? original
      : (current
          ?.split(/\s+/)
          .filter(c => c !== TRANSIENT_EMBLEM_CLASS)
          .join(" ") ?? null);
  return { value };
}

// Call immediately after cloning the same source tree, before clone-only geometry transformations.
export function restoreHiddenEmblemClasses(source: Element, clone: Element): void {
  const originals = source.querySelectorAll("#emblems use");
  const copies = clone.querySelectorAll("#emblems use");
  originals.forEach((element, i) => {
    const snapshot = emblemSourceClass(element),
      copy = copies[i];
    if (!snapshot || !copy) return;
    if (snapshot.value === null) copy.removeAttribute("class");
    else copy.setAttribute("class", snapshot.value);
  });
}

export function rememberEmblemClass(element: Element, value: string | null): void {
  sourceClasses.set(element, value);
}

export function forgetEmblemClass(element: Element): void {
  sourceClasses.delete(element);
}
