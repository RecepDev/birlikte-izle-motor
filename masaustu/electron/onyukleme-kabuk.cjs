// Her sayfada çalışır. Oda sayfasındaysa video köprüsünü kurar ve video alanının
// ölçüsünü ana sürece bildirir; başlangıç sayfasındaysa yalnızca "odaya git" köprüsü verir.
const { ipcRenderer } = require('electron');

// contextIsolation kapalı: doğrudan sayfanın penceresine yazıyoruz.
window.kabuk = {
  odayaGit: (url) => ipcRenderer.send('kabuk:odaya-git', url),
  sonSunucu: () => ipcRenderer.sendSync('kabuk:son-sunucu'),
  surum: () => ipcRenderer.sendSync('kabuk:surum'),
  sunucular: () => ipcRenderer.invoke('kabuk:sunucular'),
  guncelle: () => ipcRenderer.invoke('kabuk:guncelle'),
  kalite: () => ipcRenderer.sendSync('kabuk:kalite'),
  isim: () => ipcRenderer.sendSync('kabuk:isim'),
  otoKaynak: () => ipcRenderer.sendSync('kabuk:oto'),
  otoKaynakYaz: (acik) => ipcRenderer.send('kabuk:oto-yaz', Boolean(acik)),
  internetMbps: () => ipcRenderer.sendSync('kabuk:internet-mbps'),
  internetMbpsYaz: (mbps) => ipcRenderer.send('kabuk:internet-mbps-yaz', mbps),
  hizliBaslat: () => ipcRenderer.sendSync('kabuk:hizli-baslat'),
  hizliBaslatYaz: (acik) => ipcRenderer.send('kabuk:hizli-baslat-yaz', Boolean(acik)),
  // Sunucu (Kurulumsuz'da kodu yanında): kapalıysa başlatır, paneli bu pencerede açar. { ok } | { error }
  sunucuKodu: () => ipcRenderer.sendSync('kabuk:sunucu-kodu'),
  sunucuAc: () => ipcRenderer.invoke('kabuk:sunucu-ac'),
  isimYaz: (ad) => ipcRenderer.send('kabuk:isim-yaz', ad),
  kaliteYaz: (q) => ipcRenderer.send('kabuk:kalite-yaz', q),
  onbellek: () => ipcRenderer.sendSync('kabuk:onbellek'),
  onbellekYaz: (sn) => ipcRenderer.send('kabuk:onbellek-yaz', sn),
  // Video önbelleği boyutu (GB, elle): { motor, gb } ve yazınca { ok, gb } ya da { error }.
  videoOnbellek: () => ipcRenderer.invoke('kabuk:video-onbellek'),
  videoOnbellekYaz: (gb) => ipcRenderer.invoke('kabuk:video-onbellek-yaz', gb),
  // Önbellek yeri: klasör seçme penceresi (yol ya da null) ve kendi motorunun önbelleğini taşıma.
  klasorSec: (baslik) => ipcRenderer.invoke('kabuk:klasor-sec', baslik),
  videoOnbellekYer: (secilen) => ipcRenderer.invoke('kabuk:video-onbellek-yer', secilen),
  motor: () => ipcRenderer.invoke('kabuk:motor'),
  motorBekciYaz: (acik) => ipcRenderer.invoke('kabuk:motor-bekci-yaz', acik),
  // Canlı yayın: oynatıcı penceresi yakalanabilir durumda mı (bkz. ana.cjs)
  yayinHazir: () => ipcRenderer.invoke('kabuk:yayin-hazir'),
  // Canlı yayın sesi: yalnız oynatıcının (mpv) sesi bir ses izi olarak; olmazsa null.
  uygulamaSesi: () => uygulamaSesiIzi(),
  uygulamaSesiDurdur: () => uygulamaSesiKapat(),
  // Yayına girince kendi Stremio'sundaki torrent'i kapat (indirme boşuna sürmesin).
  torrentKapat: (infoHash) => ipcRenderer.send('kabuk:torrent-kapat', String(infoHash || '')),
};

// mpv'nin sesi (ham PCM, 48 kHz 2 kanal 16 bit) -> MediaStreamTrack. Tüm bilgisayar sesi
// (bildirimler, Discord, tarayıcı) yayına gitmesin diye sistem sesi yerine bu kullanılıyor.
let sesUretici = null;
let sesYazici = null;
let sesZamani = 0;
function uygulamaSesiKapat() {
  ipcRenderer.send('kabuk:uygulama-sesi-durdur');
  try { sesYazici?.close(); } catch { /* */ }
  sesUretici = null;
  sesYazici = null;
}
ipcRenderer.on('kabuk:uygulama-sesi-veri', (_e, parca) => {
  if (!sesYazici) return;
  const bayt = parca instanceof Uint8Array ? parca : new Uint8Array(parca);
  const kare = Math.floor(bayt.byteLength / 4);
  if (!kare) return;
  try {
    const veri = new AudioData({
      format: 's16', sampleRate: 48000, numberOfChannels: 2, numberOfFrames: kare,
      timestamp: sesZamani, data: bayt.slice(0, kare * 4),
    });
    sesZamani += Math.round((kare / 48000) * 1e6);
    sesYazici.write(veri).catch(() => {});
  } catch { /* iz kapandı */ }
});
async function uygulamaSesiIzi() {
  if (typeof MediaStreamTrackGenerator !== 'function' || typeof AudioData !== 'function') return null;
  const res = await ipcRenderer.invoke('kabuk:uygulama-sesi-baslat').catch(() => null);
  if (!res?.ok) return null;
  sesUretici = new MediaStreamTrackGenerator({ kind: 'audio' });
  sesYazici = sesUretici.writable.getWriter();
  sesZamani = 0;
  const iz = sesUretici;
  iz.addEventListener('ended', uygulamaSesiKapat);
  return iz;
}

// Masaüstüne özel düzen: kontroller/bildirimler videonun dışına alınır (mpv üstlerini örter).
// Dosya olarak bağlamak yerine içeriği gömüyoruz: http sayfasından file:// yüklemesi engelleniyor.
function stilEkle() {
  const fs = require('node:fs');
  const path = require('node:path');
  const stil = document.createElement('style');
  stil.textContent = fs.readFileSync(path.join(__dirname, 'masaustu.css'), 'utf8');
  document.head.appendChild(stil);
}

// Oda sayfası mı? Video öğesi orada. mpv, <video> öğesinin kapladığı alana hizalanır.
function olcumKur() {
  const alan = document.getElementById('video');
  if (!alan) return false;
  // Ölçüm boyut değişiminde saniyede onlarca kez tetikleniyor; her seferinde IPC
  // yollamak ve pencereyi taşımak oynatmayı takıltıyordu. Kareye bir kez ve yalnızca
  // ölçü gerçekten değiştiyse yolluyoruz.
  let bekleyen = false;
  let son = '';
  const bildir = () => {
    if (bekleyen) return;
    bekleyen = true;
    requestAnimationFrame(() => {
      bekleyen = false;
      const r = alan.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      // Kontrol kutuları (altyazı, sohbet, bölümler…), çubuk ipucu, "Girişi atla" için mpv
      // penceresinde delik açılıyor: HTML videonun üstünde görünüyor, video küçülmüyor.
      // Kontrol çubuğu için delik yok: o, videonun üstündeki saydam ayrı pencerede (kontrolAynasi).
      const oyn = alan.closest('.player');
      const secici = ['.player > .ctl-pop:not([hidden])', '.seek-tip:not([hidden])', '.skip-intro:not([hidden])', '.intro-ask:not([hidden])', '.next-ep:not([hidden])', '.notice:not([hidden]) .notice-card', '.weak-src:not([hidden])', '.player .banner:not([hidden])'];
      const cubuk = oyn && !oyn.classList.contains('idle') ? oyn.querySelector('.controls')?.getBoundingClientRect() : null;
      const kontrol = cubuk && cubuk.width > 0 && cubuk.height > 0 ? { x: cubuk.x, y: cubuk.y, width: cubuk.width, height: cubuk.height } : null;
      const delikler = secici.flatMap((q) => [...document.querySelectorAll(q)])
        .map((e) => e.getBoundingClientRect())
        .filter((k) => k.width > 0 && k.height > 0)
        .map((k) => ({ x: k.x, y: k.y, width: k.width, height: k.height }));
      const olcu = [r.x, r.y, r.width, r.height, ...delikler.flatMap((d) => [d.x, d.y, d.width, d.height]),
        ...(kontrol ? [kontrol.x, kontrol.y, kontrol.width, kontrol.height] : [-1])].map((n) => Math.round(n)).join('|');
      if (olcu === son) return;
      son = olcu;
      ipcRenderer.send('kabuk:video-alani', { x: r.x, y: r.y, width: r.width, height: r.height, delikler, kontrol });
    });
  };
  new ResizeObserver(bildir).observe(alan);
  const kutuGozcusu = new ResizeObserver(bildir);
  for (const k of document.querySelectorAll('.ctl-pop, .seek-tip, .tab-body[data-tab="subs"], .tab-body[data-tab="chat"]')) kutuGozcusu.observe(k);
  const oynatici = alan.closest('.player');
  // Kutular açılıp kapanınca ve sekmeler oynatıcıya taşınınca.
  if (oynatici) new MutationObserver(bildir).observe(oynatici, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
  ipcRenderer.on('kabuk:olcum-iste', bildir);
  window.addEventListener('scroll', bildir, true);
  document.addEventListener('fullscreenchange', bildir);
  bildir();
  return true;
}

// Saydam kontrol çubuğu: sayfanın kontrol çubuğu videonun arkasında kalıyor; aynası ayrı,
// saydam bir pencerede videonun üstünde çiziliyor (bkz. kontrol-onyukleme.cjs). Buradan
// çubuğun HTML'i gidiyor, oradan tıklama/kaydırma/fare hareketi gelip asıl öğeye uygulanıyor.
function kontrolAynasi() {
  const kok = document.querySelector('.player .controls');
  const oyn = kok?.closest('.player');
  if (!kok) return;
  let sonHtml = '';
  const yolla = () => {
    const kopya = kok.cloneNode(true);
    const asil = kok.querySelectorAll('input');
    kopya.querySelectorAll('input').forEach((g, i) => g.setAttribute('value', asil[i].value));
    const html = kopya.outerHTML;
    if (html === sonHtml) return;
    sonHtml = html;
    ipcRenderer.send('kabuk:kontrol-html', { html, origin: location.origin });
  };
  setInterval(yolla, 200);
  new MutationObserver(() => requestAnimationFrame(yolla))
    .observe(kok, { childList: true, subtree: true, attributes: true, characterData: true });
  kok.addEventListener('input', yolla);
  ipcRenderer.on('kabuk:kontrol-yenile', () => { sonHtml = ''; yolla(); });

  const bul = (yol) => yol.reduce((el, i) => el?.children[i], kok);
  // Tıklamalar ana süreçten executeJavaScript(..., userGesture) ile geliyor (bkz. ana.cjs
  // 'kontrol:olay'): IPC'den gelen el.click() kullanıcı hareketi sayılmıyordu, tam ekrandan çıkar
  // çıkmaz yeniden açma "Permissions check failed" ile reddediliyordu.
  window.__kabukKontrolOlay = (o) => kontrolOlayi(o);
  ipcRenderer.on('kabuk:kontrol-olay', (_e, o) => kontrolOlayi(o));
  function kontrolOlayi(o) {
    if (o.tur === 'leave') {
      document.getElementById('seek')?.dispatchEvent(new PointerEvent('pointerleave'));
      return;
    }
    const el = bul(o.yol || []);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const konum = { clientX: r.left + (o.oranX ?? 0.5) * r.width, clientY: r.top + (o.oranY ?? 0.5) * r.height, bubbles: true };
    if (o.tur === 'click') el.click();
    else if (o.tur === 'input' || o.tur === 'change') {
      el.value = o.deger;
      el.dispatchEvent(new Event(o.tur, { bubbles: true }));
    } else if (o.tur === 'move') {
      el.dispatchEvent(new PointerEvent('pointermove', konum));
      oyn?.dispatchEvent(new MouseEvent('mousemove', konum)); // boşta sayacı: çubuk gizlenmesin
    } else if (o.tur === 'wheel') {
      el.dispatchEvent(new WheelEvent('wheel', { ...konum, deltaY: o.deltaY, cancelable: true }));
    }
  }
}

// mpv yerel pencerede çizdiği için HTML katmanı onun üstüne gelemiyor: bir diyalog
// ya da tam ekran kaplayan bir katman açıkken mpv penceresini gizliyoruz.
// .yayin-katman: canli yayini izlerken (public/js/yayin.js) mpv onun ustunu ortmesin.
const ORTU = 'dialog[open], .overlay:not([hidden]), .compat-screen:not([hidden]), .yayin-katman:not([hidden])';
// Diyalog açıkken mpv gizli: o anki kare video alanında kapak resmi olarak duruyor (bkz. ana.cjs kareGoster).
ipcRenderer.on('kabuk:kare', (_e, veri) => {
  const v = document.getElementById('video');
  if (!v) return;
  // Asıl DOM işlevleriyle: video köprüsü (video-koprusu.cjs) video.removeAttribute'u yalnız "src" için
  // tanımlıyor, kapak resmi kalkmıyordu.
  if (veri) Element.prototype.setAttribute.call(v, 'poster', veri);
  else Element.prototype.removeAttribute.call(v, 'poster');
});
function ortuKur() {
  const bak = () => ipcRenderer.send('kabuk:ortu', Boolean(document.querySelector(ORTU)));
  new MutationObserver(bak).observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'hidden', 'class', 'style'],
  });
  bak();
}

// Sunucu sayfaları (panel, film ara, oda aç) uygulamanın penceresinde: başlık çubuğunun solunda
// "← Ana ekran" (Alt+← de geri gider). Panelin "Kapat" düğmesi pencereyi kapatıyordu (Edge penceresi
// içindi): burada uygulama kapanmasın, ana ekrana dönülsün.
function sunucuSayfasi() {
  if (location.origin !== 'http://127.0.0.1:7301') return;
  const anaEkran = () => ipcRenderer.send('kabuk:baslangic');
  window.close = anaEkran;
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = '← Ana ekran';
  b.title = 'Uygulamanın açılış ekranına dön (Alt+← bir önceki sayfa)';
  b.addEventListener('click', anaEkran);
  const ortak = 'padding:7px 14px;border-radius:999px;border:1px solid #2a2e39;background:#232633;color:#e8e9ee;'
    + 'font:500 13px system-ui,sans-serif;cursor:pointer;white-space:nowrap;';
  // Başlık çubuğu (header.head: solda başlık, sağda düğmeler) varsa solundaki başlıkla yan yana.
  const bas = document.querySelector('header.head');
  if (bas?.firstElementChild) {
    b.style.cssText = ortak;
    const sol = document.createElement('div');
    sol.style.cssText = 'display:flex;align-items:center;gap:14px;min-width:0';
    bas.insertBefore(sol, bas.firstElementChild);
    sol.append(b, sol.nextElementSibling);
  } else {
    b.style.cssText = `${ortak}position:fixed;left:12px;top:12px;z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.45)`;
    document.body.appendChild(b);
  }
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.key !== 'ArrowLeft') return;
    e.preventDefault();
    if (history.length > 1) history.back();
    else anaEkran();
  });
}

function kur() {
  sunucuSayfasi();
  if (!document.getElementById('video')) return;
  stilEkle();
  olcumKur();
  ortuKur();
  kontrolAynasi();
  try {
    require('./video-koprusu.cjs');
  } catch (err) {
    // Sessiz kalmamalı: köprü kurulmazsa sayfa tarayıcı oynatıcısını kullanmaya devam eder
    // ve mpv boş kalır - hata görünmezse bunu anlamak zor.
    console.error('Video köprüsü kurulamadı:', err);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', kur, { once: true });
else kur();
