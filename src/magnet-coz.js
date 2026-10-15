// Magnet bağlantısı çözümleme: arama kutusuna yapıştırılan magnet'ten torrent kimliği, ad ve tracker'lar,
// ve torrent adından film/dizi tahmini (Cinemeta'da aratmak için). Saf fonksiyonlar (ağ yok).

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// 32 karakterlik base32 btih -> 40 karakterlik hex.
function base32Hex(s) {
  let bits = '';
  for (const c of s.toUpperCase()) {
    const i = BASE32.indexOf(c);
    if (i < 0) return null;
    bits += i.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.slice(0, 40);
}

// magnet:?xt=urn:btih:<hash>&dn=<ad>&tr=<tracker>... -> { infoHash, ad, trackerlar } ya da null.
export function magnetCoz(metin) {
  const m = String(metin || '').trim();
  if (!/^magnet:\?/i.test(m)) return null;
  let url;
  try {
    url = new URL(m);
  } catch {
    return null;
  }
  let infoHash = null;
  for (const xt of url.searchParams.getAll('xt')) {
    const b = xt.match(/^urn:btih:([0-9a-zA-Z]+)$/i)?.[1];
    if (!b) continue;
    if (/^[0-9a-f]{40}$/i.test(b)) infoHash = b.toLowerCase();
    else if (/^[A-Za-z2-7]{32}$/.test(b)) infoHash = base32Hex(b);
    if (infoHash) break;
  }
  if (!infoHash || !/^[0-9a-f]{40}$/.test(infoHash)) return null;
  const trackerlar = [...new Set(url.searchParams.getAll('tr')
    .filter((t) => /^(udp|http|https|wss?):\/\//i.test(t)))].slice(0, 40);
  return { infoHash, ad: (url.searchParams.get('dn') || '').slice(0, 300), trackerlar };
}

const SURUM_ARTIKLARI = /\b(2160p|1080p|720p|480p|4k|uhd|hdr10?\+?|hdr|dv|dovi|dolby.?vision|bluray|blu-ray|bdrip|brrip|web-?dl|web-?rip|webrip|web|hdtv|dvdrip|remux|x26[45]|h\.?26[45]|hevc|avc|aac|ddp?\d?\.?\d?|dd\+?|atmos|truehd|dts(-hd)?|10bit|8bit|multi|dual|proper|repack|extended|unrated|imax|amzn|nf|atvp|dsnp|hmax|hulu|pcok)\b/i;

// "Severance.S02E02.Goodbye.Mrs.Selvig.2160p.ATVP.WEB-DL..." -> { sorgu: 'Severance', yil: null, sezon: 2, bolum: 2 }
// "The.Matrix.1999.1080p.BluRay" -> { sorgu: 'The Matrix', yil: 1999, sezon: null, bolum: null }
export function baslikTahmin(ad) {
  let s = String(ad || '').replace(/\.(mkv|mp4|avi|ts|m4v|mov|webm)$/i, '').replace(/[[\]()]/g, ' ');
  s = s.replace(/[._]+/g, ' ');
  let sezon = null;
  let bolum = null;
  const sb = s.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i) || s.match(/\b(\d{1,2})x(\d{2,3})\b/i);
  if (sb) {
    sezon = Number(sb[1]);
    bolum = Number(sb[2]);
  } else {
    const yalnizSezon = s.match(/\bS(\d{1,2})\b(?!\s*E)/i) || s.match(/\bSeason\s+(\d{1,2})\b/i);
    if (yalnizSezon) sezon = Number(yalnizSezon[1]);
  }
  // Başlık: sezon/bölüm, yıl ya da sürüm bilgisinin ilk geçtiği yere kadar.
  const kesimler = [];
  if (sb) kesimler.push(sb.index);
  // İlk yıl başlığın kendisi olabilir ("2001 A Space Odyssey 1968"): baştaki yıl atlanıyor.
  const yilEsle = [...s.matchAll(/\b(19\d{2}|20\d{2})\b/g)].find((x) => x.index > 0);
  let yil = null;
  if (yilEsle) {
    yil = Number(yilEsle[1]);
    kesimler.push(yilEsle.index);
  }
  const artik = s.match(SURUM_ARTIKLARI);
  if (artik && artik.index > 0) kesimler.push(artik.index);
  const sezonKelime = s.match(/\b(S\d{1,2}\b|Season\s+\d)/i);
  if (sezonKelime && sezonKelime.index > 0) kesimler.push(sezonKelime.index);
  const son = kesimler.length ? Math.min(...kesimler) : s.length;
  const sorgu = s.slice(0, son).replace(/\s*-\s*$/, '').replace(/\s+/g, ' ').trim();
  return { sorgu, yil, sezon, bolum };
}

const VIDEO = /\.(mkv|mp4|avi|ts|m4v|mov|webm)$/i;
export const videoMu = (ad) => VIDEO.test(String(ad || ''));
