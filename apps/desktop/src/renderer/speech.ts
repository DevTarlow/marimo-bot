/**
 * Turning an answer written for the eye into one worth hearing.
 *
 * The model is asked to write plainly when a reply will be spoken, but a
 * desktop agent's answer still arrives with a fenced command, a JSON body, a
 * stack trace, a table, a path that is four folders deep, and a URL. None of
 * those reads well aloud. This is the last gate before the normaliser and the
 * voice model, and it is a pure function on purpose — the rules are testable
 * without a model, a window or an audio element.
 *
 * The rule is "remove what cannot be heard, and say it is in the chat": a
 * listener who hears nothing after "here is the command" thinks the app
 * stopped. Code, JSON, stack traces and tables become one short sentence; a
 * long path becomes its base name; a link becomes "a link"; emphasis and
 * headings disappear. `toSpeech` never cuts a sentence in half — the engine
 * caps the total and reports that it did.
 */
export function toSpeech(markdown: string): string {
  let text = markdown.replace(/\r\n/gu, '\n');
  const notes: string[] = [];

  /*
   * Fences first, before the inline rules can mistake their punctuation for
   * emphasis or a list. The language and body decide which summary this block
   * earns: a JSON body is not a command, and a stack trace is not a snippet to
   * read out.
   */
  const fences = [...text.matchAll(/```([^\n]*)\n([\s\S]*?)```/gu)];
  const hadFence = fences.length > 0;
  let json = false;
  let stack = false;
  for (const [, language = '', body = ''] of fences) {
    const looksJson =
      /json/iu.test(language) ||
      (/^\s*[{\[]/u.test(body) && /"[^"\n]+"\s*:/u.test(body));
    const looksStack = /^\s+at\s+.+:\d+:\d+/mu.test(body);
    json ||= looksJson;
    stack ||= looksStack;
  }
  text = text.replace(/```[\s\S]*?```/gu, ' ');
  if (json) {
    notes.push('A JSON payload is in the chat.');
  }
  if (stack) {
    notes.push('A stack trace is in the chat.');
  }
  if (hadFence && !json && !stack) {
    notes.push('The code is in the chat.');
  }

  /*
   * Raw JSON and raw stack traces: not everyone fences. Both are detected by
   * their shape rather than by a language label, and both are removed whole.
   */
  const rawJson =
    /(^|\n)\s*[{\[][\s\S]*?"[^"\n]+"\s*:[\s\S]*?[}\]]\s*(?=\n|$)/u;
  if (rawJson.test(text)) {
    text = text.replace(rawJson, '\n');
    notes.push('A JSON payload is in the chat.');
  }
  if (/(^|\n)\s+at\s+[^\n]+:\d+:\d+/u.test(text)) {
    text = text.replace(/^\s+at\s+[^\n]+$/gmu, ' ');
    notes.push('A stack trace is in the chat.');
  }

  /*
   * A table is structure, not a sentence: reading the cells gives a listener a
   * stream of names and numbers with no grammar. Remove the block whole and say
   * where it is.
   */
  const hadTable =
    /(^|\n)\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*(?=\n|$)/u.test(
      text,
    );
  if (hadTable) {
    text = text.replace(/(?:^|\n)(?:[^\n]*\|[^\n]*(?:\n|$)){2,}/gu, '\n');
    notes.push('A table is in the chat.');
  }

  // Images are a picture the listener cannot see; links keep their label.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1');
  // A bare URL is not pronounceable by ear.
  text = text.replace(/https?:\/\/\S+|www\.\S+/giu, ' a link ');

  /*
   * A long path is read as folders rather than as a file. Keep the base name;
   * the front end will say a `ts` extension as letters later, which is the
   * short readable form of `src/main/agent.ts` — "agent tee ess".
   */
  text = text.replace(
    /(?:[A-Za-z]:\\[^\s,;:)\]]+|(?:\.{0,2}\/|\/)(?:[^\s/]+\/)*[^\s/.,;:)\]]+|(?:[\w.@-]+\/)+[\w.@-]+)/gu,
    (match) => {
      const base = match.split(/[\\/]/u).filter(Boolean).pop() ?? match;
      const rooted = /^(?:\/|\.{1,2}\/|[A-Za-z]:\\)/u.test(match);
      return /\.[A-Za-z0-9]{1,8}$/u.test(base) || rooted ? base : match;
    },
  );

  // Headings, block quotes and list markers are structure, not words.
  text = text.replace(/^#{1,6}\s+/gmu, '');
  text = text.replace(/^\s*>\s?/gmu, '');
  text = text.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gmu, '');
  text = text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gmu, '');
  text = text.replace(/^\s*([-*_])\1{2,}\s*$/gmu, ' ');
  text = text.replace(/^\s*\[[ xX]\]\s+/gmu, '');

  // Emphasis and inline code: keep the words, drop the syntax.
  text = text.replace(/\*\*([^*]+)\*\*/gu, '$1');
  text = text.replace(/__([^_]+)__/gu, '$1');
  text = text.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/gu, '$1$2');
  text = text.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/gu, '$1$2');
  text = text.replace(/`([^`]+)`/gu, '$1');
  text = text.replace(/<\/?[A-Za-z][^>]*>/gu, ' ');
  // A line of markdown punctuation is structure with nothing inside it.
  text = text.replace(/[*_~`>#]+/gu, ' ');
  // Emoji are a face, not a word.
  text = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ');
  text = text.replace(/\s+/gu, ' ').trim();

  const unique = [...new Set(notes)];
  if (unique.length > 0) {
    return text.length > 0 ? `${text} ${unique.join(' ')}` : unique.join(' ');
  }
  return text.length > 0 ? text : 'The answer is in the chat.';
}
