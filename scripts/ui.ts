/**
 * Terminal rendering for the backend trace.
 *
 * One palette, one measure, one table engine. Colour is semantic — favourable
 * is blue, critical is terracotta, neutral is grey — never decoration. When the
 * output is piped or NO_COLOR is set, every glyph still lines up.
 */

const ANSI = /\x1b\[[0-9;]*m/g;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{20E3}]/gu;

export interface Style {
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
  italic?: boolean;
}

export type Tone =
  | "ink"
  | "dim"
  | "faint"
  | "accent"
  | "good"
  | "warn"
  | "bad"
  | "favorable"
  | "critical"
  | "neutral"
  | "unclear";

const RGB: Record<Tone, [number, number, number]> = {
  ink: [232, 227, 218],
  dim: [154, 148, 136],
  faint: [96, 91, 82],
  accent: [217, 178, 106],
  good: [134, 181, 106],
  warn: [217, 164, 65],
  bad: [217, 122, 108],
  favorable: [110, 159, 216],
  critical: [201, 138, 94],
  neutral: [163, 158, 147],
  unclear: [111, 106, 97],
};

export function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}

/** Terminal-safe text: no ANSI, no emoji, one line. */
export function clean(value: string | null | undefined): string {
  return stripAnsi(String(value ?? ""))
    .replace(EMOJI, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same, but keeps semantic colour that a table cell already carries. */
export function terminalText(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(EMOJI, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

function codePointLength(value: string): number {
  return [...value].length;
}

/** Truncate a styled string without counting its escape sequences. */
export function sliceVisible(value: string, max: number): string {
  if (codePointLength(stripAnsi(value)) <= max) return value;
  if (max <= 1) return "…";
  let out = "";
  let count = 0;
  let index = 0;
  let styled = false;
  while (index < value.length && count < max - 1) {
    if (value[index] === "\x1b") {
      const match = /^\x1b\[[0-9;]*m/.exec(value.slice(index));
      if (match) {
        out += match[0];
        styled = true;
        index += match[0].length;
        continue;
      }
    }
    out += value[index];
    count += 1;
    index += 1;
  }
  return `${out}…${styled ? "\x1b[0m" : ""}`;
}

function padVisible(value: string, width: number, align: "left" | "right"): string {
  const clipped = sliceVisible(value, width);
  const gap = Math.max(0, width - codePointLength(stripAnsi(clipped)));
  return align === "right" ? " ".repeat(gap) + clipped : clipped + " ".repeat(gap);
}

export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatMs(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatSigned(value: number, digits = 2): string {
  const fixed = value.toFixed(digits);
  return value > 0 ? `+${fixed}` : fixed;
}

export interface TableColumn {
  label: string;
  align?: "left" | "right";
  max?: number;
}

export interface UiOptions {
  color?: boolean;
  width?: number;
}

export class Ui {
  readonly color: boolean;
  readonly width: number;

  constructor(options: UiOptions = {}) {
    const noColor = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "";
    const columns = Number(process.env.COLUMNS ?? process.stdout.columns ?? 0);
    this.width = Math.min(Math.max(options.width ?? (columns || 92), 64), 116);
    this.color = options.color ?? (!noColor && Boolean(process.stdout.isTTY));
  }

  paint(text: string, tone: Tone = "ink", style: Style = {}): string {
    if (!this.color) return text;
    const [r, g, b] = RGB[tone];
    const codes: string[] = [];
    if (style.bold) codes.push("1");
    if (style.dim) codes.push("2");
    if (style.italic) codes.push("3");
    if (style.underline) codes.push("4");
    codes.push(`38;2;${r};${g};${b}`);
    return `\x1b[${codes.join(";")}m${text}\x1b[0m`;
  }

  bold(text: string): string {
    return this.paint(text, "ink", { bold: true });
  }

  dim(text: string): string {
    return this.paint(text, "dim");
  }

  /** A stage is a numbered step because the pipeline is genuinely ordered. */
  stage(index: number, title: string, subtitle?: string): string {
    const number = this.paint(String(index).padStart(2, "0"), "accent", { bold: true });
    const heading = `${number}  ${this.paint(title.toUpperCase(), "ink", { bold: true })}`;
    const right = subtitle ? `  ${this.paint(clean(subtitle), "faint")}` : "";
    const used = codePointLength(stripAnsi(heading)) + codePointLength(stripAnsi(right));
    const rule = "─".repeat(Math.max(2, this.width - used - 1));
    return `\n${heading} ${this.paint(rule, "faint")}${right}`;
  }

  step(label: string, tone: Tone = "ink"): string {
    return `\n  ${this.paint("▸", "accent")} ${this.paint(label, tone, { bold: true })}`;
  }

  note(text: string): string {
    return this.block(text, { prefix: "·", indent: 2, tone: "dim" });
  }

  warn(text: string): string {
    return this.block(text, { prefix: "!", indent: 2, tone: "warn" });
  }

  error(text: string): string {
    return this.block(text, { prefix: "×", indent: 2, tone: "bad" });
  }

  bullet(label: string, value?: string): string {
    const head = this.paint("·", "faint");
    if (!value) return `  ${head} ${this.paint(clean(label), "dim")}`;
    return `  ${head} ${this.paint(clean(label), "dim")}  ${this.paint(clean(value), "ink")}`;
  }

  /** Key/value rows, wrapped at the measure, never ragged. */
  kv(rows: Array<[string, string]>): string {
    const keyWidth = Math.min(16, Math.max(...rows.map(([key]) => clean(key).length), 4));
    return rows
      .map(([key, value]) => {
        const label = this.paint(clean(key).padEnd(keyWidth), "dim");
        const wrapped = this.wrap(clean(value), this.width - keyWidth - 2);
        return wrapped
          .map((line, index) => `  ${index === 0 ? label : " ".repeat(keyWidth)}  ${line}`)
          .join("\n");
      })
      .join("\n");
  }

  table(columns: TableColumn[], rows: string[][], indent = 2): string {
    if (rows.length === 0) return " ".repeat(indent) + this.dim("(no rows)");
    const widths = columns.map((column, index) => {
      const longest = Math.max(
        codePointLength(stripAnsi(terminalText(column.label))),
        ...rows.map((row) => codePointLength(stripAnsi(terminalText(row[index] ?? "")))),
      );
      return Math.min(longest, column.max ?? 40);
    });

    const available = this.width - indent - 2 * (columns.length - 1);
    let total = widths.reduce((sum, width) => sum + width, 0);
    while (total > available) {
      let widest = 0;
      for (let index = 1; index < widths.length; index++) {
        if (widths[index] > widths[widest]) widest = index;
      }
      if (widths[widest] <= 6) break;
      widths[widest] -= 1;
      total -= 1;
    }

    const line = (cells: string[], paint?: (cell: string, index: number) => string) =>
      " ".repeat(indent) +
      columns
        .map((column, index) => {
          const text = padVisible(terminalText(cells[index] ?? ""), widths[index], column.align ?? "left");
          return paint ? paint(text, index) : text;
        })
        .join("  ")
        .trimEnd();

    const head = line(columns.map((column) => column.label), (cell) => this.paint(cell, "dim"));
    const rule = " ".repeat(indent) + this.paint(
      columns.map((_, index) => "─".repeat(widths[index])).join("  "),
      "faint",
    );
    return [head, rule, ...rows.map((row) => line(row))].join("\n");
  }

  bar(value: number, max: number, width = 12, tone: Tone = "accent"): string {
    const safeMax = Math.max(1, max);
    const filled = Math.max(0, Math.min(width, Math.round((value / safeMax) * width)));
    const cells = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
    return this.paint(cells, tone);
  }

  badge(label: string, tone: Tone): string {
    return `${this.paint("●", tone)} ${this.paint(label, tone, { bold: true })}`;
  }

  box(
    title: string | null,
    lines: string[],
    options: { tone?: Tone; indent?: number; raw?: boolean } = {},
  ): string {
    const indent = options.indent ?? 0;
    const tone = options.tone ?? "faint";
    const inner = this.width - indent - 4;
    const headLabel = title ? ` ${clean(title)} ` : "";
    const top = `╭─${headLabel}${"─".repeat(Math.max(0, this.width - indent - 3 - headLabel.length))}╮`;
    const bottom = `╰${"─".repeat(this.width - indent - 2)}╯`;
    const body = lines.flatMap((line) => {
      if (!options.raw) {
        return this.wrap(line, inner).map((part) => `│ ${part.padEnd(inner)} │`);
      }
      const rawLine = terminalText(line);
      const clipped = sliceVisible(rawLine, inner);
      const gap = Math.max(0, inner - codePointLength(stripAnsi(clipped)));
      return [`│ ${clipped}${" ".repeat(gap)} │`];
    });
    return [top, ...body, bottom]
      .map((line) => " ".repeat(indent) + this.paint(line, tone))
      .join("\n");
  }

  quote(text: string, source?: string): string {
    const width = this.width - 6;
    const lines = this.wrap(clean(text), width);
    const body = lines.map((line) => `  ${this.paint("│", "faint")} ${this.paint(line, "ink", { italic: true })}`);
    if (source) body.push(`  ${this.paint("│", "faint")} ${this.paint(clean(source), "faint")}`);
    return body.join("\n");
  }

  divider(): string {
    return this.paint("─".repeat(this.width), "faint");
  }

  wrap(text: string, width = this.width): string[] {
    const value = clean(text);
    if (!value) return [""];
    const words = value.split(" ");
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      if (!line) {
        line = word;
        continue;
      }
      if (codePointLength(line) + 1 + codePointLength(word) <= width) {
        line += ` ${word}`;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  private block(
    text: string,
    options: { prefix: string; indent: number; tone: Tone },
  ): string {
    const width = this.width - options.indent - 2;
    const lines = this.wrap(text, width);
    return lines
      .map((line, index) =>
        " ".repeat(options.indent) +
        (index === 0 ? this.paint(options.prefix, options.tone) : " ") +
        " " +
        this.paint(line, options.tone),
      )
      .join("\n");
  }
}
