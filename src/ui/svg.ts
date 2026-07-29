/** Tiny helpers for building SVG and HTML nodes without a framework. */

const SVG_NS = 'http://www.w3.org/2000/svg';

export type Attrs = Record<string, string | number | boolean | null | undefined>;

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Node[] = [],
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  applyAttrs(node, attrs);
  for (const child of children) node.appendChild(child);
  return node;
}

export function applyAttrs(node: Element, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) {
      node.removeAttribute(key);
      continue;
    }
    node.setAttribute(key, value === true ? '' : String(value));
  }
}

/** Renders a trusted, project-authored SVG string into a detached element. */
export function svgFromString(markup: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = doc.documentElement;
  return document.importNode(root, true) as unknown as SVGSVGElement;
}

export function setText(node: Element | null, text: string): void {
  if (node && node.textContent !== text) node.textContent = text;
}

export function toggleAttr(node: Element, name: string, value: string | null): void {
  if (value === null) node.removeAttribute(name);
  else if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}
