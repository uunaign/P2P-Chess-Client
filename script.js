(() => {
  if (typeof Chess === "undefined") {
    const st = document.getElementById("statusText"); if (st) st.textContent = "Error: no se pudo cargar chess.js.";
    return;
  }

  const game = new Chess();

  // Normalizar métricas de compatibilidad de chess.js
  [["isCheckmate", "in_checkmate"], ["isStalemate", "in_stalemate"], ["isDraw", "in_draw"],
  ["isThreefoldRepetition", "in_threefold_repetition"], ["isInsufficientMaterial", "insufficient_material"],
  ["inCheck", "in_check"], ["isGameOver", "game_over"]].forEach(([a, b]) => {
    if (typeof game[a] !== "function" && typeof game[b] === "function") game[a] = game[b].bind(game);
    if (typeof game[b] !== "function" && typeof game[a] !== "function") game[b] = game[a].bind(game);
  });

  // Cada página (online, partida…) solo contiene parte de la interfaz. Lo que falta se sustituye por un
  // <select> suelto (siempre el mismo por id), así el motor no necesita comprobar cada elemento.
  const PAGE = document.body.dataset.page || "partida";
  const byId = id => document.getElementById(id);
  const ghosts = new Map();
  const $ = id => byId(id) || ghosts.get(id) || (ghosts.set(id, document.createElement("select")), ghosts.get(id));
  const hostOpts = { color: null };   // opciones de anfitrión que llegan por la URL
  const handoff = params => { location.href = "partida.html?" + new URLSearchParams(params); };
  const glyph = {
    w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
    b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" }
  };

  let flipped = false, selected = null, legalTargets = [], lastMove = null;
  let pendingPremove = null, premoveMode = false;
  let marks = new Map(), arrows = [], rightStart = null, rightMoved = false, dragFrom = null;
  let redoStack = [], pendingPromotion = null, analysis = false, justDragged = false;
  let historyPly = null;
  let botEnabled = false, botColor = "b", botElo = 1200, botSkill = 10, botThinking = false;
  let engineWorker = null, engineReady = false, engineInitPromise = null, activeSearch = null;
  let analysisCancelled = false, analysisRunning = false, report = null, reviewing = false;

  // Red y tiempo
  let role = null, myColor = null;
  let peerJSInstance = null, peerJSConn = null, peerConnectionTimer = null;
  let activeHandicap = "none";
  let timed = true, whiteTime = 600, blackTime = 600, increment = 0, clockTimer = null, clockLastUpdate = null;
  let opponentChatBubbleTimer = null;

  const store = { get: k => { try { return localStorage.getItem(k) } catch (_) { return null } }, set: (k, v) => { try { localStorage.setItem(k, v) } catch (_) { } } };
  let premovesEnabled = store.get("ajedrez.premoves") === "true";
  const MATCH_HISTORY_KEY = "aj_match_history";
  const LIVE_GAMES_KEY = "aj_live_games";
  let matchHistory = [];
  try { matchHistory = JSON.parse(store.get(MATCH_HISTORY_KEY) || "[]") || []; } catch (_) { matchHistory = []; }
  let liveMatches = {};
  try { liveMatches = JSON.parse(store.get(LIVE_GAMES_KEY) || "{}") || {}; } catch (_) { liveMatches = {}; }
  let watchBoardState = null;
  let liveBroadcastTimer = null;
  let pieceSet = /^[a-z0-9_]+$/.test(store.get("ajedrez.pieces") || "") ? store.get("ajedrez.pieces") : "neo";
  let boardTheme = /^(c-[a-z0-9]+|img:[a-z0-9_]+)$/.test(store.get("ajedrez.board") || "") ? store.get("ajedrez.board") : "c-verde";
  const UI_THEMES = AJ.UI_THEMES;
  const ACCENT_PRESETS = AJ.ACCENTS;
  let uiTheme = /^(dark|light)$/.test(store.get("ajedrez.uiTheme") || "") ? store.get("ajedrez.uiTheme") : "dark";
  let accentId = ACCENT_PRESETS[store.get("ajedrez.accent") || ""] ? store.get("ajedrez.accent") : "verde";
  const isBlindPieceSet = set => /^blind_/.test(String(set || ""));
  function getPieceSetForContext(context = "normal") {
    if (!isBlindPieceSet(pieceSet)) return pieceSet;
    if (context === "promotion" || context === "friend_watch") return "neo";
    return pieceSet;
  }
  function PIECE_FOR(context, c, t) {
    return pieceUrl(getPieceSetForContext(context), c, t);
  }
  const BLIND_PIECE_SETS = {
    blind_easy: { name: "Blind: fácil", queenTypes: new Set(["n", "b"]) },
    blind_medium: { name: "Blind: medio", queenTypes: new Set(["p", "n", "b"]) },
    blind_hard: { name: "Blind: difícil", queenTypes: new Set(["p", "n", "b", "r", "q", "k"]) },
    blind_transparent: { name: "Blind: todo", transparent: true }
  };
  const blindPieceSvg = (c, mode) => {
    const dark = c === "b";
    const fill = dark ? "#111827" : "#fffdf5";
    const stroke = dark ? "#facc15" : "#111827";
    const opacity = mode === "transparent" ? 0 : 1;
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <rect width="64" height="64" fill="rgba(0,0,0,0)"/>
        ${dark
          ? `<circle cx="32" cy="32" r="23" fill="${fill}" stroke="${stroke}" stroke-width="5" opacity="${opacity}"/><circle cx="32" cy="32" r="7" fill="#fff" opacity="${opacity}"/>`
          : `<path d="M32 7 55 32 32 57 9 32Z" fill="${fill}" stroke="${stroke}" stroke-width="5" stroke-linejoin="round" opacity="${opacity}"/><circle cx="32" cy="32" r="7" fill="#111827" opacity="${opacity}"/>`}
      </svg>
    `;
    return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
  };
  const pieceUrl = (set, c, t) => {
    if (set.startsWith("blind_")) {
      const mode = BLIND_PIECE_SETS[set];
      if (!mode) return "https://images.chesscomfiles.com/chess-themes/pieces/neo/150/" + c + t + ".png";
      if (mode.transparent) return blindPieceSvg(c, "transparent");
      if (mode.queenTypes && mode.queenTypes.has(t)) return blindPieceSvg(c, "queen");
      return pieceUrl("neo", c, t);
    }
    return "https://images.chesscomfiles.com/chess-themes/pieces/" + set + "/150/" + c + t + ".png";
  };
  const PIECE = (c, t) => PIECE_FOR("normal", c, t);
  ["w", "b"].forEach(c => ["k", "q", "r", "b", "n", "p"].forEach(t => { new Image().src = PIECE(c, t) }));   // precarga
  const files = "abcdefgh";
  const pieceNames = { q: "Dama", r: "Torre", b: "Alfil", n: "Caballo" };

  function coords(name) {
    const f = files.indexOf(name[0]), r = 8 - Number(name[1]);
    return flipped ? { x: 7 - f, y: 7 - r } : { x: f, y: r };
  }

  let boardLoadingTimeout = null;
  function setBoardLoading(loading, opts = {}) {
    const el = $("boardLoading");
    if (el) {
      el.hidden = !loading;
      if (loading) {
        const t = el.querySelector("strong"), sub = el.querySelector("small");
        if (t) t.textContent = opts.title || "Esperando al rival";
        if (sub) sub.textContent = opts.sub || "El tablero se activará cuando se conecte";
        $("boardLoadingRoom").hidden = !opts.code;
        if (opts.code) $("boardLoadingCode").textContent = opts.code;
      }
    }
    if (boardLoadingTimeout) { clearTimeout(boardLoadingTimeout); boardLoadingTimeout = null; }
    if (loading && !opts.persist) {
      // Evita dejar el tablero bloqueado indefinidamente si el rival no conecta.
      boardLoadingTimeout = setTimeout(() => setBoardLoading(false), 60000);
    }
  }

  function showToast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => t.style.display = "none", 2500);
  }

  function formatTime(s) {
    if (!timed) return "∞";
    if (s <= 0) return "0:00";
    if (s < 60) {
      const centiseconds = Math.ceil(s * 100);
      if (centiseconds >= 6000) return "1:00";
      const seconds = Math.floor(centiseconds / 100);
      return "0:" + String(seconds).padStart(2, "0") + "." + String(centiseconds % 100).padStart(2, "0");
    }
    const totalSeconds = Math.ceil(s);
    const m = Math.floor(totalSeconds / 60), sec = totalSeconds % 60;
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  function advanceClock(now = performance.now()) {
    const previous = clockLastUpdate;
    clockLastUpdate = now;
    if (previous === null || !timed || !game.history().length || game.game_over() || forced) return;

    const color = game.turn();
    const remaining = color === "w" ? whiteTime : blackTime;
    if (remaining <= 0) return;
    const updated = Math.max(0, remaining - Math.max(0, now - previous) / 1000);
    if (color === "w") whiteTime = updated;
    else blackTime = updated;
    if (updated === 0) {
      renderStatus();
      checkEnd();
    }
  }

  function startClocks() {
    clearInterval(clockTimer);
    clockTimer = setInterval(() => {
      advanceClock();
      if (!document.hidden) updateClockUI();
    }, 50);
  }

  function updateClockUI() {
    const topColor = flipped ? "w" : "b";
    const bottomColor = flipped ? "b" : "w";
    const started = game.history().length > 0, turn = game.turn();
    [["topClock", topColor], ["bottomClock", bottomColor]].forEach(([id, color]) => {
      const clock = $(id), remaining = color === "w" ? whiteTime : blackTime, text = formatTime(remaining);
      if (clock.textContent !== text) clock.textContent = text;
      clock.classList.toggle("low-time", timed && remaining < 60 && remaining > 0);
      clock.classList.toggle("active", turn === color && started);
    });
  }

  /* ---------- Renderizado del Tablero ---------- */
  function render() {
    const board = $("board");
    board.innerHTML = "";
    const history = game.history({ verbose: true });
    if (report && report.rows.length !== history.length) { report = null; reviewing = false }   // la partida ha cambiado: el análisis ya no vale
    const activeHistory = (historyPly !== null) ? history.slice(0, historyPly) : history;

    // Si estamos revisando la historia, creamos un tablero temporal para visualizar
    let displayGame = game;
    if (historyPly !== null) {
      displayGame = new Chess();
      activeHistory.forEach(m => displayGame.move(m));
    }

    lastMove = activeHistory.length ? { from: activeHistory[activeHistory.length - 1].from, to: activeHistory[activeHistory.length - 1].to } : null;
    const rvRow = (reviewing && report && activeHistory.length) ? report.rows[activeHistory.length - 1] : null;

    const frag = document.createDocumentFragment();
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const file = flipped ? 7 - x : x;
      const rank = flipped ? y : 7 - y;
      const name = files[file] + (rank + 1);
      const p = displayGame.get(name);
      const sq = document.createElement("button");
      sq.type = "button";
      sq.className = "square " + (((file + (rank + 1)) % 2 === 0) ? "light" : "dark");

      if (lastMove && (lastMove.from === name || lastMove.to === name)) sq.classList.add("last");
      if (selected === name) sq.classList.add("selected");
      if (legalTargets.includes(name)) sq.classList.add(p ? "capture" : "legal");
      if (pendingPremove && name === pendingPremove.to) sq.classList.add("premove");
      if (pendingPremove && name === pendingPremove.from) sq.classList.add("premove-from");

      if (p) {
        const piece = document.createElement("img");
        piece.className = "piece " + (p.color === "w" ? "white" : "black");
        if (pendingPremove && pendingPremove.from === name) piece.classList.add("premove-origin");
        piece.src = PIECE(p.color, p.type);
        piece.draggable = false;
        sq.appendChild(piece);
      }

      if (pendingPremove && pendingPremove.to === name && pendingPremove.promotion) {
        const queuedPiece = displayGame.get(pendingPremove.from);
        if (queuedPiece && queuedPiece.type === "p" && (pendingPremove.to[1] === "1" || pendingPremove.to[1] === "8")) {
          const ghost = document.createElement("img");
          ghost.className = "premove-ghost";
          ghost.src = PIECE(queuedPiece.color, pendingPremove.promotion);
          ghost.alt = "";
          ghost.setAttribute("aria-hidden", "true");
          sq.appendChild(ghost);
        }
      }

      if ((!flipped && file === 0) || (flipped && file === 7)) {
        const rankLabel = document.createElement("span");
        rankLabel.className = "coord rank";
        rankLabel.textContent = rank + 1;
        sq.appendChild(rankLabel);
      }
      if ((!flipped && rank === 0) || (flipped && rank === 7)) {
        const fileLabel = document.createElement("span");
        fileLabel.className = "coord file";
        fileLabel.textContent = files[file];
        sq.appendChild(fileLabel);
      }

      if (rvRow && name === rvRow.m.to) { const bd = document.createElement("span"); bd.className = "rv-badge"; bd.innerHTML = catImg(rvRow.key); sq.appendChild(bd) }
      sq.dataset.sq = name;
      frag.appendChild(sq);
    }
    board.appendChild(frag);

    renderMoves();
    renderReviewPanel();
    syncLocalTimeVisibility();
    renderStatus();
    drawAnnotations();
    updateClockUI();
    $("moveCount").textContent = history.length;
    const cur = historyPly !== null ? historyPly : history.length;
    $("backBtn").disabled = $("firstBtn").disabled = cur === 0;
    $("forwardBtn").disabled = $("lastBtn").disabled = historyPly === null;
    renderCaptured(displayGame);
    const over = !!getResult();
    $("drawBtn").disabled = over || !history.length || drawPending;
    $("resignBtn").disabled = over || !history.length;
    checkEnd();
  }

  /* ---------- Interacción: clic, arrastre, flechas y animaciones ---------- */
  let drag = null, over = null;
  const curPly = () => historyPly !== null ? historyPly : game.history().length;
  const sqEl = n => $("board").querySelector('[data-sq="' + n + '"]');
  function squareAt(e) {
    const r = $("board").getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * 8), y = Math.floor((e.clientY - r.top) / r.height * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    return files[flipped ? 7 - x : x] + ((flipped ? y : 7 - y) + 1);
  }
  function cancelDrag() {
    if (!drag) return;
    if (drag.ghost) drag.ghost.remove();
    if (drag.piece) drag.piece.classList.remove("hide");
    if (over) { over.classList.remove("over"); over = null }
    drag = null;
  }
  function slide(from, to) {
    const img = sqEl(to) && sqEl(to).querySelector(".piece");
    if (!img) return;
    const a = coords(from), b = coords(to), s = $("board").clientWidth / 8;
    img.style.zIndex = 6;
    img.animate([{ transform: "translate(" + (a.x - b.x) * s + "px," + (a.y - b.y) * s + "px)" }, { transform: "translate(0,0)" }], { duration: 130, easing: "ease-out" }).onfinish = () => { img.style.zIndex = "" };
  }
  function animateMove(m, rev) {
    const pairs = [[m.from, m.to]];
    if (m.flags && /[kq]/.test(m.flags)) { const r = m.from[1]; pairs.push(m.flags.includes("k") ? ["h" + r, "f" + r] : ["a" + r, "d" + r]) }
    pairs.forEach(([f, t]) => rev ? slide(t, f) : slide(f, t));
  }
  function goPly(n) {
    const h = game.history({ verbose: true }), cur = curPly();
    n = Math.max(0, Math.min(h.length, n));
    if (n === cur) return;
    historyPly = n === h.length ? null : n;
    render();
    if (Math.abs(n - cur) === 1) animateMove(h[Math.max(n, cur) - 1], n < cur);
  }

  const boardEl = $("board");
  function getPremoveTargets(from) {
    const piece = game.get(from);
    if (!piece || !myColor || piece.color !== myColor) return [];
    const targets = new Set(), [file, rank] = [files.indexOf(from[0]), 8 - Number(from[1])];
    const inside = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
    const at = (f, r) => inside(f, r) ? game.get(files[f] + (8 - r)) : null;
    const add = (f, r) => {
      if (!inside(f, r)) return false;
      const target = at(f, r);
      if (target && (target.color === myColor || target.type === "k")) return false;
      targets.add(files[f] + (8 - r));
      return !target;
    };

    if (piece.type === "n") {
      [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]
        .forEach(([df, dr]) => add(file + df, rank + dr));
    } else if (piece.type === "p") {
      const direction = myColor === "w" ? -1 : 1;
      const nextRank = rank + direction;
      if (inside(file, nextRank) && !at(file, nextRank)) {
        targets.add(files[file] + (8 - nextRank));
        const startRank = myColor === "w" ? 6 : 1, doubleRank = rank + 2 * direction;
        if (rank === startRank && !at(file, doubleRank)) targets.add(files[file] + (8 - doubleRank));
      }
      [-1, 1].forEach(df => {
        const target = at(file + df, nextRank);
        if (!target || target.color !== myColor && target.type !== "k") targets.add(files[file + df] + (8 - nextRank));
      });
    } else {
      const directions = piece.type === "b" ? [[1, 1], [1, -1], [-1, 1], [-1, -1]]
        : piece.type === "r" ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
          : [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
      directions.forEach(([df, dr]) => {
        let f = file + df, r = rank + dr;
        while (add(f, r)) { f += df; r += dr }
      });
      if (piece.type === "k") {
        const homeRank = myColor === "w" ? 7 : 0;
        const rights = game.fen().split(" ")[2];
        if (rank === homeRank && file === 4) {
          if (rights.includes(myColor === "w" ? "K" : "k") && !at(5, homeRank) && !at(6, homeRank) && at(7, homeRank)?.color === myColor && at(7, homeRank)?.type === "r") targets.add(files[6] + (8 - homeRank));
          if (rights.includes(myColor === "w" ? "Q" : "q") && !at(1, homeRank) && !at(2, homeRank) && !at(3, homeRank) && at(0, homeRank)?.color === myColor && at(0, homeRank)?.type === "r") targets.add(files[2] + (8 - homeRank));
        }
      }
    }
    return [...targets];
  }
  function queuePremove(from, to) {
    if (!premovesEnabled) return;
    const piece = game.get(from);
    if (!piece || !myColor || piece.color !== myColor || from === to) { selected = null; legalTargets = []; premoveMode = false; render(); return; }
    if (!getPremoveTargets(from).includes(to)) { selected = null; legalTargets = []; premoveMode = false; render(); return; }
    if (game.turn() === myColor) { tryMove(from, to, undefined, true); return; }
    const promotes = piece.type === "p" && (to[1] === "1" || to[1] === "8");
    pendingPremove = { from, to, promotion: undefined };
    selected = null; legalTargets = []; premoveMode = false; render();
    if (promotes) openPromotion(piece.color, true);
  }
  function cancelPremove() {
    if (!pendingPremove) return false;
    pendingPremove = null; selected = null; legalTargets = []; premoveMode = false; render(); return true;
  }
  function executePremove() {
    if (!premovesEnabled || !pendingPremove) return;
    const pm = pendingPremove;
    const piece = game.get(pm.from);
    if (!piece || (myColor && piece.color !== myColor)) { pendingPremove = null; render(); return; }
    if (piece.color !== game.turn()) { render(); return; }
    if (piece.type === "p" && (pm.to[1] === "1" || pm.to[1] === "8") && !pm.promotion) { render(); return; }
    pendingPremove = null;
    if (!game.moves({ square: pm.from, verbose: true }).some(m => m.to === pm.to)) { render(); return; }
    tryMove(pm.from, pm.to, pm.promotion, false);
  }
  boardEl.addEventListener("pointerdown", e => {
    const name = squareAt(e); if (!name) return;
    if (e.button === 2) { cancelDrag(); if (cancelPremove()) { rightStart = null; return; } rightStart = name; return; }
    if (e.button !== 0) return;
    if (historyPly !== null) { historyPly = null; render(); return }
    if (!persistentMarks && (marks.size || arrows.length)) { marks.clear(); arrows = []; drawAnnotations() }
    const p = game.get(name), waitingForTurn = !!(myColor && game.turn() !== myColor);
    if (waitingForTurn) {
      if (!premovesEnabled) { selected = null; legalTargets = []; premoveMode = false; render(); return; }
      if (p && p.color === myColor) {
        if (premoveMode && selected && legalTargets.includes(name)) { queuePremove(selected, name); return; }
        selected = name; premoveMode = true; legalTargets = getPremoveTargets(name); render();
        drag = { from: name, x: e.clientX, y: e.clientY, active: false, premove: true };
        try { boardEl.setPointerCapture(e.pointerId) } catch (_) { } return;
      }
      if (premoveMode && selected && legalTargets.includes(name)) { queuePremove(selected, name); return; }
      selected = null; legalTargets = []; premoveMode = false; render(); return;
    }
    if (selected && legalTargets.includes(name)) { if (premoveMode) { queuePremove(selected, name); return; } tryMove(selected, name); return; }
    if (p && p.color === game.turn()) {
      selected = name; premoveMode = false;
      legalTargets = game.moves({ square: name, verbose: true }).map(m => m.to);
      render();
      drag = { from: name, x: e.clientX, y: e.clientY, active: false };
      try { boardEl.setPointerCapture(e.pointerId) } catch (_) { }
      return;
    }
    selected = null; legalTargets = []; premoveMode = false; render();
  });
  window.addEventListener("pointermove", e => {
    if (!drag) return;
    if (e.buttons & 2) { cancelDrag(); return }
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
      const el = sqEl(drag.from), img = el && el.querySelector(".piece");
      if (!img) { drag = null; return }
      const g = img.cloneNode(); g.className = "drag-ghost";
      g.style.width = g.style.height = (boardEl.clientWidth / 8) + "px";
      document.body.appendChild(g); img.classList.add("hide");
      drag.active = true; drag.ghost = g; drag.piece = img;
    }
    drag.ghost.style.left = e.clientX + "px"; drag.ghost.style.top = e.clientY + "px";
    const n = squareAt(e), el = n && legalTargets.includes(n) ? sqEl(n) : null;
    if (el !== over) { if (over) over.classList.remove("over"); over = el; if (el) el.classList.add("over") }
  });
  window.addEventListener("pointerup", e => {
    if (e.button === 2) {
      const end = squareAt(e);
      if (rightStart && end) {
        if (end === rightStart) toggleMark(end);
        else {
          const st = rightStart, exists = arrows.some(a => a.from === st && a.to === end);
          arrows = exists ? arrows.filter(a => !(a.from === st && a.to === end)) : [...arrows, { from: st, to: end, color: markColor }];
          marks.delete(st); marks.delete(end);
          drawAnnotations();
        }
      }
      rightStart = null; return;
    }
    if (!drag) return;
    const d = drag, to = squareAt(e);
    cancelDrag();
    if (d.active && to && to !== d.from && legalTargets.includes(to)) {
      if (!premovesEnabled && myColor && game.turn() !== myColor) return;
      if (d.premove || premoveMode || (myColor && game.turn() !== myColor)) queuePremove(d.from, to);
      else tryMove(d.from, to, undefined, true);
    }
  });
  window.addEventListener("pointercancel", cancelDrag);
  document.addEventListener("mousedown", e => { if (e.button === 2) cancelDrag() });
  document.addEventListener("contextmenu", e => {
    if (drag || (e.target.closest && e.target.closest("#boardWrap"))) e.preventDefault();
    cancelDrag();
    if (e.target.closest && e.target.closest("#boardWrap") && pendingPremove) cancelPremove();
  });

  function tryMove(from, to, promotion, noAnim, fromBot = false) {
    advanceClock();
    historyPly = null;
    if (forced || timedOut()) { showToast("La partida ha terminado"); return }
    const p = game.get(from);
    if (!p) { selected = null; legalTargets = []; render(); return }
    if (myColor && p.color !== myColor) { showToast("Esa pieza es del rival"); selected = null; legalTargets = []; render(); return }
    if (myColor && game.turn() !== myColor) { showToast("Es el turno del rival"); return }
    if (botEnabled && !fromBot && game.turn() === botColor) { showToast("Está pensando el bot…"); return }
    if (p.type === "p" && (to[1] === "8" || to[1] === "1") && !promotion) {
      if (game.moves({ square: from, verbose: true }).some(m => m.to === to)) {
        pendingPromotion = { from, to, noAnim };
        openPromotion(p.color);
        return;
      }
    }

    const currentTurn = game.turn();
    const move = game.move({ from, to, promotion: promotion || "q" });
    if (!move) { showToast("Movimiento ilegal"); selected = null; legalTargets = []; render(); return }
    clockLastUpdate = performance.now();

    // Aplicar incremento de tiempo
    if (currentTurn === "w") whiteTime += increment;
    else blackTime += increment;

    selected = null;
    legalTargets = [];
    premoveMode = false;
    pendingPremove = null;
    redoStack = [];

    clearDraw(); sendPayload({ type: "move", move: { from: move.from, to: move.to, promotion: move.promotion || undefined }, whiteTime, blackTime });
    if (!persistentMarks) { marks.clear(); arrows = [] }
    render();
    broadcastLiveMatch();
    if (!noAnim) animateMove(move, false);
    if (botEnabled && !fromBot && game.turn() === botColor) window.setTimeout(makeBotMove, 180);
  }

  function openPromotion(color, forPremove = false) {
    const modal = $("promotionModal"), choices = $("promotionChoices");
    modal.querySelector("h3").textContent = forPremove ? "Elige la promoción del premove" : "Coronar peón";
    choices.innerHTML = "";
    ["q", "r", "b", "n"].forEach(type => {
      const b = document.createElement("button");
      b.className = "promo"; b.title = pieceNames[type];
      b.innerHTML = '<img src="' + PIECE_FOR("promotion", color, type) + '" alt="' + pieceNames[type] + '">';
      b.onclick = () => {
        modal.style.display = "none";
        if (forPremove && pendingPremove) {
          pendingPremove.promotion = type;
          if (game.turn() === myColor) executePremove();
          else render();
          return;
        }
        if (pendingPromotion) {
          const m = pendingPromotion;
          pendingPromotion = null;
          tryMove(m.from, m.to, type, m.noAnim);
        }
      };
      choices.appendChild(b);
    });
    modal.style.display = "flex";
  }

  function renderMoves() {
    const el = $("moves"), h = game.history({ verbose: true });
    el.innerHTML = "";
    if (!h.length) {
      el.innerHTML = '<div class="empty">La partida no ha comenzado.</div>';
      return;
    }
    const currentPly = historyPly !== null ? historyPly : h.length;

    for (let i = 0; i < h.length; i += 2) {
      const no = document.createElement("div");
      no.className = "move-no";
      no.textContent = (i / 2 + 1) + ".";
      el.appendChild(no);
      for (let j = i; j < Math.min(i + 2, h.length); j++) {
        const b = document.createElement("button");
        b.className = "move " + (currentPly === j + 1 ? "current" : "");
        b.textContent = h[j].san;
        if (reviewing && report && report.rows[j]) { const dt = document.createElement("i"); dt.className = "rv-dot"; dt.style.background = CATS[report.rows[j].key].color; b.prepend(dt) }
        const plyTarget = j + 1;
        b.onclick = () => goPly(plyTarget);
        el.appendChild(b);
      }
      if (i + 1 >= h.length) el.appendChild(document.createElement("span"));
    }
    const curEl = el.querySelector(".move.current");
    if (reviewing && curEl) { const cr = curEl.getBoundingClientRect(), er = el.getBoundingClientRect(); el.scrollTop += cr.top - er.top - er.height / 2 + cr.height / 2 }
    else el.scrollTop = el.scrollHeight;
  }

  function timedOut() { return timed && (whiteTime <= 0 || blackTime <= 0) }
  function renderStatus() {
    let text = game.turn() === "w" ? "Mueven blancas" : "Mueven negras";
    if (timedOut()) {
      if (game.isInsufficientMaterial()) text = "Tablas por insuficiencia de material";
      else text = (whiteTime <= 0 ? "Negras" : "Blancas") + " ganan por tiempo";
    } else if (game.isCheckmate()) text = "Jaque mate · ganan " + (game.turn() === "w" ? "negras" : "blancas");
    else if (game.isStalemate()) text = "Tablas por ahogado";
    else if (game.isThreefoldRepetition()) text = "Tablas por repetición";
    else if (game.isInsufficientMaterial()) text = "Tablas por material insuficiente";
    else if (game.isDraw()) text = "Tablas";
    else if (game.inCheck()) text += " · Jaque";
    $("statusText").textContent = text;

    const top = flipped ? "w" : "b", bot = flipped ? "b" : "w";
    const sideInfo = c => {
      if (botEnabled) {
        const isBot = c === botColor;
        return {
          name: playerDisplayName(c),
          elo: isBot ? "Elo " + botElo : getEloText(myName)
        };
      }
      if (myColor) {
        const name = playerDisplayName(c);
        return { name, elo: getEloText(name) };
      }
      return { name: playerDisplayName(c), elo: "" };
    };

    const topData = sideInfo(top), bottomData = sideInfo(bot);
    $("topName").textContent = topData.name; $("bottomName").textContent = bottomData.name;
    const topIsBot = botEnabled && top === botColor, bottomIsBot = botEnabled && bot === botColor;
    const usePieceAvatars = !botEnabled && !myColor;
    setPlayerAvatar($("topAvatar"), topData.name, top, topIsBot, topIsBot ? botAvatarSeed(botElo) : topData.name, usePieceAvatars);
    setPlayerAvatar($("bottomAvatar"), bottomData.name, bot, bottomIsBot, bottomIsBot ? botAvatarSeed(botElo) : bottomData.name, usePieceAvatars);
  }

  function renderCaptured(g) {
    const val = { p: 1, n: 3, b: 3, r: 5, q: 9 };
    const pieceNamesEs = { p: "peón", n: "caballo", b: "alfil", r: "torre", q: "dama" };
    const captured = { w: [], b: [] }, score = { w: 0, b: 0 };
    g.history({ verbose: true }).forEach(move => {
      if (!move.captured) return;
      captured[move.color].push({ color: move.color === "w" ? "b" : "w", type: move.captured });
      score[move.color] += val[move.captured] || 0;
    });
    const top = flipped ? "w" : "b", bot = flipped ? "b" : "w";
    [["top", top], ["bottom", bot]].forEach(([k, c]) => {
      const isOpponent = myColor ? c !== myColor : c === top;
      const elo = (() => {
        const info = botEnabled ? (c === botColor ? { name: botProfileByElo(botElo).name, elo: "Elo " + botElo } : { name: normalizeName(myName, "Yo"), elo: getEloText(myName) }) : myColor ? (c === myColor ? { name: normalizeName(myName, "Yo"), elo: getEloText(myName) } : { name: normalizeName(activeOpponentName || "Rival", "Rival"), elo: getEloText(activeOpponentName || "Rival") }) : { name: c === "w" ? "Blancas" : "Negras", elo: "" };
        return info.elo;
      })();
      const pieces = $(k + "MaterialPieces");
      pieces.replaceChildren();
      const order = { q: 0, r: 1, b: 2, n: 3, p: 4 };
      const orderDirection = isOpponent ? -1 : 1;
      let groupKey = "";
      let group;
      captured[c].sort((a, b) => orderDirection * (order[a.type] - order[b.type]) || a.color.localeCompare(b.color)).forEach(piece => {
        const key = piece.color + piece.type;
        if (key !== groupKey) {
          groupKey = key;
          group = document.createElement("div");
          group.className = "material-piece-group";
          pieces.appendChild(group);
        }
        const image = document.createElement("img");
        image.className = "material-piece";
        image.src = PIECE(piece.color, piece.type);
        image.alt = pieceNamesEs[piece.type] || "";
        image.title = image.alt;
        group.appendChild(image);
        if (group.children.length === 4) group.classList.add("material-piece-group-dense");
      });
      if (!captured[c].length) {
        const empty = document.createElement("span");
        empty.className = "material-empty";
        empty.textContent = "Sin capturas";
        pieces.appendChild(empty);
      }
      $(k + "MaterialName").textContent = $(k + "Name").textContent;
      const advantage = score[c] - score[c === "w" ? "b" : "w"];
      $(k + "MaterialTotal").textContent = advantage > 0 ? "+" + advantage : "";
      $(k + "Cap").innerHTML = elo ? '<span class="elo">' + elo + '</span>' : "";
    });
  }

  const MARK_SETTINGS_KEY = "aj_mark_settings";
  let markSettings = {};
  try { markSettings = JSON.parse(store.get(MARK_SETTINGS_KEY) || "{}") || {} } catch (_) { markSettings = {} }
  let markColor = /^#[0-9a-f]{6}$/i.test(markSettings.color || "") ? markSettings.color : "#e34f4f";
  let persistentMarks = markSettings.persistent === true;
  $("markColorInput").value = markColor;
  $("persistentMarksInput").checked = persistentMarks;
  function saveMarkSettings() { try { store.set(MARK_SETTINGS_KEY, JSON.stringify({ color: markColor, persistent: persistentMarks })) } catch (_) { } }
  $("markColorInput").oninput = () => {
    markColor = $("markColorInput").value;
    marks.forEach((_, square) => marks.set(square, markColor));
    arrows = arrows.map(arrow => ({ ...arrow, color: markColor }));
    saveMarkSettings(); drawAnnotations();
  };
  $("persistentMarksInput").onchange = () => { persistentMarks = $("persistentMarksInput").checked; saveMarkSettings() };
  $("premovesInput").checked = premovesEnabled;
  $("premovesInput").onchange = () => {
    premovesEnabled = $("premovesInput").checked;
    store.set("ajedrez.premoves", String(premovesEnabled));
    if (!premovesEnabled) { pendingPremove = null; premoveMode = false; selected = null; legalTargets = []; render() }
  };
  function toggleMark(name) {
    marks.has(name) ? marks.delete(name) : marks.set(name, markColor);
    drawAnnotations();
  }

  /* ---------- Dibujar Flechas (en L para Caballos) y Puntas Ajustadas ---------- */
  function drawAnnotations() {
    const svg = $("overlay");
    svg.innerHTML = "";
    const NS = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(NS, "defs");

    // Marcador de cabeza de flecha elegante y proporcional
    const marker = document.createElementNS(NS, "marker");
    marker.setAttribute("id", "arrowhead");
    marker.setAttribute("markerWidth", "4");
    marker.setAttribute("markerHeight", "4");
    marker.setAttribute("refX", "2.5");
    marker.setAttribute("refY", "2");
    marker.setAttribute("orient", "auto");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", "M0,0 L4,2 L0,4 Z");
    path.setAttribute("fill", markColor);
    marker.appendChild(path);
    defs.appendChild(marker);
    const marker2 = marker.cloneNode(true); marker2.setAttribute("id", "arrowhead-rv"); marker2.firstChild.setAttribute("fill", "#4aa3ff"); defs.appendChild(marker2);
    svg.appendChild(defs);

    const center = n => {
      const c = coords(n);
      return { x: c.x * 100 + 50, y: c.y * 100 + 50 };
    };

    marks.forEach((color, n) => {
      const c = center(n), r = document.createElementNS(NS, "rect");
      r.setAttribute("x", c.x - 50); r.setAttribute("y", c.y - 50);
      r.setAttribute("width", 100); r.setAttribute("height", 100);
      r.setAttribute("fill", color); r.setAttribute("opacity", ".35");
      svg.appendChild(r);
    });

    [...arrows, ...reviewArrows()].forEach(a => {
      const s = center(a.from), e = center(a.to);
      const sf = files.indexOf(a.from[0]), sr = Number(a.from[1]);
      const ef = files.indexOf(a.to[0]), er = Number(a.to[1]);
      const df = Math.abs(sf - ef), dr = Math.abs(sr - er);

      // Si es un movimiento en L de Caballo (1x2 o 2x1)
      if ((df === 1 && dr === 2) || (df === 2 && dr === 1)) {
        // Calcular punto de quiebre de la L
        let corner = (df === 1) ? { x: s.x, y: e.y } : { x: e.x, y: s.y };
        const pathEl = document.createElementNS(NS, "path");
        const dStr = `M ${s.x} ${s.y} L ${corner.x} ${corner.y} L ${e.x} ${e.y}`;
        pathEl.setAttribute("d", dStr);
        pathEl.setAttribute("fill", "none");
        pathEl.setAttribute("stroke", a.color || markColor);
        pathEl.setAttribute("stroke-width", "9");
        pathEl.setAttribute("stroke-linecap", "round");
        pathEl.setAttribute("stroke-linejoin", "round");
        pathEl.setAttribute("opacity", ".85");
        pathEl.setAttribute("marker-end", "url(#" + (a.marker || "arrowhead") + ")");
        svg.appendChild(pathEl);
      } else {
        // Flecha recta normal
        const dx = e.x - s.x, dy = e.y - s.y, len = Math.hypot(dx, dy) || 1;
        const line = document.createElementNS(NS, "line");
        line.setAttribute("x1", s.x + dx / len * 15); line.setAttribute("y1", s.y + dy / len * 15);
        line.setAttribute("x2", e.x - dx / len * 22); line.setAttribute("y2", e.y - dy / len * 22);
        line.setAttribute("stroke", a.color || markColor);
        line.setAttribute("stroke-width", "9");
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("opacity", ".85");
        line.setAttribute("marker-end", "url(#" + (a.marker || "arrowhead") + ")");
        svg.appendChild(line);
      }
    });
  }

  function flip() { flipped = !flipped; render() }

  function syncLocalTimeVisibility() {
    const wrapper = document.querySelector(".local-time");
    if (!wrapper) return;
    const started = game.history().length > 0 && !forced && !game.game_over() && !game.isDraw() && !game.isCheckmate() && !game.isStalemate() && !game.isThreefoldRepetition() && !game.isInsufficientMaterial();
    wrapper.hidden = started || online();
  }

  function applyHandicapBoard(inviterColor, value) {
    const preset = getHandicapPreset(value);
    if (!inviterColor || !preset || preset.effect === "none") {
      game.reset();
      return;
    }
    try {
      const loaded = game.load(buildHandicapFen(inviterColor, value).fen);
      if (loaded === false) throw new Error("FEN no válido");
    } catch (err) {
      console.error("Handicap personalizado no válido:", err);
      activeHandicap = "none";
      game.reset();
      showToast("La posición personalizada no es válida; se usa la inicial");
    }
    selected = null; legalTargets = []; marks.clear(); arrows = []; redoStack = []; historyPly = null; forced = null; clearDraw(); report = null; reviewing = false; endShown = false;
    try { parseTC(); syncLocalTimeVisibility(); render(); } catch (err) { console.error("Error tras aplicar el handicap:", err); }
  }
  function resetLocal() {
    if (drag) cancelDrag();
    game.reset(); selected = null; legalTargets = []; marks.clear(); arrows = []; redoStack = []; historyPly = null; forced = null; clearDraw(); report = null; reviewing = false; endShown = false;
    parseTC();
    syncLocalTimeVisibility();
    render();
  }
  function reset() {
    if (online()) { requestGameReset(); return; }
    resetLocal();
    showToast("Partida reiniciada");
    if (botEnabled && botColor === "w") window.setTimeout(makeBotMove, 180);
  }

  /* ---------- Stockfish: motor en Web Worker, bot y análisis ---------- */
  // jsDelivr bloquea (403) el paquete stockfish@19 por tamaño, así que se prueba unpkg primero y luego otras opciones
  const SF19 = "https://unpkg.com/stockfish@19.0.1/bin/stockfish-19-lite-single";
  const SF16J = "https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish-nnue-16-single";
  const SF16U = "https://unpkg.com/stockfish@16.0.0/src/stockfish-nnue-16-single";
  const ENGINES = [
    { name: "Stockfish 19 NNUE", js: SF19 + ".js", wasm: SF19 + ".wasm", modern: true },
    { name: "Stockfish 16 NNUE", js: SF16J + ".js", wasm: SF16J + ".wasm", modern: true },
    { name: "Stockfish 16 NNUE", js: SF16U + ".js", wasm: SF16U + ".wasm", modern: true },
    { name: "Stockfish 10 (respaldo)", js: "https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js", modern: false }
  ];
  let engineInfo = ENGINES[ENGINES.length - 1];
  let engineLoadErrors = [];
  async function loadEngine(cfg) {
    // Motor moderno: se descarga el .js, se le fija la ruta del .wasm y se lanza desde un blob (sin depender del hash de la URL)
    let code = 'importScripts("' + cfg.js + '");';
    if (cfg.wasm) {
      const res = await fetch(cfg.js);
      if (!res.ok) throw new Error("HTTP " + res.status + " al descargar " + cfg.js);
      const src = await res.text(), key = "self.location.hash.substr(1)";
      if (!src.includes(key)) throw new Error("versión del motor no compatible");
      code = src.split(key).join(JSON.stringify(encodeURIComponent(cfg.wasm)));
    }
    return new Promise((resolve, reject) => {
      let done = false, w;
      const fail = m => { if (done) return; done = true; clearTimeout(t); try { w && w.terminate() } catch (_) { } reject(new Error(m)) };
      const t = setTimeout(() => fail("tiempo de espera agotado"), 30000);
      try { w = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" }))) } catch (e) { return fail(e.message) }
      w.onerror = ev => fail((ev && ev.message) || "error en el worker (¿WebAssembly bloqueado o wasm no descargado?)");
      w.onmessage = e => {
        const l = String(e.data || "");
        if (l === "uciok") w.postMessage("isready");
        else if (l === "readyok" && !done) { done = true; clearTimeout(t); resolve(w) }
      };
      w.postMessage("uci");
    });
  }
  function engineMessage(event) {
    const line = String(event.data || "");
    if (line === "uciok") {
      engineWorker.postMessage("isready");
      return;
    }
    if (line === "readyok") {
      engineReady = true;
      if (engineInitResolve) { engineInitResolve(); engineInitResolve = null }
      $("engineStatus").textContent = "Stockfish listo · se ejecuta en tu navegador.";
      return;
    }
    if (activeSearch) {
      const score = line.match(/\bscore (cp|mate) (-?\d+)/);
      if (score) {
        let v = Number(score[2]);
        activeSearch.score = score[1] === "mate" ? (v > 0 ? 10000 - Math.abs(v) * 100 : -10000 + Math.abs(v) * 100) : v;
      }
      const best = line.match(/^bestmove\s+(\S+)/);
      if (best) {
        const task = activeSearch; activeSearch = null;
        if (task.timer) clearTimeout(task.timer);
        task.resolve({ move: best[1], score: task.score === null ? 0 : task.score });
      }
    }
  }
  let engineInitResolve = null;
  function ensureEngine() {
    if (engineReady) return Promise.resolve();
    if (engineInitPromise) return engineInitPromise;
    engineInitPromise = (async () => {
      $("engineStatus").textContent = "Cargando Stockfish…";
      let w = null;
      engineLoadErrors = [];
      for (const cfg of ENGINES) { try { w = await loadEngine(cfg); engineInfo = cfg; break } catch (e) { engineLoadErrors.push(cfg.name + ": " + e.message); console.warn("[Stockfish]", cfg.name, e) } }
      if (!w) { engineInitPromise = null; throw new Error("No se pudo cargar Stockfish. Comprueba la conexión a Internet o prueba desde un servidor local.") }
      engineWorker = w; engineWorker.onmessage = engineMessage;
      engineWorker.onerror = () => { engineReady = false; engineInitPromise = null; engineWorker = null; $("engineStatus").textContent = "El motor se ha detenido. Vuelve a intentarlo." };
      if (engineInfo.modern) engineWorker.postMessage("setoption name Hash value 32");
      engineReady = true;
      $("engineStatus").textContent = engineInfo.name + " listo · se ejecuta en tu navegador." + (engineInfo === ENGINES[0] ? "" : " (Stockfish 19 no ha cargado: " + engineLoadErrors[0] + ")");
      const n = $("engineNote"); if (n) n.textContent = engineInfo.name + " · GPL-3.0. Necesita Internet para descargar el motor; el cálculo se hace en tu dispositivo.";
    })();
    return engineInitPromise;
  }
  async function engineSearch(fen, depth, skill = 10, movetime = 0) {
    await ensureEngine();
    if (activeSearch) throw new Error("El motor ya está calculando otra posición.");
    engineWorker.postMessage("setoption name Skill Level value " + Math.max(0, Math.min(20, skill)));
    engineWorker.postMessage("position fen " + fen);
    return new Promise((resolve, reject) => {
      const task = { resolve, reject, score: null, timer: null };
      activeSearch = task;
      task.timer = setTimeout(() => {
        if (activeSearch !== task) return;
        // Never leave the UI waiting forever for a stuck UCI search.
        engineWorker.postMessage("stop");
        task.timer = setTimeout(() => { if (activeSearch === task) { activeSearch = null; resolve({ move: "(none)", score: task.score === null ? 0 : task.score }) } }, 1800);
      }, movetime ? movetime + 2500 : 15000);
      engineWorker.postMessage(movetime ? "go movetime " + movetime : "go depth " + depth);
    });
  }
  function uciToMove(uci) {
    if (!uci || uci === "(none)" || uci === "0000") return null;
    return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" };
  }
  async function makeBotMove() {
    if (!botEnabled || botThinking || game.game_over() || forced || game.turn() !== botColor || online()) return;
    botThinking = true;
    $("engineStatus").textContent = "El bot está pensando…";
    try {
      const result = await engineSearch(game.fen(), botSkill <= 3 ? 7 : botSkill <= 6 ? 9 : botSkill <= 10 ? 10 : 11, botSkill, engineInfo.modern ? 250 + botSkill * 40 : 0);
      if (!botEnabled || game.turn() !== botColor || game.game_over()) return;
      const m = uciToMove(result.move);
      if (!m) { showToast("El bot no ha encontrado una jugada válida"); return }
      botThinking = false;
      tryMove(m.from, m.to, m.promotion, true, true);
      $("engineStatus").textContent = "Bot activo · " + botProfileByElo(botElo).name + " · Elo " + botElo + ".";
    } catch (e) { showToast(e.message || "Error al ejecutar Stockfish"); $("engineStatus").textContent = e.message || "Error al cargar el motor." }
    finally { botThinking = false }
  }
  function eloToBotSkill(elo) {
    return Math.max(0, Math.min(20, Math.round((Math.max(100, Math.min(3000, Number(elo) || 1200)) - 100) / 140)));
  }
  async function startBotGame(opts = {}) {
    if (analysisRunning) { showToast("Espera a que termine o detén el análisis primero"); return }
    if (online() && !confirm("Se cerrará la partida online actual para empezar una partida contra el bot. ¿Continuar?")) return;
    if (peerJSConn) { try { peerJSConn.close() } catch (_) { } peerJSConn = null }
    if (peerJSInstance) { try { peerJSInstance.destroy() } catch (_) { } peerJSInstance = null }
    role = null; myColor = null; botEnabled = false; botThinking = false;
    botElo = Number(opts.elo || $("botLevel").value) || 1200;
    botSkill = eloToBotSkill(botElo);
    const side = opts.side || $("botSide").value || "r";
    const playerColor = side === "r" ? (Math.random() < .5 ? "w" : "b") : side;
    botColor = playerColor === "w" ? "b" : "w";
    flipped = playerColor === "b";
    const botProfile = botProfileByElo(botElo);
    $("connText").textContent = "Partida local contra " + botProfile.name + " · Elo " + botElo;
    $("connDot").className = "status-dot";
    $("chatInput").disabled = true; $("chatSend").disabled = true;
    $("chatLog").innerHTML = '<div class="msg sys">Partida local contra ' + botProfile.name + '.</div>';
    parseTC("0+0");
    resetLocal();
    botEnabled = true;
    $("engineResults").innerHTML = "";
    $("engineStatus").textContent = "Cargando Stockfish…";
    showTab("moves"); render();
    try {
      await ensureEngine();
      $("engineStatus").textContent = "Partida contra " + botProfile.name + " iniciada · Elo " + botElo + ".";
      if (botColor === "w") makeBotMove();
    } catch (e) { botEnabled = false; showToast(e.message || "No se pudo cargar Stockfish"); $("engineStatus").textContent = e.message || "No se pudo cargar Stockfish." }
  }
  $("analyzeBtn").onclick = analyzeGame;
  function stopCurrentAnalysis() {
    analysisCancelled = true;
    if (engineWorker && activeSearch) engineWorker.postMessage("stop");
    $("stopAnalyzeBtn").disabled = true; $("endStopAnalyze").disabled = true;
    analysisStatus().textContent = "Deteniendo el análisis…";
  }
  $("stopAnalyzeBtn").onclick = stopCurrentAnalysis;
  $("endStopAnalyze").onclick = stopCurrentAnalysis;
  function analysisStatus() { return $("endModal").style.display === "flex" && $("endAnalysis").hidden === false ? $("endAnalysisStatus") : $("engineStatus") }
  function analysisResults() { return $("endModal").style.display === "flex" && $("endAnalysis").hidden === false ? $("endAnalysisResults") : $("engineResults") }
  /* ---------- Análisis: clasificación, informe y walkthrough ---------- */
  const CATS = {
    brilliant: { label: "Brillante", plural: "Brillantes", color: "#26c9a2", icon: "!!", desc: "Un sacrificio que mantiene o mejora tu posición. Difícil de ver." },
    best: { label: "Mejor jugada", plural: "Mejores", color: "#81b64c", icon: "★", desc: "Es la jugada que prefiere el motor." },
    excellent: { label: "Excelente", plural: "Excelentes", color: "#a3d160", icon: "!", desc: "Casi tan buena como la mejor opción." },
    good: { label: "Buena", plural: "Buenas", color: "#7fb0d9", icon: "✓", desc: "Una jugada correcta que no compromete la posición." },
    inaccuracy: { label: "Imprecisión", plural: "Imprecisiones", color: "#f7c631", icon: "?!", desc: "Había opciones mejores, aunque la posición sigue siendo jugable." },
    mistake: { label: "Error", plural: "Errores", color: "#e8912d", icon: "?", desc: "Cede una parte importante de la ventaja." },
    blunder: { label: "Error grave", plural: "Errores graves", color: "#ca3431", icon: "??", desc: "Cambia el rumbo de la partida de golpe." },
    missed: { label: "Omisión de victoria", plural: "Omisiones", color: "#b34ea3", icon: "✗", desc: "Tenías una posición ganadora y la has soltado." }
  };
  // Iconos de puntuación (SVG incrustados)
  const CAT_ICONS = {"brilliant": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGNsYXNzPSIiIHZpZXdCb3g9IjAgMCAxOCAxOSI+PGcgaWQ9IkJyaWxsaWFudCI+PHBhdGggY2xhc3M9Imljb24tc2hhZG93IiBvcGFjaXR5PSIwLjMiIGQ9Ik05LC41YTksOSwwLDEsMCw5LDlBOSw5LDAsMCwwLDksLjVaIj48L3BhdGg+PHBhdGggY2xhc3M9Imljb24tYmFja2dyb3VuZCIgZmlsbD0iIzFiYWRhNiIgZD0iTTksMGE5LDksMCwxLDAsOSw5QTksOSwwLDAsMCw5LDBaIj48L3BhdGg+PGcgY2xhc3M9Imljb24tY29tcG9uZW50LXNoYWRvdyIgb3BhY2l0eT0iMC4yIj48cGF0aCBkPSJNMTIuNTcsMTQuNmEuNTEuNTEsMCwwLDEsMCwuMTMuNDQuNDQsMCwwLDEtLjA4LjExbC0uMTEuMDgtLjEzLDBoLTJsLS4xMywwTDEwLDE0Ljg0QS40MS40MSwwLDAsMSwxMCwxNC42VjEyLjdhLjMyLjMyLDAsMCwxLC4wOS0uMjMuMzkuMzksMCwwLDEsLjEtLjA4bC4xMywwaDJhLjMxLjMxLDAsMCwxLC4yNC4xLjM5LjM5LDAsMCwxLC4wOC4xLjUxLjUxLDAsMCwxLDAsLjEzWm0tLjEyLTMuOTNhLjE3LjE3LDAsMCwxLDAsLjEyLjQxLjQxLDAsMCwxLS4wNy4xMS40LjQsMCwwLDEtLjIzLjA4SDEwLjM1YS4zMS4zMSwwLDAsMS0uMzQtLjMxTDkuODYsMy45QS4zNi4zNiwwLDAsMSwxMCwzLjY2YS4yMy4yMywwLDAsMSwuMTEtLjA4LjI3LjI3LDAsMCwxLC4xMywwSDEyLjNhLjMyLjMyLDAsMCwxLC4yNS4xLjM2LjM2LDAsMCwxLC4wOS4yNFoiPjwvcGF0aD48cGF0aCBkPSJNOC4wNywxNC42YS41MS41MSwwLDAsMSwwLC4xMy40NC40NCwwLDAsMS0uMDguMTFsLS4xMS4wOC0uMTMsMGgtMmwtLjEzLDAtLjExLS4wOGEuNDEuNDEsMCwwLDEtLjA4LS4yNFYxMi43YS4yNy4yNywwLDAsMSwwLS4xMy4zNi4zNiwwLDAsMSwuMDctLjEuMzkuMzksMCwwLDEsLjEtLjA4bC4xMywwaDJhLjMxLjMxLDAsMCwxLC4yNC4xLjM5LjM5LDAsMCwxLC4wOC4xLjUxLjUxLDAsMCwxLDAsLjEzWk04LDEwLjY3YS4xNy4xNywwLDAsMSwwLC4xMi40MS40MSwwLDAsMS0uMDcuMTEuNC40LDAsMCwxLS4yMy4wOEg1Ljg1YS4zMS4zMSwwLDAsMS0uMzQtLjMxTDUuMzYsMy45YS4zNi4zNiwwLDAsMSwuMDktLjI0LjIzLjIzLDAsMCwxLC4xMS0uMDguMjcuMjcsMCwwLDEsLjEzLDBINy44YS4zNS4zNSwwLDAsMSwuMjUuMS4zNi4zNiwwLDAsMSwuMDkuMjRaIj48L3BhdGg+PC9nPjxnPjxwYXRoIGNsYXNzPSJpY29uLWNvbXBvbmVudCIgZmlsbD0iI2ZmZiIgZD0iTTEyLjU3LDE0LjFhLjUxLjUxLDAsMCwxLDAsLjEzLjQ0LjQ0LDAsMCwxLS4wOC4xMWwtLjExLjA4LS4xMywwaC0ybC0uMTMsMEwxMCwxNC4zNEEuNDEuNDEsMCwwLDEsMTAsMTQuMVYxMi4yQS4zMi4zMiwwLDAsMSwxMCwxMmEuMzkuMzksMCwwLDEsLjEtLjA4bC4xMywwaDJhLjMxLjMxLDAsMCwxLC4yNC4xLjM5LjM5LDAsMCwxLC4wOC4xLjUxLjUxLDAsMCwxLDAsLjEzWm0tLjEyLTMuOTNhLjE3LjE3LDAsMCwxLDAsLjEyLjQxLjQxLDAsMCwxLS4wNy4xMS40LjQsMCwwLDEtLjIzLjA4SDEwLjM1YS4zMS4zMSwwLDAsMS0uMzQtLjMxTDkuODYsMy40QS4zNi4zNiwwLDAsMSwxMCwzLjE2YS4yMy4yMywwLDAsMSwuMTEtLjA4LjI3LjI3LDAsMCwxLC4xMywwSDEyLjNhLjMyLjMyLDAsMCwxLC4yNS4xLjM2LjM2LDAsMCwxLC4wOS4yNFoiPjwvcGF0aD48cGF0aCBjbGFzcz0iaWNvbi1jb21wb25lbnQiIGZpbGw9IiNmZmYiIGQ9Ik04LjA3LDE0LjFhLjUxLjUxLDAsMCwxLDAsLjEzLjQ0LjQ0LDAsMCwxLS4wOC4xMWwtLjExLjA4LS4xMywwaC0ybC0uMTMsMC0uMTEtLjA4YS40MS40MSwwLDAsMS0uMDgtLjI0VjEyLjJhLjI3LjI3LDAsMCwxLDAtLjEzLjM2LjM2LDAsMCwxLC4wNy0uMS4zOS4zOSwwLDAsMSwuMS0uMDhsLjEzLDBoMkEuMzEuMzEsMCwwLDEsOCwxMmEuMzkuMzksMCwwLDEsLjA4LjEuNTEuNTEsMCwwLDEsMCwuMTNaTTgsMTAuMTdhLjE3LjE3LDAsMCwxLDAsLjEyLjQxLjQxLDAsMCwxLS4wNy4xMS40LjQsMCwwLDEtLjIzLjA4SDUuODVhLjMxLjMxLDAsMCwxLS4zNC0uMzFMNS4zNiwzLjRhLjM2LjM2LDAsMCwxLC4wOS0uMjQuMjMuMjMsMCwwLDEsLjExLS4wOC4yNy4yNywwLDAsMSwuMTMsMEg3LjhhLjM1LjM1LDAsMCwxLC4yNS4xLjM2LjM2LDAsMCwxLC4wOS4yNFoiPjwvcGF0aD48L2c+PC9nPjwvc3ZnPg==", "best": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGNsYXNzPSIiIHZpZXdCb3g9IjAgMCAxOCAxOSI+PGcgaWQ9ImJlc3QiPjxwYXRoIGNsYXNzPSJpY29uLXNoYWRvdyIgb3BhY2l0eT0iMC4zIiBkPSJNOSwuNWE5LDksMCwxLDAsOSw5QTksOSwwLDAsMCw5LC41WiI+PC9wYXRoPjxwYXRoIGNsYXNzPSJpY29uLWJhY2tncm91bmQiIGZpbGw9IiM5NmJjNGIiIGQ9Ik05LDBhOSw5LDAsMSwwLDksOUE5LDksMCwwLDAsOSwwWiI+PC9wYXRoPjxwYXRoIGNsYXNzPSJpY29uLWNvbXBvbmVudC1zaGFkb3ciIG9wYWNpdHk9IjAuMiIgZD0iTTksMy40M2EuNS41LDAsMCwwLS4yNy4wOC40Ni40NiwwLDAsMC0uMTcuMjJMNy4yNCw3LjE3bC0zLjY4LjE5YS41Mi41MiwwLDAsMC0uMjYuMS41My41MywwLDAsMC0uMTYuMjMuNDUuNDUsMCwwLDAsMCwuMjguNDQuNDQsMCwwLDAsLjE1LjIzbDIuODYsMi4zMi0xLDMuNTZhLjQ1LjQ1LDAsMCwwLDAsLjI4LjQ2LjQ2LDAsMCwwLC4xNy4yMi40MS40MSwwLDAsMCwuMjYuMDkuNDMuNDMsMCwwLDAsLjI3LS4wOGwzLjA5LTIsMy4wOSwyYS40Ni40NiwwLDAsMCwuNTMsMCwuNDYuNDYsMCwwLDAsLjE3LS4yMi41My41MywwLDAsMCwwLS4yOGwtMS0zLjU2TDE0LjcxLDguMkEuNDQuNDQsMCwwLDAsMTQuODYsOGEuNDUuNDUsMCwwLDAsMC0uMjguNTMuNTMsMCwwLDAtLjE2LS4yMy41Mi41MiwwLDAsMC0uMjYtLjFsLTMuNjgtLjJMOS40NCwzLjczYS40Ni40NiwwLDAsMC0uMTctLjIyQS41LjUsMCwwLDAsOSwzLjQzWiI+PC9wYXRoPjxwYXRoIGNsYXNzPSJpY29uLWNvbXBvbmVudCIgZmlsbD0iI2ZmZiIgZD0iTTksMi45M0EuNS41LDAsMCwwLDguNzMsM2EuNDYuNDYsMCwwLDAtLjE3LjIyTDcuMjQsNi42N2wtMy42OC4xOUEuNTIuNTIsMCwwLDAsMy4zLDdhLjUzLjUzLDAsMCwwLS4xNi4yMy40NS40NSwwLDAsMCwwLC4yOC40NC40NCwwLDAsMCwuMTUuMjNMNi4xNSwxMGwtMSwzLjU2YS40NS40NSwwLDAsMCwwLC4yOC40Ni40NiwwLDAsMCwuMTcuMjIuNDEuNDEsMCwwLDAsLjI2LjA5LjQzLjQzLDAsMCwwLC4yNy0uMDhsMy4wOS0yLDMuMDksMmEuNDYuNDYsMCwwLDAsLjUzLDAsLjQ2LjQ2LDAsMCwwLC4xNy0uMjIuNTMuNTMsMCwwLDAsMC0uMjhsLTEtMy41NkwxNC43MSw3LjdhLjQ0LjQ0LDAsMCwwLC4xNS0uMjMuNDUuNDUsMCwwLDAsMC0uMjhBLjUzLjUzLDAsMCwwLDE0LjcsN2EuNTIuNTIsMCwwLDAtLjI2LS4xbC0zLjY4LS4yTDkuNDQsMy4yM0EuNDYuNDYsMCwwLDAsOS4yNywzLC41LjUsMCwwLDAsOSwyLjkzWiI+PC9wYXRoPjwvZz48L3N2Zz4=", "excellent": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGNsYXNzPSIiIHZpZXdCb3g9IjAgMCAxOCAxOSI+PGcgaWQ9ImV4Y2VsbGVudCI+PGc+PHBhdGggY2xhc3M9Imljb24tc2hhZG93IiBvcGFjaXR5PSIwLjMiIGQ9Ik05LC41YTksOSwwLDEsMCw5LDlBOSw5LDAsMCwwLDksLjVaIj48L3BhdGg+PHBhdGggY2xhc3M9Imljb24tYmFja2dyb3VuZCIgZmlsbD0iIzk2YmM0YiIgZD0iTTksMGE5LDksMCwxLDAsOSw5QTksOSwwLDAsMCw5LDBaIj48L3BhdGg+PC9nPjxnIGNsYXNzPSJpY29uLWNvbXBvbmVudC1zaGFkb3ciIG9wYWNpdHk9IjAuMiI+PHBhdGggZD0iTTEzLjc5LDExLjM0YzAtLjIuNC0uNTMuNC0uOTRTMTQsOS43MiwxNCw5LjU4YTIuMDYsMi4wNiwwLDAsMCwuMTgtLjgzLDEsMSwwLDAsMC0uMy0uNjksMS4xMywxLjEzLDAsMCwwLS41NS0uMiwxMC4yOSwxMC4yOSwwLDAsMS0yLjA3LDBjLS4zNy0uMjMsMC0xLjE4LjE4LTEuN1MxMS45LDQsMTAuNjIsMy43Yy0uNjktLjE3LS42Ni4zNy0uNzguOS0uMDUuMjEtLjA5LjQzLS4xMy41N0E1LDUsMCwwLDEsNy4wNSw4LjIzYTEuNTcsMS41NywwLDAsMS0uNDIuMTh2NC45NEE3LjIzLDcuMjMsMCwwLDEsOCwxMy41M2MuNTIuMTIuOTEuMjUsMS40NC4zM0ExMS4xMSwxMS4xMSwwLDAsMCwxMSwxNGE2LjY1LDYuNjUsMCwwLDAsMS4xOCwwLDEuMDksMS4wOSwwLDAsMCwxLS41OS42Ni42NiwwLDAsMCwuMDYtLjIsMS42MywxLjYzLDAsMCwxLC4wNy0uM2MuMTMtLjI4LjM3LS4zLjUtLjY4UzEzLjc0LDExLjUzLDEzLjc5LDExLjM0WiI+PC9wYXRoPjxwYXRoIGQ9Ik01LjQ5LDguMDlINC4zMWEuNS41LDAsMCwwLS41LjV2NC41NmEuNS41LDAsMCwwLC41LjVINS40OWEuNS41LDAsMCwwLC41LS41VjguNTlBLjUuNSwwLDAsMCw1LjQ5LDguMDlaIj48L3BhdGg+PC9nPjxnPjxwYXRoIGNsYXNzPSJpY29uLWNvbXBvbmVudCIgZmlsbD0iI2ZmZiIgZD0iTTEzLjc5LDEwLjg0YzAtLjIuNC0uNTMuNC0uOTRTMTQsOS4yMiwxNCw5LjA4YTIuMDYsMi4wNiwwLDAsMCwuMTgtLjgzLDEsMSwwLDAsMC0uMy0uNjksMS4xMywxLjEzLDAsMCwwLS41NS0uMiwxMC4yOSwxMC4yOSwwLDAsMS0yLjA3LDBjLS4zNy0uMjMsMC0xLjE4LjE4LTEuN3MuNTEtMi4xMi0uNzctMi40M2MtLjY5LS4xNy0uNjYuMzctLjc4LjktLjA1LjIxLS4wOS40My0uMTMuNTdBNSw1LDAsMCwxLDcuMDUsNy43M2ExLjU3LDEuNTcsMCwwLDEtLjQyLjE4djQuOTRBNy4yMyw3LjIzLDAsMCwxLDgsMTNjLjUyLjEyLjkxLjI1LDEuNDQuMzNhMTEuMTEsMTEuMTEsMCwwLDAsMS42Mi4xNiw2LjY1LDYuNjUsMCwwLDAsMS4xOCwwLDEuMDksMS4wOSwwLDAsMCwxLS41OS42Ni42NiwwLDAsMCwuMDYtLjIsMS42MywxLjYzLDAsMCwxLC4wNy0uM2MuMTMtLjI4LjM3LS4zLjUtLjY4UzEzLjc0LDExLDEzLjc5LDEwLjg0WiI+PC9wYXRoPjxwYXRoIGNsYXNzPSJpY29uLWNvbXBvbmVudCIgZmlsbD0iI2ZmZiIgZD0iTTUuNDksNy41OUg0LjMxYS41LjUsMCwwLDAtLjUuNXY0LjU2YS41LjUsMCwwLDAsLjUuNUg1LjQ5YS41LjUsMCwwLDAsLjUtLjVWOC4wOUEuNS41LDAsMCwwLDUuNDksNy41OVoiPjwvcGF0aD48L2c+PC9nPjwvc3ZnPg==", "good": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGNsYXNzPSIiIHZpZXdCb3g9IjAgMCAxOCAxOSI+PGcgaWQ9Imdvb2QiPjxnPjxwYXRoIGNsYXNzPSJpY29uLXNoYWRvdyIgb3BhY2l0eT0iMC4zIiBkPSJNOSwuNWE5LDksMCwxLDAsOSw5QTksOSwwLDAsMCw5LC41WiI+PC9wYXRoPjxwYXRoIGNsYXNzPSJpY29uLWJhY2tncm91bmQiIGZpbGw9IiM5NmFmOGIiIGQ9Ik05LDBhOSw5LDAsMSwwLDksOUE5LDksMCwwLDAsOSwwWiI+PC9wYXRoPjwvZz48Zz48cGF0aCBjbGFzcz0iaWNvbi1jb21wb25lbnQtc2hhZG93IiBvcGFjaXR5PSIwLjIiIGQ9Ik0xNS4xMSw2LjgxLDkuNDUsMTIuNDcsNy43OSwxNC4xM2EuMzkuMzksMCwwLDEtLjI4LjExLjM5LjM5LDAsMCwxLS4yNy0uMTFMMi44OSw5Ljc4YS4zOS4zOSwwLDAsMS0uMTEtLjI4LjM5LjM5LDAsMCwxLC4xMS0uMjdMNC4yOCw3Ljg1YS4zNC4zNCwwLDAsMSwuMTItLjA5bC4xNSwwYS4zNy4zNywwLDAsMSwuMTUsMCwuMzguMzgsMCwwLDEsLjEzLjA5bDIuNjksMi42OCw1LjY1LTUuNjVhLjM4LjM4LDAsMCwxLC4xMy0uMDkuMzcuMzcsMCwwLDEsLjE1LDAsLjQuNCwwLDAsMSwuMTUsMCwuMzQuMzQsMCwwLDEsLjEyLjA5bDEuMzksMS4zOGEuNDEuNDEsMCwwLDEsLjA4LjEzLjMzLjMzLDAsMCwxLDAsLjE1LjQuNCwwLDAsMSwwLC4xNUEuNS41LDAsMCwxLDE1LjExLDYuODFaIj48L3BhdGg+PHBhdGggY2xhc3M9Imljb24tY29tcG9uZW50IiBmaWxsPSIjZmZmIiBkPSJNMTUuMTEsNi4zMSw5LjQ1LDEyLDcuNzksMTMuNjNhLjM5LjM5LDAsMCwxLS4yOC4xMS4zOS4zOSwwLDAsMS0uMjctLjExTDIuODksOS4yOEEuMzkuMzksMCwwLDEsMi43OCw5YS4zOS4zOSwwLDAsMSwuMTEtLjI3TDQuMjgsNy4zNWEuMzQuMzQsMCwwLDEsLjEyLS4wOWwuMTUsMGEuMzcuMzcsMCwwLDEsLjE1LDAsLjM4LjM4LDAsMCwxLC4xMy4wOUw3LjUyLDEwbDUuNjUtNS42NWEuMzguMzgsMCwwLDEsLjEzLS4wOS4zNy4zNywwLDAsMSwuMTUsMCwuNC40LDAsMCwxLC4xNSwwLC4zNC4zNCwwLDAsMSwuMTIuMDlsMS4zOSwxLjM4YS40MS40MSwwLDAsMSwuMDguMTMuMzMuMzMsMCwwLDEsMCwuMTUuNC40LDAsMCwxLDAsLjE1QS41LjUsMCwwLDEsMTUuMTEsNi4zMVoiPjwvcGF0aD48L2c+PC9nPjwvc3ZnPg==", "inaccuracy": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGNsYXNzPSIiIHZpZXdCb3g9IjAgMCAxOCAxOSI+PGcgaWQ9ImluYWNjdXJhY3kiPjxwYXRoIGNsYXNzPSJpY29uLXNoYWRvdyIgb3BhY2l0eT0iMC4zIiBkPSJNOSwuNWE5LDksMCwxLDAsOSw5QTksOSwwLDAsMCw5LC41WiI+PC9wYXRoPjxwYXRoIGNsYXNzPSJpY29uLWJhY2tncm91bmQiIGZpbGw9IiNmN2MwNDUiIGQ9Ik05LDBhOSw5LDAsMSwwLDksOUE5LDksMCwwLDAsOSwwWiI+PC9wYXRoPjxnIGNsYXNzPSJpY29uLWNvbXBvbmVudC1zaGFkb3ciIG9wYWNpdHk9IjAuMiI+PHBhdGggZD0iTTEzLjY2LDE0LjhhLjI4LjI4LDAsMCwxLDAsLjEzLjIzLjIzLDAsMCwxLS4wOC4xMS4yOC4yOCwwLDAsMS0uMTEuMDhsLS4xMiwwaC0ybC0uMTMsMGEuMjcuMjcsMCwwLDEtLjEtLjA4QS4zNi4zNiwwLDAsMSwxMSwxNC44VjEyLjlhLjU5LjU5LDAsMCwxLDAtLjEzLjM2LjM2LDAsMCwxLC4wNy0uMWwuMS0uMDguMTMsMGgyYS4zMy4zMywwLDAsMSwuMjMuMS4zOS4zOSwwLDAsMSwuMDguMS4yOC4yOCwwLDAsMSwwLC4xM1ptLS4xMi0zLjkzYS4zMS4zMSwwLDAsMSwwLC4xMy4zLjMsMCwwLDEtLjA3LjEuMy4zLDAsMCwxLS4yMy4wOEgxMS40M2EuMzEuMzEsMCwwLDEtLjM0LS4zMUwxMC45NCw0LjFBLjUuNSwwLDAsMSwxMSwzLjg2bC4xMS0uMDguMTMsMGgyLjExYS4zNS4zNSwwLDAsMSwuMjYuMS40MS40MSwwLDAsMSwuMDguMjRaIj48L3BhdGg+PHBhdGggZD0iTTcuNjUsMTQuODJhLjI3LjI3LDAsMCwxLDAsLjEyLjI2LjI2LDAsMCwxLS4wNy4xMWwtLjEuMDctLjEzLDBINS40M2EuMjUuMjUsMCwwLDEtLjEyLDAsLjI3LjI3LDAsMCwxLS4xLS4wOC4zMS4zMSwwLDAsMS0uMDktLjIyVjEzYS4zNi4zNiwwLDAsMSwuMDktLjIzbC4xLS4wNy4xMiwwSDcuMzJhLjMyLjMyLDAsMCwxLC4yMy4wOS4zLjMsMCwwLDEsLjA3LjEuMjguMjgsMCwwLDEsMCwuMTNabTIuMi03LjE3YTMuMSwzLjEsMCwwLDEtLjM2LjczQTUuNTgsNS41OCwwLDAsMSw5LDlhNC44NSw0Ljg1LDAsMCwxLS41Mi40OSw4LDgsMCwwLDAtLjY1LjYzLDEsMSwwLDAsMC0uMjcuN1YxMWEuMjEuMjEsMCwwLDEsMCwuMTIuMTcuMTcsMCwwLDEtLjA2LjEuMjMuMjMsMCwwLDEtLjEuMDdsLS4xMiwwSDUuNTNhLjIxLjIxLDAsMCwxLS4xMiwwLC4xOC4xOCwwLDAsMS0uMS0uMDcuMi4yLDAsMCwxLS4wOC0uMS4zNy4zNywwLDAsMSwwLS4xMnYtLjM1YTIuNjgsMi42OCwwLDAsMSwuMTMtLjg0LDIuOTEsMi45MSwwLDAsMSwuMzMtLjY2LDMuMzgsMy4zOCwwLDAsMSwuNDUtLjU1Yy4xNi0uMTUuMzMtLjI5LjQ5LS40MmE3Ljg0LDcuODQsMCwwLDAsLjY1LS42NCwxLDEsMCwwLDAsLjI1LS42Ny43Ny43NywwLDAsMC0uMDctLjM0LjY3LjY3LDAsMCwwLS4yMy0uMjdBMS4xNiwxLjE2LDAsMCwwLDYuNDksNiwxLjYxLDEuNjEsMCwwLDAsNiw2LjExYTMsMywwLDAsMC0uNDEuMTgsMS43NSwxLjc1LDAsMCwwLS4yOS4xOGwtLjExLjA5QS41LjUsMCwwLDEsNSw2LjYyYS4zMS4zMSwwLDAsMS0uMjEtLjEzbC0xLTEuMjFhLjMuMywwLDAsMSwwLS40QTEuMzYsMS4zNiwwLDAsMSw0LDQuNjhhMy4wNywzLjA3LDAsMCwxLC41Ni0uMzgsNS40OSw1LjQ5LDAsMCwxLC45LS4zNywzLjY5LDMuNjksMCwwLDEsMS4xOS0uMTcsMy45MiwzLjkyLDAsMCwxLDIuMy43NSwyLjg1LDIuODUsMCwwLDEsLjc3LjkyQTIuODIsMi44MiwwLDAsMSwxMCw2LjcxLDMsMywwLDAsMSw5Ljg1LDcuNjVaIj48L3BhdGg+PC9nPjxnPjxwYXRoIGNsYXNzPSJpY29uLWNvbXBvbmVudCIgZmlsbD0iI2ZmZiIgZD0iTTEzLjY2LDE0LjNhLjI4LjI4LDAsMCwxLDAsLjEzLjIzLjIzLDAsMCwxLS4wOC4xMS4yOC4yOCwwLDAsMS0uMTEuMDhsLS4xMiwwaC0ybC0uMTMsMGEuMjcuMjcsMCwwLDEtLjEtLjA4QS4zNi4zNiwwLDAsMSwxMSwxNC4zVjEyLjRhLjU5LjU5LDAsMCwxLDAtLjEzLjM2LjM2LDAsMCwxLC4wNy0uMWwuMS0uMDguMTMsMGgyYS4zMy4zMywwLDAsMSwuMjMuMS4zOS4zOSwwLDAsMSwuMDguMS4yOC4yOCwwLDAsMSwwLC4xM1ptLS4xMi0zLjkzYS4zMS4zMSwwLDAsMSwwLC4xMy4zLjMsMCwwLDEtLjA3LjEuMy4zLDAsMCwxLS4yMy4wOEgxMS40M2EuMzEuMzEsMCwwLDEtLjM0LS4zMUwxMC45NCwzLjZBLjUuNSwwLDAsMSwxMSwzLjM2bC4xMS0uMDguMTMsMGgyLjExYS4zNS4zNSwwLDAsMSwuMjYuMS40MS40MSwwLDAsMSwuMDguMjRaIj48L3BhdGg+PHBhdGggY2xhc3M9Imljb24tY29tcG9uZW50IiBmaWxsPSIjZmZmIiBkPSJNNy42NSwxNC4zMmEuMjcuMjcsMCwwLDEsMCwuMTIuMjYuMjYsMCwwLDEtLjA3LjExbC0uMS4wNy0uMTMsMEg1LjQzYS4yNS4yNSwwLDAsMS0uMTIsMCwuMjcuMjcsMCwwLDEtLjEtLjA4LjMxLjMxLDAsMCwxLS4wOS0uMjJWMTIuNDlhLjM2LjM2LDAsMCwxLC4wOS0uMjNsLjEtLjA3LjEyLDBINy4zMmEuMzIuMzIsMCwwLDEsLjIzLjA5LjMuMywwLDAsMSwuMDcuMS4yOC4yOCwwLDAsMSwwLC4xM1ptMi4yLTcuMTdhMy4xLDMuMSwwLDAsMS0uMzYuNzMsNS41OCw1LjU4LDAsMCwxLS40OS42QTQuODUsNC44NSwwLDAsMSw4LjQ4LDlhOCw4LDAsMCwwLS42NS42MywxLDEsMCwwLDAtLjI3Ljd2LjIyYS4yMS4yMSwwLDAsMSwwLC4xMi4xNy4xNywwLDAsMS0uMDYuMS4yMy4yMywwLDAsMS0uMS4wN2wtLjEyLDBINS41M2EuMjEuMjEsMCwwLDEtLjEyLDAsLjE4LjE4LDAsMCwxLS4xLS4wNy4yLjIsMCwwLDEtLjA4LS4xLjM3LjM3LDAsMCwxLDAtLjEydi0uMzVhMi42OCwyLjY4LDAsMCwxLC4xMy0uODQsMi45MSwyLjkxLDAsMCwxLC4zMy0uNjYsMy4zOCwzLjM4LDAsMCwxLC40NS0uNTVjLjE2LS4xNS4zMy0uMjkuNDktLjQyYTcuODQsNy44NCwwLDAsMCwuNjUtLjY0LDEsMSwwLDAsMCwuMjUtLjY3Ljc3Ljc3LDAsMCwwLS4wNy0uMzQuNjcuNjcsMCwwLDAtLjIzLS4yNywxLjE2LDEuMTYsMCwwLDAtLjcyLS4yNEExLjYxLDEuNjEsMCwwLDAsNiw1LjYxYTMsMywwLDAsMC0uNDEuMThBMS43NSwxLjc1LDAsMCwwLDUuMyw2bC0uMTEuMDlBLjUuNSwwLDAsMSw1LDYuMTIuMzEuMzEsMCwwLDEsNC43NCw2bC0xLTEuMjFhLjMuMywwLDAsMSwwLS40QTEuMzYsMS4zNiwwLDAsMSw0LDQuMThhMy4wNywzLjA3LDAsMCwxLC41Ni0uMzgsNS40OSw1LjQ5LDAsMCwxLC45LS4zNywzLjY5LDMuNjksMCwwLDEsMS4xOS0uMTdBMy45MiwzLjkyLDAsMCwxLDguOTMsNGEyLjg1LDIuODUsMCwwLDEsLjc3LjkyQTIuODIsMi44MiwwLDAsMSwxMCw2LjIxLDMsMywwLDAsMSw5Ljg1LDcuMTVaIj48L3BhdGg+PC9nPjwvZz48L3N2Zz4=", "mistake": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGNsYXNzPSIiIHZpZXdCb3g9IjAgMCAxOCAxOSI+PGcgaWQ9Im1pc3Rha2UiPjxnPjxwYXRoIGNsYXNzPSJpY29uLXNoYWRvdyIgb3BhY2l0eT0iMC4zIiBkPSJNOSwuNWE5LDksMCwxLDAsOSw5QTksOSwwLDAsMCw5LC41WiI+PC9wYXRoPjxwYXRoIGNsYXNzPSJpY29uLWJhY2tncm91bmQiIGZpbGw9IiNlNThmMmEiIGQ9Ik05LDBhOSw5LDAsMSwwLDksOUE5LDksMCwwLDAsOSwwWiI+PC9wYXRoPjwvZz48Zz48ZyBjbGFzcz0iaWNvbi1jb21wb25lbnQtc2hhZG93IiBvcGFjaXR5PSIwLjIiPjxwYXRoIGQ9Ik05LjkyLDE1YS4yNy4yNywwLDAsMSwwLC4xMi40MS40MSwwLDAsMS0uMDcuMTEuMzIuMzIsMCwwLDEtLjIzLjA5SDcuN2EuMjUuMjUsMCwwLDEtLjEyLDAsLjI3LjI3LDAsMCwxLS4xLS4wOEEuMzEuMzEsMCwwLDEsNy4zOSwxNVYxMy4xOUEuMzIuMzIsMCwwLDEsNy40OCwxM2wuMS0uMDcuMTIsMEg5LjU5YS4zMi4zMiwwLDAsMSwuMjMuMDkuNjEuNjEsMCwwLDEsLjA3LjEuMjguMjgsMCwwLDEsMCwuMTNabTIuMi03LjE3YTMuMSwzLjEsMCwwLDEtLjM2LjczLDUuNTgsNS41OCwwLDAsMS0uNDkuNiw2LDYsMCwwLDEtLjUyLjQ5LDgsOCwwLDAsMC0uNjUuNjMsMSwxLDAsMCwwLS4yNy43di4yMmEuMjQuMjQsMCwwLDEsMCwuMTIuMTcuMTcsMCwwLDEtLjA2LjEuMy4zLDAsMCwxLS4xLjA3bC0uMTIsMEg3Ljc5bC0uMTIsMGEuMy4zLDAsMCwxLS4xLS4wNy4yNi4yNiwwLDAsMS0uMDctLjEuMzcuMzcsMCwwLDEsMC0uMTJ2LS4zNUEyLjQyLDIuNDIsMCwwLDEsNy42MSwxMGEyLjU1LDIuNTUsMCwwLDEsLjMzLS42NiwzLjM4LDMuMzgsMCwwLDEsLjQ1LS41NWMuMTYtLjE1LjMzLS4yOS40OS0uNDJhNy43Myw3LjczLDAsMCwwLC42NC0uNjQsMSwxLDAsMCwwLC4yNi0uNjcuNzcuNzcsMCwwLDAtLjA3LS4zNC43NS43NSwwLDAsMC0uMjMtLjI3LDEuMTYsMS4xNiwwLDAsMC0uNzItLjI0LDEuNjEsMS42MSwwLDAsMC0uNDkuMDcsMywzLDAsMCwwLS40MS4xOCwxLjQxLDEuNDEsMCwwLDAtLjI5LjE4bC0uMTEuMDlhLjUuNSwwLDAsMS0uMjQuMDZBLjMxLjMxLDAsMCwxLDcsNi42OUw2LDUuNDhhLjI5LjI5LDAsMCwxLDAtLjQsMS4zNiwxLjM2LDAsMCwxLC4yMS0uMiwzLjA3LDMuMDcsMCwwLDEsLjU2LS4zOCw1LjM4LDUuMzgsMCwwLDEsLjg5LS4zN0EzLjc1LDMuNzUsMCwwLDEsOC45LDRhNC4wNyw0LjA3LDAsMCwxLDEuMi4xOSw0LDQsMCwwLDEsMS4wOS41NiwyLjc2LDIuNzYsMCwwLDEsLjc4LjkyLDIuODIsMi44MiwwLDAsMSwuMjgsMS4yOEEzLDMsMCwwLDEsMTIuMTIsNy44NVoiPjwvcGF0aD48L2c+PHBhdGggY2xhc3M9Imljb24tY29tcG9uZW50IiBmaWxsPSIjZmZmIiBkPSJNOS45MiwxNC41MmEuMjcuMjcsMCwwLDEsMCwuMTIuNDEuNDEsMCwwLDEtLjA3LjExLjMyLjMyLDAsMCwxLS4yMy4wOUg3LjdhLjI1LjI1LDAsMCwxLS4xMiwwLC4yNy4yNywwLDAsMS0uMS0uMDguMzEuMzEsMCwwLDEtLjA5LS4yMlYxMi42OWEuMzIuMzIsMCwwLDEsLjA5LS4yM2wuMS0uMDcuMTIsMEg5LjU5YS4zMi4zMiwwLDAsMSwuMjMuMDkuNjEuNjEsMCwwLDEsLjA3LjEuMjguMjgsMCwwLDEsMCwuMTNabTIuMi03LjE3YTMuMSwzLjEsMCwwLDEtLjM2LjczLDUuNTgsNS41OCwwLDAsMS0uNDkuNiw2LDYsMCwwLDEtLjUyLjQ5LDgsOCwwLDAsMC0uNjUuNjMsMSwxLDAsMCwwLS4yNy43di4yMmEuMjQuMjQsMCwwLDEsMCwuMTIuMTcuMTcsMCwwLDEtLjA2LjEuMy4zLDAsMCwxLS4xLjA3bC0uMTIsMEg3Ljc5bC0uMTIsMGEuMy4zLDAsMCwxLS4xLS4wNy4yNi4yNiwwLDAsMS0uMDctLjEuMzcuMzcsMCwwLDEsMC0uMTJ2LS4zNWEyLjQyLDIuNDIsMCwwLDEsLjEzLS44NCwyLjU1LDIuNTUsMCwwLDEsLjMzLS42NiwzLjM4LDMuMzgsMCwwLDEsLjQ1LS41NWMuMTYtLjE1LjMzLS4yOS40OS0uNDJhNy43Myw3LjczLDAsMCwwLC42NC0uNjQsMSwxLDAsMCwwLC4yNi0uNjcuNzcuNzcsMCwwLDAtLjA3LS4zNEEuNzUuNzUsMCwwLDAsOS40OCw2YTEuMTYsMS4xNiwwLDAsMC0uNzItLjI0LDEuNjEsMS42MSwwLDAsMC0uNDkuMDdBMywzLDAsMCwwLDcuODYsNmExLjQxLDEuNDEsMCwwLDAtLjI5LjE4bC0uMTEuMDlhLjUuNSwwLDAsMS0uMjQuMDZBLjMxLjMxLDAsMCwxLDcsNi4xOUw2LDVhLjI5LjI5LDAsMCwxLDAtLjQsMS4zNiwxLjM2LDAsMCwxLC4yMS0uMkEzLjA3LDMuMDcsMCwwLDEsNi44MSw0YTUuMzgsNS4zOCwwLDAsMSwuODktLjM3LDMuNzUsMy43NSwwLDAsMSwxLjItLjE3LDQuMDcsNC4wNywwLDAsMSwxLjIuMTksNCw0LDAsMCwxLDEuMDkuNTYsMi43NiwyLjc2LDAsMCwxLC43OC45MiwyLjgyLDIuODIsMCwwLDEsLjI4LDEuMjhBMywzLDAsMCwxLDEyLjEyLDcuMzVaIj48L3BhdGg+PC9nPjwvZz48L3N2Zz4=", "blunder": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGNsYXNzPSIiIHZpZXdCb3g9IjAgMCAxOCAxOSI+PGcgaWQ9ImJsdW5kZXIiPjxwYXRoIGNsYXNzPSJpY29uLXNoYWRvdyIgb3BhY2l0eT0iMC4zIiBkPSJNOSwuNWE5LDksMCwxLDAsOSw5QTksOSwwLDAsMCw5LC41WiI+PC9wYXRoPjxwYXRoIGNsYXNzPSJpY29uLWJhY2tncm91bmQiIGZpbGw9IiNjYTM0MzEiIGQ9Ik05LDBhOSw5LDAsMSwwLDksOUE5LDksMCwwLDAsOSwwWiI+PC9wYXRoPjxnIGNsYXNzPSJpY29uLWNvbXBvbmVudC1zaGFkb3ciIG9wYWNpdHk9IjAuMiI+PHBhdGggZD0iTTE0Ljc0LDUuNDVBMi41OCwyLjU4LDAsMCwwLDE0LDQuNTQsMy43NiwzLjc2LDAsMCwwLDEyLjg5LDRhNC4wNyw0LjA3LDAsMCwwLTEuMi0uMTlBMy45MiwzLjkyLDAsMCwwLDEwLjUxLDRhNS44Nyw1Ljg3LDAsMCwwLS45LjM3LDMsMywwLDAsMC0uMzIuMiwzLjQ2LDMuNDYsMCwwLDEsLjQyLjYzLDMuMjksMy4yOSwwLDAsMSwuMzYsMS40Ny4zMS4zMSwwLDAsMCwuMTktLjA2bC4xMS0uMDhhMi45LDIuOSwwLDAsMSwuMjktLjE5LDMuODksMy44OSwwLDAsMSwuNDEtLjE3LDEuNTUsMS41NSwwLDAsMSwuNDgtLjA3LDEuMSwxLjEsMCwwLDEsLjcyLjI0LjcyLjcyLDAsMCwxLC4yMy4yNi44LjgsMCwwLDEsLjA3LjM0LDEsMSwwLDAsMS0uMjUuNjcsNy43MSw3LjcxLDAsMCwxLS42NS42Myw2LjIsNi4yLDAsMCwwLS40OC40MywyLjkzLDIuOTMsMCwwLDAtLjQ1LjU0LDIuNTUsMi41NSwwLDAsMC0uMzMuNjYsMi42MiwyLjYyLDAsMCwwLS4xMy44M1YxMWEuMjQuMjQsMCwwLDAsMCwuMTIuMzUuMzUsMCwwLDAsLjE3LjE3bC4xMiwwaDEuNzFsLjEyLDBhLjIzLjIzLDAsMCwwLC4xLS4wNy4yMS4yMSwwLDAsMCwuMDYtLjEuMjcuMjcsMCwwLDAsMC0uMTJWMTAuOGExLDEsMCwwLDEsLjI2LS43cS4yNy0uMjguNjYtLjYzQTUuNzksNS43OSwwLDAsMCwxNC4wNSw5YTQuNTEsNC41MSwwLDAsMCwuNDgtLjYsMi41NiwyLjU2LDAsMCwwLC4zNi0uNzIsMi44MSwyLjgxLDAsMCwwLC4xNC0xQTIuNjYsMi42NiwwLDAsMCwxNC43NCw1LjQ1WiI+PC9wYXRoPjxwYXRoIGQ9Ik0xMi4zOCwxMi42NUgxMC41bC0uMTIsMGEuMzQuMzQsMCwwLDAtLjE4LjI5djEuODJhLjM2LjM2LDAsMCwwLC4wOC4yMy4yMy4yMywwLDAsMCwuMS4wN2wuMTIsMGgxLjg4YS4yNC4yNCwwLDAsMCwuMTIsMCwuMjYuMjYsMCwwLDAsLjExLS4wNy4zNi4zNiwwLDAsMCwuMDctLjEuMjguMjgsMCwwLDAsMC0uMTNWMTNhLjI3LjI3LDAsMCwwLDAtLjEyLjYxLjYxLDAsMCwwLS4wNy0uMUEuMzIuMzIsMCwwLDAsMTIuMzgsMTIuNjVaIj48L3BhdGg+PHBhdGggZD0iTTYuNzksMTIuNjVINC45MWwtLjEyLDBhLjM0LjM0LDAsMCwwLS4xOC4yOXYxLjgyYS4zNi4zNiwwLDAsMCwuMDguMjMuMjMuMjMsMCwwLDAsLjEuMDdsLjEyLDBINi43OWEuMjQuMjQsMCwwLDAsLjEyLDBBLjI2LjI2LDAsMCwwLDcsMTVhLjM2LjM2LDAsMCwwLC4wNy0uMS4yOC4yOCwwLDAsMCwwLS4xM1YxM2EuMjcuMjcsMCwwLDAsMC0uMTIuNjEuNjEsMCwwLDAtLjA3LS4xQS4zMi4zMiwwLDAsMCw2Ljc5LDEyLjY1WiI+PC9wYXRoPjxwYXRoIGQ9Ik04LjM5LDQuNTRBMy43NiwzLjc2LDAsMCwwLDcuMyw0YTQuMDcsNC4wNywwLDAsMC0xLjItLjE5QTMuOTIsMy45MiwwLDAsMCw0LjkyLDRhNS44Nyw1Ljg3LDAsMCwwLS45LjM3LDMuMzcsMy4zNywwLDAsMC0uNTUuMzhsLS4yMS4xOWEuMzIuMzIsMCwwLDAsMCwuNDFsMSwxLjJhLjI2LjI2LDAsMCwwLC4yLjEyLjQ4LjQ4LDAsMCwwLC4yNC0uMDZsLjExLS4wOGEyLjksMi45LDAsMCwxLC4yOS0uMTlsLjQtLjE3QTEuNjYsMS42NiwwLDAsMSw2LDYuMDZhMS4xLDEuMSwwLDAsMSwuNzIuMjQuNzIuNzIsMCwwLDEsLjIzLjI2QS43Ny43NywwLDAsMSw3LDYuOWExLDEsMCwwLDEtLjI2LjY3LDcuNiw3LjYsMCwwLDEtLjY0LjYzLDYuMjgsNi4yOCwwLDAsMC0uNDkuNDMsMi45MywyLjkzLDAsMCwwLS40NS41NCwyLjcyLDIuNzIsMCwwLDAtLjMzLjY2LDIuNjIsMi42MiwwLDAsMC0uMTMuODNWMTFhLjQzLjQzLDAsMCwwLDAsLjEyLjM5LjM5LDAsMCwwLC4wOC4xLjE4LjE4LDAsMCwwLC4xLjA3LjIxLjIxLDAsMCwwLC4xMiwwSDYuNzJsLjEyLDBhLjIzLjIzLDAsMCwwLC4xLS4wNy4zNi4zNiwwLDAsMCwuMDctLjFBLjUuNSwwLDAsMCw3LDExVjEwLjhhMSwxLDAsMCwxLC4yNy0uN0E4LDgsMCwwLDEsOCw5LjQ3Yy4xOC0uMTUuMzUtLjMxLjUyLS40OEE3LDcsMCwwLDAsOSw4LjM5YTMuMjMsMy4yMywwLDAsMCwuMzYtLjcyLDMuMDcsMy4wNywwLDAsMCwuMTMtMSwyLjY2LDIuNjYsMCwwLDAtLjI5LTEuMjdBMi41OCwyLjU4LDAsMCwwLDguMzksNC41NFoiPjwvcGF0aD48L2c+PGc+PHBhdGggY2xhc3M9Imljb24tY29tcG9uZW50IiBmaWxsPSIjZmZmIiBkPSJNMTQuNzQsNUEyLjU4LDIuNTgsMCwwLDAsMTQsNGEzLjc2LDMuNzYsMCwwLDAtMS4wOS0uNTYsNC4wNyw0LjA3LDAsMCwwLTEuMi0uMTksMy45MiwzLjkyLDAsMCwwLTEuMTguMTcsNS44Nyw1Ljg3LDAsMCwwLS45LjM3LDMsMywwLDAsMC0uMzIuMiwzLjQ2LDMuNDYsMCwwLDEsLjQyLjYzLDMuMjksMy4yOSwwLDAsMSwuMzYsMS40Ny4zMS4zMSwwLDAsMCwuMTktLjA2TDEwLjM3LDZhMi45LDIuOSwwLDAsMSwuMjktLjE5LDMuODksMy44OSwwLDAsMSwuNDEtLjE3LDEuNTUsMS41NSwwLDAsMSwuNDgtLjA3LDEuMSwxLjEsMCwwLDEsLjcyLjI0LjcyLjcyLDAsMCwxLC4yMy4yNi44LjgsMCwwLDEsLjA3LjM0LDEsMSwwLDAsMS0uMjUuNjcsNy43MSw3LjcxLDAsMCwxLS42NS42Myw2LjIsNi4yLDAsMCwwLS40OC40MywyLjkzLDIuOTMsMCwwLDAtLjQ1LjU0LDIuNTUsMi41NSwwLDAsMC0uMzMuNjYsMi42MiwyLjYyLDAsMCwwLS4xMy44M3YuMzVhLjI0LjI0LDAsMCwwLDAsLjEyLjM1LjM1LDAsMCwwLC4xNy4xN2wuMTIsMGgxLjcxbC4xMiwwYS4yMy4yMywwLDAsMCwuMS0uMDcuMjEuMjEsMCwwLDAsLjA2LS4xLjI3LjI3LDAsMCwwLDAtLjEyVjEwLjNhMSwxLDAsMCwxLC4yNi0uN3EuMjctLjI4LjY2LS42M2E1Ljc5LDUuNzksMCwwLDAsLjUxLS40OCw0LjUxLDQuNTEsMCwwLDAsLjQ4LS42LDIuNTYsMi41NiwwLDAsMCwuMzYtLjcyLDIuODEsMi44MSwwLDAsMCwuMTQtMUEyLjY2LDIuNjYsMCwwLDAsMTQuNzQsNVoiPjwvcGF0aD48cGF0aCBjbGFzcz0iaWNvbi1jb21wb25lbnQiIGZpbGw9IiNmZmYiIGQ9Ik0xMi4zOCwxMi4xNUgxMC41bC0uMTIsMGEuMzQuMzQsMCwwLDAtLjE4LjI5djEuODJhLjM2LjM2LDAsMCwwLC4wOC4yMy4yMy4yMywwLDAsMCwuMS4wN2wuMTIsMGgxLjg4YS4yNC4yNCwwLDAsMCwuMTIsMCwuMjYuMjYsMCwwLDAsLjExLS4wNy4zNi4zNiwwLDAsMCwuMDctLjEuMjguMjgsMCwwLDAsMC0uMTNWMTIuNDZhLjI3LjI3LDAsMCwwLDAtLjEyLjYxLjYxLDAsMCwwLS4wNy0uMUEuMzIuMzIsMCwwLDAsMTIuMzgsMTIuMTVaIj48L3BhdGg+PHBhdGggY2xhc3M9Imljb24tY29tcG9uZW50IiBmaWxsPSIjZmZmIiBkPSJNNi43OSwxMi4xNUg0LjkxbC0uMTIsMGEuMzQuMzQsMCwwLDAtLjE4LjI5djEuODJhLjM2LjM2LDAsMCwwLC4wOC4yMy4yMy4yMywwLDAsMCwuMS4wN2wuMTIsMEg2Ljc5YS4yNC4yNCwwLDAsMCwuMTIsMEEuMjYuMjYsMCwwLDAsNywxNC41MWEuMzYuMzYsMCwwLDAsLjA3LS4xLjI4LjI4LDAsMCwwLDAtLjEzVjEyLjQ2YS4yNy4yNywwLDAsMCwwLS4xMi42MS42MSwwLDAsMC0uMDctLjFBLjMyLjMyLDAsMCwwLDYuNzksMTIuMTVaIj48L3BhdGg+PHBhdGggY2xhc3M9Imljb24tY29tcG9uZW50IiBmaWxsPSIjZmZmIiBkPSJNOC4zOSw0QTMuNzYsMy43NiwwLDAsMCw3LjMsMy40OGE0LjA3LDQuMDcsMCwwLDAtMS4yLS4xOSwzLjkyLDMuOTIsMCwwLDAtMS4xOC4xNyw1Ljg3LDUuODcsMCwwLDAtLjkuMzcsMy4zNywzLjM3LDAsMCwwLS41NS4zOGwtLjIxLjE5YS4zMi4zMiwwLDAsMCwwLC40MWwxLDEuMmEuMjYuMjYsMCwwLDAsLjIuMTIuNDguNDgsMCwwLDAsLjI0LS4wNkw0Ljc4LDZhMi45LDIuOSwwLDAsMSwuMjktLjE5bC40LS4xN0ExLjY2LDEuNjYsMCwwLDEsNiw1LjU2YTEuMSwxLjEsMCwwLDEsLjcyLjI0LjcyLjcyLDAsMCwxLC4yMy4yNkEuNzcuNzcsMCwwLDEsNyw2LjRhMSwxLDAsMCwxLS4yNi42Nyw3LjYsNy42LDAsMCwxLS42NC42Myw2LjI4LDYuMjgsMCwwLDAtLjQ5LjQzLDIuOTMsMi45MywwLDAsMC0uNDUuNTQsMi43MiwyLjcyLDAsMCwwLS4zMy42NiwyLjYyLDIuNjIsMCwwLDAtLjEzLjgzdi4zNWEuNDMuNDMsMCwwLDAsMCwuMTIuMzkuMzksMCwwLDAsLjA4LjEuMTguMTgsMCwwLDAsLjEuMDcuMjEuMjEsMCwwLDAsLjEyLDBINi43MmwuMTIsMGEuMjMuMjMsMCwwLDAsLjEtLjA3LjM2LjM2LDAsMCwwLC4wNy0uMS41LjUsMCwwLDAsMC0uMTJWMTAuM2ExLDEsMCwwLDEsLjI3LS43QTgsOCwwLDAsMSw4LDljLjE4LS4xNS4zNS0uMzEuNTItLjQ4QTcsNywwLDAsMCw5LDcuODlhMy4yMywzLjIzLDAsMCwwLC4zNi0uNzIsMy4wNywzLjA3LDAsMCwwLC4xMy0xQTIuNjYsMi42NiwwLDAsMCw5LjE1LDUsMi41OCwyLjU4LDAsMCwwLDguMzksNFoiPjwvcGF0aD48L2c+PC9nPjwvc3ZnPg==", "missed": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGNsYXNzPSIiIHZpZXdCb3g9IjAgMCAxOCAxOSI+PGcgaWQ9Im1pc3NlZF93aW4iPjxnPjxwYXRoIGNsYXNzPSJpY29uLXNoYWRvdyIgb3BhY2l0eT0iMC4zIiBkPSJNOSwuNWE5LDksMCwxLDAsOSw5QTksOSwwLDAsMCw5LC41WiI+PC9wYXRoPjxwYXRoIGNsYXNzPSJpY29uLWJhY2tncm91bmQiIGZpbGw9IiNkYmFjMTYiIGQ9Ik05LDBhOSw5LDAsMSwwLDksOUE5LDksMCwwLDAsOSwwWiI+PC9wYXRoPjwvZz48Zz48ZyBjbGFzcz0iaWNvbi1jb21wb25lbnQtc2hhZG93IiBvcGFjaXR5PSIwLjIiPjxyZWN0IHg9IjIuNzQiIHk9IjguMSIgd2lkdGg9IjEyLjUxIiBoZWlnaHQ9IjMuMTEiIHJ4PSIwLjM2Ij48L3JlY3Q+PC9nPjxyZWN0IGNsYXNzPSJpY29uLWNvbXBvbmVudCIgZmlsbD0iI2ZmZiIgeD0iMi43NCIgeT0iNy42IiB3aWR0aD0iMTIuNTEiIGhlaWdodD0iMy4xMSIgcng9IjAuMzYiPjwvcmVjdD48L2c+PC9nPjwvc3ZnPg=="};
  Object.keys(CATS).forEach(k => CATS[k].img = CAT_ICONS[k]);
  const catImg = k => '<img class="cat-ic" src="' + CATS[k].img + '" alt="' + CATS[k].icon + '" draggable="false">';
  // Iconos del modal de fin de partida (SVG incrustados)
  const END_ICONS = {"winner": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGNsYXNzPSIiIHZpZXdCb3g9IjAgMCAxOCAxOSI+PGcgaWQ9Indpbm5lciI+PGc+PHBhdGggY2xhc3M9Imljb24tc2hhZG93IiBvcGFjaXR5PSIwLjMiIGQ9Ik05LC41YTksOSwwLDEsMCw5LDlBOSw5LDAsMCwwLDksLjVaIj48L3BhdGg+PHBhdGggY2xhc3M9Imljb24tYmFja2dyb3VuZCIgZmlsbD0iI2RiYWMxNiIgZD0iTTksMGE5LDksMCwxLDAsOSw5QTksOSwwLDAsMCw5LDBaIj48L3BhdGg+PC9nPjxnIGNsYXNzPSJpY29uLWNvbXBvbmVudC1zaGFkb3ciIG9wYWNpdHk9IjAuMiI+PHBhdGggY2xhc3M9ImNscy00IiBkPSJNNC4zNSwxMi42NiwyLjg2LDcuNzJhLjM3LjM3LDAsMCwxLDAtLjIxQS4zNS4zNSwwLDAsMSwzLDcuMzRhLjMxLjMxLDAsMCwxLC4yLS4wNy4zLjMsMCwwLDEsLjIxLjA1TDYuMjcsOS4xNWwuMTQsMGguMTRhLjMxLjMxLDAsMCwwLC4xMy0uMDZBLjQ4LjQ4LDAsMCwwLDYuNzcsOUw4LjY5LDUuNTRhLjQuNCwwLDAsMSwuMTMtLjEzLjM3LjM3LDAsMCwxLC4xOCwwLC4zNi4zNiwwLDAsMSwuMzEuMThMMTEuMjIsOWEuNTIuNTIsMCwwLDAsLjEuMTEuMzEuMzEsMCwwLDAsLjEzLjA2aC4xNGwuMTMsMCwyLjg5LTEuODNhLjMuMywwLDAsMSwuMjEtLjA1LjMxLjMxLDAsMCwxLC4yLjA3LjM1LjM1LDAsMCwxLC4xMi4xNy4zNy4zNywwLDAsMSwwLC4yMWwtMS40OSw0Ljk0YS4zNC4zNCwwLDAsMS0uMTMuMTguMzEuMzEsMCwwLDEtLjIxLjA3SDQuNjlhLjMxLjMxLDAsMCwxLS4yMS0uMDdBLjM0LjM0LDAsMCwxLDQuMzUsMTIuNjZaIj48L3BhdGg+PC9nPjxwYXRoIGNsYXNzPSJ1bmRlZmluZWQiIGZpbGwtcnVsZT0iZXZlbm9kZCIgZD0iTTQuMzUsMTIuMDYsMi44Niw3LjEyYS4zNy4zNywwLDAsMSwwLS4yMUEuMzUuMzUsMCwwLDEsMyw2Ljc0YS4zMS4zMSwwLDAsMSwuMi0uMDcuMy4zLDAsMCwxLC4yMSwwTDYuMjcsOC41NWwuMTQsMGguMTRhLjMxLjMxLDAsMCwwLC4xMy0uMDYuNDguNDgsMCwwLDAsLjA5LS4xMUw4LjY5LDQuOTRhLjQuNCwwLDAsMSwuMTMtLjEzLjM3LjM3LDAsMCwxLC4xOCwwLC4zNi4zNiwwLDAsMSwuMzEuMThsMS45MSwzLjQ4YS41Mi41MiwwLDAsMCwuMS4xMS4zMS4zMSwwLDAsMCwuMTMuMDZoLjE0bC4xMywwLDIuODktMS44M2EuMy4zLDAsMCwxLC4yMSwwLC4zMS4zMSwwLDAsMSwuMi4wNy4zNS4zNSwwLDAsMSwuMTIuMTcuMzguMzgsMCwwLDEsMCwuMjFsLTEuNDksNC45NGEuMzQuMzQsMCwwLDEtLjEzLjE4LjMxLjMxLDAsMCwxLS4yMS4wN0g0LjY5YS4zMS4zMSwwLDAsMS0uMjEtLjA3QS4zNC4zNCwwLDAsMSw0LjM1LDEyLjA2WiI+PC9wYXRoPjwvZz48L3N2Zz4=", "draw_white": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGNsYXNzPSIiIHZpZXdCb3g9IjAgMCAxOCAxOSI+PGcgaWQ9ImRyYXdfd2hpdGUiPjxwYXRoIGNsYXNzPSJpY29uLXNoYWRvdyIgb3BhY2l0eT0iMC4zIiBkPSJNOSwuNWE5LDksMCwxLDAsOSw5QTksOSwwLDAsMCw5LC41WiI+PC9wYXRoPjxjaXJjbGUgY2xhc3M9Imljb24tYmFja2dyb3VuZCIgZmlsbD0iI2Y4ZjhmOCIgY3g9IjkiIGN5PSI5IiByPSI4LjUiPjwvY2lyY2xlPjxwYXRoIGNsYXNzPSJpY29uLWNvbXBvbmVudC1zaGFkb3ciIGZpbGw9IiNlOGU4ZTgiIGQ9Ik05LDFBOCw4LDAsMSwxLDEsOSw4LDgsMCwwLDEsOSwxTTksMGE5LDksMCwxLDAsOSw5QTksOSwwLDAsMCw5LDBaIj48L3BhdGg+PHBhdGggZD0iTTIuOTIsNi42MVY1LjQ0Yy44MSwwLDEuNzUtLjI4LDEuOC0xLjIySDYuMTR2NS41SDQuMzRWNi42MVptOC44Ny0yLjM5TDcsMTMuNDhINWw0LjgtOS4yNlpNOS44NSwxMy40OGMtLjA4LTEuNTQsMS4zOC0yLjE5LDIuNTctMi44OS4zMy0uMTcuNzgtLjQuNzgtLjc4YS42Ni42NiwwLDAsMC0uNjgtLjdjLS42OSwwLS45NC41OC0uOTIsMS4xNkgxMGEyLjE3LDIuMTcsMCwwLDEsLjY0LTEuNzksMi43NCwyLjc0LDAsMCwxLDEuOTEtLjYyQzE0LjEsNy44NiwxNSw4LjM4LDE1LDkuNmMwLDEuODItMi42NiwyLjE4LTIuNjYsMi41aDIuNzN2MS4zOFoiPjwvcGF0aD48L2c+PC9zdmc+", "draw_black": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGNsYXNzPSIiIHZpZXdCb3g9IjAgMCAxOCAxOSI+PGcgaWQ9ImRyYXdfYmxhY2siPjxwYXRoIGNsYXNzPSJpY29uLXNoYWRvdyIgb3BhY2l0eT0iMC4zIiBkPSJNOSwuNWE5LDksMCwxLDAsOSw5QTksOSwwLDAsMCw5LC41WiI+PC9wYXRoPjxwYXRoIGNsYXNzPSJpY29uLWJhY2tncm91bmQiIGZpbGw9IiMzMTJlMmIiIGQ9Ik05LDBhOSw5LDAsMSwwLDksOUE5LDksMCwwLDAsOSwwWiI+PC9wYXRoPjxwYXRoIGQ9Ik0yLjkyLDdWNS44NGMuODEsMCwxLjc1LS4yOCwxLjgtMS4yMkg2LjE0djUuNUg0LjM0VjdabTguODctMi4zOUw3LDEzLjg4SDVsNC44LTkuMjZaTTkuODUsMTMuODhjLS4wOC0xLjU0LDEuMzgtMi4xOSwyLjU3LTIuODkuMzMtLjE3Ljc4LS40Ljc4LS43OGEuNjYuNjYsMCwwLDAtLjY4LS43Yy0uNjksMC0uOTQuNTgtLjkyLDEuMTZIMTBhMi4xNywyLjE3LDAsMCwxLC42NC0xLjc5LDIuNzQsMi43NCwwLDAsMSwxLjkxLS42MkMxNC4xLDguMjYsMTUsOC43OCwxNSwxMGMwLDEuODItMi42NiwyLjE4LTIuNjYsMi41aDIuNzN2MS4zOFoiPjwvcGF0aD48cGF0aCBjbGFzcz0iaWNvbi1jb21wb25lbnQtc2hhZG93IiBmaWxsPSIjZmZmIiBkPSJNMi45Miw2LjUxVjUuMzRjLjgxLDAsMS43NS0uMjgsMS44LTEuMjJINi4xNHY1LjVINC4zNFY2LjUxWm04Ljg3LTIuMzlMNywxMy4zOEg1bDQuOC05LjI2Wk05Ljg1LDEzLjM4Yy0uMDgtMS41NCwxLjM4LTIuMTksMi41Ny0yLjg5LjMzLS4xNy43OC0uNC43OC0uNzhhLjY2LjY2LDAsMCwwLS42OC0uN2MtLjY5LDAtLjk0LjU4LS45MiwxLjE2SDEwYTIuMTcsMi4xNywwLDAsMSwuNjQtMS43OSwyLjc0LDIuNzQsMCwwLDEsMS45MS0uNjJDMTQuMSw3Ljc2LDE1LDguMjgsMTUsOS41YzAsMS44Mi0yLjY2LDIuMTgtMi42NiwyLjVoMi43M3YxLjM4WiI+PC9wYXRoPjwvZz48L3N2Zz4=", "resign_white": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGNsYXNzPSIiIHZpZXdCb3g9IjAgMCAxOCAxOSI+PGc+PGcgaWQ9InJlc2lnbl93aGl0ZSI+PHBhdGggY2xhc3M9Imljb24tc2hhZG93IiBvcGFjaXR5PSIwLjMiIGQ9Ik05LC41YTksOSwwLDEsMCw5LDlBOSw5LDAsMCwwLDksLjVaIj48L3BhdGg+PGNpcmNsZSBjbGFzcz0iaWNvbi1iYWNrZ3JvdW5kIiBmaWxsPSIjZjhmOGY4IiBjeD0iOSIgY3k9IjkiIHI9IjguNSI+PC9jaXJjbGU+PGc+PHBhdGggZD0iTTQuOTQsNS43NEg0Ljg5YS42My42MywwLDAsMC0uNDQuNzdsMi4xNiw4LjA5YS42My42MywwLDAsMCwuNzcuNDVsMCwwYS42Mi42MiwwLDAsMCwuNDQtLjc2TDUuNyw2LjE4QS42Mi42MiwwLDAsMCw0Ljk0LDUuNzRaIj48L3BhdGg+PHBhdGggZD0iTTEyLjMzLDMuODhjLTIsMi4yOS0zLjgzLS40MS02LDEuNTJhLjU0LjU0LDAsMCwwLS4xNS4yNS40OC40OCwwLDAsMCwwLC4yOWMuMjIuODkuODcsMy4zLDEuMTIsNC4xNWEuMTUuMTUsMCwwLDAsLjI2LjA3YzEuOTItMi42NSw0LC4yNyw2LjExLTEuNjlBLjQ2LjQ2LDAsMCwwLDEzLjc2LDhjLS4yMS0uNzgtLjgtMy0xLjEtNEMxMi42MiwzLjg0LDEyLjQyLDMuNzYsMTIuMzMsMy44OFoiPjwvcGF0aD48L2c+PC9nPjxwYXRoIGNsYXNzPSJpY29uLWNvbXBvbmVudC1zaGFkb3ciIGZpbGw9IiNlOGU4ZTgiIGQ9Ik05LDFBOCw4LDAsMSwxLDEsOSw4LDgsMCwwLDEsOSwxTTksMGE5LDksMCwxLDAsOSw5QTksOSwwLDAsMCw5LDBaIj48L3BhdGg+PC9nPjwvc3ZnPg==", "resign_black": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGNsYXNzPSIiIHZpZXdCb3g9IjAgMCAxOCAxOSI+PGcgaWQ9InJlc2lnbl9ibGFjayI+PHBhdGggY2xhc3M9Imljb24tc2hhZG93IiBvcGFjaXR5PSIwLjMiIGQ9Ik05LC41YTksOSwwLDEsMCw5LDlBOSw5LDAsMCwwLDksLjVaIj48L3BhdGg+PHBhdGggY2xhc3M9Imljb24tYmFja2dyb3VuZCIgZmlsbD0iIzMxMmUyYiIgZD0iTTksMGE5LDksMCwxLDAsOSw5QTksOSwwLDAsMCw5LDBaIj48L3BhdGg+PGc+PHBhdGggZD0iTTQuOTQsNi4zNEg0Ljg5YS42My42MywwLDAsMC0uNDQuNzdsMi4xNiw4LjA5YS42My42MywwLDAsMCwuNzcuNDVsMCwwYS42Mi42MiwwLDAsMCwuNDQtLjc2TDUuNyw2Ljc4QS42Mi42MiwwLDAsMCw0Ljk0LDYuMzRaIj48L3BhdGg+PHBhdGggZD0iTTEyLjMzLDQuNDhjLTIsMi4yOS0zLjgzLS40MS02LDEuNTJhLjU0LjU0LDAsMCwwLS4xNS4yNS40OC40OCwwLDAsMCwwLC4yOWMuMjIuODkuODcsMy4zLDEuMTIsNC4xNWEuMTUuMTUsMCwwLDAsLjI2LjA3YzEuOTItMi42NSw0LC4yNyw2LjExLTEuNjlhLjQ2LjQ2LDAsMCwwLC4xMi0uNDRjLS4yMS0uNzgtLjgtMy0xLjEtNC4wNUMxMi42Miw0LjQ0LDEyLjQyLDQuMzYsMTIuMzMsNC40OFoiPjwvcGF0aD48L2c+PGc+PHBhdGggY2xhc3M9Imljb24tY29tcG9uZW50LXNoYWRvdyIgZmlsbD0iI2ZmZiIgZD0iTTQuOTQsNS43NEg0Ljg5YS42My42MywwLDAsMC0uNDQuNzdsMi4xNiw4LjA5YS42My42MywwLDAsMCwuNzcuNDVsMCwwYS42Mi42MiwwLDAsMCwuNDQtLjc2TDUuNyw2LjE4QS42Mi42MiwwLDAsMCw0Ljk0LDUuNzRaIj48L3BhdGg+PHBhdGggY2xhc3M9Imljb24tY29tcG9uZW50LXNoYWRvdyIgZmlsbD0iI2ZmZiIgZD0iTTEyLjMzLDMuODhjLTIsMi4yOS0zLjgzLS40MS02LDEuNTJhLjU0LjU0LDAsMCwwLS4xNS4yNS40OC40OCwwLDAsMCwwLC4yOWMuMjIuODkuODcsMy4zLDEuMTIsNC4xNWEuMTUuMTUsMCwwLDAsLjI2LjA3YzEuOTItMi42NSw0LC4yNyw2LjExLTEuNjlBLjQ2LjQ2LDAsMCwwLDEzLjc2LDhjLS4yMS0uNzgtLjgtMy0xLjEtNEMxMi42MiwzLjg0LDEyLjQyLDMuNzYsMTIuMzMsMy44OFoiPjwvcGF0aD48L2c+PC9nPjwvc3ZnPg==", "checkmate_white": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGNsYXNzPSIiIHZpZXdCb3g9IjAgMCAxOCAxOSI+PGcgaWQ9ImNoZWNrbWF0ZV93aGl0ZSI+PHBhdGggY2xhc3M9Imljb24tc2hhZG93IiBvcGFjaXR5PSIwLjMiIGQ9Ik05LC41YTksOSwwLDEsMCw5LDlBOSw5LDAsMCwwLDksLjVaIj48L3BhdGg+PGNpcmNsZSBjbGFzcz0iaWNvbi1iYWNrZ3JvdW5kIiBmaWxsPSIjZjhmOGY4IiBjeD0iOSIgY3k9IjkiIHI9IjguNSI+PC9jaXJjbGU+PHBhdGggY2xhc3M9Imljb24tY29tcG9uZW50LXNoYWRvdyIgZmlsbD0iI2U4ZThlOCIgZD0iTTksMUE4LDgsMCwxLDEsMSw5LDgsOCwwLDAsMSw5LDFNOSwwYTksOSwwLDEsMCw5LDlBOSw5LDAsMCwwLDksMFoiPjwvcGF0aD48cGF0aCBkPSJNMTEuNDQsOC4xMWgxLjc0bC4xLTEuNTVIMTEuNTRsLjE4LTIuNzhIMTAuMTdMMTAsNi41Nkg4LjMxbC4xOC0yLjc4SDYuOTRMNi43Niw2LjU2SDVsLS4xLDEuNTVINi42Nkw2LjU1LDkuNzlINC44MmwtLjEsMS41NUg2LjQ2bC0uMTgsMi43OEg3LjgzTDgsMTEuMzRIOS42OWwtLjE4LDIuNzhoMS41NWwuMTgtMi43OEgxM2wuMS0xLjU1SDExLjM0Wk04LjExLDkuNzlsLjEtMS42OEg5Ljg5bC0uMSwxLjY4WiI+PC9wYXRoPjwvZz48L3N2Zz4=", "checkmate_black": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGNsYXNzPSIiIHZpZXdCb3g9IjAgMCAxOCAxOSI+PGcgaWQ9ImNoZWNrbWF0ZV9ibGFjayI+PHBhdGggY2xhc3M9Imljb24tc2hhZG93IiBvcGFjaXR5PSIwLjMiIGQ9Ik05LC41YTksOSwwLDEsMCw5LDlBOSw5LDAsMCwwLDksLjVaIj48L3BhdGg+PHBhdGggY2xhc3M9Imljb24tYmFja2dyb3VuZCIgZmlsbD0iIzMxMmUyYiIgZD0iTTksMGE5LDksMCwxLDAsOSw5QTksOSwwLDAsMCw5LDBaIj48L3BhdGg+PHBhdGggZD0iTTExLjQ0LDguNDFoMS43NGwuMS0xLjU1SDExLjU0bC4xOC0yLjc4SDEwLjE3TDEwLDYuODZIOC4zMWwuMTgtMi43OEg2Ljk0TDYuNzYsNi44Nkg1bC0uMSwxLjU1SDYuNjZsLS4xMSwxLjY4SDQuODJsLS4xLDEuNTVINi40NmwtLjE4LDIuNzhINy44M0w4LDExLjY0SDkuNjlsLS4xOCwyLjc4aDEuNTVsLjE4LTIuNzhIMTNsLjEtMS41NUgxMS4zNFpNOC4xMSwxMC4wOWwuMS0xLjY4SDkuODlsLS4xLDEuNjhaIj48L3BhdGg+PHBhdGggY2xhc3M9Imljb24tY29tcG9uZW50LXNoYWRvdyIgZmlsbD0iI2ZmZiIgZD0iTTExLjQ0LDcuOTFoMS43NGwuMS0xLjU1SDExLjU0bC4xOC0yLjc4SDEwLjE3TDEwLDYuMzZIOC4zMWwuMTgtMi43OEg2Ljk0TDYuNzYsNi4zNkg1bC0uMSwxLjU1SDYuNjZMNi41NSw5LjU5SDQuODJsLS4xLDEuNTVINi40NmwtLjE4LDIuNzhINy44M0w4LDExLjE0SDkuNjlsLS4xOCwyLjc4aDEuNTVsLjE4LTIuNzhIMTNsLjEtMS41NUgxMS4zNFpNOC4xMSw5LjU5bC4xLTEuNjhIOS44OWwtLjEsMS42OFoiPjwvcGF0aD48L2c+PC9zdmc+"};
  function setEndIcon(key) {
    const el = $("endIcon");
    const icon = key === "query_stats"
      ? "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="white" d="M4 19h16v2H2V3h2v16zm3-2H5v-5h2v5zm5 0h-2V7h2v10zm5 0h-2V3h2v14z"/></svg>')
      : key === "loser" ? END_ICONS.checkmate_black : END_ICONS[key] || END_ICONS.winner;
    const image = document.createElement("img");
    image.className = "cat-ic";
    image.src = icon;
    image.alt = "";
    image.draggable = false;
    image.setAttribute("aria-hidden", "true");
    el.classList.add("svg");
    el.replaceChildren(image);
  }
  function endIconKey(r) {
    const mine = myColor || (botEnabled ? (botColor === "w" ? "b" : "w") : null), pc = mine || "w";
    const iconColor = color => color === "w" ? "white" : "black";
    if (!r.w) return "draw_" + iconColor(pc);
    const won = mine ? r.w === mine : null;
    if (won === true) return "winner";
    const mate = /mate/i.test(r.why || "");
    if (won === false) return "loser";
    return mate ? "checkmate_" + iconColor(r.w) : "winner";
  }
  const CAT_ORDER = ["brilliant", "best", "excellent", "good", "inaccuracy", "mistake", "blunder", "missed"];
  const winPct = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1500, Math.min(1500, cp)))) - 1);   // cp = centipeones, punto de vista blancas
  const fmtEval = e => Math.abs(e) >= 90 ? (e > 0 ? "" : "-") + "M" + Math.max(0, Math.round(100 - Math.abs(e))) : (e > 0 ? "+" : "") + e.toFixed(1);
  const sideName = c => myColor ? (c === myColor ? "Tú" : "Rival") : botEnabled ? (c === botColor ? "Bot" : "Tú") : (c === "w" ? "Blancas" : "Negras");

  async function analyzeGame() {
    if (analysisRunning) return;
    if (botThinking) { showToast("Espera a que el bot termine su jugada"); return }
    if (online() && !getResult()) { showToast("Puedes analizar la partida cuando haya terminado"); return }
    const history = game.history({ verbose: true });
    if (!history.length) { showToast("Juega o carga una partida antes de analizarla"); return }
    analysisRunning = true; analysisCancelled = false; report = null; reviewing = false;
    $("analyzeBtn").disabled = true; $("stopAnalyzeBtn").disabled = false;
    $("endStopAnalyze").disabled = false;
    const results = analysisResults(); results.innerHTML = "";
    try {
      analysisStatus().textContent = "Cargando Stockfish…";
      await ensureEngine();
      const replay = new Chess(), positions = [{ fen: replay.fen(), term: null }];
      history.forEach(m => {
        replay.move({ from: m.from, to: m.to, promotion: m.promotion || "q" });
        // Posiciones terminales: no se buscan con el motor (no hay jugada) y se evalúan a mano.
        let term = null;
        if (replay.in_checkmate()) term = replay.turn() === "w" ? -100 : 100;
        else if (replay.game_over()) term = 0;
        positions.push({ fen: replay.fen(), term });
      });
      const evals = [], bestMoves = [];
      for (let i = 0; i < positions.length; i++) {
        if (analysisCancelled) break;
        analysisStatus().textContent = "Analizando posición " + (i + 1) + " de " + positions.length + "…";
        const pg = $("endProg"); if (pg) pg.style.width = ((i + 1) / positions.length * 100) + "%";
        if (positions[i].term !== null) { evals.push(positions[i].term); bestMoves.push(""); continue }
        const r = await engineSearch(positions[i].fen, 12, 20, engineInfo.modern ? 450 : 200);   // nivel 20: el análisis siempre a fuerza completa
        const turn = positions[i].fen.split(" ")[1];
        evals.push((turn === "w" ? r.score : -r.score) / 100);
        bestMoves.push(r.move);
      }
      if (analysisCancelled) { analysisStatus().textContent = "Análisis detenido. Los resultados pueden estar incompletos."; return }
      const pieceValue = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 99 };
      const rows = [];
      history.forEach((m, i) => {
        const before = evals[i], after = evals[i + 1];
        if (before === undefined || after === undefined) return;
        const playerBefore = m.color === "w" ? before : -before;
        const playerAfter = m.color === "w" ? after : -after;
        let lost = Math.max(0, playerBefore - playerAfter);
        const uci = m.from + m.to + (m.promotion || "");
        const isBest = (bestMoves[i] || "").slice(0, 4) === uci.slice(0, 4) || Math.abs(positions[i + 1].term ?? 0) === 100;   // dar mate siempre es la mejor
        if (isBest) lost = Math.min(lost, 0.1);   // la jugada del propio motor no puede ser un error
        // Sacrificio real: la pieza movida (no peón/rey) queda atacada y se pierde al menos 2 puntos de material neto,
        // sin dar mate y sin estar ya la partida decidida. Es una heurística, no un juicio humano.
        let sacrifice = false;
        if (!positions[i + 1].term && m.piece !== "p" && m.piece !== "k" && playerBefore <= 6 && playerAfter >= -0.5 && playerAfter >= playerBefore - 0.2) {
          const net = (pieceValue[m.piece] || 0) - (pieceValue[m.captured] || 0);
          if (net >= 2) { try { sacrifice = new Chess(positions[i + 1].fen).moves({ verbose: true }).some(x => x.to === m.to && x.captured) } catch (_) { } }
        }
        let key;
        if (playerBefore >= 3 && playerAfter <= 1 && lost >= 1.5) key = "missed";
        else if (sacrifice && lost <= 0.2) key = "brilliant";
        else if (isBest && lost <= 0.5) key = "best";
        else if (lost <= 0.15) key = "excellent";
        else if (lost <= 0.5) key = "good";
        else if (lost <= 1.5) key = "inaccuracy";
        else if (lost <= 3) key = "mistake";
        else key = "blunder";
        // Precisión por jugada (fórmula tipo Chess.com, sobre la probabilidad de ganar)
        const wpB = m.color === "w" ? winPct(before * 100) : 100 - winPct(before * 100);
        const wpA = m.color === "w" ? winPct(after * 100) : 100 - winPct(after * 100);
        const acc = isBest ? 100 : Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * Math.max(0, wpB - wpA)) - 3.1669));
        let bestSan = "";
        if (!isBest && bestMoves[i] && bestMoves[i] !== "(none)") {
          try { const t = new Chess(positions[i].fen); const bm = t.move({ from: bestMoves[i].slice(0, 2), to: bestMoves[i].slice(2, 4), promotion: bestMoves[i][4] || "q" }); if (bm) bestSan = bm.san } catch (_) { }
        }
        rows.push({ i, m, key, lost, before, after, acc, isBest, bestSan, bestUci: bestMoves[i] || "", fen: positions[i + 1].fen });
      });
      report = { rows, evals, startFen: positions[0].fen };
      if (results === $("endAnalysisResults")) {
        renderReport(results, report);
      } else {
        renderSidebarList(results, rows);
      }
      analysisStatus().textContent = "Análisis terminado · las categorías son estimaciones del motor.";
      renderReviewPanel();
    } catch (e) { analysisStatus().textContent = e.message || "Error durante el análisis."; showToast(e.message || "Error al analizar") }
    finally { analysisRunning = false; $("analyzeBtn").disabled = false; $("stopAnalyzeBtn").disabled = true; $("endStopAnalyze").disabled = true }
  }

  // Lista compacta del panel lateral (comportamiento anterior)
  function renderSidebarList(results, rows) {
    const counts = {}; CAT_ORDER.forEach(k => counts[k] = 0);
    const frag = document.createDocumentFragment();
    rows.forEach(r => {
      counts[r.key]++;
      const cls = r.key === "brilliant" ? "brilliant" : r.key === "best" ? "best" : ["inaccuracy", "mistake", "blunder", "missed"].includes(r.key) ? "bad" : "good";
      const row = document.createElement("div"); row.className = "engine-result " + cls;
      const no = document.createElement("span"); no.textContent = (Math.floor(r.i / 2) + 1) + (r.m.color === "w" ? "." : "…");
      const mv = document.createElement("span"); mv.textContent = r.m.san + " · " + CATS[r.key].label;
      const ev = document.createElement("span"); ev.className = "engine-eval"; ev.textContent = fmtEval(r.after);
      row.append(no, mv, ev); row.title = "Pérdida estimada: " + r.lost.toFixed(2) + " peones · Pulsa para revisar"; row.onclick = () => { closeEnd(); goPly(r.i + 1) }; frag.appendChild(row);
    });
    const summary = document.createElement("div"); summary.className = "engine-summary";
    CAT_ORDER.map(k => [counts[k], CATS[k].plural]).concat([[rows.length, "Jugadas"]]).forEach(([v, l]) => {
      const c = document.createElement("div"); c.className = "engine-stat"; const st = document.createElement("strong"); st.textContent = v; const sp = document.createElement("span"); sp.textContent = l; c.append(st, sp); summary.appendChild(c);
    });
    results.append(summary, frag);
  }

  // Gráfica de evaluación (probabilidad de ganar de las blancas); compartida por el modal y el panel de revisión
  function drawGraph(svg, evals) {
    const W = 600, H = 64, n = evals.length;
    const X = k => n > 1 ? k * W / (n - 1) : 0, Y = e => H * (1 - winPct(e * 100) / 100);
    let d = "M0," + H + " "; evals.forEach((e, k) => { d += "L" + X(k).toFixed(1) + "," + Y(e).toFixed(1) + " " }); d += "L" + W + "," + H + " Z";
    svg.setAttribute("viewBox", "0 0 " + W + " " + H); svg.setAttribute("preserveAspectRatio", "none");
    svg.innerHTML = '<rect width="' + W + '" height="' + H + '" fill="var(--line)"/><path d="' + d + '" fill="var(--bright)" opacity=".18"/><line x1="0" x2="' + W + '" y1="' + H / 2 + '" y2="' + H / 2 + '" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 4" opacity=".8"/><line class="gc" x1="-9" x2="-9" y1="0" y2="' + H + '" stroke="var(--accent)" stroke-width="3"/>';
  }
  const graphPly = (svg, e, n) => { const r = svg.getBoundingClientRect(); return Math.max(0, Math.min(n - 1, Math.round((e.clientX - r.left) / (r.width || 1) * (n - 1)))) };

  // Modal compacto: 1) categorías 2) precisión 3) evolución; el repaso se hace en el tablero real
  function renderReport(root, data) {
    const { rows, evals } = data, n = evals.length;
    root.innerHTML = "";
    const side = { w: rows.filter(r => r.m.color === "w"), b: rows.filter(r => r.m.color === "b") };
    const cnt = { w: {}, b: {} };
    [ "w", "b" ].forEach(c => { CAT_ORDER.forEach(k => cnt[c][k] = 0); side[c].forEach(r => cnt[c][r.key]++) });
    const stat = rs => rs.length ? {
      acc: rs.reduce((a, r) => a + r.acc, 0) / rs.length,
      acpl: rs.reduce((a, r) => a + Math.min(r.lost, 10), 0) / rs.length,
      top: rs.filter(r => [ "brilliant", "best", "excellent" ].includes(r.key)).length / rs.length * 100
    } : { acc: 0, acpl: 0, top: 0 };
    const accCol = a => a >= 90 ? "#26c9a2" : a >= 80 ? "#81b64c" : a >= 65 ? "#f7c631" : a >= 50 ? "#e8912d" : "#ca3431";
    const C = 2 * Math.PI * 30;
    const player = c => {
      const m = stat(side[c]), col = accCol(m.acc);
      return '<div class="an-pl"><div class="an-gauge"><svg viewBox="0 0 72 72"><circle cx="36" cy="36" r="30" class="bg"/><circle cx="36" cy="36" r="30" stroke="' + col + '" stroke-dasharray="' + (C * m.acc / 100).toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(-90 36 36)"/></svg><b>' + m.acc.toFixed(0) + '</b></div>' +
        '<div><div class="an-who"><i style="background:' + (c === "w" ? "#f2f0ea" : "#3b3a37") + '"></i>' + sideName(c) + '</div><div class="an-sub">Precisión · pérd. media <b>' + m.acpl.toFixed(2) + '</b> · top <b>' + m.top.toFixed(0) + '%</b></div></div></div>';
    };
    const max = Math.max(1, ...CAT_ORDER.flatMap(k => [ cnt.w[k], cnt.b[k] ]));
    const bar = (c, k) => '<div class="an-b ' + c + '"><i style="width:' + (cnt[c][k] / max * 100) + '%;background:' + CATS[k].color + '"></i></div>';
    let rowsHtml = "";
    CAT_ORDER.forEach(k => {
      const cat = CATS[k];
      rowsHtml += '<div class="an-row' + (cnt.w[k] + cnt.b[k] ? "" : " zero") + '" title="' + cat.desc + '"><span class="an-n">' + cnt.w[k] + '</span>' + bar("w", k) +
        '<span class="an-lab">' + catImg(k) + cat.label + '</span>' + bar("b", k) + '<span class="an-n">' + cnt.b[k] + '</span></div>';
    });
    const moments = rows.filter(r => [ "brilliant", "missed", "blunder", "mistake" ].includes(r.key))
      .sort((a, b) => (b.key === "brilliant") - (a.key === "brilliant") || b.lost - a.lost).slice(0, 6);
    const chips = moments.map((r, j) => '<button class="an-chip" data-ply="' + (r.i + 1) + '" style="--c:' + CATS[r.key].color + '">' + catImg(r.key) +
      (Math.floor(r.i / 2) + 1) + (r.m.color === "w" ? "." : "…") + " " + r.m.san + '<small>' + CATS[r.key].label + '</small></button>').join("");
    const dots = rows.filter(r => [ "brilliant", "missed", "blunder", "mistake" ].includes(r.key)).map(r => {
      const wp = winPct(r.after * 100);
      return '<span class="an-dot" style="left:' + ((r.i + 1) / Math.max(1, n - 1) * 100).toFixed(2) + '%;top:' + (100 - wp).toFixed(1) + '%;background:' + CATS[r.key].color + '"></span>';
    }).join("");
    root.innerHTML = '<div class="an-wrap"><div class="an-players">' + player("w") + player("b") + '</div>' +
      '<div class="an-h">Jugadas por categoría</div><div class="an-cats">' + rowsHtml + '</div>' +
      (chips ? '<div class="an-h">Momentos clave</div><div class="an-chips">' + chips + '</div>' : "") +
      '<div class="an-h">Evolución de la partida · pulsa para ir a esa jugada</div><div class="an-gwrap"><svg class="an-graph"></svg>' + dots + '</div>' +
      '<div class="an-legend">' + [ "brilliant", "mistake", "blunder", "missed" ].map(k => '<span>' + catImg(k) + CATS[k].label + '</span>').join("") + '</div></div>';
    const g = root.querySelector(".an-graph"); drawGraph(g, evals);
    g.addEventListener("click", e => startReview(graphPly(g, e, n)));
    root.querySelectorAll(".an-chip").forEach(b => b.onclick = () => startReview(Number(b.dataset.ply)));
    $("endAnalysis").classList.add("done"); $("endBox").classList.add("analyzed"); $("endReview").hidden = false;
  }

  /* ---------- Modo análisis sobre el tablero real ---------- */
  function startReview(ply) {
    if (!report) return;
    const n = game.history().length;
    ply = Math.max(0, Math.min(n, ply || 0));
    reviewing = true; selected = null; legalTargets = [];
    closeEnd(); showTab("moves");
    historyPly = ply === n ? null : ply;
    drawGraph($("rvGraph"), report.evals);
    render();
  }
  function exitReview() { reviewing = false; render() }
  function reviewArrows() {
    if (!reviewing || !report) return [];
    const k = curPly(), r = k > 0 ? report.rows[k - 1] : null;
    if (!r || r.isBest || !r.bestUci || r.bestUci.length < 4 || r.bestUci === "(none)") return [];
    return [{ from: r.bestUci.slice(0, 2), to: r.bestUci.slice(2, 4), color: "#4aa3ff", marker: "arrowhead-rv" }];
  }
  function renderReviewPanel() {
    const panel = $("reviewPanel"); if (!panel) return;
    $("reviewBtn").hidden = !(report && !reviewing && !analysisRunning);
    panel.hidden = !(reviewing && report);
    if (panel.hidden) return;
    const k = curPly(), r = k > 0 ? report.rows[k - 1] : null, e = report.evals[k], card = $("rvCard");
    if (!r) {
      card.innerHTML = '<div class="rv-move">Posición inicial<span class="rv-eval">' + fmtEval(e) + '</span></div><div class="rv-desc">Avanza con ← → o pulsa una jugada de la lista. Aquí verás cómo la califica el motor.</div>';
    } else {
      const c = CATS[r.key];
      let extra = "";
      if (r.bestSan && !r.isBest) extra += '<div class="rv-desc">Mejor era <b style="color:#4aa3ff">' + r.bestSan + '</b> (flecha azul en el tablero).</div>';
      if (r.lost >= 0.15) extra += '<div class="rv-desc" style="color:var(--muted)">Pérdida: ' + r.lost.toFixed(2) + ' peones · precisión de la jugada: ' + r.acc.toFixed(0) + '%</div>';
      card.innerHTML = '<div class="rv-move"><span class="rp-dot" style="background:none">' + catImg(r.key) + '</span>' + (Math.floor(r.i / 2) + 1) + (r.m.color === "w" ? ". " : "… ") + r.m.san + '<span class="rv-eval">' + fmtEval(e) + '</span></div>' +
        '<div class="rv-cat" style="color:' + c.color + '">' + c.label + ' · ' + sideName(r.m.color) + '</div><div class="rv-desc">' + c.desc + '</div>' + extra;
    }
    card.insertAdjacentHTML("beforeend", '<div class="rv-bar" title="Probabilidad de ganar de las blancas"><i style="width:' + winPct(e * 100).toFixed(1) + '%"></i></div>');
    const gc = $("rvGraph").querySelector(".gc");
    if (gc) { const x = report.evals.length > 1 ? k * 600 / (report.evals.length - 1) : 0; gc.setAttribute("x1", x); gc.setAttribute("x2", x) }
  }
  $("rvExit").onclick = exitReview;
  $("reviewBtn").onclick = () => startReview(0);
  $("rvGraph").addEventListener("click", e => { if (report) goPly(graphPly($("rvGraph"), e, report.evals.length)) });
  $("endReview").onclick = () => startReview(reviewing ? curPly() : 0);
  // Volver del tablero al panel de estadísticas (sin repetir el análisis)
  function showStats() {
    if (!report) return;
    if (!getResult()) { setEndIcon("query_stats"); $("endTitle").textContent = "Estadísticas de la partida"; $("endSub").textContent = "" }
    $("endAnalysis").hidden = false; renderReport($("endAnalysisResults"), report);
    $("endModal").style.display = "flex";
  }
  function jumpErr(dir) {
    if (!report) return;
    const ids = report.rows.filter(r => ["mistake", "blunder", "missed"].includes(r.key)).map(r => r.i + 1), k = curPly();
    const t = dir > 0 ? ids.find(p => p > k) : ids.slice().reverse().find(p => p < k);
    if (t === undefined) { showToast(dir > 0 ? "No hay más errores adelante" : "No hay errores anteriores"); return }
    goPly(t);
  }
  $("rvStats").onclick = showStats;
  $("rvNextErr").onclick = () => jumpErr(1);
  $("rvPrevErr").onclick = () => jumpErr(-1);

  /* ---------- Ajustes: piezas y tablero (assets de chess.com) ---------- */
  const PIECE_SETS = ["neo", "classic", "wood", "neo_wood", "alpha", "glass", "gothic", "marble", "metal", "modern", "nature", "ocean", "space", "vintage", "tournament", "club", "condal", "game_room", "icy_sea", "maya", "lolz", "neon", "newspaper", "sky", "tigers", "graffiti", "light", "bases", "book", "cases", "8_bit", "bubblegum", "dash", "luca", "3d_chesskid", "3d_plastic", "3d_staunton", "3d_wood", "blind_easy", "blind_medium", "blind_hard", "blind_transparent"];
  const PIECE_NAMES = { blind_easy: "Blind: fácil", blind_medium: "Blind: medio", blind_hard: "Blind: difícil", blind_transparent: "Blind: todo", neo: "Neo", classic: "Clásico", wood: "Madera", neo_wood: "Neo madera", alpha: "Alpha", glass: "Cristal", gothic: "Gótico", marble: "Mármol", metal: "Metal", modern: "Moderno", nature: "Naturaleza", ocean: "Océano", space: "Espacio", vintage: "Vintage", tournament: "Torneo", club: "Club", condal: "Condal", game_room: "Sala de juegos", icy_sea: "Mar helado", maya: "Maya", lolz: "Lolz", neon: "Neón", newspaper: "Periódico", sky: "Cielo", tigers: "Tigres", graffiti: "Grafiti", light: "Claro", bases: "Bases", book: "Libro", cases: "Cases", bubblegum: "Chicle", "8_bit": "8 bits", "3d_chesskid": "3D Chesskid", "3d_plastic": "3D plástico", "3d_staunton": "3D Staunton", "3d_wood": "3D madera" };
  const COLOR_BOARDS = [
    { id: "c-verde", name: "Verde", light: "#ebecd0", dark: "#779556" },
    { id: "c-marron", name: "Marrón", light: "#edd6b0", dark: "#b88762" },
    { id: "c-azul", name: "Azul", light: "#dee3e6", dark: "#8ca2ad" },
    { id: "c-morado", name: "Morado", light: "#f0f1f0", dark: "#8476ba" },
    { id: "c-arena", name: "Arena", light: "#f0d9b5", dark: "#b58863" },
    { id: "c-hielo", name: "Hielo", light: "#e8f0f5", dark: "#7ba3c0" },
    { id: "c-coral", name: "Coral", light: "#f6e3d3", dark: "#c5785f" },
    { id: "c-gris", name: "Gris", light: "#e6e6e6", dark: "#8b8b8b" },
    { id: "c-noche", name: "Noche", light: "#7d8796", dark: "#4b5563" }
  ];
  const IMG_BOARDS = ["green", "blue", "brown", "light", "wood", "dark_wood", "walnut", "burled_wood", "marble", "stone", "metal", "glass", "icy_sea", "sea", "sand", "parchment", "newspaper", "tournament", "neon", "graffiti", "lolz", "orange", "purple", "red", "bubblegum", "translucent", "checkers", "dash", "8_bit", "bases", "overlay"];
  const IMG_BOARD_NAMES = { green: "Verde (chess.com)", blue: "Azul (chess.com)", brown: "Marrón (chess.com)", light: "Claro", wood: "Madera", dark_wood: "Madera oscura", walnut: "Nogal", burled_wood: "Raíz de madera", marble: "Mármol", stone: "Piedra", metal: "Metal", glass: "Cristal", icy_sea: "Mar helado", sea: "Mar", sand: "Arena", parchment: "Pergamino", newspaper: "Periódico", tournament: "Torneo", neon: "Neón", graffiti: "Grafiti", lolz: "Lolz", orange: "Naranja", purple: "Morado (chess.com)", red: "Rojo", bubblegum: "Chicle", translucent: "Translúcido", checkers: "Damas", "8_bit": "8 bits", bases: "Bases", overlay: "Overlay", dash: "Dash" };
  const prettyName = id => id.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase());
  const boardImgUrl = (id, size) => "https://images.chesscomfiles.com/chess-themes/boards/" + id.slice(4) + "/" + size + ".png";
  const boardInfo = id => id.startsWith("img:") ? { id, img: true } : (COLOR_BOARDS.find(b => b.id === id) || COLOR_BOARDS[0]);
  let settingsBuilt = { pieces: false, boards: false, theme: false };

  function applyBoard() {
    const b = boardInfo(boardTheme), targets = [$("board"), $("stPreview")], root = document.documentElement.style;
    if (b.img) {
      const url = boardImgUrl(b.id, 150);
      targets.forEach(t => { t.style.backgroundImage = 'url("' + url + '")'; t.style.backgroundSize = "100% 100%" });
      document.body.classList.add("board-img");
      const probe = new Image();
      probe.onerror = () => { if (boardTheme === b.id) { boardTheme = "c-verde"; store.set("ajedrez.board", boardTheme); applyBoard(); syncSettings(); showToast("No se pudo cargar ese tablero") } };
      probe.src = url;
    } else {
      targets.forEach(t => { t.style.backgroundImage = ""; t.style.backgroundSize = "" });
      document.body.classList.remove("board-img");
      root.setProperty("--light", b.light); root.setProperty("--dark", b.dark);
    }
  }
  function renderPreview() {
    const pv = $("stPreview"), g = new Chess(); pv.innerHTML = "";
    for (let r = 7; r >= 0; r--)for (let f = 0; f < 8; f++) {
      const sq = document.createElement("div"); sq.className = "pv-sq " + (((f + r + 1) % 2 === 0) ? "light" : "dark");
      const pc = g.get(files[f] + (r + 1));
      if (pc) { const im = document.createElement("img"); im.src = PIECE(pc.color, pc.type); im.alt = ""; sq.appendChild(im) }
      pv.appendChild(sq);
    }
  }
  function applyUiTheme() {
    const theme = UI_THEMES[uiTheme] || UI_THEMES.dark;
    const accent = ACCENT_PRESETS[accentId] || ACCENT_PRESETS.verde;
    const root = document.documentElement.style;
    const accentStrong = uiTheme === "light" ? accent.light : accent.dark;
    const accentSoft = uiTheme === "light" ? accent.accent : accent.accent;
    root.setProperty("--bg", theme.bg);
    root.setProperty("--card", theme.card);
    root.setProperty("--line", theme.line);
    root.setProperty("--text", theme.text);
    root.setProperty("--bright", theme.bright);
    root.setProperty("--muted", theme.muted);
    root.setProperty("--green", accentStrong);
    root.setProperty("--green2", accentSoft);
    root.setProperty("--accent", accentStrong);
    root.setProperty("--accent-soft", accentSoft);
    document.body.style.background = theme.bg;
    document.body.style.color = theme.text;
  }

  function syncSettings() {
    document.querySelectorAll("#stPieces .st-card").forEach(c => c.classList.toggle("sel", c.dataset.id === pieceSet));
    document.querySelectorAll("#stBoards .st-card").forEach(c => c.classList.toggle("sel", c.dataset.id === boardTheme));
    document.querySelectorAll("#stTheme .st-card").forEach(c => {
      if (c.dataset.kind === "theme") c.classList.toggle("sel", c.dataset.id === uiTheme);
      if (c.dataset.kind === "accent") c.classList.toggle("sel", c.dataset.id === accentId);
    });
  }
  function choosePieces(id) { pieceSet = id; store.set("ajedrez.pieces", id); syncSettings(); render(); renderPreview() }
  function chooseBoard(id) { boardTheme = id; store.set("ajedrez.board", id); applyBoard(); syncSettings() }
  function chooseUiTheme(id) { uiTheme = id; store.set("ajedrez.uiTheme", id); applyUiTheme(); if (settingsBuilt.theme) buildThemeCards(); syncSettings(); }
  function chooseAccent(id) { accentId = id; store.set("ajedrez.accent", id); applyUiTheme(); if (settingsBuilt.theme) buildThemeCards(); syncSettings(); }
  function buildThemeCards() {
    const grid = $("stTheme");
    grid.className = "st-grid st-theme-page";
    grid.innerHTML = "";

    const page = document.createElement("div");
    page.className = "st-theme-page";

    const themeSection = document.createElement("div");
    themeSection.className = "st-theme-section";
    const themeHead = document.createElement("div");
    themeHead.className = "st-theme-head";
    themeHead.textContent = "Tema";
    const themeList = document.createElement("div");
    themeList.className = "st-theme-list";
    Object.values(UI_THEMES).forEach(theme => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "st-card st-theme-option";
      b.dataset.id = theme.id;
      b.dataset.kind = "theme";
      const th = document.createElement("div");
      th.className = "st-thumb theme";
      th.style.background = "linear-gradient(135deg, " + theme.bg + " 0%, " + theme.card + " 55%, " + theme.line + " 100%)";
      const sp = document.createElement("span");
      sp.textContent = theme.name;
      b.append(th, sp);
      b.onclick = () => chooseUiTheme(theme.id);
      themeList.appendChild(b);
    });
    themeSection.append(themeHead, themeList);

    const accentSection = document.createElement("div");
    accentSection.className = "st-theme-section";
    const accentHead = document.createElement("div");
    accentHead.className = "st-theme-head";
    accentHead.textContent = "Acento";
    const accentList = document.createElement("div");
    accentList.className = "st-theme-list";
    Object.values(ACCENT_PRESETS).forEach(accent => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "st-card st-theme-option";
      b.dataset.id = accent.id;
      b.dataset.kind = "accent";
      const th = document.createElement("div");
      th.className = "st-accent";
      const a1 = document.createElement("span");
      a1.style.background = uiTheme === "light" ? accent.light : accent.dark;
      const a2 = document.createElement("span");
      a2.style.background = accent.accent;
      th.style.background = "linear-gradient(90deg, " + (uiTheme === "light" ? accent.light : accent.dark) + " 0%, " + accent.accent + " 100%)";
      th.append(a1, a2);
      const sp = document.createElement("span");
      sp.textContent = accent.name;
      b.append(th, sp);
      b.onclick = () => chooseAccent(accent.id);
      accentList.appendChild(b);
    });
    accentSection.append(accentHead, accentList);

    page.append(themeSection, accentSection);
    grid.appendChild(page);
  }
  function buildPieceCards() {
    const grid = $("stPieces");
    PIECE_SETS.forEach(id => {
      const b = document.createElement("button"); b.type = "button"; b.className = "st-card"; b.dataset.id = id;
      const th = document.createElement("div"); th.className = "st-thumb";
      const i1 = new Image(); i1.alt = ""; i1.onerror = () => b.remove(); i1.src = pieceUrl(id, "w", "n");   // si el set no existe, la tarjeta desaparece
      const i2 = new Image(); i2.alt = ""; i2.onerror = () => { i2.style.display = "none" }; i2.src = pieceUrl(id, "b", "q");
      th.append(i1, i2);
      const sp = document.createElement("span"); sp.textContent = PIECE_NAMES[id] || prettyName(id);
      b.append(th, sp); b.onclick = () => choosePieces(id); grid.appendChild(b);
    });
  }
  function buildBoardCards() {
    const grid = $("stBoards");
    COLOR_BOARDS.forEach(c => {
      const b = document.createElement("button"); b.type = "button"; b.className = "st-card"; b.dataset.id = c.id;
      const th = document.createElement("div"); th.className = "st-thumb bd";
      th.style.background = "repeating-conic-gradient(" + c.dark + " 0 25%," + c.light + " 0 50%) 0 0/50% 50%";
      const sp = document.createElement("span"); sp.textContent = c.name;
      b.append(th, sp); b.onclick = () => chooseBoard(c.id); grid.appendChild(b);
    });
    IMG_BOARDS.forEach(name => {
      const id = "img:" + name, b = document.createElement("button"); b.type = "button"; b.className = "st-card"; b.dataset.id = id;
      const th = document.createElement("div"); th.className = "st-thumb bd";
      const sp = document.createElement("span"); sp.textContent = IMG_BOARD_NAMES[name] || prettyName(name);
      b.append(th, sp); b.onclick = () => chooseBoard(id);
      // miniatura ligera (76) con reserva a 150; si ninguna carga, ese tablero no existe y se quita
      const load = sizes => { const im = new Image(); im.onload = () => { th.style.backgroundImage = 'url("' + im.src + '")' }; im.onerror = () => { sizes.length ? load(sizes) : b.remove() }; im.src = boardImgUrl(id, sizes.shift()) };
      load([76, 150]);
      grid.appendChild(b);
    });
  }
  function showSettingsTab(t) {
    document.querySelectorAll(".st-tab").forEach(b => b.classList.toggle("active", b.dataset.st === t));
    $("stPieces").hidden = t !== "pieces"; $("stBoards").hidden = t !== "boards"; $("stTheme").hidden = t !== "theme"; $("stGeneral").hidden = t !== "general";
    if (t === "boards" && !settingsBuilt.boards) { settingsBuilt.boards = true; buildBoardCards(); syncSettings() }
    if (t === "theme" && !settingsBuilt.theme) { settingsBuilt.theme = true; buildThemeCards(); syncSettings() }
  }
  function openSettings() {
    if (!settingsBuilt.pieces) { settingsBuilt.pieces = true; buildPieceCards() }
    if (!settingsBuilt.theme) { settingsBuilt.theme = true; buildThemeCards() }
    syncSettings(); renderPreview(); applyBoard();
    $("settingsModal").style.display = "flex";
  }
  const closeSettings = () => { $("settingsModal").style.display = "none" };
  const openHistory = () => { renderHistoryList(); $("historyModal").style.display = "flex" };
  const closeHistory = () => { $("historyModal").style.display = "none" };
  let activeWatchCode = null;
  let watchFlipped = false;
  const closeWatch = () => {
    activeWatchCode = null;
    watchFlipped = false;
    $("watchBoard").style.transform = "none";
    $("watchModal").style.display = "none";
  };
  $("watchRotateBtn").onclick = () => {
    watchFlipped = !watchFlipped;
    const data = activeWatchCode ? liveMatches[activeWatchCode] : null;
    if (data) {
      const watchGame = new Chess();
      try { watchGame.load(data.fen || "startpos") } catch (_) { }
      renderWatchBoard(watchGame);
    }
  };
  $("settingsBtn").onclick = openSettings;
  $("historyBtn").onclick = openHistory;
  $("historyClose").onclick = closeHistory;
  $("watchClose").onclick = closeWatch;
  $("stClose").onclick = $("stDone").onclick = closeSettings;
  $("settingsModal").addEventListener("click", e => { if (e.target === $("settingsModal")) closeSettings() });
  $("historyModal").addEventListener("click", e => { if (e.target === $("historyModal")) closeHistory() });
  $("watchModal").addEventListener("click", e => { if (e.target === $("watchModal")) closeWatch() });
  document.querySelectorAll(".st-tab").forEach(b => b.onclick = () => showSettingsTab(b.dataset.st));
  $("stReset").onclick = () => { pieceSet = "neo"; boardTheme = "c-verde"; uiTheme = "dark"; accentId = "verde"; markColor = "#e34f4f"; persistentMarks = false; premovesEnabled = false; $("markColorInput").value = markColor; $("persistentMarksInput").checked = false; $("premovesInput").checked = false; store.set("ajedrez.premoves", "false"); saveMarkSettings(); store.set("ajedrez.pieces", pieceSet); store.set("ajedrez.board", boardTheme); store.set("ajedrez.uiTheme", uiTheme); store.set("ajedrez.accent", accentId); applyBoard(); applyUiTheme(); syncSettings(); render(); renderPreview(); drawAnnotations() };
  // con los ajustes abiertos, Esc los cierra y las flechas no mueven el tablero de detrás
  document.addEventListener("keydown", e => {
    if ($("settingsModal").style.display !== "flex") return;
    if (e.key === "Escape") { e.stopImmediatePropagation(); closeSettings() }
    else if (e.key.startsWith("Arrow")) e.stopImmediatePropagation();
  }, true);
  applyBoard();
  applyUiTheme();

  /* ---------- Navegación por Teclado ---------- */
  document.addEventListener("keydown", e => {
    if (/INPUT|SELECT/.test(e.target.tagName)) return;
    const h = game.history();
    if (!h.length) return;
    const current = historyPly !== null ? historyPly : h.length;

    if (e.key === "ArrowLeft") goPly(current - 1);
    else if (e.key === "ArrowRight") goPly(current + 1);
    else if (e.key === "ArrowUp") goPly(0);
    else if (e.key === "ArrowDown") goPly(h.length);
    else if (e.key === "Escape") {
      cancelDrag();
      $("promotionModal").style.display = "none";
      if (pendingPremove && pendingPremove.promotion === undefined && game.get(pendingPremove.from)?.type === "p" && ["1", "8"].includes(pendingPremove.to[1])) pendingPremove = null;
      pendingPromotion = null;
      if (!persistentMarks) { marks.clear(); arrows = [] } selected = null; legalTargets = []; render();
    }
  });

  $("backBtn").onclick = () => goPly(curPly() - 1);
  $("forwardBtn").onclick = () => goPly(curPly() + 1);

  /* ---------- Exportar PGN ---------- */
  function downloadPGN() {
    const pgn = game.pgn({ max_width: 60, newline_char: "\n" });
    const blob = new Blob([pgn], { type: "application/x-chess-pgn" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "partida_ajedrez.pgn";
    a.click();
    URL.revokeObjectURL(url);
    showToast("PGN descargado para análisis");
  }
  $("downloadPgnBtn").onclick = downloadPGN;

  $("flipBtn").onclick = flip;
  /* ---------- Tablas y rendición ---------- */
  let forced = null, drawPending = false, resignArm = null;
  const online = () => peerJSConn && peerJSConn.open;
  function showDrawBar() { $("drawBar").hidden = false }
  function clearDraw() { drawPending = false; $("drawBar").hidden = true }
  function disarm() { clearTimeout(resignArm); resignArm = null; $("resignBtn").textContent = "⚑ Rendirse" }
  $("drawBtn").onclick = () => {
    if (myColor) {
      if (!online()) { showToast("No hay rival conectado"); return }
      drawPending = true; sendPayload({ type: "drawOffer" }); showToast("Tablas ofrecidas"); render();
    } else showDrawBar();
  };
  $("drawYes").onclick = () => { sendPayload({ type: "drawAccept" }); forced = { w: null, why: "por acuerdo" }; clearDraw(); render() };
  $("drawNo").onclick = () => { sendPayload({ type: "drawDecline" }); clearDraw() };
  $("resignBtn").onclick = () => {
    if (!resignArm) { $("resignBtn").textContent = "¿Seguro? Pulsa otra vez"; resignArm = setTimeout(disarm, 3000); return }
    disarm();
    const c = myColor || game.turn();
    forced = { w: c === "w" ? "b" : "w", why: "por abandono" };
    sendPayload({ type: "resign", color: c }); clearDraw(); render();
  };

  /* ---------- Modal de fin de partida ---------- */
  let endShown = false;
  function getResult() {
    if (forced) return forced;
    if (timedOut()) {
      if (game.isInsufficientMaterial()) return { w: null, why: "por insuficiencia de material" };
      return { w: whiteTime <= 0 ? "b" : "w", why: "por tiempo" };
    }
    if (game.isCheckmate()) return { w: game.turn() === "w" ? "b" : "w", why: "por jaque mate" };
    if (game.isStalemate()) return { w: null, why: "por ahogado" };
    if (game.isThreefoldRepetition()) return { w: null, why: "por repetición" };
    if (game.isInsufficientMaterial()) return { w: null, why: "por material insuficiente" };
    if (game.isDraw()) return { w: null, why: "por la regla de los 50 movimientos" };
    return null;
  }
  function checkEnd() {
    const r = getResult();
    if (!r) { endShown = false; $("endModal").style.display = "none"; return }
    if (endShown) return;
    endShown = true;
    setTimeout(() => { const r2 = getResult(); if (r2) showEnd(r2) }, 650);
  }
  function getMatchHistory() {
    try {
      const parsed = JSON.parse(store.get(MATCH_HISTORY_KEY) || "[]");
      if (Array.isArray(parsed)) return parsed.slice(0, 30);
    } catch (_) { }
    return [];
  }
  function saveMatchHistory(entries) {
    matchHistory = Array.isArray(entries) ? entries.slice(0, 30) : [];
    try { store.set(MATCH_HISTORY_KEY, JSON.stringify(matchHistory)); } catch (_) { }
  }
  let historyPreviewing = false;
  function suppressHistoryPersistForPreview() {
    historyPreviewing = true;
  }
  function loadSavedPgn(chess, pgn) {
    if (typeof chess.load_pgn === "function") return chess.load_pgn(pgn);
    if (typeof chess.loadPgn === "function") return chess.loadPgn(pgn);
    return false;
  }
  function renderHistoryMiniBoard(entry, mount) {
    const mini = new Chess();
    const fen = entry && (entry.fen || entry.finalFen || "");
    if (fen) {
      try { mini.load(fen) } catch (_) { }
    } else if (entry && entry.pgn) {
      try { loadSavedPgn(mini, entry.pgn) } catch (_) { }
    }
    const board = document.createElement("div");
    board.className = "history-mini-board";
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const file = x;
        const rank = 7 - y;
        const name = files[file] + (rank + 1);
        const square = document.createElement("div");
        square.className = "history-mini-square " + (((file + rank) % 2 === 0) ? "light" : "dark");
        const piece = mini.get(name);
        if (piece) {
          const img = document.createElement("img");
          img.src = PIECE(piece.color, piece.type);
          img.alt = "";
          square.appendChild(img);
        }
        board.appendChild(square);
      }
    }
    mount.innerHTML = "";
    mount.appendChild(board);
  }
  function openHistoryEntry(entry) {
    if (!entry || (!entry.pgn && !entry.fen && !entry.finalFen && !Array.isArray(entry.moves))) return;
    try {
      const pgnText = String(entry.pgn || "").trim();
      const targetFen = String(entry.fen || entry.finalFen || "").trim();
      const moveList = Array.isArray(entry.moves) ? entry.moves.filter(Boolean) : [];
      let replay = null;
      if (moveList.length) {
        const candidate = new Chess();
        let valid = true;
        for (const san of moveList) {
          try { if (!candidate.move(String(san))) { valid = false; break } } catch (_) { valid = false; break }
        }
        if (valid) replay = candidate;
      }
      if (!replay && pgnText) {
        const candidate = new Chess();
        try { if (loadSavedPgn(candidate, pgnText)) replay = candidate } catch (_) { }
      }
      if (replay) {
        game.reset();
        replay.history({ verbose: true }).forEach(move => game.move({ from: move.from, to: move.to, promotion: move.promotion || "q" }));
      } else if (targetFen) {
        try { if (game.load(targetFen)) replay = game } catch (_) { replay = null }
      }
      if (!replay) {
        historyPreviewing = false;
        showToast("No se pudo abrir la partida");
        return;
      }
      const resultSide = entry.resultSide;
      forced = resultSide === "draw" ? { w: null, why: entry.resultWhy || "por tablas" } : ["w", "b"].includes(resultSide) ? { w: resultSide, why: entry.resultWhy || "resultado guardado" } : null;
      endShown = false;
      historyPly = 0;
      reviewing = false;
      report = null;
      suppressHistoryPersistForPreview();
      closeHistory();
      showTab("moves");
      render();
      const finalResult = getResult();
      if (finalResult) {
        showEnd(finalResult);
      } else {
        historyPreviewing = false;
        showToast("Esta partida no tiene resultado final para mostrar");
      }
    } catch (_) {
      historyPreviewing = false;
      showToast("No se pudo abrir la partida");
    }
  }
  function removeHistoryEntry(index) {
    const entries = getMatchHistory();
    const next = entries.filter((_, i) => i !== index);
    saveMatchHistory(next);
    renderHistoryList();
    showToast("Partida eliminada del historial");
  }
  function showHistoryContextMenu(event, index) {
    event.preventDefault();
    const existing = document.getElementById("historyContextMenu");
    if (existing) existing.remove();
    const menu = document.createElement("div");
    menu.id = "historyContextMenu";
    menu.className = "history-context-menu";
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "Eliminar";
    removeBtn.onclick = () => {
      removeHistoryEntry(index);
      menu.remove();
    };
    menu.appendChild(removeBtn);
    menu.style.left = (event.clientX + 8) + "px";
    menu.style.top = (event.clientY + 8) + "px";
    document.body.appendChild(menu);
    const close = () => menu.remove();
    setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
    setTimeout(() => document.addEventListener("contextmenu", close, { once: true }), 0);
  }
  function renderHistoryList() {
    const list = $("historyList");
    const entries = getMatchHistory();
    if (!entries.length) {
      list.innerHTML = '<div class="empty">Aún no hay partidas guardadas. Cuando termine una partida aparecerá aquí con el rival y el resultado.</div>';
      return;
    }
    list.innerHTML = "";
    entries.forEach((entry, index) => {
      const card = document.createElement("div");
      card.className = "history-item";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.title = "Abrir partida";
      const badge = entry.result === "Victoria" ? "win" : entry.result === "Derrota" ? "loss" : "draw";
      const label = entry.opponent || "Rival";
      const short = entry.summary || entry.pgn || "Partida completada";
      const left = document.createElement("div");
      left.className = "history-left";
      left.innerHTML = '<div class="history-head"><div class="history-vs"><strong>' + label + '</strong><span>' + (entry.when || "") + '</span></div><span class="history-result ' + badge + '">' + entry.result + '</span></div>' +
        '<div class="history-pgn">' + short.slice(0, 120) + (short.length > 120 ? "…" : "") + '</div>';
      const miniWrap = document.createElement("div");
      miniWrap.className = "history-mini-wrap";
      renderHistoryMiniBoard(entry, miniWrap);
      card.append(left, miniWrap);
      const open = (event) => {
        if (event) event.preventDefault();
        openHistoryEntry(entry);
      };
      card.addEventListener("click", open);
      card.addEventListener("contextmenu", e => showHistoryContextMenu(e, index));
      card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e) } });
      list.appendChild(card);
    });
  }
  function persistFinalMatch(r) {
    if (!r) return;
    const opponentName = botEnabled ? botProfileByElo(botElo).name : normalizeName(activeOpponentName || "Rival");
    const myRole = botEnabled ? (botColor === "w" ? "b" : "w") : (myColor || "w");
    const resultText = !r.w ? "Empate" : (r.w === myRole ? "Victoria" : "Derrota");
    const pgn = game.pgn({ max_width: 60, newline_char: "\n" }).trim();
    const fen = game.fen();
    const moves = game.history({ verbose: true }).map(m => m.san || "").filter(Boolean);
    const summary = pgn.replace(/\s+/g, " ").trim();
    const entry = {
      opponent: opponentName,
      result: resultText,
      resultSide: r.w === null ? "draw" : r.w,
      resultWhy: r.why || "",
      when: new Date().toLocaleString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }),
      pgn: pgn || "",
      fen: fen || "",
      moves: moves.length ? moves : [],
      summary: summary ? summary.slice(0, 120) + (summary.length > 120 ? "…" : "") : "Partida completada"
    };
    const items = getMatchHistory();
    const duplicate = items.some(item => {
      const samePGN = item && item.pgn && entry.pgn && item.pgn === entry.pgn;
      const sameFEN = item && item.fen && entry.fen && item.fen === entry.fen;
      return samePGN || sameFEN;
    });
    if (duplicate) return;
    items.unshift(entry);
    saveMatchHistory(items);
    renderHistoryList();
  }
  function reportMatchResult(r) {
    if (!myColor || (!online() && !botEnabled)) return;
    const outcome = !r.w ? 0.5 : (r.w === myColor ? 1 : 0);
    const opponent = botEnabled ? botProfileByElo(botElo).name : normalizeName(activeOpponentName || "Rival");
    applyEloResult(myName, opponent, outcome);
    if (online()) sendPayload({ type: "matchResult", name: myName, opponentName: opponent, outcome });
  }
  function showEnd(r) {
    const h = game.history({ verbose: true }), win = r.w && myColor ? r.w === myColor : null;
    setEndIcon(endIconKey(r));
    $("endTitle").textContent = !r.w ? "Tablas" : myColor ? (win ? "¡Has ganado!" : "Has perdido") : "Ganan las " + (r.w === "w" ? "blancas" : "negras");
    $("endSub").textContent = r.why;
    const endAvatarColor = r.w || myColor || "w";
    const endAvatarName = playerDisplayName(endAvatarColor);
    const endIsBot = botEnabled && endAvatarColor === botColor;
    setPlayerAvatar($("endAvatar"), endAvatarName, endAvatarColor, endIsBot, endIsBot ? botAvatarSeed(botElo) : endAvatarName, !botEnabled && !myColor);
    $("endMsg").textContent = !r.w ? "Tablas, ¡buen duelo!" : win === false ? "¡Ánimo, la próxima es tuya!" : "¡Buena partida!";
    $("endMoves").textContent = Math.ceil(h.length / 2);
    $("endCaps").textContent = h.filter(m => /[ce]/.test(m.flags)).length;
    $("endChecks").textContent = h.filter(m => /[+#]/.test(m.san)).length;
    $("endAnalysis").hidden = true; $("endAnalysis").classList.remove("done"); $("endBox").classList.remove("analyzed"); $("endReview").hidden = true; $("endProg").style.width = "0"; $("endPgn").hidden = false; $("endAnalysisResults").innerHTML = ""; $("endAnalysisStatus").textContent = "El análisis se ejecuta en tu navegador y puede tardar unos segundos.";
    const isHistoryPreview = historyPreviewing;
    if (!isHistoryPreview) { persistFinalMatch(r); reportMatchResult(r) }
    historyPreviewing = false;
    if (!isHistoryPreview && friendPeer && friendPeer.open) {
      setTimeout(() => broadcastLiveMatch(), 60);
    }
    $("endModal").style.display = "flex";
  }
  const closeEnd = () => { $("endModal").style.display = "none" };
  $("endClose").onclick = closeEnd;
  $("endModal").onclick = e => { if (e.target === $("endModal")) closeEnd() };
  $("endPgn").onclick = () => {
    $("endAnalysis").hidden = false;
    $("endPgn").hidden = true;
    analyzeGame();
  };
  $("endNew").onclick = () => { closeEnd(); reset() };
  $("endRematch").onclick = () => { closeEnd(); if (online()) requestRematch(); else { reset(); if (!myColor) { flipped = !flipped; render() } } };

  $("newGameBtn").onclick = reset;
  $("firstBtn").onclick = () => goPly(0);
  $("lastBtn").onclick = () => goPly(game.history().length);
  function showTab(t) {
    document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === t));
    document.querySelectorAll("#pane-moves, #pane-analysis").forEach(p => p.hidden = p.id !== "pane-" + t);
  }
  function showGameSubtab(t) {
    document.querySelectorAll(".game-subtab").forEach(b => {
      const active = b.dataset.gameSubtab === t;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll("#move-subpane-list, #move-subpane-chat").forEach(p => {
      p.hidden = p.id !== "move-subpane-" + (t === "chat" ? "chat" : "list");
    });
  }
  function syncGameSubtabs() {
    const connected = !!online();
    const gs = document.querySelector(".game-subtabs");
    if (gs) gs.hidden = !connected;
    if (!connected) showGameSubtab("moves");
  }
  document.querySelectorAll(".game-subtab").forEach(b => b.onclick = () => showGameSubtab(b.dataset.gameSubtab));
  document.querySelectorAll(".tab").forEach(b => b.onclick = () => showTab(b.dataset.tab));
  syncGameSubtabs();

  /* ---------- Entrada a la partida desde las otras páginas ---------- */
  function startLocalGame(tc) {
    if (peerJSConn) { try { peerJSConn.close() } catch (_) { } peerJSConn = null; }
    if (peerJSInstance) { try { peerJSInstance.destroy() } catch (_) { } peerJSInstance = null; }
    botEnabled = false; botThinking = false; role = null; myColor = null;
    parseTC(TC_RE.test(String(tc)) ? String(tc) : "600+0");
    resetLocal(); showTab("moves");
  }

  /* ---------- Control de Tiempo & Red ---------- */
  /* ---------- Selector de ritmo personalizado ---------- */
  const TC_CATS = [
    { id: "bullet", name: "Bala", icon: "rocket_launch", main: ["60+0", "60+1", "120+1"], more: ["30+0", "30+1", "60+2"] },
    { id: "blitz", name: "Blitz", icon: "bolt", main: ["180+0", "180+2", "300+0"], more: ["180+1", "240+0", "300+3", "300+5"] },
    { id: "rapid", name: "Rápida", icon: "timer", main: ["600+0", "600+5", "900+10"], more: ["900+0", "1200+0", "1800+0", "1800+20"] },
    { id: "classic", name: "Clásica", icon: "hourglass_top", main: [], more: ["3600+0", "5400+30", "7200+30"] }
  ];
  const TC_RE = /^\d{1,5}\+\d{1,3}$/;
  const HANDICAP_PIECES = {
    none: { label: "Ninguno", icon: "✦", piece: null },
    pawn: { label: "Peón", icon: "♟", piece: "p" },
    knight: { label: "Caballo", icon: "♞", piece: "n" },
    bishop: { label: "Alfil", icon: "♝", piece: "b" },
    rook: { label: "Torre", icon: "♜", piece: "r" },
    queen: { label: "Dama", icon: "♛", piece: "q" },
    king: { label: "Rey", icon: "♚", piece: "k" }
  };
  const HANDICAP_TARGETS = { me: "Yo", rival: "Rival" };
  const HANDICAP_CUSTOM_PIECES = [
    { key: "p", label: "Peón", glyph: "♟" },
    { key: "n", label: "Caballo", glyph: "♞" },
    { key: "b", label: "Alfil", glyph: "♝" },
    { key: "r", label: "Torre", glyph: "♜" },
    { key: "q", label: "Dama", glyph: "♛" },
    { key: "k", label: "Rey", glyph: "♚" }
  ];

  function getDefaultCustomPiecesForColor(color) {
    const isWhite = color === "w";
    const base = isWhite ? {
      a1: "r", b1: "n", c1: "b", d1: "q", e1: "k", f1: "b", g1: "n", h1: "r",
      a2: "p", b2: "p", c2: "p", d2: "p", e2: "p", f2: "p", g2: "p", h2: "p"
    } : {
      a8: "r", b8: "n", c8: "b", d8: "q", e8: "k", f8: "b", g8: "n", h8: "r",
      a7: "p", b7: "p", c7: "p", d7: "p", e7: "p", f7: "p", g7: "p", h7: "p"
    };
    return new Map(Object.entries(base));
  }

  function normalizeHandicapValue(value) {
    const v = String(value || "none").trim().toLowerCase();
    if (!v || v === "none") return "none";
    if (v.startsWith("custom:")) return v;
    return "none";
  }

  function encodeCustomHandicap(target, piecesMap) {
    const entries = [...piecesMap.entries()].filter(([, type]) => type).map(([square, type]) => `${square}:${type}`);
    return `custom:${target}|${entries.join(",")}`;
  }

  function decodeCustomHandicap(value) {
    const normalized = normalizeHandicapValue(value);
    if (normalized === "none") return { target: "me", pieces: new Map() };
    const rest = normalized.slice("custom:".length);
    const [targetPart, dataPart = ""] = rest.split("|");
    const target = targetPart === "rival" ? "rival" : "me";
    const pieces = new Map();
    if (dataPart) {
      dataPart.split(",").filter(Boolean).forEach(part => {
        const [square, type] = part.split(":");
        if (square && type && /^[a-h][1-8]$/.test(square) && /^[prnbqk]$/.test(type)) pieces.set(square, type);
      });
    }
    return { target, pieces };
  }

  function getHandicapPreset(value) {
    const normalized = normalizeHandicapValue(value);
    if (normalized === "none") return { value: "none", piece: "none", mode: "advantage", target: "me", label: "Ninguno" };
    if (normalized.startsWith("custom:")) {
      const parsed = decodeCustomHandicap(normalized);
      return { value: normalized, piece: "custom", mode: "custom", target: parsed.target, label: `Personalizado · ${HANDICAP_TARGETS[parsed.target] || "Yo"}`, customPieces: parsed.pieces };
    }
    return { value: "none", piece: "none", mode: "advantage", target: "me", label: "Ninguno" };
  }

  function oppositeColor(color) { return color === "w" ? "b" : "w"; }
  // Construye el FEN de la posición con handicap sin depender de put()/remove() de chess.js
  function buildHandicapFen(inviterColor, value) {
    const preset = getHandicapPreset(value);
    const grid = {};
    ["w", "b"].forEach(c => getDefaultCustomPiecesForColor(c).forEach((type, sq) => { grid[sq] = { type, color: c }; }));
    if (preset.piece === "custom") {
      const targetColor = preset.target === "me" ? inviterColor : oppositeColor(inviterColor);
      const defaults = getDefaultCustomPiecesForColor(targetColor);
      // Las casillas se guardan con quien reta abajo; si reta con negras se espeja la fila
      const real = sq => inviterColor === "b" ? sq[0] + (9 - Number(sq[1])) : sq;
      preset.customPieces.forEach((type, sq0) => {
        const sq = real(sq0);
        if (defaults.has(sq)) delete grid[sq];
        else grid[sq] = { type, color: targetColor };
      });
    }
    const rows = [];
    for (let rank = 8; rank >= 1; rank--) {
      let row = "", empty = 0;
      for (const file of "abcdefgh") {
        const pc = grid[file + rank];
        if (!pc) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += pc.color === "w" ? pc.type.toUpperCase() : pc.type;
      }
      if (empty) row += empty;
      rows.push(row);
    }
    const has = (sq, type, color) => grid[sq] && grid[sq].type === type && grid[sq].color === color;
    let castling = "";
    if (has("e1", "k", "w") && has("h1", "r", "w")) castling += "K";
    if (has("e1", "k", "w") && has("a1", "r", "w")) castling += "Q";
    if (has("e8", "k", "b") && has("h8", "r", "b")) castling += "k";
    if (has("e8", "k", "b") && has("a8", "r", "b")) castling += "q";
    return { fen: rows.join("/") + " w " + (castling || "-") + " - 0 1", grid };
  }

  // Comprueba que la posición personalizada sea válida antes de enviar el reto (devuelve el motivo si no lo es)
  function validateHandicapPosition(inviterColor, value) {
    const colors = inviterColor === "w" || inviterColor === "b" ? [inviterColor] : ["w", "b"];
    for (const c of colors) {
      try {
        const { fen, grid } = buildHandicapFen(c, value);
        const all = Object.entries(grid);
        const kingsW = all.filter(([, p]) => p.type === "k" && p.color === "w").length;
        const kingsB = all.filter(([, p]) => p.type === "k" && p.color === "b").length;
        if (kingsW !== 1 || kingsB !== 1) return { ok: false, error: "Cada bando debe tener exactamente un rey" };
        if (all.some(([sq, p]) => p.type === "p" && (sq[1] === "1" || sq[1] === "8"))) return { ok: false, error: "No puede haber peones en la primera ni en la última fila" };
        const test = new Chess();
        let loaded;
        try { loaded = test.load(fen); } catch (e) { return { ok: false, error: "Posición no válida: " + (e && e.message || e) }; }
        if (loaded === false) return { ok: false, error: "Posición no válida (FEN rechazado)" };
      } catch (err) {
        console.error(err);
        return { ok: false, error: "Error al comprobar la posición: " + (err && err.message || err) };
      }
    }
    return { ok: true };
  }
  function getHandicapLabel(value) {
    const preset = getHandicapPreset(value);
    if (preset.value === "none") return "Ninguno";
    if (preset.piece === "custom") return `Personalizado · ${HANDICAP_TARGETS[preset.target]}`;
    return "Ninguno";
  }

  function applyHandicapBuilder(inviterColor, value) {
    const preset = getHandicapPreset(value);
    if (!inviterColor || preset.value === "none") return new Chess();
    const board = new Chess();
    if (preset.piece === "custom") {
      const targetColor = preset.target === "me" ? inviterColor : oppositeColor(inviterColor);
      const defaultPieces = getDefaultCustomPiecesForColor(targetColor);
      defaultPieces.forEach((type, square) => {
        board.put({ type, color: targetColor }, square);
      });
      preset.customPieces.forEach((type, square) => {
        if (defaultPieces.has(square)) board.remove(square);
        else board.put({ type, color: targetColor }, square);
      });
      return board;
    }
    return board;
  }

  const tcParse = v => { const p = String(v).split("+"); return { b: parseInt(p[0], 10) || 0, i: parseInt(p[1], 10) || 0 } };
  function tcCat(v) {
    const { b, i } = tcParse(v); if (b <= 0) return null;
    const e = b + 40 * i;
    return TC_CATS[e < 180 ? 0 : e < 600 ? 1 : e < 3600 ? 2 : 3];
  }
  function tcBase(b) { if (b < 60) return b + " s"; const m = Math.floor(b / 60), sc = b % 60; return sc ? m + ":" + String(sc).padStart(2, "0") : String(m) }
  function tcShort(v) {
    const { b, i } = tcParse(v); if (b <= 0) return "Sin límite";
    if (!i) return b < 60 ? b + " s" : tcBase(b) + " min";
    return tcBase(b) + " + " + i;
  }
  function tcName(v) { const c = tcCat(v); return tcShort(v) + (c ? " (" + c.name + ")" : "") }
  function tcIcon(v) { const c = tcCat(v); return c ? c.icon : "all_inclusive" }

  const TC_SELECTS = ["localTcSelect", "tcSelect", "inviteTcSelect"];
  const SEL_VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  const tcPickers = [];
  function makeHandicapPicker(select) {
    if (!select) return null;
    const root = document.createElement("div");
    root.className = "hcp";
    root.innerHTML = '<button type="button" class="hcp-trigger" aria-expanded="false"><span class="hcp-summary">Ninguno</span><span class="material-symbols-rounded hcp-chev">expand_more</span></button><div class="hcp-panel" hidden></div>';
    select.style.display = "none";
    select.after(root);
    const trigger = root.querySelector(".hcp-trigger");
    const panel = root.querySelector(".hcp-panel");
    let isOpen = false;
    let customTarget = "me";
    let customPieces = new Map();
    let selectedPiece = "p";

    function ensureCustomOption() {
      let option = [...select.options].find(o => o.dataset.hcpCustom === "1");
      if (!option) {
        option = document.createElement("option");
        option.dataset.hcpCustom = "1";
        select.appendChild(option);
      }
      option.value = encodeCustomHandicap(customTarget, customPieces);
      option.textContent = "Personalizado";
      return option;
    }

    function getChallengeOwnerColor() {
      const val = $("inviteColorSelect") ? $("inviteColorSelect").value : (myColor || "w");
      return val === "r" ? (myColor || "w") : val;
    }

    function resetCustomBoardForTarget(target) {
      customTarget = target;
      customPieces = new Map();
      persistState();
      renderBoard();
    }

    function syncFromSelect() {
      const parsed = decodeCustomHandicap(select.value || "none");
      customTarget = parsed.target || "me";
      customPieces = parsed.pieces ? new Map(parsed.pieces) : new Map();
      return parsed;
    }

    function persistState() {
      if (!customPieces.size) {
        select.value = "none";
        trigger.querySelector(".hcp-summary").textContent = "Ninguno";
        return;
      }
      ensureCustomOption();
      select.value = encodeCustomHandicap(customTarget, customPieces);
      const preset = getHandicapPreset(select.value);
      trigger.querySelector(".hcp-summary").textContent = preset.label || "Ninguno";
    }

    function renderBoard() {
      const boardEl = panel.querySelector(".hcp-board");
      if (!boardEl) return;
      const fileLabels = ["a", "b", "c", "d", "e", "f", "g", "h"];
      // Perspectiva fija: mi mitad abajo (filas 1-4) y la del rival arriba (filas 8-5), sea cual sea el color real
      const defaultPieces = getDefaultCustomPiecesForColor(customTarget === "me" ? "w" : "b");
      const ranks = customTarget === "me" ? [1, 2, 3, 4] : [8, 7, 6, 5];
      boardEl.innerHTML = "";
      for (const rank of ranks) {
        for (let fileIndex = 0; fileIndex < 8; fileIndex++) {
          const square = fileLabels[fileIndex] + rank;
          const isLight = (fileIndex + rank) % 2 === 1;
          const btn = document.createElement("button");
          btn.type = "button";
          const hasDefaultPiece = defaultPieces.has(square);
          const customType = customPieces.get(square);
          const isInactive = hasDefaultPiece && customType === defaultPieces.get(square);
          const isAdded = !hasDefaultPiece && customType;
          const pieceType = customType || (hasDefaultPiece ? defaultPieces.get(square) : null);
          const piece = pieceType ? HANDICAP_CUSTOM_PIECES.find(p => p.key === pieceType) : null;
          btn.className = "hcp-square" + (isLight ? " light" : " dark") + (isInactive ? " inactive" : "") + (isAdded ? " custom" : "");
          btn.textContent = piece ? piece.glyph : "";
          btn.title = square;
          btn.setAttribute("aria-label", "Cuadrado " + square);
          btn.onclick = () => {
            if (selectedPiece && !hasDefaultPiece) {
              customPieces.set(square, selectedPiece);
              persistState();
              renderBoard();
              return;
            }
            if (customType) {
              customPieces.delete(square);
              persistState();
              renderBoard();
              return;
            }
            if (hasDefaultPiece) {
              customPieces.set(square, defaultPieces.get(square));
              persistState();
              renderBoard();
            }
          };
          boardEl.appendChild(btn);
        }
      }
    }

    function close() {
      isOpen = false;
      panel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      root.classList.remove("open");
    }

    function open() {
      isOpen = true;
      panel.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      root.classList.add("open");
    }

    trigger.onclick = () => isOpen ? close() : open();
    panel.innerHTML = '<div class="hcp-target-row"><button type="button" class="hcp-target-btn active" data-target="me">Yo</button><button type="button" class="hcp-target-btn" data-target="rival">Rival</button></div><div class="hcp-piece-row">' + HANDICAP_CUSTOM_PIECES.map(p => '<button type="button" class="hcp-piece-btn' + (p.key === selectedPiece ? ' active' : '') + '" data-piece="' + p.key + '">' + p.glyph + '</button>').join("") + '</div><div class="hcp-board" aria-label="Tablero del handicap"></div><button type="button" class="hcp-clear">Vaciar</button>';

    const targetButtons = panel.querySelectorAll(".hcp-target-btn");
    targetButtons.forEach(btn => {
      btn.onclick = () => {
        const nextTarget = btn.dataset.target || "me";
        targetButtons.forEach(b => b.classList.toggle("active", b === btn));
        resetCustomBoardForTarget(nextTarget);
      };
    });

    const pieceButtons = panel.querySelectorAll(".hcp-piece-btn");
    pieceButtons.forEach(btn => {
      btn.onclick = () => {
        selectedPiece = btn.dataset.piece || "p";
        pieceButtons.forEach(b => b.classList.toggle("active", b === btn));
      };
    });

    panel.querySelector(".hcp-clear").onclick = () => {
      customPieces = new Map();
      select.value = "none";
      trigger.querySelector(".hcp-summary").textContent = "Ninguno";
      renderBoard();
    };

    select.addEventListener("change", () => {
      syncFromSelect();
      const preset = getHandicapPreset(select.value);
      trigger.querySelector(".hcp-summary").textContent = preset.label || "Ninguno";
      const activeTarget = panel.querySelector('[data-target="' + customTarget + '"]');
      if (activeTarget) targetButtons.forEach(b => b.classList.toggle("active", b === activeTarget));
      renderBoard();
    });

    syncFromSelect();
    ensureCustomOption();
    renderBoard();
    trigger.querySelector(".hcp-summary").textContent = getHandicapPreset(select.value).label || "Ninguno";
    if (customPieces.size === 0) resetCustomBoardForTarget(customTarget);
    document.addEventListener("mousedown", e => {
      if (root.contains(e.target)) return;
      // Si se pulsa Enviar/Cancelar no se cierra aún: al colapsar el panel el botón se movería y el click se perdería
      if (e.target.closest && e.target.closest("#sendChallengeBtn, #cancelChallengeBtn")) return;
      close();
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
    return { root, close };
  }

  function ensureTcOption(v) {
    TC_SELECTS.forEach(id => {
      const sel = $(id);
      if (![...sel.options].some(o => o.value === v)) { const o = document.createElement("option"); o.value = v; o.textContent = tcName(v); sel.appendChild(o) }
    });
  }
  function closeTcPickers(except) { tcPickers.forEach(p => { if (p !== except) p.close() }) }

  function makeTcPicker(sel) {
    const root = document.createElement("div"); root.className = "tcp";
    root.innerHTML = '<button type="button" class="tcp-trigger" aria-haspopup="true" aria-expanded="false"><span class="material-symbols-rounded tcp-ico"></span><span class="tcp-label"></span><span class="material-symbols-rounded tcp-chev">expand_more</span></button><div class="tcp-panel" hidden></div>';
    sel.style.display = "none"; sel.after(root);
    const trigger = root.querySelector(".tcp-trigger"), panel = root.querySelector(".tcp-panel");
    let expanded = false, isOpen = false;

    const recents = () => {
      let list = []; try { list = JSON.parse(store.get("ajedrez.tcRecent") || "[]") } catch (_) { }
      list = list.filter(v => TC_RE.test(String(v)));
      ["180+0", "300+0", "60+0"].forEach(v => { if (list.length < 3 && !list.includes(v)) list.push(v) });
      return list.slice(0, 3);
    };
    const pushRecent = v => { const l = [v].concat(recents().filter(x => x !== v)).slice(0, 3); store.set("ajedrez.tcRecent", JSON.stringify(l)) };

    function pick(v) {
      ensureTcOption(v); sel.value = v; pushRecent(v); close();
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    function section(icon, title, vals) {
      if (!vals.length) return;
      const w = document.createElement("div");
      const h = document.createElement("div"); h.className = "tcp-sec-h";
      const ic = document.createElement("span"); ic.className = "material-symbols-rounded"; ic.textContent = icon;
      const tt = document.createElement("span"); tt.textContent = title; h.append(ic, tt);
      const g = document.createElement("div"); g.className = "tcp-grid";
      vals.forEach(v => {
        const b = document.createElement("button"); b.type = "button";
        b.className = "tcp-opt" + (v === sel.value ? " sel" : ""); b.textContent = tcShort(v);
        b.onclick = () => pick(v); g.appendChild(b);
      });
      w.append(h, g); panel.appendChild(w);
    }
    function buildPanel() {
      panel.innerHTML = "";
      section("history", "Recientes", recents());
      TC_CATS.forEach(c => section(c.icon, c.name, expanded ? c.main.concat(c.more) : c.main));
      if (expanded) {
        section("all_inclusive", "Sin límite", ["0+0"]);
        const w = document.createElement("div");
        w.innerHTML = '<div class="tcp-sec-h"><span class="material-symbols-rounded">tune</span><span>Personalizado</span></div><div class="tcp-custom"><input type="number" class="tcp-min" min="1" max="180" placeholder="Minutos" aria-label="Minutos"><span class="tcp-plus">+</span><input type="number" class="tcp-inc" min="0" max="60" placeholder="Inc. (s)" aria-label="Incremento en segundos"><button type="button" class="primary tcp-apply">Usar</button></div>';
        const mi = w.querySelector(".tcp-min"), inc = w.querySelector(".tcp-inc");
        const apply = () => {
          const m = Math.round(Number(mi.value)), i = Math.round(Number(inc.value || 0));
          if (!(m >= 1 && m <= 180) || !(i >= 0 && i <= 60)) { showToast("Usa de 1 a 180 min y de 0 a 60 s de incremento"); return }
          pick(m * 60 + "+" + i);
        };
        w.querySelector(".tcp-apply").onclick = apply;
        [mi, inc].forEach(x => x.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); apply() } });
        panel.appendChild(w);
      }
      const more = document.createElement("button"); more.type = "button"; more.className = "tcp-more";
      more.innerHTML = '<span></span><span class="material-symbols-rounded"></span>';
      more.children[0].textContent = expanded ? "Menos controles de tiempo" : "Más controles de tiempo";
      more.children[1].textContent = expanded ? "expand_less" : "expand_more";
      more.onclick = () => { expanded = !expanded; buildPanel() };
      panel.appendChild(more);
    }
    function refresh() {
      const v = sel.value;
      root.querySelector(".tcp-ico").textContent = tcIcon(v);
      root.querySelector(".tcp-label").textContent = tcName(v);
      if (isOpen) buildPanel();
    }
    function open() { closeTcPickers(api); isOpen = true; root.classList.add("open"); trigger.setAttribute("aria-expanded", "true"); panel.hidden = false; buildPanel() }
    function close() { if (!isOpen) return; isOpen = false; expanded = false; root.classList.remove("open"); trigger.setAttribute("aria-expanded", "false"); panel.hidden = true }
    trigger.onclick = () => isOpen ? close() : open();
    const api = { root, refresh, close };
    tcPickers.push(api);

    Object.defineProperty(sel, "value", {
      configurable: true,
      get() { return SEL_VALUE.get.call(sel) },
      set(v) { v = String(v); if (TC_RE.test(v)) ensureTcOption(v); SEL_VALUE.set.call(sel, v); tcPickers.forEach(p => p.refresh()) }
    });
    refresh();
  }
  (function initTcPickers() {
    const all = [...new Set(TC_CATS.flatMap(c => c.main.concat(c.more)).concat(["0+0"]))];
    TC_SELECTS.forEach(id => {
      const sel = $(id); sel.innerHTML = "";
      all.forEach(v => { const o = document.createElement("option"); o.value = v; o.textContent = tcName(v); sel.appendChild(o) });
      SEL_VALUE.set.call(sel, "600+0");
    });
    TC_SELECTS.forEach(id => makeTcPicker($(id)));
    document.addEventListener("mousedown", e => { tcPickers.forEach(p => { if (!p.root.contains(e.target)) p.close() }) });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeTcPickers() });
  })();
  (function initHandicapPicker() {
    const select = $("inviteHandicapSelect");
    if (!select) return;
    select.innerHTML = "";
    const optionNone = document.createElement("option");
    optionNone.value = "none";
    optionNone.textContent = "Ninguno";
    select.appendChild(optionNone);
    select.value = "none";
    makeHandicapPicker(select);
  })();

  function parseTC(value) {
    const current = typeof value === "string" && TC_RE.test(value)
      ? value
      : ($("localTcSelect") && $("localTcSelect").value) || ($("tcSelect") && $("tcSelect").value) || "600+0";
    const val = current.split("+");
    const base = parseInt(val[0], 10);
    increment = parseInt(val[1], 10);
    timed = base > 0;
    whiteTime = base;
    blackTime = base;
    clockLastUpdate = performance.now();
    if ($("localTcSelect")) $("localTcSelect").value = current;
    if ($("tcSelect")) $("tcSelect").value = current;
    updateClockUI();
  }
  $("localTcSelect").onchange = parseTC;
  $("tcSelect").onchange = () => {
    if ($("localTcSelect")) $("localTcSelect").value = $("tcSelect").value;
    parseTC();
  };
  parseTC();
  startClocks();

  const RTC_CONFIG = {
    iceCandidatePoolSize: 4,   // pre-reúne candidatos ICE: el handshake WebRTC arranca con ventaja
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "turn:openrelay.metered.ca:80", username: "openrelay", credential: "openrelay" },
      { urls: "turn:openrelay.metered.ca:443", username: "openrelay", credential: "openrelay" }
    ]
  };

  /* ---------- Peer precalentado ----------
     Se deja abierta de antemano una conexión con el servidor de señalización (con el código de sala ya
     reservado). Al crear una sala o unirse a una, se usa al instante, sin esperar al servidor. */
  let warmPeer = null, warmRetries = 0;
  const genRoomCode = () => { let c = ""; while (c.length < 6) c += Math.random().toString(36).substring(2); return c.slice(0, 6).toUpperCase() };
  function discardWarm(w, retry) {
    if (w.claimed) return;
    if (warmPeer === w) warmPeer = null;
    try { w.peer.destroy() } catch (_) { }
    if (retry && warmRetries++ < 5) setTimeout(prepareWarmPeer, 1500);
  }
  function prepareWarmPeer() {
    if (warmPeer || typeof Peer === "undefined" || PAGE !== "online") return;
    const code = genRoomCode();
    let peer;
    try { peer = new Peer("AJEDREZ-" + code, { config: RTC_CONFIG }) } catch (_) { return }
    const w = warmPeer = { code, peer, claimed: false };
    peer.on("open", () => { warmRetries = 0 });
    peer.on("disconnected", () => { if (!w.claimed) { try { peer.reconnect() } catch (_) { discardWarm(w, true) } } });
    peer.on("error", () => discardWarm(w, true));
    peer.on("close", () => discardWarm(w, true));
  }
  function takeWarmPeer() {
    const w = warmPeer;
    if (!w) { setTimeout(prepareWarmPeer, 800); return null }
    if (w.peer.destroyed || w.peer.disconnected) { discardWarm(w, false); setTimeout(prepareWarmPeer, 800); return null }
    w.claimed = true; warmPeer = null;
    setTimeout(prepareWarmPeer, 800);
    return w;
  }

  function sendPayload(data) {
    if (peerJSConn && peerJSConn.open) {
      try { peerJSConn.send(data); return true }
      catch (err) {
        console.warn("No se pudo enviar el mensaje al rival:", err);
        $("connText").textContent = "Conexión inestable";
        $("connDot").className = "status-dot warn";
      }
    }
    return false;
  }

  function handleNetworkData(d) {
    if (d.type === "move") {
      advanceClock();
      const m = game.move(d.move);
      if (m) {
        if (d.whiteTime !== undefined) whiteTime = d.whiteTime;
        if (d.blackTime !== undefined) blackTime = d.blackTime;
        clockLastUpdate = performance.now();
        cancelDrag(); selected = null; legalTargets = []; redoStack = []; historyPly = null; marks.clear(); arrows = []; clearDraw();
        render(); animateMove(m, false);
        broadcastLiveMatch();
        if (pendingPremove && !game.game_over()) window.setTimeout(executePremove, 0);
      }
    } else if (d.type === "resetRequest") {
      if (!online() || !game.history().length) return;
      pendingResetRequest = String(d.token || "");
      if (!pendingResetRequest) return;
      $("resetRequestText").textContent = normalizeName(d.name || "Tu rival") + " solicita reiniciar la partida. ¿Aceptas?";
      $("resetRequestModal").style.display = "flex";
    } else if (d.type === "resetConsent") {
      if (d.token !== activeResetToken) return;
      sendPayload({ type: "resetCommit", token: activeResetToken });
      activeResetToken = null;
      resetLocal(); showToast("Reinicio aceptado por ambos jugadores");
    } else if (d.type === "resetCommit") {
      if (!d.token || d.token !== pendingResetRequest) return;
      pendingResetRequest = null;
      $("resetRequestModal").style.display = "none";
      resetLocal(); showToast("Partida reiniciada por acuerdo");
    } else if (d.type === "resetDecline") {
      if (d.token !== activeResetToken) return;
      activeResetToken = null; showToast("El rival rechazó reiniciar la partida");
    } else if (d.type === "reset") {
      return;
    } else if (d.type === "resetLegacy") {
      game.reset(); marks.clear(); arrows = []; pendingPremove = null; premoveMode = false; selected = null; legalTargets = []; forced = null; clearDraw();
      if (d.whiteTime) whiteTime = d.whiteTime;
      if (d.blackTime) blackTime = d.blackTime;
      render();
      broadcastLiveMatch();
    } else if (d.type === "sync") {
      if (d.name) activeOpponentName = normalizeName(d.name, "Rival");
      if (d.host) {
        myColor = d.host === "w" ? "b" : "w";
        flipped = myColor === "b";
        if (TC_RE.test(String(d.tc))) parseTC(String(d.tc));
        if (d.handicap !== undefined) {
          activeHandicap = String(d.handicap);
          applyHandicapBoard(d.host, activeHandicap);
        }
      }
      render();
    } else if (d.type === "resign") {
      forced = { w: d.color === "w" ? "b" : "w", why: "por abandono" }; clearDraw(); render();
    } else if (d.type === "drawOffer") {
      showDrawBar();
    } else if (d.type === "drawAccept") {
      forced = { w: null, why: "por acuerdo" }; clearDraw(); render();
    } else if (d.type === "drawDecline") {
      drawPending = false; showToast("El rival rechazó las tablas"); render();
    } else if (d.type === "rematchRequest") {
      activeOpponentName = normalizeName(d.name || "Rival");
      showRematchOffer(d, peerJSConn);
    } else if (d.type === "rematchAccept") {
      if (confirmLeave()) {
        resetLocal();
        showToast("Revancha aceptada");
        render();
      }
    } else if (d.type === "rematchDecline") {
      $("inviteBar").hidden = true; pendingInvite = null; pendingRematch = null; showToast((d.name || "Rival") + " rechazó la revancha");
    } else if (d.type === "matchResult") {
      const senderName = normalizeName(d.name || activeOpponentName || "Rival");
      const outcome = Number(d.outcome);
      if (Number.isFinite(outcome)) {
        applyEloResult(senderName, myName, outcome);
        applyEloResult(myName, senderName, 1 - outcome);
      }
    } else if (d.type === "full") {
      showToast("La sala ya está completa");
    } else if (d.type === "chat") {
      const text = String(d.text || "").slice(0, 300);
      addMsg("them", text);
      showOpponentChatBubble(text);
    }
  }

  let activeResetToken = null, pendingResetRequest = null;
  function requestGameReset() {
    if (!online()) { resetLocal(); return; }
    if (activeResetToken) { showToast("Ya has solicitado reiniciar; espera la respuesta"); return; }
    activeResetToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sendPayload({ type: "resetRequest", token: activeResetToken, name: myName });
    showToast("Solicitud de reinicio enviada; espera a que el rival acepte");
  }
  $("resetRequestYes").onclick = () => {
    const token = pendingResetRequest;
    if (!token) return;
    pendingResetRequest = null; $("resetRequestModal").style.display = "none";
    sendPayload({ type: "resetConsent", token });
    showToast("Has aceptado; reiniciando la partida");
  };
  $("resetRequestNo").onclick = () => {
    const token = pendingResetRequest;
    pendingResetRequest = null; $("resetRequestModal").style.display = "none";
    if (token) sendPayload({ type: "resetDecline", token });
  };
  $("resetRequestModal").addEventListener("click", e => { if (e.target === $("resetRequestModal")) $("resetRequestNo").click(); });

  let bootJoining = false;
  function initPeerJS(targetCode = null, onReady = null) {
    clearTimeout(peerConnectionTimer); peerConnectionTimer = null;
    botEnabled = false; botThinking = false;
    if (peerJSConn) { const o = peerJSConn; peerJSConn = null; try { o.close() } catch (_) { } }
    pingAll();
    if (peerJSInstance) { try { peerJSInstance.destroy() } catch (_) { } peerJSInstance = null }
    role = null; myColor = null; flipped = false;
    hideOpponentChatBubble();
    syncGameSubtabs();
    $("connText").textContent = "Conectando…"; $("connDot").className = "status-dot warn";
    $("chatInput").disabled = true; $("chatSend").disabled = true; $("chatLog").innerHTML = "";
    resetLocal();
    showTab("moves");

    const isHost = !targetCode;
    const warm = takeWarmPeer();
    const roomCode = isHost ? (warm ? warm.code : genRoomCode()) : targetCode.toUpperCase();
    activeHandicap = "none";
    // Con ID propio se evita la petición HTTP previa que PeerJS hace para obtener uno
    try { peerJSInstance = warm ? warm.peer : new Peer(isHost ? "AJEDREZ-" + roomCode : "AJEDREZ-G" + genRoomCode() + genRoomCode(), { config: RTC_CONFIG }) }
    catch (err) { showToast("No se pudo iniciar la conexión. Comprueba tu red e inténtalo de nuevo."); $("connText").textContent = "Sin conectar · partida local"; $("connDot").className = "status-dot warn"; return }

    let peerReadyHandled = false;
    const onPeerOpen = () => {
      if (peerReadyHandled) {
        if (peerJSInstance) {
          $("connText").textContent = peerJSConn && peerJSConn.open ? "¡Rival conectado!" : "Señalización recuperada";
          $("connDot").className = peerJSConn && peerJSConn.open ? "status-dot" : "status-dot warn";
        }
        return;
      }
      peerReadyHandled = true;
      if (isHost) {
        role = "host"; const cs = hostOpts.color || $("colorSelect").value; hostOpts.color = null; myColor = cs === "r" ? (Math.random() < .5 ? "w" : "b") : cs; flipped = myColor === "b";
        if (window.__challengeHandicapValue) { activeHandicap = String(window.__challengeHandicapValue); window.__challengeHandicapValue = null; }
        try { if (activeHandicap !== "none") applyHandicapBoard(myColor, activeHandicap); }
        catch (err) { console.error("Error al aplicar el handicap:", err); activeHandicap = "none"; try { game.reset(); } catch (_) { } }
        $("roomInput").value = roomCode;
        $("connText").innerHTML = 'Sala [<span class="selectable">' + String(roomCode).replace(/[^A-Z0-9]/g, "") + '</span>] lista';
        showToast("Sala creada: " + roomCode + " · juegas con " + (myColor === "w" ? "blancas" : "negras") + (activeHandicap !== "none" ? " · handicap: " + getHandicapLabel(activeHandicap) : ""));
        try { render(); } catch (err) { console.error("Error al dibujar el tablero:", err); }
        if (onReady) onReady(roomCode);
      } else {
        role = "guest"; myColor = "b"; flipped = true;
        const conn = peerJSInstance.connect("AJEDREZ-" + roomCode, { reliable: true });
        setupConn(conn);
        peerConnectionTimer = setTimeout(() => {
          if (conn === peerJSConn && !conn.open) {
            setBoardLoading(false);
            bootJoining = false;
            peerJSConn = null;
            const failedPeer = peerJSInstance;
            peerJSInstance = null; role = null; myColor = null; flipped = false;
            try { conn.close() } catch (_) { }
            try { if (failedPeer) failedPeer.destroy() } catch (_) { }
            $("connText").textContent = "El anfitrión no responde"; $("connDot").className = "status-dot warn";
            $("chatInput").disabled = true; $("chatSend").disabled = true;
            render();
            showToast("No se pudo establecer la conexión. Comprueba el código y que el anfitrión siga conectado.");
          }
        }, 20000);
        render();
      }
    };
    if (peerJSInstance.open) onPeerOpen(); else peerJSInstance.on("open", onPeerOpen);

    peerJSInstance.on("connection", conn => setupConn(conn));
    peerJSInstance.on("disconnected", () => {
      if (peerJSInstance && !peerJSInstance.destroyed) {
        $("connText").textContent = "Recuperando señalización…"; $("connDot").className = "status-dot warn";
        try { peerJSInstance.reconnect() } catch (_) { }
      }
    });
    peerJSInstance.on("error", err => {
      setBoardLoading(false);
      if (bootJoining && !online()) { bootJoining = false; setTimeout(() => { location.href = "online.html" }, 2600); }
      showToast(err.type === "peer-unavailable" ? "No existe esa sala o el anfitrión está desconectado" : err.type === "unavailable-id" ? "Código en uso, inténtalo de nuevo" : "Error de conexión: " + err.type);
      if (!online()) { role = null; myColor = null; flipped = false; $("connText").textContent = "Sin conectar · partida local"; $("connDot").className = "status-dot warn"; $("chatInput").disabled = true; $("chatSend").disabled = true; render() }
    });
  }

  function setupConn(conn) {
    if (peerJSConn && peerJSConn.open && conn !== peerJSConn) {
      conn.on("open", () => { try { conn.send({ type: "full" }) } catch (_) { } setTimeout(() => conn.close(), 300) });
      return;
    }
    peerJSConn = conn;
    conn.on("open", () => {
      if (conn !== peerJSConn) return;
      clearTimeout(peerConnectionTimer); peerConnectionTimer = null;
      setBoardLoading(false);
      // Al aceptar una invitación y establecerse la conexión, mostrar directamente la partida.
      showTab("moves");
      showGameSubtab("moves");
      syncGameSubtabs();
      syncLocalTimeVisibility();
      $("connText").textContent = "¡Rival conectado!";
      $("connDot").className = "status-dot";
      $("chatInput").disabled = false;
      $("chatSend").disabled = false;
      showToast("¡Partida iniciada!");
      if (role === "host") sendPayload({ type: "sync", tc: $("tcSelect").value, host: myColor, name: myName, handicap: activeHandicap });
      else sendPayload({ type: "sync", name: myName, handicap: activeHandicap });
      pingAll();
    });
    conn.on("data", data => { if (conn === peerJSConn) handleNetworkData(data) });
    conn.on("error", () => { if (conn === peerJSConn) { $("connText").textContent = "Error en la conexión"; $("connDot").className = "status-dot warn" } });
    conn.on("close", () => {
      if (conn !== peerJSConn) return;
      clearTimeout(peerConnectionTimer); peerConnectionTimer = null;
      myColor = null; role = null; clearDraw(); render();
      $("connText").textContent = "Rival desconectado";
      $("connDot").className = "status-dot warn";
      $("chatInput").disabled = true;
      $("chatSend").disabled = true;
      hideOpponentChatBubble();
      syncGameSubtabs();
      pingAll();
    });
  }

  $("createRoomBtn").onclick = () => handoff({ mode: "host", tc: $("tcSelect").value, color: $("colorSelect").value || "r" });
  $("joinRoomBtn").onclick = () => {
    const c = $("roomInput").value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(c)) { showToast("El código de sala debe tener 6 caracteres"); return }
    handoff({ mode: "join", room: c });
  };
  $("boardLoadingCopy").onclick = () => {
    const c = $("boardLoadingCode").textContent.trim();
    if (!c) return;
    const url = location.href.split(/[?#]/)[0] + "?mode=join&room=" + encodeURIComponent(c);
    navigator.clipboard.writeText(url).then(() => showToast("Enlace copiado"));
  };
  $("boardLoadingCodeCopy").onclick = () => navigator.clipboard.writeText($("boardLoadingCode").textContent.trim()).then(() => showToast("Código copiado"));

  /* ---------- Amigos: ID persistente + presencia (sin servidor propio) ---------- */
  const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v) } catch (_) { return null } };
  const rnd = n => Array.from({ length: n }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.random() * 32 | 0]).join("");
  let myCode = LS("aj_code"); if (!myCode) { myCode = rnd(8); LS("aj_code", myCode) }
  let myName = LS("aj_name") || "Jugador" + rnd(3);
  let friends = []; try { friends = JSON.parse(LS("aj_friends") || "[]") } catch (_) { }
  const presence = {}, playing = {}, FID = c => "AJEDREZ-U" + c, NAME_FID = name => {
    const normalized = normalizeName(name).normalize("NFKC").toLowerCase();
    let hashA = 2166136261, hashB = 2246822519;
    for (let i = 0; i < normalized.length; i++) {
      const code = normalized.charCodeAt(i);
      hashA = Math.imul(hashA ^ code, 16777619) >>> 0;
      hashB = Math.imul(hashB ^ code, 3266489917) >>> 0;
    }
    return "AJEDREZ-N" + hashA.toString(16).padStart(8, "0") + hashB.toString(16).padStart(8, "0");
  }, saveFriends = () => LS("aj_friends", JSON.stringify(friends));
  const ELO_KEY = "aj_elo_by_name";
  let playerRatings = {}; try { playerRatings = JSON.parse(LS(ELO_KEY) || "{}") || {}; } catch (_) { playerRatings = {} }
  let activeOpponentName = "Rival";
  let friendPeer = null, namePeer = null, pendingInvite = null, pendingRematch = null;
  let friendStartTimer = null;
  const peerTabId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const peerChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("aj-peer-owner-" + myCode) : null;
  const ratedResults = new Map();
  const confirmLeave = () => !online() || confirm("Se cerrará la partida online actual. ¿Continuar?");
  const isPlayingOnline = () => !!online();

  function normalizeName(name, fallback = "Jugador", max = 16) {
    const clean = String(name || fallback).trim().replace(/\s+/g, " ").slice(0, max);
    return clean || fallback;
  }
  const BOT_PROFILES = [
    { name: "Maya", seed: "maya", elo: 100 },
    { name: "Leo", seed: "leo", elo: 400 },
    { name: "Sara", seed: "sara", elo: 800 },
    { name: "Iker", seed: "iker", elo: 1200 },
    { name: "Nora", seed: "nora", elo: 1600 },
    { name: "Omar", seed: "omar", elo: 2000 },
    { name: "Luna", seed: "luna", elo: 2400 },
    { name: "Daniel", seed: "daniel", elo: 2800 },
    { name: "Ava", seed: "ava", elo: 3000 },
    { name: "Mateo", seed: "mateo", elo: 3200 }
  ];
  function botProfileByElo(elo) {
    const safe = Math.max(100, Math.min(3000, Math.round(Number(elo) || 1200)));
    return BOT_PROFILES.reduce((best, current) => Math.abs(current.elo - safe) < Math.abs(best.elo - safe) ? current : best, BOT_PROFILES[0]);
  }
  function botAvatarSeed(levelOrElo) {
    return botProfileByElo(levelOrElo).seed || String(levelOrElo || 1200);
  }
  function avatarUrl(seed, isBot = false) {
    const key = normalizeName(seed || "bot").toLowerCase();
    return "https://api.dicebear.com/10.x/" + (isBot ? "avataaars" : "marbles") + "/svg?seed=" + encodeURIComponent(key);
  }
  function chessPieceFallbackUrl(color) {
    const isWhite = color === "w";
    const piece = isWhite ? "♔" : "♚";
    const fill = isWhite ? "#fff" : "#222";
    const stroke = isWhite ? "#333" : "#fff";
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="50%" y="78%" text-anchor="middle" font-family="Segoe UI Symbol,Arial,sans-serif" font-size="56" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1">' + piece + '</text></svg>';
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
  function setPlayerAvatar(img, name, color, isBot = false, seed = name, useChessPiece = false) {
    img.alt = name;
    let triedPieceImage = useChessPiece;
    img.onerror = () => {
      if (!triedPieceImage) {
        triedPieceImage = true;
        img.src = PIECE(color, "k");
        return;
      }
      img.onerror = null;
      img.src = chessPieceFallbackUrl(color);
    };
    if (useChessPiece) {
      img.src = PIECE(color, "k");
      return;
    }
    const safeSeed = String(seed || name || "bot");
    img.src = avatarUrl(safeSeed, isBot);
  }
  (function initBotLevelPicker() {
    const select = byId("botLevel");
    if (!select) return;
    const root = document.createElement("div");
    root.className = "bot-level-picker";
    select.classList.add("bot-level-native");
    select.after(root);

    const summary = document.createElement("div");
    summary.className = "bot-level-summary";
    root.appendChild(summary);

    const groups = [
      { title: "Beginner", min: 100, max: 800 },
      { title: "Intermediate", min: 1200, max: 2000 },
      { title: "Advanced", min: 2400, max: 3200 }
    ];

    const grid = document.createElement("div");
    grid.className = "bot-level-grid";
    root.appendChild(grid);

    const entries = [];
    groups.forEach(group => {
      const groupWrap = document.createElement("div");
      groupWrap.className = "bot-level-group";

      const title = document.createElement("div");
      title.className = "bot-level-group-title";
      title.textContent = group.title;
      groupWrap.appendChild(title);

      const row = document.createElement("div");
      row.className = "bot-level-group-row";
      groupWrap.appendChild(row);

      const profiles = BOT_PROFILES.filter(profile => profile.elo >= group.min && profile.elo <= group.max).sort((a, b) => a.elo - b.elo);
      profiles.forEach(profile => {
        const option = document.createElement("option");
        option.value = String(profile.elo);
        option.textContent = profile.name + " • Elo " + profile.elo;
        select.appendChild(option);

        const button = document.createElement("button");
        button.type = "button";
        button.className = "bot-level-option";
        button.setAttribute("role", "option");
        button.setAttribute("aria-label", profile.name + " · Elo " + profile.elo);
        button.dataset.value = String(profile.elo);

        const image = document.createElement("img");
        image.className = "bot-level-option-avatar";
        image.alt = profile.name;

        const textWrap = document.createElement("div");
        textWrap.className = "bot-level-option-text";
        const nameEl = document.createElement("span");
        nameEl.className = "bot-level-option-name";
        nameEl.textContent = profile.name;
        const eloEl = document.createElement("span");
        eloEl.className = "bot-level-option-elo";
        eloEl.textContent = profile.elo;
        textWrap.append(nameEl, eloEl);

        button.append(image, textWrap);
        button.onclick = () => {
          select.value = String(profile.elo);
          select.dispatchEvent(new Event("change", { bubbles: true }));
        };

        row.appendChild(button);
        setPlayerAvatar(image, profile.name, "b", true, botAvatarSeed(profile.elo));
        entries.push({ option, button, profile });
      });

      grid.appendChild(groupWrap);
    });

    function refresh() {
      const selected = entries.find(entry => entry.option.value === select.value) || entries[0];
      summary.innerHTML = '<strong>' + selected.profile.name + '</strong><span class="bot-level-summary-elo">' + selected.profile.elo + '</span>';
      entries.forEach(entry => entry.button.setAttribute("aria-selected", String(entry === selected)));
    }

    select.addEventListener("change", refresh);
    select.value = String(botElo);
    refresh();
  })();
  function playerDisplayName(color) {
    if (botEnabled) return color === botColor ? botProfileByElo(botElo).name : normalizeName(myName, "Yo");
    if (myColor) return normalizeName(color === myColor ? myName : activeOpponentName || "Rival", color === myColor ? "Yo" : "Rival");
    return color === "w" ? "Blancas" : "Negras";
  }
  function playerKey(name) { return normalizeName(name, "Jugador").toLowerCase(); }
  function ensurePlayerElo(name) {
    const clean = normalizeName(name, "Jugador");
    const key = playerKey(clean);
    if (!playerRatings[key]) setPlayerElo(clean, 500);
    else if (playerRatings[key].name !== clean) playerRatings[key].name = clean;
    return getPlayerElo(clean);
  }
  function getPlayerElo(name, fallback = 500) {
    const key = playerKey(name);
    const entry = playerRatings[key];
    const value = Number(entry && (typeof entry === "object" ? (entry.rating ?? entry.value) : entry));
    if (Number.isFinite(value)) return Math.max(0, Math.round(value));
    return Number.isFinite(fallback) ? Math.max(0, Math.round(fallback)) : 500;
  }
  function getPlayerRatedGames(name) {
    const entry = playerRatings[playerKey(name)];
    return Math.max(0, Math.floor(Number(entry && typeof entry === "object" ? entry.games : 0) || 0));
  }
  function setPlayerRating(name, rating, games) {
    const clean = normalizeName(name, "Jugador");
    playerRatings[playerKey(clean)] = { name: clean, rating, games };
    try { LS(ELO_KEY, JSON.stringify(playerRatings)); } catch (_) { }
  }
  function setPlayerElo(name, value) {
    const clean = normalizeName(name, "Jugador");
    const rating = Math.max(0, Math.round(Number(value) || 500));
    const previous = playerRatings[playerKey(clean)];
    playerRatings[playerKey(clean)] = { name: clean, rating, games: Math.max(0, Math.floor(Number(previous && typeof previous === "object" ? previous.games : 0) || 0)) };
    try { LS(ELO_KEY, JSON.stringify(playerRatings)); } catch (_) { }
    return rating;
  }
  function encodeProgressText(payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const code = btoa(binary);
    let hash = 2166136261;
    for (let i = 0; i < code.length; i++) hash = Math.imul(hash ^ code.charCodeAt(i), 16777619) >>> 0;
    return "AJEDREZ-ELO-1\n" + code.match(/.{1,64}/g).join("\n") + "\nFIRMA:" + hash.toString(16).padStart(8, "0");
  }
  function decodeProgressText(contents) {
    const lines = String(contents || "").trim().split(/\r?\n/);
    if (lines.shift() !== "AJEDREZ-ELO-1") throw new Error("El archivo no es una copia de Elo válida.");
    const signature = lines.pop();
    const code = lines.join("").trim();
    let hash = 2166136261;
    for (let i = 0; i < code.length; i++) hash = Math.imul(hash ^ code.charCodeAt(i), 16777619) >>> 0;
    if (!/^FIRMA:[0-9a-f]{8}$/i.test(signature || "") || signature.slice(7).toLowerCase() !== hash.toString(16).padStart(8, "0")) throw new Error("El archivo está incompleto o ha sido modificado.");
    const binary = atob(code), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || data.version !== 1 || !data.player || !Number.isFinite(data.rating) || !Number.isInteger(data.games) || data.games < 0 || data.rating < 0 || data.rating > 100000) throw new Error("Los datos de Elo del archivo no son válidos.");
    return { name: normalizeName(data.player), rating: Math.round(data.rating), games: data.games };
  }
  function exportEloProgress() {
    const name = normalizeName(myName, "Yo");
    const content = encodeProgressText({ version: 1, player: name, rating: getPlayerElo(name), games: getPlayerRatedGames(name) });
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "ajedrez-elo-" + playerKey(name).replace(/[^a-z0-9-]/g, "-") + ".txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Copia de Elo descargada");
  }
  async function importEloProgress(file) {
    try {
      if (!file || file.size > 1024 * 1024) throw new Error("El archivo está vacío o supera el tamaño permitido.");
      const progress = decodeProgressText(await file.text());
      if (!confirm("¿Importar el progreso de " + progress.name + " (Elo " + progress.rating + ")? Se reemplazará ese perfil en este dispositivo.")) return;
      setPlayerRating(progress.name, progress.rating, progress.games);
      myName = progress.name;
      LS("aj_name", myName);
      $("nameInput").value = myName;
      setPlayerAvatar($("profileAvatar"), myName, "w");
      startNamePeer();
      render();
      pingAll();
      showToast("Progreso Elo recuperado");
    } catch (error) {
      showToast(error.message || "No se pudo importar el archivo");
    } finally {
      $("importEloFile").value = "";
    }
  }
  function getEloText(name) { return "Elo " + getPlayerElo(name); }
  function applyEloResult(playerName, opponentName, scoreForPlayer) {
    const aName = normalizeName(playerName, "Jugador");
    const bName = normalizeName(opponentName, "Rival");
    const key = [playerKey(aName), playerKey(bName)].sort().join("|");
    const now = Date.now();
    const previous = ratedResults.get(key);
    if (previous && now - previous < 15000) return;
    ratedResults.set(key, now);

    const a = ensurePlayerElo(aName);
    const b = ensurePlayerElo(bName);
    const score = Math.max(0, Math.min(1, Number(scoreForPlayer) || 0.5));
    const expectedA = 1 / (1 + Math.pow(10, (b - a) / 400));
    const expectedB = 1 / (1 + Math.pow(10, (a - b) / 400));
    const gamesA = getPlayerRatedGames(aName), gamesB = getPlayerRatedGames(bName);
    const kA = gamesA < 30 ? 40 : a >= 2400 ? 10 : 20;
    const kB = gamesB < 30 ? 40 : b >= 2400 ? 10 : 20;
    const nextA = Math.max(0, Math.round(a + kA * (score - expectedA)));
    const nextB = Math.max(0, Math.round(b + kB * ((1 - score) - expectedB)));
    setPlayerRating(aName, nextA, gamesA + 1);
    setPlayerRating(bName, nextB, gamesB + 1);
  }

  let friendRenderSignature = null;
  function renderFriends() {
    const el = $("friendList");
    const signature = JSON.stringify(friends.map(f => {
      const live = liveMatches[f.code];
      return [f.code, f.name, f.ack, getEloText(f.name || f.code), presence[f.code] === true,
        playing[f.code] === true, !!live && live.playing !== false];
    }));
    if (signature === friendRenderSignature) return;
    friendRenderSignature = signature;
    el.innerHTML = "";
    if (!friends.length) { el.innerHTML = '<div class="empty">Busca a un amigo por nombre o añádelo con su código para ver si está conectado y retarle.</div>'; return }
    const activeFriends = friends.filter(f => presence[f.code] === true);
    const inactiveFriends = friends.filter(f => presence[f.code] !== true);
    const divider = label => {
      const d = document.createElement("div"); d.className = "friend-divider";
      const before = document.createElement("hr"), text = document.createElement("span"), after = document.createElement("hr");
      text.textContent = label;
      d.append(before, text, after);
      el.appendChild(d);
    };
    const renderFriend = f => {
      const d = document.createElement("div"); d.className = "friend";
      d.innerHTML = '<div class="friend-main">' +
        '<div class="friend-top"><img class="friend-avatar" alt=""><span class="fname"></span></div>' +
        '<div class="friend-meta"><span class="friend-status"></span><span class="friend-elo"></span></div>' +
        '</div>' +
        '<div class="friend-actions">' +
        '<button class="primarySmall watch-btn" hidden><span class="material-symbols-rounded">visibility</span> Ver</button>' +
        '<button class="primarySmall challenge-btn"><span class="material-symbols-rounded">swords</span> Retar</button>' +
        '<button class="secondary noTextButton" title="Quitar" aria-label="Quitar amigo"><span class="material-symbols-rounded">close</span></button>' +
        '</div>';
      const name = f.name || f.code;
      d.querySelector(".fname").textContent = name;
      setPlayerAvatar(d.querySelector(".friend-avatar"), name, "w");
      const status = d.querySelector(".friend-status");
      const hasLiveGame = !!liveMatches[f.code] && liveMatches[f.code].playing !== false;
      status.textContent = playing[f.code] ? (hasLiveGame ? "en partida en directo" : "en partida") : "no está jugando partida";
      status.hidden = !presence[f.code];
      d.querySelector(".friend-elo").textContent = getEloText(name);
      const [watchBtn, challengeBtn, removeBtn] = d.querySelectorAll("button");
      watchBtn.hidden = f.code === myCode || !hasLiveGame || !presence[f.code];
      watchBtn.onclick = () => openWatchModal(f.code);
      challengeBtn.disabled = !presence[f.code] || f.code === myCode;
      challengeBtn.onclick = () => challenge(f);
      removeBtn.onclick = () => { friends = friends.filter(x => x.code !== f.code); saveFriends(); renderFriends() };
      el.appendChild(d);
    };
    divider("ACTIVOS");
    activeFriends.forEach(renderFriend);
    divider("INACTIVOS / DESCONECTADOS");
    inactiveFriends.forEach(renderFriend);
  }
  function ping(f) {
    if (!friendPeer || !friendPeer.open) return;
    const c = friendPeer.connect(FID(f.code), { reliable: true });
    // WebRTC can take several seconds to negotiate; a short timeout incorrectly
    // reports reachable friends as offline on slower networks.
    let responded = false;
    const t = setTimeout(() => { if (!responded) { presence[f.code] = false; delete playing[f.code]; renderFriends() } try { c.close() } catch (_) { } }, 20000);
    c.on("open", () => {
      c.send({ type: "hello", name: myName, code: myCode, elo: getPlayerElo(myName), playing: isPlayingOnline(), fen: game.fen(), pgn: game.pgn({ max_width: 60, newline_char: "\n" }) });
      if (isPlayingOnline()) c.send(prepareLiveGamePayload());
    });
    c.on("data", d => {
      if (!d) return;
      if (d.type === "hello") {
        responded = true; clearTimeout(t); presence[f.code] = true;
        if (d.name && d.name !== f.name) { f.name = String(d.name).slice(0, 16); saveFriends() }
        if (typeof d.elo === "number") setPlayerElo(d.name, d.elo);
        playing[f.code] = d.playing === true;
        if (d.code && d.code !== myCode && d.playing === true && d.fen) {
          updateLiveMatch(d);
        }
        renderFriends();
        if (!f.ack) { c.send({ type: "friend", name: myName, code: myCode, elo: getPlayerElo(myName), playing: isPlayingOnline() }); f.ack = true; saveFriends() }
        if (isPlayingOnline()) c.send(prepareLiveGamePayload());
        setTimeout(() => { try { c.close() } catch (_) { } }, 500);
      } else if (d.type === "friendAck") { f.ack = true; saveFriends(); try { c.close() } catch (_) { } }
      else if (d.type === "liveGame") { updateLiveMatch(d); renderFriends(); try { c.close() } catch (_) { } }
    });
    c.on("error", () => { /* Keep the last known status until the presence probe expires. */ });
    c.on("close", () => { clearTimeout(t) });
  }
  let pingTimer = null;
  function pingAll() {   // agrupa llamadas seguidas para no saturar la red mientras se establece una partida
    if (pingTimer) return;
    pingTimer = setTimeout(() => { pingTimer = null; friends.forEach(ping) }, 600);
  }
  function findFriendByName() {
    const name = normalizeName($("friendNameInput").value, "").slice(0, 16);
    if (!name) { showToast("Escribe el nombre del jugador"); return }
    if (playerKey(name) === playerKey(myName)) { showToast("Ese es tu propio nombre"); return }
    if (!friendPeer || !friendPeer.open) { showToast("Tu conexión de amigos aún no está lista"); return }

    let completed = false;
    let attempts = 0, attemptTimer = null;
    const timeout = setTimeout(() => {
      if (completed) return;
      completed = true;
      showToast("No se encontró a " + name + ". Prueba con su código de amigo.");
    }, 20000);
    const retry = () => {
      clearTimeout(attemptTimer);
      if (!completed && attempts < 3) attemptTimer = setTimeout(connectAttempt, 650);
    };
    function connectAttempt() {
      if (completed || attempts >= 3 || !friendPeer || !friendPeer.open) return;
      attempts++;
      let answered = false;
      let c;
      try { c = friendPeer.connect(NAME_FID(name), { reliable: true }); }
      catch (_) { retry(); return; }
      const attemptTimeout = setTimeout(() => { if (!answered) { try { c.close() } catch (_) { } retry(); } }, 5500);
      c.on("open", () => { try { c.send({ type: "nameLookup" }) } catch (_) { retry(); } });
      c.on("data", d => {
        if (completed || !d || d.type !== "nameResult") return;
        answered = true; clearTimeout(attemptTimeout); clearTimeout(attemptTimer); clearTimeout(timeout);
        completed = true;
        try { c.close() } catch (_) { }
        if (!/^[A-Z0-9]{8}$/.test(String(d.code))) { showToast("La respuesta del jugador no es válida"); return; }
        if (d.code === myCode) { showToast("Ese es tu propio código"); return; }
        let f = friends.find(x => x.code === d.code);
        const foundName = normalizeName(d.name || name);
        if (!f) { f = { code: d.code, name: foundName, ack: false }; friends.push(f) }
        else f.name = foundName;
        if (typeof d.elo === "number") setPlayerElo(foundName, d.elo);
        presence[d.code] = true; playing[d.code] = d.playing === true;
        saveFriends(); $("friendNameInput").value = ""; renderFriends();
        showToast("Encontrado: " + foundName); ping(f);
      });
      c.on("error", () => { if (!answered) { answered = true; clearTimeout(attemptTimeout); retry(); } });
    }
    connectAttempt();
  }
  let challengeTarget = null;
  function closeChallengePickers() {
    document.querySelectorAll("#challengeModal .hcp").forEach(r => r.classList.remove("open"));
    document.querySelectorAll("#challengeModal .hcp-panel").forEach(pn => { pn.hidden = true; });
    document.querySelectorAll("#challengeModal .hcp-trigger").forEach(t => t.setAttribute("aria-expanded", "false"));
  }
  function challenge(f) {
    if (!confirmLeave()) return;
    if (!friendPeer || !friendPeer.open) { showToast("Tu conexión de amigos aún no está lista"); return }
    closeTcPickers();
    closeChallengePickers();
    challengeTarget = f;
    $("challengeFriendName").textContent = "Invitación para " + (f.name || f.code) + ". Elige el ritmo, el color y el handicap con el que quieres jugar.";
    $("inviteTcSelect").value = $("tcSelect").value;
    $("inviteColorSelect").value = $("colorSelect").value;
    $("inviteHandicapSelect").value = "none";
    $("challengeModal").style.display = "flex";
  }
  function sendChallenge() {
    const f = challengeTarget;
    if (!f) return;
    if (!friendPeer || !friendPeer.open) {
      showToast("Tu conexión de amigos aún no está lista");
      return;
    }

    const inviteSelect = $("inviteHandicapSelect");
    const handicapValue = String((inviteSelect && inviteSelect.value) || "none");
    const normalizedHandicap = normalizeHandicapValue(handicapValue);
    const inviteTc = $("inviteTcSelect").value;
    const inviteColor = $("inviteColorSelect").value;

    if (normalizedHandicap !== "none") {
      const check = validateHandicapPosition(inviteColor, normalizedHandicap);
      if (!check.ok) { showToast(check.error); return; }   // el modal sigue abierto para corregirlo
    }

    closeChallengePickers();
    $("challengeModal").style.display = "none";
    challengeTarget = null;
    if (PAGE !== "partida") { handoff({ mode: "host", invite: f.code, iname: f.name || "", tc: inviteTc, color: inviteColor, handicap: normalizedHandicap }); return; }
    runChallenge(f, inviteTc, inviteColor, normalizedHandicap);
  }
  let friendRetries = 0, nameRetries = 0, friendReconnectTimer = null, nameReconnectTimer = null;
  const friendReady = [];
  function afterFriendPeer(cb) {
    if (friendPeer && friendPeer.open) return cb();
    friendReady.push(cb);
  }
  function runChallenge(f, inviteTc, inviteColor, normalizedHandicap) {
    setBoardLoading(true, { title: "Esperando a " + (f.name || f.code), sub: "Le hemos enviado la invitación", persist: true });
    $("tcSelect").value = inviteTc;
    hostOpts.color = inviteColor;
    activeHandicap = normalizedHandicap;
    window.__challengeHandicapValue = normalizedHandicap;
    parseTC(inviteTc);

    try { initPeerJS(null, roomCode => afterFriendPeer(() => {
      const c = friendPeer.connect(FID(f.code), { reliable: true });
      const timeout = setTimeout(() => {
        if (!c.open) {
          setBoardLoading(false);
          showToast("No se pudo contactar con " + (f.name || f.code));
        }
      }, 8000);

      const sendInvite = () => {
        try {
          c.send({ type: "invite", room: roomCode, name: myName, tc: inviteTc, color: inviteColor, handicap: activeHandicap });
          // Se queda cargando hasta que el rival acepte (setupConn lo quita al conectarse), rechace o pasen 60 s
          showToast("Invitación enviada a " + (f.name || f.code) + ". Esperando a que acepte…");
        } catch (_) {
          setBoardLoading(false);
          showToast("No se pudo enviar la invitación. Comprueba que esté en línea.");
        }
      };

      c.on("data", d => {
        if (d && d.type === "declined") {
          setBoardLoading(false);
          showToast((f.name || "Tu amigo") + " rechazó la invitación");
        }
      });
      c.on("error", () => {
        clearTimeout(timeout);
        setBoardLoading(false);
        showToast("No se pudo enviar la invitación. Comprueba que esté en línea.");
      });
      c.on("close", () => {
        // El amigo cerró la página antes de aceptar
        if (!peerJSConn || !peerJSConn.open) setBoardLoading(false);
      });

      if (c.open) {
        clearTimeout(timeout);
        sendInvite();
        return;
      }
      c.on("open", () => {
        clearTimeout(timeout);
        sendInvite();
      });
    })); } catch (err) {
      console.error("Error al enviar el reto:", err);
      setBoardLoading(false);
      showToast("No se pudo enviar el reto");
    }
    challengeTarget = null;
  }
  $("sendChallengeBtn").onclick = sendChallenge;
  $("cancelChallengeBtn").onclick = () => { closeChallengePickers(); $("challengeModal").style.display = "none"; challengeTarget = null };
  $("challengeModal").addEventListener("click", e => { if (e.target === $("challengeModal")) { $("challengeModal").style.display = "none"; challengeTarget = null; } });
  function showInvite(d, c) {
    pendingInvite = { room: d.room, c, handicap: d.handicap };
    pendingRematch = null;
    const n = normalizeName(d.name || "Un amigo");
    const tcLabel = /^\d{1,5}\+\d{1,3}$/.test(String(d.tc)) ? tcName(d.tc) : "Control de tiempo estándar";
    const myInvitedColor = d.color === "w" ? "negras" : d.color === "b" ? "blancas" : "color aleatorio";
    const handicapText = getHandicapLabel(d.handicap);
    $("inviteText").textContent = n + " te invita · " + tcLabel + " · " + getEloText(n) + (handicapText !== "Ninguno" ? " · handicap: " + handicapText : "") + " · tú juegas con " + myInvitedColor;
    $("inviteBar").hidden = false;
  }
  function showRematchOffer(d, c) {
    pendingInvite = null;
    pendingRematch = { c, opponent: normalizeName(d.name || "Rival") };
    const n = pendingRematch.opponent;
    $("inviteText").textContent = n + " quiere revancha · " + getEloText(n) + " · ¿aceptas?";
    $("inviteBar").hidden = false;
  }
  function requestRematch() {
    if (!online()) { showToast("Necesitas una partida online para pedir revancha"); return }
    const opponent = normalizeName(activeOpponentName || "Rival");
    if (peerJSConn && peerJSConn.open) {
      peerJSConn.send({ type: "rematchRequest", name: myName, elo: getPlayerElo(myName) });
      showToast("Revancha enviada a " + opponent);
    }
  }
  $("invYes").onclick = () => {
    const rematch = pendingRematch;
    const i = pendingInvite;
    $("inviteBar").hidden = true;
    if (rematch) {
      pendingRematch = null;
      try {
        if (rematch.c && rematch.c.open) rematch.c.send({ type: "rematchAccept", name: myName, elo: getPlayerElo(myName) });
      } catch (_) { }
      if (confirmLeave()) {
        resetLocal();
        showToast("Revancha aceptada");
        render();
      }
      return;
    }
    pendingInvite = null;
    if (i && confirmLeave()) { if (PAGE !== "partida") handoff({ mode: "join", room: i.room }); else initPeerJS(i.room) }
  };
  $("invNo").onclick = () => {
    const rematch = pendingRematch;
    try {
      if (rematch && rematch.c && rematch.c.open) rematch.c.send({ type: "rematchDecline", name: myName });
      else if (pendingInvite && pendingInvite.c) pendingInvite.c.send({ type: "declined" });
    } catch (_) { }
    $("inviteBar").hidden = true;
    pendingInvite = null;
    pendingRematch = null;
  };

  function prepareLiveGamePayload() {
    const result = getResult();
    const opponentName = botEnabled ? botProfileByElo(botElo).name : normalizeName(activeOpponentName || "Rival");
    const whiteName = myColor === "w" ? normalizeName(myName, "Yo") : normalizeName(opponentName, "Rival");
    const blackName = myColor === "b" ? normalizeName(myName, "Yo") : normalizeName(opponentName, "Rival");
    return {
      type: "liveGame",
      code: myCode,
      name: myName,
      opponent: opponentName,
      whiteName,
      blackName,
      fen: game.fen(),
      pgn: game.pgn({ max_width: 60, newline_char: "\n" }),
      playing: isPlayingOnline(),
      result: result ? { w: result.w, why: result.why } : null,
      moveCount: game.history().length,
      tc: ($("tcSelect") && $("tcSelect").value) || ($("localTcSelect") && $("localTcSelect").value) || "600+0",
      whiteTime,
      blackTime
    };
  }
  function updateLiveMatch(d) {
    if (!d || !d.code) return;
    const code = String(d.code);
    if (code === myCode) return;
    const item = {
      code,
      name: normalizeName(d.name || code, "Jugador"),
      opponent: normalizeName(d.opponent || "Rival", "Rival"),
      whiteName: normalizeName(d.whiteName || d.opponent || "Blancas", "Blancas"),
      blackName: normalizeName(d.blackName || d.name || "Negras", "Negras"),
      fen: String(d.fen || "startpos"),
      pgn: String(d.pgn || ""),
      playing: d.playing !== false,
      result: d.result || null,
      moveCount: Number(d.moveCount) || 0,
      tc: String(d.tc || "600+0"),
      updatedAt: Date.now()
    };
    liveMatches[code] = item;
    try { store.set(LIVE_GAMES_KEY, JSON.stringify(liveMatches)) } catch (_) { }
    presence[code] = true;
    playing[code] = item.playing;
    if (activeWatchCode === code && $("watchModal").style.display === "flex") {
      openWatchModal(code);
    }
    renderFriends();
  }
  function scheduleLiveMatchBroadcast(immediate = false) {
    if (!friendPeer || !friendPeer.open || !friends.length) return;
    const run = () => {
      const payload = prepareLiveGamePayload();
      friends.forEach(f => {
        if (!f || !f.code || f.code === myCode || !presence[f.code]) return;
        try {
          const c = friendPeer.connect(FID(f.code), { reliable: true });
          c.on("open", () => c.send(payload));
          c.on("data", d => { if (d && d.type === "liveGame") updateLiveMatch(d) });
          c.on("error", () => {});
        } catch (_) { }
      });
    };
    if (immediate) {
      if (liveBroadcastTimer) { clearTimeout(liveBroadcastTimer); liveBroadcastTimer = null; }
      run();
      return;
    }
    if (liveBroadcastTimer) clearTimeout(liveBroadcastTimer);
    liveBroadcastTimer = setTimeout(run, 120);
  }
  function broadcastLiveMatch() {
    scheduleLiveMatchBroadcast(true);
  }
  function openWatchModal(code) {
    const data = liveMatches[code];
    if (!data) { showToast("Esta partida no está disponible en directo ahora mismo"); return }
    activeWatchCode = code;
    watchFlipped = false;

    const blackName = normalizeName(data.blackName || (data.name && data.opponent ? ((data.name === data.whiteName) ? data.opponent : data.name) : data.name || "Negras"), "Negras");
    const whiteName = normalizeName(data.whiteName || (data.name && data.opponent ? ((data.name === data.blackName) ? data.opponent : data.opponent || data.name) : data.opponent || "Blancas"), "Blancas");
    const topMeta = $("watchMetaTop");
    const bottomMeta = $("watchMetaBottom");
    topMeta.innerHTML = "";
    bottomMeta.innerHTML = "";

    const buildPlayer = (name, side, status = "") => {
      const row = document.createElement("div");
      row.className = "watch-player" + (status ? "" : " empty-status");

      const avatar = document.createElement("img");
      avatar.className = "watch-player-avatar";
      avatar.alt = name;
      setPlayerAvatar(avatar, name, side === "white" ? "w" : "b", false, name, false);

      const text = document.createElement("div");
      text.className = "watch-player-text";

      const nameEl = document.createElement("div");
      nameEl.className = "watch-player-name";
      nameEl.textContent = name;

      const sub = document.createElement("div");
      sub.className = "watch-player-sub";
      sub.textContent = side === "white" ? "Blancas" : "Negras";

      const state = document.createElement("div");
      state.className = "watch-player-status";
      state.textContent = status;

      text.appendChild(nameEl);
      text.appendChild(sub);
      row.appendChild(avatar);
      row.appendChild(text);
      row.appendChild(state);
      return row;
    };

    topMeta.appendChild(buildPlayer(blackName, "black", ""));
    bottomMeta.appendChild(buildPlayer(whiteName, "white", ""));

    const watchGame = new Chess();
    try { watchGame.load(data.fen || "startpos") } catch (_) { }
    renderWatchBoard(watchGame);
    $("watchModal").style.display = "flex";
  }
  function renderWatchBoard(gameState) {
    const board = $("watchBoard");
    const previousState = watchBoardState;
    const prevPositions = new Map();
    if (previousState) {
      for (let rank = 8; rank >= 1; rank--) {
        for (const file of files) {
          const square = file + rank;
          const piece = previousState.get(square);
          if (piece) prevPositions.set(piece.color + piece.type + "-" + (prevPositions.get(piece.color + piece.type) || 0), square);
        }
      }
    }
    board.innerHTML = "";
    const b = boardInfo(boardTheme);
    if (b.img) {
      board.style.backgroundImage = 'url("' + boardImgUrl(b.id, 150) + '")';
      board.style.backgroundSize = "100% 100%";
      board.style.backgroundRepeat = "no-repeat";
    } else {
      board.style.backgroundImage = "";
      board.style.backgroundSize = "";
      board.style.backgroundRepeat = "";
    }
    const remainingSources = previousState ? new Map() : null;
    if (remainingSources) {
      for (let rank = 8; rank >= 1; rank--) {
        for (const file of files) {
          const square = file + rank;
          const piece = previousState.get(square);
          if (piece) {
            const key = piece.color + piece.type;
            const arr = remainingSources.get(key) || [];
            arr.push(square);
            remainingSources.set(key, arr);
          }
        }
      }
    }
    const displaySquare = squareName => {
      const fileIndex = files.indexOf(squareName[0]);
      const rankIndex = Number(squareName[1]) - 1;
      const x = watchFlipped ? 7 - fileIndex : fileIndex;
      const y = watchFlipped ? rankIndex : 7 - rankIndex;
      return { x, y };
    };
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const file = watchFlipped ? 7 - x : x;
      const rank = watchFlipped ? y : 7 - y;
      const name = files[file] + (rank + 1);
      const sq = document.createElement("div");
      const isLight = ((file + rank) % 2 === 0);
      sq.className = "square " + (isLight ? "light" : "dark");
      if (!b.img) {
        const root = getComputedStyle(document.documentElement);
        sq.style.background = isLight ? (root.getPropertyValue("--light").trim() || "#ebecd0") : (root.getPropertyValue("--dark").trim() || "#779556");
      } else {
        sq.style.background = "transparent";
      }
      const p = gameState.get(name);
      if (p) {
        const img = document.createElement("img");
        img.className = "piece " + (p.color === "w" ? "white" : "black");
        img.src = PIECE_FOR("friend_watch", p.color, p.type);
        img.alt = "";
        if (previousState) {
          const key = p.color + p.type;
          const sources = remainingSources && remainingSources.get(key) ? remainingSources.get(key).slice() : [];
          const uniqueSources = sources.filter(square => square !== name && !!previousState.get(square) && previousState.get(square).color === p.color && previousState.get(square).type === p.type && !gameState.get(square));
          const source = uniqueSources.length === 1 ? uniqueSources[0] : null;
          if (source) {
            const sourceIndex = sources.indexOf(source);
            if (sourceIndex >= 0) {
              sources.splice(sourceIndex, 1);
              remainingSources.set(key, sources);
            }
            const sourceCoord = displaySquare(source);
            const targetCoord = displaySquare(name);
            const dx = (sourceCoord.x - targetCoord.x) * 100;
            const dy = (sourceCoord.y - targetCoord.y) * 100;
            img.style.transform = "translate(" + dx + "%, " + dy + "%)";
            img.style.transition = "transform 220ms ease-out";
            requestAnimationFrame(() => {
              img.style.transform = "translate(0, 0)";
            });
          }
        }
        sq.appendChild(img);
      }
      board.appendChild(sq);
    }
    watchBoardState = gameState;
  }
  function startFriendPeer() {
    if (typeof Peer === "undefined") return;
    if (friendPeer && !friendPeer.destroyed) return;
    try { friendPeer = new Peer(FID(myCode), { config: RTC_CONFIG }); }
    catch (err) { scheduleFriendPeerRestart(); return; }
    const current = friendPeer;
    current.on("open", () => { if (friendPeer !== current) return; clearTimeout(friendReconnectTimer); friendReconnectTimer = null; friendRetries = 0; $("friendNote").textContent = "En línea. Tus amigos te ven mientras esta página esté abierta."; friendReady.splice(0).forEach(fn => fn()); pingAll() });
    current.on("connection", c => {
      c.on("data", d => {
        if (!d) return;
        if (d.type === "hello") {
          c.send({ type: "hello", name: myName, code: myCode, elo: getPlayerElo(myName), playing: isPlayingOnline(), fen: game.fen(), pgn: game.pgn({ max_width: 60, newline_char: "\n" }) });
          if (/^[A-Z0-9]{8}$/.test(String(d.code)) && d.code !== myCode) {
            const code = String(d.code), nm = String(d.name || code).slice(0, 16);
            let f = friends.find(x => x.code === code);
            if (!f) { f = { code, name: nm, ack: true }; friends.push(f) } else { f.name = nm; f.ack = true }
            presence[code] = true; playing[code] = d.playing === true;
            if (d.fen) updateLiveMatch({ code, name: nm, opponent: normalizeName(activeOpponentName || "Rival"), fen: d.fen, pgn: d.pgn, playing: d.playing === true });
            saveFriends(); renderFriends(); c.send({ type: "friendAck" });
          }
        }
        else if (d.type === "friend" && /^[A-Z0-9]{8}$/.test(String(d.code)) && d.code !== myCode) {
          const nm = String(d.name || d.code).slice(0, 16);
          let f = friends.find(x => x.code === d.code);
          if (!f) { f = { code: d.code, name: nm, ack: true }; friends.push(f); showToast(nm + " te añadió como amigo") }
          else { f.name = nm; f.ack = true }
          if (typeof d.elo === "number") setPlayerElo(nm, d.elo);
          presence[d.code] = true; playing[d.code] = d.playing === true;
          saveFriends(); renderFriends();
          c.send({ type: "friendAck" });
        }
        else if (d.type === "invite" && /^[A-Z0-9]{6}$/.test(String(d.room))) showInvite(d, c);
        else if (d.type === "liveGame") { updateLiveMatch(d); c.send({ type: "liveGame", code: myCode, name: myName, opponent: normalizeName(activeOpponentName || "Rival"), fen: game.fen(), pgn: game.pgn({ max_width: 60, newline_char: "\n" }), playing: isPlayingOnline(), result: getResult() ? { w: getResult().w, why: getResult().why } : null, moveCount: game.history().length, tc: ($("tcSelect") && $("tcSelect").value) || ($("localTcSelect") && $("localTcSelect").value) || "600+0" }); }
      });
    });
    current.on("disconnected", () => {
      if (friendPeer !== current) return;
      $("friendNote").textContent = "Recuperando conexión con el servicio de amigos…";
      clearTimeout(friendReconnectTimer);
      try { current.reconnect() } catch (_) { }
      // PeerJS reconnect can remain pending without throwing; replace the peer if it never reopens.
      friendReconnectTimer = setTimeout(() => { if (friendPeer === current && !current.open) restartFriendPeer(); }, 7000);
    });
    current.on("error", err => {
      if (friendPeer !== current) return;
      if (err.type === "peer-unavailable") { /* A single failed probe is not proof that the peer is offline. */ }
      else if (err.type === "unavailable-id") {
        if (friendRetries++ < 6) { try { current.destroy() } catch (_) { } friendPeer = null; setTimeout(startFriendPeer, 900 * friendRetries); }
        else $("friendNote").textContent = "Tu ID ya está en uso en otra pestaña o ventana del mismo navegador; ciérrala para aparecer en línea.";
      }
      else { $("friendNote").textContent = "Recuperando conexión con el servicio de amigos…"; scheduleFriendPeerRestart(); }
    });
  }
  function scheduleFriendPeerRestart() {
    clearTimeout(friendReconnectTimer);
    if (friendRetries++ >= 8) { $("friendNote").textContent = "No se pudo recuperar la conexión. Actualiza la página para volver a intentarlo."; return; }
    friendReconnectTimer = setTimeout(restartFriendPeer, Math.min(friendRetries * 1000, 8000));
  }
  function restartFriendPeer() {
    clearTimeout(friendReconnectTimer); friendReconnectTimer = null;
    const old = friendPeer; friendPeer = null;
    try { if (old && !old.destroyed) old.destroy(); } catch (_) { }
    startFriendPeer();
  }
  function releaseFriendServices() {
    clearTimeout(friendReconnectTimer); clearTimeout(nameReconnectTimer);
    const oldFriendPeer = friendPeer, oldNamePeer = namePeer;
    friendPeer = null; namePeer = null;
    try { if (oldFriendPeer && !oldFriendPeer.destroyed) oldFriendPeer.destroy(); } catch (_) { }
    try { if (oldNamePeer && !oldNamePeer.destroyed) oldNamePeer.destroy(); } catch (_) { }
  }
  if (peerChannel) peerChannel.onmessage = event => {
    if (event.data && event.data.type === "claim" && event.data.owner !== peerTabId) {
      clearTimeout(friendStartTimer);
      releaseFriendServices();
    }
  };
  function claimFriendServices() {
    clearTimeout(friendStartTimer);
    if (peerChannel) peerChannel.postMessage({ type: "claim", owner: peerTabId });
    friendStartTimer = setTimeout(() => { startFriendPeer(); startNamePeer(); pingAll(); }, 900);
  }
  function startNamePeer() {
    if (typeof Peer === "undefined") return;
    clearTimeout(nameReconnectTimer); nameReconnectTimer = null;
    if (namePeer) { try { namePeer.destroy(); } catch (_) { } namePeer = null; }
    try { namePeer = new Peer(NAME_FID(myName), { config: RTC_CONFIG }); }
    catch (_) { scheduleNamePeerRestart(); return; }
    const current = namePeer;
    current.on("connection", c => {
      c.on("data", d => {
        if (d && d.type === "nameLookup")
          c.send({ type: "nameResult", name: myName, code: myCode, elo: getPlayerElo(myName), playing: isPlayingOnline() });
      });
    });
    current.on("error", err => {
      if (namePeer !== current) return;
      if (err.type === "unavailable-id") {
        if (nameRetries++ < 6) { try { current.destroy() } catch (_) { } namePeer = null; nameReconnectTimer = setTimeout(startNamePeer, 1200 * nameRetries); }
        else $("friendNote").textContent = "Ese nombre ya está en uso. La búsqueda por nombre requiere nombres únicos; usa el código de amigo.";
      }
      else scheduleNamePeerRestart();
    });
    current.on("open", () => { if (namePeer === current) { clearTimeout(nameReconnectTimer); nameReconnectTimer = null; nameRetries = 0; } });
    current.on("disconnected", () => {
      if (namePeer !== current) return;
      try { current.reconnect(); } catch (_) { }
      nameReconnectTimer = setTimeout(() => { if (namePeer === current && !current.open) { try { current.destroy(); } catch (_) { } namePeer = null; scheduleNamePeerRestart(); } }, 7000);
    });
  }
  function scheduleNamePeerRestart() {
    clearTimeout(nameReconnectTimer);
    if (nameRetries++ >= 8) return;
    nameReconnectTimer = setTimeout(startNamePeer, Math.min(nameRetries * 1200, 9000));
  }
  $("nameInput").value = myName;
  setPlayerAvatar($("profileAvatar"), myName, "w");
  $("exportEloBtn").onclick = exportEloProgress;
  $("importEloBtn").onclick = () => $("importEloFile").click();
  $("importEloFile").onchange = event => importEloProgress(event.target.files && event.target.files[0]);
  $("nameInput").onchange = () => { myName = $("nameInput").value.trim().slice(0, 16) || myName; $("nameInput").value = myName; LS("aj_name", myName); setPlayerAvatar($("profileAvatar"), myName, "w"); startNamePeer(); render(); pingAll() };
  $("myCode").value = myCode;
  $("refreshFriends").onclick = () => pingAll();
  $("copyCodeBtn").onclick = () => navigator.clipboard.writeText(myCode).then(() => showToast("Código copiado"));
  $("findFriendBtn").onclick = findFriendByName;
  $("friendNameInput").onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); findFriendByName() } };
  $("addFriendBtn").onclick = () => {
    const c = $("friendInput").value.trim().toUpperCase().replace(/^AJEDREZ-U/, "");
    if (!/^[A-Z0-9]{8}$/.test(c)) { showToast("El código de amigo tiene 8 caracteres"); return }
    if (c === myCode) { showToast("Ese es tu propio código"); return }
    if (friends.some(f => f.code === c)) { showToast("Ya está en tu lista"); return }
    const f = { code: c, name: c, ack: false }; friends.push(f); saveFriends(); $("friendInput").value = ""; renderFriends();
    if (!friendPeer || !friendPeer.open) showToast("Conectando con el servicio de amigos…");
    else { showToast("Buscando a tu amigo…"); ping(f) }
  };
  $("friendInput").onkeydown = event => { if (event.key === "Enter") $("addFriendBtn").click() };
  setInterval(() => { if (!document.hidden || isPlayingOnline()) pingAll() }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) claimFriendServices();
  });
  window.addEventListener("focus", () => { if (!document.hidden) claimFriendServices(); });
  window.addEventListener("beforeunload", () => { clearTimeout(friendStartTimer); releaseFriendServices(); if (peerChannel) peerChannel.close(); try { warmPeer && warmPeer.peer.destroy() } catch (_) { } });
  if (PAGE === "online") prepareWarmPeer();
  renderFriends(); claimFriendServices();
  // Salir de una partida online en curso pide confirmación (al cambiar de página se perdería la conexión)
  window.addEventListener("beforeunload", e => { if (PAGE === "partida" && online() && game.history().length && !game.game_over()) { e.preventDefault(); e.returnValue = "" } });

  /* ---------- Chat ---------- */
  function addMsg(kind, text) {
    const log = $("chatLog"), d = document.createElement("div");
    d.className = "msg " + kind;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }
  function hideOpponentChatBubble() {
    clearTimeout(opponentChatBubbleTimer);
    $("topChatBubble").hidden = true;
    $("bottomChatBubble").hidden = true;
  }
  function showOpponentChatBubble(text) {
    const topColor = flipped ? "w" : "b";
    const bubble = $(topColor === myColor ? "bottomChatBubble" : "topChatBubble");
    hideOpponentChatBubble();
    bubble.textContent = text;
    bubble.hidden = false;
    opponentChatBubbleTimer = setTimeout(() => { bubble.hidden = true }, 5000);
  }
  function sendChat() {
    const text = $("chatInput").value.trim();
    if (!text) return;
    sendPayload({ type: "chat", text });
    addMsg("me", text);
    $("chatInput").value = "";
  }
  $("chatSend").onclick = sendChat;
  $("chatInput").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); sendChat() } };

  render();

  if (PAGE === "partida") {
    const q = new URLSearchParams(location.search), mode = q.get("mode"), qTc = q.get("tc");
    const tc = TC_RE.test(qTc || "") ? qTc : "600+0";
    if (mode === "bot") startBotGame({ elo: q.get("elo"), side: ["w", "b", "r"].includes(q.get("side")) ? q.get("side") : "r" });
    else if (mode === "host") {
      hostOpts.color = ["w", "b", "r"].includes(q.get("color")) ? q.get("color") : "r";
      window.__challengeHandicapValue = normalizeHandicapValue(q.get("handicap"));
      const inv = /^[A-Z0-9]{8}$/.test(q.get("invite") || "") ? q.get("invite") : null;
      if (inv) runChallenge(friends.find(x => x.code === inv) || { code: inv, name: q.get("iname") || inv }, tc, hostOpts.color, window.__challengeHandicapValue);
      else {
        parseTC(tc);
        initPeerJS(null, code => setBoardLoading(true, { title: "Sala " + code, sub: "Comparte el código o el enlace con tu rival", code, persist: true }));
      }
    } else if (mode === "join" && /^[A-Z0-9]{6}$/i.test(q.get("room") || "")) {
      bootJoining = true;
      setBoardLoading(true, { title: "Conectando…", sub: "Entrando en la sala", persist: true });
      initPeerJS(q.get("room"));
    } else startLocalGame(tc);
    if (q.get("settings")) openSettings();
  }
})();
