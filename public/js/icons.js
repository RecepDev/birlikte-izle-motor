// Oynatıcı kontrol simgeleri (Stremio'daki gibi ince çizgili). Emoji her sistemde
// farklı ve renkli çiziliyordu; SVG her yerde aynı ve yazı rengini alıyor.
const P = {
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4.5h3.2v15H7zM13.8 4.5H17v15h-3.2z" fill="currentColor" stroke="none"/>',
  next: '<path d="M6 5l10 7-10 7z"/><path d="M18 5v14"/>',
  prev: '<path d="M18 5L8 12l10 7z"/><path d="M6 5v14"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  vol0: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/>',
  vol1: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/>',
  vol2: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/><path d="M18 7a7 7 0 0 1 0 10"/>',
  info: '<path d="M5 19v-3M9.5 19v-6.5M14 19v-10M18.5 19V5"/>',
  audio: '<path d="M4 10v4M7.5 7v10M11 4v16M14.5 8v8M18 6v12M21 10v4"/>',
  subs: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 11h4M13 11h4M7 15h7M16 15h1"/>',
  chat: '<path d="M4 5.5h16v10H10l-4.5 4v-4H4z"/>',
  react: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14a4 4 0 0 0 7 0"/><path d="M9.2 9.8h.01M14.8 9.8h.01" stroke-width="2.4"/>',
  episodes: '<rect x="3" y="8" width="14" height="12" rx="2"/><path d="M7 5h12a2 2 0 0 1 2 2v9"/>',
  fs: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  fsExit: '<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
  compat: '<path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.4-.6-.6-2.4z"/>',
};

export function icon(name) {
  return `<svg class="ic" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

// Aynı simge tekrar yazılmasın (her timeupdate'te çağrılıyor).
export function setIcon(button, name) {
  if (!button || button.dataset.ic === name) return;
  button.dataset.ic = name;
  button.innerHTML = icon(name);
}
