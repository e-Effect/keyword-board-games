const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("Usage: node scripts/verify-hosted.cjs https://example.com");
const sockets = [];
const keyword = `verify-${randomUUID()}`;

async function connect(gameType, nickname, options = {}) {
  const socket = new WebSocket(baseUrl.replace(/^http/, "ws"));
  sockets.push(socket);
  const client = { socket, state: null, failure: null, messages: [], playerId: options.playerId || randomUUID(), keyword: options.keyword || keyword };
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    client.messages.push(message);
    if (message.type === "state") client.state = message;
    if (message.type === "error") client.failure = new Error(message.message);
  });
  client.send = (message) => socket.send(JSON.stringify(message));
  client.wait = async (predicate, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (client.failure) throw client.failure;
      if (client.state && predicate(client.state)) return client.state;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out waiting for ${gameType}: ${nickname}; condition=${predicate}; last=${JSON.stringify({ status: client.state?.status, ready: client.state?.me.ready, connected: client.state?.opponent?.connected, result: client.state?.result })}`);
  };
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  client.send({ type: "join", playerId: client.playerId, keyword, nickname, gameType, timeLimitSeconds: 15, ...options });
  await client.wait(() => true);
  return client;
}

async function verify() {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  console.log("PASS HTTPS health");
  await assert.rejects(connect("hitblow", "Missing", { keyword: `missing-${randomUUID()}`, action: "join" }), /部屋が見つかりません/);

  const first = await connect("hitblow", "Verify A", { action: "create" });
  await assert.rejects(connect("hitblow", "Duplicate", { action: "create" }), /すでにあります/);
  const ghostA = await connect("ghost", "Verify C", { action: "create" });
  assert.equal(first.state.status, "waiting");
  assert.equal(ghostA.state.status, "waiting");
  const second = await connect("hitblow", "Verify B");
  await first.wait((state) => state.status === "setup");
  assert.ok(Math.abs(first.state.setupDeadlineAt - first.state.serverNow - 30000) < 1000);
  assert.equal(ghostA.state.status, "waiting");
  console.log("PASS keyword matching and game-mode isolation");

  first.send({ type: "set-secret", value: "123" });
  second.send({ type: "set-secret", value: "456" });
  await first.wait((state) => state.status === "playing");
  await second.wait((state) => state.status === "playing");
  assert.equal(first.state.me.secret, "123");
  assert.equal(first.state.opponent.secret, null);
  assert.equal(first.state.rules.timeLimitSeconds, 15);
  const firstTurn = first.state.isMyTurn;
  await first.wait((state) => state.guesses.length === 1, 20000);
  await second.wait((state) => state.guesses.length === 1);
  assert.equal(first.state.guesses[0].skipped, true);
  assert.equal(first.state.isMyTurn, !firstTurn);
  const guesser = first.state.isMyTurn ? first : second;
  guesser.send({ type: "guess", value: guesser === first ? "456" : "123" });
  await guesser.wait((state) => Boolean(state.winner));
  assert.equal(guesser.state.winner.side, "me");
  console.log("PASS Hit and Blow secret privacy, 15-second timeout, turn switch, and win");

  const ghostB = await connect("ghost", "Verify D");
  await ghostA.wait((state) => state.status === "setup");
  const kinds = ["good", "bad", "good", "bad", "good", "bad", "good", "bad"];
  ghostA.send({ type: "ghost-setup", kinds });
  ghostB.send({ type: "ghost-setup", kinds });
  await ghostA.wait((state) => state.status === "playing");
  await ghostB.wait((state) => state.status === "playing");
  const mover = ghostA.state.isMyTurn ? ghostA : ghostB;
  const pieces = mover.state.ghost.pieces;
  const own = pieces.filter((piece) => piece.owner === "me");
  const opponents = pieces.filter((piece) => piece.owner === "opponent");
  assert.equal(own.length, 8);
  assert.equal(opponents.length, 8);
  assert.ok(opponents.every((piece) => piece.kind !== "good" && piece.kind !== "bad"));
  const piece = own.find((item) => item.row === 4 || item.row === 1);
  assert.ok(piece);
  const row = piece.row === 4 ? 3 : 2;
  mover.send({ type: "ghost-move", pieceId: piece.id, to: { row, col: piece.col } });
  await mover.wait((state) => state.ghost.log.some((entry) => entry.action === "move"));
  assert.equal(mover.state.isMyTurn, false);
  assert.equal(mover.state.ghost.pieces.find((item) => item.id === piece.id).row, row);
  console.log("PASS Ghost Duel setup, hidden opponent colors, move, and turn switch");

  async function pair(options = {}) {
    const pairKeyword = `verify-${randomUUID()}`;
    const a = await connect("hitblow", "Host", { ...options, keyword: pairKeyword, action: "create" });
    const b = await connect("hitblow", "Guest", { keyword: pairKeyword, action: "join", length: 3, timeLimitSeconds: 60 });
    await a.wait((state) => state.status === "setup");
    return [a, b];
  }
  const [timeoutA, timeoutB] = await pair({ timeLimitSeconds: 0, length: 4 });
  const setupDeadline = timeoutA.state.setupDeadlineAt;
  timeoutA.send({ type: "set-secret", value: "0123" });
  await timeoutA.wait((state) => state.me.ready);
  timeoutB.socket.close();
  // Reconnect as soon as the client reconnects; proxy close propagation may lag.
  const resumed = await connect("hitblow", "Guest", { action: "resume", keyword: timeoutB.keyword, playerId: timeoutB.playerId });
  assert.equal(resumed.state.setupDeadlineAt, setupDeadline);
  const [bothLate] = await pair({ timeLimitSeconds: 0 });
  const [finalA, finalB] = await pair();
  finalA.send({ type: "set-secret", value: "123" });
  finalB.send({ type: "set-secret", value: "456" });
  await finalA.wait((state) => state.status === "playing");
  finalA.send({ type: "guess", value: "456" });
  await finalA.wait((state) => state.finalAnswer);

  const [a, b] = await pair({ length: 4, timeLimitSeconds: 0 });
  assert.equal(b.state.rules.length, 4);
  assert.equal(b.state.rules.timeLimitSeconds, 0);
  a.send({ type: "set-secret", value: "0123" });
  b.send({ type: "set-secret", value: "4567" });
  await a.wait((state) => state.status === "playing");
  await b.wait((state) => state.status === "playing");
  assert.equal(a.state.turnDeadlineAt, null);
  assert.equal(a.state.setupDeadlineAt, null);
  assert.equal(a.state.isFirst, true);
  a.send({ type: "guess", value: "4567" });
  await a.wait((state) => state.finalAnswer);
  await b.wait((state) => state.finalAnswer);
  assert.equal(a.state.status, "playing");
  assert.equal(b.state.isMyTurn, true);
  b.send({ type: "guess", value: "0123" });
  await a.wait((state) => state.status === "ended");
  await b.wait((state) => state.status === "ended");
  assert.equal(a.state.result, "draw");
  assert.equal(b.state.winner, null);
  console.log("PASS 4 digits, inherited settings, unlimited turns, final answer, and Draw");

  a.send({ type: "rematch" });
  b.send({ type: "rematch" });
  await a.wait((state) => state.status === "setup");
  await b.wait((state) => state.status === "setup");
  assert.equal(a.state.isFirst, false);
  assert.ok(a.state.setupDeadlineAt > setupDeadline);
  a.send({ type: "set-secret", value: "0123" });
  b.send({ type: "set-secret", value: "4567" });
  await a.wait((state) => state.status === "playing");
  await b.wait((state) => state.status === "playing");
  b.send({ type: "guess", value: "0123" });
  await a.wait((state) => state.finalAnswer);
  a.send({ type: "guess", value: "4568" });
  await a.wait((state) => state.status === "ended");
  await b.wait((state) => state.status === "ended");
  assert.equal(b.state.winner.side, "me");
  a.send({ type: "leave" });
  await b.wait((state) => !state.opponent);
  assert.equal(b.state.status, "ended");
  console.log("PASS rematch, swapped first player, final miss, and preserving result after opponent leaves");

  await timeoutA.wait((state) => state.status === "ended", 35000);
  assert.equal(timeoutA.state.winner.side, "me");
  assert.equal(timeoutA.state.endReason, "setup-timeout");
  await resumed.wait((state) => state.status === "ended");
  assert.equal(resumed.state.winner.side, "opponent");
  await bothLate.wait((state) => state.status === "ended");
  assert.equal(bothLate.state.result, "double-loss");
  await finalA.wait((state) => state.status === "ended");
  assert.equal(finalA.state.winner.side, "me");
  assert.equal(finalA.state.endReason, "final-answer-timeout");
  console.log("PASS fixed 30-second setup loss even with unlimited turns");
  console.log("PASS unchanged deadline after reconnect, double setup loss, and final-answer timeout");
}

verify().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "leave" }));
      socket.close();
    } else {
      socket.terminate();
    }
  }
});
