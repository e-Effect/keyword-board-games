const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { makeCommentatorAuth, createCommentatorApi, roomSnapshot, sessionCookie } = require("../src/commentator");

const password = "test-only-password";
const secret = crypto.randomBytes(48).toString("base64url");

test("signed commentator sessions persist across restart but reject tampering, expiry and changed credentials", () => {
  const auth = makeCommentatorAuth(password, secret);
  const now = Date.now();
  const token = auth.issue(now);
  assert.equal(auth.checkPassword(password), true);
  assert.equal(auth.checkPassword("wrong"), false);
  assert.equal(makeCommentatorAuth(password, secret).verify(token, now + 300000), true);
  assert.equal(auth.verify(token + "changed", now), false);
  assert.equal(auth.verify("bad.token.extra", now), false);
  assert.equal(auth.verify(token, now + 366 * 86400000), false);
  assert.equal(makeCommentatorAuth("different-password", secret).verify(token, now), false);
  assert.equal(makeCommentatorAuth(password, "different-long-secret-for-testing").verify(token, now), false);
  assert.equal(makeCommentatorAuth("1234", secret).configured, true);
  assert.equal(makeCommentatorAuth(password).configured, false);
  assert.equal(makeCommentatorAuth(undefined, secret).verify(token), false);
});

test("persistent auth cookie is HttpOnly, restricted to commentator routes and secure on HTTPS", () => {
  const cookie = sessionCookie("test-token", { headers: { "x-forwarded-proto": "https" }, socket: {} });
  assert.match(cookie, /Path=\/commentator\//);
  assert.match(cookie, /HttpOnly; SameSite=Strict; Secure/);
  assert.match(cookie, /Max-Age=31536000/);
  assert.match(sessionCookie("", { headers: {}, socket: {} }, true), /Max-Age=0/);
});

function sampleRoom() {
  return {
    commentatorId: "room-public-id", roomKey: "private-key", keywordHash: "private-hash",
    gameType: "hitblow", status: "playing", createdAt: 1, turnIndex: 0, startingIndex: 0,
    length: 3, timeLimitSeconds: 30, turnDeadlineAt: 1000,
    players: [{ id: "private-id-a", nickname: "A", secret: "123", connected: true }, { id: "private-id-b", nickname: "B", secret: "456", connected: true }],
    guesses: [{ playerId: "private-id-a", value: "789", hits: 0, blows: 0 }],
    ghost: { pieces: [], winReason: null }
  };
}

test("commentator projections reveal both finalized secrets but omit credentials and player identifiers", () => {
  const snapshot = roomSnapshot(sampleRoom(), () => []);
  assert.deepEqual(snapshot.players.map((p) => p.secret), ["123", "456"]);
  assert.equal(snapshot.guesses[0].playerIndex, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-key|private-hash|private-id/);
  const room = sampleRoom();
  room.gameType = "ghost";
  room.ghost.pieces = [{ ownerId: room.players[0].id, ownerIndex: 0, kind: "good", row: 4, col: 1, alive: true }, { ownerId: room.players[1].id, ownerIndex: 1, kind: "bad", row: 2, col: 2, alive: true }];
  assert.deepEqual(roomSnapshot(room, () => []).pieces.map((p) => p.kind), ["good", "bad"]);
  room.status = "setup";
  room.players[0].ghostSetup = ["good", "bad"];
  const pending = roomSnapshot(room, () => [{ row: 5, col: 1 }, { row: 5, col: 2 }]);
  assert.equal(pending.pieces.length, 2);
  assert.equal(pending.players[1].ready, false);
});

test("HTTP commentator endpoints require auth and origin, retain sessions, logout, and throttle distributed guessing", async (t) => {
  const rooms = new Map([["key", sampleRoom()]]);
  const handle = createCommentatorApi({ password, sessionSecret: secret, rooms, startSlotsForIndex: () => [] });
  const server = http.createServer((req, res) => {
    handle(req, res, new URL(req.url, "http://localhost")).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(`${base}/commentator/api/${path}`, {
    method: "POST", headers: { origin: base, "content-type": "application/json", ...headers }, body: JSON.stringify(body)
  });
  assert.equal((await fetch(`${base}/commentator/api/rooms`)).status, 401);
  const denied = await fetch(`${base}/commentator/api/rooms`, { headers: { cookie: "commentator_session=forged" } });
  assert.equal(denied.status, 401);
  assert.doesNotMatch(await denied.text(), /123|456/);
  assert.equal((await post("login", { password }, { origin: "https://attacker.invalid" })).status, 403);
  const login = await post("login", { password });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const authorized = await fetch(`${base}/commentator/api/rooms`, { headers: { cookie } });
  assert.equal(authorized.headers.get("cache-control"), "no-store, private");
  assert.deepEqual((await authorized.json()).rooms[0].players.map((p) => p.secret), ["123", "456"]);
  const restored = await fetch(`${base}/commentator/api/session`, { headers: { cookie } });
  assert.equal((await restored.json()).authenticated, true);
  assert.match(restored.headers.get("set-cookie"), /HttpOnly/);
  assert.match((await post("logout", {})).headers.get("set-cookie"), /Max-Age=0/);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await post("login", { password: "wrong" }, { "x-forwarded-for": `192.0.2.${attempt}` })).status, 401);
  }
  assert.equal((await post("login", { password }, { "x-forwarded-for": "192.0.2.20" })).status, 429);
});

test("unconfigured service fails closed instead of allowing a public first-user password registration", async (t) => {
  const handle = createCommentatorApi({ rooms: new Map(), startSlotsForIndex: () => [] });
  const server = http.createServer((req, res) => handle(req, res, new URL(req.url, "http://localhost")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/commentator/api/rooms`)).status, 401);
  const result = await fetch(`${base}/commentator/api/login`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(result.status, 503);
});
