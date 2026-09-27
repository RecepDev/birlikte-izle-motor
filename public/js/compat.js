// Can this device open every video the room offers? Everything here is pure logic (no DOM)
// so it can be tested; probeDevice() is the only part that touches browser APIs.

const VIDEO_CODEC = { HEVC: 'hevc', 'Dolby Vision': 'hevc', AV1: 'av1' };
const AUDIO_CODEC = { AC3: 'ac3', 'E-AC3': 'eac3', DTS: 'dts', 'DTS-HD': 'dts', TrueHD: 'truehd' };
const QUALITY_RANK = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 };
const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };

const screenRank = (width) => (!width ? 4 : width >= 3200 ? 4 : width >= 1700 ? 3 : width >= 1100 ? 2 : 1);

// Dolby Vision without an HDR10 fallback layer: browsers show wrong (green/purple) colours.
const isDolbyVisionOnly = (s) => s.hdr === 'Dolby Vision' && !/hdr10|\bhdr\b/i.test(`${s.name || ''} ${s.title || ''}`);

export function streamVerdict(stream, device) {
  const vCodec = VIDEO_CODEC[stream.videoRisk];
  const aCodec = AUDIO_CODEC[stream.audioRisk];
  const hdr = Boolean(stream.hdr);
  const pictureBlocked = (Boolean(vCodec) && !device.videoCodecs.includes(vCodec))
    || (hdr && device.hdr10Decode === false);
  const audioBlocked = Boolean(aCodec) && !device.audioCodecs.includes(aCodec);
  let level = 'direct';
  if (pictureBlocked) level = 'reencode';
  else if (audioBlocked || stream.notWebReady) level = 'compat';
  return {
    level,
    hdr,
    hdrOnSdrScreen: hdr && !device.screenHdr,
    dvOnly: isDolbyVisionOnly(stream),
    audioBlocked,
  };
}

// Best stream to recommend: never one that needs its picture re-encoded, then the highest
// quality the screen can show, SDR ahead of HDR on an SDR screen, then the healthiest swarm.
export function pickBest(streams, verdicts, device) {
  const cap = screenRank(device.screenWidth);
  let best = null;
  let bestScore = -Infinity;
  for (const s of streams) {
    const v = verdicts.get(s.streamId);
    if (!v || v.level === 'reencode') continue;
    let score = Math.min(QUALITY_RANK[s.quality] || 2, cap) * 1000;
    if (v.level === 'direct') score += 800;
    if (v.hdrOnSdrScreen) score -= 1500;
    if (v.dvOnly) score -= 3000;
    score += Math.min(Number(s.seeders) || 0, 900) / 10;
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

// device: see probeDevice. streams: the ones this viewer can see. current: the stream they are on.
export function evaluate({ device, streams, current = null, isHost = false, relayEnabled = true }) {
  const verdicts = new Map(streams.map((s) => [s.streamId, streamVerdict(s, device)]));
  const count = (test) => streams.filter((s) => test(s, verdicts.get(s.streamId))).length;
  const counts = {
    total: streams.length,
    direct: count((s, v) => v.level === 'direct'),
    compat: count((s, v) => v.level === 'compat'),
    reencode: count((s, v) => v.level === 'reencode'),
  };
  const hevcStreams = count((s) => VIDEO_CODEC[s.videoRisk] === 'hevc');
  const heavyStreams = count((s) => s.quality === '2160p' || VIDEO_CODEC[s.videoRisk] || s.hdr);
  const uhdStreams = count((s) => s.quality === '2160p');
  const hdrStreams = count((s, v) => v.hdr);
  const dvStreams = count((s) => s.hdr === 'Dolby Vision');
  const dvOnlyStreams = count((s, v) => v.dvOnly);
  const audioStreams = count((s, v) => v.audioBlocked);
  const best = pickBest(streams, verdicts, device);
  const currentVerdict = current ? verdicts.get(current.streamId) || null : null;
  const hasHevc = device.videoCodecs.includes('hevc');
  const problems = [];
  const add = (id, level, title, detail, advice = []) => problems.push({ id, level, title, detail, advice });

  if (!hasHevc && hevcStreams) {
    add('hevc', 'warn', 'Tarayıcın HEVC (x265) görüntüyü açamıyor',
      `${hevcStreams} kaynak HEVC ya da Dolby Vision kullanıyor (4K ve HDR dosyaların çoğu böyle). Bunlar doğrudan açılmaz.`, [
        'Windows: Microsoft Store\'dan "HEVC Video Uzantıları"nı kur, tarayıcıyı yeniden başlat.',
        'Tarayıcıda donanım hızlandırma açık olmalı, ekran kartı sürücüsü güncel olmalı.',
        'Bu arada HEVC/HDR yazmayan (x264) bir kaynak sorunsuz açılır.',
      ]);
  }
  if (device.gpu === false && heavyStreams) {
    add('no-gpu', 'warn', 'Donanım hızlandırma kapalı görünüyor',
      '4K, HEVC ve HDR videolar bu yüzden takılabilir ya da hiç açılmayabilir.', [
        'Edge: Ayarlar → Sistem ve performans → "Kullanılabilir olduğunda grafik hızlandırmayı kullan"ı aç, yeniden başlat.',
        'Chrome: Ayarlar → Sistem → "Mümkün olduğunda grafik hızlandırmayı kullan"ı aç, yeniden başlat.',
      ]);
  }
  if (hasHevc && device.hevc4kSmooth === false && uhdStreams) {
    add('slow-4k', 'warn', 'Bu cihaz 4K görüntüyü akıcı çözemeyebilir',
      `${uhdStreams} kaynak 4K. Cihazın bunları kare atlamadan oynatması beklenmiyor.`, [
        '1080p bir kaynak seç ya da oynatıcıdaki 🛠 Uyumlu mod → 1080p seçeneğini kullan.',
      ]);
  }
  if (hdrStreams && !device.screenHdr) {
    add('hdr-screen', 'warn', 'Ekranın HDR göstermiyor: HDR içerikler soluk ya da karanlık görünür',
      `${hdrStreams} kaynak HDR ya da Dolby Vision. Ekran veya Windows HDR'si kapalıyken bu videolar SDR'ye çevrilir; renkler soluk, karanlık sahneler koyu kalır.`, [
        'Ekranın HDR destekliyorsa: Windows Ayarlar → Sistem → Ekran → "HDR kullan"ı aç, tarayıcıyı yeniden başlat.',
        'HDR desteklemiyorsa HDR etiketi olmayan (SDR) bir kaynak seç; renkler en doğru onda çıkar.',
        'Kalite sekmesindeki Parlaklık/Renk ayarı karanlığı azaltır ama 4K videoda kare kaybına yol açabilir; 1080p ile kullan.',
      ]);
  }
  if (hdrStreams && hasHevc && device.hdr10Decode === false) {
    add('hdr-decode', 'warn', 'Tarayıcın HDR10 görüntüyü çözemiyor',
      `${hdrStreams} HDR kaynak var ama bu tarayıcı HDR (PQ) görüntüyü doğrudan çözemiyor.`, [
        'Ekran kartı sürücüsünü ve tarayıcıyı güncelle, donanım hızlandırmayı aç.',
        'HDR olmayan (SDR) bir kaynak seçebilirsin.',
      ]);
  }
  if (dvStreams) {
    add('dolby-vision', currentVerdict?.dvOnly ? 'warn' : 'info', 'Dolby Vision tarayıcıda gerçek DV olarak oynamaz',
      dvOnlyStreams
        ? `${dvOnlyStreams} kaynak sadece "DV" yazıyor (HDR10 yazmıyor). Bunlarda renkler yeşil/mor bozuk çıkabilir.`
        : 'Kaynakların hepsi DV + HDR10 yazıyor, HDR10 olarak sorunsuz açılır.',
      ['Dosya adında HDR10 ya da HDR10+ da geçen kaynağı tercih et.']);
  }
  if (device.stremio === false) {
    if (isHost) {
      add('stremio', 'error', 'Stremio açık değil',
        'Videolar senin bilgisayarındaki Stremio üzerinden oynar; kapalıyken hiçbir video açılmaz.',
        ['Stremio uygulamasını aç (oynatıcıdaki "🔌 Stremio\'ya bağlan" butonu da açar).']);
    } else if (!relayEnabled) {
      add('stremio', 'error', 'Stremio açık değil ve host relay\'i kapalı',
        'Bu cihazdan hiçbir video açılamaz.',
        ['Kendi Stremio\'nu aç ya da host\'tan "Host üzerinden izle"yi açmasını iste.']);
    } else {
      add('stremio', 'info', 'Stremio kapalı: videolar host üzerinden akacak',
        'Sorun yok; kendi Stremio\'nu açarsan host\'un internetini yormazsın.');
    }
  } else if (device.touch && !isHost && !relayEnabled) {
    add('stremio', 'error', 'Bu cihazda Stremio yok ve host relay\'i kapalı',
      'Telefondan video açılamaz.', ['Host\'tan "Host üzerinden izle"yi açmasını iste.']);
  }
  if (currentVerdict?.level === 'reencode' && !problems.some((p) => p.id === 'hevc' || p.id === 'hdr-decode')) {
    add('current', 'warn', 'Şu an izlediğin kaynağın görüntüsü açılamıyor',
      'Tarayıcın bu kaynağın görüntü biçimini çözemiyor; kalite düşmesin diye dönüştürülmüyor.',
      ['Aşağıdaki önerilen kaynağa geç ya da Kalite sekmesinden başka bir kaynak seç.']);
  }
  if (audioStreams) {
    add('audio', 'info', 'Bazı kaynakların sesi tarayıcıda açılmaz',
      `${audioStreams} kaynağın sesi (AC3/DTS/TrueHD) doğrudan çalmaz. Uyumlu mod sesi otomatik dönüştürür, görüntü kalitesi düşmez.`);
  }
  problems.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  return {
    problems,
    needsAttention: problems.some((p) => p.level !== 'info'),
    counts,
    best,
    hdrStreams,
    current: currentVerdict,
    verdicts,
  };
}

// Which torrents the automatic scan on room join should test. Every test opens the torrent in the
// host's Stremio and pulls real data, so only well-seeded ones are scanned (best first, capped).
// If nothing is well seeded, the few best-seeded are tried instead. Streams whose addon gives no
// seed count are left to the manual "test all" button.
export const AUTO_SCAN_MIN_SEEDERS = 100;
export const AUTO_SCAN_MAX = 3;
export const AUTO_SCAN_FALLBACK = 5;

export function autoScanTargets(streams) {
  const ranked = streams
    .filter((s) => s.kind === 'torrent' && Number.isFinite(s.seeders))
    .sort((a, b) => b.seeders - a.seeders);
  const strong = ranked.filter((s) => s.seeders >= AUTO_SCAN_MIN_SEEDERS);
  return strong.length ? strong.slice(0, AUTO_SCAN_MAX) : ranked.slice(0, AUTO_SCAN_FALLBACK);
}

// Reads what this browser/screen/machine can do. Browser only.
// codecs: browserCodecs(); hw: checkHardware() result; stremioUp: isStremioUp() result.
export async function probeDevice({ codecs, hw, stremioUp, touch }) {
  const media = (query) => {
    try {
      return Boolean(window.matchMedia(query).matches);
    } catch {
      return false;
    }
  };
  const decode = async (video) => {
    try {
      const info = await navigator.mediaCapabilities?.decodingInfo({ type: 'media-source', video });
      return info ? { supported: Boolean(info.supported), smooth: Boolean(info.smooth) } : null;
    } catch {
      return null;
    }
  };
  const uhd = { contentType: 'video/mp4; codecs="hvc1.2.4.L150.90"', width: 3840, height: 2160, bitrate: 25_000_000, framerate: 24 };
  const [plain, pq, hlg] = await Promise.all([
    decode(uhd),
    decode({ ...uhd, transferFunction: 'pq', colorGamut: 'rec2020', hdrMetadataType: 'smpteSt2086' }),
    decode({ ...uhd, transferFunction: 'hlg', colorGamut: 'rec2020' }),
  ]);
  return {
    videoCodecs: codecs.videoCodecs,
    audioCodecs: codecs.audioCodecs,
    hevc4kSmooth: plain ? plain.smooth : null,
    hdr10Decode: pq ? pq.supported : null,
    hlgDecode: hlg ? hlg.supported : null,
    screenHdr: media('(dynamic-range: high)') || media('(video-dynamic-range: high)'),
    screenWidth: Math.round((window.screen?.width || 0) * (window.devicePixelRatio || 1)),
    gpu: hw ? hw.gpu : null,
    gpuRenderer: hw?.renderer || '',
    stremio: stremioUp,
    touch,
  };
}
