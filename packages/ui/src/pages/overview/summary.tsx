import { issueLabels } from "../seo/labels";

export type SummaryBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

const listMarker = /^\s*(?:(- |\* |\+ )|(\d+[.)] ))/;

export function parseOverviewMarkdown(markdown: string): SummaryBlock[] {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const blocks: SummaryBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join(" ").trim() });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
    list = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const marker = listMarker.exec(line);
    if (!trimmed) {
      flushParagraph();
      flushList();
    } else if (marker) {
      flushParagraph();
      const ordered = Boolean(marker[2]);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(trimmed.replace(listMarker, "").trim());
    } else {
      flushList();
      paragraph.push(trimmed);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

export function labelAttentionText(text: string): string {
  const rules = Object.keys(issueLabels).sort((left, right) => right.length - left.length);
  if (!rules.length) return text;
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])(${rules.join("|")})(?=$|[^A-Za-z0-9_])`, "g");
  return text.replace(pattern, (_match, prefix: string, rule: string) => prefix + issueLabels[rule]);
}

export function attentionDestination(link: string, projectId: string): string {
  return link.startsWith("/p/") ? link : `/p/${projectId}/seo`;
}

export function OverviewSummary({ markdown }: { markdown: string }) {
  const blocks = parseOverviewMarkdown(markdown);
  return <div className="si-overview-readme-content">{blocks.map((block, index) => block.kind === "paragraph"
    ? <p key={`p-${index}`}>{block.text}</p>
    : block.ordered
      ? <ol key={`ol-${index}`}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ol>
      : <ul key={`ul-${index}`}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>)}</div>;
}
