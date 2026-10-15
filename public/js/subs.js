// Subtitle tab: list, host-shared selection, personal override, delay, style.

import { el, toast, storage, errorText } from './ui.js';
import { decodeSubtitle, toVtt, langLabel, normalizeLang } from './shared/subtitle-text.js';
import { cueListesi } from './shared/altyazi-hizala.js';
import { ozelAdlariBul } from './shared/zor-kelime-sec.js';
import { SEVIYELER } from './zor-kelime.js';

const MAX_BYTES = 2 * 1024 * 1024;
const STEP = 0.5;

export function createSubs({
  panel, video, playerEl, roomId, request, isHost, userToken,
  embeddedInfo = () => null, embeddedLangs: embeddedLangsOf = () => [],
  audioTracks = () => [], onSelectAudio = () => {},
  multiAudioLikely = () => false, compatActive = () => false, onSwitchCompat = () => {},
  reencodeBlocked = () => false, onForceCompat = () => {},
  streamKey = () => null,
  zorKelime = null,
}) {
  let list = [];
  let hostSel = null; // { subId, offset } | null, shared by the host
  let personal = null; // { subId, offset } when this viewer chose on their own
  const localFiles = []; // guest-only uploads: { subId, label, url }
  let trackEl = null;
  let appliedId = null;
  let trackFailed = false;
  // İkinci altyazı (alt satır): İngilizce izlerken altında Türkçesi. Host bir varsayılan
  // seçebiliyor, isteyen kendi için değiştiriyor/kapatıyor (herkesin İngilizcesi aynı değil).
  // İki dosyanın zamanlaması tutmadığı için sunucu ikinciyi birinciye hizalayıp veriyor.
  let hostSel2 = null;
  let personal2 = null;
  let trackEl2 = null;
  let appliedId2 = null;
  let trackFailed2 = false;
  let hiza = null; // { subId, ref, durum: 'bekliyor'|'oldu'|'olmadi'|'yok', ... }
  // Masaüstü/telefon uygulamasında dosyanın içindeki (gömülü) altyazıyı seçen kişi.
  // Kişisel seçim: oynatıcı çiziyor, odanın altyazısı bu kişide kapanıyor.
  let embeddedChosen = null;
  // Varsayılan: yalnızca Türkçe ve İngilizce altyazılar listelenir; kişi "Diğer dilleri de
  // göster" derse hepsi (tercih bu cihazda saklanır). Seçili olan hangi dilde olursa olsun görünür.
  let showAllLangs = storage.get('tumAltyaziDilleri') === '1';
  // Kişisel ses gecikmesi (masaüstü): bluetooth kulaklıkta ses görüntünün gerisinde kalırsa.
  let audioDelay = Number(storage.get('sesGecikme')) || 0;
  function nudgeAudioDelay(delta) {
    audioDelay = delta === null ? 0 : Math.round(Math.min(5, Math.max(-5, audioDelay + delta)) * 10) / 10;
    storage.set('sesGecikme', String(audioDelay));
    window.masaustuBilgi?.(`Ses gecikmesi ${audioDelay > 0 ? '+' : ''}${audioDelay.toFixed(1)} sn`);
    render();
  }
  // Sıra her platformda aynı: önce Türkçe, sonra İngilizce, sonra diğerleri (kendi sırasıyla).
  const embeddedRank = (t) => {
    const key = `${t.lang || ''} ${t.title || ''}`.toLowerCase();
    if (/(^|[^a-zçğıöşü])(tur|tr|turkish|türkçe|turkce)([^a-zçğıöşü]|$)/.test(key)) return 0;
    if (/(^|[^a-zçğıöşü])(eng|en|english|ingilizce|i̇ngilizce)([^a-zçğıöşü]|$)/.test(key)) return 1;
    return 2;
  };
  const groupRank = (name) => (name === 'Senin dosyaların' ? 0 : name === langLabel('tur') ? 1 : name === langLabel('eng') ? 2 : 3);
  const embeddedTracks = () => (window.masaustuGomulu?.liste() || [])
    .map((t, i) => ({ t, i }))
    .sort((a, b) => embeddedRank(a.t) - embeddedRank(b.t) || a.i - b.i)
    .map(({ t }) => t);
  // Parça listesi gelince (dosya yüklendi) paylaşılan gömülü seçimi eşleştir.
  window.addEventListener('masaustu-gomulu', () => apply());
  // Gömülü altyazı, uygulamalar arasında "dil + o dildeki sırası" ile anlatılıyor:
  // mpv ile ExoPlayer'ın parça numaraları farklı, dosyadaki sıra aynı.
  const embeddedKey = (track) => {
    const label = track.lang ? langLabel(track.lang) : 'Bilinmeyen';
    const same = embeddedTracks().filter((t) => (t.lang ? langLabel(t.lang) : 'Bilinmeyen') === label);
    return `gomulu:${label}:${Math.max(0, same.indexOf(track))}`;
  };
  const embeddedIdForKey = (key) => embeddedTracks().find((t) => embeddedKey(t) === key)?.id ?? null;
  let reloadCount = 0;
  const originals = new WeakMap();
  let size = Number(storage.get('cueSize')) || 1;
  let bg = storage.get('cueBg') ?? '0.6';
  // Personal vertical position: percent of the player height where the text ends; null = default.
  const savedLine = storage.get('cueLine');
  let line = savedLine === null || savedLine === '' ? null : Number(savedLine);
  const DEFAULT_LINE = 92;

  // Subtitles are drawn in our own layer above the video (not the browser's
  // ::cue), so picture filters never touch them and size/position always work.
  const overlay = el('div', { class: 'sub-overlay', 'aria-live': 'off' });
  playerEl.append(overlay);

  // Text outline around the letters (text-shadow in em, so it scales with size).
  const ring = (w) => [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1.4], [0, 1.4], [-1.4, 0], [1.4, 0]]
    .map(([x, y]) => `${x * w}em ${y * w}em 0 #000`).join(', ');
  const OUTLINES = {
    none: ['Yok', 'none'],
    thin: ['İnce', ring(0.035)],
    thick: ['Kalın', `${ring(0.07)}, 0 0 0.12em #000`],
    shadow: ['Gölge', '0.07em 0.07em 0.14em rgba(0, 0, 0, .95), 0 0 0.25em rgba(0, 0, 0, .6)'],
  };
  let outline = OUTLINES[storage.get('cueOutline')] ? storage.get('cueOutline') : 'thin';
  function cycleOutline() {
    const keys = Object.keys(OUTLINES);
    outline = keys[(keys.indexOf(outline) + 1) % keys.length];
    storage.set('cueOutline', outline);
    applyStyle();
    render();
  }

  function applyStyle() {
    const px = Math.max(12, Math.round(playerEl.clientHeight * 0.045 * size));
    overlay.style.fontSize = `${px}px`;
    overlay.style.setProperty('--sub-bg', `rgba(0, 0, 0, ${bg})`);
    overlay.style.setProperty('--sub-shadow', OUTLINES[outline][1]);
    // 100'ün üstü masaüstünde videonun altındaki siyah boşluğa iner; tarayıcıda alt kenarda kalır.
    overlay.style.bottom = `${Math.max(0, 100 - (line ?? DEFAULT_LINE))}%`;
    window.masaustuAltyazi?.stil({ size, bg: Number(bg), outline, line: line ?? DEFAULT_LINE });
  }
  new ResizeObserver(applyStyle).observe(playerEl);

  function renderCues() {
    const lines = [];
    for (const cue of trackEl?.track?.activeCues || []) {
      const span = el('span', { class: 'sub-line' });
      span.append(cue.getCueAsHTML()); // browser-parsed VTT markup (i, b, u only), never raw HTML
      lines.push(span);
    }
    // İkinci altyazı birincinin altında, daha küçük puntoyla: hangisinin asıl olduğu
    // belli olsun ve iki satır dar ekranda görüntünün yarısını yemesin.
    for (const cue of trackEl2?.track?.activeCues || []) {
      const span = el('span', { class: 'sub-line sub-line-2' });
      span.append(cue.getCueAsHTML());
      lines.push(span);
    }
    overlay.replaceChildren(...lines);
  }

  const effective = () => personal || hostSel || { subId: null, offset: 0 };
  const effective2 = () => personal2 || hostSel2 || { subId: null, offset: 0 };
  const findSub = (id) => localFiles.find((f) => f.subId === id) || list.find((s) => s.subId === id);
  const srcFor = (id, ref = null) => {
    const yerel = localFiles.find((f) => f.subId === id)?.url;
    if (yerel) return yerel;
    const q = new URLSearchParams();
    if (ref) q.set('ref', ref); // sunucu ikinciyi birinciye hizalayıp veriyor
    if (reloadCount) q.set('r', String(reloadCount));
    const kuyruk = q.toString();
    return `/sub/${roomId}/${encodeURIComponent(id)}.vtt${kuyruk ? `?${kuyruk}` : ''}`;
  };
  // Hizalamanın dayanağı: birinci altyazı listeden geliyorsa onun subId'si. Gömülü
  // (dosyanın içindeki) ya da kişinin kendi yüklediği dosyada sunucuda karşılığı yok,
  // o zaman hizalama yapılamıyor.
  const hizaRefi = () => {
    const birinci = effective().subId;
    if (!birinci || birinci.startsWith('gomulu:') || localFiles.some((f) => f.subId === birinci)) return null;
    return birinci;
  };

  // iOS's own fullscreen player can only show native subtitles.
  let nativeFullscreen = false;
  video.addEventListener('webkitbeginfullscreen', () => { nativeFullscreen = true; showOnly(); });
  video.addEventListener('webkitendfullscreen', () => { nativeFullscreen = false; showOnly(); });

  function showOnly() {
    for (const t of video.textTracks) {
      const birinci = trackEl && t === trackEl.track;
      const ikinci = trackEl2 && t === trackEl2.track;
      // iOS'un kendi tam ekranında yalnız birinci altyazı gösterilebiliyor (ikinci
      // satırı kendi katmanımız çiziyor, oraya HTML gelmiyor).
      if (birinci) t.mode = nativeFullscreen ? 'showing' : 'hidden';
      else if (ikinci) t.mode = 'hidden';
      else t.mode = 'disabled';
    }
    renderCues();
  }

  function shift(offset, element = trackEl) {
    const cues = element?.track?.cues;
    if (!cues) return;
    for (const cue of cues) {
      let o = originals.get(cue);
      if (!o) {
        o = { start: cue.startTime, end: cue.endTime };
        originals.set(cue, o);
      }
      cue.startTime = Math.max(0, o.start + offset);
      cue.endTime = Math.max(0, o.end + offset);
    }
  }

  function applyLine() {
    applyStyle();
  }

  function resize(delta) {
    size = Math.round(Math.min(4, Math.max(0.3, size + delta)) * 10) / 10;
    storage.set('cueSize', String(size));
    applyStyle();
    render();
  }

  function moveLine(delta) {
    line = delta === null ? null : Math.round(Math.min(200, Math.max(0, (line ?? DEFAULT_LINE) + delta)) * 10) / 10;
    storage.set('cueLine', line === null ? '' : String(line));
    applyLine();
    render();
  }

  function apply() {
    const eff = effective();
    if (eff.subId !== appliedId) {
      trackEl?.remove();
      trackEl = null;
      appliedId = eff.subId;
      trackFailed = false;
      if (eff.subId && findSub(eff.subId)) {
        trackEl = el('track', { kind: 'subtitles', src: srcFor(eff.subId), srclang: 'tr', label: 'Altyazı' });
        trackEl.addEventListener('load', () => {
          shift(effective().offset);
          renderCues();
        });
        trackEl.track.addEventListener('cuechange', renderCues);
        trackEl.addEventListener('error', () => {
          trackFailed = true;
          toast('Altyazı yüklenemedi. Altyazı sekmesinden tekrar deneyebilirsin.');
          render();
        });
        video.append(trackEl);
      }
      showOnly();
    }
    shift(eff.offset);
    applyIkinci();
    renderCues();
    render();
    // Masaüstü kabuğunda altyazıyı mpv çiziyor: mpv yerel (native) bir pencerede
    // çizdiği için ne <track> ipuçları ne de bu HTML katmanı videonun üstüne gelebiliyor.
    window.masaustuAltyazi?.uygula(eff.subId && findSub(eff.subId) ? srcFor(eff.subId) : null, eff.offset);
    // Dosyanın içindeki altyazı (host'un ya da kişisel seçim): oynatıcı çiziyor.
    const want = eff.subId?.startsWith('gomulu:') ? embeddedIdForKey(eff.subId) : null;
    if (want !== embeddedChosen) {
      window.masaustuGomulu?.sec(want || '');
      embeddedChosen = want;
    }
  }

  // ---- ikinci altyazı (alt satır) ------------------------------------------------------

  // Sunucudan hizalamanın sonucunu sorar: "otomatik hizalandı (+2,4 sn)" ya da
  // "hizalanamadı" yazabilmek için. Hesap sunucuda bir kez yapılıp saklanıyor.
  async function hizaSor(subId, ref) {
    hiza = { subId, ref, durum: 'bekliyor' };
    render();
    try {
      const res = await fetch(`/sub/${roomId}/${encodeURIComponent(subId)}/hiza.json?ref=${encodeURIComponent(ref)}`);
      const veri = await res.json();
      // Bu arada seçim değiştiyse gelen cevabı atıyoruz.
      if (hiza?.subId !== subId || hiza?.ref !== ref) return;
      hiza = veri?.ok
        ? { subId, ref, durum: 'oldu', mod: veri.mod, guven: veri.guven, kesin: veri.kesin, kaydirma: veri.kaydirma, nokta: veri.nokta }
        : { subId, ref, durum: 'olmadi', sebep: veri?.sebep || null, guven: veri?.guven ?? null };
    } catch {
      if (hiza?.subId === subId) hiza = { subId, ref, durum: 'olmadi', sebep: 'ag' };
    }
    render();
  }

  function applyIkinci() {
    const eff2 = effective2();
    const ref = hizaRefi();
    // Hizalama dayanağı değişirse (birinci altyazı değişti) dosyayı yeniden almalıyız.
    const anahtar = eff2.subId ? `${eff2.subId}|${ref || ''}` : null;
    if (anahtar !== appliedId2) {
      trackEl2?.remove();
      trackEl2 = null;
      appliedId2 = anahtar;
      trackFailed2 = false;
      if (eff2.subId && findSub(eff2.subId)) {
        trackEl2 = el('track', { kind: 'subtitles', src: srcFor(eff2.subId, ref), srclang: 'tr', label: 'İkinci altyazı' });
        trackEl2.addEventListener('load', () => {
          shift(effective2().offset, trackEl2);
          renderCues();
        });
        trackEl2.track.addEventListener('cuechange', renderCues);
        trackEl2.addEventListener('error', () => {
          trackFailed2 = true;
          toast('İkinci altyazı yüklenemedi.');
          render();
        });
        video.append(trackEl2);
        if (ref) hizaSor(eff2.subId, ref);
        else hiza = { subId: eff2.subId, ref: null, durum: 'yok' };
      } else hiza = null;
      showOnly();
    }
    shift(eff2.offset, trackEl2);
    // Masaüstünde ikinci satırı mpv'nin kendi "ikincil altyazı"sı çiziyor.
    window.masaustuAltyazi?.ikinci?.(eff2.subId && findSub(eff2.subId) ? srcFor(eff2.subId, ref) : null, eff2.offset);
  }

  // Host seçerse herkese gider (varsayılan), isteyen kendi için değiştirir.
  async function choose2(subId) {
    if (subId && subId === effective().subId) return toast('Bu altyazı zaten üst satırda.');
    if (isHost() && !personal2 && !localFiles.some((f) => f.subId === subId)) {
      const res = await request('setHostSubtitle2', { subId, offset: subId === hostSel2?.subId ? hostSel2.offset : 0 });
      if (res?.error) toast(errorText(res.error));
      return;
    }
    personal2 = { subId, offset: 0 };
    apply();
  }

  async function nudge2(delta) {
    const eff2 = effective2();
    const offset = Math.round((eff2.offset + delta) * 10) / 10;
    if (isHost() && !personal2) {
      const res = await request('setHostSubtitle2', { subId: eff2.subId, offset });
      if (res?.error) toast(errorText(res.error));
      return;
    }
    personal2 = { subId: eff2.subId, offset };
    apply();
  }

  // ---- zor kelime kutusu beslemesi -----------------------------------------------------

  // Kutu yalnız İngilizce altyazıda çalışıyor (Türkçesini yazdığımız dil İngilizce).
  function birinciIngilizceMi() {
    const id = effective().subId;
    if (!id) return false;
    if (id.startsWith('gomulu:')) return id.split(':')[1] === langLabel('eng');
    return normalizeLang(findSub(id)?.lang) === 'eng';
  }

  // Masaüstünde altyazıyı mpv çiziyor, sayfanın <track> ipuçları çalışmıyor: ekranda
  // hangi repliğin durduğunu kendimiz hesaplıyoruz (tarayıcıda da aynı yol, tek kod).
  let zorCueler = null;
  let zorKaynak = null;
  async function zorCueleriHazirla() {
    const id = effective().subId;
    const anahtar = zorKelime?.acikMi() && birinciIngilizceMi() && id && !id.startsWith('gomulu:')
      ? `${id}|${reloadCount}` : null;
    if (anahtar === zorKaynak) return;
    zorKaynak = anahtar;
    zorCueler = null;
    if (!anahtar) return;
    try {
      const metin = await (await fetch(srcFor(id))).text();
      if (zorKaynak !== anahtar) return;
      zorCueler = cueListesi(metin);
      // Filmin özel adları (Sollozzo, Dufresne): kutuya girmesinler.
      zorKelime.ozelAdlariAyarla(ozelAdlariBul(zorCueler.map((c) => c.metin)));
    } catch { /* kutu sessiz kalır */ }
  }

  setInterval(() => {
    if (!zorKelime?.acikMi()) return;
    zorCueleriHazirla();
    if (!zorCueler?.length) return zorKelime.goster('', birinciIngilizceMi());
    const t = video.currentTime - effective().offset;
    const cue = zorCueler.find((c) => t >= c.b && t <= c.s);
    zorKelime.goster(cue?.metin || '', true);
  }, 300);

  // Host seçerse herkese gider (her uygulama aynı dili kendi listesinde bulur),
  // misafir seçerse yalnızca onda.
  function chooseEmbedded(track) {
    choose(embeddedKey(track));
  }

  // ---- Otomatik altyazı (host, Ayarlar'dan kapatılabilir): kaynak seçilince önce dosyanın
  // içindeki (gömülü) Türkçe, yoksa listedeki (harici) Türkçe, o da yoksa hiçbiri seçilir.
  // Gömülü parça listesi dosya açılınca geliyor; gelmezse 12 sn sonra harici Türkçeye bakılır.
  // Kişi o kaynakta elle seçim yaptıysa dokunulmaz.
  let autoDoneFor = null;
  let autoWaitFrom = null;
  let manualFor = null;
  const isTurkishSub = (s) => langLabel(s.lang) === langLabel('tur');
  function autoPick() {
    const key = streamKey();
    if (!key || !isHost() || storage.get('otoAltyazi') === '0') return;
    if (autoDoneFor === key || manualFor === key) return;
    if (autoWaitFrom?.key !== key) autoWaitFrom = { key, at: Date.now() };
    const gomuluTr = embeddedTracks().find((t) => embeddedRank(t) === 0);
    if (gomuluTr) {
      autoDoneFor = key;
      if (hostSel?.subId !== embeddedKey(gomuluTr)) choose(embeddedKey(gomuluTr), { auto: true });
      return;
    }
    const embeddedKnown = embeddedTracks().length > 0;
    if (!embeddedKnown && Date.now() - autoWaitFrom.at < 12_000) return;
    const harici = list.find(isTurkishSub);
    if (!harici && !list.length && Date.now() - autoWaitFrom.at < 20_000) return; // liste henüz gelmedi
    autoDoneFor = key;
    if (harici) {
      if (hostSel?.subId !== harici.subId) choose(harici.subId, { auto: true });
    } else if (hostSel?.subId?.startsWith('gomulu:')) {
      // Önceki kaynağın gömülü altyazısı bu dosyada yok: kapat.
      choose(null, { auto: true });
    }
  }
  setInterval(autoPick, 1500);

  async function choose(subId, { auto = false } = {}) {
    if (!auto) manualFor = streamKey();
    const localOnly = localFiles.some((f) => f.subId === subId);
    if (isHost() && !localOnly) {
      personal = null;
      const res = await request('setHostSubtitle', { subId, offset: subId === hostSel?.subId ? hostSel.offset : 0 });
      if (res?.error) toast(errorText(res.error));
      return;
    }
    personal = { subId, offset: 0 };
    apply();
  }

  function reloadTrack() {
    reloadCount++;
    appliedId = null; // forces a fresh <track>
    apply();
  }

  async function refreshList() {
    const res = await request('refreshSubtitles');
    if (res?.error === 'rate') toast('Liste az önce yenilendi, birkaç saniye bekle.');
    else if (res?.error) toast(errorText(res.error));
    else toast('Altyazı listesi yenileniyor…');
  }

  async function nudge(delta) {
    const eff = effective();
    const offset = Math.round((eff.offset + delta) * 10) / 10;
    if (isHost() && !personal) {
      const res = await request('setHostSubtitle', { subId: eff.subId, offset });
      if (res?.error) toast(errorText(res.error));
      return;
    }
    personal = { subId: eff.subId, offset };
    apply();
  }

  async function upload(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) return toast('Dosya 2 MB sınırını aşıyor.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isHost()) {
      const res = await fetch(`/room/${roomId}/subtitles`, {
        method: 'POST',
        headers: { 'x-user-token': userToken, 'x-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' },
        body: bytes,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return toast(body.error || 'Yükleme başarısız.');
      toast('Altyazı herkese eklendi.');
      await choose(body.subId);
      return;
    }
    const vtt = toVtt(decodeSubtitle(bytes, /\btr\b|tur|türk/i.test(file.name) ? 'tur' : 'und'));
    const subId = `l${localFiles.length + 1}`;
    localFiles.push({ subId, label: `📄 ${file.name.slice(0, 60)}`, url: URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })) });
    personal = { subId, offset: 0 };
    apply();
  }

  function subButton(s, current) {
    return el(
      'li',
      {},
      el(
        'button',
        { type: 'button', class: s.subId === current ? 'current' : '', onclick: () => choose(s.subId) },
        el('span', { text: s.label }),
        el('span', { class: 'muted small', text: [s.matched ? '✓ bu dosyaya uygun' : '', hostSel?.subId === s.subId ? 'host' : ''].filter(Boolean).join(' · ') }),
      ),
    );
  }

  // "İkinci altyazı" kutusu: alt satırda ikinci bir dil. İngilizce izlerken altında
  // Türkçesini görmek için. Hizalamayı sunucu yapıyor, sonucu burada yazıyoruz.
  function ikinciSatirKutusu() {
    const eff = effective();
    const eff2 = effective2();
    const secili = eff2.subId ? findSub(eff2.subId) : null;
    // Üst satırda olan altyazı listede ikinci kez çıkmasın.
    const secenekler = list.filter((s) => s.subId !== eff.subId);
    const secim = el('select', { onchange: (e) => choose2(e.target.value || null) },
      el('option', { value: '', selected: eff2.subId ? null : true }, 'Kapalı'),
      ...secenekler.map((s) => el('option', {
        value: s.subId,
        selected: s.subId === eff2.subId ? true : null,
      }, `${langLabel(s.lang)} · ${s.label}`.slice(0, 70))));

    const durumYazi = () => {
      if (!eff2.subId) return null;
      if (!hiza || hiza.subId !== eff2.subId) return null;
      if (hiza.durum === 'bekliyor') return el('span', { class: 'muted small', text: '⏳ iki altyazı hizalanıyor…' });
      if (hiza.durum === 'yok') {
        return el('span', { class: 'muted small', text: 'ℹ️ Üst satır dosyanın içindeki ya da kendi yüklediğin altyazı olduğu için otomatik hizalama yapılamıyor; gecikmeyi elle ayarla.' });
      }
      if (hiza.durum === 'oldu') {
        const ne = hiza.mod === 'parcali' ? 'film boyunca değişen kayma düzeltildi'
          : hiza.mod === 'oranli' ? 'kare hızı farkı düzeltildi'
            : `${hiza.kaydirma > 0 ? '+' : ''}${Number(hiza.kaydirma).toFixed(1)} sn kaydırıldı`;
        return el('span', {
          class: hiza.kesin ? 'muted small' : 'small',
          text: `${hiza.kesin ? '✅' : '⚠️'} Otomatik hizalandı: ${ne}${hiza.kesin ? '' : ` (güven %${Math.round(hiza.guven * 100)}, şüpheli)`}`,
        });
      }
      return el('span', { class: 'small', text: hiza.sebep === 'ag'
        ? '⚠️ Hizalama sonucu alınamadı.'
        : `⚠️ Otomatik hizalanamadı${hiza.guven !== null ? ` (uyum %${Math.round(hiza.guven * 100)})` : ''}: bu altyazı başka bir sürüm için olabilir. Gecikmeyi elle ayarla ya da başka bir altyazı dene.` });
    };

    const kip = personal2
      ? el('div', { class: 'row' }, el('span', { class: 'muted small', text: '👤 İkinci satır sende kişisel' }),
        el('button', { type: 'button', text: "Host'unkine dön", onclick: () => { personal2 = null; apply(); } }))
      : el('div', { class: 'muted small', text: isHost() ? 'Seçtiğin ikinci altyazı herkese varsayılan olur; isteyen kendi için kapatabilir.' : "Host'un ikinci altyazısını izliyorsun. Kendin seçersen yalnız sende değişir." });

    return [
      el('h3', {}, '🔤 İkinci altyazı (alt satır)'),
      el('div', { class: 'muted small', text: 'Üstte seçtiğin altyazı, altında bu. İngilizce izleyip altında Türkçesini görmek için.' }),
      el('div', { class: 'row' }, el('span', { class: 'muted small', text: 'Altyazı' }), secim),
      trackFailed2
        ? el('div', { class: 'row warning-row' },
          el('span', { text: '⚠️ İkinci altyazı yüklenemedi.' }),
          el('button', { type: 'button', text: '↻ Tekrar yükle', onclick: () => { appliedId2 = null; apply(); } }))
        : null,
      secili ? el('div', { class: 'row' },
        el('span', { class: 'muted small', text: 'Alt satır gecikmesi' }),
        el('button', { type: 'button', text: `−${STEP}`, onclick: () => nudge2(-STEP) }),
        el('button', { type: 'button', text: '−0.1', onclick: () => nudge2(-0.1) }),
        el('span', { text: `${eff2.offset > 0 ? '+' : ''}${eff2.offset.toFixed(1)} sn` }),
        el('button', { type: 'button', text: '+0.1', onclick: () => nudge2(0.1) }),
        el('button', { type: 'button', text: `+${STEP}`, onclick: () => nudge2(STEP) }),
        el('span', { class: 'info-i', tabindex: '0', title: 'Üst satırın gecikmesinden ayrı: iki altyazı dosyası farklı zamanlamada olabilir.' }, 'i')) : null,
      durumYazi(),
      secili ? kip : null,
    ].filter(Boolean);
  }

  // "Zor kelimelerin Türkçesi" ayarı: yalnız İngilizce altyazıda işe yarıyor, o yüzden
  // kutunun yanında ne zaman çalıştığı da yazıyor. Varsayılan kapalı.
  function zorKelimeKutusu() {
    if (!zorKelime) return [];
    const acik = zorKelime.acikMi();
    const ingilizce = birinciIngilizceMi();
    return [
      el('h3', {}, '📖 Zor kelimelerin Türkçesi'),
      el('label', { class: 'row' },
        el('input', {
          type: 'checkbox',
          checked: acik || null,
          onchange: async (e) => { await zorKelime.ac(e.target.checked); render(); },
        }),
        ' Ekranda duran repliğin zor kelimelerini köşede göster'),
      acik ? el('div', { class: 'row' },
        el('span', { class: 'muted small', text: 'Seviyem' }),
        el('select', { onchange: (e) => { zorKelime.seviyeSec(e.target.value); render(); } },
          ...Object.entries(SEVIYELER).map(([deger, ad]) => el('option', {
            value: deger,
            selected: Number(deger) === zorKelime.seviyesi() ? true : null,
          }, `${ad} · ilk ${Number(deger).toLocaleString('tr')} kelimeyi biliyorum`))),
        el('span', { class: 'info-i', tabindex: '0', title: 'Bu sayının dışında kalan kelimeler "zor" sayılıp kutuda gösterilir. Kutudaki kelimeye dokununca öteki anlamları açılır.' }, 'i')) : null,
      acik && zorKelime.hata() ? el('div', { class: 'row warning-row' },
        el('span', { text: '⚠️ Sözlük yüklenemedi. Sunucuda sözlük dosyası olmayabilir.' })) : null,
      acik && !ingilizce ? el('div', { class: 'muted small', text: 'ℹ️ Kutu yalnız İngilizce altyazıda çalışıyor; üst satırda şu an İngilizce altyazı yok.' }) : null,
      acik ? el('div', { class: 'muted small', text: 'Sözlük: Wiktionary (CC BY-SA) · sıklık: SUBTLEX-US' }) : null,
    ].filter(Boolean);
  }

  function render() {
    const eff = effective();
    const offsetText = `${eff.offset > 0 ? '+' : ''}${eff.offset.toFixed(1)} sn`;
    const mode = personal
      ? el('div', { class: 'row' }, el('span', { text: '👤 Kişisel seçim (host değişiklikleri sana uygulanmıyor)' }),
        el('button', { type: 'button', text: "Host'unkine dön", onclick: () => { personal = null; apply(); } }))
      : el('div', { class: 'muted small', text: isHost() ? 'Seçtiğin altyazı herkese uygulanır.' : "Host'un seçimini izliyorsun. Kendin seçersen kişisel moda geçersin." });

    const groups = new Map();
    for (const s of [...localFiles.map((f) => ({ ...f, lang: 'local' })), ...list]) {
      const key = s.lang === 'local' ? 'Senin dosyaların' : langLabel(s.lang);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    // Languages the file carries inside it (from the release name). The browser
    // can't show those tracks, so they're listed as info, not as choices.
    // Uygulama dosyanın gerçek altyazı listesini veriyorsa onu gösteriyoruz; dosya
    // adından tahmin edilen "gömülü" bilgi satırlarına gerek kalmıyor.
    const allEmbedded = embeddedTracks();
    const realEmbedded = showAllLangs ? allEmbedded : allEmbedded.filter((t) => embeddedRank(t) <= 1 || eff.subId === embeddedKey(t));
    const embeddedLangs = new Set(allEmbedded.length ? [] : embeddedLangsOf());
    for (const lang of embeddedLangs) if (!groups.has(lang)) groups.set(lang, []);
    const embeddedRow = (lang) => el('li', { class: 'embedded' },
      el('span', { text: `💬 ${lang} · dosyanın içinde` }),
      el('span', { class: 'tag-embedded', text: 'gömülü' }),
      el('span', { class: 'info-i', tabindex: '0', title: 'Bu altyazı video dosyasının içinde. Tarayıcı gömülü altyazıyı gösteremez; bu dilde aşağıdan bir altyazı seç.' }, 'i'));

    // Türkçe/İngilizce dışındaki gruplar: yalnızca "hepsini göster" açıksa ya da seçili altyazı
    // o gruptaysa görünür.
    const sortedGroups = [...groups].map((g, i) => ({ g, i }))
      .sort((a, b) => groupRank(a.g[0]) - groupRank(b.g[0]) || a.i - b.i)
      .map(({ g }) => g);
    const visibleGroups = sortedGroups.filter(([name, subs]) => showAllLangs || groupRank(name) <= 2
      || subs.some((x) => x.subId === eff.subId));
    const hiddenCount = sortedGroups.filter((g) => !visibleGroups.includes(g)).reduce((n, [, subs]) => n + Math.max(1, subs.length), 0)
      + allEmbedded.length - realEmbedded.length;
    const fileInput = el('input', { type: 'file', accept: '.srt,.vtt,text/vtt', hidden: true, onchange: (e) => upload(e.target.files[0]) });
    // replaceChildren would print null/false as text, so drop them first.
    const put = (...nodes) => panel.replaceChildren(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
    const embedded = allEmbedded.length ? null : embeddedInfo();
    const embeddedGroup = allEmbedded.length
      ? [
        el('h3', {}, '📦 Dosyanın içindeki altyazılar'),
        el('ul', {}, ...realEmbedded.map((t, i) => el('li', {},
          el('button', {
            type: 'button',
            class: eff.subId === embeddedKey(t) ? 'current' : '',
            onclick: () => chooseEmbedded(t),
          },
          el('span', { text: t.title || (t.lang ? langLabel(t.lang) : `Altyazı ${i + 1}`) }),
          el('span', { class: 'muted small', text: [t.lang ? langLabel(t.lang) : '', isHost() ? 'herkese' : 'sadece sende'].filter(Boolean).join(' · ') }))))),
      ]
      : [];
    const tracks = audioTracks();
    // Köprü sayfadan sonra kurulabiliyor: her çizimde son değeri iletiyoruz (köprü tekrarı eliyor).
    window.masaustuSesGecikme?.(audioDelay);
    const audioDelayRow = window.masaustuSesGecikme
      ? el('div', { class: 'row' },
        el('span', { class: 'muted small', text: '🎧 Ses gecikmesi' }),
        el('button', { type: 'button', text: '−0.1', onclick: () => nudgeAudioDelay(-0.1) }),
        el('span', { text: `${audioDelay > 0 ? '+' : ''}${audioDelay.toFixed(1)} sn` }),
        el('button', { type: 'button', text: '+0.1', onclick: () => nudgeAudioDelay(0.1) }),
        audioDelay ? el('button', { type: 'button', text: 'Sıfırla', onclick: () => nudgeAudioDelay(null) }) : null,
        el('span', { class: 'info-i', tabindex: '0', title: 'Yalnızca sende. Ses görüntünün gerisindeyse (bluetooth kulaklık) eksiye, önündeyse artıya al.' }, 'i'))
      : null;
    const audioRow = tracks.length > 1
      ? el('div', { class: 'row' },
        el('span', { class: 'muted small', text: '🔊 Ses dili' }),
        el('select', { onchange: (e) => onSelectAudio(e.target.value) },
          ...tracks.map((t) => el('option', { value: t.id, selected: t.active || null }, t.label))))
      : null;
    // Normal (non-compat) playback can't see a file's alternate audio tracks at all
    // (browser limitation for MKV); only hls.js (Uyumlu mod) exposes them. And Uyumlu
    // mod itself can get blocked by "kaliteyi koru" when the picture needs re-encoding
    // (HEVC/Dolby Vision the browser can't decode) — that trade-off is a banner over
    // the player, easy to miss from this tab, so spell it out here too.
    const audioHint = tracks.length <= 1 && !compatActive() && reencodeBlocked()
      ? el('div', { class: 'row' },
        el('span', { text: '🔊 Ses dilini görmek için görüntü dönüştürülmesi gerekiyor, "Görüntü kalitesini koru" bunu engelliyor.' }),
        el('button', { type: 'button', text: 'Yine de dönüştür (kalite düşer)', onclick: onForceCompat }),
        el('span', { class: 'info-i', tabindex: '0', title: 'Bu dosyanın görüntü biçimini (HEVC/Dolby Vision) tarayıcı açamıyor. Kalite sekmesindeki "Görüntü kalitesini koru" açıkken bu yüzden dönüştürme yapılmıyor.' }, 'i'))
      : tracks.length <= 1 && !compatActive() && multiAudioLikely()
        ? el('div', { class: 'row' },
          el('span', { text: '🔊 Bu dosyada birden fazla ses dili olabilir (dosya adına göre).' }),
          el('button', { type: 'button', text: 'Uyumlu moda geç', onclick: onSwitchCompat }),
          el('span', { class: 'info-i', tabindex: '0', title: 'Tarayıcı normal oynatmada dosyanın alternatif ses parçalarını göremiyor. Uyumlu mod (hls.js) bazı dosyalarda bunları listeleyebilir; hepsinde çalışmayabilir.' }, 'i'))
        : null;
    put(
      audioRow,
      audioDelayRow,
      audioHint,
      mode,
      embedded ? el('div', { class: 'row' }, el('span', { text: '💬 Bu dosyada gömülü altyazı var' }),
        el('span', { class: 'info-i', tabindex: '0', title: embedded }, 'i')) : null,
      eff.subId?.startsWith('gomulu:') && !window.masaustuGomulu
        ? el('div', { class: 'row warning-row' },
          el('span', { text: `📦 Host dosyanın içindeki altyazıyı seçti (${eff.subId.split(':')[1]}). Tarayıcı bunu gösteremiyor: aşağıdan bir altyazı seç ya da Birlikte İzle uygulamasını kullan.` }))
        : null,
      trackFailed
        ? el('div', { class: 'row warning-row' },
          el('span', { text: '⚠️ Altyazı yüklenemedi.' }),
          el('button', { type: 'button', text: '↻ Tekrar yükle', onclick: reloadTrack }))
        : null,
      el('div', { class: 'row' },
        el('span', { class: 'muted small', text: 'Gecikme' }),
        el('button', { type: 'button', text: `−${STEP}`, disabled: !eff.subId, onclick: () => nudge(-STEP) }),
        el('button', { type: 'button', text: '−0.1', disabled: !eff.subId, onclick: () => nudge(-0.1) }),
        el('span', { text: offsetText }),
        el('button', { type: 'button', text: '+0.1', disabled: !eff.subId, onclick: () => nudge(0.1) }),
        el('button', { type: 'button', text: `+${STEP}`, disabled: !eff.subId, onclick: () => nudge(STEP) })),
      ...ikinciSatirKutusu(),
      ...zorKelimeKutusu(),
      el('div', { class: 'row' },
        el('span', { class: 'muted small', text: 'Yazı' }),
        el('button', { type: 'button', text: 'A−', title: 'Küçült', onclick: () => resize(-0.1) }),
        el('span', { class: 'muted small', text: `%${Math.round(size * 100)}` }),
        el('button', { type: 'button', text: 'A+', title: 'Büyüt', onclick: () => resize(0.1) }),
        el('button', { type: 'button', text: bg === '0' ? 'Arka plan: yok' : 'Arka plan: var', onclick: () => { bg = bg === '0' ? '0.6' : '0'; storage.set('cueBg', bg); applyStyle(); render(); } }),
        el('button', { type: 'button', text: `Kenarlık: ${OUTLINES[outline][0]}`, title: 'Harflerin etrafındaki çizgi: Yok / İnce / Kalın / Gölge', onclick: cycleOutline })),
      el('div', { class: 'row' },
        el('span', { class: 'muted small', text: 'Konum' }),
        el('button', { type: 'button', text: '▲ Yukarı', title: 'Altyazıyı yukarı taşı', onclick: () => moveLine(-2.5) }),
        el('button', { type: 'button', text: '▼ Aşağı', title: 'Altyazıyı aşağı taşı', onclick: () => moveLine(2.5) }),
        el('span', { class: 'muted small', text: line === null ? 'otomatik' : `%${line}` }),
        line === null ? null : el('button', { type: 'button', text: 'Sıfırla', onclick: () => moveLine(null) })),
      el('div', { class: 'row' },
        fileInput,
        el('button', { type: 'button', text: '📄 .srt / .vtt yükle', onclick: () => fileInput.click() }),
        el('span', { class: 'muted small', text: isHost() ? 'herkese eklenir' : 'sadece sende görünür' })),
      // Altyazı listesinin en üstünde; açıkken de görünsün ki geri kapatılabilsin.
      hiddenCount || showAllLangs
        ? el('label', { class: 'row muted small' },
          el('input', { type: 'checkbox', checked: showAllLangs || null, onchange: (e) => { showAllLangs = e.target.checked; storage.set('tumAltyaziDilleri', showAllLangs ? '1' : '0'); render(); } }),
          hiddenCount ? ` Diğer dilleri de göster (${hiddenCount})` : ' Diğer dilleri de göster')
        : null,
      el('ul', {}, el('li', {}, el('button', { type: 'button', class: eff.subId ? '' : 'current', onclick: () => choose(null), text: 'Kapalı' }))),
      ...embeddedGroup,
      el('div', { class: 'row' },
        el('span', { class: 'muted small', text: list.length ? `${list.length} altyazı` : 'Altyazı listesi boş ya da yükleniyor.' }),
        el('button', { type: 'button', text: '↻ Listeyi yenile', title: "Altyazıları addon'lardan yeniden çek", onclick: refreshList })),
      // Dil grupları her platformda aynı sırada: kendi dosyaların, Türkçe, İngilizce, diğerleri.
      ...visibleGroups
        .flatMap(([name, subs]) => {
        const emb = embeddedLangs.has(name);
        return [
          el('h3', {}, name, emb ? el('span', { class: 'tag-embedded', text: 'gömülü' }) : ''),
          el('ul', {}, ...(emb ? [embeddedRow(name)] : []), ...subs.map((s) => subButton(s, eff.subId))),
        ];
      }),
    );
  }

  applyStyle();
  render();

  return {
    setList(next) {
      list = next || [];
      if (personal?.subId && !findSub(personal.subId)) personal = null;
      if (personal2?.subId && !findSub(personal2.subId)) personal2 = null;
      apply();
    },
    setHost(sel) {
      hostSel = sel;
      apply();
    },
    setHost2(sel) {
      hostSel2 = sel;
      apply();
    },
    rerender: render,
  };
}
