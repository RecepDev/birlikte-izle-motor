// Tanı kaydı: bu cihazın oynatıcısında olanlar (durum geçişleri, sarmalar, sapma, hız, hatalar)
// 10 sn'de bir sunucuya gidiyor (bkz. src/tani.js). Host, İzleyiciler'de kişinin kaydını açabiliyor.

const BEKLEYEN_EN_FAZLA = 400;

export function createTani({ request }) {
  const bekleyen = [];

  function kaydet(k, veri = {}) {
    bekleyen.push({ t: Date.now(), k, ...veri });
    if (bekleyen.length > BEKLEYEN_EN_FAZLA) bekleyen.splice(0, bekleyen.length - BEKLEYEN_EN_FAZLA);
  }

  let gonderiliyor = false;
  async function gonder() {
    if (gonderiliyor || !bekleyen.length) return;
    gonderiliyor = true;
    const parti = bekleyen.splice(0, 200);
    const res = await request('tani', { entries: parti });
    // Gidemediyse (bağlantı yok) başa geri koy; sonra tekrar denenir.
    if (!res || res.error) bekleyen.unshift(...parti.slice(-(BEKLEYEN_EN_FAZLA - bekleyen.length)));
    gonderiliyor = false;
  }
  setInterval(gonder, 10_000);

  return { kaydet, gonder };
}

// Host'un gördüğü metin: "12:03:15.2 durum ready local" gibi satırlar.
export function taniMetni(entries) {
  return entries.map((e) => {
    const { t, k, ...veri } = e;
    const d = new Date(t);
    const saat = `${d.toLocaleTimeString('tr-TR')}.${String(Math.floor(d.getMilliseconds() / 100))}`;
    const ayrinti = Object.entries(veri)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([a, v]) => `${a}=${typeof v === 'number' ? Math.round(v * 100) / 100 : typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    return `${saat}  ${k}  ${ayrinti}`;
  }).join('\n');
}
