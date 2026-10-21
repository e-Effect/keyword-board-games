const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("Usage: node scripts/verify-hosted.cjs https://example.com");
const sockets = [];
const keyword = `verify-${randomUUID()}`;

async function connect(gameType, nickname) {
  const socket = new WebSocket(baseUrl.replace(/^http/, "ws"));
  sockets.push(socket);
  const client = { socket, state: null, failure: null };
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
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
    throw new Error(`Timed out waiting for ${gameType}: ${nickname}`);
  };
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  client.send({ type: "join", playerId: randomUUID(), keyword, nickname, gameType, timeLimitSeconds: 15 });
  await client.wait(() => true);
  return client;
}

async function verify() {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  console.log("PASS HTTPS health");

  const first = await connect("hitblow", "Verify A");
  const ghostA = await connect("ghost", "Verify C");
  assert.equal(first.state.status, "waiting");
  assert.equal(ghostA.state.status, "waiting");
  const second = await connect("hitblow", "Verify B");
  await first.wait((state) => state.status === "setup");
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
