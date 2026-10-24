import { memo, type ReactNode } from "react";

/*
 * Just enough markdown for agent transcripts: bold, italic, inline code,
 * bullet and numbered lists, and pipe tables. Everything passes through React
 * text nodes - no dangerouslySetInnerHTML, no raw HTML - so model output can
 * only ever render as text, emphasis, lists, and tables.
 */

const INLINE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|【[^】\n]+】)/g;

function inline(raw: string): ReactNode[] {
  // Models escape pipes in answers; a citation mark like 【Document: Lease】
  // becomes a chip instead of raw brackets.
  const text = raw.replace(/\\\|/g, "|");
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("【") && part.endsWith("】")) {
      return (
        <span key={i} className="bg-muted text-muted-foreground mx-0.5 inline-block rounded px-1 py-px align-baseline text-[11px]">
          {part.slice(1, -1)}
        </span>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={i} className="bg-muted rounded px-1 py-0.5 text-[0.85em]">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

const isTableLine = (line: string) => line.trim().startsWith("|") && line.trim().endsWith("|");
const isSeparatorLine = (line: string) => /^\|?[\s:|-]+\|?$/.test(line.trim()) && line.includes("-");
const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

function Table({ lines }: { lines: string[] }) {
  const [head, , ...body] = lines;
  return (
    <table className="my-1 border-collapse text-[12px]">
      <thead>
        <tr>
          {cells(head).map((c, i) => (
            <th key={i} className="border-border border px-2 py-1 text-left font-medium">{inline(c)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((row, r) => (
          <tr key={r}>
            {cells(row).map((c, i) => (
              <td key={i} className="border-border border px-2 py-1 align-top">{inline(c)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Renders one message's markdown. Blocks split on blank lines. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    if (lines[i].trim() === "") { i++; continue; }

    // Pipe table: header, separator, body rows.
    if (isTableLine(lines[i]) && i + 1 < lines.length && isSeparatorLine(lines[i + 1])) {
      const tableLines = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && isTableLine(lines[i])) { tableLines.push(lines[i]); i++; }
      blocks.push(<Table key={key++} lines={tableLines} />);
      continue;
    }

    // Bullet or numbered list.
    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(lines[i]) || numbered.test(lines[i])) {
      const ordered = numbered.test(lines[i]);
      const items: string[] = [];
      while (i < lines.length && (bullet.test(lines[i]) || numbered.test(lines[i]))) {
        items.push(lines[i].replace(bullet, "").replace(numbered, ""));
        i++;
      }
      const ListTag = ordered ? "ol" : "ul";
      blocks.push(
        <ListTag key={key++} className={`my-1 flex flex-col gap-0.5 ${ordered ? "list-decimal pl-7 marker:text-muted-foreground marker:font-normal" : "list-disc pl-5"}`}>
          {items.map((item, j) => <li key={j} className={ordered ? "pl-1" : undefined}>{inline(item)}</li>)}
        </ListTag>,
      );
      continue;
    }

    // Heading: keep the text, drop the #s.
    const heading = lines[i].match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      blocks.push(<p key={key++} className="mt-1 font-medium text-foreground">{inline(heading[1])}</p>);
      i++;
      continue;
    }

    // Paragraph: join wrapped lines with a space, like markdown does.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isTableLine(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push(<p key={key++}>{inline(para.join(" "))}</p>);
  }

  return <div className="flex flex-col gap-1.5">{blocks}</div>;
});
