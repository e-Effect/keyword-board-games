const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");

function section(start, end) {
  return source.slice(source.indexOf(`function ${start}(`), source.indexOf(`function ${end}(`));
}

function renderField({ index = 0, kind = "good", owner = "me", turn = true, row, col = 0 } = {}) {
  const piece = { id: "selected", owner, kind, row: row ?? (index === 0 ? 0 : 5), col };
  const context = vm.createContext({
    state: { status: "playing", isMyTurn: turn, ghost: { myIndex: index, pieces: [piece] } },
    selectedGhostPieceId: piece.id,
    canPlay: () => true
  });
  vm.runInContext(section("ghostToView", "ghostViewToBoard") +
    section("isGhostExitReady", "isAdjacentToSelected") +
    section("renderGhostField", "renderGhostSetupBoard"), context);
  return vm.runInContext('renderGhostField("<div>board</div>")', context);
}

test("external exits face both players and only the correct own door is actionable", () => {
  for (const index of [0, 1]) {
    for (const col of [0, 5]) {
      const html = renderField({ index, col });
      assert.equal((html.match(/class="ghost-door /g) || []).length, 4);
      assert.equal((html.match(/class="ghost-door available"/g) || []).length, 1);
      const viewCol = index === 0 ? col : 5 - col;
      assert.match(html, new RegExp(`class="ghost-door available" data-ghost-escape="${viewCol}"`));
      assert.match(html, /あなたの脱出口/);
      assert.match(html, /相手の脱出口/);
    }
  }
});

test("Hit and Blow renders every guess instead of discarding early history", () => {
  const guesses = Array.from({ length: 12 }, (_, index) => ({ side: "me", value: String(100 + index), hits: 0, blows: 1 }));
  const context = vm.createContext({ state: { guesses }, escapeHtml: String });
  vm.runInContext(section("renderHistoryTable", "renderHistoryBoard"), context);
  const html = vm.runInContext('renderHistoryTable("あなたの推理", "me")', context);
  assert.equal((html.match(/class="duel-history-row"/g) || []).length, 12);
  assert.match(html, /100/);
  assert.match(html, /111/);
});

test("pink ghosts, opponents, wrong turns, and non-exit squares cannot activate doors", () => {
  for (const options of [{ kind: "bad" }, { owner: "opponent" }, { turn: false }, { row: 1 }, { col: 1 }]) {
    assert.doesNotMatch(renderField(options), /class="ghost-door available"/);
  }
});

test("capture counters show both colors caught from the opponent, not own losses", () => {
  const context = vm.createContext({
    state: { ghost: { counts: { me: { badCaptured: 3 }, opponent: { goodCaptured: 2, badCaptured: 1 } } } },
    ghostArt: () => ""
  });
  vm.runInContext(section("renderGhostCounts", "updateGhostFeedback"), context);
  const html = vm.runInContext("renderGhostCounts()", context);
  assert.match(html, /捕まえた水色 <b>2\/4/);
  assert.match(html, /捕まえたピンク <b>1\/4/);
  assert.doesNotMatch(html, /3\/4|取られた/);
});
