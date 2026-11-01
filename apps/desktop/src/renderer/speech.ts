/**
 * Turning an answer written for the eye into one worth hearing.
 *
 * The model is asked to write plainly when a reply will be spoken, but it still
 * reaches for markdown: a fenced command becomes a minute of punctuation read
 * aloud, a link becomes a URL nobody can follow by ear, and a table becomes a
 * stream of numbers. This is the last gate before `/tts`, and it is a pure
 * function on purpose — the rules are testable without an engine, a microphone
 * or a window.
 *
 * It does not try to summarise. The length cap lives in the host, because the
 * same cap governs a request the renderer never makes; this only removes what
 * cannot be spoken.
 */
export function toSpeech(markdown: string): string {
  let text = markdown;
  /*
   * Fences first, before the inline rules can mistake their punctuation for
   * emphasis or a list. The replacement is a sentence rather than silence: a
   * listener who hears nothing after "here is the command" thinks the app
   * stopped.
   */
  const hadCode = /```[\s\S]*?```/u.test(text);
  text = text.replace(/```[\s\S]*?```/gu, ' ');
  text = text.replace(/`([^`]+)`/gu, '$1');
  // Images are a picture the listener cannot see; links keep their label.
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1');
  // Bare URLs are not pronounceable as a rule.
  text = text.replace(/https?:\/\/\S+/gu, ' a link ');
  // Headings, block quotes and list markers are structure, not words.
  text = text.replace(/^#{1,6}\s+/gmu, '');
  text = text.replace(/^\s*>\s?/gmu, '');
  text = text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gmu, '');
  // Tables are rows of pipes; keep the cell words, drop the bars.
  text = text.replace(/^\s*\|.*\|\s*$/gmu, (row) =>
    row
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0 && !/^:?-{3,}:?$/u.test(cell))
      .join(', '),
  );
  text = text.replace(/\*\*([^*]+)\*\*/gu, '$1');
  text = text.replace(/__([^_]+)__/gu, '$1');
  text = text.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/gu, '$1$2');
  text = text.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/gu, '$1$2');
  text = text.replace(/<\/?[A-Za-z][^>]*>/gu, ' ');
  // A line of markdown punctuation is structure with nothing inside it.
  text = text.replace(/[*_~`>#]+/gu, ' ');
  text = text.replace(/\s+/gu, ' ').trim();

  if (hadCode && text.length > 0) {
    return `${text} The code is in the chat.`;
  }
  if (text.length === 0) {
    return hadCode ? 'The code is in the chat.' : 'The answer is in the chat.';
  }
  return text;
}
