// Canlı yayın istemcisi (WebRTC). Sunucu tarafı: src/yayin.js.
//
// Host: getDisplayMedia ile görüntü + sistem sesi yakalanır. Masaüstü uygulamasında kabuk bu
// isteğe mpv'nin penceresini ve sistem sesini kendisi verir (seçici çıkmaz); tarayıcıda
// tarayıcının kendi pencere seçicisi açılır. Her izleyiciye ayrı RTCPeerConnection.
// İzleyici: host'tan gelen teklife cevap verir, gelen akışı ayrı bir <video>'da gösterir.
//
// ICE adayları tek tek gönderilmez: aday toplama bitince (ya da süre dolunca) tam SDP tek
// mesajda gider - sunucudaki "bağlantı başına saniyede 20 olay" sınırına takılmasın.

// Çözünürlük ve kare hızı ayrı seçiliyor (bkz. src/yayin.js): anahtar '<çözünürlük><fps>'.
export const COZUNURLUKLER = {
  '480p': { ad: '480p (zayıf internet)', genislik: 854, yukseklik: 480, kbps30: 1500 },
  '720p': { ad: '720p', genislik: 1280, yukseklik: 720, kbps30: 3500 },
  '1080p': { ad: '1080p', genislik: 1920, yukseklik: 1080, kbps30: 6000 },
  '1440p': { ad: '1440p', genislik: 2560, yukseklik: 1440, kbps30: 10000 },
};
export const FPSLER = [30, 60];
export const KALITELER = Object.fromEntries(Object.entries(COZUNURLUKLER).flatMap(([ad, c]) => FPSLER.map((fps) => [
  `${ad}${fps}`, { ad: `${ad} · ${fps} fps`, genislik: c.genislik, yukseklik: c.yukseklik, fps, kbps: fps === 60 ? Math.round(c.kbps30 * 1.5) : c.kbps30 },
])));
const SES_KBPS = 192;
const ADAY_BEKLEME_MS = 3000;
const BAGLANTI_ZAMAN_ASIMI_MS = 20_000;
const ISTATISTIK_MS = 2000;

// Aday toplama bitene kadar bekle (en çok ADAY_BEKLEME_MS).
function adaylariBekle(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const bitti = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', bitti);
      clearTimeout(zaman);
      resolve();
    };
    const zaman = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', bitti);
      resolve();
    }, ADAY_BEKLEME_MS);
    pc.addEventListener('icegatheringstatechange', bitti);
  });
}

// Opus'u stereo ve yüksek bit hızına al: varsayılan mono ~32 kbps konuşma için, film için değil.
export function opusStereo(sdp, kbps = SES_KBPS) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const ekler = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: String(kbps * 1000) };
  const satir = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (!satir.test(sdp)) return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${Object.entries(ekler).map(([k, v]) => `${k}=${v}`).join(';')}`);
  return sdp.replace(satir, (_t, params) => {
    const var_ = new Map(params.split(';').map((p) => p.trim()).filter(Boolean).map((p) => p.split('=')));
    for (const [k, v] of Object.entries(ekler)) var_.set(k, v);
    return `a=fmtp:${pt} ${[...var_].map(([k, v]) => `${k}=${v}`).join(';')}`;
  });
}

// Video bit hızı ipuçları: WebRTC ~300 kbps'den başlayıp yavaşça artırıyor, ilk 10 saniye
// görüntü bulanık ve 9-10 fps kalıyordu (ölçüldü). Chromium, gönderici tarafta uzak SDP'deki
// (izleyicinin cevabı) x-google-*-bitrate değerlerini kullanır: host cevabı uygulamadan önce ekler.
export function bitHiziIpucu(sdp, kbps) {
  const videoPt = new Set();
  let videoda = false;
  for (const satir of sdp.split(/\r?\n/)) {
    if (satir.startsWith('m=')) videoda = satir.startsWith('m=video');
    const m = videoda && satir.match(/^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//i);
    if (m) videoPt.add(m[1]);
  }
  const ek = `x-google-min-bitrate=${Math.round(kbps * 0.5)};x-google-start-bitrate=${Math.round(kbps * 0.8)};x-google-max-bitrate=${kbps}`;
  return sdp.replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (t, pt, p) => (videoPt.has(pt) && !p.includes('x-google-') ? `a=fmtp:${pt} ${p};${ek}` : t));
}

// Donanım kodlayıcıya en uygun codec önce: H.264 (ekran kartı), sonra VP9/AV1/VP8.
// Chromium 130 (Electron 33) tercih listesini ALICI yeteneklerinden istiyor; gönderici
// listesiyle verilince sessizce reddediyordu ve yazılım VP8 (libvpx) kullanılıyordu (ölçüldü).
function codecSirasi(transceiver, log) {
  const caps = RTCRtpReceiver.getCapabilities?.('video') || RTCRtpSender.getCapabilities?.('video');
  if (!caps || !transceiver.setCodecPreferences) return;
  const puan = (c) => {
    const t = c.mimeType.toLowerCase();
    if (t === 'video/h264') return c.sdpFmtpLine?.includes('packetization-mode=1') ? 0 : 1;
    if (t === 'video/vp9') return 2;
    if (t === 'video/av1') return 3;
    if (t === 'video/vp8') return 4;
    return 9; // rtx, red, ulpfec: sonda kalır
  };
  try {
    // H.264 içinde yüksek profil (640032) önce: aynı bit hızında daha net
    const profil = (c) => (/profile-level-id=64/.test(c.sdpFmtpLine || '') ? 0 : 1);
    transceiver.setCodecPreferences([...caps.codecs].sort((a, b) => puan(a) - puan(b) || profil(a) - profil(b)));
  } catch (err) {
    log?.('yayin-codec-hata', { hata: String(err) }); // varsayılan sıra kalır
  }
}

export function createYayinIstemci({ socket, request, onDurum = () => {}, log = () => {} }) {
  // ---- host ----
  let akis = null;          // yakalanan MediaStream
  let kalite = null;        // KALITELER[...]
  let iceServers = [];
  let sistemSesi = false;   // ses tüm bilgisayardan mı (uygulama sesi alınamadıysa)
  const esler = new Map();  // userId -> RTCPeerConnection
  let istatistikZamani = null;
  let sonBayt = new Map();  // userId -> { bytes, at }
  let hostOzet = { izleyici: 0, mbps: 0, fps: null, kodlayici: null };

  // ---- izleyici ----
  let izlePc = null;
  let izleVideo = null;
  let izleIce = [];
  let izleZamanAsimi = null;

  const bildir = (olay) => onDurum({ ...olay, host: yayinliyor(), izliyor: Boolean(izlePc) });
  const yayinliyor = () => Boolean(akis);

  async function esOlustur(userId) {
    esler.get(userId)?.close();
    const pc = new RTCPeerConnection({ iceServers });
    esler.set(userId, pc);
    for (const track of akis.getTracks()) {
      const t = pc.addTransceiver(track, { direction: 'sendonly', streams: [akis] });
      if (track.kind === 'video') codecSirasi(t, log);
      const p = t.sender.getParameters();
      p.encodings = p.encodings?.length ? p.encodings : [{}];
      if (track.kind === 'video') {
        p.encodings[0].maxBitrate = kalite.kbps * 1000;
        p.encodings[0].maxFramerate = kalite.fps;
        p.degradationPreference = 'balanced';
      } else {
        p.encodings[0].maxBitrate = SES_KBPS * 1000;
      }
      t.sender.setParameters(p).catch(() => {});
    }
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        if (esler.get(userId) === pc) esler.delete(userId);
        pc.close();
      }
      log('yayin-es', { userId, durum: pc.connectionState });
    });
    const teklif = await pc.createOffer();
    await pc.setLocalDescription({ type: 'offer', sdp: opusStereo(teklif.sdp) });
    await adaylariBekle(pc);
    if (esler.get(userId) !== pc) return; // bu arada ayrıldı
    await request('yayinSinyal', { to: userId, sinyal: { tur: 'teklif', sdp: pc.localDescription.sdp } });
  }

  async function istatistik() {
    let toplamBit = 0;
    let fps = null;
    let kodlayici = null;
    const simdi = performance.now();
    for (const [userId, pc] of esler) {
      let bayt = 0;
      const rapor = await pc.getStats();
      rapor.forEach((s) => {
        if (s.type !== 'outbound-rtp') return;
        bayt += s.bytesSent || 0;
        if (s.kind === 'video') {
          fps = s.framesPerSecond ?? fps;
          kodlayici = s.encoderImplementation || kodlayici;
        }
      });
      const once = sonBayt.get(userId);
      if (once) toplamBit += ((bayt - once.bytes) * 8) / ((simdi - once.at) / 1000);
      sonBayt.set(userId, { bytes: bayt, at: simdi });
    }
    for (const id of sonBayt.keys()) if (!esler.has(id)) sonBayt.delete(id);
    hostOzet = { izleyici: esler.size, mbps: Math.round(toplamBit / 1e5) / 10, fps: fps && Math.round(fps), kodlayici };
    bildir({ tur: 'istatistik', ...hostOzet });
  }

  async function baslat(kaliteAdi, sinir) {
    if (akis) return { ok: true };
    kalite = KALITELER[kaliteAdi] || KALITELER['1080p30'];
    // Masaüstü uygulaması: oynatıcı penceresi gizliyse (diyalog açık, video yükleniyor/başlamadı)
    // yakalama "Could not start video source" ile düşüyor - önce sor, anlaşılır sebep ver.
    if (window.kabuk?.yayinHazir) {
      const hazir = await window.kabuk.yayinHazir().catch(() => ({ ok: true }));
      if (!hazir.ok) return { error: 'oynaticiHazirDegil', sebep: hazir.sebep };
    }
    // Masaüstü uygulamasında ses yalnız oynatıcıdan (mpv): tüm bilgisayar sesi (bildirimler,
    // Discord, tarayıcı…) yayına gitmesin. Olmazsa (eski Windows) sistem sesine düşülür.
    const uygSes = await window.kabuk?.uygulamaSesi?.().catch(() => null);
    sistemSesi = !uygSes;
    try {
      akis = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: kalite.genislik }, height: { max: kalite.yukseklik }, frameRate: { ideal: kalite.fps, max: kalite.fps } },
        // Konuşma filtreleri filmi bozar (mono, gürültü bastırma, otomatik ses): hepsi kapalı.
        audio: uygSes ? false : { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
        systemAudio: uygSes ? 'exclude' : 'include',
        selfBrowserSurface: 'exclude',
      });
    } catch (err) {
      akis = null;
      uygSes?.stop();
      window.kabuk?.uygulamaSesiDurdur?.();
      return { error: err?.name === 'NotAllowedError' ? 'iptal' : 'yakalama', detay: String(err?.message || err) };
    }
    if (uygSes) akis.addTrack(uygSes);
    const video = akis.getVideoTracks()[0];
    if (video) video.contentHint = 'motion';
    // Tarayıcının "Paylaşımı durdur" düğmesi ya da pencere kapanırsa yayın biter.
    video?.addEventListener('ended', () => bitir());
    const res = await request('yayinBaslat', { kalite: kaliteAdi, sinir });
    if (res?.error) {
      durdurYerel();
      return res;
    }
    const ice = await request('yayinIce');
    iceServers = ice?.iceServers || [];
    istatistikZamani = setInterval(() => istatistik().catch(() => {}), ISTATISTIK_MS);
    bildir({ tur: 'basladi', sesVar: akis.getAudioTracks().length > 0, sistemSesi, ...res });
    return res;
  }

  function durdurYerel() {
    clearInterval(istatistikZamani);
    istatistikZamani = null;
    for (const pc of esler.values()) pc.close();
    esler.clear();
    sonBayt.clear();
    akis?.getTracks().forEach((t) => t.stop());
    akis = null;
    window.kabuk?.uygulamaSesiDurdur?.();
  }

  async function bitir() {
    if (!akis) return;
    durdurYerel();
    await request('yayinBitir');
    bildir({ tur: 'bitti' });
  }

  // ---- izleyici ----
  async function izle(videoEl) {
    if (izlePc) return { ok: true };
    const res = await request('yayinKatil');
    if (res?.error) return res;
    izleVideo = videoEl;
    izleIce = res.iceServers || [];
    // Teklif host'tan gelecek (yayinSinyal); gelmezse ya da bağlanamazsa haber ver.
    izlePc = 'bekliyor';
    clearTimeout(izleZamanAsimi);
    izleZamanAsimi = setTimeout(() => {
      if (izlePc === 'bekliyor' || (izlePc && izlePc.connectionState !== 'connected')) {
        birakYerel();
        request('yayinAyril');
        bildir({ tur: 'baglanamadi' });
      }
    }, BAGLANTI_ZAMAN_ASIMI_MS);
    bildir({ tur: 'baglaniyor' });
    return res;
  }

  async function teklifGeldi(from, sdp) {
    if (!izlePc) return;
    if (izlePc !== 'bekliyor') izlePc.close();
    const pc = new RTCPeerConnection({ iceServers: izleIce });
    izlePc = pc;
    const gelen = new MediaStream();
    pc.addEventListener('track', (e) => {
      gelen.addTrack(e.track);
      if (izleVideo && izleVideo.srcObject !== gelen) izleVideo.srcObject = gelen;
      izleVideo?.play().catch(() => {});
    });
    pc.addEventListener('connectionstatechange', () => {
      log('yayin-izle', { durum: pc.connectionState });
      if (pc.connectionState === 'connected') {
        clearTimeout(izleZamanAsimi);
        bildir({ tur: 'baglandi' });
      } else if (pc.connectionState === 'failed' && izlePc === pc) {
        birakYerel();
        request('yayinAyril');
        bildir({ tur: 'baglanamadi' });
      }
    });
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const cevap = await pc.createAnswer();
    await pc.setLocalDescription({ type: 'answer', sdp: opusStereo(cevap.sdp) });
    await adaylariBekle(pc);
    if (izlePc !== pc) return;
    await request('yayinSinyal', { to: from, sinyal: { tur: 'cevap', sdp: pc.localDescription.sdp } });
  }

  function birakYerel() {
    clearTimeout(izleZamanAsimi);
    if (izlePc && izlePc !== 'bekliyor') izlePc.close();
    izlePc = null;
    if (izleVideo) izleVideo.srcObject = null;
  }

  async function birak() {
    if (!izlePc) return;
    birakYerel();
    await request('yayinAyril');
    bildir({ tur: 'birakti' });
  }

  // İzleyicinin gördüğü kare hızı ve gelen hız (arayüz rozeti için).
  let izleOnceki = null; // { bayt, at }: gelen hız (Mbps) için
  async function izleIstatistik() {
    if (!izlePc || izlePc === 'bekliyor') return null;
    let sonuc = null;
    let bayt = 0;
    (await izlePc.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp') bayt += s.bytesReceived || 0;
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        sonuc = { fps: s.framesPerSecond ?? null, genislik: s.frameWidth ?? null, yukseklik: s.frameHeight ?? null, kayip: s.packetsLost ?? 0 };
      }
    });
    const simdi = Date.now();
    if (sonuc && izleOnceki && simdi > izleOnceki.at) {
      sonuc.mbps = Math.round((((bayt - izleOnceki.bayt) * 8) / 1e6 / ((simdi - izleOnceki.at) / 1000)) * 10) / 10;
    }
    izleOnceki = { bayt, at: simdi };
    return sonuc;
  }

  // ---- sunucudan gelenler ----
  socket.on('yayinIzleyici', ({ userId }) => {
    if (!akis) return;
    esOlustur(userId).catch((err) => log('yayin-teklif-hata', { userId, hata: String(err) }));
  });
  socket.on('yayinAyrildi', ({ userId }) => {
    esler.get(userId)?.close();
    esler.delete(userId);
  });
  socket.on('yayinSinyal', ({ from, sinyal }) => {
    if (sinyal?.tur === 'cevap') {
      const sdp = kalite ? bitHiziIpucu(sinyal.sdp, kalite.kbps) : sinyal.sdp;
      esler.get(from)?.setRemoteDescription({ type: 'answer', sdp }).catch((err) => log('yayin-cevap-hata', { hata: String(err) }));
    } else if (sinyal?.tur === 'teklif') {
      teklifGeldi(from, sinyal.sdp).catch((err) => {
        log('yayin-izle-hata', { hata: String(err) });
        birakYerel();
        bildir({ tur: 'baglanamadi' });
      });
    }
  });
  socket.on('yayinDurum', (d) => {
    if (!d?.aktif && izlePc) {
      birakYerel();
      bildir({ tur: 'birakti', sebep: 'yayinBitti' });
    }
    bildir({ tur: 'durum', ...d });
  });

  // Yayın sürerken ayar değişimi: yakalama yeni çözünürlük/fps'e ayarlanır, her izleyiciyle
  // bağlantı yeni bit hızıyla yeniden kurulur (izleyicide 1-3 sn'lik kısa kesinti).
  async function ayarla(kaliteAdi, sinir) {
    if (!akis) return { error: 'yayinYok' };
    const yeni = KALITELER[kaliteAdi];
    if (!yeni) return { error: 'badValue' };
    const res = await request('yayinGuncelle', { kalite: kaliteAdi, sinir });
    if (res?.error) return res;
    const degisti = yeni !== kalite;
    kalite = yeni;
    if (degisti) {
      const video = akis.getVideoTracks()[0];
      await video?.applyConstraints({
        width: { max: kalite.genislik }, height: { max: kalite.yukseklik }, frameRate: { ideal: kalite.fps, max: kalite.fps },
      }).catch((err) => log('yayin-ayar-hata', { hata: String(err) }));
      for (const userId of [...esler.keys()]) {
        esOlustur(userId).catch((err) => log('yayin-teklif-hata', { userId, hata: String(err) }));
      }
    }
    bildir({ tur: 'ayarlandi', ...res });
    return res;
  }

  return {
    baslat, bitir, ayarla, izle, birak, izleIstatistik,
    yayinliyor, izliyor: () => Boolean(izlePc), hostOzet: () => ({ ...hostOzet }),
  };
}
