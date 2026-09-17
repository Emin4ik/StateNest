import { z } from 'zod';

/**
 * The Claude Code hook wire format.
 *
 * Everything here is defensive by design. The payload shape is owned by Claude
 * Code and documented as changing between versions, so every field this plugin
 * reads is optional and every handler must work when it is absent. A hook that
 * throws on an unexpected payload would show the user an error in a tool they
 * did not ask to debug.
 *
 * Verified against the Claude Code hooks reference and observed payloads at
 * v2.1.273. See docs/research/claude-code-integration.md.
 */

export const HookInputSchema = z.looseObject({
  hook_event_name: z.string().optional(),
  session_id: z.string().optional(),
  /** Claude's actual working directory. Not the same as process.cwd(). */
  cwd: z.string().optional(),
  transcript_path: z.string().optional(),
  /** SessionStart: startup | resume | clear | compact | fork. */
  source: z.string().optional(),
  /** SessionEnd: clear | resume | logout | prompt_input_exit | other. */
  reason: z.string().optional(),
  /** PreCompact and PostCompact: manual | auto. */
  trigger: z.string().optional(),
  /** PostCompact: the model-written summary of the conversation so far. */
  compact_summary: z.string().optional(),
  /** PreCompact only. */
  custom_instructions: z.string().nullable().optional(),
  /** Stop: Claude's final message, which the docs prefer over the transcript. */
  last_assistant_message: z.string().optional(),
  /** Stop: true when Claude Code is already continuing because of a stop hook. */
  stop_hook_active: z.boolean().optional(),
});

export type HookInput = z.infer<typeof HookInputSchema>;

export type HookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'PreCompact'
  | 'PostCompact';

/**
 * Claude Code truncates any hook output string at this length. Exceeding it
 * silently loses the tail, so the context builder caps well below it.
 */
export const HOOK_OUTPUT_LIMIT = 10_000;

export interface HookOutput {
  /** Additional context for the model. Only meaningful on SessionStart. */
  additionalContext?: string;
  /** A one-line notice shown to the user. Used sparingly, for real problems. */
  systemMessage?: string;
}

/**
 * Build the JSON a hook writes to stdout.
 *
 * `additionalContext` has to sit inside `hookSpecificOutput` alongside a
 * matching `hookEventName`; placed at the top level it is accepted and then
 * silently ignored, which is the kind of bug that looks like "the plugin just
 * does nothing".
 */
export function buildHookResponse(event: HookEventName, output: HookOutput): string {
  const response: Record<string, unknown> = {};

  if (output.additionalContext !== undefined && output.additionalContext !== '') {
    response.hookSpecificOutput = {
      hookEventName: event,
      additionalContext: truncateForHook(output.additionalContext),
    };
  }
  if (output.systemMessage) {
    response.systemMessage = truncateForHook(output.systemMessage);
  }

  return JSON.stringify(response);
}

export function truncateForHook(text: string): string {
  if (text.length <= HOOK_OUTPUT_LIMIT) return text;
  return `${text.slice(0, HOOK_OUTPUT_LIMIT - 3)}...`;
}

/** Read all of stdin, with a deadline so a hook can never hang a session. */
export async function readStdin(timeoutMs = 2_000): Promise<string> {
  if (process.stdin.isTTY) return '';

  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.removeAllListeners('error');
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    const timer = setTimeout(finish, timeoutMs);
    // Do not hold the event loop open waiting for input that is not coming.
    timer.unref?.();

    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

export function parseHookInput(raw: string): HookInput {
  if (raw.trim() === '') return {};
  try {
    const parsed = HookInputSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * Run work with a hard deadline.
 *
 * SessionEnd hooks from a plugin share a budget of roughly 1.5 seconds that a
 * plugin's own `timeout` field cannot raise, and SessionStart delays the
 * model's first response one-for-one. Every handler is therefore bounded, and
 * returns whatever it has when time runs out rather than being killed
 * mid-write.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
