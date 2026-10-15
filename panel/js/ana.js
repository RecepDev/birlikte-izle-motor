import { api, el, $ } from './api.js';
import { afisKart, adres } from './afis.js';
import { izlendiMi, kutHazir } from './kutuphane.js';
import { izlendiHazir } from './izlendi.js';
import { oynaIkon } from './oyna-stil.js';

function satir(baslik, kartlar, { tumu = null, sag = null } = {}) {
  const kutu = el('div', { class: 'afis-serit' }, ...kartlar);
  return {
    kutu,
    bolum: el('section', { class: 'satir' },
      el('div', { class: 'satir-baslik' },
        el('h2', { text: baslik }),
        tumu ? el('a', { class: 'tumu', href: tumu }, 'Tümü ›') : null,
        sag),
      kutu),
  };
}

// Oynat düğmesi: en son açılan kaynakla odayı doğrudan açar. Kayıtlı kaynak yoksa içeriğin sayfasına gider.
// Düğmenin dışına (afişin arka planına) basınca afişin kendi bağlantısı çalışır: içeriğin sayfası.
async function devamEt(k, dugme) {
  dugme.disabled = true;
  try {
    const r = await api('/api/rooms/devam', { method: 'POST', body: { type: k.type, id: k.id } });
    if (window.kabuk?.odayaGit) window.kabuk.odayaGit(r.roomUrl);
    else location.href = r.roomUrl;
  } catch {
    location.href = adres(k);
  } finally {
    dugme.disabled = false;
  }
}

function devamKart(k) {
  const kart = afisKart(k, {
    alt: k.type === 'series'
      ? `${k.watched?.length || 0} bölüm${k.last ? ` · S${k.last.split(':')[0]}E${k.last.split(':')[1]}` : ''}`
      : (k.year || ''),
  });
  const dugme = el('button', { type: 'button', class: 'oyna-dugme', title: 'Kaldığın yerden oynat', 'aria-label': 'Oynat' }, oynaIkon());
  dugme.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    devamEt(k, dugme);
  });
  kart.querySelector('.afis-gorsel')?.append(dugme);
  return kart;
}

async function yukle() {
  const ana = $('#icerik');
  const [gecmis, filmler, diziler] = await Promise.all([
    api('/api/gecmis').catch(() => []),
    api('/api/katalog?type=movie&id=top').catch(() => []),
    api('/api/katalog?type=series&id=top').catch(() => []),
    kutHazir.catch(() => {}),
    izlendiHazir.catch(() => {}),
  ]);
  const parcalar = [];
  if (gecmis.length) {
    let gizle = false;
    try { gizle = localStorage.getItem('gecmisIzlenmisGizle') === '1'; } catch { /* yok */ }
    // Anahtar (switch): "İzlenmişleri gizle". Açıkken izlenmiş film/diziler şeritten çıkar; seçim hatırlanır.
    const kutucuk = el('input', { type: 'checkbox', role: 'switch' });
    kutucuk.checked = gizle;
    const anahtar = el('label', { class: 'serit-anahtar', title: 'İzlediklerini şeritten gizle' },
      el('span', { class: 'serit-anahtar-yazi', text: 'İzlenmişleri gizle' }), kutucuk, el('span', { class: 'serit-anahtar-ray' }));
    const kartlar = () => gecmis.filter((k) => !(gizle && izlendiMi(k.type, k.id))).map(devamKart);
    const s = satir('İzlemeye devam', kartlar(), { sag: anahtar });
    kutucuk.addEventListener('change', () => {
      gizle = kutucuk.checked;
      try { localStorage.setItem('gecmisIzlenmisGizle', gizle ? '1' : '0'); } catch { /* yok */ }
      s.kutu.replaceChildren(...kartlar());
    });
    parcalar.push(s.bolum);
  }
  if (filmler.length) parcalar.push(satir('Popüler – Film', filmler.slice(0, 20).map((m) => afisKart(m)), { tumu: '/kesfet?type=movie&id=top' }).bolum);
  if (diziler.length) parcalar.push(satir('Popüler – Dizi', diziler.slice(0, 20).map((m) => afisKart(m)), { tumu: '/kesfet?type=series&id=top' }).bolum);
  ana.replaceChildren(...(parcalar.length
    ? parcalar
    : [el('p', { class: 'muted', text: 'Katalog alınamadı: internet bağlantısını denetle, sonra sayfayı yenile.' })]));
}
export const hazir = yukle();
