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
