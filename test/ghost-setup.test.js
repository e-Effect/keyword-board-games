const test = require("node:test");
const assert = require("node:assert/strict");
const { swapGhostSetupPieces } = require("../public/ghost-setup");
const initial = ["good", "good", "good", "good", "bad", "bad", "bad", "bad"];

test("every possible swap preserves four ghosts of each kind without modifying the input", () => {
  for (let from = 0; from < 8; from += 1) {
    for (let to = 0; to < 8; to += 1) {
      const before = [...initial];
      const after = swapGhostSetupPieces(before, from, to);
      assert.equal(after.length, 8);
      assert.equal(after.filter((kind) => kind === "good").length, 4);
      assert.equal(after.filter((kind) => kind === "bad").length, 4);
      assert.equal(after[from], before[to]);
      assert.equal(after[to], before[from]);
      assert.deepEqual(before, initial);
    }
  }
});

test("repeated swaps preserve the fixed set of pieces", () => {
  let setup = [...initial];
  for (let i = 0; i < 256; i += 1) setup = swapGhostSetupPieces(setup, i % 8, (i * 3 + 5) % 8);
  assert.deepEqual([...setup].sort(), [...initial].sort());
});

test("invalid counts, colors, and off-board slots cannot change the setup", () => {
  assert.throws(() => swapGhostSetupPieces([...initial, "good"], 0, 1));
  assert.throws(() => swapGhostSetupPieces(Array(8).fill("good"), 0, 1));
  assert.throws(() => swapGhostSetupPieces(["unknown", ...initial.slice(1)], 0, 1));
  for (const index of [-1, 8, 1.5, NaN, "1"]) {
    assert.throws(() => swapGhostSetupPieces(initial, index, 0), RangeError);
    assert.throws(() => swapGhostSetupPieces(initial, 0, index), RangeError);
  }
  assert.deepEqual(initial, ["good", "good", "good", "good", "bad", "bad", "bad", "bad"]);
});
