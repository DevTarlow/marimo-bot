/**
 * Making code-shaped words sayable before the lexicon sees them.
 *
 * An assistant writes `speech-host.ts`, `getURLValue`, `v0.1.0` and `ORT`,
 * and the English lexicon knows none of those as written. Left alone they
 * reach the G2P as one token, miss the lexicon and CMU, and disappear from the
 * sentence — the failure that made a technical reply sound like it had holes in
 * it.
 *
 * This expansion is deliberately before the lexicon: it splits camelCase,
 * snake_case, kebab-case, dots and slashes into ordinary words, spells short
 * all-caps tokens letter by letter, and maps the common technical ones to a
 * phrase a voice can say. Everything it emits is an ordinary English word or
 * the name of a letter, so the lexicon and the stage-3 fallback have something
 * to work with rather than a token they must drop.
 *
 * It is English-only with the rest of the front end, and it is a pure function
 * so the rules can be tested without a model.
 */

/** How each letter is said; all are ordinary words the lexicon knows. */
const LETTERS: Readonly<Record<string, string>> = {
  a: 'ay',
  b: 'bee',
  c: 'see',
  d: 'dee',
  e: 'ee',
  f: 'eff',
  g: 'gee',
  h: 'aitch',
  i: 'eye',
  j: 'jay',
  k: 'kay',
  l: 'ell',
  m: 'em',
  n: 'en',
  o: 'oh',
  p: 'pee',
  q: 'cue',
  r: 'ar',
  s: 'ess',
  t: 'tee',
  u: 'you',
  v: 'vee',
  w: 'double you',
  x: 'ex',
  y: 'why',
  z: 'zee',
};

/** Spell a run of letters, e.g. `API` → `ay pee eye`. */
export function spellLetters(letters: string): string {
  return [...letters.toLowerCase()]
    .map((letter) => LETTERS[letter] ?? letter)
    .join(' ');
}

/**
 * Technical abbreviations said as names or as the word people actually use.
 *
 * Letters beat a guessed pronunciation for most of these — "ONNX" read as a
 * word is a mystery, and "O N N X" is not. The few with a settled spoken form
 * (`gif`, `wasm`, `sequel`) are the map's real work.
 */
const TECH_WORDS: Readonly<Record<string, string>> = {
  api: spellLetters('api'),
  cpu: spellLetters('cpu'),
  gpu: spellLetters('gpu'),
  tts: spellLetters('tts'),
  ort: spellLetters('ort'),
  cli: spellLetters('cli'),
  url: spellLetters('url'),
  uri: spellLetters('uri'),
  http: spellLetters('http'),
  https: spellLetters('https'),
  ipc: spellLetters('ipc'),
  sse: spellLetters('sse'),
  onnx: spellLetters('onnx'),
  wav: spellLetters('wav'),
  json: spellLetters('json'),
  yaml: spellLetters('yaml'),
  toml: spellLetters('toml'),
  sql: spellLetters('sql'),
  gif: 'gif',
  wasm: 'wazem',
  sqlite: 'sequel lite',
  jpeg: 'jay peg',
  html: spellLetters('html'),
  css: spellLetters('css'),
  js: spellLetters('js'),
  ts: spellLetters('ts'),
  jsx: spellLetters('jsx'),
  tsx: spellLetters('tsx'),
  npm: spellLetters('npm'),
  pnpm: spellLetters('pnpm'),
  os: spellLetters('os'),
  ui: spellLetters('ui'),
  id: spellLetters('id'),
  llm: spellLetters('llm'),
  gpt: spellLetters('gpt'),
  pdf: spellLetters('pdf'),
  csv: spellLetters('csv'),
  png: spellLetters('png'),
  jpg: spellLetters('jpg'),
  svg: spellLetters('svg'),
  xml: spellLetters('xml'),
  am: spellLetters('am'),
  pm: spellLetters('pm'),
  us: spellLetters('us'),
  uk: spellLetters('uk'),
  usa: spellLetters('usa'),
  ok: 'okay',
  readme: 'read me',
  todo: 'to do',
  fixme: 'fix me',
  changelog: 'change log',
  src: 'source',
  lib: 'library',
  pkg: 'package',
  cmd: 'command',
  dir: 'directory',
  usr: 'user',
  ctx: 'context',
  msg: 'message',
  'e.g': 'for example',
  'i.e': 'that is',
  etc: 'etcetera',
  vs: 'versus',
  'a.m': 'ay em',
  'p.m': 'pee em',
  'u.s': 'you ess',
  'u.k': 'you kay',
};

/**
 * File extensions, which are the last part after a dot and not abbreviations
 * in their own right. `md` is "markdown", not "em dee"; `ts` is a file type and
 * is spelled, because it has no spoken name.
 */
const EXTENSIONS: Readonly<Record<string, string>> = {
  ts: TECH_WORDS['ts'] ?? 'tee ess',
  tsx: TECH_WORDS['tsx'] ?? 'tee ess ex',
  js: TECH_WORDS['js'] ?? 'jay ess',
  jsx: TECH_WORDS['jsx'] ?? 'jay ess ex',
  mjs: spellLetters('mjs'),
  cjs: spellLetters('cjs'),
  json: TECH_WORDS['json'] ?? 'jay ess oh en',
  md: 'markdown',
  markdown: 'markdown',
  yml: TECH_WORDS['yaml'] ?? 'why ay em ell',
  yaml: TECH_WORDS['yaml'] ?? 'why ay em ell',
  toml: TECH_WORDS['toml'] ?? 'tee oh em ell',
  css: TECH_WORDS['css'] ?? 'see ess ess',
  html: TECH_WORDS['html'] ?? 'aitch tee em ell',
  xml: TECH_WORDS['xml'] ?? 'ex em ell',
  py: 'python',
  sh: 'shell',
  bash: 'bash',
  zsh: 'zed shell',
  env: 'environment',
  lock: 'lock',
  txt: 'text',
  pdf: TECH_WORDS['pdf'] ?? 'pee dee eff',
  png: TECH_WORDS['png'] ?? 'pee en gee',
  jpg: TECH_WORDS['jpg'] ?? 'jay pee gee',
  jpeg: TECH_WORDS['jpeg'] ?? 'jay pee ee gee',
  gif: 'gif',
  svg: TECH_WORDS['svg'] ?? 'ess vee gee',
  wav: TECH_WORDS['wav'] ?? 'double you ay vee',
  mp3: 'em pee three',
  mp4: 'em pee four',
  exe: 'executable',
  dll: spellLetters('dll'),
  bin: 'binary',
  log: 'log',
  ini: spellLetters('ini'),
  cfg: 'config',
  conf: 'config',
};

/**
 * All-caps words that are words, not abbreviations.
 *
 * Spelling these would be worse than pronouncing them: "NOTICE" read as N O T
 * I C E is a sentence about letters, and "README" is a word people say.
 */
const UPPER_WORDS: Readonly<Record<string, string>> = {
  readme: 'read me',
  notice: 'notice',
  licence: 'licence',
  license: 'license',
  agents: 'agents',
  warning: 'warning',
  error: 'error',
  info: 'info',
  debug: 'debug',
  true: 'true',
  false: 'false',
  null: 'null',
  yes: 'yes',
  no: 'no',
  on: 'on',
  off: 'off',
  ok: 'okay',
  todo: 'to do',
  fixme: 'fix me',
  changelog: 'change log',
};

const TOKEN = /[A-Za-z0-9](?:[A-Za-z0-9._/\\'-]*[A-Za-z0-9])?/gu;

/** Whether a token is a pure number or version the normaliser already handles. */
function isNumberToken(token: string): boolean {
  return /^\d+(?:\.\d+)*$/u.test(token);
}

/**
 * Rewrite the code-shaped tokens in a sentence, leaving everything else alone.
 *
 * Pure numbers are left for the normaliser: splitting `3.5` into `3 5` here
 * would turn a decimal into two numbers, and the normaliser's decimal rule is
 * already the right one.
 */
export function expandSpeakable(text: string): string {
  return text.replace(TOKEN, (token) => expandToken(token));
}

/** One token, or the same token when it is already an ordinary word. */
export function expandToken(token: string): string {
  if (isNumberToken(token)) {
    return token;
  }
  const version = /^v(\d+(?:\.\d+)+)$/iu.exec(token);
  if (version !== null) {
    return `version ${version[1] ?? ''}`;
  }
  /*
   * A dotted abbreviation is a word, not an identifier. `e.g` and `p.m` reach
   * the splitter as tokens and would otherwise become two stray letters.
   */
  const whole = TECH_WORDS[token.toLowerCase()];
  if (whole !== undefined) {
    return whole;
  }
  const hasDot = token.includes('.');
  const parts = token.split(/[._/\\-]+/u).filter((part) => part.length > 0);
  const out: string[] = [];
  for (const [index, part] of parts.entries()) {
    const extension = hasDot && index === parts.length - 1;
    for (const piece of camelParts(part)) {
      out.push(expandPiece(piece, extension));
    }
  }
  return out.join(' ').trim();
}

function expandPiece(piece: string, extension: boolean): string {
  const lower = piece.toLowerCase();
  if (extension) {
    const mapped = EXTENSIONS[lower];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  const tech = TECH_WORDS[lower];
  if (tech !== undefined) {
    return tech;
  }
  const upper = piece.toUpperCase() === piece && /[A-Z]/u.test(piece);
  if (upper) {
    const word = UPPER_WORDS[lower];
    if (word !== undefined) {
      return word;
    }
    if (piece.length >= 2 && piece.length <= 4) {
      return spellLetters(piece);
    }
    // A long all-caps word is more likely a shouted word than an abbreviation;
    // let the lexicon and the fallback pronounce it as a word.
    return lower;
  }
  return piece;
}

/** Split camelCase and PascalCase at their boundaries. */
function camelParts(part: string): string[] {
  const spaced = part
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2');
  return spaced.split(/\s+/u).filter((piece) => piece.length > 0);
}
