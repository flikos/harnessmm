/**
 * Find a mechanical chain the model can reuse instead of reasoning step by
 * step.
 *
 * The premise: a person should not have to pre-register the words they will
 * use. Understanding what the request means is the model's job — it already has
 * the conversation. What a library saves is the *plan*: once a sequence of
 * mechanical steps with observable gates exists, re-deriving it pays for a
 * reasoning call every step.
 *
 * So this module matches a request against saved graphs by what they are about
 * (their declared `intent`), never by exact phrasing. It is a hint, not a
 * gate: the model still decides, and the tool schema still exposes manual
 * authoring for anything the library does not cover.
 */

/** Words carried by almost every request; they identify nothing. */
const STOPWORDS = new Set([
  'и', 'в', 'во', 'на', 'по', 'с', 'со', 'к', 'ко', 'у', 'о', 'об', 'от', 'до', 'из', 'за', 'для',
  'не', 'что', 'как', 'это', 'всё', 'все', 'ещё', 'еще', 'мне', 'нас', 'вы', 'ты', 'он', 'она',
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'it', 'this', 'that', 'with',
  'please', 'pls', 'давай', 'надо', 'нужно', 'можно', 'пожалуйста',
]);

/**
 * Words that describe wanting something done rather than what is done.
 *
 * They are dropped before matching, so "проверь плагин" and "посмотри, что с
 * плагином" reach the matcher as the same request. The cost is that a chain's
 * declared intent must describe what it does, not what the user says to trigger
 * it — which is the right requirement anyway, since the library is matched
 * against many differently worded asks.
 */
const ASK_WORDS = new Set([
  'проверь', 'проверить', 'проверка', 'сделай', 'сделать', 'посмотри', 'посмотреть', 'запусти',
  'запустить', 'прогони', 'прогнать', 'покажи', 'показать', 'просто', 'давай', 'хочу', 'хотелось',
  'помоги', 'нужн', 'плиз', 'run', 'check', 'please', 'show', 'make', 'do', 'let',
]);

/**
 * Light stemming: enough for Russian and English inflection, no dictionary.
 *
 * The ending that carries inflection varies by part of speech — `проверь` has a
 * bare soft sign, `проверить` an infinitive `-ть`, `плагину` a dative `-у` — so
 * one fixed pass leaves forms that mean the same word different. The list is
 * applied repeatedly until nothing more is stripped.
 */
const RU_ENDINGS = ['иями', 'ями', 'ами', 'ов', 'ев', 'ах', 'ях', 'ам', 'ям', 'ом', 'ем', 'ой', 'ый',
  'ий', 'ая', 'ое', 'ые', 'ть', 'ти', 'ет', 'ют', 'ут', 'ил', 'ла', 'ли', 'ия', 'ие', 'ы', 'и', 'а',
  'о', 'е', 'ь', 'у', 'ю']
const EN_ENDINGS = ['ing', 'ed', 'es', 's']

/** Matched terms beyond this add no further certainty. */
const EVIDENCE_CAP = 3

export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stem(word) {
  let out = word
  for (let pass = 0; pass < 3; pass += 1) {
    const before = out
    for (const ending of RU_ENDINGS) {
      if (out.length - ending.length >= 3 && out.endsWith(ending)) {
        out = out.slice(0, -ending.length)
        break
      }
    }
    for (const ending of EN_ENDINGS) {
      if (out.length - ending.length >= 3 && out.endsWith(ending)) {
        out = out.slice(0, -ending.length)
        break
      }
    }
    if (out === before) break
  }
  return out
}

/** Content tokens of a text: stemmed, ask-words and stopwords dropped. */
export function contentTokens(text) {
  const tokens = normalizeText(text).split(' ').filter(Boolean)
  const out = []
  for (const token of tokens) {
    if (token.length < 2) continue
    if (STOPWORDS.has(token)) continue
    if (ASK_WORDS.has(token)) continue
    out.push(stem(token))
  }
  return out
}

function setOf(tokens) {
  return new Set(tokens)
}

/**
 * Score one saved graph against a request.
 *
 * `intent` is the graph's declared purpose (required — a graph with no intent
 * cannot be matched, so the failure is visible instead of silent). `description`
 * and the saved name refine it.
 *
 * Coverage is measured in the direction that matters: how much of the *intent*
 * the request actually talks about. A request that mentions every intent word
 * plus a lot of unrelated asks still covers its intent fully, while a request
 * that misses half of it does not.
 */
export function scoreGraph(graph, requestTokens) {
  const request = setOf(requestTokens)
  if (request.size === 0) return null

  const intent = setOf(contentTokens(graph.intent ?? ''))
  // `description` is supporting evidence (it may be English, like "syntax,
  // tests, bench"), so it can push a decision over the line but must not make
  // the intent look bigger than it is: coverage stays measured against intent.
  const supporting = new Set([
    ...contentTokens(graph.description ?? ''),
    ...contentTokens(graph.name ?? ''),
  ])
  const vocabulary = new Set([...intent, ...supporting])
  if (vocabulary.size === 0) return null

  let matched = 0
  let matchedSupporting = 0
  for (const token of vocabulary) {
    if (!request.has(token)) continue
    if (intent.has(token)) matched += 1
    else matchedSupporting += 1
  }
  if (matched + matchedSupporting === 0) return null

  // Without a declared intent there is nothing to be covered, so a
  // description-only hit lands at a deliberately low coverage.
  const coverage = intent.size === 0 ? 0 : matched / intent.size
  const precision = (matched + matchedSupporting) / request.size
  // Coverage is a ratio, and a request naming two of three intent terms is not
  // "two thirds certain" the way a long request proves it: with few intent
  // terms the same ratio is far more fragile. Weighting by absolute matched
  // terms keeps a one-word coincidence out while letting a short, precise ask
  // ("проверь пакет") still land.
  const evidence = Math.min(matched + matchedSupporting, EVIDENCE_CAP) / EVIDENCE_CAP
  const score = Number((coverage * (0.55 + 0.45 * evidence)).toFixed(4))
  return {
    name: graph.name,
    intent: graph.intent ?? null,
    description: graph.description ?? null,
    coverage: Number(coverage.toFixed(4)),
    precision: Number(precision.toFixed(4)),
    score,
    matchedTerms: matched,
    supportingTerms: matchedSupporting,
    intentTerms: intent.size,
  }
}

/**
 * Best saved graph for a request, or null.
 *
 * A wrong hint costs a wasted run and some trust, so a match must clear three
 * independent bars. Coverage is what stops a request that shares one vague word
 * from claiming a chain. Precision is deliberately *not* a bar: a person who
 * asks for the verification and three other things still wants the verification,
 * and dividing by request length would punish them for saying more.
 */
export function findReusableChain(requestText, graphs, options = {}) {
  const minCoverage = Number.isFinite(options.minCoverage) ? options.minCoverage : 0.28
  const minPrecision = Number.isFinite(options.minPrecision) ? options.minPrecision : 0.15
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0.22
  const requestTokens = contentTokens(requestText)
  if (requestTokens.length === 0) return null

  let best = null
  for (const graph of graphs ?? []) {
    const scored = scoreGraph(graph, requestTokens)
    if (scored === null) continue
    if (scored.coverage < minCoverage || scored.precision < minPrecision) continue
    if (scored.score < minScore) continue
    if (best === null || scored.score > best.score) best = scored
  }
  return best
}