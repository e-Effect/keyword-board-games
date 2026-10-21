const root = document.querySelector("#commentator");
const statusNames = { waiting: "相手待ち", setup: "準備中", playing: "対戦中", ended: "終了" };
let rooms = [];
let selectedId = null;
let gameFilter = "all";
let phaseFilter = "active";
let loggedIn = false;
let pollTimer;
let lastSnapshot = "";
let clockOffset = 0;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const gameName = (room) => room.gameType === "ghost" ? "ゴースト" : "ヒット＆ブロー";
const art = (kind) => `<span class="ghost-art ${kind}" aria-hidden="true"></span>`;
const playerName = (room, index) => room.players.find((p) => p.index === index)?.nickname || "相手待ち";

async function api(path, body) {
  const response = await fetch(`/commentator/api/${path}`, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.message || "接続できませんでした。");
    error.status = response.status;
    throw error;
  }
  return data;
}

function showLogin(configured = true, message = "") {
  clearTimeout(pollTimer);
  loggedIn = false;
  rooms = [];
  selectedId = null;
  lastSnapshot = "";
  root.removeAttribute("aria-busy");
  root.innerHTML = `<section class="login"><h1>実況者ログイン</h1><form id="loginForm">
    <label>実況用パスワード<input id="password" name="password" type="password" autocomplete="current-password" required minlength="4" maxlength="256" ${configured ? "" : "disabled"}></label>
    <button type="submit" ${configured ? "" : "disabled"}>ログイン</button><p id="loginNotice" class="notice" role="status">${escapeHtml(message || (configured ? "" : "実況用パスワードはまだ設定されていません。"))}</p>
  </form></section>`;
  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("button");
    const input = document.querySelector("#password");
    button.disabled = true;
    try {
      await api("login", { password: input.value });
      input.value = "";
      startDashboard();
    } catch (error) {
      input.value = "";
      document.querySelector("#loginNotice").textContent = error.message;
      button.disabled = false;
    }
  });
}

function visibleRooms() {
  return rooms.filter((room) => (gameFilter === "all" || room.gameType === gameFilter) &&
    (phaseFilter === "all" || (phaseFilter === "active" ? room.status !== "ended" : room.status === phaseFilter)))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function renderRoomList() {
  const list = visibleRooms();
  document.querySelector("#roomCount").textContent = `${list.length} ルーム`;
  document.querySelector("#roomList").innerHTML = list.length ? list.map((room) => `
    <button class="room-item ${selectedId === room.id ? "selected" : ""}" type="button" data-room="${room.id}" aria-pressed="${selectedId === room.id}">
      <span class="room-item-top">${gameName(room)}<span class="status ${room.status}">${statusNames[room.status]}</span></span>
      <strong>${escapeHtml(room.players.map((p) => p.nickname).join(" vs "))}</strong><small>#${room.id.slice(0, 8)}</small>
    </button>`).join("") : `<p class="empty">対象の部屋はありません</p>`;
  document.querySelectorAll("[data-room]").forEach((button) => button.addEventListener("click", () => {
    selectedId = button.dataset.room;
    renderRoomList();
    renderDetail();
  }));
}

function renderHitblow(room, player) {
  const index = player.index;
  const secret = player.secret || "";
  const guesses = room.guesses.filter((guess) => guess.playerIndex === index);
  return `<section class="player-view">${playerHeader(room, player)}
    <div class="secret ${secret ? "" : "pending"}" aria-label="${escapeHtml(player.nickname)}の数字 ${secret || "未決定"}">
      ${Array.from({ length: room.length }, (_, i) => `<b>${secret[i] || "－"}</b>`).join("")}</div>
    <table class="history"><thead><tr><th>予想</th><th>H</th><th>B</th></tr></thead><tbody>
      ${guesses.length ? guesses.map((guess) => `<tr><td>${guess.skipped ? "無回答" : escapeHtml(guess.value)}</td><td>${guess.skipped ? "－" : guess.hits}</td><td>${guess.skipped ? "－" : guess.blows}</td></tr>`).join("") : `<tr><td colspan="3">まだ回答はありません</td></tr>`}
    </tbody></table></section>`;
}

function playerHeader(room, player) {
  const active = room.status === "playing" && room.turnIndex === player.index;
  return `<header class="player-header ${active ? "active" : ""}"><h3>${escapeHtml(player.nickname)}</h3><small>${active ? "手番" : player.connected ? room.status === "playing" ? "待機" : room.status === "ended" ? "終了" : player.ready ? "準備完了" : "入力中" : "接続待ち"}</small></header>`;
}

function renderGhost(room, player) {
  const cells = [];
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      const boardRow = player.index === 0 ? row : 5 - row;
      const boardCol = player.index === 0 ? col : 5 - col;
      const piece = room.pieces.find((p) => p.alive && p.row === boardRow && p.col === boardCol);
      cells.push(`<div class="ghost-cell ${piece?.ownerIndex === player.index ? "own" : ""}" ${piece ? `role="img" aria-label="${escapeHtml(playerName(room, piece.ownerIndex))}の${piece.kind === "good" ? "水色" : "ピンク"}"` : ""}>${piece ? art(piece.kind) : ""}</div>`);
    }
  }
  const caught = (kind) => room.pieces.filter((p) => !p.alive && !p.escaped && p.ownerIndex !== player.index && p.kind === kind).length;
  const lane = (name) => `<div class="exit-lane"><span class="door" aria-hidden="true"></span><span>${escapeHtml(name)}の脱出口</span><span class="door" aria-hidden="true"></span></div>`;
  return `<section class="player-view">${playerHeader(room, player)}<p class="board-opponent">上：${escapeHtml(playerName(room, 1 - player.index))} ／ 下：${escapeHtml(player.nickname)}</p>
    <div class="ghost-field">${lane(player.nickname)}<div class="ghost-board">${cells.join("")}</div>${lane(playerName(room, 1 - player.index))}</div>
    <div class="captures"><span>${art("good")}捕まえた水色 ${caught("good")}/4</span><span>${art("bad")}捕まえたピンク ${caught("bad")}/4</span></div>
    ${room.status === "setup" ? `<p class="board-pending">${player.ready ? "配置決定済み" : "配置はまだ決定されていません"}</p>` : ""}</section>`;
}

function renderDetail() {
  const room = rooms.find((item) => item.id === selectedId);
  const detail = document.querySelector("#detail");
  if (!room) {
    detail.innerHTML = `<p class="empty">${selectedId ? "この部屋は削除されました" : "部屋を選択してください"}</p>`;
    return;
  }
  const winner = room.players.find((p) => p.winner);
  detail.innerHTML = `<header class="detail-header"><div><h2>${gameName(room)} <span class="status ${room.status}">${statusNames[room.status]}</span></h2>
    <p>#${room.id.slice(0, 8)}${room.reconnectDeadlineAt ? " ／ 再接続待ち" : room.finalAnswer ? " ／ 後攻の最終回答" : ""}</p></div><span class="timer" ${room.deadline && room.status !== "ended" ? `data-deadline="${room.deadline}"` : ""}>${room.reconnectDeadlineAt ? "時間停止中" : room.timeLimitSeconds === 0 ? "無制限" : `${room.timeLimitSeconds}秒`}</span></header>
    ${room.status === "ended" ? `<div class="result">${room.result === "draw" ? "Draw" : winner ? `${escapeHtml(winner.nickname)} WIN` : "対戦終了"}</div>` : ""}
    <div class="duel">${room.players.map((player) => room.gameType === "ghost" ? renderGhost(room, player) : renderHitblow(room, player)).join("")}${room.players.length < 2 ? `<p class="empty">相手の入室待ち</p>` : ""}</div>`;
  updateTimers();
}

function updateTimers() {
  document.querySelectorAll("[data-deadline]").forEach((element) => {
    element.textContent = `${Math.max(0, Math.ceil((Number(element.dataset.deadline) - Date.now() - clockOffset) / 1000))}秒`;
  });
}

async function poll() {
  clearTimeout(pollTimer);
  if (!loggedIn) return;
  try {
    const snapshot = await api("rooms");
    if (!loggedIn) return;
    clockOffset = snapshot.serverNow - Date.now();
    document.querySelector("#connection").textContent = "接続済み";
    document.querySelector("#connection").className = "connection";
    const serialized = JSON.stringify(snapshot.rooms);
    if (serialized !== lastSnapshot) {
      lastSnapshot = serialized;
      rooms = snapshot.rooms;
      if (!selectedId) selectedId = visibleRooms()[0]?.id || null;
      const previousFocus = document.activeElement?.dataset.room;
      renderRoomList();
      renderDetail();
      if (previousFocus) [...document.querySelectorAll("[data-room]")].find((e) => e.dataset.room === previousFocus)?.focus({ preventScroll: true });
    }
  } catch (error) {
    if (error.status === 401) { showLogin(true, "もう一度ログインしてください。"); return; }
    const connection = document.querySelector("#connection");
    if (connection) { connection.textContent = "再接続中"; connection.className = "connection offline"; }
  }
  if (loggedIn) pollTimer = setTimeout(poll, 1000);
}

function startDashboard() {
  loggedIn = true;
  root.removeAttribute("aria-busy");
  root.innerHTML = `<header class="topbar"><h1>実況ルーム</h1><div class="topbar-actions"><span id="connection" class="connection">接続中</span><button id="logout" type="button">ログアウト</button></div></header>
    <div class="layout"><aside class="sidebar"><p id="roomCount" class="room-count">0 ルーム</p><div class="filters">
      <select id="gameFilter" aria-label="ゲームで絞り込み"><option value="all">すべてのゲーム</option><option value="hitblow">ヒット＆ブロー</option><option value="ghost">ゴースト</option></select>
      <select id="phaseFilter" aria-label="進行状況で絞り込み"><option value="active">進行中すべて</option><option value="playing">対戦中</option><option value="setup">準備中</option><option value="waiting">相手待ち</option><option value="ended">終了</option><option value="all">すべて</option></select>
    </div><nav id="roomList" class="room-list" aria-label="実況する部屋"></nav></aside><section id="detail" class="detail"><p class="empty">接続中…</p></section></div>`;
  document.querySelector("#gameFilter").value = gameFilter;
  document.querySelector("#phaseFilter").value = phaseFilter;
  for (const id of ["gameFilter", "phaseFilter"]) document.querySelector(`#${id}`).addEventListener("change", () => {
    gameFilter = document.querySelector("#gameFilter").value;
    phaseFilter = document.querySelector("#phaseFilter").value;
    selectedId = visibleRooms()[0]?.id || null;
    renderRoomList(); renderDetail();
  });
  document.querySelector("#logout").addEventListener("click", async () => {
    const button = document.querySelector("#logout"); button.disabled = true;
    try { await api("logout", {}); showLogin(); } catch { button.disabled = false; }
  });
  poll();
}

api("session").then((session) => session.authenticated ? startDashboard() : showLogin(session.configured))
  .catch(() => showLogin(true, "接続できません。ページを開き直してください。"));
setInterval(updateTimers, 250);
