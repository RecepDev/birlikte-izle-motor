// Afiş kartı: film/dizi detay ekranına (/detay) gider.
import { el } from './api.js';

export const afisYok = () => el('div', { class: 'poster-yok', text: '🎞' });

export function adres(m) {
  return `/detay?${new URLSearchParams({ type: m.type === 'series' ? 'series' : 'movie', id: m.id })}`;
}

export function afisKart(m, { alt = m.year, rozet = null } = {}) {
  return el('a', {
    class: 'afis', href: adres(m), title: m.name,
    'data-type': m.type === 'series' ? 'series' : 'movie', 'data-id': String(m.id).split(':')[0], 'data-ad': m.name || '', 'data-poster': m.poster || '', 'data-yil': m.year || '',
  },
    el('div', { class: 'afis-gorsel' },
      m.poster
        ? el('img', { src: m.poster, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(afisYok()) })
        : afisYok(),
      rozet ? el('span', { class: 'afis-rozet', text: rozet }) : null),
    el('span', { class: 'afis-ad', text: m.name }),
    alt ? el('span', { class: 'afis-alt', text: alt }) : null);
}
