// Stremio'ya girmeden oda açma: film/dizi ara, afişten seç, kaynak listesine geç.
import { api, el, $ } from './api.js';

const gorunur = (id, acik) => { $(id).hidden = !acik; };

function kart(sonuc, tiklama, alt = sonuc.year) {
  return el('button', { type: 'button', class: 'poster-kart', onclick: tiklama },
    sonuc.poster
      ? el('img', { src: sonuc.poster, alt: '', loading: 'lazy' })
      : el('div', { class: 'poster-yok', text: '🎞' }),
    el('span', { class: 'poster-ad', text: sonuc.name }),
    alt ? el('span', { class: 'poster-yil muted small', text: alt }) : null);
}

const odayaGit = (type, id) => { location.href = `/new?type=${type}&id=${encodeURIComponent(id)}`; };

async function bolumleriAc(dizi) {
  gorunur('#filmler-kart', false);
  gorunur('#diziler-kart', false);
  gorunur('#gecmis-kart', false);
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
  // En son açılan bölüm vurgulu; açılmış bölümlerde "izlendi" işareti.
  // Aramadan açılan dizide de geçmişteki son bölümü kullan.
  const son = dizi.last || gecmisKayitlari.find((k) => k.type === 'series' && k.id === dizi.id)?.last || null;
  let sonSatir = null;
  $('#bolumler').replaceChildren(...[...sezonlar].flatMap(([sezon, liste]) => [
    el('h3', { text: `Sezon ${sezon}` }),
    el('div', { class: 'bolum-satir' }, ...liste.map((b) => {
      const anahtar = `${b.season}:${b.episode}`;
      const satir = el('button', {
        type: 'button',
        class: [b.watched ? 'izlendi' : '', anahtar === son ? 'son' : ''].filter(Boolean).join(' '),
        onclick: () => odayaGit('series', `${dizi.id}:${b.season}:${b.episode}`),
      },
      el('span', { text: `${b.episode}. ${b.name}` }),
      b.watched ? el('span', { class: 'izlendi-etiket', text: anahtar === son ? '▶ en son' : '✓ izlendi' }) : null);
      if (anahtar === son) sonSatir = satir;
      return satir;
    })),
  ]));
  // Kaldığın yere kaydır.
  sonSatir?.scrollIntoView({ block: 'center' });
}

async function ara() {
  const q = $('#ara-input').value.trim();
  gorunur('#bolumler-kart', false);
  if (!q) {
    $('#ara-durum').textContent = 'Aramak için yaz.';
    gorunur('#filmler-kart', false);
    gorunur('#diziler-kart', false);
    gecmisiGoster();
    return;
  }
  gorunur('#gecmis-kart', false);
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

// Daha önce oda açılanlar: aramanın üstünde. Dizide bölüm listesi, kaldığın bölüm işaretli.
let gecmisKayitlari = [];
async function gecmisiGoster() {
  const liste = await api('/api/gecmis').catch(() => []);
  gecmisKayitlari = liste;
  gorunur('#gecmis-kart', liste.length > 0 && !$('#ara-input').value.trim());
  $('#gecmis').replaceChildren(...liste.map((k) => kart(
    k,
    () => (k.type === 'series' ? bolumleriAc(k) : odayaGit('movie', k.id)),
    k.type === 'series'
      ? `📺 ${k.watched.length} bölüm${k.last ? ` · son S${k.last.split(':')[0]}E${k.last.split(':')[1]}` : ''}`
      : '🎬 film',
  )));
}
gecmisiGoster();

$('#ara-btn').addEventListener('click', ara);
$('#ara-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') ara(); });
$('#bolum-geri').addEventListener('click', ara);
