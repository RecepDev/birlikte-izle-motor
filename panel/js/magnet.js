// Arama kutusuna yapıştırılan magnet: torrent açılır, dosya seçtirilir, içerik (IMDb) eşleştirilir,
// sonra oda açılır ya da arka planda indirilir. Eşleştirme altyazı, geçmiş ve afiş için gerekli.
import { api, el, formatSize } from './api.js';
import { afisYok } from './afis.js';

export async function magnetAkisi(kap, magnet) {
  const durum = { dosya: null, secim: null, sezon: null, bolum: null, coz: null, dosyalar: [] };
  const kok = el('div', { class: 'magnet-kart' });
  kap.replaceChildren(kok);
  const yaz = (...cocuklar) => kok.replaceChildren(...cocuklar.filter(Boolean));

  yaz(el('h2', { text: '🧲 Magnet' }), el('p', { class: 'muted', text: 'Magnet çözülüyor…' }));
  try {
    durum.coz = await api('/api/magnet/coz', { method: 'POST', body: { magnet } });
  } catch (err) {
    return yaz(el('h2', { text: '🧲 Magnet' }), el('p', { class: 'error', text: err.message }));
  }
  const { infoHash, ad, trackerlar, tahmin } = durum.coz;
  yaz(el('h2', { text: '🧲 Magnet' }), el('p', { class: 'muted small', text: ad || infoHash }),
    el('p', { class: 'muted', text: 'Torrent bilgisi alınıyor… (en çok 45 sn sürebilir)' }));
  try {
    const d = await api('/api/magnet/dosyalar', { method: 'POST', body: { infoHash, trackerlar } });
    durum.dosyalar = d.dosyalar.filter((f) => f.video).length ? d.dosyalar.filter((f) => f.video) : d.dosyalar;
    durum.adi = d.ad || ad;
  } catch (err) {
    return yaz(el('h2', { text: '🧲 Magnet' }), el('p', { class: 'muted small', text: ad || infoHash }), el('p', { class: 'error', text: err.message }));
  }
  durum.dosya = durum.dosyalar[0] || null; // en büyük video

  // ---- ekran ------------------------------------------------------------------------------
  const dosyaKutusu = el('div', { class: 'm-dosyalar' });
  const eslesmeKutusu = el('div', { class: 'm-eslesme' });
  const sezonKutusu = el('div', { class: 'm-sezon', hidden: true });
  const eylem = el('div', { class: 'm-eylem' });
  const durumYazi = el('p', { class: 'muted small', text: '' });
  const araKutu = el('input', { class: 'sag-ara', value: tahmin?.sorgu || '', placeholder: 'Film ya da dizi adı' });
  const sonucKutu = el('div', { class: 'afis-serit m-sonuc' });

  const hazirMi = () => Boolean(durum.dosya && durum.secim
    && (durum.secim.type === 'movie' || (durum.sezon > 0 && durum.bolum > 0)));
  const icerikId = () => (durum.secim.type === 'series' ? `${durum.secim.id}:${durum.sezon}:${durum.bolum}` : durum.secim.id);

  function dosyalariCiz() {
    dosyaKutusu.replaceChildren(...durum.dosyalar.map((f) => {
      const secili = durum.dosya === f;
      return el('label', { class: `m-dosya${secili ? ' secili' : ''}` },
        el('input', { type: 'radio', name: 'm-dosya', checked: secili, onchange: () => { durum.dosya = f; dosyalariCiz(); eylemCiz(); } }),
        el('span', { class: 'm-dosya-ad', title: f.yol }, f.ad),
        el('span', { class: 'm-dosya-boyut', text: formatSize(f.boyut) }));
    }));
  }

  function sonuclariCiz(liste) {
    sonucKutu.replaceChildren(...(liste.length
      ? liste.map((m) => {
        const k = el('button', { type: 'button', class: `m-secenek${durum.secim?.id === m.id && durum.secim?.type === m.type ? ' secili' : ''}`, title: `${m.name} (${m.type === 'series' ? 'dizi' : 'film'})` },
          el('div', { class: 'afis-gorsel' }, m.poster ? el('img', { src: m.poster, alt: '', loading: 'lazy' }) : afisYok()),
          el('span', { class: 'afis-ad', text: m.name }),
          el('span', { class: 'afis-alt', text: `${m.type === 'series' ? '📺 dizi' : '🎬 film'}${m.year ? ` · ${m.year}` : ''}` }));
        k.addEventListener('click', () => { durum.secim = m; sonuclariCiz(liste); sezonCiz(); eylemCiz(); });
        return k;
      })
      : [el('p', { class: 'muted', text: 'Eşleşen içerik bulunamadı: adı değiştirip ara.' })]));
  }

  function sezonCiz() {
    const dizi = durum.secim?.type === 'series';
    sezonKutusu.hidden = !dizi;
    if (!dizi) return;
    const sayi = (anahtar, yer) => el('input', {
      type: 'number', min: '1', max: '999', value: durum[anahtar] ? String(durum[anahtar]) : '', placeholder: yer, class: 'm-sayi',
      oninput: (e) => { durum[anahtar] = Number(e.target.value) || null; eylemCiz(); },
    });
    sezonKutusu.replaceChildren(el('span', { class: 'muted', text: 'Hangi bölüm?' }), 'Sezon ', sayi('sezon', '1'), ' Bölüm ', sayi('bolum', '1'));
  }

  function eylemCiz() {
    const hazir = hazirMi();
    const oda = el('button', { type: 'button', class: 'detay-dugme birincil', disabled: !hazir, onclick: () => odaAc(oda) }, 'Oda aç');
    const indir = el('button', { type: 'button', class: 'detay-dugme', disabled: !hazir, onclick: () => indirEkle(indir) }, '↓ İndir');
    eylem.replaceChildren(oda, indir);
    durumYazi.textContent = hazir ? '' : (!durum.secim ? 'Önce bu torrent\'in hangi film/dizi olduğunu seç.' : 'Dizi için sezon ve bölümü yaz.');
  }

  async function eslestirAra() {
    const q = araKutu.value.trim();
    if (!q) return;
    sonucKutu.replaceChildren(el('p', { class: 'muted', text: 'Aranıyor…' }));
    const liste = await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => []);
    // Tahmin diziyse dizileri, filmse filmleri öne al.
    const dizi = tahmin?.sezon != null;
    liste.sort((a, b) => Number((b.type === 'series') === dizi) - Number((a.type === 'series') === dizi));
    if (!durum.secim && liste[0]) {
      durum.secim = liste[0];
      durum.sezon ||= tahmin?.sezon || (liste[0].type === 'series' ? 1 : null);
      durum.bolum ||= tahmin?.bolum || null;
    }
    sonuclariCiz(liste);
    sezonCiz();
    eylemCiz();
  }
  araKutu.addEventListener('keydown', (e) => { if (e.key === 'Enter') { durum.secim = null; eslestirAra(); } });

  async function odaAc(dugme) {
    dugme.disabled = true;
    dugme.textContent = 'Açılıyor…';
    try {
      const id = icerikId();
      const k = await api('/api/magnet/kaynak', { method: 'POST', body: {
        infoHash, trackerlar, filename: durum.dosya.ad, boyut: durum.dosya.boyut, type: durum.secim.type, id, ad: durum.adi,
      } });
      const res = await api('/api/rooms', { method: 'POST', body: { type: durum.secim.type, id, streamId: k.streamId, olcumler: [] } });
      if (window.kabuk?.odayaGit) window.kabuk.odayaGit(res.roomUrl);
      else location.href = res.roomUrl;
    } catch (err) {
      alert(`Oda açılamadı: ${err.message}`);
      dugme.disabled = false;
      dugme.textContent = 'Oda aç';
    }
  }

  async function indirEkle(dugme) {
    dugme.disabled = true;
    const id = icerikId();
    const r = await api('/api/indirme', { method: 'POST', body: {
      infoHash, fileIdx: null, filename: durum.dosya.ad, ad: `${durum.secim.name}${durum.secim.type === 'series' ? ` · ${durum.sezon}x${durum.bolum}` : ''} · magnet`,
      type: durum.secim.type, contentId: id, poster: durum.secim.poster || null, kalite: null, boyut: durum.dosya.boyut,
      sources: [`dht:${infoHash}`, ...trackerlar.map((t) => `tracker:${t}`)],
    } }).catch((err) => ({ error: err.message }));
    if (r?.error) {
      alert(`İndirme eklenemedi: ${r.error}`);
      dugme.disabled = false;
      return;
    }
    dugme.textContent = '✅ İndirmeye eklendi';
  }

  yaz(
    el('h2', { text: '🧲 Magnet' }),
    el('p', { class: 'muted small', text: durum.adi || infoHash }),
    el('h4', { class: 'm-baslik', text: 'OYNATILACAK DOSYA' }), dosyaKutusu,
    el('h4', { class: 'm-baslik', text: 'BU HANGİ FİLM/DİZİ?' }),
    el('div', { class: 'sag-arac' }, araKutu, el('button', { type: 'button', class: 'detay-dugme kucuk', onclick: () => { durum.secim = null; eslestirAra(); } }, 'Ara')),
    sonucKutu, sezonKutusu, durumYazi, eylem);
  dosyalariCiz();
  eylemCiz();
  eslestirAra();
}
