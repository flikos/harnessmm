import test from 'node:test'
import assert from 'node:assert/strict'
import { contentTokens, findReusableChain, normalizeText, scoreGraph, stem } from '../lib/match.js'

const graph = (name, intent, description = '') => ({ name, intent, description })

const VERIFY = graph('verify-package', 'пакет: тесты и замер', 'syntax, tests, bench, плагин')
const DEPLOY = graph('deploy-staging', 'сборка на staging', 'build and publish')

test('normalization keeps letters and digits, drops punctuation', () => {
  assert.equal(normalizeText('  Проверь, ПЛАГИН!!  '), 'проверь плагин')
  assert.equal(normalizeText('run `npm test` now'), 'run npm test now')
})

test('stopwords carry no identity, content words survive stemming', () => {
  const tokens = contentTokens('нужно проверь плагин и тесты')
  assert.equal(tokens.includes('нужно'), false)
  assert.equal(tokens.includes('и'), false)
  assert.ok(tokens.some((token) => token.startsWith('плагин')))
  assert.ok(tokens.some((token) => token.startsWith('тест')))
})

test('russian inflection collapses to one stem', () => {
  assert.equal(stem('плагина'), stem('плагину'))
  assert.equal(stem('тесты'), stem('тест'))
})

test('a natural sentence asking for the same work matches, without any registered phrase', () => {
  // Same request as the one that defeated the old fingerprint design, worded
  // the way a person writes it.
  const requests = [
    'прогони тесты и замер для пакета',
    'прогони тесты и замер для плагина, пожалуйста',
    'проверь пакет: тесты и замер',
  ]
  for (const request of requests) {
    const match = findReusableChain(request, [VERIFY, DEPLOY])
    assert.ok(match, `expected a match for: ${request}`)
    assert.equal(match.name, 'verify-package')
  }
})

test('a request that only shares a vague word is not a match', () => {
  // "плагин" appears in a description, but the request asks for nothing the
  // chain does. A weak hint costs a wasted run and some trust.
  const request = 'Проверь плагин. Посмотри, что реализовано и как это можно улучшить?'
  const vague = graph('verify-package', 'пакет: тесты и замер', 'syntax, tests, bench, плагин')
  assert.equal(findReusableChain(request, [vague, DEPLOY]), null)
})

test('an unrelated request does not match', () => {
  assert.equal(findReusableChain('Переведи этот текст на английский', [VERIFY, DEPLOY]), null)
  assert.equal(findReusableChain('Перепиши этот модуль на TypeScript', [VERIFY, DEPLOY]), null)
})

test('a short precise ask still lands on a three-term intent', () => {
  const match = findReusableChain('проверь пакет', [VERIFY, DEPLOY])
  assert.ok(match, 'one strong intent term out of three is still evidence')
  assert.equal(match.name, 'verify-package')
})

test('a request that mentions a notable part of the intent wins over a partial one', () => {
  const request = 'прогони тесты и замер для пакета'
  const match = findReusableChain(request, [VERIFY, DEPLOY])
  assert.equal(match.name, 'verify-package')
})

test('a graph without intent is never suggested', () => {
  assert.equal(findReusableChain('проверить пакет тесты замер', [graph('anonymous', '')]), null)
})

test('coverage and precision are reported separately so a hint can be audited', () => {
  const scored = scoreGraph(VERIFY, contentTokens('проверить пакет'))
  assert.ok(scored)
  assert.ok(scored.coverage > 0)
  assert.ok(scored.precision > 0)
  assert.equal(scored.name, 'verify-package')
})

test('a chatty request still matches when it covers the intent', () => {
  const request =
    'проверить пакет полностью, прогони тесты и сделай замер, потом покажи сводку и напиши отчёт в файл'
  const match = findReusableChain(request, [VERIFY, DEPLOY])
  assert.ok(match)
  assert.equal(match.name, 'verify-package')
})

test('empty or tokenless requests never match', () => {
  assert.equal(findReusableChain('', [VERIFY]), null)
  assert.equal(findReusableChain('и в на', [VERIFY]), null)
})