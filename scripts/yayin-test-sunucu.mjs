// Canlı yayın uçtan uca testi için küçük sunucu: gerçek oda yöneticisi, socket katmanı, yayın
// modülü ve asıl oda sayfası; ama addon/Stremio/torrent YOK. Oda, yerel bir test videosuna giden
// tek bir http kaynağıyla açılır. Kullanıcının sunucusuna, Stremio'suna ve verisine dokunmaz.
//
// Kullanım: node scripts/yayin-test-sunucu.mjs <test.mp4> [port]
// Çıktı (stdout, tek satır JSON): { "odaUrl", "hostUrl" }
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { createRoomManager } from '../src/rooms.js';
import { attachSocket } from '../src/socket.js';
import { normalizeStreams } from '../src/streams.js';
import { createYayin } from '../src/yayin.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const video = process.argv[2];
const port = Number(process.argv[3]) || 7200;
const base = `http://127.0.0.1:${port}`;
const sessiz = { info() {}, warn() {}, error: (...a) => console.error(...a) };

const app = express();
app.get('/test.mp4', (req, res) => res.sendFile(path.resolve(video)));
app.get(['/room', '/room/', '/room/:id'], (req, res) => res.sendFile(path.join(ROOT, 'public', 'room.html')));
app.get('/vendor/hls.min.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules', 'hls.js', 'dist', 'hls.min.js')));
app.use(express.static(path.join(ROOT, 'public'), { index: false }));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 100_000, serveClient: true });
const rooms = createRoomManager();
const yayin = createYayin({ log: sessiz });
attachSocket(io, {
  rooms,
  log: sessiz,
  hooks: {
    onRoomClosed: (room) => yayin.kapat(room.id),
    onJoin: (room, uid) => yayin.onJoin(room, uid),
    yayinDurumu: (room) => yayin.katilmaDurumu(room),
    onDisconnect: (room, uid) => yayin.onDisconnect(room, uid),
    roomEvents: { ...yayin.events },
  },
});

const streams = normalizeStreams([{ addonName: 'Test', streams: [{ name: 'Test 720p', title: 'Yayın testi 720p', url: `${base}/test.mp4` }] }]);
const { room, creatorToken } = rooms.create({
  type: 'movie',
  contentId: 'tt-yayin-testi',
  meta: { name: 'Yayın testi' },
  streams,
  hostStreamId: streams[0].streamId,
  // "herkes beklesin": yayını izleyenin (kendi oynatıcısı boşta) odayı bekletmediği de sınanır
  settings: { ...DEFAULT_CONFIG.defaults, waitMode: 'wait' },
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({
    odaUrl: `${base}/room/${room.id}`,
    hostUrl: `${base}/room/${room.id}#host=${creatorToken}&name=TestHost`,
  }));
});
