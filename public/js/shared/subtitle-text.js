// Subtitle text helpers shared by the server and the browser.

const LANG_ALIASES = {
  tr: 'tur', en: 'eng', de: 'ger', deu: 'ger', fr: 'fre', fra: 'fre', es: 'spa', it: 'ita', ru: 'rus',
  ar: 'ara', pt: 'por', nl: 'dut', nld: 'dut', pl: 'pol', el: 'ell', gre: 'ell', he: 'heb', uk: 'ukr',
  bg: 'bul', ro: 'rum', ron: 'rum', hu: 'hun', cs: 'cze', ces: 'cze', sv: 'swe', fa: 'per', fas: 'per',
  az: 'aze', ja: 'jpn', ko: 'kor', zh: 'chi', zho: 'chi',
};

export const LANG_LABELS = {
  tur: 'Türkçe', eng: 'İngilizce', ger: 'Almanca', fre: 'Fransızca', spa: 'İspanyolca', ita: 'İtalyanca',
  rus: 'Rusça', ara: 'Arapça', por: 'Portekizce', pob: 'Portekizce (BR)', dut: 'Felemenkçe', pol: 'Lehçe',
  ell: 'Yunanca', heb: 'İbranice', ukr: 'Ukraynaca', bul: 'Bulgarca', rum: 'Romence', hun: 'Macarca',
  cze: 'Çekçe', swe: 'İsveççe', per: 'Farsça', aze: 'Azerice', jpn: 'Japonca', kor: 'Korece', chi: 'Çince',
  und: 'Bilinmeyen',
};

const CODE_PAGE = {
  tur: 'windows-1254', aze: 'windows-1254',
  rus: 'windows-1251', ukr: 'windows-1251', bul: 'windows-1251', srp: 'windows-1251', mac: 'windows-1251',
  ell: 'windows-1253', heb: 'windows-1255', ara: 'windows-1256', per: 'windows-1256',
  pol: 'windows-1250', cze: 'windows-1250', hun: 'windows-1250', rum: 'windows-1250', hrv: 'windows-1250',
};

export function normalizeLang(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return 'und';
  return LANG_ALIASES[c] || c;
}

export const langLabel = (code) => LANG_LABELS[normalizeLang(code)] || String(code);

export function decodeSubtitle(bytes, lang) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  const body = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    // Dil bilinmiyorsa (orn. dosya adindan tahmin edilemeyen elle yuklenen altyazi)
    // varsayilan olarak Turkce kod sayfasi kullanilir - bu uygulamanin kullanici
    // kitlesi Turkce oldugu icin "bilinmeyen" neredeyse hep Turkce cikiyor; aksi
    // varsayim (windows-1252) s/i/g gibi harfleri sessizce bozuyordu.
    return new TextDecoder(CODE_PAGE[normalizeLang(lang)] || 'windows-1254').decode(body);
  }
}

const stripTags = (line) =>
  line
    .replace(/\{\\[^}]*\}/g, '') // ASS overrides such as {\an8}
    .replace(/<\/?font[^>]*>/gi, '');

export function srtToVtt(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n');
  const out = lines.map((line) =>
    line.includes('-->')
      ? line.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2')
      : stripTags(line),
  );
  return `WEBVTT\n\n${out.join('\n').replace(/^\n+/, '')}`;
}

export function toVtt(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  return normalized.startsWith('WEBVTT') ? normalized : srtToVtt(normalized);
}

const langRank = (lang) => (lang === 'tur' ? 0 : lang === 'eng' ? 1 : 2);

export function sortSubtitles(list) {
  return list
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const la = normalizeLang(a.s.lang);
      const lb = normalizeLang(b.s.lang);
      return (
        langRank(la) - langRank(lb)
        || (langRank(la) === 2 ? langLabel(la).localeCompare(langLabel(lb), 'tr') : 0)
        || Number(Boolean(b.s.matched)) - Number(Boolean(a.s.matched))
        || a.i - b.i
      );
    })
    .map(({ s }) => s);
}
