import pc from 'picocolors';
import { isBrainError } from '../util/errors.js';

/**
 * Terminal output.
 *
 * Two rules shape everything here:
 *
 * - Human output goes to stdout; diagnostics go to stderr. That is what makes
 *   `pb projects --json | jq` work even while a warning is being printed.
 *
 * - Nothing is ever truncated silently. When a column is cut, the ellipsis
 *   says so; when a list is capped, the footer says how many were left out.
 */

export interface OutputOptions {
  json?: boolean;
  quiet?: boolean;
  noColor?: boolean;
}

let colorEnabled = true;

export function configureColor(options: { noColor?: boolean } = {}): void {
  // NO_COLOR is the cross-tool convention; FORCE_COLOR overrides a non-TTY.
  const forced = process.env.FORCE_COLOR;
  if (options.noColor || process.env.NO_COLOR) {
    colorEnabled = false;
  } else if (forced && forced !== '0') {
    colorEnabled = true;
  } else {
    colorEnabled = Boolean(process.stdout.isTTY);
  }
  pc.createColors(colorEnabled);
}

export function colorsEnabled(): boolean {
  return colorEnabled;
}

const paint = {
  dim: (text: string) => (colorEnabled ? pc.dim(text) : text),
  bold: (text: string) => (colorEnabled ? pc.bold(text) : text),
  green: (text: string) => (colorEnabled ? pc.green(text) : text),
  yellow: (text: string) => (colorEnabled ? pc.yellow(text) : text),
  red: (text: string) => (colorEnabled ? pc.red(text) : text),
  cyan: (text: string) => (colorEnabled ? pc.cyan(text) : text),
  magenta: (text: string) => (colorEnabled ? pc.magenta(text) : text),
};

export const style = paint;

export function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${paint.yellow('warning')} ${message}\n`);
}

export function info(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function success(message: string): void {
  print(`${paint.green('✓')} ${message}`);
}

export function failure(message: string): void {
  print(`${paint.red('✗')} ${message}`);
}

export function heading(text: string): void {
  print(paint.bold(text));
}

/**
 * Render an error the way the brief demands: say what happened, show the
 * relevant context, and name a command that would fix it.
 */
export function printError(error: unknown): void {
  if (isBrainError(error)) {
    process.stderr.write(`\n${paint.red(error.message)}\n`);
    for (const detail of error.details) {
      process.stderr.write(`  ${paint.dim(detail)}\n`);
    }
    if (error.hints.length > 0) {
      process.stderr.write(`\n${paint.dim('Try:')}\n`);
      for (const hint of error.hints) {
        process.stderr.write(`  ${paint.cyan(hint)}\n`);
      }
    }
    process.stderr.write('\n');
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n${paint.red('Unexpected error:')} ${message}\n`);
  if (error instanceof Error && error.stack && process.env.PROJECT_BRAIN_DEBUG) {
    process.stderr.write(`${paint.dim(error.stack)}\n`);
  }
  process.stderr.write(
    `\n${paint.dim('This is probably a bug. Re-run with PROJECT_BRAIN_DEBUG=1 for a stack trace,')}\n` +
      `${paint.dim('then please report it at https://github.com/project-brain/project-brain/issues')}\n\n`,
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  /** Column is dropped entirely when the terminal is too narrow for it. */
  optional?: boolean;
  align?: 'left' | 'right';
  /** Longest this column may grow before its cells are ellipsised. */
  maxWidth?: number;
  paint?: (text: string, row: T) => string;
}

export function terminalWidth(): number {
  const columns = process.stdout.columns;
  // A piped or non-TTY stdout reports nothing; assume a comfortable width
  // rather than wrapping output that is about to be read by a human anyway.
  return typeof columns === 'number' && columns > 20 ? columns : 100;
}

/**
 * Render rows as an aligned table, dropping optional columns and shrinking
 * wide ones until the result fits the terminal.
 */
export function renderTable<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  if (rows.length === 0) return '';

  const width = terminalWidth();
  const gap = 2;

  let active = [...columns];
  let widths = measure(rows, active);

  // Drop optional columns from the right until the table fits.
  while (totalWidth(widths, gap) > width && active.some((column) => column.optional)) {
    const lastOptional = findLastIndex(active, (column) => Boolean(column.optional));
    if (lastOptional < 0) break;
    active = active.filter((_, index) => index !== lastOptional);
    widths = measure(rows, active);
  }

  // Still too wide: shrink the widest shrinkable column, one character at a
  // time, so the squeeze is shared rather than gutting a single column.
  let guard = 0;
  while (totalWidth(widths, gap) > width && guard++ < 500) {
    let widestIndex = -1;
    let widest = 0;
    for (let index = 0; index < widths.length; index++) {
      const candidate = widths[index]!;
      if (candidate > widest && candidate > 8) {
        widest = candidate;
        widestIndex = index;
      }
    }
    if (widestIndex < 0) break;
    widths[widestIndex] = widest - 1;
  }

  const lines: string[] = [];
  lines.push(
    paint.dim(
      active
        .map((column, index) => pad(column.header.toUpperCase(), widths[index]!, column.align))
        .join(' '.repeat(gap))
        .trimEnd(),
    ),
  );

  for (const row of rows) {
    const cells = active.map((column, index) => {
      const raw = truncate(column.value(row), widths[index]!);
      const padded = pad(raw, widths[index]!, column.align);
      return column.paint ? column.paint(padded, row) : padded;
    });
    lines.push(cells.join(' '.repeat(gap)).trimEnd());
  }

  return lines.join('\n');
}

function measure<T>(rows: readonly T[], columns: readonly Column<T>[]): number[] {
  return columns.map((column) => {
    let widest = column.header.length;
    for (const row of rows) {
      const length = visibleLength(column.value(row));
      if (length > widest) widest = length;
    }
    return column.maxWidth ? Math.min(widest, column.maxWidth) : widest;
  });
}

function totalWidth(widths: readonly number[], gap: number): number {
  if (widths.length === 0) return 0;
  return widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
}

function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const length = visibleLength(text);
  if (length >= width) return text;
  const padding = ' '.repeat(width - length);
  return align === 'right' ? padding + text : text + padding;
}

export function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (visibleLength(text) <= maxLength) return text;
  if (maxLength === 1) return '…';
  return `${text.slice(0, maxLength - 1)}…`;
}

/** Length ignoring ANSI escapes, so colored cells still align. */
function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/** `key: value` lines with the keys aligned, used by `pb show`. */
export function renderFields(fields: readonly [string, string][]): string {
  const width = Math.max(0, ...fields.map(([key]) => key.length));
  return fields
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${paint.dim(pad(`${key}`, width))}  ${value}`)
    .join('\n');
}

export function bullet(text: string, marker = '•'): string {
  return `  ${paint.dim(marker)} ${text}`;
}

export function statusColor(status: string): string {
  switch (status) {
    case 'active':
      return paint.green(status);
    case 'paused':
      return paint.yellow(status);
    case 'waiting':
      return paint.cyan(status);
    case 'archived':
      return paint.dim(status);
    default:
      return status;
  }
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
