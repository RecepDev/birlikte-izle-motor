# libtorrent ile video akış sunucusu (ölçüm için). Stremio'nun yaptığını libtorrent'le yapar:
# istenen aralığın parçalarına süre sınırı (set_piece_deadline) verip sırayla okur.
#
#   GET /add?ih=<hash>&idx=<sıra>&tr=<tracker>...   metadata gelince {"boyut": n}
#   GET /stream/<hash>   Range: bytes=a-b  (kapalı aralık)
#   GET /stats/<hash>    {"peers": n, "down": bayt/sn}
#   GET /remove/<hash>   torrent'i ve dosyalarını siler
#
# Çalıştır: python lt_sunucu.py <port> <klasör>

import json
import os
import select
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import libtorrent as lt

PORT = int(sys.argv[1])
KLASOR = sys.argv[2]
ONDEN_BAYT = 64 * 1024 * 1024  # okunan yerin önünde süre sınırı verilen kısım

ses = lt.session({
    'listen_interfaces': '0.0.0.0:6895,[::]:6895',
    'enable_dht': True,
    'enable_lsd': True,
    'enable_upnp': True,
    'enable_natpmp': True,
    'connections_limit': 200,
    'alert_mask': lt.alert_category.status | lt.alert_category.storage | lt.alert_category.error,
})

torrentler = {}  # hash -> {'h': handle, 'idx': int}
parcalar = {}  # (hash, parça) -> bytes
kosul = threading.Condition()


def alarm_dongusu():
    while True:
        ses.wait_for_alert(200)
        for a in ses.pop_alerts():
            if isinstance(a, lt.read_piece_alert):
                with kosul:
                    parcalar[(str(a.handle.info_hash()), a.piece)] = bytes(a.buffer) if not a.error.value() else None
                    kosul.notify_all()


threading.Thread(target=alarm_dongusu, daemon=True).start()


def parca_oku(ih, h, p, iptal):
    h.read_piece(p)
    with kosul:
        while (ih, p) not in parcalar:
            if iptal():
                return None
            kosul.wait(0.5)
        return parcalar.pop((ih, p))


class Isleyici(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def json(self, kod, veri):
        govde = json.dumps(veri).encode()
        self.send_response(kod)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(govde)))
        self.end_headers()
        self.wfile.write(govde)

    def do_GET(self):
        u = urlparse(self.path)
        yol = u.path.strip('/').split('/')
        try:
            if yol[0] == 'add':
                return self.ekle(parse_qs(u.query))
            if yol[0] == 'stream':
                return self.akit(yol[1])
            if yol[0] == 'stats':
                t = torrentler.get(yol[1])
                if not t:
                    return self.json(404, {})
                s = t['h'].status()
                return self.json(200, {'peers': s.num_peers, 'down': s.download_rate})
            if yol[0] == 'remove':
                t = torrentler.pop(yol[1], None)
                if t:
                    ses.remove_torrent(t['h'], lt.session.delete_files)
                return self.json(200, {'ok': True})
            return self.json(404, {})
        except (ConnectionError, BrokenPipeError):
            pass

    def ekle(self, q):
        ih = q['ih'][0].lower()
        idx = int(q.get('idx', ['0'])[0])
        p = lt.parse_magnet_uri(f'magnet:?xt=urn:btih:{ih}')
        p.save_path = KLASOR
        p.trackers = q.get('tr', [])
        p.flags &= ~lt.torrent_flags.auto_managed
        p.flags &= ~lt.torrent_flags.paused
        p.max_connections = 80
        h = ses.add_torrent(p)
        torrentler[ih] = {'h': h, 'idx': idx}
        son = time.time() + 120
        while not h.status().has_metadata:
            if time.time() > son:
                return self.json(504, {'hata': 'metadata'})
            time.sleep(0.1)
        ti = h.torrent_file()
        dosyalar = ti.files()
        if idx >= dosyalar.num_files():
            idx = max(range(dosyalar.num_files()), key=dosyalar.file_size)
            torrentler[ih]['idx'] = idx
        # Yalnız izlenen dosya, en düşük öncelikle (süre sınırlı parçalar her zaman önde).
        h.prioritize_files([1 if i == idx else 0 for i in range(dosyalar.num_files())])
        return self.json(200, {'boyut': dosyalar.file_size(idx)})

    def akit(self, ih):
        t = torrentler.get(ih)
        if not t:
            return self.json(404, {})
        h, idx = t['h'], t['idx']
        ti = h.torrent_file()
        fs = ti.files()
        boyut = fs.file_size(idx)
        ofset = fs.file_offset(idx)
        pl = ti.piece_length()
        aralik = self.headers.get('range', 'bytes=0-').split('=')[1].split('-')
        bas = int(aralik[0])
        son = int(aralik[1]) if aralik[1] else boyut - 1
        son = min(son, boyut - 1)
        if bas > son:
            self.send_response(416)
            self.send_header('content-range', f'bytes */{boyut}')
            self.send_header('content-length', '0')
            self.end_headers()
            return
        self.send_response(206)
        self.send_header('content-type', 'application/octet-stream')
        self.send_header('content-range', f'bytes {bas}-{son}/{boyut}')
        self.send_header('content-length', str(son - bas + 1))
        self.end_headers()
        ilk = (ofset + bas) // pl
        sonp = (ofset + son) // pl
        onden = max(4, ONDEN_BAYT // pl)
        kapandi = [False]
        baglanti = self.connection

        # İstemci bağlantıyı kapattı mı (beklerken de fark edilsin; yoksa eski konumun süre sınırlı
        # parçaları bir sonraki okumanın önünde kalıyor).
        def koptu():
            try:
                hazir, _, _ = select.select([baglanti], [], [], 0)
                return bool(hazir) and baglanti.recv(1, socket.MSG_PEEK) == b''
            except OSError:
                return True

        iptal = lambda: kapandi[0] or ih not in torrentler or koptu()
        sinirli = set()
        try:
            for p in range(ilk, sonp + 1):
                for k in range(p, min(p + onden, sonp + 1)):
                    if k not in sinirli and not h.have_piece(k):
                        h.set_piece_deadline(k, 500 + (k - p) * 150)
                        sinirli.add(k)
                while not h.have_piece(p):
                    if iptal():
                        return
                    time.sleep(0.02)
                veri = parca_oku(ih, h, p, iptal)
                if veri is None:
                    return
                pbas = p * pl
                a = max(ofset + bas, pbas) - pbas
                b = min(ofset + son + 1, pbas + len(veri)) - pbas
                try:
                    self.wfile.write(veri[a:b])
                except (ConnectionError, BrokenPipeError, OSError):
                    kapandi[0] = True
                    return
        finally:
            if ih in torrentler:
                for k in sinirli:
                    if not h.have_piece(k):
                        h.reset_piece_deadline(k)


os.makedirs(KLASOR, exist_ok=True)
print(f'lt hazir {PORT}', flush=True)
ThreadingHTTPServer(('127.0.0.1', PORT), Isleyici).serve_forever()
