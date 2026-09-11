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
