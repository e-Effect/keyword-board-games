const test = require("node:test");
const assert = require("node:assert/strict");
const {
  judgeGuess,
  normalizeKeyword,
  validateKeyword,
  validateNumber,
  validateTimeLimit
} = require("../src/game");

test("normalizes keyword before matching", () => {
  assert.equal(normalizeKeyword("　ＡＢＣＤ　"), "abcd");
});

test("requires at least four keyword characters", () => {
  assert.equal(validateKeyword("abc").ok, false);
  assert.equal(validateKeyword("abcd").ok, true);
});

test("validates three unique digits", () => {
  assert.equal(validateNumber("123").ok, true);
  assert.equal(validateNumber("112").ok, false);
  assert.equal(validateNumber("12").ok, false);
  assert.equal(validateNumber("12a").ok, false);
  assert.equal(validateNumber("0123", 4).ok, true);
  assert.equal(validateNumber("012", 4).ok, false);
  assert.equal(validateNumber("0112", 4).ok, false);
});

test("validates supported turn time limits", () => {
  assert.equal(validateTimeLimit(15).ok, true);
  assert.equal(validateTimeLimit("30").ok, true);
  assert.equal(validateTimeLimit(20).ok, false);
  assert.equal(validateTimeLimit(0).ok, true);
  assert.equal(validateTimeLimit("0").ok, true);
  assert.equal(validateTimeLimit(null).ok, false);
  assert.equal(validateTimeLimit("").ok, false);
  assert.equal(validateTimeLimit(false).ok, false);
});

test("judges hit and blow counts", () => {
  assert.deepEqual(judgeGuess("123", "132"), { hits: 1, blows: 2 });
  assert.deepEqual(judgeGuess("987", "123"), { hits: 0, blows: 0 });
  assert.deepEqual(judgeGuess("123", "123"), { hits: 3, blows: 0 });
});
