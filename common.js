/* Utilidades compartidas por todas las páginas (inicio, bot, local, online y partida).
   Va en el <head>, sin defer, para que el tema se aplique antes de pintar nada. */
(function () {
  const get = k => { try { return localStorage.getItem(k) } catch (_) { return null } };
  const set = (k, v) => { try { localStorage.setItem(k, v) } catch (_) { } };

  /* ---------- Temas (única fuente de verdad: script.js los lee de aquí) ---------- */
  const UI_THEMES = {
    dark: { id: "dark", name: "Oscuro", bg: "#211f1c", card: "#2b2926", line: "#3a3732", text: "#bab7b1", bright: "#ffffff", muted: "#8a867e" },
    light: { id: "light", name: "Claro", bg: "#edf1f4", card: "#ffffff", line: "#d4dbe5", text: "#3a4758", bright: "#101827", muted: "#667085" }
  };
  const ACCENTS = {
    verde: { id: "verde", name: "Verde", dark: "#81b64c", light: "#5fb76b", accent: "#a3d160" },
    azul: { id: "azul", name: "Azul", dark: "#3b82f6", light: "#2563eb", accent: "#93c5fd" },
    rojo: { id: "rojo", name: "Rojo", dark: "#ef4444", light: "#dc2626", accent: "#fca5a5" },
    morado: { id: "morado", name: "Morado", dark: "#8b5cf6", light: "#7c3aed", accent: "#c4b5fd" },
    naranja: { id: "naranja", name: "Naranja", dark: "#f59e0b", light: "#ea580c", accent: "#fdba74" },
    rosa: { id: "rosa", name: "Rosa", dark: "#ec4899", light: "#db2777", accent: "#f9a8d4" },
    cian: { id: "cian", name: "Cian", dark: "#06b6d4", light: "#0891b2", accent: "#67e8f9" },
    amarillo: { id: "amarillo", name: "Amarillo", dark: "#eab308", light: "#ca8a04", accent: "#fef08a" }
  };

  // Color de texto legible sobre el acento elegido (claro u oscuro según su luminosidad)
  function onColor(hex) {
    const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#1d1b18" : "#ffffff";
  }

  function applyTheme() {
    const id = /^(dark|light)$/.test(get("ajedrez.uiTheme") || "") ? get("ajedrez.uiTheme") : "dark";
    const acc = ACCENTS[get("ajedrez.accent") || ""] || ACCENTS.verde;
    const t = UI_THEMES[id], strong = id === "light" ? acc.light : acc.dark;
    const r = document.documentElement.style;
    r.setProperty("--bg", t.bg); r.setProperty("--card", t.card); r.setProperty("--line", t.line);
    r.setProperty("--text", t.text); r.setProperty("--bright", t.bright); r.setProperty("--muted", t.muted);
    r.setProperty("--green", strong); r.setProperty("--green2", acc.accent);
    r.setProperty("--accent", strong); r.setProperty("--accent-soft", acc.accent);
    r.setProperty("--on-accent", onColor(strong));
    document.documentElement.dataset.theme = id;
  }
  applyTheme();

  /* ---------- Enlaces antiguos: index.html#room=ABC123 ahora entra por la página de partida ---------- */
  const legacy = /room=([A-Za-z0-9]{6})/.exec(location.hash);
  if (legacy && !/partida\.html$/.test(location.pathname)) {
    location.replace("partida.html?mode=join&room=" + legacy[1].toUpperCase());
  }

  /* ---------- Perfil (mismas claves que usa script.js) ---------- */
  const rnd = n => Array.from({ length: n }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.random() * 32 | 0]).join("");
  const profile = {
    get name() {
      let n = get("aj_name");
      if (!n) { n = "Jugador" + rnd(3); set("aj_name", n); }
      return n;
    },
    set name(v) { set("aj_name", String(v).trim().replace(/\s+/g, " ").slice(0, 16) || this.name); },
    get code() {
      let c = get("aj_code");
      if (!c) { c = rnd(8); set("aj_code", c); }
      return c;
    }
  };

  function namePeerId(value) {
    const normalized = String(value || "").trim().replace(/\s+/g, " ").slice(0, 16).normalize("NFKC").toLowerCase();
    let hashA = 2166136261, hashB = 2246822519;
    for (let i = 0; i < normalized.length; i++) {
      const code = normalized.charCodeAt(i);
      hashA = Math.imul(hashA ^ code, 16777619) >>> 0;
      hashB = Math.imul(hashB ^ code, 3266489917) >>> 0;
    }
    return "AJEDREZ-N" + hashA.toString(16).padStart(8, "0") + hashB.toString(16).padStart(8, "0");
  }

  /* ---------- Avatares y piezas ---------- */
  const knightFallback = fill => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="' + fill + '"/>' +
    '<text x="50%" y="72%" text-anchor="middle" font-size="40" fill="#fff">♞</text></svg>');
  function avatarUrl(seed, isBot) {
    const key = String(seed || "bot").trim().replace(/\s+/g, " ").slice(0, 16).toLowerCase();
    return "https://api.dicebear.com/10.x/" + (isBot ? "avataaars" : "marbles") + "/svg?seed=" + encodeURIComponent(key);
  }
  function setAvatar(img, name, isBot, seed) {
    img.alt = name || "";
    img.onerror = () => { img.onerror = null; img.src = knightFallback(isBot ? "#8f6bff" : "#779556"); };
    img.src = avatarUrl(seed || name, isBot);
  }
  function pieceUrl(color, type) {
    let set_ = get("ajedrez.pieces") || "neo";
    if (!/^[a-z0-9_]+$/.test(set_) || /^blind_/.test(set_)) set_ = "neo";
    return "https://images.chesscomfiles.com/chess-themes/pieces/" + set_ + "/150/" + color + type + ".png";
  }
  // Pone una pieza (con las piezas que el jugador tenga elegidas) en un <img>; si no carga, usa el símbolo
  function setPiece(img, color, type) {
    const glyph = { w: { n: "♘", k: "♔", q: "♕", r: "♖", b: "♗", p: "♙" }, b: { n: "♞", k: "♚", q: "♛", r: "♜", b: "♝", p: "♟" } }[color][type];
    img.alt = "";
    img.onerror = () => {
      const s = document.createElement("span");
      s.className = img.className + " glyph"; s.textContent = glyph; s.setAttribute("aria-hidden", "true");
      img.replaceWith(s);
    };
    img.src = pieceUrl(color, type);
  }

  /* ---------- Aviso breve ---------- */
  function toast(msg) {
    let t = document.getElementById("toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
    t.textContent = msg; t.style.display = "block";
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.style.display = "none" }, 2400);
  }

  /* ---------- Fichas flotando de fondo (solo decoración) ---------- */
  function floaters() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const box = document.createElement("div"); box.className = "floaters"; box.setAttribute("aria-hidden", "true");
    const glyphs = ["♞", "♟", "♜", "♝", "♛", "♚", "♘", "♙"];
    for (let i = 0; i < 9; i++) {
      const s = document.createElement("span");
      s.textContent = glyphs[i % glyphs.length];
      s.style.cssText = "left:" + (4 + i * 11 + (i % 3) * 2) + "%;font-size:" + (34 + (i * 17) % 46) + "px;animation-duration:" + (22 + (i * 7) % 18) + "s;animation-delay:-" + (i * 3.3) + "s";
      box.appendChild(s);
    }
    document.body.prepend(box);
  }
  document.addEventListener("DOMContentLoaded", () => { if (document.body.classList.contains("menu")) floaters(); });

  window.AJ = { UI_THEMES, ACCENTS, get, set, profile, namePeerId, avatarUrl, setAvatar, pieceUrl, setPiece, toast, applyTheme, rnd };
})();
