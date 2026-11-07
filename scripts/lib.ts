import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnv(): Record<string, string | undefined> {
  if (!process.env.ORIANE_API) {
    const path = resolve(process.cwd(), ".env");
    if (existsSync(path)) process.loadEnvFile(path);
  }
  return process.env;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Add it to .env (see .env.example).`);
  return value;
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export function num(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function table(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "(no rows)";
  const columns = Object.keys(rows[0]);
  const widths = columns.map((column) =>
    Math.max(
      column.length,
      ...rows.map((row) => String(row[column] ?? "").length),
    ),
  );
  const line = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  return [
    line(columns),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map((row) => line(columns.map((c) => String(row[c] ?? "")))),
  ].join("\n");
}
