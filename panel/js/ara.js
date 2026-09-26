// Stremio'ya girmeden oda açma: film/dizi ara, afişten seç, kaynak listesine geç.
import { api, el, $ } from './api.js';

const gorunur = (id, acik) => { $(id).hidden = !acik; };

function kart(sonuc, tiklama) {
  return el('button', { type: 'button', class: 'poster-kart', onclick: tiklama },
    sonuc.poster
      ? el('img', { src: sonuc.poster, alt: '', loading: 'lazy' })
      : el('div', { class: 'poster-yok', text: '🎞' }),
    el('span', { class: 'poster-ad', text: sonuc.name }),
    sonuc.year ? el('span', { class: 'poster-yil muted small', text: sonuc.year }) : null);
}

const odayaGit = (type, id) => { location.href = `/new?type=${type}&id=${encodeURIComponent(id)}`; };

async function bolumleriAc(dizi) {
  gorunur('#filmler-kart', false);
  gorunur('#diziler-kart', false);
  gorunur('#bolumler-kart', true);
  $('#bolumler-baslik').textContent = dizi.name;
  $('#bolumler').replaceChildren(el('p', { class: 'muted', text: 'Bölümler yükleniyor…' }));
  const bolumler = await api(`/api/series/${encodeURIComponent(dizi.id)}/episodes`);
  // Bölüm listesi gelmezse dizinin kendi id'siyle devam: /new yine kaynak listeler.
  if (!bolumler.length) return odayaGit('series', dizi.id);
  const sezonlar = new Map();
  for (const b of bolumler) {
    if (!sezonlar.has(b.season)) sezonlar.set(b.season, []);
    sezonlar.get(b.season).push(b);
  }
  $('#bolumler').replaceChildren(...[...sezonlar].flatMap(([sezon, liste]) => [
    el('h3', { text: `Sezon ${sezon}` }),
    el('div', { class: 'bolum-satir' }, ...liste.map((b) => el('button', {
      type: 'button',
      text: `${b.episode}. ${b.name}`,
      onclick: () => odayaGit('series', `${dizi.id}:${b.season}:${b.episode}`),
    }))),
  ]));
}

async function ara() {
  const q = $('#ara-input').value.trim();
  gorunur('#bolumler-kart', false);
  if (!q) {
    $('#ara-durum').textContent = 'Aramak için yaz.';
    gorunur('#filmler-kart', false);
    gorunur('#diziler-kart', false);
    return;
  }
  $('#ara-durum').textContent = 'Aranıyor…';
  const sonuclar = await api(`/api/search?q=${encodeURIComponent(q)}`);
  const filmler = sonuclar.filter((s) => s.type === 'movie');
  const diziler = sonuclar.filter((s) => s.type === 'series');
  $('#ara-durum').textContent = sonuclar.length ? `${filmler.length} film, ${diziler.length} dizi` : 'Sonuç yok.';
  $('#filmler').replaceChildren(...filmler.map((s) => kart(s, () => odayaGit('movie', s.id))));
  $('#diziler').replaceChildren(...diziler.map((s) => kart(s, () => bolumleriAc(s))));
  gorunur('#filmler-kart', filmler.length > 0);
  gorunur('#diziler-kart', diziler.length > 0);
}

$('#ara-btn').addEventListener('click', ara);
$('#ara-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') ara(); });
$('#bolum-geri').addEventListener('click', ara);
