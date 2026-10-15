// Otomatik kaynak seçimi ("Oda aç" ekranı ve odada bölüm/film değiştirme):
// önce tercih edilen kalite, onun içinde en çok kaynaklı (seed) torrent. O kalitede işe yarar
// kaynak (en az 3 seed) yoksa bir alt kaliteye, o da yoksa üst kaliteye bakılır. Sezon paketleri
// geride (izleyenleri dağınık, yavaş). Saf fonksiyon: sunucu da panel de kullanıyor.

const SIRA = ['2160p', '1080p', '720p', '480p'];
const EN_AZ_SEED = 3;

const puan = (s) => (Number(s.seeders) || 0) * (s.pack ? 0.35 : 1);

// Tercih edilen kaliteden başlayıp önce aşağı, sonra yukarı: 1080p -> 1080p, 720p, 480p, 2160p.
function kaliteSirasi(kalite) {
  const i = SIRA.indexOf(kalite);
  if (i < 0) return SIRA;
  return [...SIRA.slice(i), ...SIRA.slice(0, i).reverse()];
}

// Yayın grubu (dosya adının sonundaki "-FLUX" gibi): aynı dizide iyi çalışan grup hatırlanıyor.
export function grupAdi(s) {
  const satir = String(s?.title || s?.name || '').split('\n')[0].trim();
  const m = satir.match(/-([A-Za-z0-9]{2,20})(?:\.(?:mkv|mp4|avi|ts))?$/i);
  return m ? m[1].toUpperCase() : null;
}

// Kaynak hafızası ({ grup, addon }): dizinin önceki bölümlerinde iyi indiren kaynağın grubu.
// Eşleşenler öne alınıyor (sıra korunarak), böylece önce onlar ölçülüyor/seçiliyor.
export function hafizaOnce(list, hafiza) {
  if (!hafiza?.grup) return list;
  const uyar = (s) => grupAdi(s) === hafiza.grup && (!hafiza.addon || s.addonName === hafiza.addon);
  return [...list.filter(uyar), ...list.filter((s) => !uyar(s))];
}

// İndirme seçenekleri (kullanıcı; bkz. src/indirme-secenek.js): kalite, boyut, hdr, dil, Türkçe altyazı, Blu-ray.
// Seçenekler tek tek süzgeç: eşleşen kaynak kalmazsa o süzgeç gevşetilir (en az önemliden başlayarak) ve
// `gevsetilen` listesinde döner. Süzgeçlerden sonra en çok kaynaklı seçilir; boyut 'kucuk'/'buyuk' ise o boyuta göre.
export const INDIRME_VARSAYILAN = {
  sor: true, kalite: '', boyut: 'fark', boyutMaxGb: null, hdr: 'fark', dil: 'fark', diller: [], favoriDiller: ['tr', 'en'], trAltyazi: 'fark', bluray: 'fark',
};
// İstenen diller: `diller` listesi; eski tek `dil` ayarı da geçerli.
export const istenenDiller = (o) => (Array.isArray(o?.diller) && o.diller.length ? o.diller : (o?.dil && o.dil !== 'fark' ? [o.dil] : []));
export function indirmeSec(streams, secenek, { hafiza = null, kalite = null } = {}) {
  const o = { ...INDIRME_VARSAYILAN, ...(secenek || {}) };
  const torrents = (Array.isArray(streams) ? streams : []).filter((s) => s.kind === 'torrent');
  const saglikli = (s) => (Number(s.seeders) || 0) >= EN_AZ_SEED;
  const adimlar = [
    // Önem sırası: ilk eleman en son gevşetilir.
    ['kalite', o.kalite || kalite ? (s) => s.quality === (o.kalite || kalite) : null],
    ['Türkçe altyazı', o.trAltyazi === 'olsun' ? (s) => (s.embeddedSubs?.langs || []).includes('Türkçe') : null],
    // Dil: seçilen dillerden (birden çok olabilir) en az biri kaynakta geçiyorsa.
    ['dil', istenenDiller(o).length ? (s) => istenenDiller(o).some((k) => (s.diller || []).includes(k) || (k === 'tr' && s.turkceSes === true)) : null],
    ['HDR', o.hdr === 'olsun' ? (s) => Boolean(s.hdr) : (o.hdr === 'olmasin' ? (s) => !s.hdr : null)],
    ['Blu-ray', o.bluray === 'olsun' ? (s) => s.source === 'BluRay' : (o.bluray === 'olmasin' ? (s) => s.source !== 'BluRay' : null)],
    ['boyut sınırı', Number(o.boyutMaxGb) > 0 ? (s) => !s.sizeBytes || s.sizeBytes <= Number(o.boyutMaxGb) * 1024 ** 3 : null],
  ];
  let havuz = torrents;
  const gevsetilen = [];
  // Süzgeçleri önemli olandan başlayarak uygula; sonuç boşsa (ya da hiçbiri sağlıklı değilse) o süzgeç atlanır.
  for (const [ad, f] of adimlar) {
    if (!f) continue;
    const dar = havuz.filter(f);
    if (dar.length && dar.some(saglikli)) havuz = dar; else gevsetilen.push(ad);
  }
  if (!havuz.length) return { secilen: null, gevsetilen };
  const iyi = havuz.filter(saglikli);
  const aday = iyi.length ? iyi : havuz;
  let secilen;
  if (o.boyut === 'kucuk' || o.boyut === 'buyuk') {
    const boyutlu = aday.filter((s) => s.sizeBytes > 0);
    const kaynak = boyutlu.length ? boyutlu : aday;
    secilen = [...kaynak].sort((a, b) => (o.boyut === 'kucuk' ? (a.sizeBytes || 1e15) - (b.sizeBytes || 1e15) : (b.sizeBytes || 0) - (a.sizeBytes || 0)) || puan(b) - puan(a))[0];
  } else {
    // Boyut fark etmez: kaynak hafızası, sonra en çok kaynaklı.
    const hatirlanan = hafiza?.grup ? aday.filter((s) => grupAdi(s) === hafiza.grup).sort((a, b) => puan(b) - puan(a))[0] : null;
    secilen = hatirlanan || [...aday].sort((a, b) => puan(b) - puan(a))[0];
  }
  return { secilen: secilen || null, gevsetilen };
}

// httpOk: doğrudan (debrid) linkler de seçilebilir mi (varsa önce onlar: en hızlı yol).
// hafiza: bkz. hafizaOnce; tercih edilen kalitede yeterli seed'li eşleşen varsa o seçilir.
export function otomatikSec(streams, kalite, { httpOk = false, hafiza = null } = {}) {
  const list = Array.isArray(streams) ? streams : [];
  const sira = kaliteSirasi(kalite);
  if (httpOk) {
    for (const q of sira) {
      const http = list.find((s) => s.kind === 'http' && s.quality === q);
      if (http) return http;
    }
    const http = list.find((s) => s.kind === 'http');
    if (http) return http;
  }
  const torrents = list.filter((s) => s.kind === 'torrent');
  if (hafiza?.grup) {
    const hatirlanan = torrents
      .filter((s) => s.quality === sira[0] && grupAdi(s) === hafiza.grup && (Number(s.seeders) || 0) >= EN_AZ_SEED)
      .sort((a, b) => puan(b) - puan(a))[0];
    if (hatirlanan) return hatirlanan;
  }
  for (const q of sira) {
    const best = torrents.filter((s) => s.quality === q).sort((a, b) => puan(b) - puan(a))[0];
    if (best && (Number(best.seeders) || 0) >= EN_AZ_SEED) return best;
  }
  return [...torrents].sort((a, b) => puan(b) - puan(a))[0] || null;
}
