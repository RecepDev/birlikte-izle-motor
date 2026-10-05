# libtorrent akış ayarı denemesi: aynı torrent'lerde farklı parça isteme stratejilerini sırayla dener.
# Ölçülen: açılış (ilk parça), 20 sn sıralı okuma (sırayla teslim edilen bayt), %35 ve %80'e sarma
# (o yerin ilk parçası). Sarılan parçanın kaç farklı kaynaktan indiği de yazılıyor (teşhis için).
#
# Çalıştır: .venv-lt/Scripts/python lt_deneme.py <hash> [<hash> ...]

import json
import os
import shutil
import sys
import tempfile
import time

import libtorrent as lt

BURASI = os.path.dirname(os.path.abspath(__file__))
TR = json.load(open(os.path.join(BURASI, '..', '..', 'data', 'trackerlar.json'), encoding='utf-8'))['liste']
MB = 1024 * 1024

TEMEL = {
    'listen_interfaces': '0.0.0.0:6897,[::]:6897',
    'enable_dht': True, 'enable_lsd': True, 'enable_upnp': True, 'enable_natpmp': True,
    'connections_limit': 400,
    'announce_to_all_trackers': True, 'announce_to_all_tiers': True,
    'connection_speed': 100, 'torrent_connect_boost': 80, 'smooth_connects': False,
    'peer_connect_timeout': 7, 'piece_timeout': 5, 'request_timeout': 10, 'tick_interval': 100,
    'strict_end_game_mode': False, 'max_out_request_queue': 5000,
    'alert_mask': lt.alert_category.status | lt.alert_category.error | lt.alert_category.piece_progress,
}

# sinirli: süre sınırlı (acil) pencere bayt / en çok parça; oncelik: arkasındaki öncelik-7 penceresi;
# ilk_ms: ilk parçanın süre sınırı; hiz: sonraki parçaların aralığı için hedef hız (bayt/sn);
# wpt: whole_pieces_threshold (hızlı kaynağa bütün parçayı verme eşiği, sn; varsayılan 20).
VARYANTLAR = {
    'A_simdiki': dict(wpt=20, sinirli=16 * MB, sinirli_en_cok=24, oncelik=96 * MB, ilk_ms=0, hiz=6 * MB),
    'B_parca_bolme': dict(wpt=0, sinirli=16 * MB, sinirli_en_cok=24, oncelik=96 * MB, ilk_ms=0, hiz=6 * MB),
    'C_hep_acil': dict(wpt=0, sinirli=64 * MB, sinirli_en_cok=64, oncelik=0, ilk_ms=0, hiz=6 * MB),
    'D_yalniz_oncelik': dict(wpt=0, sinirli=0, sinirli_en_cok=0, oncelik=96 * MB, ilk_ms=0, hiz=6 * MB),
    'E_gevsek_sure': dict(wpt=0, sinirli=32 * MB, sinirli_en_cok=32, oncelik=96 * MB, ilk_ms=1500, hiz=4 * MB),
}

ses = lt.session(TEMEL)
var = {}  # hash -> inmiş parçalar


def alarmlar(bekle_ms=50):
    ses.wait_for_alert(bekle_ms)
    for a in ses.pop_alerts():
        if isinstance(a, lt.piece_finished_alert):
            var.setdefault(str(a.handle.info_hash()), set()).add(a.piece_index)


class Okuyucu:
    def __init__(self, h, ih, v, pl, son):
        self.h, self.ih, self.v, self.pl, self.son = h, ih, v, pl, son
        self.sinirli, self.oncelikli = set(), set()

    def pencere(self, p):
        v = self.v
        sinirli_adet = 0 if not v['sinirli'] else max(2, min(v['sinirli_en_cok'], v['sinirli'] // self.pl))
        oncelik_adet = max(sinirli_adet, v['oncelik'] // self.pl) if v['oncelik'] else sinirli_adet
        adim = max(50, int(self.pl * 1000 / v['hiz']))
        inen = var.setdefault(self.ih, set())
        for k in range(p, min(p + oncelik_adet, self.son + 1)):
            if k in inen:
                continue
            if k - p < sinirli_adet:
                if k not in self.sinirli:
                    self.h.set_piece_deadline(k, v['ilk_ms'] + (k - p) * adim)
                    self.sinirli.add(k)
            elif k not in self.oncelikli:
                self.h.piece_priority(k, 7)
                self.oncelikli.add(k)
        if not oncelik_adet and p not in inen and p not in self.oncelikli:
            self.h.piece_priority(p, 7)
            self.oncelikli.add(p)

    def birak(self):
        inen = var.get(self.ih, set())
        for k in self.sinirli - inen:
            self.h.reset_piece_deadline(k)
        for k in (self.sinirli | self.oncelikli) - inen:
            self.h.piece_priority(k, 1)
        self.sinirli, self.oncelikli = set(), set()

    # p parçası inene kadar bekler; süre (sn) ya da None.
    def bekle(self, p, sinir_sn):
        t0 = time.time()
        while p not in var.get(self.ih, set()):
            if time.time() - t0 > sinir_sn:
                return None
            self.pencere(p)
            alarmlar()
        return time.time() - t0

    # p'den başlayıp sn boyunca sırayla teslim edilen bayt.
    def sirali(self, p, sn):
        t0 = time.time()
        bayt = 0
        while time.time() - t0 < sn and p <= self.son:
            self.pencere(p)
            if p in var.get(self.ih, set()):
                bayt += self.pl
                p += 1
                continue
            alarmlar()
        return bayt * 8 / 1e6 / (time.time() - t0)


def kaynak_sayisi(h, p):
    try:
        for q in h.get_download_queue():
            if q['piece_index'] == p:
                return len({str(b.get('peer')) for b in q['blocks'] if b.get('state', 0) != 0})
    except Exception:
        pass
    return None


def dene(ih, ad, v):
    ses.apply_settings({'whole_pieces_threshold': v['wpt']})
    klasor = tempfile.mkdtemp(prefix='ltd-')
    p = lt.parse_magnet_uri(f'magnet:?xt=urn:btih:{ih}')
    p.save_path = klasor
    p.trackers = TR
    p.flags &= ~lt.torrent_flags.auto_managed
    p.flags &= ~lt.torrent_flags.paused
    p.max_connections = 80
    var[ih] = set()
    t0 = time.time()
    h = ses.add_torrent(p)
    sonuc = {'varyant': ad}
    try:
        while not h.status().has_metadata:
            if time.time() - t0 > 90:
                sonuc['hata'] = 'metadata'
                return sonuc
            alarmlar(100)
        sonuc['metadata'] = round(time.time() - t0, 1)
        ti = h.torrent_file()
        fs = ti.files()
        idx = max(range(fs.num_files()), key=fs.file_size)
        h.prioritize_files([1 if i == idx else 0 for i in range(fs.num_files())])
        pl = ti.piece_length()
        ilk = fs.file_offset(idx) // pl
        son = (fs.file_offset(idx) + fs.file_size(idx) - 1) // pl
        sonuc['parca_mb'] = round(pl / MB, 2)
        o = Okuyucu(h, ih, v, pl, son)
        s = o.bekle(ilk, 90)
        sonuc['acilis'] = None if s is None else round(time.time() - t0, 1)
        if s is None:
            return sonuc
        sonuc['izleme_mbps'] = round(o.sirali(ilk + 1, 20), 1)
        for ad_, oran in (('sarma35', 0.35), ('sarma80', 0.8)):
            o.birak()
            hedef = ilk + int((son - ilk) * oran)
            # 2 sn sonra o parçayı kaç kaynak indiriyor (teşhis)
            t1 = time.time()
            kaynak = None
            while hedef not in var.get(ih, set()) and time.time() - t1 < 60:
                o.pencere(hedef)
                alarmlar()
                if kaynak is None and time.time() - t1 > 2:
                    kaynak = kaynak_sayisi(h, hedef)
            sonuc[ad_] = round(time.time() - t1, 1) if hedef in var.get(ih, set()) else None
            sonuc[ad_ + '_kaynak'] = kaynak
        sonuc['peer'] = h.status().num_peers
        return sonuc
    finally:
        ses.remove_torrent(h, lt.session.delete_files)
        time.sleep(3)
        shutil.rmtree(klasor, ignore_errors=True)


print('DHT ısınıyor (45 sn)...', flush=True)
t = time.time()
while time.time() - t < 45:
    alarmlar(500)
adlar = list(VARYANTLAR)
tablo = []
for i, ih in enumerate(sys.argv[1:]):
    print(f'\n== {ih}', flush=True)
    for k in range(len(adlar)):
        ad = adlar[(k + i) % len(adlar)]
        s = dene(ih, ad, VARYANTLAR[ad])
        s['torrent'] = ih
        tablo.append(s)
        print('  ' + json.dumps(s, ensure_ascii=False), flush=True)
json.dump(tablo, open(os.path.join(BURASI, 'lt_deneme.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('\n== Özet (medyan)')
for ad in adlar:
    r = [x for x in tablo if x['varyant'] == ad and x.get('acilis') is not None]
    def med(k):
        a = sorted(x[k] for x in r if x.get(k) is not None)
        return a[len(a) // 2] if a else None
    print(f"  {ad:18} {len(r)}/{len([x for x in tablo if x['varyant'] == ad])} | açılış {med('acilis')} | izleme {med('izleme_mbps')} Mbps | sarma %35 {med('sarma35')} (kaynak {med('sarma35_kaynak')}), %80 {med('sarma80')} (kaynak {med('sarma80_kaynak')})")
