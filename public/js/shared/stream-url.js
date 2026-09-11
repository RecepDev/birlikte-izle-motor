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
