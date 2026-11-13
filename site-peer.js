/* Lightweight friend identity and invitation receiver for non-game pages. */
(() => {
  if (typeof Peer === "undefined" || !window.AJ) return;
  const get = key => { try { return localStorage.getItem(key) } catch (_) { return null } };
  const set = (key, value) => { try { localStorage.setItem(key, value) } catch (_) { } };
  const myCode = window.AJ.profile.code;
  const name = () => window.AJ.profile.name;
  const fid = "AJEDREZ-U" + myCode;
  const nameId = () => window.AJ.namePeerId(name());
  const rtcConfig = { config: { iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "turn:openrelay.metered.ca:80", username: "openrelay", credential: "openrelay" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelay", credential: "openrelay" }
  ] } };
  let peer = null, namePeer = null, retries = 0, nameRetries = 0, inviteCard = null, peerStartTimer = null, nameStartTimer = null, nameReconnectTimer = null;
  const peerTabId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const peerChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("aj-peer-owner-" + myCode) : null;
  const saveFriend = (code, playerName) => {
    if (!/^[A-Z0-9]{8}$/.test(code) || code === myCode) return;
    let list = [];
    try { list = JSON.parse(get("aj_friends") || "[]") } catch (_) { }
    const found = list.find(friend => friend.code === code);
    if (found) { if (playerName) found.name = String(playerName).slice(0, 16); found.ack = true; }
    else list.push({ code, name: String(playerName || code).slice(0, 16), ack: true });
    set("aj_friends", JSON.stringify(list));
  };
  function showInvite(data, connection) {
    if (inviteCard) inviteCard.remove();
    const card = inviteCard = document.createElement("section");
    card.className = "site-invite";
    const title = document.createElement("strong");
    title.textContent = "Invitación de " + String(data.name || "un amigo").slice(0, 16);
    const detail = document.createElement("span");
    detail.textContent = "Te ha invitado a una partida online.";
    const actions = document.createElement("div"); actions.className = "site-invite-actions";
    const accept = document.createElement("button"); accept.className = "btn"; accept.textContent = "Jugar";
    const decline = document.createElement("button"); decline.className = "btn ghost"; decline.textContent = "Ahora no";
    accept.onclick = () => { location.href = "partida.html?mode=join&room=" + encodeURIComponent(data.room); };
    decline.onclick = () => { try { connection.send({ type: "declined" }) } catch (_) { } card.remove(); inviteCard = null; };
    actions.append(accept, decline); card.append(title, detail, actions); document.body.appendChild(card);
  }
  function start() {
    if (peer || typeof Peer === "undefined") return;
    try { peer = new Peer(fid, rtcConfig); } catch (_) { retry(); return; }
    const current = peer;
    current.on("open", () => { if (peer === current) retries = 0; });
    current.on("connection", connection => {
      connection.on("data", data => {
        if (!data || typeof data !== "object") return;
        if (data.type === "nameLookup") {
          connection.send({ type: "nameResult", name: name(), code: myCode, playing: false });
        } else if (data.type === "hello") {
          const code = String(data.code || "");
          saveFriend(code, data.name);
          connection.send({ type: "hello", name: name(), code: myCode, playing: false });
        } else if (data.type === "friend") {
          saveFriend(String(data.code || ""), data.name);
          connection.send({ type: "friendAck" });
        } else if (data.type === "invite" && /^[A-Z0-9]{6}$/.test(String(data.room || ""))) {
          showInvite(data, connection);
        }
      });
    });
    current.on("disconnected", () => {
      if (peer !== current) return;
      try { current.reconnect(); } catch (_) { peer = null; retry(); }
      setTimeout(() => { if (peer === current && current.disconnected) { try { current.destroy(); } catch (_) { } peer = null; retry(); } }, 8000);
    });
    current.on("error", error => {
      if (error && error.type === "unavailable-id" && peer === current) {
        try { current.destroy(); } catch (_) { }
        peer = null; retry();
      }
    });
    current.on("close", () => { if (peer === current) { peer = null; retry(); } });
  }
  function retry() {
    if (retries++ < 8) setTimeout(start, Math.min(retries * 1000, 8000));
  }
  function startNamePeer() {
    if (namePeer || typeof Peer === "undefined") return;
    let current;
    try { current = new Peer(nameId(), rtcConfig); namePeer = current; } catch (_) { retryName(); return; }
    current.on("connection", connection => connection.on("data", data => {
      if (data && data.type === "nameLookup") connection.send({ type: "nameResult", name: name(), code: myCode, playing: false });
    }));
    current.on("open", () => { if (namePeer === current) { clearTimeout(nameReconnectTimer); nameReconnectTimer = null; nameRetries = 0; } });
    current.on("error", error => {
      if (namePeer !== current) return;
      if (error && error.type === "unavailable-id") restartNamePeer();
      else scheduleNamePeerRestart();
    });
    current.on("close", () => { if (namePeer === current) { namePeer = null; retryName(); } });
    current.on("disconnected", () => {
      if (namePeer !== current) return;
      try { current.reconnect(); } catch (_) { try { current.destroy(); } catch (_) { } namePeer = null; retryName(); }
      clearTimeout(nameReconnectTimer);
      nameReconnectTimer = setTimeout(() => { if (namePeer === current && !current.open) restartNamePeer(); }, 7000);
    });
  }
  function restartNamePeer() {
    clearTimeout(nameReconnectTimer); nameReconnectTimer = null;
    const old = namePeer; namePeer = null;
    try { if (old && !old.destroyed) old.destroy(); } catch (_) { }
    retryName();
  }
  function scheduleNamePeerRestart() {
    clearTimeout(nameReconnectTimer);
    nameReconnectTimer = setTimeout(restartNamePeer, 2500);
  }
  function retryName() {
    clearTimeout(nameStartTimer);
    if (nameRetries++ < 8) nameStartTimer = setTimeout(startNamePeer, Math.min(nameRetries * 1200, 9000));
  }
  window.refreshSitePeerName = () => {
    const old = namePeer;
    namePeer = null; nameRetries = 0;
    try { if (old) old.destroy(); } catch (_) { }
    startNamePeer();
  };
  function releasePeers() {
    clearTimeout(nameReconnectTimer);
    clearTimeout(nameStartTimer);
    const oldPeer = peer, oldNamePeer = namePeer;
    peer = null; namePeer = null;
    try { if (oldPeer && !oldPeer.destroyed) oldPeer.destroy(); } catch (_) { }
    try { if (oldNamePeer && !oldNamePeer.destroyed) oldNamePeer.destroy(); } catch (_) { }
  }
  if (peerChannel) peerChannel.onmessage = event => {
    if (event.data && event.data.type === "claim" && event.data.owner !== peerTabId) {
      clearTimeout(peerStartTimer); clearTimeout(nameStartTimer); clearTimeout(nameReconnectTimer);
      releasePeers();
    }
  };
  function claimPeers() {
    clearTimeout(peerStartTimer); clearTimeout(nameStartTimer);
    if (peerChannel) peerChannel.postMessage({ type: "claim", owner: peerTabId });
    peerStartTimer = setTimeout(start, 900); nameStartTimer = setTimeout(startNamePeer, 1200);
  }
  window.addEventListener("beforeunload", () => { clearTimeout(peerStartTimer); clearTimeout(nameStartTimer); releasePeers(); if (peerChannel) peerChannel.close(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) claimPeers();
  });
  window.addEventListener("focus", () => { if (!document.hidden) claimPeers(); });
  if (!document.hidden) claimPeers();
})();
