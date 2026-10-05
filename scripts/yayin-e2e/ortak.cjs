// Iki test betiginin ortak yardimcilari
const fs = require('node:fs');

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

async function kosulBekle(wc, ifade, ms = 30000, adim = 300) {
  const son = Date.now() + ms;
  while (Date.now() < son) {
    try {
      if (await wc.executeJavaScript(`Boolean(${ifade})`)) return true;
    } catch { /* sayfa yukleniyor */ }
    await bekle(adim);
  }
  return false;
}

// Katilma ekrani aciksa adi yazip katil
async function katil(wc, ad) {
  await kosulBekle(wc, "document.querySelector('#join') || document.querySelector('#app')", 20000);
  await wc.executeJavaScript(`(() => {
    const j = document.querySelector('#join');
    if (!j || j.hidden) return;
    const i = document.querySelector('#join-name');
    if (!i.value) i.value = ${JSON.stringify(ad)};
    document.querySelector('#join-form').requestSubmit();
  })()`);
  return kosulBekle(wc, "!document.querySelector('#app').hidden", 20000);
}

function yaz(dosya, veri) {
  fs.writeFileSync(dosya, JSON.stringify(veri, null, 1));
}

// Ekran kapalı/kilitliyken Windows pencereleri "görünmüyor" sayıyor; Chromium o zaman çizmeyi
// (requestAnimationFrame) durduruyor ve oda sayfası mpv'ye alan bildiremiyordu. Test, kullanıcı
// başında değilken de çalışsın.
function gorunmezlikKapat(app) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

module.exports = { bekle, kosulBekle, katil, yaz, gorunmezlikKapat };
