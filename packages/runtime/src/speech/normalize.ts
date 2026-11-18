/**
 * Turning a reply written for the eye into words the voice model can say.
 *
 * This is a port of the model repository's Apache-2.0 `tts_norm.py`, which is
 * itself a short list of things the misaki lexicon demonstrably gets wrong:
 * `3:45pm`, `2026-10-13`, `$24.5B`, `555-0123`, `3/4`, `St. Paul St.`, version
 * numbers, temperatures, ranges. The lexicon already handles ordinary currency,
 * percentages, large integers and abbreviations; this layer fixes only what it
 * does not.
 *
 * Sentence punctuation is preserved because the model uses it for prosody and
 * silence. Only punctuation that would be read as a word is rewritten.
 *
 * **Order matters.** Dates and times run before the generic number rule, or ISO
 * dates become three cardinals; money runs before magnitudes, or `$24.5B` loses
 * its magnitude suffix.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const UNITS: Readonly<Record<string, string>> = {
  km: 'kilometres',
  mi: 'miles',
  cm: 'centimetres',
  mm: 'millimetres',
  kg: 'kilograms',
  lb: 'pounds',
  lbs: 'pounds',
  oz: 'ounces',
  ml: 'millilitres',
  l: 'litres',
  ft: 'feet',
  in: 'inches',
  hr: 'hours',
  hrs: 'hours',
  min: 'minutes',
  mins: 'minutes',
  sec: 'seconds',
  secs: 'seconds',
  ms: 'milliseconds',
  gb: 'gigabytes',
  mb: 'megabytes',
  kb: 'kilobytes',
  tb: 'terabytes',
  hz: 'hertz',
  khz: 'kilohertz',
  mhz: 'megahertz',
  ghz: 'gigahertz',
  kw: 'kilowatts',
  mph: 'miles per hour',
  kph: 'kilometres per hour',
};

const MAGNITUDES: Readonly<Record<string, string>> = {
  k: 'thousand',
  m: 'million',
  b: 'billion',
  t: 'trillion',
};

const FRACTIONS: Readonly<Record<string, string>> = {
  '1/2': 'a half',
  '1/3': 'a third',
  '2/3': 'two thirds',
  '1/4': 'a quarter',
  '3/4': 'three quarters',
  '1/8': 'an eighth',
};

const ABBREVIATIONS: Readonly<Record<string, string>> = {
  mr: 'Mister',
  mrs: 'Missus',
  ms: 'Miss',
  dr: 'Doctor',
  prof: 'Professor',
  rev: 'Reverend',
  hon: 'Honourable',
  ext: 'extension',
  approx: 'approximately',
  vs: 'versus',
  est: 'estimated',
  dept: 'department',
  univ: 'university',
  fig: 'figure',
  eq: 'equation',
  ref: 'reference',
  vol: 'volume',
  incl: 'including',
  excl: 'excluding',
  min: 'minimum',
  max: 'maximum',
  avg: 'average',
  mt: 'mount',
  ft: 'fort',
  appt: 'appointment',
  pp: 'pages',
  jr: 'Junior',
  sr: 'Senior',
  inc: 'Incorporated',
  ltd: 'Limited',
  corp: 'Corporation',
  mins: 'minutes',
  hrs: 'hours',
  wks: 'weeks',
  yrs: 'years',
};

const DAYS: Readonly<Record<string, string>> = {
  Mon: 'Monday',
  Tue: 'Tuesday',
  Tues: 'Tuesday',
  Wed: 'Wednesday',
  Weds: 'Wednesday',
  Thu: 'Thursday',
  Thur: 'Thursday',
  Thurs: 'Thursday',
  Fri: 'Friday',
  Sat: 'Saturday',
  Sun: 'Sunday',
};

const MONTH_ABBREVIATIONS: Readonly<Record<string, string>> = {
  Jan: 'January',
  Feb: 'February',
  Mar: 'March',
  Apr: 'April',
  Jun: 'June',
  Jul: 'July',
  Aug: 'August',
  Sep: 'September',
  Sept: 'September',
  Oct: 'October',
  Nov: 'November',
  Dec: 'December',
};

const SYMBOLS: Readonly<Record<string, string>> = {
  '%': ' percent ',
  '&': ' and ',
  '@': ' at ',
  '+': ' plus ',
  '=': ' equals ',
  '×': ' times ',
  '÷': ' divided by ',
  '<': ' less than ',
  '>': ' greater than ',
  '~': ' about ',
  '°': ' degrees ',
  '€': ' euros ',
  '£': ' pounds ',
  '¥': ' yen ',
  '©': ' copyright ',
  '™': ' trademark ',
  '§': ' section ',
};

const ROMAN: Readonly<Record<string, number>> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
  xi: 11,
  xii: 12,
};

const ROMAN_CONTEXT =
  /(?:chapter|section|part|volume|book|act|phase|appendix|world war|type|class|figure|table|step|stage)/iu;

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];

const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];

const SCALES: ReadonlyArray<readonly [number, string]> = [
  [1_000_000_000_000, 'trillion'],
  [1_000_000_000, 'billion'],
  [1_000_000, 'million'],
  [1_000, 'thousand'],
];

const ORDINAL_IRREGULAR: Readonly<Record<string, string>> = {
  one: 'first',
  two: 'second',
  three: 'third',
  four: 'fourth',
  five: 'fifth',
  six: 'sixth',
  seven: 'seventh',
  eight: 'eighth',
  nine: 'ninth',
  ten: 'tenth',
  eleven: 'eleventh',
  twelve: 'twelfth',
  thirteen: 'thirteenth',
  fourteen: 'fourteenth',
  fifteen: 'fifteenth',
  sixteen: 'sixteenth',
  seventeen: 'seventeenth',
  eighteen: 'eighteenth',
  nineteen: 'nineteenth',
  twenty: 'twentieth',
  thirty: 'thirtieth',
  forty: 'fortieth',
  fifty: 'fiftieth',
  sixty: 'sixtieth',
  seventy: 'seventieth',
  eighty: 'eightieth',
  ninety: 'ninetieth',
  hundred: 'hundredth',
  thousand: 'thousandth',
  million: 'millionth',
  billion: 'billionth',
  trillion: 'trillionth',
};

/** Cardinal English words for a whole number. */
export function cardinal(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  const n = Math.trunc(value);
  if (n < 0) {
    return `minus ${cardinal(-n)}`;
  }
  if (n < 20) {
    return ONES[n] ?? String(n);
  }
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)] ?? '';
    const rest = n % 10;
    return rest === 0 ? tens : `${tens}-${ONES[rest] ?? ''}`;
  }
  if (n < 1000) {
    const hundreds = ONES[Math.floor(n / 100)] ?? '';
    const rest = n % 100;
    return rest === 0
      ? `${hundreds} hundred`
      : `${hundreds} hundred and ${cardinal(rest)}`;
  }
  for (const [scale, name] of SCALES) {
    if (n >= scale) {
      const whole = Math.floor(n / scale);
      const rest = n % scale;
      return rest === 0
        ? `${cardinal(whole)} ${name}`
        : `${cardinal(whole)} ${name} ${cardinal(rest)}`;
    }
  }
  return String(n);
}

/** Ordinal English words for a whole number. */
export function ordinal(value: number): string {
  const words = cardinal(value).split(' ');
  const last = words.pop() ?? '';
  const hyphen = last.lastIndexOf('-');
  const head = hyphen >= 0 ? last.slice(0, hyphen + 1) : '';
  const tail = hyphen >= 0 ? last.slice(hyphen + 1) : last;
  const replaced = ORDINAL_IRREGULAR[tail] ?? `${tail}th`;
  words.push(`${head}${replaced}`);
  return words.join(' ');
}

/**
 * A year as a person says it, not as a cardinal.
 *
 * 2026 is twenty twenty-six, 1905 is nineteen oh five, 2005 is two thousand
 * five. This is the one place a four-digit number must not read as a quantity.
 */
export function year(value: number): string {
  if (value === 2000) {
    return 'two thousand';
  }
  if (value >= 2001 && value <= 2009) {
    return `two thousand ${cardinal(value - 2000)}`;
  }
  if (value >= 2010 && value <= 2099) {
    const rest = value % 100;
    return rest === 0
      ? `${cardinal(Math.floor(value / 100))} hundred`
      : `${cardinal(Math.floor(value / 100))} ${cardinal(rest)}`;
  }
  if (value >= 1100 && value <= 1999) {
    const rest = value % 100;
    if (rest === 0) {
      return `${cardinal(Math.floor(value / 100))} hundred`;
    }
    return `${cardinal(Math.floor(value / 100))} ${
      rest < 10 ? `oh ${cardinal(rest)}` : cardinal(rest)
    }`;
  }
  return cardinal(value);
}

/** One numeric token, with decimals read digit by digit after "point". */
function decimal(token: string): string {
  const clean = token.replaceAll(',', '');
  if (!/\d/u.test(clean)) {
    return clean;
  }
  if (clean.includes('.')) {
    const [whole, fraction = ''] = clean.split('.');
    const left = cardinal(Number(whole || '0'));
    const right = [...fraction]
      .map((digit) => cardinal(Number(digit)))
      .join(' ');
    return `${left} point ${right}`;
  }
  return cardinal(Number(clean));
}

/**
 * Put back a period the am/pm group swallowed.
 *
 * `3:45pm.` normalised to "three forty-five PM" with no punctuation left the
 * sentence with no final intonation. The period goes back only when the match
 * really did end the sentence.
 */
function keepFinalDot(
  source: string,
  match: string,
  output: string,
  offset: number,
): string {
  if (!match.endsWith('.')) {
    return output;
  }
  const rest = source.slice(offset + match.length);
  if (rest.trim() === '') {
    return `${output}.`;
  }
  if (/^\s+[A-Z]/u.test(rest)) {
    return `${output}.`;
  }
  return output;
}

function dates(text: string): string {
  let out = text.replace(
    /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/gu,
    (match, y: string, mo: string, d: string) => {
      const month = Number(mo);
      const day = Number(d);
      if (month < 1 || month > 12 || day < 1 || day > 31) {
        return match;
      }
      return `${MONTHS[month - 1] ?? ''} ${ordinal(day)}, ${year(Number(y))}`;
    },
  );
  out = out.replace(
    /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/gu,
    (match, a: string, b: string, y: string) => {
      const month = Number(a);
      const day = Number(b);
      if (month < 1 || month > 12 || day < 1 || day > 31) {
        return match;
      }
      let fullYear = Number(y);
      if (fullYear < 100) {
        fullYear += fullYear < 50 ? 2000 : 1900;
      }
      return `${MONTHS[month - 1] ?? ''} ${ordinal(day)}, ${year(fullYear)}`;
    },
  );
  const months = MONTHS.join('|');
  out = out.replace(
    new RegExp(`\\b(${months})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'giu'),
    (_match, name: string, d: string, y: string) =>
      `${name} ${ordinal(Number(d))}, ${year(Number(y))}`,
  );
  return out;
}

function times(text: string): string {
  return text.replace(
    /\b(\d{1,2}):(\d{2})(?:\s*([ap])\.?m\.?)?/giu,
    (
      match: string,
      h: string,
      m: string,
      ampm: string | undefined,
      offset: number,
      source: string,
    ) => {
      const hour = Number(h);
      const minute = Number(m);
      if (hour > 23 || minute > 59) {
        return match;
      }
      const suffix =
        ampm === undefined ? '' : ampm.toLowerCase() === 'a' ? ' AM' : ' PM';
      let spoken: string;
      if (minute === 0) {
        spoken =
          suffix === ''
            ? `${cardinal(hour)} o'clock`
            : cardinal(hour <= 12 ? hour : hour - 12);
      } else if (minute < 10) {
        spoken = `${cardinal(hour <= 12 || suffix === '' ? hour : hour - 12)} oh ${cardinal(minute)}`;
      } else {
        spoken = `${cardinal(hour <= 12 || suffix === '' ? hour : hour - 12)} ${cardinal(minute)}`;
      }
      return keepFinalDot(source, match, `${spoken}${suffix}`, offset);
    },
  );
}

function bareHours(text: string): string {
  return text.replace(
    /\b(\d{1,2})\s*([ap])\.?m\.?(?![a-z])/giu,
    (
      match: string,
      h: string,
      ampm: string,
      offset: number,
      source: string,
    ) => {
      const hour = Number(h);
      if (hour < 1 || hour > 12) {
        return match;
      }
      return keepFinalDot(
        source,
        match,
        `${cardinal(hour)} ${ampm.toLowerCase() === 'a' ? 'AM' : 'PM'}`,
        offset,
      );
    },
  );
}

function phones(text: string): string {
  return text.replace(
    /\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]?\d{0,4}\b/gu,
    (match) => {
      const digits = match.replaceAll(/\D/gu, '');
      if (digits.length < 7 || digits.length > 11) {
        return match;
      }
      const groups: string[] = [];
      let index = 0;
      if (digits.length === 11 && digits[0] === '1') {
        groups.push('one');
        index = 1;
      }
      for (const [a, b] of [
        [index, index + 3],
        [index + 3, index + 6],
        [index + 6, digits.length],
      ] as const) {
        if (a < digits.length) {
          groups.push(
            [...digits.slice(a, b)].map((d) => cardinal(Number(d))).join(' '),
          );
        }
      }
      return groups.filter((group) => group.length > 0).join(', ');
    },
  );
}

function money(text: string): string {
  return text.replace(
    /\$\s?(\d[\d,]*(?:\.\d+)?)(?:\s?([KkMmBbTt])\b)?/gu,
    (_match: string, amount: string, suffix?: string) => {
      const clean = amount.replaceAll(',', '');
      if (suffix !== undefined) {
        const magnitude = MAGNITUDES[suffix.toLowerCase()] ?? suffix;
        return `${decimal(clean)} ${magnitude} dollars`;
      }
      if (clean.includes('.')) {
        const [whole, fraction = ''] = clean.split('.');
        const cents = Number((fraction + '00').slice(0, 2));
        const dollars = Number(whole);
        const dollarWord = dollars === 1 ? 'dollar' : 'dollars';
        if (cents === 0) {
          return `${cardinal(dollars)} ${dollarWord}`;
        }
        const centWord = cents === 1 ? 'cent' : 'cents';
        return `${cardinal(dollars)} ${dollarWord} and ${cardinal(cents)} ${centWord}`;
      }
      const value = Number(clean);
      return `${cardinal(value)} ${value === 1 ? 'dollar' : 'dollars'}`;
    },
  );
}

function magnitudes(text: string): string {
  return text.replace(
    /\b(\d[\d,]*(?:\.\d+)?)\s*([KMBT])\b/gu,
    (_match, amount: string, suffix: string) =>
      `${decimal(amount)} ${MAGNITUDES[suffix.toLowerCase()] ?? suffix}`,
  );
}

function fractions(text: string): string {
  return text.replace(
    /\b(\d{1,3})\/(\d{1,3})\b/gu,
    (match, a: string, b: string) => {
      const numerator = Number(a);
      const denominator = Number(b);
      if (denominator === 0) {
        return match;
      }
      const known = FRACTIONS[`${numerator}/${denominator}`];
      if (known !== undefined) {
        return known;
      }
      return `${cardinal(numerator)} ${ordinal(denominator)}${numerator === 1 ? '' : 's'}`;
    },
  );
}

function versions(text: string): string {
  return text.replace(
    /\b(\d+)\.(\d+)\.(\d+)\b/gu,
    (_match, a: string, b: string, c: string) =>
      [a, b, c].map((part) => cardinal(Number(part))).join(' point '),
  );
}

function units(text: string): string {
  const names = Object.keys(UNITS).sort((a, b) => b.length - a.length);
  let out = text.replace(
    new RegExp(`\\b(\\d[\\d,]*(?:\\.\\d+)?)\\s?(${names.join('|')})\\b`, 'giu'),
    (_match, amount: string, unit: string) => {
      const value = decimal(amount);
      let word = UNITS[unit.toLowerCase()] ?? unit;
      if (amount.replaceAll(',', '') === '1' && word.endsWith('s')) {
        word = word.slice(0, -1);
      }
      return `${value} ${word}`;
    },
  );
  out = out.replace(
    /([-−]?[\d.]+)\s?°\s?([CF])\b/gu,
    (_match, raw: string, unit: string) => {
      const negative = raw.startsWith('-') || raw.startsWith('−');
      const value = decimal(negative ? raw.slice(1) : raw);
      const scale = unit.toUpperCase() === 'C' ? 'Celsius' : 'Fahrenheit';
      return `${negative ? 'minus ' : ''}${value} degrees ${scale}`;
    },
  );
  return out;
}

function abbreviations(text: string): string {
  let out = text;
  out = out.replace(/\bSt\.\s+(?=[A-Z])/gu, 'Saint ');
  out = out.replace(/\bSt\.(?=\s*$)/gu, 'Street.');
  out = out.replace(/\bSt\.(?=\s*["')\]])/gu, 'Street.');
  out = out.replace(/\bSt\.(?!\s+[A-Z])/gu, 'Street');
  out = out.replace(/\bAve\./gu, 'Avenue');
  out = out.replace(/\bRd\./gu, 'Road');
  out = out.replace(/\bBlvd\./gu, 'Boulevard');
  out = out.replace(/\bNo\.\s*(?=\d)/gu, 'number ');
  out = out.replace(/\bNos\.\s*(?=\d)/gu, 'numbers ');
  for (const [key, value] of [
    ...Object.entries(DAYS),
    ...Object.entries(MONTH_ABBREVIATIONS),
  ]) {
    out = out.replace(new RegExp(`\\b${key}\\.`, 'gu'), value);
  }
  for (const [key, value] of Object.entries(ABBREVIATIONS)) {
    out = out.replace(new RegExp(`\\b${key}\\.`, 'giu'), value);
  }
  return out;
}

function romans(text: string): string {
  const pattern = new RegExp(
    `\\b(${ROMAN_CONTEXT.source})\\s+([IVX]{1,4})\\b`,
    'giu',
  );
  return text.replace(pattern, (match, context: string, numeral: string) => {
    const value = ROMAN[numeral.toLowerCase()];
    return value === undefined ? match : `${context} ${cardinal(value)}`;
  });
}

function ordinals(text: string): string {
  return text.replace(/\b(\d+)(?:st|nd|rd|th)\b/giu, (_match, value: string) =>
    ordinal(Number(value)),
  );
}

function ranges(text: string): string {
  return text.replace(
    /\b(\d+)\s?[-–—]\s?(\d+)\b/gu,
    (_match, a: string, b: string) =>
      `${cardinal(Number(a))} to ${cardinal(Number(b))}`,
  );
}

function numbers(text: string): string {
  let out = text.replace(/(?<![\w.])[-−](\d)/gu, 'minus $1');
  out = out.replace(/\b\d[\d,]*(?:\.\d+)?\b/gu, (token: string) => {
    if (!token.includes(',') && /^\d{4}$/u.test(token)) {
      const value = Number(token);
      if (value >= 1100 && value <= 2099) {
        return year(value);
      }
    }
    return decimal(token);
  });
  return out;
}

/**
 * Expand a reply to the words the model will speak.
 *
 * The punctuation `. , ! ? ;` and dashes survive. Everything else that is
 * structure `toSpeech` did not remove is either turned into a word or removed.
 */
export function normalizeEnglish(text: string): string {
  let out = text.normalize('NFKC');
  out = out
    .replaceAll('’', "'")
    .replaceAll('‘', "'")
    .replaceAll('“', '"')
    .replaceAll('”', '"')
    .replaceAll('—', ' - ')
    .replaceAll('–', '-')
    .replaceAll('…', '...');
  out = out.replace(/https?:\/\/\S+|www\.\S+/giu, ' link ');
  out = out.replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/gu, ' email address ');
  out = out.replace(/\be\.\s?g\./giu, 'for example,');
  out = out.replace(/\bi\.\s?e\./giu, 'that is,');
  out = out.replace(/\betc\./giu, 'etcetera');
  out = out.replace(/\bvs\.?\b/giu, 'versus');
  out = dates(out);
  out = times(out);
  out = bareHours(out);
  out = phones(out);
  out = money(out);
  out = versions(out);
  out = fractions(out);
  out = magnitudes(out);
  out = units(out);
  out = abbreviations(out);
  out = romans(out);
  out = ordinals(out);
  out = ranges(out);
  for (const [symbol, word] of Object.entries(SYMBOLS)) {
    out = out.replaceAll(symbol, word);
  }
  out = numbers(out);
  // A colon that survived the time rule becomes a comma: the same pause, with no
  // stray token for the model to read as punctuation.
  out = out.replaceAll(':', ',');
  out = out.replace(/[\\/\[\]{}<>_*`^|]/gu, ' ');
  out = out.replace(/\s+([.,!?;])/gu, '$1');
  out = out.replace(/([.,!?;])(?=[^\s"',.!?;])/gu, '$1 ');
  out = out.replace(/\s{2,}/gu, ' ').trim();
  return out;
}
