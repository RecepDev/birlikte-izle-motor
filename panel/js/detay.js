// Film/dizi detay ekranı (Stremio tarzı): solda tanıtım, sağda bölümler ve gömülü kaynak listesi.
import { indirmeIstegi } from './indirme-secenek.js';
import { api, apiStream, el, $, formatSize } from './api.js';
import { onayla, sor } from '/js/diyalog.js';
import { izlendiAyarla } from './izlendi.js';
import { menuAc, menuBaslik, menuAyrac, menuOge } from './menu.js';

const params = new URLSearchParams(location.search);
const type = params.get('type') === 'series' ? 'series' : 'movie';
let secilenId = params.get('id') || ''; // dizide "tt..:S:E" olabilir (doğrudan bölüm kaynakları)
const imdbId = secilenId.split(':')[0];

const DEBRID_UYARI = 'Bu bir doğrudan link (ör. Real-Debrid).\n\n'
  + 'Linkte debrid hesabının anahtarı var: arkadaşların senin hesabını kullanır. '
  + 'Real-Debrid farklı IP\'lerden aynı anda kullanımı ban sebebi sayabilir.\n\nYine de bu stream ile oda açılsın mı?';
const KALITELER = ['2160p', '1080p', '720p'];
const kaliteAdi = (q) => (q === '2160p' ? '4K' : q || '?');

let detay = null;
let bolumler = [];
let izlenen = new Set();
let sonBolum = null;
let tercihKalite = null;
let indirilenler = [];
const sag = $('#detay-sag');

// ---- geri / başlık ---------------------------------------------------------------------
$('#detay-geri').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.href = '/ana';
});

// ---- sol: tanıtım ----------------------------------------------------------------------
function solCiz() {
  const d = detay;
  if (d.background) $('#detay-arka').style.backgroundImage = `url("${d.background.replace(/"/g, '%22')}")`;
  document.title = `${d.name} · Birlikte İzle`;
  const etiketler = (baslik, liste) => (liste.length
    ? el('div', { class: 'detay-blok' }, el('h4', { text: baslik }), el('div', { class: 'detay-etiketler' }, ...liste.map((x) => el('span', { class: 'detay-etiket', text: x }))))
    : null);
  const sayilar = [d.runtime, d.year, d.imdbRating ? `${d.imdbRating}` : null].filter(Boolean);
  $('#detay-sol').replaceChildren(
    d.logo
      ? el('img', { class: 'detay-logo', src: d.logo, alt: d.name, onerror: (e) => e.target.replaceWith(el('h1', { class: 'detay-baslik', text: d.name })) })
      : el('h1', { class: 'detay-baslik', text: d.name }),
    el('div', { class: 'detay-sayilar' },
      ...sayilar.map((x) => el('span', { text: x })),
      d.imdbRating ? el('span', { class: 'imdb-rozet', text: 'IMDb' }) : null),
    etiketler('TÜRLER', d.genres),
    etiketler('OYUNCULAR', d.cast),
    d.description ? el('div', { class: 'detay-blok' }, el('h4', { text: 'ÖZET' }), el('p', { class: 'detay-ozet', text: d.description })) : null,
    el('div', { class: 'detay-eylemler' },
      d.fragman ? el('a', { class: 'detay-dugme', href: d.fragman, target: '_blank', rel: 'noreferrer' }, '🎬 Fragman') : null,
      type === 'movie' ? el('span', { id: 'film-indir-yeri' }) : null));
  filmIndirCiz();
}

// Filmde: indirilmişse "İndirilenden aç", değilse ↓ İndir (durum değişince yenilenir).
function filmIndirCiz() {
  const yer = $('#film-indir-yeri');
  if (!yer || type !== 'movie') return;
  const kayit = indirilenKayit('movie', imdbId);
  if (kayit?.durum === 'bitti') {
    yer.replaceChildren(el('button', { type: 'button', class: 'detay-dugme birincil', onclick: (e) => indirilenAc(kayit, detay?.name || imdbId, e.currentTarget) }, '▶ İndirilenden aç'));
  } else {
    const d = indirKucuk('movie', imdbId);
    d.className = 'detay-dugme';
    yer.replaceChildren(d);
    indirimDurumuGuncelle();
  }
}

// ---- sağ: dizide sezon/bölüm listesi -----------------------------------------------------
let secilenSezon = null;

function bolumListesi() {
  otoDurdur();
  secilenId = imdbId;
  history.replaceState(null, '', `/detay?${new URLSearchParams({ type, id: imdbId })}`);
  const sezonlar = [...new Set(bolumler.map((b) => b.season))].sort((a, b) => a - b);
  if (secilenSezon === null) {
    const son = sonBolum ? Number(sonBolum.split(':')[0]) : null;
    secilenSezon = sezonlar.includes(son) ? son : (sezonlar.find((s) => s > 0) ?? sezonlar[0]);
  }
  const secici = el('select', { class: 'detay-sezon' }, ...sezonlar.map((s) => el('option', { value: String(s) }, s === 0 ? 'Özel bölümler' : `Sezon ${s}`)));
  secici.value = String(secilenSezon);
  secici.addEventListener('change', () => { secilenSezon = Number(secici.value); bolumListesi(); });
  const liste = bolumler.filter((b) => b.season === secilenSezon);
  const bolumId = (b) => `${imdbId}:${b.season}:${b.episode}`;
  let sonSatir = null;
  const satirlar = liste.map((b) => {
    const anahtar = `${b.season}:${b.episode}`;
    const izlendi = izlenen.has(anahtar);
    const son = anahtar === sonBolum;
    const kayit = indirilenKayit('series', bolumId(b));
    const baslik = `S${b.season}E${b.episode} ${b.name}`;
    const satir = el('div', { class: `bolum${izlendi ? ' izlendi' : ''}${son ? ' son' : ''}` },
      el('button', { type: 'button', class: 'bolum-ana', onclick: () => kaynaklariAc(bolumId(b), baslik) },
        b.thumbnail ? el('img', { class: 'bolum-resim', src: b.thumbnail, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }) : null,
        el('span', { class: 'bolum-ad' }, `${b.episode}. ${b.name}`),
        izlendi ? el('span', { class: 'izlendi-etiket' }, son ? '▶ en son' : '✓ izlendi') : null),
      el('div', { class: 'bolum-eylem' },
        kayit?.durum === 'bitti'
          ? el('button', { type: 'button', class: 'detay-dugme birincil kucuk', title: 'İndirilen dosyadan doğrudan oda aç (torrent beklemez)', onclick: (e) => indirilenAc(kayit, baslik, e.currentTarget) }, '▶ Aç')
          : null,
        indirKucuk('series', bolumId(b))));
    // Sağ tık: bölümü / sezonu / bütün diziyi izledim işaretle ya da işareti kaldır.
    satir.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const sezonBolumleri = liste.map((x) => `${x.season}:${x.episode}`);
      menuAc(e.clientX, e.clientY, [
        menuBaslik(baslik),
        izlendi
          ? menuOge('✖ İzlendi işaretini kaldır', () => izlendiDegistir([anahtar], false))
          : menuOge('✓ İzledim olarak işaretle', () => izlendiDegistir([anahtar], true)),
        menuAyrac(),
        menuOge(`✓ Sezon ${secilenSezon}: hepsini izledim işaretle`, () => izlendiDegistir(sezonBolumleri, true)),
        menuOge(`✖ Sezon ${secilenSezon}: işaretleri kaldır`, () => izlendiDegistir(sezonBolumleri, false)),
        menuAyrac(),
        menuOge('✓ Bütün diziyi izledim işaretle', () => izlendiDegistir(null, true)),
        menuOge('✖ Bütün izlendi işaretlerini kaldır', () => izlendiDegistir(null, false)),
      ]);
    });
    if (son) sonSatir = satir;
    return satir;
  });
  sag.replaceChildren(
    el('div', { class: 'sag-ust' },
      el('strong', { text: 'Bölümler' }), secici,
      el('button', { type: 'button', class: 'detay-dugme kucuk', title: 'Sezonun bütün bölümlerini arka planda indir (kaynak otomatik seçilir)',
        onclick: () => topluIndir(liste.map((b) => ({ type: 'series', id: bolumId(b) })), `Sezon ${secilenSezon}: ${liste.length} bölüm`, 'sezon') }, '↓ Sezonu indir'),
      el('button', { type: 'button', class: 'detay-dugme kucuk', title: 'Dizinin bütün sezonlarını arka planda indir (özel bölümler hariç, kaynak her bölüm için otomatik seçilir)',
        onclick: () => {
          const hepsi = bolumler.filter((b) => b.season > 0);
          const sayi = new Set(hepsi.map((b) => b.season)).size;
          topluIndir(hepsi.map((b) => ({ type: 'series', id: bolumId(b) })), `${detay?.name || 'Dizi'}: tüm sezonlar (${sayi} sezon, ${hepsi.length} bölüm)`, 'dizi');
        } }, '↓ Tüm sezonları indir')),
    el('div', { class: 'sag-liste' }, ...satirlar));
  indirimDurumuGuncelle();
  sonSatir?.scrollIntoView({ block: 'center' });
}

// Elle izlendi işareti: bolumler null ise bütün dizi. Sonra bölüm listesi sunucudan yeniden alınıp çizilir (kaydırma yerinde).
async function izlendiDegistir(bolumler, deger) {
  await izlendiAyarla('series', imdbId, deger, bolumler);
  // Bütün dizi izledim işaretlenince kütüphaneye de eklenir.
  if (deger && !bolumler) {
    await api('/api/kutuphane/ekle', { method: 'POST', body: { type: 'series', id: imdbId, name: detay?.name, poster: detay?.poster, year: detay?.year || detay?.releaseInfo } }).catch(() => {});
  }
  const liste = await api(`/api/series/${encodeURIComponent(imdbId)}/episodes`).catch(() => null);
  if (!liste) return;
  bolumler = liste;
  izlenen = new Set(liste.filter((b) => b.watched).map((b) => `${b.season}:${b.episode}`));
  const konum = document.querySelector('.sag-liste')?.scrollTop || 0;
  bolumListesi();
  const yeni = document.querySelector('.sag-liste');
  if (yeni) yeni.scrollTop = konum;
}

// ---- sağ: kaynak listesi (gömülü) --------------------------------------------------------
let kaynakNesil = 0;
let streams = [];
let tamamlandi = false;
let cevapVeren = 0;
let kaliteSuzgec = '';
let aramaMetni = '';

function siraQ(s) {
  if (tercihKalite && s.quality === tercihKalite) return -1;
  const i = KALITELER.indexOf(s.quality);
  return i < 0 ? 9 : i;
}
const siralayici = (a, b) => siraQ(a) - siraQ(b) || (Number(b.seeders) || 0) - (Number(a.seeders) || 0);
const kaliteDe = (s) => (KALITELER.includes(s.quality) ? s.quality : 'diger');

async function kaynaklariAc(id, baslik) {
  otoDurdur();
  secilenId = id;
  history.replaceState(null, '', `/detay?${new URLSearchParams({ type, id })}`);
  const nesil = ++kaynakNesil;
  streams = [];
  tamamlandi = false;
  cevapVeren = 0;
  kaliteSuzgec = '';
  aramaMetni = '';
  const geriDugme = type === 'series'
    ? el('button', { type: 'button', class: 'sag-geri', title: 'Bölümlere dön', onclick: () => { kaynakNesil++; bolumListesi(); } }, '‹')
    : null;
  sag.replaceChildren(
    el('div', { class: 'sag-ust' },
      geriDugme,
      el('strong', { class: 'sag-baslik', text: baslik || detay?.name || '' })),
    el('div', { class: 'sag-arac' },
      el('button', { type: 'button', id: 'oto-baslat', class: 'detay-dugme birincil', title: 'En uygun kaynağı kendisi bulur, hız doğrular ve odayı açar', onclick: () => otoBaslat(id) }, '⚡ Otomatik seç'),
      el('button', { type: 'button', class: 'detay-dugme kucuk', title: 'Bu bölümü/filmi arka planda indir (kaynak otomatik seçilir)', onclick: () => topluIndir([{ type, id }], baslik || detay?.name || id) }, '↓ Otomatik indir')),
    el('div', { class: 'sag-arac' },
      el('div', { id: 'kalite-cipler', class: 'cipler' }),
      el('input', { class: 'sag-ara', placeholder: 'Kaynak ara…', oninput: (e) => { aramaMetni = e.target.value.trim().toLowerCase(); kaynakCiz(); } })),
    el('div', { id: 'kaynaklar', class: 'sag-liste' }, el('p', { class: 'muted', text: 'Kaynaklar alınıyor…' })));
  try {
    await apiStream(`/api/streams?${new URLSearchParams({ type, id })}`, (line) => {
      if (nesil !== kaynakNesil) return;
      if (line.type === 'addon') {
        cevapVeren += 1;
        streams = [...streams.filter((s) => s.addonName !== line.addonName), ...line.streams];
        kaynakCiz();
      } else if (line.type === 'done') {
        tamamlandi = true;
        kaynakCiz();
      }
    });
  } catch (err) {
    if (nesil === kaynakNesil) $('#kaynaklar')?.replaceChildren(el('p', { class: 'error', text: err.message }));
  }
}

function kaliteCipleri() {
  const kutu = $('#kalite-cipler');
  if (!kutu) return;
  const var_ = (q) => streams.some((s) => kaliteDe(s) === q);
  const cip = (q, yazi) => el('button', {
    type: 'button', class: `chip${kaliteSuzgec === q ? ' active' : ''}`,
    onclick: () => { kaliteSuzgec = kaliteSuzgec === q ? '' : q; kaynakCiz(); },
  }, yazi);
  kutu.replaceChildren(
    cip('', 'Hepsi'),
    ...KALITELER.filter(var_).map((q) => cip(q, kaliteAdi(q))),
    ...(var_('diger') ? [cip('diger', 'Diğer')] : []));
  for (const c of kutu.children) c.classList.toggle('active', (c.textContent === 'Hepsi' && !kaliteSuzgec)
    || c.textContent === (kaliteSuzgec === 'diger' ? 'Diğer' : kaliteAdi(kaliteSuzgec)));
}

function indirmeKaydi(s) {
  if (s.kind !== 'torrent') return null;
  return indirilenler.find((k) => k.infoHash === s.infoHash
    && ((k.fileIdx ?? -1) === (Number.isInteger(s.fileIdx) ? s.fileIdx : -1) || (s.filename && k.filename === s.filename))) || null;
}

function kaynakSatiri(s) {
  const kayit = indirmeKaydi(s);
  const satirlar = String(s.title || s.name).split('\n').filter(Boolean);
  const odaDugme = el('button', { type: 'button', class: 'detay-dugme birincil kucuk', text: 'Oda aç' });
  odaDugme.addEventListener('click', () => odaAc(s, odaDugme));
  const indirDugme = el('button', { type: 'button', class: 'detay-dugme kucuk', title: 'Diske indir: sonra internetsiz de açılır' }, '↓');
  indirDugme.addEventListener('click', () => kaynakIndir(s, indirDugme));
  if (kayit) {
    indirDugme.textContent = kayit.durum === 'bitti' ? '💾' : '⏳';
    indirDugme.disabled = true;
    indirDugme.title = kayit.durum === 'bitti' ? 'İndirildi: torrent beklemeden diskten açılır' : 'İndirme listesinde';
  }
  const rozetler = [
    s.kind === 'torrent' ? '🧲' : '🔗 doğrudan',
    s.seeders !== null && s.seeders !== undefined ? `👤 ${s.seeders}` : null,
    s.sizeBytes ? formatSize(s.sizeBytes) : null,
    s.hdr ? `🌗 ${s.hdr}` : null,
    s.embeddedSubs ? `💬${s.embeddedSubs.langs?.includes('Türkçe') ? ' TR' : ''}` : null,
    kayit?.durum === 'bitti' ? '💾 indirildi' : null,
  ].filter(Boolean);
  return el('div', { class: 'kaynak' },
    el('div', { class: 'k-sol' },
      el('span', { class: 'k-kalite', text: kaliteAdi(s.quality) }),
      el('span', { class: 'k-addon', text: s.addonName })),
    el('div', { class: 'k-bilgi' },
      el('div', { class: 'k-ad', title: satirlar.join('\n') }, satirlar[0] || ''),
      el('div', { class: 'k-alt' }, rozetler.join(' · '))),
    el('div', { class: 'k-eylem' }, indirDugme, odaDugme));
}

function kaynakCiz() {
  const kutu = $('#kaynaklar');
  if (!kutu) return;
  kaliteCipleri();
  const gorunen = streams.filter((s) => (!aramaMetni || `${s.name} ${s.title} ${s.quality}`.toLowerCase().includes(aramaMetni))
    && (!kaliteSuzgec || kaliteDe(s) === kaliteSuzgec)).sort(siralayici);
  if (!streams.length) {
    kutu.replaceChildren(el('p', { class: 'muted', text: tamamlandi
      ? "Hiç kaynak bulunamadı. Panelde Torrentio gibi bir stream addon'u ekli ve açık mı?"
      : `Kaynaklar alınıyor… (${cevapVeren} addon cevap verdi)` }));
    return;
  }
  const alt = tamamlandi ? null : el('p', { class: 'muted small', text: `Diğer addon'lar aranıyor… (${cevapVeren} cevap verdi)` });
  kutu.replaceChildren(...[alt, ...(gorunen.length ? gorunen.map(kaynakSatiri) : [el('p', { class: 'muted', text: 'Bu filtreye uyan kaynak yok.' })])].filter(Boolean));
}

async function odaAc(s, dugme) {
  otoDurdur();
  if (s.kind === 'http' && !await onayla(DEBRID_UYARI)) return;
  dugme.disabled = true;
  dugme.textContent = 'Açılıyor…';
  try {
    const res = await api('/api/rooms', { method: 'POST', body: { type, id: secilenId, streamId: s.streamId, olcumler: [] } });
    // Uygulamada oda oynatıcı penceresinde, tarayıcıda aynı sekmede açılır.
    if (window.kabuk?.odayaGit) window.kabuk.odayaGit(res.roomUrl);
    else location.href = res.roomUrl;
  } catch (err) {
    alert(`Oda açılamadı: ${err.message}`);
    dugme.disabled = false;
    dugme.textContent = 'Oda aç';
  }
}

async function kaynakIndir(s, dugme) {
  dugme.disabled = true;
  dugme.textContent = '…';
  const ek = type === 'series' ? ` · ${secilenId.split(':').slice(1).join('x')}` : '';
  const r = await api('/api/indirme', {
    method: 'POST',
    body: {
      infoHash: s.infoHash, fileIdx: Number.isInteger(s.fileIdx) ? s.fileIdx : null, filename: s.filename || null,
      ad: `${detay?.name || secilenId}${ek} · ${s.quality || ''}`.trim(), type, contentId: secilenId, poster: detay?.poster || null,
      kalite: s.quality || null, boyut: s.sizeBytes || null, sources: s.sources || [],
    },
  }).catch((err) => ({ error: err.message }));
  if (r?.error) {
    alert(`İndirme eklenemedi: ${r.error}`);
    dugme.disabled = false;
    dugme.textContent = '↓';
    return;
  }
  indirmeDurumuYenile();
}


// ---- otomatik seç: aynı panelde ------------------------------------------------------------
// Otomatik mod (ölçüm, doğrulama, kaynak seçimi) /new sayfasındaki mantıkla çalışıyor; o sayfa gizli bir
// çerçevede açılıyor, durumu burada gösteriliyor ve oda hazır olunca burada açılıyor.
let oto = null; // { ifr, kart, zaman }

function otoDurdur() {
  if (!oto) return;
  clearInterval(oto.zaman);
  oto.ifr.remove(); // çerçeve kapanınca /new açık denenen torrent'leri kapatır
  oto.kart.remove();
  oto = null;
  $('#oto-baslat')?.removeAttribute('disabled');
}

function otoBaslat(id) {
  otoDurdur();
  const ifr = el('iframe', { class: 'oto-ifr', 'aria-hidden': 'true', tabindex: '-1', src: `/new?${new URLSearchParams({ type, id, oto: '1', gomulu: '1' })}` });
  document.body.append(ifr);
  const metin = el('span', { class: 'oto-metin', text: '🤖 Otomatik mod başlıyor…' });
  const simdi = el('button', { type: 'button', class: 'detay-dugme birincil kucuk', hidden: true, onclick: () => ifr.contentDocument?.querySelector('#oto-simdi')?.click() }, 'Şimdi aç');
  const kalite = el('button', { type: 'button', class: 'detay-dugme kucuk', hidden: true, onclick: () => ifr.contentDocument?.querySelector('#oto-kalite')?.click() }, '');
  const iptal = el('button', { type: 'button', class: 'detay-dugme kucuk', onclick: otoDurdur }, 'İptal');
  const liste = el('ul', { class: 'oto-liste', hidden: true });
  const kart = el('div', { class: 'oto-kart' }, el('div', { class: 'oto-satir' }, el('span', { class: 'oto-donen' }), metin, simdi, kalite, iptal), liste);
  $('#kaynaklar').before(kart);
  $('#oto-baslat')?.setAttribute('disabled', '');
  // Gizli sayfanın durumunu yansıt (aynı kökten: doğrudan okunabilir).
  const yansit = () => {
    const d = ifr.contentDocument;
    if (!d) return;
    const m = d.querySelector('#oto-text')?.textContent;
    if (m) metin.textContent = m;
    const sd = d.querySelector('#oto-simdi');
    simdi.hidden = !sd || sd.hidden;
    const ka = d.querySelector('#oto-kalite');
    kalite.hidden = !ka || ka.hidden;
    if (ka) kalite.textContent = ka.textContent;
    const l = d.querySelector('#oto-liste');
    liste.hidden = !l || l.hidden || !l.children.length;
    if (l) liste.replaceChildren(...[...l.children].map((li) => li.cloneNode(true)));
  };
  oto = { ifr, kart, zaman: setInterval(yansit, 500) };
}

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !oto || e.source !== oto.ifr.contentWindow) return;
  if (e.data?.tip === 'oda') {
    // Oda hazır: uygulamada oynatıcı penceresinde, tarayıcıda bu sekmede açılır.
    if (window.kabuk?.odayaGit) window.kabuk.odayaGit(e.data.url);
    else location.href = e.data.url;
  } else if (e.data?.tip === 'hata') {
    alert(e.data.mesaj);
    otoDurdur();
  }
});

// İndirilmiş dosyadan doğrudan oda: torrent'e gidilmez, dosya diskten servis edilir.
async function indirilenAc(kayit, baslik, dugme) {
  dugme.disabled = true;
  dugme.textContent = 'Açılıyor…';
  try {
    const trackerlar = (kayit.sources || []).filter((x) => x.startsWith('tracker:')).map((x) => x.slice('tracker:'.length));
    const k = await api('/api/magnet/kaynak', { method: 'POST', body: {
      infoHash: kayit.infoHash, trackerlar, filename: kayit.filename, boyut: kayit.boyut, type: kayit.type, id: kayit.contentId, ad: baslik,
    } });
    const res = await api('/api/rooms', { method: 'POST', body: { type: kayit.type, id: kayit.contentId, streamId: k.streamId, olcumler: [] } });
    if (window.kabuk?.odayaGit) window.kabuk.odayaGit(res.roomUrl);
    else location.href = res.roomUrl;
  } catch (err) {
    alert(`Oda açılamadı: ${err.message}`);
    dugme.disabled = false;
    dugme.textContent = '▶ Aç';
  }
}

function indirilenKayit(t, id) {
  return indirmeVeri.kayitlar.find((x) => x.type === t && x.contentId === id) || null;
}

// ---- arka plan indirme (otomatik kaynak) --------------------------------------------------
let indirmeVeri = { kayitlar: [], arama: [] };
function icerikDurumu(t, id) {
  const k = indirmeVeri.kayitlar.find((x) => x.type === t && x.contentId === id);
  if (k) {
    const yuzde = k.boyut ? Math.min(100, Math.round((k.inen / k.boyut) * 100)) : 0;
    if (k.durum === 'bitti') return { metin: '✅', ipucu: 'İndirildi', kilit: true };
    if (k.durum === 'iniyor') return { metin: `%${yuzde}`, ipucu: 'İniyor', kilit: true };
    if (k.durum === 'hata') return { metin: '⚠️', ipucu: k.hata || 'Hata (tekrar basınca yeniden dener)', kilit: false };
    return { metin: k.durum === 'duraklatildi' || k.izlemeBekliyor ? '⏸️' : '⏳', ipucu: 'İndirme listesinde', kilit: true };
  }
  const a = indirmeVeri.arama.find((x) => x.type === t && x.id === id);
  if (a) return { metin: a.durum === 'bulunamadi' || a.durum === 'hata' ? '⚠️' : '🔎', ipucu: a.durum === 'bulunamadi' ? 'Kaynak bulunamadı' : 'Kaynak aranıyor', kilit: a.durum === 'sirada' || a.durum === 'araniyor' };
  return null;
}
function indirKucuk(t, id) {
  const d = el('button', { type: 'button', class: 'indir-mini', 'data-tip': `${t}|${id}`, title: 'Arka planda indir (kaynak otomatik seçilir)' }, '↓');
  d.addEventListener('click', async () => topluIndir([{ type: t, id }], null));
  return d;
}
function indirimDurumuGuncelle() {
  for (const d of document.querySelectorAll('button.indir-mini[data-tip]')) {
    const [t, ...g] = d.dataset.tip.split('|');
    const durum = icerikDurumu(t, g.join('|'));
    d.textContent = durum ? durum.metin : '↓';
    d.title = durum ? durum.ipucu : 'Arka planda indir (kaynak otomatik seçilir)';
    d.disabled = Boolean(durum?.kilit);
  }
}
async function topluIndir(items, aciklama, toplu = null) {
  await indirmeIstegi(items, aciklama || detay?.name || '', toplu);
  indirmeDurumuYenile();
}
async function indirmeDurumuYenile() {
  try {
    indirmeVeri = await api('/api/indirme');
    indirmeVeri.arama ||= [];
  } catch { return; }
  const eski = JSON.stringify(indirilenler.map((k) => [k.infoHash, k.fileIdx, k.durum]));
  indirilenler = indirmeVeri.kayitlar;
  indirimDurumuGuncelle();
  const degisti = JSON.stringify(indirilenler.map((k) => [k.infoHash, k.fileIdx, k.durum])) !== eski;
  if (degisti && $('#kaynaklar')) kaynakCiz();
  if (degisti) {
    filmIndirCiz();
    // Bölüm listesi açıksa "▶ Aç" düğmeleri güncellensin (kaydırma yerinde kalsın).
    if (type === 'series' && !$('#kaynaklar') && bolumler.length) {
      const konum = document.querySelector('.sag-liste')?.scrollTop || 0;
      bolumListesi();
      const yeni = document.querySelector('.sag-liste');
      if (yeni) yeni.scrollTop = konum;
    }
  }
}

// ---- başlangıç ----------------------------------------------------------------------------
(async () => {
  if (!imdbId) { $('#detay-sol').textContent = 'İçerik bilgisi yok.'; return; }
  indirmeDurumuYenile();
  setInterval(indirmeDurumuYenile, 2000);
  const [d, tercih, gecmis] = await Promise.all([
    api(`/api/detay?${new URLSearchParams({ type, id: imdbId })}`).catch(() => null),
    api('/api/tercih').catch(() => null),
    api('/api/gecmis').catch(() => []),
  ]);
  tercihKalite = tercih?.kalite || null;
  detay = d?.error ? null : d;
  if (!detay) detay = { id: imdbId, type, name: imdbId, genres: [], cast: [], description: '', background: null, logo: null, poster: null };
  solCiz();
  if (type === 'movie') {
    kaynaklariAc(imdbId, detay.name);
    return;
  }
  const kayit = gecmis.find((k) => k.type === 'series' && k.id === imdbId);
  sonBolum = kayit?.last || null;
  izlenen = new Set(kayit?.watched || []);
  const liste = await api(`/api/series/${encodeURIComponent(imdbId)}/episodes`).catch(() => []);
  if (liste[0]) izlenen = new Set(liste.filter((b) => b.watched).map((b) => `${b.season}:${b.episode}`));
  bolumler = liste;
  const [, s, e] = secilenId.split(':');
  if (s && e) {
    // Doğrudan bölüm adresi: o bölümün kaynakları açık gelir, geri düğmesi bölüm listesine döner.
    secilenSezon = Number(s);
    const b = bolumler.find((x) => String(x.season) === s && String(x.episode) === e);
    return kaynaklariAc(secilenId, `S${s}E${e}${b ? ` ${b.name}` : ''}`);
  }
  if (!bolumler.length) return kaynaklariAc(imdbId, detay.name); // bölüm listesi gelmedi: dizinin kendi id'siyle
  bolumListesi();
})();
