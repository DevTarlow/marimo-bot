/**
 * Memory tools: `read_memory`, `update_memory` and `prune_memory`.
 *
 * None of them takes a path. Memory lives at exactly one app-owned location per
 * profile, so the model cannot aim a memory write at an arbitrary file, and no
 * approval gate is needed for the agent's own notebook. The file is still
 * inspectable — every call and its arguments are in the transcript.
 *
 * Failures come back as text rather than exceptions: a full disk or an
 * oversized rewrite should reach the model as something it can react to, not as
 * a broken turn.
 */
import {FunctionTool} from '@google/adk';
import {z} from 'zod';

import {memoryIndexNote} from '../memory/index-note.js';
import {memorySizeWarning} from '../memory/size.js';
import type {MemoryIndexState} from '../memory/index-note.js';
import type {MemoryStore} from '../memory/index.js';
import type {RecallLookup} from './recall-tools.js';

export interface MemoryToolContext {
  memory: MemoryStore;
  /**
   * Recall, when this install has it and memory is one of its corpora.
   *
   * The memory tools are the only place that knows a *write* happened, which is
   * the one moment worth doing two things at: telling the engine to come up so
   * the next turn's refresh is embedding rather than loading, and telling the
   * model that what it just wrote is not searchable yet. Absent means the feature
   * is off, and neither sentence is owed.
   */
  recall?: RecallLookup;
}

/**
 * Warms the recall engine after a memory write, and never lets it matter.
 *
 * Deliberately not awaited: the model is waiting on this tool result and loading
 * the weights takes seconds, while the turn that benefits is the next one. The
 * failure is dropped rather than reported for the same reason — a service that
 * cannot start will say so on the search that needs it, and a stored fact is not
 * a worse fact for having no index behind it.
 */
function warmRecall(recall: RecallLookup | undefined): void {
  try {
    void recall?.warm?.().catch(() => undefined);
  } catch {
    // A synchronous throw from an injected seam is still not the write's problem.
  }
}

/**
 * The index note for a call that has just written, or `''`.
 *
 * Every failure here is the same answer — say nothing — because this is an
 * annotation on a successful write. A lookup that cannot answer the question
 * must not turn a stored fact into an error.
 */
async function indexNote(
  context: MemoryToolContext,
  bullets: number,
): Promise<string> {
  const state: MemoryIndexState | undefined = await context.recall
    ?.memoryState?.()
    .catch(() => undefined);
  if (state === undefined) {
    return '';
  }
  return memoryIndexNote({state, bullets});
}

/** How many bullets a document holds, for a note that has to count them. */
function bulletCount(text: string): number {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/u.test(line)).length;
}

/**
 * How alike two bullets have to be before one is called a restatement.
 *
 * Higher than the retrieval floor, and for a different question. That floor
 * answers "is this worth putting in front of somebody"; this one answers "is
 * this the same sentence", and a false yes is worse than a false no — it tells
 * the model to remove a bullet that was a separate fact, which is the failure the
 * `replaces` path exists to avoid.
 *
 * **This number is a conservative starting point rather than a measurement**, and
 * it is deliberately too high rather than too low: too high means the advisory
 * rarely fires, too low means it fires on unrelated facts. `near-duplicate.live.test.ts`
 * is what measures it against real bullets when the weights are present, exactly
 * as the retrieval floor is pinned by its own live test.
 */
export const SAME_FACT_SCORE = 0.9;

/**
 * How long the advisory may take before it is skipped.
 *
 * A write is something the user is waiting on, and the engine may be cold. Short
 * enough to be invisible, which is the point: this is a hint, not a check, and a
 * missed hint costs nothing while a slow write costs a turn.
 */
const NEAR_DUPLICATE_DEADLINE_MS = 250;

/** How many bullets the advisory looks at. */
const NEAR_DUPLICATE_LIMIT = 3;

/** A bullet that already says something close to what is being written. */
export interface NearDuplicate {
  section: string;
  text: string;
  score: number;
}

/**
 * The nearest existing bullet, when it is close enough to be the same fact.
 *
 * Advisory and total. Every reason it cannot answer — no recall, no memory
 * corpus, an index that has not caught up with the file, a cold engine, a
 * search that took too long — answers `undefined`, and `undefined` renders as
 * no note at all. A write must never fail, or even slow down visibly, because a
 * second process could not be asked a question.
 *
 * Called *before* the write, and that is not a detail: run afterwards, the
 * bullet just added is in memory and in the index, so the nearest bullet to the
 * new fact is the new fact — a note that says every write duplicates itself.
 */
export async function findNearDuplicate(
  fact: string,
  recall: RecallLookup | undefined,
): Promise<NearDuplicate | undefined> {
  const query = fact.trim();
  if (recall === undefined || query.length === 0) {
    return undefined;
  }
  try {
    if (!recall.scopes().includes('memory')) {
      return undefined;
    }
    /*
     * A behind index is the one case where a wrong answer is likely rather than
     * merely possible: it is missing the bullets written since the last refresh,
     * so "nothing similar" would be a statement about a document that no longer
     * exists. The next write gets the note instead.
     */
    const state = await recall.memoryState?.();
    if (state?.behind === true) {
      return undefined;
    }
    const answer = await withDeadline(
      recall.search({
        query,
        scopes: ['memory'],
        limit: NEAR_DUPLICATE_LIMIT,
      }),
      NEAR_DUPLICATE_DEADLINE_MS,
    );
    const best = answer.hits
      .filter((hit) => hit.text.trim().length > 0)
      .sort((left, right) => right.score - left.score)[0];
    if (best === undefined || best.score < SAME_FACT_SCORE) {
      return undefined;
    }
    return {
      section: best.section ?? '',
      text: best.text,
      score: best.score,
    };
  } catch {
    return undefined;
  }
}

/**
 * What the model is told about a near-duplicate, in one paragraph.
 *
 * Written as a question about *this* bullet rather than as an instruction, and it
 * says which of the two things to do: memory holds one file of facts, so a
 * restatement should not be added twice and a contradiction must take the old
 * wording out. A note that only said "this looks similar" would leave a small
 * model to invent a third option.
 */
export function nearDuplicateNote(found: NearDuplicate): string {
  const where = found.section.length > 0 ? ` under "${found.section}"` : '';
  return (
    `Memory already holds something close to this${where}: ` +
    `"${found.text}" (similarity ${found.score.toFixed(2)}). ` +
    'If that is the same fact in different words, it does not need adding again. ' +
    'If this one corrects it, send it again with "replaces" set to that exact ' +
    `bullet so the old wording is removed — do not add a second version of it.`
  );
}

/**
 * A promise, or a rejection if it takes longer than the deadline.
 *
 * The same shape the host uses, and a local copy rather than a shared one
 * because the host asks a different question about a different thing: there, a
 * timeout changes what is in the prompt, and here it means no note. Sharing the
 * helper would tie a prompt's fallback to a hint's.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('the lookup took too long'));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function createReadMemoryTool(context: MemoryToolContext) {
  return new FunctionTool({
    name: 'read_memory',
    description:
      "Return the current contents of the agent's long-term memory — the facts " +
      'about this person and the facts about this workspace, together. The same ' +
      'contents are already included in your system prompt, so this is only for ' +
      're-checking your own recent writes.',
    parameters: z.object({}),
    execute: async () => {
      try {
        const text = await context.memory.read();
        const bytes = Buffer.byteLength(text, 'utf8');
        // Reported on every read, so the size is visible before the hard cap is
        // what makes it visible — the truncation in the prompt is the last
        // moment and by then the file has been heavy for a while.
        const sizeWarning = memorySizeWarning(
          bytes,
          context.memory.softLimitBytes,
        );
        const suffix = sizeWarning ? `\n\n${sizeWarning}` : '';
        if (text.trim().length === 0) {
          return 'Memory is empty. Use update_memory to record durable facts.';
        }
        /*
         * The facts first and the file note last. It used to lead with two
         * absolute paths, and a small model read that as an instruction: it
         * spent the turn calling `read_file` on them (refused, outside the
         * workspace) and then told the person it remembered nothing that was
         * right there in the text below.
         */
        return (
          `${text}\n\n(${String(bytes)} bytes. This is the app's memory file, ` +
          'not a workspace file: edit it with the memory tools, not the file ' +
          `tools.)${suffix}`
        );
      } catch (error) {
        return `Could not read memory: ${describeError(error)}`;
      }
    },
  });
}

export function createUpdateMemoryTool(context: MemoryToolContext) {
  return new FunctionTool({
    name: 'update_memory',
    description:
      'Add, correct or replace a fact in long-term memory. Use it for durable ' +
      'things a future session should know: who the user is, how they want to be ' +
      'talked to, what they have asked you never to do — and, separately, this ' +
      "project's conventions, paths and quirks. When the user corrects something " +
      'you already remembered, pass the old bullet as "replaces" so the wrong ' +
      'version does not stay behind. Never store secrets, credentials, or ' +
      'transient output. Duplicate facts are dropped rather than repeated.',
    parameters: z.object({
      content: z
        .string()
        .min(1)
        .describe(
          'The fact to remember. One fact per line; each line becomes a bullet.',
        ),
      section: z
        .string()
        .optional()
        .describe(
          'Layer to write into, e.g. "About the user", "Preferences and tone", ' +
            '"Environment and conventions", "Project pointers", "Boundaries". ' +
            'Defaults to "Notes".',
        ),
      scope: z
        .enum(['person', 'workspace'])
        .optional()
        .describe(
          'Which memory this belongs in, for a layer the list does not name. ' +
            '"person" is true everywhere the user goes (who they are, how they ' +
            'want to be talked to, what they forbid); "workspace" is true only ' +
            'inside the folder you are working in. Leave it out to let the ' +
            'section decide — a layer the app does not know goes to the workspace.',
        ),
      mode: z
        .enum(['append', 'replace'])
        .optional()
        .describe(
          'append (default) adds facts that are not already present; replace rewrites the whole section.',
        ),
      replaces: z
        .string()
        .optional()
        .describe(
          'When correcting a fact, the existing bullet to remove first — either ' +
            'the whole bullet or a leading substring of it, in the same section. ' +
            'The old bullet is deleted and the new one added, so both versions ' +
            'never sit next to each other.',
        ),
    }),
    execute: async ({content, section, scope, mode, replaces}) => {
      /*
       * Asked before the write, and only when nothing is being corrected: a call
       * that already names the bullet it replaces has answered this question
       * itself, and a whole-section rewrite is not a fact to compare.
       */
      const similar =
        replaces === undefined && (mode ?? 'append') === 'append'
          ? await findNearDuplicate(content, context.recall)
          : undefined;
      let report: Awaited<ReturnType<MemoryStore['update']>>;
      try {
        report = await context.memory.update({
          content,
          ...(section !== undefined ? {section} : {}),
          ...(scope !== undefined ? {scope} : {}),
          ...(mode !== undefined ? {mode} : {}),
          ...(replaces !== undefined ? {replaces} : {}),
        });
      } catch (error) {
        return `Could not update memory: ${describeError(error)}`;
      }
      const bytes = byteLength(report.content);
      const size = `${bytes} bytes`;
      /*
       * The correction path is reported in as many words, including when it did
       * nothing. The model cannot see the file, so "Replaced ..." is the only
       * evidence it has that the old bullet is gone — and a silent no-op would
       * let it believe it corrected something it did not.
       */
      let outcome: string;
      switch (report.supersede.outcome) {
        case 'removed':
          outcome = `Updated memory (now ${size}). Replaced "${report.supersede.removed}". The new contents are in your prompt on the next request.`;
          break;
        case 'absent':
          outcome = `Updated memory (now ${size}), but nothing in "${
            (section ?? 'Notes').trim() || 'Notes'
          }" matched "${replaces}" so no old bullet was removed. The fact you were correcting may still be there under other words; check read_memory and retry if so.`;
          break;
        case 'ambiguous':
          outcome = `Updated memory (now ${size}), but "${replaces}" matched ${String(
            report.supersede.matches ?? 0,
          )} bullets, so none was removed. Pass more of the bullet you mean, or use mode "replace" to rewrite the section.`;
          break;
        default:
          outcome = `Updated memory (now ${size}). The new contents are in your prompt on the next request.`;
      }
      // A write is the moment the file got bigger, so the size advice lands
      // here as well as on a read: a run that never calls read_memory still
      // gets told before the file is the cap's problem.
      const warning = memorySizeWarning(bytes, context.memory.softLimitBytes);
      /*
       * And the moment the file and its vectors diverge, which is the other thing
       * only this call knows. The warm is requested before the state is asked
       * for, so a lookup whose engine is already up has nothing to do and one
       * that is cold has started by the time the answer comes back.
       */
      warmRecall(context.recall);
      const note = await indexNote(context, bulletCount(report.content));
      const suffix = [
        similar === undefined ? '' : nearDuplicateNote(similar),
        warning,
        note,
      ]
        .filter((part) => part.length > 0)
        .join('\n\n');
      return suffix.length > 0 ? `${outcome}\n\n${suffix}` : outcome;
    },
  });
}

export function createPruneMemoryTool(context: MemoryToolContext) {
  return new FunctionTool({
    name: 'prune_memory',
    description:
      'Replace memory with a deduplicated, summarised rewrite: drop what is ' +
      'outdated or no longer true, merge repeats, and keep everything that still ' +
      'matters. Send the *whole* document — every layer you mean to keep, ' +
      'including the ones about the person. A layer you leave out is kept only if ' +
      'it is a person-level layer, and you are told when that happened. The ' +
      'previous contents are kept as memory.md.bak.',
    parameters: z.object({
      content: z
        .string()
        .min(1)
        .describe(
          'The complete replacement document, in the same markdown shape as the current memory.',
        ),
      reason: z
        .string()
        .optional()
        .describe('One line on why the prune was needed.'),
    }),
    execute: async ({content, reason}) => {
      let before: string;
      try {
        before = await context.memory.read();
      } catch (error) {
        return `Could not read memory before pruning: ${describeError(error)}`;
      }
      let report: Awaited<ReturnType<MemoryStore['prune']>>;
      try {
        report = await context.memory.prune({
          content,
          ...(reason !== undefined ? {reason} : {}),
        });
      } catch (error) {
        return `Could not prune memory: ${describeError(error)}`;
      }
      const suffix = reason ? ` Reason: ${reason}` : '';
      /*
       * The one thing a prune can get wrong now that memory is two files. The
       * model cannot see the files, so "you named no facts about the person" is
       * the only way it can learn it sent half a document — and the person-level
       * half is the half nothing else can reconstruct.
       */
      const kept = report.personUntouched
        ? '\n\nThe rewrite named no person-level layer (About the user, Preferences and tone, Boundaries), so that half of memory was left exactly as it was. Include those sections in the document if you meant to rewrite them too.'
        : '';
      /*
       * A prune rewrites every bullet, so the index is behind by definition and
       * the note is the same one a write gets. The warm matters more here than
       * anywhere: the whole file has to be re-embedded on the next search, and
       * that is the largest batch this app ever sends inside a turn's deadline.
       */
      warmRecall(context.recall);
      const indexMessage = await indexNote(
        context,
        bulletCount(report.content),
      );
      const tail = indexMessage.length > 0 ? `\n\n${indexMessage}` : '';
      return `Pruned memory (${byteLength(before)} → ${byteLength(report.content)} bytes). Previous contents kept as memory.md.bak.${suffix}${kept}${tail}`;
    },
  });
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as {code?: string}).code;
    return code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}
