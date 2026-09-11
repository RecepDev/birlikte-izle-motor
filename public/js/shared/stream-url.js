// Stremio streaming server URL builders shared by the browser and the server.

export const STREMIO_BASE = 'http://127.0.0.1:11470';

export function torrentPath(stream) {
  const idx = Number.isInteger(stream.fileIdx) ? stream.fileIdx : -1;
  return `/${stream.infoHash}/${idx}`;
}

function trackerQuery(sources) {
  return (sources || [])
    .filter((s) => typeof s === 'string' && (s.startsWith('tracker:') || s.startsWith('dht:')))
    .map((s) => `tr=${encodeURIComponent(s)}`)
    .join('&');
}

// Stremio starts the torrent itself when this URL is requested.
export function localTorrentUrl(stream, base = STREMIO_BASE) {
  const query = trackerQuery(stream.sources);
  return `${base}${torrentPath(stream)}${query ? `?${query}` : ''}`;
}

export function hlsPath(stream) {
  return `${torrentPath(stream)}/hls.m3u8`;
}

// ---- Stremio HLS converter (hlsv2) ----------------------------------------
// The converter copies every track whose codec is listed and converts only the
// rest, so telling it what the browser can decode avoids needless transcoding.

export const HLS_VIDEO_CODECS = ['h264', 'hevc', 'av1'];
export const HLS_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'flac', 'ac3', 'eac3'];

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Converter ids are bound to the stream and codec set, so a relay request can
// never reach a converter created for something else (e.g. Stremio's own app).
export const HLS_4K_WIDTH = 3840;

// Uyumlu mod resolution picker: only the 2160p tier costs the converting
// Stremio real CPU/bandwidth, so it alone is gated behind host/relay4k
// permission (see room.js capsFor and relay.js validateHlsV2).
export const COMPAT_WIDTHS = { '2160p': HLS_4K_WIDTH, '1080p': 1920, '720p': 1280, '480p': 854 };

export function hlsConvertId(stream, caps) {
  const capsKey = fnv1a(`${caps.videoCodecs.join(',')}|${caps.audioCodecs.join(',')}|${caps.maxWidth || ''}`);
  const source = stream.kind === 'torrent'
    ? `${stream.infoHash}-${Number.isInteger(stream.fileIdx) ? stream.fileIdx : 'x'}`
    : `url-${fnv1a(stream.url)}`;
  return `bi-${source}-${capsKey}`;
}

export function hlsMediaUrl(stream, base = STREMIO_BASE) {
  return stream.kind === 'torrent' ? localTorrentUrl(stream, base) : stream.url;
}

export function hlsV2Query(stream, caps, base = STREMIO_BASE) {
  const q = new URLSearchParams({ mediaURL: hlsMediaUrl(stream, base) });
  for (const c of caps.videoCodecs) q.append('videoCodecs', c);
  for (const c of caps.audioCodecs) q.append('audioCodecs', c);
  // Stremio caps converted video at 1920 px wide unless told otherwise.
  if (caps.maxWidth) q.set('maxWidth', String(caps.maxWidth));
  return q;
}

export function hlsV2Path(stream, caps) {
  return `/hlsv2/${hlsConvertId(stream, caps)}/master.m3u8?${hlsV2Query(stream, caps)}`;
}
