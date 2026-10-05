// Canlı yayın (Discord'daki "Yayın Aç" gibi): host oynattığı görüntüyü + bilgisayar sesini bir
// kez sıkıştırıp WebRTC ile izleyicilere doğrudan gönderir. Görüntü bu sunucudan GEÇMEZ; sunucu
// yalnızca bağlantı kurma mesajlarını (SDP teklif/cevap) host ile o yayına katılmış izleyici
// arasında taşır ve kimin izlediğini tutar.
//
// Kurallar:
// - Yayını yalnız odanın host'u açar/kapatır. Host değişir ya da bağlantısı koparsa yayın biter.
// - İzleyici sayısı sınırlı (host'un upload'u her izleyiciye ayrı akış gönderiyor).
// - Sinyal yalnızca host <-> katılmış izleyici arasında: başka biri araya mesaj sokamaz.
// - ICE adayları ayrı ayrı gönderilmez (bağlantı başına saniyede 20 olay sınırı var): istemci
//   aday toplamayı bitirip tam SDP'yi tek mesajda yollar. İzleyici başına toplam 2 mesaj.

export const YAYIN_SINIR_VARSAYILAN = 6;
export const YAYIN_SINIR_EN_FAZLA = 20;
export const SINYAL_EN_BUYUK = 64 * 1024;          // SDP genelde 5-15 KB
export const KALITELER = {
  '720p30': { genislik: 1280, yukseklik: 720, fps: 30, kbps: 3500 },
  '1080p30': { genislik: 1920, yukseklik: 1080, fps: 30, kbps: 6000 },
  '1080p60': { genislik: 1920, yukseklik: 1080, fps: 60, kbps: 9000 },
  '1440p60': { genislik: 2560, yukseklik: 1440, fps: 60, kbps: 14000 },
};

// Ücretsiz, herkese açık STUN: çoğu ev bağlantısında doğrudan bağlantı için yeter. Mobil veri /
// sıkı NAT için TURN gerekir (config.yayin.iceServers ya da Cloudflare TURN anahtarı).
export const VARSAYILAN_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

export function createYayin({ iceServers = async () => VARSAYILAN_ICE, now = Date.now, log = null } = {}) {
  const yayinlar = new Map(); // roomId -> { hostUserId, kalite, sinir, izleyiciler: Map(userId -> at), baslangic }

  const durumMesaji = (room) => {
    const y = yayinlar.get(room.id);
    return {
      to: 'room',
      event: 'yayinDurum',
      data: y
        ? { aktif: true, hostUserId: y.hostUserId, kalite: y.kalite, sinir: y.sinir, izleyici: y.izleyiciler.size }
        : { aktif: false },
    };
  };

  // Host değiştiyse (devir) eski host'un yayını geçersiz: kapat.
  function gecerli(room) {
    const y = yayinlar.get(room.id);
    if (y && y.hostUserId !== room.hostUserId) {
      yayinlar.delete(room.id);
      return null;
    }
    return y || null;
  }

  function bitir(room, sebep) {
    if (!yayinlar.has(room.id)) return [];
    yayinlar.delete(room.id);
    log?.info?.('Yayın bitti', { roomId: room.id, sebep });
    return [durumMesaji(room)];
  }

  const events = {
    yayinBaslat: (room, uid, p) => {
      if (uid !== room.hostUserId) return { error: 'notHost' };
      const kalite = KALITELER[p?.kalite] ? p.kalite : '1080p30';
      const istenen = Number(p?.sinir);
      const sinir = Number.isInteger(istenen) && istenen >= 1 && istenen <= YAYIN_SINIR_EN_FAZLA ? istenen : YAYIN_SINIR_VARSAYILAN;
      const eski = gecerli(room);
      // Yeniden başlatma (kalite değişimi): izleyiciler yeniden bağlanır, liste sıfırlanır.
      yayinlar.set(room.id, { hostUserId: uid, kalite, sinir, izleyiciler: new Map(), baslangic: eski?.baslangic ?? now() });
      log?.info?.('Yayın açıldı', { roomId: room.id, kalite, sinir });
      return { reply: { ok: true, kalite, sinir, ...KALITELER[kalite] }, msgs: [durumMesaji(room)] };
    },

    yayinBitir: (room, uid) => {
      if (uid !== room.hostUserId) return { error: 'notHost' };
      return { reply: { ok: true }, msgs: bitir(room, 'host kapattı') };
    },

    // İzleyici yayına katılır; host'a "bu kişiye teklif gönder" denir.
    yayinKatil: async (room, uid) => {
      const y = gecerli(room);
      if (!y) return { error: 'yayinYok' };
      if (uid === y.hostUserId) return { error: 'badInput' };
      if (!y.izleyiciler.has(uid) && y.izleyiciler.size >= y.sinir) return { error: 'yayinDolu' };
      y.izleyiciler.set(uid, now());
      const ad = room.users.get(uid)?.name || '';
      return {
        reply: { ok: true, iceServers: await iceServers(), kalite: y.kalite },
        msgs: [{ to: y.hostUserId, event: 'yayinIzleyici', data: { userId: uid, ad } }, durumMesaji(room)],
      };
    },

    yayinAyril: (room, uid) => {
      const y = gecerli(room);
      if (!y || !y.izleyiciler.delete(uid)) return { reply: { ok: true }, msgs: [] };
      return { reply: { ok: true }, msgs: [{ to: y.hostUserId, event: 'yayinAyrildi', data: { userId: uid } }, durumMesaji(room)] };
    },

    // Host'un ICE ayarı (teklifi hazırlamadan önce ister).
    yayinIce: async (room, uid) => {
      if (uid !== room.hostUserId) return { error: 'notHost' };
      return { reply: { ok: true, iceServers: await iceServers() }, msgs: [] };
    },

    // SDP teklif/cevap taşıma: yalnız host <-> katılmış izleyici.
    yayinSinyal: (room, uid, p) => {
      const y = gecerli(room);
      if (!y) return { error: 'yayinYok' };
      const to = String(p?.to || '');
      const sinyal = p?.sinyal;
      if (!sinyal || typeof sinyal !== 'object' || !['teklif', 'cevap'].includes(sinyal.tur) || typeof sinyal.sdp !== 'string') {
        return { error: 'badInput' };
      }
      if (sinyal.sdp.length > SINYAL_EN_BUYUK) return { error: 'badInput' };
      const hostGonderiyor = uid === y.hostUserId;
      if (hostGonderiyor) {
        if (sinyal.tur !== 'teklif' || !y.izleyiciler.has(to)) return { error: 'badInput' };
      } else if (sinyal.tur !== 'cevap' || to !== y.hostUserId || !y.izleyiciler.has(uid)) {
        return { error: 'badInput' };
      }
      return { reply: { ok: true }, msgs: [{ to, event: 'yayinSinyal', data: { from: uid, sinyal: { tur: sinyal.tur, sdp: sinyal.sdp } } }] };
    },
  };

  return {
    events,
    // Odaya katılma cevabına eklenen yayın durumu: yayın açıksa izleyici doğrudan yayına girer
    // (kendi kaynağını hiç açmadan, otomatik kaynak aramadan).
    katilmaDurumu: (room) => durumMesaji(room).data,
    // Yeni katılan kişi açık bir yayını görsün.
    onJoin(room, uid) {
      const y = gecerli(room);
      return y ? [{ ...durumMesaji(room), to: uid }] : [];
    },
    // Bağlantısı kopan: host ise yayın biter; izleyiciyse listeden çıkar.
    onDisconnect(room, uid) {
      const y = gecerli(room);
      if (!y) return [];
      if (uid === y.hostUserId) return bitir(room, 'host ayrıldı');
      if (!y.izleyiciler.delete(uid)) return [];
      return [{ to: y.hostUserId, event: 'yayinAyrildi', data: { userId: uid } }, durumMesaji(room)];
    },
    kapat(roomId) {
      yayinlar.delete(roomId);
    },
    durum(roomId) {
      const y = yayinlar.get(roomId);
      return y ? { hostUserId: y.hostUserId, kalite: y.kalite, sinir: y.sinir, izleyiciler: [...y.izleyiciler.keys()] } : null;
    },
  };
}

// Cloudflare TURN: kalıcı anahtar sunucuda kalır, izleyiciye kısa ömürlü kimlik verilir.
// config.yayin = { cloudflareTurn: { keyId, token } } ya da { iceServers: [...] }.
export function createIceServers({ getConfig, fetchImpl = fetch, now = Date.now, log = null }) {
  let onbellek = null; // { at, servers }
  return async function iceServers() {
    const ayar = getConfig()?.yayin || {};
    const sabit = Array.isArray(ayar.iceServers) && ayar.iceServers.length ? ayar.iceServers : VARSAYILAN_ICE;
    const cf = ayar.cloudflareTurn;
    if (!cf?.keyId || !cf?.token) return sabit;
    if (onbellek && now() - onbellek.at < 30 * 60_000) return onbellek.servers;
    try {
      const yanit = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cf.keyId)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cf.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 4 * 3600 }),
        signal: AbortSignal.timeout(5000),
      });
      if (!yanit.ok) throw new Error(`HTTP ${yanit.status}`);
      const veri = await yanit.json();
      const servers = Array.isArray(veri.iceServers) ? veri.iceServers : [veri.iceServers].filter(Boolean);
      onbellek = { at: now(), servers: [...VARSAYILAN_ICE, ...servers] };
      return onbellek.servers;
    } catch (err) {
      log?.warn?.('Cloudflare TURN kimliği alınamadı, yalnız STUN', { error: err.message });
      return sabit;
    }
  };
}
