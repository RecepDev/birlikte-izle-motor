// Turns a pasted magnet link (or a bare infoHash) into a raw addon-style torrent stream,
// ready for normalizeAddonStreams.

const HEX = /^[0-9a-f]{40}$/i;
const BASE32 = /^[a-z2-7]{32}$/i;
const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const MAX_LENGTH = 4000;

function base32ToHex(text) {
  let bits = '';
  for (const c of text.toLowerCase()) bits += B32_ALPHABET.indexOf(c).toString(2).padStart(5, '0');
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.slice(0, 40);
}

// Returns { name, title, infoHash, fileIdx?, sources } or null when it is not a usable magnet.
export function parseMagnet(input) {
  const text = String(input || '').trim();
  if (!text || text.length > MAX_LENGTH) return null;
  if (HEX.test(text)) return { name: 'Magnet', title: text.toLowerCase(), infoHash: text.toLowerCase(), sources: [`dht:${text.toLowerCase()}`] };
  if (!/^magnet:\?/i.test(text)) return null;

  let params;
  try {
    params = new URLSearchParams(text.slice(text.indexOf('?') + 1));
  } catch {
    return null;
  }
  const btih = params.getAll('xt').map((x) => x.match(/^urn:btih:(.+)$/i)?.[1]).find(Boolean);
  let infoHash = null;
  if (btih && HEX.test(btih)) infoHash = btih.toLowerCase();
  else if (btih && BASE32.test(btih)) infoHash = base32ToHex(btih);
  if (!infoHash || !HEX.test(infoHash)) return null;

  const name = (params.get('dn') || 'Magnet').trim().slice(0, 200) || 'Magnet';
  const trackers = params.getAll('tr').filter((t) => /^(udp|http|https|wss?):\/\//i.test(t)).slice(0, 30);
  const stream = {
    name,
    title: name,
    infoHash,
    sources: [...trackers.map((t) => `tracker:${t}`), `dht:${infoHash}`],
  };
  // "so=" (select only) names the file inside a multi-file torrent.
  const so = Number.parseInt(params.get('so') ?? '', 10);
  if (Number.isInteger(so) && so >= 0) stream.fileIdx = so;
  return stream;
}
