// Temalı sağ tık menüsü (ana ekran afişleri ve detay sayfasındaki bölümler ortak kullanır).
import { el } from './api.js';

let menu = null;

export function menuKapat() {
  menu?.remove();
  menu = null;
}

export const menuAcik = () => menu !== null;

export const menuBaslik = (metin) => el('div', { class: 'sagtik-baslik', text: metin });
export const menuAyrac = () => el('div', { class: 'sagtik-ayrac' });
export const menuOge = (metin, fn) => el('button', {
  type: 'button', class: 'sagtik-oge', role: 'menuitem', onclick: async () => { menuKapat(); await fn(); },
}, metin);

export function menuAc(x, y, ogeler) {
  menuKapat();
  menu = el('div', { class: 'sagtik-menu', role: 'menu' }, ...ogeler);
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
}

// Menü öğesine basınca öğe kaldırılıp (yeni menü açılabilir) olay yukarı çıkıyor: kaldırılmış öğeden gelen tıklama
// yeni açılan menüyü kapatmasın ("İndirme seçenekleri…" bu yüzden hiçbir şey yapmıyordu).
document.addEventListener('click', (e) => { if (menu && e.target.isConnected && !menu.contains(e.target)) menuKapat(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menuKapat(); });
window.addEventListener('blur', menuKapat);
