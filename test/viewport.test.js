const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function handlers() {
  const listeners = new Map();
  vm.runInNewContext(fs.readFileSync(require.resolve("../public/viewport.js"), "utf8"), {
    document: {
      addEventListener(type, callback, options) {
        assert.equal(options.passive, false);
        listeners.set(type, callback);
      }
    }
  });
  return listeners;
}

test("Safari pinch gestures are canceled without passive listeners", () => {
  const listeners = handlers();
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    let prevented = false;
    listeners.get(type)({ cancelable: true, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    listeners.get(type)({ cancelable: false, preventDefault() { assert.fail("not cancelable"); } });
  }
});

test("multi-touch is blocked but single-finger scrolling and dragging are preserved", () => {
  const listeners = handlers();
  for (const type of ["touchstart", "touchmove"]) {
    for (const count of [0, 1, 2, 3]) {
      let prevented = false;
      listeners.get(type)({ touches: Array(count), cancelable: true, preventDefault() { prevented = true; } });
      assert.equal(prevented, count > 1);
    }
  }
});
