export const $ = (sel, root = document) => root.querySelector(sel);

// Tiny DOM builder. Text is always set through textContent (never innerHTML).
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

let toastTimer = null;
export function toast(message, ms = 3000) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, ms);
}

export const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  },
};

export function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt('Linki kopyala:', text);
    return false;
  }
}

export const ERROR_TEXT = {
  locked: 'Oynatmayı sadece host kontrol edebiliyor.',
  notHost: 'Bunu sadece host yapabilir.',
  rate: 'Çok hızlı gidiyorsun, biraz yavaşla.',
  tooLong: 'Mesaj çok uzun.',
  timeout: 'Sunucu cevap vermedi.',
  badStream: 'Bu stream seçilemiyor.',
  relayFull: 'Relay dolu, host kişi sınırını artırmalı.',
  relayOff: 'Host relay\'i kapatmış.',
};
export const errorText = (code) => ERROR_TEXT[code] || `Hata: ${code}`;
