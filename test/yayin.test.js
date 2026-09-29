import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createYayin, createIceServers, VARSAYILAN_ICE, SINYAL_EN_BUYUK } from '../src/yayin.js';

function oda() {
  return {
    id: 'ODA123',
    hostUserId: 'h',
    users: new Map([['h', { name: 'Host' }], ['a', { name: 'Ali' }], ['b', { name: 'Ayşe' }], ['c', { name: 'Can' }]]),
  };
}
const sdp = (tur) => ({ tur, sdp: `v=0 ${tur}` });

test('yayını yalnız host açar ve kapatır; açılınca odaya duyurulur', async () => {
  const y = createYayin();
  const r = oda();
  assert.equal(y.events.yayinBaslat(r, 'a', { kalite: '1080p30' }).error, 'notHost');
  const res = y.events.yayinBaslat(r, 'h', { kalite: '1080p60', sinir: 3 });
  assert.equal(res.reply.kalite, '1080p60');
  assert.equal(res.reply.fps, 60);
  assert.deepEqual(res.msgs[0], { to: 'room', event: 'yayinDurum', data: { aktif: true, hostUserId: 'h', kalite: '1080p60', sinir: 3, izleyici: 0 } });
  assert.equal(y.events.yayinBitir(r, 'a').error, 'notHost');
  assert.deepEqual(y.events.yayinBitir(r, 'h').msgs[0].data, { aktif: false });
});

test('bilinmeyen kalite ve geçersiz sınır varsayılana düşer', () => {
  const y = createYayin();
  const res = y.events.yayinBaslat(oda(), 'h', { kalite: '8k', sinir: 999 });
  assert.equal(res.reply.kalite, '1080p30');
  assert.equal(res.reply.sinir, 6);
});

test('izleyici katılınca host\'a haber gider, ICE sunucuları döner; sınır dolunca reddedilir', async () => {
  const y = createYayin({ iceServers: async () => [{ urls: 'stun:x' }] });
  const r = oda();
  assert.equal((await y.events.yayinKatil(r, 'a')).error, 'yayinYok');
  y.events.yayinBaslat(r, 'h', { sinir: 2 });
  const k = await y.events.yayinKatil(r, 'a');
  assert.deepEqual(k.reply.iceServers, [{ urls: 'stun:x' }]);
  assert.deepEqual(k.msgs[0], { to: 'h', event: 'yayinIzleyici', data: { userId: 'a', ad: 'Ali' } });
  await y.events.yayinKatil(r, 'b');
  assert.equal((await y.events.yayinKatil(r, 'c')).error, 'yayinDolu');
  // zaten katılmış olan tekrar katılabilir (yeniden bağlanma), sınıra takılmaz
  assert.ok((await y.events.yayinKatil(r, 'a')).reply.ok);
  assert.equal((await y.events.yayinKatil(r, 'h')).error, 'badInput');
});

test('sinyal yalnız host ile katılmış izleyici arasında, yalnız doğru yönde taşınır', async () => {
  const y = createYayin();
  const r = oda();
  y.events.yayinBaslat(r, 'h', {});
  await y.events.yayinKatil(r, 'a');
  // host -> katılmış izleyici: teklif
  const t = y.events.yayinSinyal(r, 'h', { to: 'a', sinyal: sdp('teklif') });
  assert.deepEqual(t.msgs[0], { to: 'a', event: 'yayinSinyal', data: { from: 'h', sinyal: sdp('teklif') } });
  // izleyici -> host: cevap
  assert.equal(y.events.yayinSinyal(r, 'a', { to: 'h', sinyal: sdp('cevap') }).msgs[0].to, 'h');
  // katılmamış kişiye teklif, katılmamış kişiden cevap, izleyiciden izleyiciye, yanlış tür
  assert.equal(y.events.yayinSinyal(r, 'h', { to: 'b', sinyal: sdp('teklif') }).error, 'badInput');
  assert.equal(y.events.yayinSinyal(r, 'b', { to: 'h', sinyal: sdp('cevap') }).error, 'badInput');
  assert.equal(y.events.yayinSinyal(r, 'a', { to: 'b', sinyal: sdp('cevap') }).error, 'badInput');
  assert.equal(y.events.yayinSinyal(r, 'a', { to: 'h', sinyal: sdp('teklif') }).error, 'badInput');
  assert.equal(y.events.yayinSinyal(r, 'h', { to: 'a', sinyal: { tur: 'teklif' } }).error, 'badInput');
  // çok büyük SDP
  assert.equal(y.events.yayinSinyal(r, 'h', { to: 'a', sinyal: { tur: 'teklif', sdp: 'x'.repeat(SINYAL_EN_BUYUK + 1) } }).error, 'badInput');
  // taşınan veri yalnız tur+sdp (fazla alanlar atılır)
  const fazla = y.events.yayinSinyal(r, 'h', { to: 'a', sinyal: { ...sdp('teklif'), kotu: 1 } });
  assert.deepEqual(Object.keys(fazla.msgs[0].data.sinyal), ['tur', 'sdp']);
});

test('izleyici ayrılınca ya da bağlantısı kopunca listeden çıkar ve host\'a bildirilir', async () => {
  const y = createYayin();
  const r = oda();
  y.events.yayinBaslat(r, 'h', {});
  await y.events.yayinKatil(r, 'a');
  await y.events.yayinKatil(r, 'b');
  assert.deepEqual(y.events.yayinAyril(r, 'a').msgs[0], { to: 'h', event: 'yayinAyrildi', data: { userId: 'a' } });
  assert.deepEqual(y.onDisconnect(r, 'b')[0], { to: 'h', event: 'yayinAyrildi', data: { userId: 'b' } });
  assert.deepEqual(y.durum(r.id).izleyiciler, []);
  assert.deepEqual(y.onDisconnect(r, 'c'), []); // yayında olmayan
});

test('host\'un bağlantısı koparsa ya da host değişirse yayın biter', async () => {
  const y = createYayin();
  const r = oda();
  y.events.yayinBaslat(r, 'h', {});
  assert.deepEqual(y.onDisconnect(r, 'h')[0].data, { aktif: false });
  assert.equal(y.durum(r.id), null);

  y.events.yayinBaslat(r, 'h', {});
  r.hostUserId = 'a';                     // host devri
  assert.equal((await y.events.yayinKatil(r, 'b')).error, 'yayinYok');
  assert.equal(y.durum(r.id), null);
});

test('sonradan katılan kişi açık yayını görür; oda kapanınca yayın silinir', () => {
  const y = createYayin();
  const r = oda();
  assert.deepEqual(y.onJoin(r, 'c'), []);
  y.events.yayinBaslat(r, 'h', {});
  const [m] = y.onJoin(r, 'c');
  assert.equal(m.to, 'c');
  assert.equal(m.data.aktif, true);
  y.kapat(r.id);
  assert.equal(y.durum(r.id), null);
});

test('ICE: ayar yoksa ücretsiz STUN; Cloudflare TURN kimliği alınır, önbelleğe konur, hata olursa STUN', async () => {
  assert.deepEqual(await createIceServers({ getConfig: () => ({}) })(), VARSAYILAN_ICE);
  let cagri = 0;
  const fetchImpl = async (url, opts) => {
    cagri += 1;
    assert.match(url, /\/turn\/keys\/KEY\/credentials\/generate-ice-servers$/);
    assert.equal(opts.headers.Authorization, 'Bearer TOK');
    return { ok: true, json: async () => ({ iceServers: [{ urls: ['turn:x'], username: 'u', credential: 'p' }] }) };
  };
  const ice = createIceServers({ getConfig: () => ({ yayin: { cloudflareTurn: { keyId: 'KEY', token: 'TOK' } } }), fetchImpl });
  const a = await ice();
  assert.deepEqual(a.at(-1), { urls: ['turn:x'], username: 'u', credential: 'p' });
  await ice();
  assert.equal(cagri, 1); // önbellek
  const bozuk = createIceServers({ getConfig: () => ({ yayin: { cloudflareTurn: { keyId: 'K', token: 'T' } } }), fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.deepEqual(await bozuk(), VARSAYILAN_ICE);
});

// ---- istemci (public/js/yayin.js) saf yardımcıları ----
import { opusStereo, bitHiziIpucu } from '../public/js/yayin.js';

const ORNEK_SDP = [
  'v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 102', 'a=rtpmap:96 VP8/90000', 'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96',
  'a=rtpmap:102 H264/90000', 'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032', '',
].join('\r\n');

test('opus stereo ve yüksek bit hızına alınır, mevcut parametreler korunur', () => {
  const s = opusStereo(ORNEK_SDP, 192);
  assert.match(s, /a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=192000/);
  assert.equal(opusStereo(s, 192), s); // iki kez uygulamak bozmaz
  assert.equal(opusStereo('v=0\r\n'), 'v=0\r\n'); // opus yoksa dokunmaz
});

test('bit hızı ipucu yalnız video codec satırlarına eklenir (rtx ve ses hariç), tekrar eklenmez', () => {
  const s = bitHiziIpucu(ORNEK_SDP, 6000);
  assert.match(s, /a=fmtp:102 [^\r\n]*;x-google-min-bitrate=3000;x-google-start-bitrate=4800;x-google-max-bitrate=6000/);
  assert.match(s, /a=fmtp:97 apt=96\r\n/);          // rtx'e dokunulmadı
  assert.match(s, /a=fmtp:111 minptime=10;useinbandfec=1\r\n/); // ses satırına dokunulmadı
  assert.equal(bitHiziIpucu(s, 6000), s);
});
