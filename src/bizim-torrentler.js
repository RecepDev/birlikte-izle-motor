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
export function yeniMi(infoHash, ms = 25_000) {
  return Date.now() - (sonKullanim.get(infoHash) || 0) < ms;
}
