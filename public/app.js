const PLAYER_ID_KEY = "hitblow.playerId";
const NICKNAME_KEY = "hitblow.nickname";
const TIME_LIMIT_KEY = "hitblow.timeLimitSeconds";
const GAME_TYPE_KEY = "hitblow.gameType";
const MATCH_KEY = "games.activeMatch.v1";
const app = document.querySelector("#app");
const connection = document.querySelector("#connection");
const toast = document.querySelector("#toast");
const DEFAULT_GHOST_SETUP = ["good", "good", "good", "good", "bad", "bad", "bad", "bad"];

let socket = null;
let state = null;
let joinDraft = {
  nickname: localStorage.getItem(NICKNAME_KEY) || "",
  keyword: "",
  timeLimitSeconds: Number(localStorage.getItem(TIME_LIMIT_KEY) || 30),
  length: 3,
  gameType: localStorage.getItem(GAME_TYPE_KEY) || "hitblow"
};
let secretDigits = [];
let guessDigits = [];
let ghostSetupKinds = [...DEFAULT_GHOST_SETUP];
let selectedGhostPieceId = null;
let ghostSetupDrag = null;
let ghostSwapMotion = null;
let ghostKeyboardSlot = null;
let ghostFeedback = null;
let ghostFeedbackTimer = null;
let lastToastTimer = null;
let reconnectTimer = null;
let joinMode = null;
let selectedGame = null;
let joining = false;
let resuming = false;
let superseded = false;
let connectionStatus = "connecting";
let lastAnimatedGhostMove = null;
let localRemainingSeconds = null;

function timeLabel(seconds) {
  return seconds === 0 ? "無制限" : `${seconds}秒`;
}

function makePlayerId() {
  const existing = localStorage.getItem(PLAYER_ID_KEY);
  if (existing) {
    return existing;
  }
  const id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 80);
  localStorage.setItem(PLAYER_ID_KEY, id);
  return id;
}

const playerId = makePlayerId();

function savedMatch(storage) {
  try {
    const value = JSON.parse(storage.getItem(MATCH_KEY));
    return value?.playerId === playerId && ["hitblow", "ghost"].includes(value.gameType) && typeof value.keyword === "string" && value.keyword.length > 0 ? value : null;
  } catch { return null; }
}

function saveMatch() {
  const value = JSON.stringify({ playerId, nickname: state.me.nickname, keyword: joinDraft.keyword, gameType: state.gameType, length: state.rules.length, timeLimitSeconds: state.rules.timeLimitSeconds });
  try { sessionStorage.setItem(MATCH_KEY, value); localStorage.setItem(MATCH_KEY, value); } catch {}
}

function forgetMatch() {
  try {
    sessionStorage.removeItem(MATCH_KEY);
    const value = savedMatch(localStorage);
    if (value?.gameType === joinDraft.gameType && value?.keyword === joinDraft.keyword) localStorage.removeItem(MATCH_KEY);
  } catch {}
}

function resumeMatch(value) {
  joinDraft = { ...joinDraft, ...value };
  selectedGame = value.gameType;
  resuming = true;
  superseded = false;
  if (socket?.readyState === WebSocket.OPEN) sendJoin();
  else if (!socket || socket.readyState !== WebSocket.CONNECTING) connect();
  render();
}

function canPlay() {
  return state?.status === "playing" && !state.reconnectDeadlineAt && connectionStatus === "ready";
}

function matchStatusMarkup() {
  if (!state) return "";
  const mine = escapeHtml(state.me.nickname);
  const other = escapeHtml(state.opponent?.nickname || state.answers?.opponent?.nickname || "相手待ち");
  return `<div class="match-identities"><span><i class="status-dot ${connectionStatus === "ready" ? "online" : ""}"></i>${mine}<small>あなた</small></span><span><i class="status-dot ${state.opponent?.connected ? "online" : ""}"></i>${other}<small>相手</small></span></div>`;
}

function updateConnectionNotice() {
  const notice = document.querySelector("#matchConnectionNotice");
  if (!notice || !state) return;
  let text = "";
  if (superseded) text = "別の画面で対戦が開かれました。この画面は接続を停止しています。";
  else if (connectionStatus !== "ready") text = "通信が切れました。再接続しています…";
  else if (state.reconnectDeadlineAt) {
    const remaining = Math.max(0, Math.ceil((state.reconnectDeadlineAt - state.serverNow - (Date.now() - state.receivedAt)) / 1000));
    text = `相手の再接続待ち · あと${remaining}秒（対戦時間は停止中）`;
  }
  notice.hidden = !text || state.status === "ended";
  notice.textContent = text;
}

function matchNoticeMarkup() {
  return `<p id="matchConnectionNotice" class="match-notice" role="status" hidden></p>`;
}

function openResignDialog() {
  if (document.querySelector("#resignDialog")) return;
  const dialog = document.createElement("dialog");
  dialog.id = "resignDialog";
  dialog.className = "resign-dialog";
  dialog.setAttribute("aria-labelledby", "resignTitle");
  const connected = socket?.readyState === WebSocket.OPEN;
  dialog.innerHTML = `<h2 id="resignTitle">${connected ? "投了しますか？" : "対戦を終了しますか？"}</h2><p>${connected ? "この対戦はあなたの負けになります。" : "通信が切れているため、再接続の猶予が終わると敗北になります。"}</p><div><button id="cancelResign" class="button secondary" type="button">続ける</button><button id="confirmResign" class="button" type="button">${connected ? "投了する" : "メインに戻る"}</button></div>`;
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.querySelector("#cancelResign").addEventListener("click", close);
  dialog.querySelector("#confirmResign").addEventListener("click", () => {
    if (socket?.readyState === WebSocket.OPEN) send({ type: "resign" });
    else {
      forgetMatch(); state = null; resuming = false; selectedGame = null; joinMode = null; superseded = false;
      render();
      if (!socket || socket.readyState === WebSocket.CLOSED) connect();
    }
    close();
  });
  dialog.addEventListener("cancel", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

document.addEventListener("click", (event) => { if (event.target.closest("[data-resign]")) openResignDialog(); });

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function countReadyPlayers() {
  return [state.me, state.opponent].filter((player) => player && player.ready).length;
}

function countConnectedPlayers() {
  return [state.me, state.opponent].filter((player) => player && player.connected).length;
}

function currentPhaseIndex() {
  if (!state) {
    return 0;
  }
  if (state.status === "waiting") {
    return 0;
  }
  if (state.status === "setup") {
    return 1;
  }
  if (state.status === "playing") {
    return 2;
  }
  return 3;
}

function renderPhaseSteps() {
  const current = currentPhaseIndex();
  const selectedGameType = state ? state.gameType : joinDraft.gameType;
  const steps = selectedGameType === "ghost"
    ? ["入室", "配置", "対戦", "結果"]
    : ["入室", "答え", "対戦", "結果"];
  return `
    <div class="phase-steps" aria-label="進行状況">
      ${steps.map((label, index) => {
        const className = index < current ? "done" : index === current ? "current" : "";
        return `<div class="phase-step ${className}"><span>${index + 1}</span>${label}</div>`;
      }).join("")}
    </div>
  `;
}

function renderMatchStats() {
  const playerCount = state.opponent ? 2 : 1;
  const readyCount = countReadyPlayers();
  return `
    <div class="stat-line">
      <span><b>人数</b>${playerCount}/2</span>
      <span><b>準備</b>${readyCount}/2</span>
      <span><b>接続</b>${countConnectedPlayers()}/2</span>
    </div>
  `;
}

function getRemainingSeconds() {
  if (state?.status === "playing" && state.reconnectDeadlineAt) return state.pausedRemainingMs === null ? null : Math.ceil(state.pausedRemainingMs / 1000);
  if (state?.status === "playing" && connectionStatus !== "ready") return localRemainingSeconds;
  const deadline = state && (state.status === "setup" ? state.setupDeadlineAt : state.turnDeadlineAt);
  if (!state || !deadline || !state.serverNow) {
    return null;
  }
  const elapsed = Date.now() - (state.receivedAt || Date.now());
  const estimatedServerNow = state.serverNow + elapsed;
  return Math.max(0, Math.ceil((deadline - estimatedServerNow) / 1000));
}

function updateCountdown() {
  updateConnectionNotice();
  const timers = document.querySelectorAll(".turn-timer");
  if (!timers.length || !state) {
    return;
  }
  const remaining = getRemainingSeconds();
  timers.forEach((timer) => {
    const value = remaining === null ? state.rules.timeLimitSeconds : remaining;
    timer.textContent = remaining === null && value === 0
      ? timer.dataset.timerFormat === "short" ? "∞" : "無制限"
      : timer.dataset.timerFormat === "short" ? String(value) : `${value}秒`;
    timer.classList.toggle("unlimited", remaining === null && value === 0);
    timer.classList.toggle("low", remaining !== null && remaining <= 5);
  });
}

function renderMySecret() {
  if (!state || !state.me || !state.me.secret) {
    return "";
  }
  return `
    <div class="secret-badge">
      <span>自分の答え</span>
      <b>${escapeHtml(state.me.secret)}</b>
    </div>
  `;
}

async function copyCurrentUrl() {
  try {
    await navigator.clipboard.writeText(location.href);
    showToast("URLをコピーしました。");
  } catch (error) {
    showToast("ブラウザのURLを相手に送ってください。");
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(lastToastTimer);
  lastToastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function setConnection(status) {
  if (status !== "ready" && connectionStatus === "ready" && state?.status === "playing") localRemainingSeconds = getRemainingSeconds();
  connectionStatus = status;
  connection.className = "connection";
  if (status === "ready") {
    connection.textContent = "接続済み";
    connection.classList.add("ready");
  } else if (status === "offline") {
    connection.textContent = "未接続";
    connection.classList.add("offline");
  } else {
    connection.textContent = "接続中";
  }
  updateConnectionNotice();
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showToast("サーバーに接続していません。");
    return;
  }
  socket.send(JSON.stringify(payload));
}

function connect() {
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}`);
  setConnection("connecting");

  socket.addEventListener("open", () => {
    setConnection("ready");
    if ((state || resuming) && joinDraft.keyword) {
      sendJoin();
    }
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state") {
      joining = false;
      resuming = false;
      updateGhostFeedback(message);
      if (message.status === "setup" && (!state || state.status !== "setup")) {
        secretDigits = [];
        guessDigits = [];
        ghostSetupKinds = [...DEFAULT_GHOST_SETUP];
      }
      if (message.gameType !== "ghost" || message.status !== "playing" || !message.isMyTurn) {
        selectedGhostPieceId = null;
      }
      state = message;
      if (state.gameType === "ghost" && state.status === "setup" && state.me.ready && state.ghost.mySetup) ghostSetupKinds = [...state.ghost.mySetup];
      if (state.status === "ended") { const dialog = document.querySelector("#resignDialog"); if (dialog) { dialog.close(); dialog.remove(); } }
      state.receivedAt = Date.now();
      saveMatch();
      render();
      updateCountdown();
      return;
    }
    if (message.type === "error") {
      joining = false;
      if (message.code === "room_missing" && (state || resuming)) {
        forgetMatch();
        state = null;
        joinMode = null;
        selectedGame = null;
        resuming = false;
      }
      if (!state) render();
      showToast(message.message);
      return;
    }
    if (message.type === "left") {
      forgetMatch();
      state = null;
      joinMode = null;
      selectedGame = null;
      joining = false;
      joinDraft.keyword = "";
      secretDigits = [];
      guessDigits = [];
      ghostSetupKinds = [...DEFAULT_GHOST_SETUP];
      selectedGhostPieceId = null;
      render();
    }
  });

  socket.addEventListener("close", (event) => {
    if (event.code === 4000) {
      superseded = true;
      setConnection("offline");
      if (state) render();
      return;
    }
    setConnection("offline");
    if (state) render();
    if (!state && joining) {
      joining = false;
      render();
    }
    reconnectTimer = setTimeout(connect, 1400);
  });

  socket.addEventListener("error", () => {
    setConnection("offline");
  });
}

function sendJoin() {
  send({
    type: "join",
    playerId,
    nickname: joinDraft.nickname,
    action: state || resuming ? "resume" : joinMode,
    length: joinDraft.length,
    keyword: joinDraft.keyword,
    timeLimitSeconds: joinDraft.timeLimitSeconds,
    gameType: joinDraft.gameType
  });
}

function ghostArt(kind = "unknown") {
  return `<span class="ghost-art ${kind}" aria-hidden="true"></span>`;
}

function ghostRulesButton() {
  return `<button class="rules-button" type="button" data-ghost-rules title="ルール"><span aria-hidden="true">?</span>ルール</button>`;
}

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-ghost-rules]")) return;
  let dialog = document.querySelector("#ghostRules");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "ghostRules";
    dialog.className = "ghost-rules";
    dialog.setAttribute("aria-labelledby", "ghostRulesTitle");
    dialog.innerHTML = `
      <header><h2 id="ghostRulesTitle">ゴーストのルール</h2><button class="rules-close" type="button" aria-label="ルールを閉じる">×</button></header>
      <section><h3>水色4体・ピンク4体</h3><p>自分のおばけ8体の位置を入れ替えて配置します。相手のおばけの色は、捕まえるまでわかりません。</p></section>
      <section><h3>1ターンに1体、1マス</h3><p>交互に、おばけを上下左右のどれかへ1マス動かします。斜めには動けません。相手のおばけがいるマスへ動くと捕まえられます。</p></section>
      <section><h3>勝ち方は3つ</h3><ul><li>相手の水色を4体すべて捕まえる。</li><li>自分のピンクを4体すべて相手に取らせる。</li><li>自分の水色を1体、相手側の左右どちらかの脱出口から盤外へ出す。</li></ul></section>
      <section><h3>脱出は角に着いた次の自分のターン</h3><p>上側の左右の角が、あなたの脱出口につながっています。角に着いただけでは勝ちになりません。次の自分のターンにその水色を選び、盤外のドアを押すと脱出です。相手は下側の脱出口を目指します。</p></section>
      <section><h3>ピンクの捕獲に注意</h3><p>相手のピンクを4体すべて捕まえるか、自分の水色を4体すべて取られると負けです。上の個数は、あなたが捕まえた相手のおばけの数です。</p></section>
      <section><h3>制限時間</h3><p>設定した制限時間内に動かなければ、無回答として相手のターンになります。ルールを開いている間も時間は進みます。無制限の部屋では時間切れはありません。</p></section>`;
    dialog.querySelector(".rules-close").addEventListener("click", () => dialog.close());
    document.body.append(dialog);
  }
  if (!dialog.open) dialog.showModal();
});

function renderGamePicker() {
  const previousMatch = savedMatch(localStorage);
  app.innerHTML = `
    <section class="game-picker">
      <h2>ゲームを選ぶ</h2>
      <div class="game-library">
        <button id="chooseHitblow" class="game-cover numbers-cover" type="button">
          <span class="number-art" aria-hidden="true"><i>1</i><i>2</i><i>3</i></span>
          <span class="game-cover-label"><small>HIT &amp; BLOW</small><strong>ヒット＆ブロー</strong><span class="cover-arrow" aria-hidden="true">→</span></span>
        </button>
        <button id="chooseGhost" class="game-cover ghosts-cover" type="button">
          <span class="ghost-pair" aria-hidden="true">${ghostArt("good")}${ghostArt("bad")}</span>
          <span class="game-cover-label"><small>GHOST DUEL</small><strong>ゴースト</strong><span class="cover-arrow" aria-hidden="true">→</span></span>
        </button>
      </div>
      ${previousMatch ? `<button id="resumeMatch" class="button resume-match" type="button">前の対戦に戻る</button>` : ""}
    </section>`;
  document.querySelector("#resumeMatch")?.addEventListener("click", () => resumeMatch(previousMatch));
  for (const [id, game] of [["chooseHitblow", "hitblow"], ["chooseGhost", "ghost"]]) {
    document.querySelector(`#${id}`).addEventListener("click", () => {
      selectedGame = game;
      joinDraft.gameType = game;
      render();
    });
  }
}

function backToGames() {
  selectedGame = null;
  joinMode = null;
  render();
}

function renderTimeOptions() {
  return `
    <fieldset class="time-field">
      <legend>制限時間</legend>
      <div class="time-options">
        ${[15, 30, 45, 60, 0].map((seconds) => `
          <label class="time-option ${joinDraft.timeLimitSeconds === seconds ? "selected" : ""}">
            <input type="radio" name="timeLimitSeconds" value="${seconds}" ${joinDraft.timeLimitSeconds === seconds ? "checked" : ""}>
            <span>${timeLabel(seconds)}</span>
          </label>
        `).join("")}
      </div>
    </fieldset>
  `;
}

function renderJoin() {
  setScreenMode("menu");
  if (!selectedGame) {
    renderGamePicker();
    return;
  }
  if (!joinMode) {
    app.innerHTML = `
      <section class="panel stack">
        <h2>対戦する</h2>
        ${selectedGame === "ghost" ? ghostRulesButton() : ""}
        <div class="room-choices">
          <button id="createRoom" class="button" type="button">部屋を作る</button>
          <button id="joinRoom" class="button secondary" type="button">入室する</button>
        </div>
        <button id="backGames" class="text-back" type="button">← ゲーム選択に戻る</button>
      </section>`;
    document.querySelector("#createRoom").addEventListener("click", () => { joinMode = "create"; render(); });
    document.querySelector("#joinRoom").addEventListener("click", () => { joinMode = "join"; render(); });
    document.querySelector("#backGames").addEventListener("click", backToGames);
    return;
  }
  app.innerHTML = `
    <section class="panel stack">
      <div>
        <h2>${joinMode === "create" ? "部屋を作る" : "入室する"}</h2>
      </div>
      ${renderPhaseSteps()}
      <form id="joinForm" class="stack">
        <label>
          ニックネーム
          <input id="nickname" name="nickname" maxlength="16" autocomplete="nickname" value="${escapeHtml(joinDraft.nickname)}" placeholder="名前">
        </label>
        <label>
          キーワード
          <input id="keyword" name="keyword" minlength="4" maxlength="40" autocomplete="off" value="${escapeHtml(joinDraft.keyword)}" placeholder="4文字以上">
        </label>
        <input type="hidden" name="gameType" value="${joinDraft.gameType}">
        ${joinMode === "create" && joinDraft.gameType === "hitblow" ? `
          <fieldset class="time-field">
            <legend>桁数</legend>
            <div class="game-options">
              ${[3, 4].map((length) => `<label class="game-option ${joinDraft.length === length ? "selected" : ""}">
                <input type="radio" name="length" value="${length}" ${joinDraft.length === length ? "checked" : ""}>
                <span>${length}桁</span></label>`).join("")}
            </div>
          </fieldset>` : ""}
        ${joinMode === "create" ? renderTimeOptions() : ""}
        <button class="button" type="submit" ${joining ? "disabled" : ""}>${joining ? "接続中…" : joinMode === "create" ? "部屋を作る" : "入室する"}</button>
        <button id="backMain" class="button secondary" type="button" ${joining ? "disabled" : ""}>部屋の選択に戻る</button>
        <button id="backGames" class="text-back" type="button" ${joining ? "disabled" : ""}>← ゲーム選択に戻る</button>
      </form>
    </section>
  `;

  document.querySelector("#backMain").addEventListener("click", () => { joinMode = null; render(); });
  document.querySelector("#backGames").addEventListener("click", backToGames);
  for (const name of ["nickname", "keyword"]) {
    document.querySelector(`#${name}`).addEventListener("input", (event) => { joinDraft[name] = event.target.value; });
  }
  document.querySelectorAll('input[name="length"]').forEach((input) => {
    input.addEventListener("change", () => { joinDraft.length = Number(input.value); render(); });
  });
  document.querySelectorAll('input[name="timeLimitSeconds"]').forEach((input) => {
    input.addEventListener("change", () => {
      joinDraft.timeLimitSeconds = Number(input.value);
      document.querySelectorAll(".time-option").forEach((option) => option.classList.remove("selected"));
      input.closest(".time-option").classList.add("selected");
    });
  });
  document.querySelector("#joinForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    joinDraft.nickname = String(form.get("nickname") || "").trim();
    joinDraft.keyword = String(form.get("keyword") || "").trim();
    if (joinMode === "create") {
      joinDraft.timeLimitSeconds = Number(form.get("timeLimitSeconds") ?? 30);
      joinDraft.length = Number(form.get("length") ?? 3);
    }
    joinDraft.gameType = String(form.get("gameType") || "hitblow");
    if ([...joinDraft.keyword.normalize("NFKC")].length < 4) {
      showToast("キーワードは4文字以上にしてください。");
      return;
    }
    localStorage.setItem(NICKNAME_KEY, joinDraft.nickname);
    localStorage.setItem(TIME_LIMIT_KEY, String(joinDraft.timeLimitSeconds));
    localStorage.setItem(GAME_TYPE_KEY, joinDraft.gameType);
    sendJoin();
    joining = Boolean(socket && socket.readyState === WebSocket.OPEN);
    render();
  });
}

function playerStatus(player, emptyText) {
  if (!player) {
    return emptyText;
  }
  if (state.status === "ended") return player.rematch ? "再戦待ち" : "対戦終了";
  if (!player.connected) {
    return "再接続待ち";
  }
  if (state.status === "setup") {
    return player.ready ? "準備完了" : state.gameType === "ghost" ? "配置中" : "答え設定中";
  }
  if (state.status === "ended") {
    return player.rematch ? "再戦待ち" : "対戦終了";
  }
  return "接続中";
}

function renderPlayers() {
  const opponentName = state.opponent ? state.opponent.nickname : "相手";
  return `
    <div class="players">
      <div class="player">
        <b>${escapeHtml(state.me.nickname)}</b>
        <span>${playerStatus(state.me, "")}</span>
      </div>
      <div class="player">
        <b>${escapeHtml(opponentName)}</b>
        <span>${playerStatus(state.opponent, "待機中")}</span>
      </div>
    </div>
  `;
}

function setScreenMode(mode) {
  document.body.dataset.screen = mode;
  document.body.dataset.game = state ? state.gameType : selectedGame || "home";
  document.querySelector(".topbar h1").textContent = !state && !selectedGame ? "ふたりのひみつ" : (state ? state.gameType : selectedGame) === "ghost" ? "ゴースト" : "ヒット＆ブロー";
}

function splitDigits(value) {
  return value ? String(value).split("") : [];
}

function playerName(player, fallback) {
  return escapeHtml(player && player.nickname ? player.nickname : fallback);
}

function playerConnectionText(player) {
  if (!player) {
    return "待機中";
  }
  return player.connected ? "接続中" : "再接続待ち";
}

function renderAvatar() {
  return `<div class="duel-avatar" aria-hidden="true">☺</div>`;
}

function renderDuelCard(value, concealed = false) {
  const content = concealed ? "?" : value || "";
  return `
    <div class="duel-card ${concealed ? "concealed" : ""} ${content ? "" : "blank"}">
      <b>${escapeHtml(content)}</b>
    </div>
  `;
}

function renderCardStrip(values, concealed = false) {
  return `
    <div class="duel-cards">
      ${Array.from({ length: state.rules.length }, (_, index) => {
        const value = values[index] || "";
        return renderDuelCard(value, concealed);
      }).join("")}
    </div>
  `;
}

function renderDuelSide(side) {
  const isMe = side === "me";
  const player = (isMe ? state.me : state.opponent) || state.answers?.[side];
  const status = playerStatus(player, "待機中");
  const selectedDigits = isMe && state.status === "setup" && !state.me.ready
    ? secretDigits
    : splitDigits(player && player.secret);
  const concealed = !isMe && state.status !== "ended";
  const stripValues = concealed ? [] : selectedDigits;

  return `
    <div class="duel-side ${isMe ? "mine" : "opponent"}">
      <div class="player-info">
        ${isMe ? renderAvatar() : ""}
        <div class="player-copy">
          <strong><i class="status-dot ${isMe ? connectionStatus === "ready" ? "online" : "" : player?.connected ? "online" : ""}"></i>${playerName(player, isMe ? "あなた" : "NoName")}</strong>
          <span>${isMe ? "あなた" : "相手"} / ${escapeHtml(status)}</span>
        </div>
        ${isMe ? "" : renderAvatar()}
      </div>
      ${renderCardStrip(stripValues, concealed)}
    </div>
  `;
}

function renderDuelHeader() {
  const setup = state.status === "setup";
  return `
    <div class="duel-top-space"></div>
    <section class="duel-header">
      <div class="turn-tabs">
        <span>${state.isFirst ? "先攻" : "後攻"}</span>
        <span>${state.isFirst ? "後攻" : "先攻"}</span>
      </div>
      ${renderDuelSide("me")}
      ${renderDuelSide("opponent")}
    </section>
    ${setup ? `
      <div class="entry-status-row">
        <span class="mine">${state.me.ready ? "決定済み" : "入力中..."}</span>
        <span class="opponent">${state.opponent && state.opponent.ready ? "決定済み" : "入力中..."}</span>
      </div>
    ` : ""}
    ${renderMatchStats()}
  `;
}

function renderInputDisplay(digits) {
  return `
    <div class="deck-display">
      ${Array.from({ length: state.rules.length }, (_, index) => {
        const value = digits[index] || "-";
        return `<span>${escapeHtml(value)}</span>`;
      }).join("")}
    </div>
  `;
}

function renderDeckKeypad(mode, digits) {
  return `
    <div class="deck-keypad">
      ${Array.from({ length: 10 }, (_, value) => {
        const used = digits.includes(String(value));
        return `<button class="deck-key ${used ? "used" : ""}" type="button" data-${mode}-digit="${value}" ${used ? "disabled" : ""}>${value}</button>`;
      }).join("")}
      <button id="${mode === "secret" ? "submitSecret" : "submitGuess"}" class="deck-key submit" type="button" ${digits.length === state.rules.length ? "" : "disabled"}>決定</button>
      <button class="deck-key clear" type="button" data-${mode}-back aria-label="1桁消す">⌫</button>
      <button class="sr-only" type="button" data-${mode}-clear>クリア</button>
    </div>
  `;
}

function renderInputDeck({ mode, digits, prompt, active = true }) {
  const timerText = getRemainingSeconds() ?? (state.rules.timeLimitSeconds === 0 ? "∞" : state.rules.timeLimitSeconds);
  return `
    <section class="input-deck ${active ? "" : "inactive"}">
      <div class="deck-curve"></div>
      <div class="deck-inner">
        <div class="deck-heading">
          <div class="round-timer turn-timer" data-timer-format="short" aria-label="残り時間">${timerText}</div>
          <p>${prompt}</p>
        </div>
        ${renderInputDisplay(digits)}
        ${active ? renderDeckKeypad(mode, digits) : ""}
      </div>
    </section>
  `;
}

function ghostToView(row, col) {
  if (!state.ghost || state.ghost.myIndex === 0) {
    return { row, col };
  }
  return { row: 5 - row, col: 5 - col };
}

function ghostViewToBoard(row, col) {
  if (!state.ghost || state.ghost.myIndex === 0) {
    return { row, col };
  }
  return { row: 5 - row, col: 5 - col };
}

function ghostPieceAt(row, col) {
  return state.ghost.pieces.find((piece) => piece.row === row && piece.col === col) || null;
}

function ghostKindLabel(kind) {
  if (kind === "good") {
    return "水色";
  }
  if (kind === "bad") {
    return "ピンク";
  }
  return "?";
}

function ghostWinText(reason, won) {
  if (reason === "resigned") return won ? "相手が投了しました" : "あなたが投了しました";
  if (reason === "opponent-left") return won ? "相手が対戦から退出しました" : "対戦から退出しました";
  if (reason === "disconnect-timeout") return state.result === "double-loss" ? "両者とも再接続できませんでした" : won ? "相手が再接続できなかったため勝利です" : "再接続の猶予が終了しました";
  if (reason === "escape") {
    return won ? "水色のおばけが脱出！" : "相手の水色のおばけが脱出しました";
  }
  if (reason === "capture-good") {
    return won ? "相手の水色をすべて捕獲！" : "水色をすべて取られました";
  }
  if (reason === "own-bad-captured") {
    return won ? "ピンクをすべて取らせました" : "相手のピンクをすべて取ってしまいました";
  }
  return "勝負が決まりました";
}

function isGhostExitReady(piece) {
  if (!piece || piece.owner !== "me" || piece.kind !== "good") {
    return false;
  }
  if (state.ghost.myIndex === 0) {
    return piece.row === 0 && (piece.col === 0 || piece.col === 5);
  }
  return piece.row === 5 && (piece.col === 0 || piece.col === 5);
}

function isAdjacentToSelected(row, col) {
  const selected = state.ghost.pieces.find((piece) => piece.id === selectedGhostPieceId);
  if (!selected) {
    return false;
  }
  return Math.abs(selected.row - row) + Math.abs(selected.col - col) === 1;
}

function renderGhostPiece(piece) {
  const label = piece.owner === "me" ? `${ghostKindLabel(piece.kind)}のおばけ` : state.status === "ended" ? `相手の${ghostKindLabel(piece.kind)}のおばけ` : "相手のおばけ";
  return `
    <button class="ghost-piece ${piece.owner} ${piece.kind}" type="button" data-piece-id="${piece.id}" aria-label="${label}">
      ${ghostArt(piece.kind)}
    </button>
  `;
}

function renderGhostBoard() {
  const rows = [];
  const lastMove = state.ghost.log.filter((entry) => entry.from && entry.to).at(-1);
  for (let viewRow = 0; viewRow < 6; viewRow += 1) {
    for (let viewCol = 0; viewCol < 6; viewCol += 1) {
      const board = ghostViewToBoard(viewRow, viewCol);
      const piece = ghostPieceAt(board.row, board.col);
      const selected = piece && piece.id === selectedGhostPieceId;
      const target = Boolean(selectedGhostPieceId && (!piece || piece.owner === "opponent"));
      const legalish = selectedGhostPieceId && isAdjacentToSelected(board.row, board.col);
      const exitSquare = (board.row === 0 || board.row === 5) && (board.col === 0 || board.col === 5);
      const lastFrom = lastMove?.from.row === board.row && lastMove?.from.col === board.col;
      const lastTo = lastMove?.to.row === board.row && lastMove?.to.col === board.col;
      rows.push(`
        <div class="ghost-cell ${selected ? "selected" : ""} ${legalish && target ? "target" : ""} ${exitSquare ? "exit" : ""} ${lastFrom ? "last-from" : ""} ${lastTo ? "last-to" : ""}" data-row="${board.row}" data-col="${board.col}" ${lastFrom || lastTo ? `aria-label="直前の移動${lastFrom ? "元" : "先"}"` : ""}>
          ${piece ? renderGhostPiece(piece) : ""}
        </div>
      `);
    }
  }
  return renderGhostField(`<div class="ghost-board">${rows.join("")}</div>`);
}

function renderGhostField(board) {
  const selected = state.ghost.pieces.find((piece) => piece.id === selectedGhostPieceId);
  const ready = canPlay() && state.isMyTurn && isGhostExitReady(selected);
  const selectedCol = selected ? ghostToView(selected.row, selected.col).col : null;
  const doors = (mine) => `<div class="ghost-exits ${mine ? "own-exits" : "opponent-exits"}">
    ${[0, 5].map((col) => `<button type="button" class="ghost-door ${ready && mine && selectedCol === col ? "available" : ""}" data-ghost-escape="${col}" aria-label="${mine ? "あなた" : "相手"}の${col === 0 ? "左" : "右"}の脱出口" ${ready && mine && selectedCol === col ? "" : "disabled"}><span class="door-art" aria-hidden="true"><i></i></span><span class="door-arrow" aria-hidden="true">${mine ? "↑" : "↓"}</span></button>`).join("")}
    <div class="exit-caption"><strong>${mine ? "あなたの脱出口" : "相手の脱出口"}</strong>${mine ? `<small>${ready ? "ドアを押して脱出" : "水色で盤外へ"}</small>` : ""}</div>
  </div>`;
  return `<div class="ghost-field">${doors(true)}${board}${doors(false)}</div>`;
}

function renderGhostSetupBoard() {
  const slotMap = new Map(state.ghost.myStartSlots.map((slot, index) => [`${slot.row}:${slot.col}`, index]));
  const cells = [];
  for (let viewRow = 0; viewRow < 6; viewRow += 1) {
    for (let viewCol = 0; viewCol < 6; viewCol += 1) {
      const board = ghostViewToBoard(viewRow, viewCol);
      const slotIndex = slotMap.get(`${board.row}:${board.col}`);
      const kind = slotIndex === undefined ? null : ghostSetupKinds[slotIndex];
      cells.push(`
        <div class="ghost-cell setup ${kind ? "filled" : ""}" data-slot-index="${slotIndex === undefined ? "" : slotIndex}">
          ${kind ? `<button class="ghost-piece me ${kind}" type="button" aria-label="${ghostKindLabel(kind)}のおばけ" aria-pressed="false">${ghostArt(kind)}</button>` : ""}
        </div>
      `);
    }
  }
  return renderGhostField(`<div class="ghost-board setup-board">${cells.join("")}</div>`);
}

function getGhostSetupSlot(cell) {
  if (!cell || !cell.dataset) {
    return null;
  }
  const slotValue = cell.dataset.slotIndex;
  if (slotValue === "") {
    return null;
  }
  const slotIndex = Number(slotValue);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 8) {
    return null;
  }
  return slotIndex;
}

function getGhostSetupCellAt(clientX, clientY) {
  const target = document.elementFromPoint(clientX, clientY);
  return target ? target.closest("[data-slot-index]") : null;
}

function clearGhostSetupDragClasses() {
  document.querySelector(".ghost-drag-preview")?.remove();
  document.querySelectorAll(".ghost-cell.dragging, .ghost-cell.drag-over").forEach((cell) => {
    cell.classList.remove("dragging", "drag-over");
  });
}

function markGhostSetupDragTarget(cell) {
  document.querySelectorAll(".ghost-cell.drag-over").forEach((candidate) => {
    if (candidate !== cell) {
      candidate.classList.remove("drag-over");
    }
  });
  if (cell && getGhostSetupSlot(cell) !== null && getGhostSetupSlot(cell) !== ghostSetupDrag?.fromIndex) {
    cell.classList.add("drag-over");
  }
}

function swapGhostSetupSlots(fromIndex, toIndex) {
  ghostSetupKinds = swapGhostSetupPieces(ghostSetupKinds, fromIndex, toIndex);
}

function animateGhostSetupSwap(fromIndex, toIndex, draggedRect) {
  const from = document.querySelector(`[data-slot-index="${fromIndex}"] .ghost-piece`);
  const to = document.querySelector(`[data-slot-index="${toIndex}"] .ghost-piece`);
  const fromRect = from.getBoundingClientRect();
  const toRect = to.getBoundingClientRect();
  swapGhostSetupSlots(fromIndex, toIndex);
  renderGhostSetup();
  const board = document.querySelector(".setup-board");
  const source = board.querySelector(`[data-slot-index="${fromIndex}"] .ghost-piece`);
  const target = board.querySelector(`[data-slot-index="${toIndex}"] .ghost-piece`);
  for (const piece of [source, target]) piece.parentElement.classList.add("swapped");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  // The two pieces start at their previous positions, then travel into their new slots.
  const motion = { board, animations: [] };
  ghostSwapMotion = motion;
  board.classList.add("swap-animating");
  const floating = draggedRect || fromRect;
  const moves = [
    [source, toRect.left - fromRect.left, toRect.top - fromRect.top],
    [target, floating.left - toRect.left, floating.top - toRect.top]
  ];
  for (const [piece, x, y] of moves) {
    piece.parentElement.classList.add("swap-moving");
    motion.animations.push(piece.animate([
      { transform: `translate(${x}px, ${y}px)`, opacity: 1 },
      { transform: "translate(0, 0)", opacity: 1 }
    ], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" }));
  }
  Promise.allSettled(motion.animations.map((animation) => animation.finished)).then(() => {
    board.classList.remove("swap-animating");
    board.querySelectorAll(".swap-moving").forEach((cell) => cell.classList.remove("swap-moving"));
    if (ghostSwapMotion === motion) ghostSwapMotion = null;
  });
}

function bindGhostSetupDrag() {
  document.querySelectorAll("[data-slot-index]").forEach((cell) => {
    const slotIndex = getGhostSetupSlot(cell);
    if (slotIndex === null) {
      return;
    }

    cell.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0 || ghostSetupDrag || ghostSwapMotion) return;
      clearGhostSetupDragClasses();
      ghostKeyboardSlot = null;
      document.querySelectorAll(".swap-selected").forEach((selected) => {
        selected.classList.remove("swap-selected");
        selected.querySelector("button").setAttribute("aria-pressed", "false");
      });
      const rect = cell.querySelector(".ghost-piece").getBoundingClientRect();
      ghostSetupDrag = {
        pointerId: event.pointerId,
        fromIndex: slotIndex,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        rect,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      if (cell.setPointerCapture) {
        cell.setPointerCapture(event.pointerId);
      }
    });

    cell.addEventListener("pointermove", (event) => {
      if (!ghostSetupDrag || ghostSetupDrag.pointerId !== event.pointerId) {
        return;
      }
      const distance = Math.hypot(event.clientX - ghostSetupDrag.startX, event.clientY - ghostSetupDrag.startY);
      if (distance > 8) {
        ghostSetupDrag.moved = true;
      }
      if (ghostSetupDrag.moved) {
        event.preventDefault();
        cell.classList.add("dragging");
        let preview = document.querySelector(".ghost-drag-preview");
        if (!preview) {
          preview = cell.querySelector(".ghost-piece").cloneNode(true);
          preview.classList.add("ghost-drag-preview");
          preview.setAttribute("aria-hidden", "true");
          preview.tabIndex = -1;
          preview.style.width = `${ghostSetupDrag.rect.width}px`;
          preview.style.height = `${ghostSetupDrag.rect.height}px`;
          document.body.append(preview);
        }
        preview.style.left = `${event.clientX - ghostSetupDrag.offsetX}px`;
        preview.style.top = `${event.clientY - ghostSetupDrag.offsetY}px`;
        markGhostSetupDragTarget(getGhostSetupCellAt(event.clientX, event.clientY));
      }
    });

    cell.addEventListener("pointerup", (event) => {
      if (!ghostSetupDrag || ghostSetupDrag.pointerId !== event.pointerId) {
        return;
      }
      const drag = ghostSetupDrag;
      ghostSetupDrag = null;
      const targetIndex = getGhostSetupSlot(getGhostSetupCellAt(event.clientX, event.clientY));
      const draggedRect = document.querySelector(".ghost-drag-preview")?.getBoundingClientRect();
      clearGhostSetupDragClasses();
      if (cell.releasePointerCapture) {
        cell.releasePointerCapture(event.pointerId);
      }
      if (drag.moved && targetIndex !== null && targetIndex !== drag.fromIndex) {
        animateGhostSetupSwap(drag.fromIndex, targetIndex, draggedRect);
      }
    });

    cell.addEventListener("pointercancel", (event) => {
      if (ghostSetupDrag && ghostSetupDrag.pointerId === event.pointerId) {
        ghostSetupDrag = null;
        clearGhostSetupDragClasses();
      }
    });
    cell.addEventListener("lostpointercapture", () => {
      if (ghostSetupDrag && ghostSetupDrag.fromIndex === slotIndex) {
        ghostSetupDrag = null;
        clearGhostSetupDragClasses();
      }
    });
    cell.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (ghostSwapMotion || ghostSetupDrag) return;
        if (ghostKeyboardSlot === null) {
          ghostKeyboardSlot = slotIndex;
          cell.classList.add("swap-selected");
          cell.querySelector("button").setAttribute("aria-pressed", "true");
        } else {
          const fromIndex = ghostKeyboardSlot;
          ghostKeyboardSlot = null;
          if (fromIndex !== slotIndex) animateGhostSetupSwap(fromIndex, slotIndex);
          else {
            cell.classList.remove("swap-selected");
            cell.querySelector("button").setAttribute("aria-pressed", "false");
          }
        }
      }
    });
  });
}

function renderGhostSetup() {
  if (ghostSwapMotion) {
    ghostSwapMotion.animations.forEach((animation) => animation.cancel());
    ghostSwapMotion = null;
  }
  ghostKeyboardSlot = null;
  ghostSetupDrag = null;
  clearGhostSetupDragClasses();
  setScreenMode("ghost");
  const alreadyReady = Boolean(state.me.ready);
  const goodCount = ghostSetupKinds.filter((kind) => kind === "good").length;
  const badCount = ghostSetupKinds.filter((kind) => kind === "bad").length;
  app.innerHTML = `
    <section class="ghost-screen">
      <header class="ghost-header">
        <div>
          <p>GHOST DUEL</p>
          <h2>配置を決める</h2>
        </div>
        <div class="ghost-header-tools">${ghostRulesButton()}<span>${timeLabel(state.rules.timeLimitSeconds)}</span></div>
      </header>
      ${renderMatchStats()}
      <div class="ghost-players">
        <span>${escapeHtml(state.me.nickname)} / ${playerStatus(state.me, "")}</span>
        <span>${escapeHtml(state.opponent ? state.opponent.nickname : "相手")} / ${playerStatus(state.opponent, "待機中")}</span>
      </div>
      <div class="ghost-help">${alreadyReady ? "相手の配置を待っています" : "水色4体・ピンク4体"}</div>
      ${renderGhostSetupBoard()}
      <div class="ghost-counts">
        <span class="good">${ghostArt("good")}水色 ${goodCount}/4</span>
        <span class="bad">${ghostArt("bad")}ピンク ${badCount}/4</span>
      </div>
      <div class="ghost-actions">
        <button id="submitGhostSetup" class="button" type="button" ${!alreadyReady && goodCount === 4 && badCount === 4 ? "" : "disabled"}>${alreadyReady ? "配置済み" : "配置完了"}</button>
        <button id="leave" class="button secondary" type="button">ゲーム選択へ</button>
      </div>
    </section>
  `;

  if (!alreadyReady) {
    bindGhostSetupDrag();
    document.querySelector("#submitGhostSetup").addEventListener("click", () => {
      send({ type: "ghost-setup", kinds: ghostSetupKinds });
    });
  }
  document.querySelector("#leave").addEventListener("click", () => send({ type: "leave" }));
}

function renderGhostCounts() {
  const opponent = state.ghost.counts.opponent || { goodCaptured: 0, badCaptured: 0 };
  return `
    <div class="ghost-captures">
      <span>${ghostArt("good")}捕まえた水色 <b>${opponent.goodCaptured}/4</b></span>
      <span>${ghostArt("bad")}捕まえたピンク <b>${opponent.badCaptured}/4</b></span>
    </div>
  `;
}

function updateGhostFeedback(message) {
  if (message.gameType !== "ghost" || message.status === "setup" || message.status === "waiting") {
    ghostFeedback = null;
    clearTimeout(ghostFeedbackTimer);
    return;
  }
  const latest = message.ghost.log.at(-1);
  const previous = state?.gameType === "ghost" ? state.ghost.log.at(-1) : null;
  if (!state || !latest || latest.eventId === previous?.eventId || latest.action !== "capture") return;
  const mine = latest.side === "me";
  const blue = latest.capturedKind === "good";
  ghostFeedback = {
    kind: blue ? "good" : "bad",
    tone: mine === blue ? "success" : "danger",
    text: blue ? mine ? "水色を捕獲！" : "水色を取られた！" : mine ? "しまった、ピンクだ！" : "ピンクを取らせた！"
  };
  clearTimeout(ghostFeedbackTimer);
  ghostFeedbackTimer = setTimeout(() => {
    ghostFeedback = null;
    const feedback = document.querySelector(".ghost-feedback");
    if (feedback) {
      feedback.className = "ghost-feedback";
      feedback.replaceChildren();
    }
  }, 5000);
}

function renderGhostFeedback() {
  return `<div class="ghost-feedback ${ghostFeedback ? ghostFeedback.tone : ""}" role="status" aria-live="polite">
    ${ghostFeedback ? `<span class="feedback-piece" aria-hidden="true">${ghostArt(ghostFeedback.kind)}</span><strong>${ghostFeedback.text}</strong>` : ""}
  </div>`;
}

function renderGhostGame() {
  setScreenMode("ghost");
  const selected = state.ghost.pieces.find((piece) => piece.id === selectedGhostPieceId);
  const ended = state.status === "ended";
  const won = ended && state.winner?.side === "me";
  app.innerHTML = `
    <section class="ghost-screen play">
      <header class="ghost-header ${ended ? "finished" : state.isMyTurn ? "my-turn" : "their-turn"}">
        <div>
          <p>GHOST DUEL</p>
          <h2>${ended ? "対戦結果" : state.isMyTurn ? "あなたのターン" : "相手のターン"}</h2>
        </div>
        <div class="ghost-header-tools">${ghostRulesButton()}${ended ? "" : `<button class="resign-trigger" type="button" data-resign aria-label="投了" title="投了">⚑</button><span class="ghost-time turn-timer">${timeLabel(state.rules.timeLimitSeconds)}</span>`}</div>
      </header>
      ${matchStatusMarkup()}
      ${matchNoticeMarkup()}
      ${ended ? `<section class="result-banner ghost-result ${won ? "win" : "lose"}" aria-label="対戦結果">
        <h2>${won ? "WIN" : "Lose"}</h2><p>${ghostWinText(state.ghost.winReason, won)}</p>
      </section>` : ""}
      ${renderGhostCounts()}
      ${ended ? "" : renderGhostFeedback()}
      ${renderGhostBoard()}
      ${ended ? `<p class="answer-label">答え合わせ · 相手の色を公開しています</p>` : ""}
      ${ended ? `
        <div class="ghost-actions">
          <button id="rematch" class="button" type="button" ${state.me.rematch || !state.opponent ? "disabled" : ""}>${state.me.rematch ? "再戦待ち" : "同じ相手と再戦"}</button>
          <button id="leave" class="button secondary" type="button">メインに戻る</button>
        </div>
      ` : ""}
    </section>
  `;

  updateConnectionNotice();
  const move = state.ghost.log.filter((entry) => entry.from && entry.to && ["move", "capture"].includes(entry.action)).at(-1);
  const animationKey = move ? `${state.ghost.pieces[0]?.id}:${move.eventId}` : null;
  if (move && animationKey !== lastAnimatedGhostMove && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    lastAnimatedGhostMove = animationKey;
    const from = document.querySelector(`[data-row="${move.from.row}"][data-col="${move.from.col}"]`);
    const to = document.querySelector(`[data-row="${move.to.row}"][data-col="${move.to.col}"]`);
    const piece = to?.querySelector(".ghost-piece");
    if (from && piece) {
      const a = from.getBoundingClientRect(); const b = to.getBoundingClientRect();
      piece.animate([{ transform: `translate(${a.left - b.left}px,${a.top - b.top}px)` }, { transform: "translate(0,0)" }], { duration: 260, easing: "ease-out" });
    }
  }
  if (canPlay() && state.isMyTurn) {
    document.querySelectorAll(".ghost-cell").forEach((cell) => {
      cell.addEventListener("click", () => {
        const row = Number(cell.dataset.row);
        const col = Number(cell.dataset.col);
        const piece = ghostPieceAt(row, col);
        if (piece && piece.owner === "me") {
          selectedGhostPieceId = piece.id;
          renderGhostGame();
          return;
        }
        if (selectedGhostPieceId) {
          send({ type: "ghost-move", pieceId: selectedGhostPieceId, to: { row, col } });
          selectedGhostPieceId = null;
        }
      });
    });
    document.querySelectorAll("[data-ghost-escape]:not(:disabled)").forEach((escapeButton) => {
      escapeButton.addEventListener("click", () => {
        send({ type: "ghost-move", pieceId: selected.id, escape: true });
        selectedGhostPieceId = null;
      });
    });
  }
  if (ended) {
    document.querySelector("#rematch").addEventListener("click", () => send({ type: "rematch" }));
    document.querySelector("#leave").addEventListener("click", () => send({ type: "leave" }));
  }
}

function renderWaiting() {
  setScreenMode("waiting");
  app.innerHTML = `
    <section class="panel stack">
      <div class="status-band attention">
        <strong>相手待ち</strong>
        <span class="status-pill">${timeLabel(state.rules.timeLimitSeconds)}${state.gameType === "hitblow" ? ` / ${state.rules.length}桁` : ""}</span>
      </div>
      ${renderPhaseSteps()}
      ${renderMatchStats()}
      ${renderPlayers()}
      <div class="actions">
        <button id="copyLink" class="button" type="button">URLコピー</button>
        <button id="leave" class="button secondary" type="button">ゲーム選択へ</button>
      </div>
    </section>
  `;
  document.querySelector("#copyLink").addEventListener("click", copyCurrentUrl);
  document.querySelector("#leave").addEventListener("click", () => send({ type: "leave" }));
}

function renderSlots(digits) {
  return `
    <div class="slots">
      ${Array.from({ length: state.rules.length }, (_, index) => {
        const value = digits[index];
        return `<div class="slot ${value === undefined ? "empty" : ""}">${value === undefined ? "-" : value}</div>`;
      }).join("")}
    </div>
  `;
}

function renderKeypad(mode, digits) {
  const digitButtons = Array.from({ length: 10 }, (_, value) => {
    const used = digits.includes(String(value));
    return `<button class="digit ${used ? "used" : ""}" type="button" data-${mode}-digit="${value}" ${used ? "disabled" : ""}>${value}</button>`;
  }).join("");
  return `
    <div class="keypad">
      ${digitButtons}
      <button class="digit control" type="button" data-${mode}-back>⌫</button>
      <button class="digit control" type="button" data-${mode}-clear>C</button>
    </div>
  `;
}

function bindDigitControls(mode, digits, onChange) {
  document.querySelectorAll(`[data-${mode}-digit]`).forEach((button) => {
    button.addEventListener("click", () => {
      if (digits.length >= state.rules.length) {
        return;
      }
      digits.push(button.dataset[`${mode}Digit`]);
      onChange();
    });
  });
  document.querySelector(`[data-${mode}-back]`).addEventListener("click", () => {
    digits.pop();
    onChange();
  });
  document.querySelector(`[data-${mode}-clear]`).addEventListener("click", () => {
    digits.splice(0, digits.length);
    onChange();
  });
}

function renderSetup() {
  setScreenMode("arena");
  app.innerHTML = `
    <section class="arena-screen setup-screen">
      ${renderDuelHeader()}
      <div class="arena-fill"></div>
      ${renderInputDeck({
        mode: "secret",
        digits: secretDigits,
        prompt: state.me.ready ? "相手の入力を待っています" : "あなたの数字を決めてください",
        active: !state.me.ready
      })}
      <button id="leave" class="arena-leave" type="button">ゲーム選択へ</button>
    </section>
  `;

  if (!state.me.ready) {
    bindDigitControls("secret", secretDigits, renderSetup);
    document.querySelector("#submitSecret").addEventListener("click", () => {
      send({ type: "set-secret", value: secretDigits.join("") });
      secretDigits = [];
    });
  }
  document.querySelector("#leave").addEventListener("click", () => send({ type: "leave" }));
}

function renderHistory(title, side) {
  const rows = state.guesses.filter((guess) => guess.side === side);
  return `
    <section class="history">
      <h3>${title}</h3>
      <div class="history-list">
        ${rows.length
          ? rows.map((guess) => `
            <div class="history-row">
              <div>
                <div class="guess">${guess.skipped ? "無回答" : escapeHtml(guess.value)}</div>
                <div class="muted">${guess.skipped ? "時間切れ" : escapeHtml(guess.nickname)}</div>
              </div>
              ${guess.skipped
                ? `<div class="score skipped"><span>PASS</span></div>`
                : `<div class="score">
                    <span>${guess.hits}H</span>
                    <span>${guess.blows}B</span>
                  </div>`}
            </div>
          `).join("")
          : `<div class="empty-history">まだありません</div>`}
      </div>
    </section>
  `;
}

function renderHistoryTable(title, side) {
  const rows = state.guesses.filter((guess) => guess.side === side);
  const filledRows = Array.from({ length: Math.max(6, rows.length) }, (_, index) => rows[index] || null);
  return `
    <section class="duel-history ${side}">
      <header>
        <span>${title}</span>
        <b>H</b>
        <b>B</b>
      </header>
      <div class="duel-history-rows">
        ${filledRows.map((guess) => {
          if (!guess) {
            return `<div class="duel-history-row empty"><span></span><b></b><b></b></div>`;
          }
          if (guess.skipped) {
            return `<div class="duel-history-row skipped"><span>無回答</span><b></b><b></b></div>`;
          }
          return `
            <div class="duel-history-row">
              <span>${escapeHtml(guess.value)}</span>
              <b>${guess.hits}</b>
              <b>${guess.blows}</b>
            </div>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderHistoryBoard() {
  return `
    <div class="duel-history-board">
      ${renderHistoryTable("あなたの推理", "me")}
      ${renderHistoryTable("相手の推理", "opponent")}
    </div>
  `;
}

function renderPlayBanner() {
  if (state.status === "ended") {
    return `
      <div class="status-band done">
        <strong>${state.winner.side === "me" ? "勝ち" : "負け"}</strong>
        <span class="muted">勝者: ${escapeHtml(state.winner.nickname)}</span>
      </div>
    `;
  }
  if (!state.opponent.connected) {
    return `
      <div class="status-band pause">
        <strong>相手の再接続待ち</strong>
        <span class="muted">画面はそのままです</span>
      </div>
    `;
  }
  return `
    <div class="status-band ${state.isMyTurn ? "attention" : ""}">
      <strong>${state.isMyTurn ? "あなたのターン" : "相手のターン"}</strong>
      <span class="timer-pill turn-timer">${state.rules.timeLimitSeconds}秒</span>
    </div>
  `;
}

function renderGuessPanel() {
  if (state.status !== "playing" || !state.isMyTurn || !state.opponent.connected) {
    return "";
  }
  return `
    <section class="panel stack">
      <h2>予想</h2>
      ${renderSlots(guessDigits)}
      ${renderKeypad("guess", guessDigits)}
      <button id="submitGuess" class="button warn" type="button" ${guessDigits.length === state.rules.length ? "" : "disabled"}>この数字で勝負</button>
    </section>
  `;
}

function renderResult() {
  const result = state.result === "draw" ? "draw" : state.winner && state.winner.side === "me" ? "win" : "lose";
  const labels = { win: "WIN", lose: "Lose", draw: "Draw" };
  const detail = state.endReason === "setup-timeout"
    ? state.result === "double-loss" ? "両者とも数字設定が時間切れです" : "数字設定の時間切れで決着しました"
    : ["resigned", "disconnect-timeout", "opponent-left"].includes(state.endReason) ? ghostWinText(state.endReason, result === "win")
    : state.result === "draw" ? "両者正解、引き分けです" : result === "win" ? "あなたの勝ちです" : "相手の勝ちです";
  return `<section class="result-banner ${result}" aria-label="対戦結果">
    <h2>${labels[result]}</h2><p>${detail}</p>
  </section>`;
}

function renderGame() {
  const historyScroll = [...document.querySelectorAll(".duel-history-rows")].map((element) => ({ top: element.scrollTop, atBottom: element.scrollHeight - element.scrollTop - element.clientHeight < 4 }));
  setScreenMode("arena");
  app.innerHTML = `
    <section class="arena-screen play-screen">
      ${renderDuelHeader()}
      ${matchNoticeMarkup()}
      ${state.status === "ended" ? renderResult() : `
        <div class="arena-message ${state.isMyTurn ? "active" : ""}">
          <strong>${state.isMyTurn ? "あなたのターン" : "相手のターン"}</strong>
          <span class="timer-pill turn-timer">${timeLabel(state.rules.timeLimitSeconds)}</span>
          <button class="resign-trigger" type="button" data-resign aria-label="投了" title="投了">⚑</button>
        </div>
        ${state.finalAnswer ? `<div class="final-answer">${state.isMyTurn ? "最後の回答です。正解すればDraw！" : "後攻の最後の回答を待っています"}</div>` : ""}
      `}
      ${state.status === "ended" ? `<p class="answer-label">答え合わせ · 両者の数字を公開しています</p>` : ""}
      ${renderHistoryBoard()}
      ${state.status === "playing"
        ? renderInputDeck({
            mode: "guess",
            digits: guessDigits,
            prompt: state.isMyTurn ? "相手の数字を推理してください" : "相手の入力を待っています",
            active: state.isMyTurn && state.opponent.connected && canPlay()
          })
        : ""}
      ${state.status === "ended" ? `
        <section class="arena-actions">
          <button id="rematch" class="button" type="button" ${state.me.rematch || !state.opponent ? "disabled" : ""}>${state.me.rematch ? "再戦待ち" : "同じ相手と再戦"}</button>
          <button id="leave" class="button secondary" type="button">メインに戻る</button>
        </section>
      ` : ""}
    </section>
  `;

  updateConnectionNotice();
  if (canPlay() && state.isMyTurn && state.opponent.connected) {
    bindDigitControls("guess", guessDigits, renderGame);
    document.querySelector("#submitGuess").addEventListener("click", () => {
      send({ type: "guess", value: guessDigits.join("") });
      guessDigits = [];
    });
  }

  if (state.status === "ended") {
    document.querySelector("#rematch").addEventListener("click", () => send({ type: "rematch" }));
    document.querySelector("#leave").addEventListener("click", () => send({ type: "leave" }));
  }
  document.querySelectorAll(".duel-history-rows").forEach((rows, index) => { rows.scrollTop = historyScroll[index] && !historyScroll[index].atBottom ? historyScroll[index].top : rows.scrollHeight; });
}

function render() {
  app.style.setProperty("--digits", state ? state.rules.length : joinDraft.length);
  if (!state) {
    if (resuming) {
      setScreenMode("waiting");
      app.innerHTML = `<section class="panel stack"><h2>対戦に再接続しています…</h2><p class="resume-status" role="status">${escapeHtml(joinDraft.nickname)} · ${joinDraft.gameType === "ghost" ? "ゴースト" : "ヒット＆ブロー"}</p><button id="cancelResume" class="button secondary" type="button">再接続をやめる</button></section>`;
      document.querySelector("#cancelResume").addEventListener("click", () => { forgetMatch(); resuming = false; state = null; selectedGame = null; joinMode = null; socket?.close(); render(); });
      return;
    }
    renderJoin();
    return;
  }

  if (state.status === "waiting") {
    renderWaiting();
    return;
  }

  if (state.status === "setup") {
    if (state.gameType === "ghost") {
      renderGhostSetup();
    } else {
      guessDigits = [];
      renderSetup();
    }
    return;
  }

  if (state.gameType === "ghost") {
    renderGhostGame();
  } else {
    renderGame();
  }
}

const previousTabMatch = savedMatch(sessionStorage);
if (previousTabMatch) { joinDraft = { ...joinDraft, ...previousTabMatch }; selectedGame = previousTabMatch.gameType; resuming = true; }
render();
connect();
setInterval(updateCountdown, 250);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
