import { NIST_CONTROL_TITLES } from "./nistControlTitles";

/** The compliance document that holds one row per control. */
export const SSP_SLUG = "system-security-plan";

const CONTROL_ID = /\b(?:AC|AT|AU|CA|CM|CP|IA|IR|MA|MP|PE|PL|PM|PS|PT|RA|SA|SC|SI|SR)-\d{1,2}(?:\(\d{1,2}\))?(?![\w(-])/g;
const ANCHOR_PREFIX = "control-";

/** Page anchor of a control's row in the system security plan: IA-2(1) -> control-ia-2-1. */
export function controlAnchor(id: string): string {
  return ANCHOR_PREFIX + id.toLowerCase().replace(/[()]/g, (c) => (c === "(" ? "-" : ""));
}

/** The control id a page hash points at, when it points at one. */
export function controlFromHash(hash: string): string | null {
  const anchor = hash.replace(/^#/, "");
  if (!anchor.startsWith(ANCHOR_PREFIX)) return null;
  return Object.keys(NIST_CONTROL_TITLES).find((id) => controlAnchor(id) === anchor) ?? null;
}

/** NIST's text of a control in the SP 800-53 Release 5.2.0 catalog, which pads ids: IA-2(1) -> IA-02(01). */
export function nistControlUrl(id: string): string {
  const padded = id.replace(/-(\d+)/, (_, n: string) => "-" + n.padStart(2, "0")).replace(/\((\d+)\)/, (_, n: string) => `(${n.padStart(2, "0")})`);
  return `https://csrc.nist.gov/projects/cprt/catalog#/cprt/framework/version/SP_800_53_5_2_0/home?element=${padded}`;
}

export function controlTitle(id: string): string | undefined {
  return NIST_CONTROL_TITLES[id];
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdNode[];
  data?: { hProperties?: Record<string, string> };
}

// Text in these nodes stays as written: links already point somewhere, and code is literal.
const SKIP = new Set(["link", "linkReference", "inlineCode", "code", "html", "definition"]);

// whitespace-nowrap keeps an id such as PS-2 on one line in the narrow id column.
function link(url: string, title: string, text: string): MdNode {
  return {
    type: "link",
    url,
    title,
    children: [{ type: "text", value: text }],
    data: { hProperties: { className: "whitespace-nowrap" } }
  };
}

function splitText(value: string, href: (id: string) => string): MdNode[] {
  const parts: MdNode[] = [];
  let last = 0;
  for (const match of value.matchAll(CONTROL_ID)) {
    const id = match[0];
    const title = NIST_CONTROL_TITLES[id];
    if (!title) continue;
    const at = match.index ?? 0;
    if (at > last) parts.push({ type: "text", value: value.slice(last, at) });
    parts.push(link(href(id), `${id}: ${title}`, id));
    last = at + id.length;
  }
  if (last === 0) return [{ type: "text", value }];
  if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
  return parts;
}

function linkText(node: MdNode, href: (id: string) => string): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (SKIP.has(child.type)) return [child];
    if (child.type === "text" && child.value) return splitText(child.value, href);
    linkText(child, href);
    return [child];
  });
}

/** The control id a table row is about: its first cell holds the id and nothing else. */
function rowControl(cell: MdNode | undefined): string | null {
  const only = cell?.children?.length === 1 ? cell.children[0] : undefined;
  if (only?.type !== "text") return null;
  const id = only.value?.trim() ?? "";
  return NIST_CONTROL_TITLES[id] ? id : null;
}

function anchorRows(node: MdNode): void {
  for (const child of node.children ?? []) {
    if (child.type === "tableRow") {
      const cell = child.children?.[0];
      const id = rowControl(cell);
      if (!cell || !id) continue;
      child.data = { ...child.data, hProperties: { ...child.data?.hProperties, id: controlAnchor(id) } };
      // The row's own id opens NIST's text of the control.
      cell.children = [link(nistControlUrl(id), `${id} in NIST SP 800-53 Rev. 5`, id)];
    } else {
      anchorRows(child);
    }
  }
}

export interface ControlLinkOptions {
  /** True for the system security plan: its rows get anchors, and its links stay on the page. */
  isSsp: boolean;
  /** Path or URL of the system security plan, for links from the other documents. */
  sspHref: string;
}

/**
 * Remark plugin: turns each Moderate control id in the text into a link to that
 * control's row in the system security plan, with the control's title on hover.
 * In the plan itself, each control row gets an anchor and its id links to NIST.
 */
export function remarkControlLinks(options: ControlLinkOptions) {
  const href = (id: string) => (options.isSsp ? "" : options.sspHref) + "#" + controlAnchor(id);
  return (tree: MdNode) => {
    if (options.isSsp) anchorRows(tree);
    linkText(tree, href);
  };
}
