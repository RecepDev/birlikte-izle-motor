// İnen filmin/dizinin afişinde sol altta daire biçimli ilerleme: ok + yüzde. 2 sn'de bir /api/indirme'den tazelenir.
// Dizide o dizinin sıradaki/inen bütün bölümleri toplam olarak sayılır (inen bayt / toplam bayt).
import { api } from './api.js';

const AKTIF = new Set(['iniyor', 'kuyrukta', 'duraklatildi']);
const NS = 'http://www.w3.org/2000/svg';
const R = 15;
const CEVRE = 2 * Math.PI * R;
let harita = new Map(); // "type|imdb" -> { yuzde, durum, canli }
const sonIlerleme = new Map(); // "type|imdb" -> { inen, zaman }: veri gerçekten akıyor mu (yanıp sönme)

function rozetYap() {
  const kap = document.createElement('span');
  kap.className = 'ind-rozet';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  const iz = document.createElementNS(NS, 'circle');
  const halka = document.createElementNS(NS, 'circle');
  for (const c of [iz, halka]) {
    c.setAttribute('cx', '18'); c.setAttribute('cy', '18'); c.setAttribute('r', String(R)); c.setAttribute('fill', 'none'); c.setAttribute('stroke-width', '3');
  }
  iz.setAttribute('class', 'ind-iz');
  halka.setAttribute('class', 'ind-halka');
  halka.setAttribute('stroke-dasharray', String(CEVRE));
  halka.setAttribute('transform', 'rotate(-90 18 18)');
  svg.append(iz, halka);
  const ok = document.createElement('span');
  ok.className = 'ind-ok';
  ok.textContent = '↓';
  const yazi = document.createElement('span');
  yazi.className = 'ind-yuzde';
  kap.append(svg, ok, yazi);
  return kap;
}

// Dizide ne indiriliyor: tek bölüm -> E, tek sezon -> S1, birden çok sezon -> A. Film: ok.
// Aynı toplu isteğin parçaları sayılır: işleyen kayıtların ilkinden en çok 10 dk önce eklenmiş biten bölümler de dahil
// (sezon indirirken biten bölümler yüzünden etiket E'ye düşmesin; eski, ilgisiz indirmeler katılmasın).
function grupBul(anahtar, kayitlar) {
  if (!anahtar.startsWith('series|')) return kayitlar;
  const aktif = kayitlar.filter((k) => AKTIF.has(k.durum));
  const ilk = Math.min(...aktif.map((k) => Date.parse(k.tarih) || Infinity));
  return kayitlar.filter((k) => AKTIF.has(k.durum) || (Date.parse(k.tarih) || 0) >= ilk - 10 * 60_000);
}
function topluTur(k) {
  if (k.toplu) return k.toplu;
  try { return JSON.parse(localStorage.getItem('indirmeToplu') || '{}')[k.contentId] || null; } catch { return null; }
}
function etiketBul(anahtar, grup0) {
  if (!anahtar.startsWith('series|')) return '';
  const grup = grup0.map((k) => ({ ...k, toplu: topluTur(k) }));
  const sezonNo = (k) => String(k.contentId || '').split(':')[1];
  // Bütün dizi istendiyse A; tek bir sezon istendiyse S1; birden çok sezon istendiyse A.
  if (grup.some((k) => k.toplu === 'dizi')) return 'A';
  const sezonlar = new Set(grup.filter((k) => k.toplu === 'sezon').map(sezonNo).filter(Boolean));
  const tek = grup.filter((k) => !k.toplu);
  if (sezonlar.size > 1) return 'A';
  if (sezonlar.size === 1 && !tek.length) return `S${[...sezonlar][0]}`;
  // Bölümler tek tek eklendi: tek bölüm E, birkaç tane ise adedi.
  return grup.length <= 1 ? 'E' : (grup.length > 99 ? '99+' : String(grup.length));
}

function uygula() {
  for (const a of document.querySelectorAll('a.afis[data-id]')) {
    const gorsel = a.querySelector('.afis-gorsel');
    if (!gorsel) continue;
    const d = harita.get(`${a.dataset.type}|${a.dataset.id}`);
    let r = gorsel.querySelector('.ind-rozet');
    if (!d) { r?.remove(); continue; }
    if (!r) { r = rozetYap(); gorsel.append(r); }
    r.classList.toggle('bekliyor', d.durum !== 'iniyor');
    r.classList.toggle('canli', Boolean(d.canli));
    r.querySelector('.ind-ok').textContent = d.etiket || '↓';
    r.classList.toggle('harfli', Boolean(d.etiket));
    r.classList.toggle('uzun', (d.etiket || '').length >= 3);
    r.querySelector('.ind-halka').setAttribute('stroke-dashoffset', String(CEVRE * (1 - d.yuzde / 100)));
    r.querySelector('.ind-yuzde').textContent = d.durum === 'duraklatildi' ? '⏸' : (d.durum === 'kuyrukta' ? '…' : `${d.yuzde}%`);
    r.title = d.durum === 'iniyor' ? `İniyor: %${d.yuzde}` : (d.durum === 'duraklatildi' ? 'İndirme duraklatıldı' : 'İndirme sırada');
  }
}

// Disk dolduğu için düşen indirmeler: ekranın üstünde temalı uyarı şeridi + (yeni düşüşte) kısa bip. Yer açılıp
// indirmeler sürünce kendiliğinden kalkar. (Masaüstü uygulaması ayrıca sistem bildirimi + bip veriyor: ana.cjs.)
let diskBilinen = new Set();
function bip() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    [0].forEach((gecikme) => { // tek bip
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + gecikme);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + gecikme + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + gecikme + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + gecikme);
      o.stop(ctx.currentTime + gecikme + 0.25);
    });
    setTimeout(() => ctx.close?.(), 1500);
  } catch { /* ses çalınamazsa şerit yine görünür */ }
}
function diskUyarisi(kayitlar) {
  const dusen = kayitlar.filter((k) => k.durum === 'hata' && /ENOSPC|no space left/i.test(String(k.hata || '')));
  if (window.kabuk?.bildirimAyar && window.kabuk.bildirimAyar().diskSerit === false) { document.getElementById('disk-uyari')?.remove(); return; }
  let serit = document.getElementById('disk-uyari');
  if (!dusen.length) {
    serit?.remove();
    diskBilinen = new Set();
    try { sessionStorage.removeItem('diskBip'); } catch { /* yok */ }
    return;
  }
  if (!serit) {
    serit = document.createElement('div');
    serit.id = 'disk-uyari';
    serit.setAttribute('role', 'alert');
    document.body.append(serit);
  }
  serit.textContent = `Disk dolu: ${dusen.length} indirme durdu. Yer açıp İndirilenler'den "Hepsini sürdür"e bas.`;
  // Ses yalnız bir kez (disk dolu dönemi başında): sayfa değişse/yenilense, başka indirme düşse tekrar çalmaz.
  // Masaüstü uygulaması kendi bildirimi ve bip'ini zaten veriyor (ana.cjs): orada sayfa sesi çalınmaz.
  let calindi = false;
  try { calindi = sessionStorage.getItem('diskBip') === '1'; } catch { calindi = true; }
  if (!calindi) {
    try { sessionStorage.setItem('diskBip', '1'); } catch { /* yok */ }
    if (!window.kabuk) bip();
  }
  diskBilinen = new Set(dusen.map((k) => k.id));
}

async function yenile() {
  if (document.hidden) return;
  let r;
  try { r = await api('/api/indirme'); } catch { return; }
  diskUyarisi(r.kayitlar || []);
  const gruplar = new Map();
  for (const k of r.kayitlar || []) {
    if (k.durum === 'hata') continue;
    const imdb = String(k.contentId || '').split(':')[0];
    if (!imdb || !k.type) continue;
    const anahtar = `${k.type === 'series' ? 'series' : 'movie'}|${imdb}`;
    const g = gruplar.get(anahtar) || { inen: 0, boyut: 0, durumlar: [], kayitlar: [] };
    g.kayitlar.push(k);
    g.inen += k.durum === 'bitti' ? (k.boyut || k.inen || 0) : (k.inen || 0);
    g.boyut += k.boyut || k.inen || 0;
    g.durumlar.push(k.durum);
    gruplar.set(anahtar, g);
  }
  harita = new Map();
  for (const [anahtar, g] of gruplar) {
    if (!g.durumlar.some((d) => AKTIF.has(d))) continue;
    const durum = g.durumlar.includes('iniyor') ? 'iniyor' : (g.durumlar.includes('kuyrukta') ? 'kuyrukta' : 'duraklatildi');
    // İlerleme ve etiket aynı toplu isteğin kayıtlarından (eski biten bölümler yüzdeyi şişirmesin).
    const grup = grupBul(anahtar, g.kayitlar);
    const inen = grup.reduce((t, k) => t + (k.durum === 'bitti' ? (k.boyut || k.inen || 0) : (k.inen || 0)), 0);
    const boyut = grup.reduce((t, k) => t + (k.boyut || k.inen || 0), 0);
    // Canlı: son 6 sn içinde inen bayt arttı (durum "iniyor" ama takılı olan yanıp sönmez).
    const onceki = sonIlerleme.get(anahtar);
    const simdi = Date.now();
    if (!onceki || inen > onceki.inen) sonIlerleme.set(anahtar, { inen, zaman: inen > (onceki?.inen ?? -1) ? simdi : onceki.zaman });
    const canli = durum === 'iniyor' && simdi - sonIlerleme.get(anahtar).zaman < 6000 && inen > 0;
    harita.set(anahtar, { durum, canli, yuzde: boyut > 0 ? Math.min(100, Math.floor((inen / boyut) * 100)) : 0, etiket: etiketBul(anahtar, grup) });
  }
  uygula();
}

let bekliyor = false;
new MutationObserver(() => {
  if (bekliyor) return;
  bekliyor = true;
  requestAnimationFrame(() => { bekliyor = false; uygula(); });
}).observe(document.body, { childList: true, subtree: true });

yenile();
setInterval(yenile, 2000);
