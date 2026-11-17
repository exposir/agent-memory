const ASCII_PART = /[A-Za-z0-9_./-]+/g;
const CJK_PART = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const QUOTED = /"([^"]{2,})"|“([^”]{2,})”/g;

export const STOPWORDS = new Set(
  `
a an the and or of to in on at for with without from by as is are was were
be been being it its this that these those i you he she we they me my your
our their them not no do does did done can could should would will shall may
might must if then than so such but also just only very more most some any
each other into over under about after before between during through up down
out off again further once here there when where why how all both few many
much own same too now
的 了 是 在 我 你 他 她 它 我们 你们 他们 这 那 这些 那些 就 也 和 与 或
不 要 会 能 可以 把 被 对 从 到 然后 因为 所以 如果 但是 而且 以及 一个
什么 怎么 为什么 哪个 哪里 时候 现在 还是 已经 没有 不是 就是 这个 那个
一下 一些 自己 一种 这样 那样 这里 那里
`
    .trim()
    .split(/\s+/),
);

const CJK_STOP_CHARS = new Set(
  [...STOPWORDS].filter((word) => word.length === 1 && /[\u3400-\u9fff]/.test(word)),
);

export function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

function splitAsciiIdentifier(part: string): string[] {
  const lower = part.toLowerCase();
  const camelParts = part
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([0-9])([a-z])/gi, "$1 $2")
    .replace(/([a-z])([0-9])/gi, "$1 $2")
    .split(/\s+/)
    .map((piece) => piece.toLowerCase())
    .filter(Boolean);
  const separated = lower.split(/[._/-]+/).filter(Boolean);
  const pieces = [...camelParts, ...separated].filter(
    (piece, index, all) => piece && piece !== lower && all.indexOf(piece) === index,
  );
  return [lower, ...pieces].filter((piece, index, all) => all.indexOf(piece) === index);
}

function cjkBigrams(run: string): string[] {
  if (run.length < 2) {
    return [run];
  }
  const output: string[] = [];
  for (let index = 0; index < run.length - 1; index += 1) {
    const bigram = run.slice(index, index + 2);
    if ([...bigram].some((char) => CJK_STOP_CHARS.has(char))) {
      continue;
    }
    output.push(bigram);
  }
  return output;
}

export function tokenize(text: string): string[] {
  const normalized = text.normalize("NFKC");
  const raw: string[] = [];

  for (const match of normalized.matchAll(ASCII_PART)) {
    raw.push(...splitAsciiIdentifier(match[0]!));
  }
  for (const match of normalized.matchAll(CJK_PART)) {
    raw.push(...cjkBigrams(match[0]!));
  }

  const cleaned = [
    ...new Set(
      raw
        .map((term) => term.replace(/^[./-]+|[./-]+$/g, ""))
        .filter(Boolean),
    ),
  ];
  const kept = cleaned.filter(
    (term) => term.length >= 2 && !STOPWORDS.has(term),
  );
  return kept.length > 0 ? kept : cleaned;
}

export function tokenKey(tokens: Iterable<string>): string {
  return [...new Set(tokens)].sort().join("\u0000");
}

function isWordCharacter(character: string | undefined): boolean {
  if (!character) {
    return false;
  }
  return character.charCodeAt(0) < 128 && /[a-z0-9_]/i.test(character);
}

export function carriesTerm(text: string, term: string): boolean {
  const haystack = normalizeText(text);
  const needle = normalizeText(term);
  if (!needle) {
    return false;
  }
  const whole = needle.length <= 4;
  let start = 0;
  while (true) {
    const at = haystack.indexOf(needle, start);
    if (at < 0) {
      return false;
    }
    const before = at > 0 ? haystack[at - 1] : undefined;
    const after = haystack[at + needle.length];
    const versionPrefix =
      before === "v" &&
      /^[0-9]/.test(needle) &&
      !isWordCharacter(at > 1 ? haystack[at - 2] : undefined);
    if ((!isWordCharacter(before) || versionPrefix) && (!whole || !isWordCharacter(after))) {
      return true;
    }
    start = at + 1;
  }
}

export function termHits(text: string, terms: readonly string[]): number {
  const haystack = normalizeText(text);
  let hits = 0;
  for (const term of terms) {
    const needle = normalizeText(term);
    if (carriesTerm(haystack, needle)) {
      hits += 1;
    } else if (needle.length >= 7 && carriesTerm(haystack, needle.slice(0, -2))) {
      hits += 1;
    }
  }
  return hits;
}

export function windowSpan(text: string, terms: readonly string[]): number {
  if (terms.length < 2) {
    return 0;
  }
  const haystack = normalizeText(text);
  const marks: Array<[number, number, number]> = [];
  terms.forEach((term, termIndex) => {
    const needle = normalizeText(term);
    let start = 0;
    while (true) {
      const at = haystack.indexOf(needle, start);
      if (at < 0) {
        break;
      }
      marks.push([at, termIndex, needle.length]);
      start = at + 1;
    }
  });
  marks.sort((left, right) => left[0] - right[0]);
  if (marks.length === 0) {
    return 0;
  }

  const counts = new Map<number, number>();
  let have = 0;
  let best = 0;
  let left = 0;
  for (let right = 0; right < marks.length; right += 1) {
    const [position, termIndex, length] = marks[right]!;
    counts.set(termIndex, (counts.get(termIndex) ?? 0) + 1);
    if (counts.get(termIndex) === 1) {
      have += 1;
    }
    while (have === terms.length && left <= right) {
      const [leftPosition, leftTerm] = marks[left]!;
      const span = position + length - leftPosition;
      if (best === 0 || span < best) {
        best = span;
      }
      counts.set(leftTerm, (counts.get(leftTerm) ?? 0) - 1);
      if (counts.get(leftTerm) === 0) {
        have -= 1;
      }
      left += 1;
    }
  }
  return best;
}

export function queryParts(query: string): { terms: string[]; phrases: string[] } {
  const phrases: string[] = [];
  for (const match of query.matchAll(QUOTED)) {
    const phrase = (match[1] ?? match[2] ?? "").trim();
    if (phrase) {
      phrases.push(phrase);
    }
  }
  const plain = query.replace(QUOTED, " ");
  return {
    terms: tokenize(`${plain} ${phrases.join(" ")}`),
    phrases: [...new Set(phrases.map(normalizeText))],
  };
}

export function ftsAnd(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

export function ftsPrefixAnd(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
}

export function ftsOr(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}
