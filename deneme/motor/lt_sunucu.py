# libtorrent ile video akış sunucusu (ölçüm için). Stremio'nun yaptığını libtorrent'le yapar:
# istenen aralığın parçalarına süre sınırı (set_piece_deadline) verip sırayla okur.
#
#   GET /add?ih=<hash>&idx=<sıra>&tr=<tracker>...   metadata gelince {"boyut": n}
#   GET /stream/<hash>   Range: bytes=a-b
#   GET /stats/<hash>    {"peers": n, "down": bayt/sn}
#   GET /remove/<hash>   torrent'i ve dosyalarını siler
#
# Çalıştır: python lt_sunucu.py <port> <klasör>
#
# İlk sürüme göre (ölçümde sarma 9 sn, izleme 15 Mbps):
# - Tüm tracker'lara aynı anda soruluyor (libtorrent varsayılanı tek tracker), bağlantı daha hızlı kuruluyor.
# - Yavaş kaynaktaki parça 5 sn'de başka kaynaktan isteniyor; süre sınırları 100 ms'de bir işleniyor.
# - Parça bekleme yoklama yerine "parça bitti" alarmıyla; okumalar önden (3 parça) isteniyor.
# - Sarmada eski konumun süre sınırları kaldırılıp önceliği düşürülüyor (yeni konumla yarışmasın).

import json
import os
import select
import socket
import sys
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import libtorrent as lt

PORT = int(sys.argv[1])
KLASOR = sys.argv[2]
# Okunan yerin önü: ilk kısım süre sınırlı (libtorrent'in "acil" parçaları; çok olursa yavaşlıyor),
# arkası en yüksek öncelikle.
SINIRLI_BAYT = 16 * 1024 * 1024
SINIRLI_EN_COK = 24
ONCELIKLI_BAYT = 96 * 1024 * 1024
HEDEF_HIZ = 6 * 1024 * 1024  # süre sınırlarının aralığı bu hıza göre (bayt/sn, ~50 Mbps)
ONDEN_OKUMA = 3  # diskten önden istenen parça sayısı
ONBELLEK_BAYT = 256 * 1024 * 1024  # okunmuş parçalar (aynı yeri okuyan iki istek için)

AYARLAR = {
    'listen_interfaces': '0.0.0.0:6895,[::]:6895',
    'enable_dht': True,
    'enable_lsd': True,
    'enable_upnp': True,
    'enable_natpmp': True,
    'connections_limit': 400,
    'announce_to_all_trackers': True,
    'announce_to_all_tiers': True,
    'connection_speed': 100,
    'torrent_connect_boost': 80,
    'smooth_connects': False,
    'peer_connect_timeout': 7,
    'piece_timeout': 5,
    'request_timeout': 10,
    'tick_interval': 100,
    'strict_end_game_mode': False,
    'max_out_request_queue': 5000,
    'alert_mask': lt.alert_category.status | lt.alert_category.storage | lt.alert_category.error | lt.alert_category.piece_progress,
}
ses = lt.session(AYARLAR)

# hash -> {'h': handle, 'idx': int, 'var': inmiş parçalar}. "Var mı" libtorrent'e sorulmuyor: her soru
# libtorrent'in iş parçacığını bekletiyor, parça başına yüzlerce soru akışı 1 Mbps'e düşürüyordu.
torrentler = {}
parcalar = OrderedDict()  # (hash, parça) -> bytes
istenen = set()  # okuması istenmiş (hash, parça)
kosul = threading.Condition()


def alarm_dongusu():
    while True:
        ses.wait_for_alert(100)
        alarmlar = ses.pop_alerts()
        if not alarmlar:
            continue
        with kosul:
            for a in alarmlar:
                if isinstance(a, lt.piece_finished_alert):
                    t = torrentler.get(str(a.handle.info_hash()))
                    if t:
                        t['var'].add(a.piece_index)
                elif isinstance(a, lt.read_piece_alert):
                    anahtar = (str(a.handle.info_hash()), a.piece)
                    istenen.discard(anahtar)
                    if not a.error.value():
                        parcalar[anahtar] = bytes(a.buffer)
                        parcalar.move_to_end(anahtar)
                        toplam = sum(len(v) for v in parcalar.values())
                        while toplam > ONBELLEK_BAYT and len(parcalar) > ONDEN_OKUMA * 2:
                            _, eski = parcalar.popitem(last=False)
                            toplam -= len(eski)
            kosul.notify_all()


threading.Thread(target=alarm_dongusu, daemon=True).start()


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
                    with kosul:
                        for k in [k for k in parcalar if k[0] == yol[1]]:
                            del parcalar[k]
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
        torrentler[ih] = {'h': h, 'idx': idx, 'var': set()}
        son = time.time() + 120
        while not h.status().has_metadata:
            if time.time() > son:
                return self.json(504, {'hata': 'metadata'})
            time.sleep(0.05)
        ti = h.torrent_file()
        dosyalar = ti.files()
        if idx < 0 or idx >= dosyalar.num_files():
            idx = max(range(dosyalar.num_files()), key=dosyalar.file_size)
            torrentler[ih]['idx'] = idx
        # Yalnız izlenen dosya, en düşük öncelikle: süre sınırlı parçalar her zaman önde. Hepsi 0
        # olursa torrent "bitti" sayılıp kaynaklarla bağlantı kesiliyor, o yüzden 1.
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
        son = min(int(aralik[1]) if aralik[1] else boyut - 1, boyut - 1)
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
        sinirli_adet = max(2, min(SINIRLI_EN_COK, SINIRLI_BAYT // pl))
        oncelikli_adet = max(sinirli_adet, ONCELIKLI_BAYT // pl)
        adim_ms = max(50, int(pl * 1000 / HEDEF_HIZ))
        var = t['var']
        baglanti = self.connection

        def koptu():
            try:
                hazir, _, _ = select.select([baglanti], [], [], 0)
                return bool(hazir) and baglanti.recv(1, socket.MSG_PEEK) == b''
            except OSError:
                return True

        sinirli = set()
        oncelikli = set()
        gonderilecek = ilk
        okunacak = ilk
        try:
            while gonderilecek <= sonp:
                if ih not in torrentler or koptu():
                    return
                for k in range(gonderilecek, min(gonderilecek + oncelikli_adet, sonp + 1)):
                    if k in var:
                        continue
                    if k - gonderilecek < sinirli_adet:
                        if k not in sinirli:
                            h.set_piece_deadline(k, (k - gonderilecek) * adim_ms)
                            sinirli.add(k)
                    elif k not in oncelikli:
                        h.piece_priority(k, 7)
                        oncelikli.add(k)
                with kosul:
                    while okunacak <= sonp and okunacak - gonderilecek < ONDEN_OKUMA and okunacak in var:
                        anahtar = (ih, okunacak)
                        if anahtar not in parcalar and anahtar not in istenen:
                            istenen.add(anahtar)
                            h.read_piece(okunacak)
                        okunacak += 1
                    veri = parcalar.get((ih, gonderilecek))
                    if veri is None:
                        # Önbellekten düşmüş olabilir: inmişse yeniden iste.
                        anahtar = (ih, gonderilecek)
                        if anahtar not in istenen and gonderilecek in var:
                            istenen.add(anahtar)
                            h.read_piece(gonderilecek)
                        kosul.wait(0.1)
                        continue
                pbas = gonderilecek * pl
                a = max(ofset + bas, pbas) - pbas
                b = min(ofset + son + 1, pbas + len(veri)) - pbas
                try:
                    self.wfile.write(veri[a:b])
                except (ConnectionError, BrokenPipeError, OSError):
                    return
                gonderilecek += 1
        finally:
            # Sarmada eski konumun acil/öncelikli parçaları yeni konumla yarışmasın.
            if ih in torrentler:
                for k in sinirli - var:
                    h.reset_piece_deadline(k)
                for k in (sinirli | oncelikli) - var:
                    h.piece_priority(k, 1)


os.makedirs(KLASOR, exist_ok=True)
print(f'lt hazir {PORT}', flush=True)
ThreadingHTTPServer(('127.0.0.1', PORT), Isleyici).serve_forever()
