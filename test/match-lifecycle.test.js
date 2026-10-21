const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const WebSocket = require("ws");
let child;
let base;
const clients = [];

before(async () => {
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: "0", NODE_ENV: "test", TEST_RECONNECT_GRACE_MS: "1200", COMMENTATOR_PASSWORD: "", COMMENTATOR_SESSION_SECRET: "" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Test server did not start")), 10000);
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      const port = chunk.toString().match(/http:\/\/localhost:(\d+)/)?.[1];
      if (port) { base = `ws://127.0.0.1:${port}`; clearTimeout(timer); resolve(); }
    });
  });
});

after(async () => {
  for (const client of clients) client.socket.terminate();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill(); await exited;
  }
});

async function connect(gameType, options) {
  const client = { socket: new WebSocket(base), state: null, messages: [], playerId: options.playerId || randomUUID(), keyword: options.keyword };
  clients.push(client);
  client.socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    client.messages.push(message);
    if (message.type === "state") client.state = message;
  });
  client.wait = async (predicate, timeout = 5000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (predicate(client.state, client.messages)) return client.state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for test match state");
  };
  await new Promise((resolve, reject) => { client.socket.once("open", resolve); client.socket.once("error", reject); });
  client.send = (message) => client.socket.send(JSON.stringify(message));
  client.send({ type: "join", playerId: client.playerId, nickname: "Test", gameType, timeLimitSeconds: 15, ...options });
  await client.wait((state) => Boolean(state));
  return client;
}

async function pair(gameType) {
  const keyword = randomUUID();
  const a = await connect(gameType, { keyword, action: "create" });
  const b = await connect(gameType, { keyword, action: "join" });
  await a.wait((state) => state.status === "setup");
  if (gameType === "ghost") {
    for (const client of [a, b]) client.send({ type: "ghost-setup", kinds: ["good", "good", "good", "good", "bad", "bad", "bad", "bad"] });
  } else {
    a.send({ type: "set-secret", value: "123" });
    b.send({ type: "set-secret", value: "456" });
  }
  await a.wait((state) => state.status === "playing");
  await b.wait((state) => state.status === "playing");
  return [a, b];
}

test("Ghost rejects fractional, missing, string and non-finite coordinates without losing a turn", async () => {
  const [a] = await pair("ghost");
  const piece = a.state.ghost.pieces.find((p) => p.owner === "me" && p.row === 4 && p.col === 1);
  for (const to of [{ row: 4.5, col: 1.5 }, { row: "3", col: 1 }, { row: null, col: 1 }, { row: Infinity, col: 1 }, { col: 1 }]) {
    const before = a.messages.length;
    a.send({ type: "ghost-move", pieceId: piece.id, to });
    await a.wait((state, messages) => messages.slice(before).some((m) => m.type === "error" && m.code === "move_out_of_board"));
    assert.equal(a.state.isMyTurn, true);
    assert.equal(a.state.ghost.pieces.find((p) => p.id === piece.id).row, 4);
  }
});

test("reconnect freezes the turn, restores the same player and deadline, and later expires with answer reveal", async () => {
  const [a, b] = await pair("hitblow");
  assert.equal(b.state.opponent.secret, null);
  assert.equal(b.state.answers, null);
  a.socket.close();
  await b.wait((state) => Boolean(state.reconnectDeadlineAt));
  const remaining = b.state.pausedRemainingMs;
  assert.equal(b.state.turnDeadlineAt, null);
  const before = b.messages.length;
  b.send({ type: "guess", value: "789" });
  await b.wait((state, messages) => messages.slice(before).some((m) => m.code === "game_paused"));
  const resumed = await connect("hitblow", { keyword: a.keyword, playerId: a.playerId, action: "resume" });
  assert.equal(resumed.state.isMyTurn, true);
  assert.equal(resumed.state.me.secret, "123");
  assert.equal(resumed.state.reconnectDeadlineAt, null);
  assert.ok(Math.abs(resumed.state.turnDeadlineAt - resumed.state.serverNow - remaining) < 100);
  resumed.socket.close();
  await b.wait((state) => state.status === "ended");
  assert.equal(b.state.endReason, "disconnect-timeout");
  assert.equal(b.state.winner.side, "me");
  assert.equal(b.state.answers.opponent.secret, "123");
});

test("resignation reveals both answers only at the end and preserves them after the opponent leaves", async () => {
  const [a, b] = await pair("hitblow");
  a.send({ type: "resign" });
  await a.wait((state) => state.status === "ended");
  await b.wait((state) => state.status === "ended");
  assert.equal(a.state.winner.side, "opponent");
  assert.equal(b.state.opponent.secret, "123");
  a.send({ type: "leave" });
  await b.wait((state) => state.opponent === null);
  assert.equal(b.state.answers.opponent.secret, "123");
  assert.equal(b.state.isFirst, false);
});

test("Ghost move highlights expose positions, not hidden colors; final colors survive an opponent exit", async () => {
  const [a, b] = await pair("ghost");
  assert.ok(a.state.ghost.pieces.filter((p) => p.owner === "opponent").every((p) => p.kind === "unknown"));
  const piece = a.state.ghost.pieces.find((p) => p.owner === "me" && p.row === 4 && p.col === 1);
  a.send({ type: "ghost-move", pieceId: piece.id, to: { row: 3, col: 1 } });
  await b.wait((state) => state.ghost.log.length === 1);
  assert.deepEqual(b.state.ghost.log[0].from, { row: 4, col: 1 });
  assert.equal(b.state.ghost.log[0].pieceKind, "unknown");
  a.send({ type: "leave" });
  await b.wait((state) => state.status === "ended" && state.opponent === null);
  assert.equal(b.state.ghost.myIndex, 1);
  assert.ok(b.state.ghost.pieces.every((p) => ["good", "bad"].includes(p.kind)));
  assert.equal(b.state.answers.opponent.nickname, "Test");
});

test("a submitted Ghost setup survives resume without exposing it to the opponent", async () => {
  const keyword = randomUUID();
  const a = await connect("ghost", { keyword, action: "create" });
  const b = await connect("ghost", { keyword, action: "join" });
  await a.wait((state) => state.status === "setup");
  const kinds = ["bad", "good", "bad", "good", "good", "bad", "good", "bad"];
  a.send({ type: "ghost-setup", kinds });
  await a.wait((state) => state.me.ready);
  a.socket.close();
  const resumed = await connect("ghost", { keyword, action: "resume", playerId: a.playerId });
  assert.deepEqual(resumed.state.ghost.mySetup, kinds);
  assert.equal(b.state.ghost.mySetup, null);
  assert.equal(b.state.ghost.pieces.length, 0);
});
