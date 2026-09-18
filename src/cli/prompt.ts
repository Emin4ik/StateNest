import { createInterface, type Interface } from 'node:readline/promises';
import { style } from './output.js';

/**
 * Minimal interactive prompts.
 *
 * Hand-rolled rather than pulled from a dependency because the needs are
 * small - a question, a yes/no, a checklist - and because a prompt library is
 * a surprisingly large amount of code to ship for an onboarding flow the user
 * sees once.
 *
 * Every prompt is non-interactive-safe: without a TTY it returns the default
 * instead of hanging, so `statenest init --yes` works in CI and inside a script.
 */

export interface PromptOptions {
  /** Answer used when there is no TTY or the user accepted the default. */
  defaultValue?: string;
  /** Force non-interactive behaviour, as `--yes` does. */
  assumeDefaults?: boolean;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

let sharedInterface: Interface | null = null;

function readline(): Interface {
  sharedInterface ??= createInterface({ input: process.stdin, output: process.stderr });
  return sharedInterface;
}

/** Close the shared readline, so the process can exit. */
export function closePrompts(): void {
  sharedInterface?.close();
  sharedInterface = null;
}

export async function ask(question: string, options: PromptOptions = {}): Promise<string> {
  const fallback = options.defaultValue ?? '';
  if (options.assumeDefaults || !isInteractive()) return fallback;

  const suffix = options.defaultValue ? style.dim(` (${options.defaultValue})`) : '';
  const answer = await readline().question(`${question}${suffix} `);
  return answer.trim() === '' ? fallback : answer.trim();
}

export async function confirm(
  question: string,
  options: { defaultValue?: boolean; assumeYes?: boolean } = {},
): Promise<boolean> {
  // `--yes` means yes. It used to mean "assume the default", which for the
  // prompts that matter - overwriting data, pushing to a remote - defaults to
  // no, so `statenest import --yes` printed "Cancelled. Nothing was changed." and
  // exited 0. A flag that silently does the opposite of what it says is worse
  // than no flag.
  if (options.assumeYes) return true;

  // Without that explicit authorisation, a non-interactive run takes the
  // cautious default rather than guessing.
  const fallback = options.defaultValue ?? true;
  if (!isInteractive()) return fallback;

  const hint = fallback ? 'Y/n' : 'y/N';
  const answer = (await readline().question(`${question} ${style.dim(`[${hint}]`)} `))
    .trim()
    .toLowerCase();
  if (answer === '') return fallback;
  return answer === 'y' || answer === 'yes';
}

export interface ChoiceItem {
  label: string;
  hint?: string;
  /** Pre-ticked in the checklist. */
  selected?: boolean;
}

/**
 * A numbered checklist.
 *
 * Used where the brief is explicit that StateNest must show candidates and
 * let the user choose - importing SSH hosts, picking scan roots - rather than
 * hoovering everything up and asking forgiveness later.
 */
export async function multiSelect(
  title: string,
  items: readonly ChoiceItem[],
  options: { assumeDefaults?: boolean } = {},
): Promise<number[]> {
  const preselected = items
    .map((item, index) => (item.selected ? index : -1))
    .filter((index) => index >= 0);

  if (options.assumeDefaults || !isInteractive() || items.length === 0) return preselected;

  process.stderr.write(`\n${title}\n\n`);
  items.forEach((item, index) => {
    const mark = item.selected ? style.green('[x]') : '[ ]';
    const hint = item.hint ? style.dim(`  ${item.hint}`) : '';
    process.stderr.write(`  ${mark} ${index + 1}. ${item.label}${hint}\n`);
  });
  process.stderr.write(
    `\n${style.dim('Enter numbers to toggle (e.g. "1 3 4"), "all", "none", or press enter to accept.')}\n`,
  );

  const answer = (await readline().question('> ')).trim().toLowerCase();
  if (answer === '') return preselected;
  if (answer === 'all') return items.map((_, index) => index);
  if (answer === 'none') return [];

  const selected = new Set(preselected);
  for (const token of answer.split(/[\s,]+/)) {
    const index = Number.parseInt(token, 10) - 1;
    if (!Number.isFinite(index) || index < 0 || index >= items.length) continue;
    if (selected.has(index)) selected.delete(index);
    else selected.add(index);
  }
  return [...selected].sort((a, b) => a - b);
}

/** A single choice from a short list. Returns the chosen index. */
export async function select(
  title: string,
  items: readonly ChoiceItem[],
  options: { defaultIndex?: number; assumeDefaults?: boolean } = {},
): Promise<number> {
  const fallback = options.defaultIndex ?? 0;
  if (options.assumeDefaults || !isInteractive() || items.length === 0) return fallback;

  process.stderr.write(`\n${title}\n\n`);
  items.forEach((item, index) => {
    const hint = item.hint ? style.dim(`  ${item.hint}`) : '';
    process.stderr.write(`  ${index + 1}. ${item.label}${hint}\n`);
  });

  const answer = (await readline().question(`\n${style.dim(`Choose [${fallback + 1}]`)} `)).trim();
  if (answer === '') return fallback;
  const index = Number.parseInt(answer, 10) - 1;
  return Number.isFinite(index) && index >= 0 && index < items.length ? index : fallback;
}
