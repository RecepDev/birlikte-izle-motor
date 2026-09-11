// Turns raw addon stream objects into the room's stream list.

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

function normalizeOne(raw, addonName) {
  if (!raw || typeof raw !== 'object') return null;
  const base = {
    addonName,
    name: String(raw.name || ''),
    title: String(raw.title || raw.description || ''),
  };
  base.quality = parseQuality(`${base.name} ${base.title}`);
  base.videoRisk = parseVideoRisk(`${base.name} ${base.title}`);
  base.hdr = parseHdr(`${base.name} ${base.title}`);
  // Torrentio puts the seeder count in the title as "👤 123".
  const seeders = `${base.title} ${base.name}`.match(/👤\s*(\d+)/);
  base.seeders = seeders ? Number(seeders[1]) : null;
  base.embeddedSubs = parseEmbeddedSubs(`${base.name} ${base.title}`);
  base.sizeBytes = parseSizeBytes(raw);
  const notWebReady = raw.behaviorHints?.notWebReady === true;
  const subtitles = cleanSubtitles(raw.subtitles);

  if (typeof raw.infoHash === 'string') {
    if (!INFO_HASH.test(raw.infoHash)) return null;
    return {
      kind: 'torrent',
      ...base,
      infoHash: raw.infoHash.toLowerCase(),
      fileIdx: Number.isInteger(raw.fileIdx) ? raw.fileIdx : null,
      sources: (raw.sources || []).filter(
        (s) => typeof s === 'string' && (s.startsWith('tracker:') || s.startsWith('dht:')),
      ),
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
export function normalizeStreams(addonResults) {
  const out = [];
  for (const { addonName, streams } of addonResults) {
    for (const raw of streams || []) {
      const s = normalizeOne(raw, addonName);
      if (s) out.push({ streamId: `s${out.length + 1}`, ...s });
    }
  }
  return out;
}

// Guests never see HTTP links other than the one the host is playing:
// those links usually carry the host's debrid key.
export function guestStreamList(streams, hostStreamId) {
  return streams.filter((s) => s.kind === 'torrent' || s.streamId === hostStreamId);
}
