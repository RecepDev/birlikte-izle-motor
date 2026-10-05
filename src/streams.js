// Turns raw addon stream objects into the room's stream list.

import { dosyaAdiKaydet } from './motor/dosya-adlari.js';

const INFO_HASH = /^[0-9a-f]{40}$/i;
const UNITS = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

export function parseQuality(text) {
  const t = String(text || '').toLowerCase();
  if (/2160p|\b4k\b|\buhd\b/.test(t)) return '2160p';
  if (/1080p/.test(t)) return '1080p';
  if (/720p/.test(t)) return '720p';
  if (/480p/.test(t)) return '480p';
  return null;
}

// Video formats browsers often cannot decode (black picture, sound only).
export function parseVideoRisk(text) {
  const t = String(text || '');
  if (/\b(dv|dovi)\b|dolby.?vision/i.test(t)) return 'Dolby Vision';
  if (/x\.?265|hevc|h\.?265/i.test(t)) return 'HEVC';
  if (/\bav1\b/i.test(t)) return 'AV1';
  return null;
}

// Audio formats browsers commonly cannot decode at all (picture plays, no sound).
// Detecting this live in the browser is unreliable on Chrome/Edge (no
// webkitAudioDecodedByteCount there), so it's flagged from the release name
// up front instead, the same way parseVideoRisk covers the picture side.
export function parseAudioRisk(text) {
  const t = String(text || '');
  if (/\btrue.?hd\b/i.test(t)) return 'TrueHD';
  if (/\bdts.?(hd|x|ma)\b/i.test(t)) return 'DTS-HD';
  if (/\bdts\b/i.test(t)) return 'DTS';
  if (/\be-?ac-?3\b|\bddp\d*\b|\bdd\+/i.test(t)) return 'E-AC3';
  if (/\bac-?3\b|dolby.?digital/i.test(t)) return 'AC3';
  return null;
}

// HDR content often looks dark or washed out on SDR screens.
export function parseHdr(text) {
  const t = String(text || '');
  if (/\b(dv|dovi)\b|dolby.?vision/i.test(t)) return 'Dolby Vision';
  if (/hdr10\+|hdr10plus/i.test(t)) return 'HDR10+';
  if (/\bhdr(10)?\b|\bhlg\b/i.test(t)) return 'HDR';
  return null;
}

// Subtitles inside the file itself, as release names announce them:
// "Sub (Rus Ukr Eng)", "Multi Subs", "ESub", "TR Altyazı"... Returns { langs } or null.
const SUB_LANGS = { eng: 'İngilizce', rus: 'Rusça', ukr: 'Ukraynaca', heb: 'İbranice', tur: 'Türkçe', tr: 'Türkçe', ita: 'İtalyanca', fre: 'Fransızca', fra: 'Fransızca', ger: 'Almanca', deu: 'Almanca', spa: 'İspanyolca', por: 'Portekizce', ara: 'Arapça', pol: 'Lehçe' };
export function parseEmbeddedSubs(text) {
  const t = String(text || '');
  const listed = t.match(/\bsubs?\s*\(([^)]+)\)/i);
  if (listed) {
    const langs = listed[1].split(/[\s,/+]+/).map((w) => SUB_LANGS[w.toLowerCase()] || w).filter(Boolean);
    return { langs };
  }
  if (/\besubs?\b/i.test(t)) return { langs: ['İngilizce'] };
  if (/altyaz[ıi]|\btr\.?sub/i.test(t)) return { langs: ['Türkçe'] };
  if (/multi.?subs?|\bsubs\b|\bsubbed\b|\bsub\b/i.test(t)) return { langs: [] };
  return null;
}

// Release names announcing more than one audio language: "Dual Audio",
// "Türkçe Dublaj", "TR+EN"... The browser needs Uyumlu mod (hls.js) to ever
// expose alternate audio tracks for MKV, so this is just a heads-up to try it.
export function parseMultiAudio(text) {
  const t = String(text || '');
  if (/dual[\s.-]?audio|multi[\s.-]?audio|\b2\s?audio\b/i.test(t)) return true;
  if (/dublaj/i.test(t)) return true;
  if (/\b(tr|tur)\s*[+/&]\s*(en|eng)\b|\b(en|eng)\s*[+/&]\s*(tr|tur)\b/i.test(t)) return true;
  // Russian-scene release convention (HDRezka etc.): a named dub/voice-over
  // track listed alongside "Original" ("MVO + Original") means 2+ audio tracks.
  if (/\b(mvo|dvo|avo)\b/i.test(t)) return true;
  if (/\+\s*original\b|\boriginal\s*\+/i.test(t)) return true;
  if (/дубляж|многоголос|двухголос|одноголос/i.test(t)) return true;
  return false;
}

// Sezon paketi mi (tek bölüm değil)? Pakette izleyenler dağınık, kaynak çabuk azalıyor.
// "S03E05" gibi tek bölüm işareti varsa paket değil.
export function parsePack(text) {
  const t = String(text);
  if (/S\d{1,2}\s?E\d{1,3}(?!\d)(?!\s?-\s?E?\d)/i.test(t) || /\b\d{1,2}x\d{2}\b/.test(t)) return false;
  return /season|sezon|сезон|complete|pack|\bS\d{1,2}\b|S\d{1,2}E\d{1,3}\s?-\s?E?\d|серии:\s*\d+\s*-\s*\d+/i.test(t);
}

// En iyi kaynak: aynı kalite (verildiyse), tek bölüm, çok kaynak (seeder). Doğrudan linkler
// torrentlerden önce (kaynak sorunu yok).
export function bestStream(streams, preferQuality = null) {
  const puan = (s) => {
    if (s.kind === 'http') return 1e9;
    let p = Number(s.seeders) || 0;
    if (s.pack) p *= 0.35;
    if (preferQuality && s.quality === preferQuality) p *= 3;
    return p;
  };
  return [...streams].sort((a, b) => puan(b) - puan(a))[0] || null;
}

export function parseSizeBytes(raw) {
  const hinted = raw?.behaviorHints?.videoSize;
  if (Number.isFinite(hinted) && hinted > 0) return hinted;
  const text = `${raw?.title || ''} ${raw?.description || ''} ${raw?.name || ''}`;
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(KB|MB|GB|TB)\b/i);
  if (!m) return null;
  return Number(m[1].replace(',', '.')) * UNITS[m[2].toUpperCase()];
}

function cleanSubtitles(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//.test(s.url))
    .map((s) => ({ id: String(s.id ?? s.url), url: s.url, lang: String(s.lang || 'und') }));
}

// Ek tracker'lar (bkz. torrent-hiz.js): her torrent'in kaynak listesine ekleniyor.
let extraSources = [];
export function setExtraSources(list) {
  extraSources = Array.isArray(list) ? list : [];
}

function normalizeOne(raw, addonName) {
  if (!raw || typeof raw !== 'object') return null;
  const base = {
    addonName,
    name: String(raw.name || ''),
    title: String(raw.title || raw.description || ''),
  };
  base.quality = parseQuality(`${base.name} ${base.title}`);
  base.videoRisk = parseVideoRisk(`${base.name} ${base.title}`);
  base.audioRisk = parseAudioRisk(`${base.name} ${base.title}`);
  base.hdr = parseHdr(`${base.name} ${base.title}`);
  // Torrentio puts the seeder count in the title as "👤 123".
  const seeders = `${base.title} ${base.name}`.match(/👤\s*(\d+)/);
  base.seeders = seeders ? Number(seeders[1]) : null;
  base.embeddedSubs = parseEmbeddedSubs(`${base.name} ${base.title}`);
  base.multiAudio = parseMultiAudio(`${base.name} ${base.title}`);
  base.pack = parsePack(`${base.name} ${base.title}`);
  base.sizeBytes = parseSizeBytes(raw);
  const notWebReady = raw.behaviorHints?.notWebReady === true;
  const subtitles = cleanSubtitles(raw.subtitles);

  if (typeof raw.infoHash === 'string') {
    if (!INFO_HASH.test(raw.infoHash)) return null;
    // Dosya adı: TorrServer motorunda dosya sırası kayabiliyor, adla eşleştiriliyor (src/motor/).
    const filename = typeof raw.behaviorHints?.filename === 'string' ? raw.behaviorHints.filename : null;
    dosyaAdiKaydet(raw.infoHash.toLowerCase(), raw.fileIdx, filename);
    return {
      kind: 'torrent',
      ...base,
      filename,
      infoHash: raw.infoHash.toLowerCase(),
      fileIdx: Number.isInteger(raw.fileIdx) ? raw.fileIdx : null,
      sources: [...new Set([...(raw.sources || []).filter(
        (s) => typeof s === 'string' && (s.startsWith('tracker:') || s.startsWith('dht:')),
      ), ...extraSources])],
      url: null,
      notWebReady,
      subtitles,
    };
  }
  if (typeof raw.url === 'string' && /^https?:\/\//.test(raw.url)) {
    // Streams that need custom request headers cannot be played by a browser.
    if (raw.behaviorHints?.proxyHeaders) return null;
    return {
      kind: 'http',
      ...base,
      infoHash: null,
      fileIdx: null,
      sources: [],
      url: raw.url,
      notWebReady,
      subtitles,
    };
  }
  return null;
}

// addonResults: [{ addonName, streams: [raw] }]
// One addon's raw streams -> normalized ones, streamIds continuing from
// startIndex (so a caller can normalize addons one at a time as they arrive
// and still end up with the same globally-unique ids as normalizeStreams).
export function normalizeAddonStreams(addonName, rawStreams, startIndex = 0) {
  const out = [];
  for (const raw of rawStreams || []) {
    const s = normalizeOne(raw, addonName);
    if (s) out.push({ streamId: `s${startIndex + out.length + 1}`, ...s });
  }
  return out;
}

export function normalizeStreams(addonResults) {
  const out = [];
  for (const { addonName, streams } of addonResults) {
    out.push(...normalizeAddonStreams(addonName, streams, out.length));
  }
  return out;
}

// Guests never see HTTP links other than the one the host is playing:
// those links usually carry the host's debrid key.
export function guestStreamList(streams, hostStreamId) {
  return streams.filter((s) => s.kind === 'torrent' || s.streamId === hostStreamId);
}
