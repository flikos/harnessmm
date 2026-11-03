/**
 * A small coding task set. Every task ships a hidden check script the actor
 * never sees, a reference solution (v1) and, for two tasks, a repair (v2) so
 * that the guard path has to fail closed and hand control back to the actor.
 */
export const TASKS = [
  {
    id: 'add',
    prompt: 'Write solution.py with add(a, b) returning the sum of two integers.',
    solution: `def add(a, b):
    return a + b
`,
    check: `from solution import add

assert add(2, 3) == 5
assert add(-4, 4) == 0
assert add(0, 0) == 0
print("ALL TESTS PASSED")
`,
  },
  {
    id: 'fizzbuzz',
    prompt: 'Write solution.py with fizzbuzz(n) returning a list of strings for 1..n.',
    solution: `def fizzbuzz(n):
    out = []
    for i in range(1, n + 1):
        if i % 15 == 0:
            out.append("FizzBuzz")
        elif i % 3 == 0:
            out.append("Fizz")
        elif i % 5 == 0:
            out.append("Buzz")
        else:
            out.append(str(i))
    return out
`,
    check: `from solution import fizzbuzz

assert fizzbuzz(5) == ["1", "2", "Fizz", "4", "Buzz"]
assert fizzbuzz(15)[-1] == "FizzBuzz"
print("ALL TESTS PASSED")
`,
  },
  {
    id: 'palindrome',
    prompt: 'Write solution.py with is_palindrome(s) ignoring case and non-alphanumerics.',
    solution: `def is_palindrome(s):
    letters = [c.lower() for c in s if c.isalnum()]
    return letters == letters[::-1]
`,
    check: `from solution import is_palindrome

assert is_palindrome("A man, a plan, a canal: Panama")
assert not is_palindrome("hello")
assert is_palindrome("")
print("ALL TESTS PASSED")
`,
  },
  {
    id: 'gcd',
    prompt: 'Write solution.py with gcd(a, b) using the Euclidean algorithm.',
    solution: `def gcd(a, b):
    a, b = abs(a), abs(b)
    while b:
        a, b = b, a % b
    return a
`,
    check: `from solution import gcd

assert gcd(48, 18) == 6
assert gcd(17, 5) == 1
assert gcd(0, 9) == 9
print("ALL TESTS PASSED")
`,
  },
  {
    id: 'flatten',
    prompt: 'Write solution.py with flatten(items) that flattens arbitrarily nested lists.',
    solution: `def flatten(items):
    out = []
    for item in items:
        if isinstance(item, list):
            out.extend(flatten(item))
        else:
            out.append(item)
    return out
`,
    check: `from solution import flatten

assert flatten([1, [2, [3, [4]]], 5]) == [1, 2, 3, 4, 5]
assert flatten([]) == []
print("ALL TESTS PASSED")
`,
  },
  {
    id: 'word_freq',
    prompt: 'Write solution.py with word_freq(text, k) returning the k most common lowercase words.',
    solution: `import re


def word_freq(text, k):
    counts = {}
    for word in re.findall(r"[a-z]+", text.lower()):
        counts[word] = counts.get(word, 0) + 1
    ranked = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))
    return [word for word, _ in ranked[:k]]
`,
    check: `from solution import word_freq

assert word_freq("the cat and the dog and the bird", 2) == ["the", "and"]
assert word_freq("", 3) == []
print("ALL TESTS PASSED")
`,
  },
  {
    id: 'roman',
    prompt: 'Write solution.py with roman(n) converting 1..3999 to Roman numerals.',
    solution: `VALUES = [
    (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"),
    (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
    (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
]


def roman(n):
    out = []
    for value, sign in VALUES:
        while n >= value:
            out.append(sign)
            n -= value
    return "".join(out)
`,
    buggySolution: `VALUES = [
    (1000, "M"), (500, "D"), (100, "C"), (50, "L"), (10, "X"), (5, "V"), (1, "I"),
]


def roman(n):
    out = []
    for value, sign in VALUES:
        while n >= value:
            out.append(sign)
            n -= value
    return "".join(out)
`,
    check: `from solution import roman

assert roman(4) == "IV"
assert roman(9) == "IX"
assert roman(1994) == "MCMXCIV"
print("ALL TESTS PASSED")
`,
  },
  {
    id: 'balanced',
    prompt: 'Write solution.py with balanced(s) checking that brackets are balanced.',
    solution: `PAIRS = {")": "(", "]": "[", "}": "{"}


def balanced(s):
    stack = []
    for char in s:
        if char in "([{":
            stack.append(char)
        elif char in PAIRS:
            if not stack or stack.pop() != PAIRS[char]:
                return False
    return not stack
`,
    brokenSolution: `PAIRS = {")": "(", "]": "[", "}": "{"}


def balanced(s)
    stack = []
    for char in s:
        if char in "([{":
            stack.append(char)
        elif char in PAIRS:
            if not stack or stack.pop() != PAIRS[char]:
                return False
    return not stack
`,
    check: `from solution import balanced

assert balanced("([]{})")
assert not balanced("(]")
print("ALL TESTS PASSED")
`,
  },
]

export function taskById(id) {
  return TASKS.find((task) => task.id === id)
}