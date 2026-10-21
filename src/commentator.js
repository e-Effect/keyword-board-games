const crypto = require("node:crypto");

const SESSION_SECONDS = 365 * 24 * 60 * 60;
const COOKIE = "commentator_session";

function makeCommentatorAuth(password, sessionSecret) {
  const configured = typeof password === "string" && password.length >= 4 && typeof sessionSecret === "string" && sessionSecret.length >= 32;
  const key = configured ? crypto.scryptSync(password, sessionSecret, 32) : null;
  const digest = (value) => crypto.createHash("sha256").update(value).digest();
  const expected = configured ? digest(password) : null;
  const sign = (payload) => crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return {
    configured,
    checkPassword(value) {
      return configured && typeof value === "string" && crypto.timingSafeEqual(digest(value), expected);
    },
    issue(now = Date.now()) {
      if (!configured) throw new Error("Commentator access is not configured");
      const payload = Buffer.from(JSON.stringify({ exp: now + SESSION_SECONDS * 1000, nonce: crypto.randomBytes(18).toString("base64url") })).toString("base64url");
      return `${payload}.${sign(payload)}`;
    },
    verify(token, now = Date.now()) {
      if (!configured || typeof token !== "string" || token.length > 1024) return false;
      const parts = token.split(".");
      if (parts.length !== 2) return false;
      const signature = Buffer.from(parts[1], "base64url");
      const expectedSignature = Buffer.from(sign(parts[0]), "base64url");
      if (signature.length !== expectedSignature.length || !crypto.timingSafeEqual(signature, expectedSignature)) return false;
      try {
        const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString());
        return Number.isFinite(payload.exp) && payload.exp > now && payload.exp <= now + SESSION_SECONDS * 1000;
      } catch {
        return false;
      }
    }
  };
}

function readCookie(request) {
  return (request.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}

function sessionCookie(token, request, clear = false) {
  const secure = request.socket.encrypted || request.headers["x-forwarded-proto"] === "https";
  return `${COOKIE}=${token}; Path=/commentator/; Max-Age=${clear ? 0 : SESSION_SECONDS}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function roomSnapshot(room, startSlotsForIndex) {
  const players = room.players.map((player, index) => ({
    index: room.ghost.pieces.find((piece) => piece.ownerId === player.id)?.ownerIndex ?? index,
    nickname: player.nickname,
    connected: player.connected,
    ready: room.gameType === "ghost" ? Boolean(player.ghostSetup) : Boolean(player.secret),
    secret: room.gameType === "hitblow" ? player.secret : null,
    winner: player.id === room.winnerId
  }));
  const pieces = room.status === "setup"
    ? room.players.flatMap((player, index) => (player.ghostSetup || []).map((kind, slot) => ({
      kind, ownerIndex: index, ...startSlotsForIndex(index)[slot], alive: true, escaped: false
    })))
    : room.ghost.pieces.map(({ kind, ownerIndex, row, col, alive, escaped }) => ({ kind, ownerIndex, row, col, alive, escaped: Boolean(escaped) }));
  return {
    id: room.commentatorId,
    gameType: room.gameType,
    status: room.status,
    createdAt: room.createdAt,
    players,
    turnIndex: room.turnIndex,
    startingIndex: room.startingIndex,
    timeLimitSeconds: room.timeLimitSeconds,
    length: room.length,
    deadline: room.status === "setup" ? room.setupDeadlineAt : room.turnDeadlineAt,
    result: room.result,
    endReason: room.gameType === "ghost" ? room.ghost.winReason : room.endReason,
    finalAnswer: Boolean(room.pendingWinnerId),
    guesses: room.guesses.map(({ playerId, value, hits, blows, skipped }) => ({
      playerIndex: room.players.findIndex((player) => player.id === playerId), value, hits, blows, skipped: Boolean(skipped)
    })),
    pieces: room.gameType === "ghost" ? pieces : []
  };
}

function createCommentatorApi({ password, sessionSecret, rooms, startSlotsForIndex }) {
  const auth = makeCommentatorAuth(password, sessionSecret);
  const failures = new Map();
  let globalFailure = { count: 0, until: 0 };
  const json = (response, status, body, headers = {}) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, private", "x-content-type-options": "nosniff", ...headers });
    response.end(JSON.stringify(body));
  };
  return async (request, response, url) => {
    if (!url.pathname.startsWith("/commentator/api/")) return false;
    const authenticated = auth.verify(readCookie(request));
    if (request.method === "GET" && url.pathname === "/commentator/api/session") {
      json(response, 200, { authenticated, configured: auth.configured }, authenticated ? { "set-cookie": sessionCookie(auth.issue(), request) } : {});
      return true;
    }
    if (request.method === "POST") {
      const origin = request.headers.origin;
      const protocol = request.socket.encrypted || request.headers["x-forwarded-proto"] === "https" ? "https" : "http";
      if (origin !== `${protocol}://${request.headers.host}` || !request.headers["content-type"]?.startsWith("application/json")) {
        json(response, 403, { message: "この送信元からは操作できません。" });
        return true;
      }
    }
    if (request.method === "POST" && url.pathname === "/commentator/api/login") {
      if (!auth.configured) {
        json(response, 503, { message: "実況用パスワードが未設定です。管理者による設定が必要です。" });
        return true;
      }
      const ip = request.headers["x-forwarded-for"]?.split(",").at(-1).trim() || request.socket.remoteAddress;
      const now = Date.now();
      for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
      const failure = failures.get(ip);
      if (globalFailure.until <= now) globalFailure = { count: 0, until: now + 15 * 60 * 1000 };
      if ((failure?.count || 0) >= 5 || globalFailure.count >= 5 || failures.size >= 10000) {
        json(response, 429, { message: "入力回数が上限に達しました。15分後にお試しください。" }, { "retry-after": "900" });
        return true;
      }
      let raw = "";
      try {
        for await (const chunk of request) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 2048) {
            json(response, 413, { message: "入力が長すぎます。" });
            return true;
          }
        }
        const body = JSON.parse(raw);
        // Recheck after reading the body so parallel requests cannot bypass the limit.
        if (globalFailure.count >= 5) {
          json(response, 429, { message: "入力回数が上限に達しました。15分後にお試しください。" }, { "retry-after": "900" });
          return true;
        }
        if (!auth.checkPassword(body.password)) {
          globalFailure.count += 1;
          failures.set(ip, { count: (failure?.count || 0) + 1, until: failure?.until || now + 15 * 60 * 1000 });
          json(response, 401, { message: "パスワードが違います。" });
          return true;
        }
      } catch {
        json(response, 400, { message: "入力内容を確認してください。" });
        return true;
      }
      failures.delete(ip);
      globalFailure = { count: 0, until: 0 };
      json(response, 200, { authenticated: true }, { "set-cookie": sessionCookie(auth.issue(), request) });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/commentator/api/logout") {
      json(response, 200, { authenticated: false }, { "set-cookie": sessionCookie("", request, true) });
      return true;
    }
    if (!authenticated) {
      json(response, 401, { message: "実況者ログインが必要です。" });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/commentator/api/rooms") {
      json(response, 200, { serverNow: Date.now(), rooms: [...rooms.values()].map((room) => roomSnapshot(room, startSlotsForIndex)) });
      return true;
    }
    json(response, 404, { message: "見つかりません。" });
    return true;
  };
}

module.exports = { makeCommentatorAuth, createCommentatorApi, roomSnapshot, sessionCookie };
