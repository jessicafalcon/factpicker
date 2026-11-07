"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { factLabel, fmt, readingLabel, type Copy, type Locale } from "@/lib/i18n";
import type { FactItem, SankeyLink, SankeyNode } from "@/lib/graphql";


const VERDICT_COLOR: Record<string, { fill: string; soft: string }> = {
  "verdict:AGAINST": { fill: "var(--color-against)", soft: "var(--color-against-soft)" },
  "verdict:FOR": { fill: "var(--color-for)", soft: "var(--color-for-soft)" },
  "verdict:NONE": { fill: "var(--color-none)", soft: "var(--color-none-soft)" },
};

const compactViews = (views: number) =>
  views >= 1_000_000 ? `${(views / 1_000_000).toFixed(1).replace(/\.0$/, "")}M` : `${Math.round(views / 1000)}k`;

const verdictLabel = (id: string, copy: Copy) =>
  id === "verdict:FOR"
    ? copy.sankey.verdictFor
    : id === "verdict:AGAINST"
      ? copy.sankey.verdictAgainst
      : copy.sankey.verdictNone;

const WIDTH = 1100;
const FLOW_HEIGHT = 300;
const TOP = 52;
const NODE_W = 340;
const VERDICT_W = 250;
const READ_X = 300;
const VERDICT_X = 820;

function layout(nodes: SankeyNode[], links: SankeyLink[]) {
  const readings = nodes.filter((node) => node.column === 1);
  const verdicts = nodes.filter((node) => node.column === 2);
  const gap = 14;
  const boxHeight = (count: number) => Math.min(76, Math.max(46, 26 + count * 4));

  const place = (list: SankeyNode[], heightOf: (node: SankeyNode) => number) => {
    const total = list.reduce((sum, node) => sum + heightOf(node), 0) + gap * Math.max(0, list.length - 1);
    let y = TOP + Math.max(0, (FLOW_HEIGHT - total) / 2);
    const map = new Map<string, { y: number; h: number }>();
    for (const node of list) {
      const h = heightOf(node);
      map.set(node.id, { y, h });
      y += h + gap;
    }
    return map;
  };

  const readingBoxes = place(readings, (node) => boxHeight(node.videos));
  const verdictBoxes = place(verdicts, (node) => 64);

  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  const linksOut = links.map((link) => {
    const source = readingBoxes.get(link.source) ?? verdictBoxes.get(link.source) ?? {
      y: TOP,
      h: FLOW_HEIGHT,
    };
    const target = readingBoxes.get(link.target) ?? verdictBoxes.get(link.target) ?? {
      y: TOP,
      h: FLOW_HEIGHT,
    };
    const sourceTotal = links.filter((item) => item.source === link.source).reduce((sum, item) => sum + item.videos, 0) || 1;
    const targetTotal = links.filter((item) => item.target === link.target).reduce((sum, item) => sum + item.videos, 0) || 1;
    const usedOut = outgoing.get(link.source) ?? 0;
    const usedIn = incoming.get(link.target) ?? 0;
    const thicknessOut = (link.videos / sourceTotal) * source.h;
    const thicknessIn = (link.videos / targetTotal) * target.h;
    const y0 = source.y + usedOut;
    const y1 = target.y + usedIn;
    outgoing.set(link.source, usedOut + thicknessOut);
    incoming.set(link.target, usedIn + thicknessIn);
    const mid = (READ_X + (link.source === "fact" ? 40 : 0) + VERDICT_X) / 2;
    const path = [
      `M ${link.source === "fact" ? 52 : READ_X + NODE_W} ${y0}`,
      `C ${mid} ${y0}, ${mid} ${y1}, ${link.target.startsWith("verdict") ? VERDICT_X : READ_X} ${y1}`,
      `L ${link.target.startsWith("verdict") ? VERDICT_X : READ_X} ${y1 + thicknessIn}`,
      `C ${mid} ${y1 + thicknessIn}, ${mid} ${y0 + thicknessOut}, ${link.source === "fact" ? 52 : READ_X + NODE_W} ${y0 + thicknessOut}`,
      "Z",
    ].join(" ");
    return { ...link, path, thicknessOut };
  });

  return { readingBoxes, verdictBoxes, linksOut };
}

function wrap(label: string, max = 34): string[] {
  if (label.length <= max) return [label];
  const words = label.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > max && current) {
      lines.push(current);
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 2).map((line, index) => (index === 1 && lines.length > 2 ? `${line}…` : line));
}

export function ReadingsSankey({
  facts,
  selectedId,
  onSelect,
  locale,
  copy,
}: {
  facts: FactItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  locale: Locale;
  copy: Copy;
}) {
  const ordered = useMemo(() => [...facts].sort((a, b) => b.videos - a.videos), [facts]);
  const [hovered, setHovered] = useState<string | null>(null);

  if (ordered.length === 0) return null;
  const activeIndex = Math.max(0, ordered.findIndex((item) => item.id === selectedId));
  const fact = ordered[activeIndex];
  const { nodes, links, summary } = fact.sankey;
  const { readingBoxes, verdictBoxes, linksOut } = layout(nodes, links);
  const factNode = nodes.find((node) => node.column === 0);
  const readings = nodes.filter((node) => node.column === 1);
  const verdicts = nodes.filter((node) => node.column === 2);

  return (
    <section aria-labelledby="readings-heading" className="mx-auto max-w-[1180px] px-6">
      <h2
        id="readings-heading"
        className="max-w-[18ch] font-display text-[clamp(2rem,3.4vw,2.85rem)] leading-[1.1] tracking-[-0.02em]"
      >
        {copy.sankey.title}
      </h2>
      <p className="mt-5 max-w-[62ch] font-serif text-[clamp(1.05rem,1.5vw,1.2rem)] leading-[1.6] text-ink">
        {copy.sankey.intro}
      </p>

      <div className="mt-9 flex flex-wrap items-center gap-2">
        <span className="mr-1 font-sans text-[13px] font-semibold text-ink">{copy.sankey.pick}</span>
        {ordered.map((item, index) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={index === activeIndex}
            onClick={() => onSelect(item.id)}
            className={cn(
              "h-9 rounded-full border px-4 font-sans text-[13px] transition-colors",
              index === activeIndex
                ? "border-ink bg-ink text-paper"
                : "border-rule bg-transparent text-ink hover:border-ink/40",
            )}
          >
            {factLabel(item, locale)}
          </button>
        ))}
      </div>

      <div className="mt-8 border-t border-rule pt-8">
        <p className="font-sans text-[11px] font-bold uppercase tracking-[0.14em] text-ink">{copy.sankey.factEyebrow}</p>
        <h3 className="mt-1.5 font-display text-[clamp(1.4rem,2vw,1.75rem)] leading-tight tracking-[-0.01em]">
          {fact.category}
        </h3>
        <p className="mt-1 max-w-[46ch] font-serif text-[15px] leading-[1.5] text-ink-soft">
          {fact.statement} · {fmt(copy.sankey.videos, { n: fact.videos })}
        </p>

        {fact.videos < 4 ? (
          <p className="mt-8 max-w-[54ch] font-serif text-[16px] leading-[1.6] text-ink-soft">
            {fmt(copy.sankey.empty, { n: fact.videos })}
          </p>
        ) : (
          <>
            <figure className="mt-6 hidden sm:block">
              <svg
                viewBox={`0 0 ${WIDTH} ${TOP + FLOW_HEIGHT + 24}`}
                className="w-full"
                role="img"
                aria-label={`Flow from the fact to ${readings.length} readings and ${verdicts.length} verdicts. ${summary.againstPct}% against a candidate, ${summary.forPct}% in support, ${summary.nonePct}% no side.`}
              >
                <text x={READ_X} y={20} className="fill-ink-soft font-sans text-[10px] font-bold uppercase tracking-[0.12em]">
                  {copy.sankey.colReadings}
                </text>
                <text x={VERDICT_X} y={20} className="fill-ink-soft font-sans text-[10px] font-bold uppercase tracking-[0.12em]">
                  {copy.sankey.colVerdicts}
                </text>

                {linksOut.map((link) => {
                  const verdict = VERDICT_COLOR[link.target];
                  const base = link.target.startsWith("verdict") ? verdict.fill : "var(--color-rule)";
                  const dim = hovered && link.source !== hovered && link.target !== hovered;
                  return (
                    <path
                      key={`${link.source}-${link.target}`}
                      d={link.path}
                      fill={base}
                      opacity={dim ? 0.08 : link.target.startsWith("verdict") ? 0.42 : 0.3}
                      className="transition-opacity duration-200"
                    />
                  );
                })}

                <rect
                  x={42}
                  y={TOP}
                  width={10}
                  height={FLOW_HEIGHT}
                  rx={2}
                  fill="var(--color-ink)"
                />

                {readings.map((node) => {
                  const box = readingBoxes.get(node.id)!;
                  const lines = wrap(readingLabel(node.id, node.label, locale));
                  return (
                    <g
                      key={node.id}
                      onMouseEnter={() => setHovered(node.id)}
                      onMouseLeave={() => setHovered(null)}
                    >
                      <rect
                        x={READ_X}
                        y={box.y}
                        width={NODE_W}
                        height={box.h}
                        rx={6}
                        fill="var(--color-paper)"
                        stroke={hovered === node.id ? "var(--color-ink)" : "var(--color-rule)"}
                        strokeWidth={1}
                      />
                      <text x={READ_X + 14} y={box.y + (lines.length > 1 ? 22 : 26)} className="fill-ink font-serif text-[14px]">
                        {lines.map((line, index) => (
                          <tspan key={line} x={READ_X + 14} dy={index === 0 ? 0 : 17}>
                            {line}
                          </tspan>
                        ))}
                      </text>
                      <text
                        x={READ_X + NODE_W - 14}
                        y={box.y + 26}
                        textAnchor="end"
                        className="fill-ink-soft font-sans text-[11px]"
                      >
                        {node.videos}
                      </text>
                    </g>
                  );
                })}

                {verdicts.map((node) => {
                  const box = verdictBoxes.get(node.id)!;
                  const color = VERDICT_COLOR[node.id];
                  return (
                    <g key={node.id}>
                      <rect x={VERDICT_X} y={box.y} width={VERDICT_W} height={box.h} rx={6} fill={color.soft} />
                      <rect x={VERDICT_X} y={box.y} width={4} height={box.h} rx={2} fill={color.fill} />
                      <text x={VERDICT_X + 16} y={box.y + 27} className="fill-ink font-serif text-[14px]">
                        {verdictLabel(node.id, copy)}
                      </text>
                      <text x={VERDICT_X + 16} y={box.y + 46} className="fill-ink-soft font-sans text-[11px]">
                        {fmt(copy.sankey.viewsLine, { v: fmt(copy.sankey.videos, { n: node.videos }), views: compactViews(node.views) })}
                      </text>
                    </g>
                  );
                })}
              </svg>

              <table className="sr-only">
                <caption>{fact.statement}</caption>
                <thead>
                  <tr>
                    <th scope="col">Reading</th>
                    <th scope="col">Videos</th>
                  </tr>
                </thead>
                <tbody>
                  {readings.map((node) => (
                    <tr key={node.id}>
                      <th scope="row">{node.label}</th>
                      <td>{node.videos}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </figure>

            <div className="mt-6 sm:hidden" aria-label="Readings and verdicts">
              {readings.map((node) => {
                const split = links
                  .filter((link) => link.source === node.id)
                  .map((link) => ({ key: link.target, videos: link.videos, color: VERDICT_COLOR[link.target] }));
                return (
                  <div key={node.id} className="border-b border-rule py-4 last:border-b-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="font-serif text-[15.5px] leading-snug text-ink">{node.label}</p>
                      <span className="font-sans text-[12px] tabular-nums text-ink-soft">{node.videos}</span>
                    </div>
                    <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-paper-deep">
                      {split.map((part) => (
                        <span
                          key={part.key}
                          className="h-full"
                          style={{ width: `${(part.videos / node.videos) * 100}%`, background: part.color.fill, opacity: 0.75 }}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
              <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1 font-sans text-[11.5px] text-ink-soft">
                {verdicts.map((node) => (
                  <li key={node.id} className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: VERDICT_COLOR[node.id].fill }} />
                    {verdictLabel(node.id, copy)} · {node.videos}
                  </li>
                ))}
              </ul>
            </div>

            <figcaption className="mx-auto mt-8 max-w-[62ch] sm:mt-8 text-center font-serif text-[clamp(1rem,1.4vw,1.15rem)] leading-[1.6] text-ink">
              {fmt(copy.sankey.caption, {
                n: summary.videos,
                against: summary.againstPct,
                for: summary.forPct,
                none: summary.nonePct,
                top: summary.topReading
                  ? fmt(copy.sankey.captionTop, {
                      label: readingLabel(
                        readings.find((node) => node.label === summary.topReading)?.id ?? "",
                        summary.topReading,
                        locale,
                      ),
                    })
                  : "",
              })}
            </figcaption>
          </>
        )}
      </div>
    </section>
  );
}
