// OTOMATİK KOPYA: public/js/shared/diller.js ile aynı olmalı (test/diller.test.js denetler). Panel dosyaları statik servis edildiği için
// yeni bir sunucu yolu gerekmiyor (sunucu yeniden başlamadan da çalışır).
// Ses dilleri: indirme seçeneklerindeki "Dil" ve favori diller. DOM'suz, sunucu ve panel ortak kullanır.
// Torrent adlarından dil bulma: bayrak emojileri (Torrentio "🇬🇧 🇹🇷" yazar), dil adları ve ISO kısaltmaları.
// "Altyazı" geçen kısımlar sayılmaz (Türkçe altyazı Türkçe ses değildir).

export const DILLER = [
  { kod: 'tr', ad: 'Türkçe', bayrak: 'TR', desen: /t[uü]rk[cç]e|turkish|\b(tur|tr)\b/i },
  { kod: 'en', ad: 'İngilizce', bayrak: 'GB', bayrak2: 'US', desen: /ingilizce|english|\b(eng|en)\b/i },
  { kod: 'de', ad: 'Almanca', bayrak: 'DE', desen: /almanca|german|deutsch|\b(ger|deu)\b/i },
  { kod: 'fr', ad: 'Fransızca', bayrak: 'FR', desen: /frans[ıi]zca|french|fran[cç]ais|\b(fre|fra|vff|vfq)\b/i },
  { kod: 'es', ad: 'İspanyolca', bayrak: 'ES', bayrak2: 'MX', desen: /[ıi]spanyolca|spanish|espa[nñ]ol|latino|castellano|\b(spa|esp)\b/i },
  { kod: 'it', ad: 'İtalyanca', bayrak: 'IT', desen: /italyanca|italian|italiano|\b(ita)\b/i },
  { kod: 'pt', ad: 'Portekizce', bayrak: 'PT', bayrak2: 'BR', desen: /portekizce|portuguese|portugu[eê]s|\b(por|ptbr|pt-br)\b/i },
  { kod: 'ru', ad: 'Rusça', bayrak: 'RU', desen: /rus[cç]a|russian|\b(rus)\b/i },
  { kod: 'ja', ad: 'Japonca', bayrak: 'JP', desen: /japonca|japanese|\b(jpn|jap)\b/i },
  { kod: 'ko', ad: 'Korece', bayrak: 'KR', desen: /korece|korean|\b(kor)\b/i },
  { kod: 'zh', ad: 'Çince', bayrak: 'CN', bayrak2: 'TW', desen: /[cç]ince|chinese|mandarin|cantonese|\b(chi|zho|chs|cht)\b/i },
  { kod: 'hi', ad: 'Hintçe', bayrak: 'IN', desen: /hint[cç]e|hindi|\b(hin)\b/i },
  { kod: 'ar', ad: 'Arapça', bayrak: 'SA', bayrak2: 'EG', desen: /arap[cç]a|arabic|\b(ara)\b/i },
  { kod: 'pl', ad: 'Lehçe', bayrak: 'PL', desen: /leh[cç]e|polish|polski|\b(pol)\b/i },
  { kod: 'nl', ad: 'Hollandaca', bayrak: 'NL', desen: /hollandaca|dutch|\b(dut|nld)\b/i },
  { kod: 'sv', ad: 'İsveççe', bayrak: 'SE', desen: /isve[cç]ce|swedish|\b(swe)\b/i },
  { kod: 'uk', ad: 'Ukraynaca', bayrak: 'UA', desen: /ukraynaca|ukrainian|\b(ukr)\b/i },
  { kod: 'he', ad: 'İbranice', bayrak: 'IL', desen: /ibranice|hebrew|\b(heb)\b/i },
  { kod: 'el', ad: 'Yunanca', bayrak: 'GR', desen: /yunanca|greek|\b(gre|ell)\b/i },
  { kod: 'fa', ad: 'Farsça', bayrak: 'IR', desen: /fars[cç]a|persian|farsi/i },
  { kod: 'th', ad: 'Tayca', bayrak: 'TH', desen: /tayca|thai|\b(tha)\b/i },
  { kod: 'id', ad: 'Endonezce', bayrak: 'ID', desen: /endonezce|indonesian/i },
];

export const DIL_KODLARI = DILLER.map((d) => d.kod);
export const dilAdi = (kod) => DILLER.find((d) => d.kod === kod)?.ad || kod;

// "🇹🇷" -> "TR" (iki bölgesel gösterge simgesi).
function bayrakKodlari(metin) {
  const kodlar = new Set();
  for (const m of String(metin).matchAll(/[\u{1F1E6}-\u{1F1FF}]{2}/gu)) {
    const [a, b] = [...m[0]].map((c) => String.fromCharCode(c.codePointAt(0) - 0x1F1E6 + 65));
    kodlar.add(a + b);
  }
  return kodlar;
}

// Altyazı anlatan kısımları (ve sonrasındaki dil listesini) ses aramasından çıkarır: "Sub (Eng Tur)", "TR Altyazı", "Subs: ...".
function altyaziyiAt(metin) {
  return String(metin)
    .replace(/\bsubs?\s*\([^)]*\)/gi, ' ')
    .replace(/\b(subs?|subtitles?|esubs?|msubs?)\b[:\s-]*[^\n|]*/gi, ' ')
    .replace(/(\S+\s+)?alt\s?yaz[ıi]\w*/gi, ' ');
}

// Torrent adında geçen ses dilleri (kod listesi).
export function sesDilleri(metin) {
  const temiz = altyaziyiAt(metin);
  const bayraklar = bayrakKodlari(temiz);
  const bulunan = [];
  for (const d of DILLER) {
    if (bayraklar.has(d.bayrak) || (d.bayrak2 && bayraklar.has(d.bayrak2)) || d.desen.test(temiz)) bulunan.push(d.kod);
  }
  // Çift/çoklu ses işareti olup hiçbir dil yoksa bilinmiyor (boş liste).
  return bulunan;
}
