// Bu sunucunun Stremio'da açtırabildiği torrent'ler (oda kaynakları, "Oda aç" ekranında
// listelenen/denetlenenler, sonraki bölüm). Hiçbir oda ya da denetim kullanmıyorsa kapatılıyor:
// yoksa oda yokken bile Stremio arkada onları indirip interneti yiyordu. Kişinin Stremio
// uygulamasında kendi açtığı (bizim listemizde olmayan) torrent'lere dokunulmuyor.

const bilinen = new Set();
const sonKullanim = new Map(); // infoHash -> en son dokunulduğu an

export function kaydet(streams) {
  for (const s of streams || []) {
    if (s?.kind === 'torrent' && s.infoHash) bilinen.add(s.infoHash);
  }
}

// Az önce açıldı/denetlendi: bir süre kapatma (sonuç ölçülüyor olabilir).
export function dokun(infoHash) {
  if (infoHash) {
    bilinen.add(infoHash);
    sonKullanim.set(infoHash, Date.now());
  }
}

export function bizimMi(infoHash) {
  return bilinen.has(infoHash);
}

// Açık kalma payı: "Oda aç" sayfası açıkken 8 sn'de bir dokunuyor; sayfa kapanınca/arka plana
// geçince en geç bu kadar sonra kapanıyor.
// Herkes çıkmış oda da kullanmıyor sayılır (30 sn sonra; sayfa yenileme/kısa kopma için pay).
// Hiç kimse girmemiş yeni oda: host panelden odaya geçiyor olabilir, 3 dk bekleniyor.
export function odaBosMu(r) {
  if (r.connectedUsers().length || r.emptySince === null) return false;
  return r.now() - r.emptySince > (r.users.size ? 30_000 : 180_000);
}

// Stremio'da açık olanlardan kapatılacaklar: bizim açtırdığımız, hiçbir dolu odanın izlemediği,
// denetlenmeyen ve son 25 sn'de dokunulmamış torrent'ler.
export function kapatilacaklar({ acik, rooms, denetlenen = [] }) {
  const kullanilan = new Set(denetlenen);
  for (const r of rooms) {
    kaydet(r.streams);
    if (odaBosMu(r)) continue;
    for (const id of r.statsStreamIds()) {
      const h = r.streams.find((s) => s.streamId === id)?.infoHash;
      if (h) kullanilan.add(h);
    }
  }
  return acik.filter((h) => bizimMi(h) && !kullanilan.has(h) && !yeniMi(h));
}

export function yeniMi(infoHash, ms = 25_000) {
  return Date.now() - (sonKullanim.get(infoHash) || 0) < ms;
}
