const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { WebSocketServer } = require("ws");
const {
  DEFAULT_TURN_TIME_LIMIT,
  DEFAULT_LENGTH,
  judgeGuess,
  validateKeyword,
  validateNumber,
  validateTimeLimit
} = require("./src/game");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const ROOM_TTL_MS = 30 * 60 * 1000;
const WAITING_TTL_MS = 10 * 60 * 1000;

const rooms = new Map();
const GAME_TYPES = new Set(["hitblow", "ghost"]);
const BOARD_SIZE = 6;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

function hashKeyword(keyword) {
  return crypto.createHash("sha256").update(keyword).digest("hex");
}

function makeRoom(roomKey, keywordHash, gameType, timeLimitSeconds = DEFAULT_TURN_TIME_LIMIT) {
  return {
    roomKey,
    keywordHash,
    gameType,
    players: [],
    status: "waiting",
    guesses: [],
    ghost: makeGhostState(),
    length: DEFAULT_LENGTH,
    timeLimitSeconds,
    turnIndex: 0,
    startingIndex: 0,
    turnStartedAt: null,
    turnDeadlineAt: null,
    turnTimer: null,
    winnerId: null,
    createdAt: Date.now(),
    lastActivity: Date.now()
  };
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function deleteRoom(room) {
  clearTurnTimer(room);
  rooms.delete(room.roomKey);
}

function makeGhostState() {
  return {
    pieces: [],
    log: [],
    moveNumber: 0,
    winReason: null
  };
}

function getPlayerIndex(room, player) {
  return room.players.findIndex((candidate) => candidate.id === player.id);
}

function startSlotsForIndex(index) {
  return index === 0
    ? [
        { row: 5, col: 1 }, { row: 5, col: 2 }, { row: 5, col: 3 }, { row: 5, col: 4 },
        { row: 4, col: 1 }, { row: 4, col: 2 }, { row: 4, col: 3 }, { row: 4, col: 4 }
      ]
    : [
        { row: 0, col: 4 }, { row: 0, col: 3 }, { row: 0, col: 2 }, { row: 0, col: 1 },
        { row: 1, col: 4 }, { row: 1, col: 3 }, { row: 1, col: 2 }, { row: 1, col: 1 }
      ];
}

function validateGhostSetup(kinds) {
  if (!Array.isArray(kinds) || kinds.length !== 8) {
    return { ok: false, message: "青4体、赤4体を配置してください。" };
  }
  const normalized = kinds.map((kind) => String(kind));
  if (normalized.some((kind) => kind !== "good" && kind !== "bad")) {
    return { ok: false, message: "青か赤を選んでください。" };
  }
  if (normalized.filter((kind) => kind === "good").length !== 4) {
    return { ok: false, message: "青は4体にしてください。" };
  }
  if (normalized.filter((kind) => kind === "bad").length !== 4) {
    return { ok: false, message: "赤は4体にしてください。" };
  }
  return { ok: true, value: normalized };
}

function buildGhostPieces(room) {
  room.ghost = makeGhostState();
  for (const [playerIndex, player] of room.players.entries()) {
    const slots = startSlotsForIndex(playerIndex);
    player.ghostSetup.forEach((kind, slotIndex) => {
      room.ghost.pieces.push({
        id: `${playerIndex}-${slotIndex}-${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`,
        ownerId: player.id,
        ownerIndex: playerIndex,
        kind,
        row: slots[slotIndex].row,
        col: slots[slotIndex].col,
        alive: true
      });
    });
  }
}

function pieceAt(room, row, col) {
  return room.ghost.pieces.find((piece) => piece.alive && piece.row === row && piece.col === col) || null;
}

function publicGhostState(room, player) {
  const myIndex = getPlayerIndex(room, player);
  const opponent = getOpponent(room, player);
  const alivePieces = room.ghost.pieces.filter((piece) => piece.alive);
  const captured = room.ghost.pieces.filter((piece) => !piece.alive && !piece.escaped);
  const countsFor = (ownerId) => ({
    goodAlive: room.ghost.pieces.filter((piece) => piece.ownerId === ownerId && piece.kind === "good" && piece.alive).length,
    badAlive: room.ghost.pieces.filter((piece) => piece.ownerId === ownerId && piece.kind === "bad" && piece.alive).length,
    goodCaptured: room.ghost.pieces.filter((piece) => piece.ownerId === ownerId && piece.kind === "good" && !piece.alive && !piece.escaped).length,
    badCaptured: room.ghost.pieces.filter((piece) => piece.ownerId === ownerId && piece.kind === "bad" && !piece.alive && !piece.escaped).length
  });

  return {
    boardSize: BOARD_SIZE,
    myIndex,
    myStartSlots: startSlotsForIndex(myIndex),
    pieces: alivePieces.map((piece) => ({
      id: piece.id,
      owner: piece.ownerId === player.id ? "me" : "opponent",
      ownerIndex: piece.ownerIndex,
      kind: piece.ownerId === player.id ? piece.kind : "unknown",
      row: piece.row,
      col: piece.col
    })),
    captured: captured.map((piece) => ({
      owner: piece.ownerId === player.id ? "me" : "opponent",
      kind: piece.kind
    })),
    counts: {
      me: countsFor(player.id),
      opponent: opponent ? countsFor(opponent.id) : null
    },
    log: room.ghost.log.slice(-8).map((entry) => ({
      side: entry.playerId === player.id ? "me" : "opponent",
      action: entry.action,
      pieceKind: entry.playerId === player.id ? entry.pieceKind : "unknown",
      capturedKind: entry.capturedKind || null,
      createdAt: entry.createdAt
    })),
    winReason: room.ghost.winReason
  };
}

function isExitMove(piece, to) {
  if (piece.kind !== "good") {
    return false;
  }
  if (piece.ownerIndex === 0) {
    return piece.row === 0 && (piece.col === 0 || piece.col === 5) && to.row === -1 && to.col === piece.col;
  }
  return piece.row === 5 && (piece.col === 0 || piece.col === 5) && to.row === 6 && to.col === piece.col;
}

function inBoard(row, col) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function setGhostWinner(room, winnerId, reason) {
  room.status = "ended";
  room.winnerId = winnerId;
  room.ghost.winReason = reason;
  room.turnStartedAt = null;
  room.turnDeadlineAt = null;
  clearTurnTimer(room);
}

function evaluateGhostWin(room, movingPlayer, capturedPiece, escapedPiece) {
  const opponent = getOpponent(room, movingPlayer);
  if (!opponent) {
    return;
  }
  if (escapedPiece && escapedPiece.ownerId === movingPlayer.id && escapedPiece.kind === "good") {
    setGhostWinner(room, movingPlayer.id, "escape");
    return;
  }
  const opponentGoodAlive = room.ghost.pieces.filter((piece) => piece.ownerId === opponent.id && piece.kind === "good" && piece.alive).length;
  if (opponentGoodAlive === 0) {
    setGhostWinner(room, movingPlayer.id, "capture-good");
    return;
  }
  for (const owner of room.players) {
    const badAlive = room.ghost.pieces.filter((piece) => piece.ownerId === owner.id && piece.kind === "bad" && piece.alive).length;
    if (badAlive === 0) {
      setGhostWinner(room, owner.id, "own-bad-captured");
      return;
    }
  }
}

function scheduleTurnTimer(room) {
  clearTurnTimer(room);
  if (room.status !== "playing" || !room.turnDeadlineAt) {
    return;
  }
  const delay = Math.max(0, room.turnDeadlineAt - Date.now());
  room.turnTimer = setTimeout(() => expireCurrentTurn(room), delay + 25);
}

function startTurn(room, turnIndex) {
  room.turnIndex = turnIndex;
  room.turnStartedAt = Date.now();
  room.turnDeadlineAt = room.turnStartedAt + room.timeLimitSeconds * 1000;
  scheduleTurnTimer(room);
}

function advanceTurn(room) {
  startTurn(room, room.turnIndex === 0 ? 1 : 0);
}

function expireCurrentTurn(room) {
  if (rooms.get(room.roomKey) !== room || room.status !== "playing") {
    return false;
  }
  if (!room.turnDeadlineAt || Date.now() < room.turnDeadlineAt) {
    scheduleTurnTimer(room);
    return false;
  }

  const currentPlayer = room.players[room.turnIndex];
  if (!currentPlayer) {
    clearTurnTimer(room);
    return false;
  }

  if (room.gameType === "ghost") {
    room.ghost.log.push({
      playerId: currentPlayer.id,
      action: "timeout",
      pieceKind: "unknown",
      createdAt: Date.now()
    });
  } else {
    room.guesses.push({
      playerId: currentPlayer.id,
      nickname: currentPlayer.nickname,
      value: null,
      hits: null,
      blows: null,
      skipped: true,
      reason: "timeout",
      createdAt: Date.now()
    });
  }
  advanceTurn(room);
  broadcastRoom(room);
  return true;
}

function expireTurnIfNeeded(room) {
  if (room.status !== "playing" || !room.turnDeadlineAt || Date.now() < room.turnDeadlineAt) {
    return false;
  }
  return expireCurrentTurn(room);
}

function send(socket, payload) {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function getOpponent(room, player) {
  return room.players.find((candidate) => candidate.id !== player.id) || null;
}

function publicPlayer(player, options = {}) {
  if (!player) {
    return null;
  }
  const ready = options.gameType === "ghost" ? Boolean(player.ghostSetup) : Boolean(player.secret);
  return {
    nickname: player.nickname,
    connected: player.connected,
    ready,
    rematch: Boolean(player.rematch),
    secret: options.gameType === "hitblow" && options.revealSecret ? player.secret : null
  };
}

function stateFor(room, player) {
  const opponent = getOpponent(room, player);
  const turnPlayer = room.status === "playing" ? room.players[room.turnIndex] : null;
  const state = {
    type: "state",
    gameType: room.gameType,
    serverNow: Date.now(),
    status: room.status,
    rules: {
      length: room.length,
      duplicateDigits: false,
      timeLimitSeconds: room.timeLimitSeconds
    },
    turnStartedAt: room.status === "playing" ? room.turnStartedAt : null,
    turnDeadlineAt: room.status === "playing" ? room.turnDeadlineAt : null,
    me: publicPlayer(player, { gameType: room.gameType, revealSecret: true }),
    opponent: publicPlayer(opponent, { gameType: room.gameType }),
    isMyTurn: Boolean(turnPlayer && turnPlayer.id === player.id),
    turn: turnPlayer
      ? {
          side: turnPlayer.id === player.id ? "me" : "opponent",
          nickname: turnPlayer.nickname
        }
      : null,
    winner: room.winnerId
      ? {
          side: room.winnerId === player.id ? "me" : "opponent",
          nickname: (room.players.find((item) => item.id === room.winnerId) || {}).nickname || ""
        }
      : null,
    guesses: room.guesses.map((guess) => ({
      side: guess.playerId === player.id ? "me" : "opponent",
      nickname: guess.nickname,
      value: guess.value,
      hits: guess.hits,
      blows: guess.blows,
      skipped: Boolean(guess.skipped),
      reason: guess.reason || null,
      createdAt: guess.createdAt
    }))
  };
  if (room.gameType === "ghost") {
    state.ghost = publicGhostState(room, player);
  }
  return state;
}

function broadcastRoom(room) {
  room.lastActivity = Date.now();
  for (const player of room.players) {
    send(player.socket, stateFor(room, player));
  }
}

function sendError(socket, message, code = "error") {
  send(socket, { type: "error", code, message });
}

function attachPlayerSocket(room, player, socket, session) {
  if (player.socket && player.socket !== socket) {
    player.socket.close(4000, "reconnected");
  }
  player.socket = socket;
  player.connected = true;
  player.lastSeen = Date.now();
  session.room = room;
  session.player = player;
}

function handleJoin(socket, session, message) {
  const keywordResult = validateKeyword(message.keyword);
  if (!keywordResult.ok) {
    sendError(socket, keywordResult.message, "keyword_invalid");
    return;
  }

  const playerId = String(message.playerId || "").trim();
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(playerId)) {
    sendError(socket, "プレイヤー情報を作り直してください。", "player_invalid");
    return;
  }

  const keywordHash = hashKeyword(keywordResult.value);
  const nickname = String(message.nickname || "").normalize("NFKC").trim().slice(0, 16) || "Player";
  const gameType = GAME_TYPES.has(message.gameType) ? message.gameType : "hitblow";
  const roomKey = `${gameType}:${keywordHash}`;
  const timeLimitResult = validateTimeLimit(message.timeLimitSeconds || DEFAULT_TURN_TIME_LIMIT);
  if (!timeLimitResult.ok) {
    sendError(socket, timeLimitResult.message, "time_limit_invalid");
    return;
  }
  let room = rooms.get(roomKey);

  if (room && !room.players.some((candidate) => candidate.connected)) {
    deleteRoom(room);
    room = null;
  }

  if (room && room.status === "waiting" && room.players.length === 1 && !room.players[0].connected) {
    deleteRoom(room);
    room = null;
  }

  if (!room) {
    room = makeRoom(roomKey, keywordHash, gameType, timeLimitResult.value);
    rooms.set(roomKey, room);
  }

  let player = room.players.find((candidate) => candidate.id === playerId);
  if (!player) {
    if (room.players.length >= 2) {
      sendError(socket, "このキーワードはすでに対戦中です。", "room_full");
      return;
    }
    player = {
      id: playerId,
      nickname,
      socket: null,
      connected: true,
      secret: null,
      ghostSetup: null,
      rematch: false,
      joinedAt: Date.now(),
      lastSeen: Date.now()
    };
    room.players.push(player);
  } else {
    player.nickname = nickname;
  }

  attachPlayerSocket(room, player, socket, session);

  if (room.players.length === 2 && room.status === "waiting") {
    room.status = "setup";
  }

  broadcastRoom(room);
}

function requireJoined(socket, session) {
  if (!session.room || !session.player) {
    sendError(socket, "先にマッチングしてください。", "not_joined");
    return false;
  }
  return true;
}

function handleSetSecret(socket, session, message) {
  if (!requireJoined(socket, session)) {
    return;
  }
  const { room, player } = session;
  if (room.gameType !== "hitblow") {
    sendError(socket, "この部屋では数字設定は使いません。", "wrong_game");
    return;
  }
  if (room.status !== "setup") {
    sendError(socket, "今は答えを設定できません。", "wrong_phase");
    return;
  }

  const secretResult = validateNumber(message.value, room.length);
  if (!secretResult.ok) {
    sendError(socket, secretResult.message, "secret_invalid");
    return;
  }

  player.secret = secretResult.value;
  player.rematch = false;

  if (room.players.length === 2 && room.players.every((candidate) => candidate.secret)) {
    room.status = "playing";
    startTurn(room, room.startingIndex);
  }

  broadcastRoom(room);
}

function handleGhostSetup(socket, session, message) {
  if (!requireJoined(socket, session)) {
    return;
  }
  const { room, player } = session;
  if (room.gameType !== "ghost") {
    sendError(socket, "この部屋では使えない操作です。", "wrong_game");
    return;
  }
  if (room.status !== "setup") {
    sendError(socket, "今は配置できません。", "wrong_phase");
    return;
  }

  const setupResult = validateGhostSetup(message.kinds);
  if (!setupResult.ok) {
    sendError(socket, setupResult.message, "ghost_setup_invalid");
    return;
  }

  player.ghostSetup = setupResult.value;
  player.rematch = false;

  if (room.players.length === 2 && room.players.every((candidate) => candidate.ghostSetup)) {
    buildGhostPieces(room);
    room.status = "playing";
    startTurn(room, room.startingIndex);
  }

  broadcastRoom(room);
}

function handleGhostMove(socket, session, message) {
  if (!requireJoined(socket, session)) {
    return;
  }
  const { room, player } = session;
  if (room.gameType !== "ghost") {
    sendError(socket, "この部屋では使えない操作です。", "wrong_game");
    return;
  }
  expireTurnIfNeeded(room);
  if (room.status !== "playing") {
    sendError(socket, "まだ対戦中ではありません。", "wrong_phase");
    return;
  }

  const currentPlayer = room.players[room.turnIndex];
  if (!currentPlayer || currentPlayer.id !== player.id) {
    sendError(socket, "相手のターンです。", "not_your_turn");
    return;
  }

  const piece = room.ghost.pieces.find((candidate) => candidate.id === message.pieceId && candidate.alive);
  if (!piece || piece.ownerId !== player.id) {
    sendError(socket, "動かすコマを選んでください。", "piece_invalid");
    return;
  }

  const from = { row: piece.row, col: piece.col };
  const to = message.escape
    ? { row: piece.ownerIndex === 0 ? -1 : BOARD_SIZE, col: piece.col }
    : {
        row: Number(message.to && message.to.row),
        col: Number(message.to && message.to.col)
      };

  let capturedPiece = null;
  let action = "move";

  if (isExitMove(piece, to)) {
    piece.alive = false;
    piece.escaped = true;
    action = "escape";
  } else {
    if (!inBoard(to.row, to.col)) {
      sendError(socket, "盤面内に移動してください。", "move_out_of_board");
      return;
    }
    const distance = Math.abs(piece.row - to.row) + Math.abs(piece.col - to.col);
    if (distance !== 1) {
      sendError(socket, "上下左右に1マスだけ動けます。", "move_invalid");
      return;
    }
    const target = pieceAt(room, to.row, to.col);
    if (target && target.ownerId === player.id) {
      sendError(socket, "自分のコマがある場所には動けません。", "move_blocked");
      return;
    }
    if (target) {
      target.alive = false;
      capturedPiece = target;
      action = "capture";
    }
    piece.row = to.row;
    piece.col = to.col;
  }

  room.ghost.moveNumber += 1;
  room.ghost.log.push({
    playerId: player.id,
    action,
    pieceKind: piece.kind,
    capturedKind: capturedPiece ? capturedPiece.kind : null,
    from,
    to,
    createdAt: Date.now()
  });

  evaluateGhostWin(room, player, capturedPiece, action === "escape" ? piece : null);
  if (room.status === "playing") {
    advanceTurn(room);
  }

  broadcastRoom(room);
}

function handleGuess(socket, session, message) {
  if (!requireJoined(socket, session)) {
    return;
  }
  const { room, player } = session;
  if (room.gameType !== "hitblow") {
    sendError(socket, "この部屋では数字予想は使いません。", "wrong_game");
    return;
  }
  expireTurnIfNeeded(room);
  if (room.status !== "playing") {
    sendError(socket, "まだ対戦中ではありません。", "wrong_phase");
    return;
  }

  const currentPlayer = room.players[room.turnIndex];
  if (!currentPlayer || currentPlayer.id !== player.id) {
    sendError(socket, "相手のターンです。", "not_your_turn");
    return;
  }

  const opponent = getOpponent(room, player);
  if (!opponent || !opponent.secret) {
    sendError(socket, "相手の準備が完了していません。", "opponent_not_ready");
    return;
  }

  const guessResult = validateNumber(message.value, room.length);
  if (!guessResult.ok) {
    sendError(socket, guessResult.message, "guess_invalid");
    return;
  }

  const result = judgeGuess(guessResult.value, opponent.secret);
  room.guesses.push({
    playerId: player.id,
    nickname: player.nickname,
    value: guessResult.value,
    hits: result.hits,
    blows: result.blows,
    createdAt: Date.now()
  });

  if (result.hits === room.length) {
    room.status = "ended";
    room.winnerId = player.id;
    room.turnStartedAt = null;
    room.turnDeadlineAt = null;
    clearTurnTimer(room);
  } else {
    advanceTurn(room);
  }

  broadcastRoom(room);
}

function handleRematch(socket, session) {
  if (!requireJoined(socket, session)) {
    return;
  }
  const { room, player } = session;
  if (room.status !== "ended") {
    sendError(socket, "まだ再戦できません。", "wrong_phase");
    return;
  }

  player.rematch = true;
  if (room.players.length === 2 && room.players.every((candidate) => candidate.rematch)) {
    room.status = "setup";
    room.guesses = [];
    room.ghost = makeGhostState();
    room.winnerId = null;
    room.turnStartedAt = null;
    room.turnDeadlineAt = null;
    clearTurnTimer(room);
    room.startingIndex = room.startingIndex === 0 ? 1 : 0;
    room.turnIndex = room.startingIndex;
    for (const candidate of room.players) {
      candidate.secret = null;
      candidate.ghostSetup = null;
      candidate.rematch = false;
    }
  }

  broadcastRoom(room);
}

function removePlayerFromRoom(room, player) {
  const index = room.players.findIndex((candidate) => candidate.id === player.id);
  if (index >= 0) {
    room.players.splice(index, 1);
  }
  if (room.players.length === 0) {
    deleteRoom(room);
  } else if (room.status !== "playing") {
    room.status = "waiting";
    room.guesses = [];
    room.ghost = makeGhostState();
    room.winnerId = null;
    room.turnStartedAt = null;
    room.turnDeadlineAt = null;
    clearTurnTimer(room);
    room.players[0].secret = null;
    room.players[0].ghostSetup = null;
    room.players[0].rematch = false;
    broadcastRoom(room);
  } else {
    broadcastRoom(room);
  }
}

function handleLeave(socket, session) {
  if (!requireJoined(socket, session)) {
    return;
  }
  const { room, player } = session;
  removePlayerFromRoom(room, player);
  session.room = null;
  session.player = null;
  send(socket, { type: "left" });
}

function handleDisconnect(session, socket) {
  if (!session.room || !session.player) {
    return;
  }
  const { room, player } = session;
  if (player.socket !== socket) {
    return;
  }
  player.socket = null;
  player.connected = false;
  player.lastSeen = Date.now();
  broadcastRoom(room);
}

function handleSocketMessage(socket, session, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch (error) {
    sendError(socket, "通信データを読み取れませんでした。", "bad_json");
    return;
  }

  switch (message.type) {
    case "join":
      handleJoin(socket, session, message);
      break;
    case "set-secret":
      handleSetSecret(socket, session, message);
      break;
    case "ghost-setup":
      handleGhostSetup(socket, session, message);
      break;
    case "ghost-move":
      handleGhostMove(socket, session, message);
      break;
    case "guess":
      handleGuess(socket, session, message);
      break;
    case "rematch":
      handleRematch(socket, session);
      break;
    case "leave":
      handleLeave(socket, session);
      break;
    default:
      sendError(socket, "未対応の操作です。", "unknown_type");
      break;
  }
}

function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (requestUrl.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const cacheControl = pathname === "/index.html" || pathname === "/sw.js"
      ? "no-cache"
      : "public, max-age=60";
    response.writeHead(200, {
      "cache-control": cacheControl,
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream"
    });
    response.end(data);
  });
}

const server = http.createServer(serveStatic);
const webSocketServer = new WebSocketServer({ server, maxPayload: 4096 });

webSocketServer.on("connection", (socket) => {
  const session = { room: null, player: null };
  socket.isAlive = true;

  socket.on("pong", () => {
    socket.isAlive = true;
  });
  socket.on("message", (raw) => handleSocketMessage(socket, session, raw));
  socket.on("close", () => handleDisconnect(session, socket));
});

setInterval(() => {
  for (const socket of webSocketServer.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30000);

setInterval(() => {
  const now = Date.now();
  for (const [keywordHash, room] of rooms.entries()) {
    const hasConnectedPlayer = room.players.some((player) => player.connected);
    const ttl = room.status === "waiting" ? WAITING_TTL_MS : ROOM_TTL_MS;
    if (!hasConnectedPlayer && now - room.lastActivity > ttl) {
      deleteRoom(room);
    }
  }
}, 60000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Hit and Blow server running at http://localhost:${PORT}`);
});
