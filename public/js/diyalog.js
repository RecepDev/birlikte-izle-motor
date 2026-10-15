// Uygulama temalı onay / bilgi / metin sorma pencereleri (tarayıcının kendi alert/confirm/prompt'unun yerine).
// <dialog> kullanıyor: masaüstü kabuğu "dialog[open]" görünce oynatıcı penceresini gizleyip kareyi gösteriyor.
// window.alert da buraya bağlanır (beklemeden gösterilir); confirm/prompt eşzamansız: onayla() / sor().
const css = document.createElement('link');
css.rel = 'stylesheet';
css.href = '/css/diyalog.css';
document.head.append(css);

const sira = [];
let acik = false;

function goster({ mesaj, tur, varsayilan = '', tamam = 'Tamam', iptal = 'İptal', tehlike = false }) {
  return new Promise((coz) => {
    sira.push({ mesaj, tur, varsayilan, tamam, iptal, tehlike, coz });
    if (!acik) siradaki();
  });
}

function siradaki() {
  const o = sira.shift();
  if (!o) { acik = false; return; }
  acik = true;
  const d = document.createElement('dialog');
  d.className = 'diyalog';
  const govde = document.createElement('div');
  govde.className = 'diyalog-mesaj';
  govde.textContent = o.mesaj;
  const alan = o.tur === 'sor' ? document.createElement('input') : null;
  if (alan) { alan.type = 'text'; alan.className = 'diyalog-alan'; alan.value = o.varsayilan; }
  const dugmeler = document.createElement('div');
  dugmeler.className = 'diyalog-dugmeler';
  const tamamB = document.createElement('button');
  tamamB.type = 'button';
  tamamB.textContent = o.tamam;
  tamamB.className = o.tehlike ? 'diyalog-tamam tehlike' : 'diyalog-tamam';
  const iptalB = o.tur === 'bildir' ? null : document.createElement('button');
  if (iptalB) { iptalB.type = 'button'; iptalB.textContent = o.iptal; iptalB.className = 'diyalog-iptal'; }
  dugmeler.append(...(iptalB ? [iptalB, tamamB] : [tamamB]));
  d.append(govde, ...(alan ? [alan] : []), dugmeler);
  let sonuc = o.tur === 'sor' ? null : false;
  const bitir = () => {
    if (d.open) d.close();
  };
  tamamB.addEventListener('click', () => { sonuc = o.tur === 'sor' ? alan.value : true; bitir(); });
  iptalB?.addEventListener('click', bitir);
  d.addEventListener('cancel', () => { /* Esc: iptal */ });
  d.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target !== iptalB) { e.preventDefault(); tamamB.click(); } });
  d.addEventListener('click', (e) => { if (e.target === d && o.tur !== 'bildir') bitir(); });
  d.addEventListener('close', () => {
    d.remove();
    o.coz(o.tur === 'bildir' ? undefined : sonuc);
    siradaki();
  });
  document.body.append(d);
  d.showModal();
  (alan || (o.tehlike && iptalB) || tamamB).focus();
  alan?.select();
}

export const onayla = (mesaj, secenek = {}) => goster({ mesaj: String(mesaj), tur: 'onayla', ...secenek });
export const sor = (mesaj, varsayilan = '') => goster({ mesaj: String(mesaj), tur: 'sor', varsayilan });
export const bildir = (mesaj) => goster({ mesaj: String(mesaj), tur: 'bildir' });
window.alert = (mesaj) => { bildir(mesaj); };
