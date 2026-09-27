// Subtitle tab: list, host-shared selection, personal override, delay, style.

import { el, toast, storage, errorText } from './ui.js';
import { decodeSubtitle, toVtt, langLabel } from './shared/subtitle-text.js';

const MAX_BYTES = 2 * 1024 * 1024;
const STEP = 0.5;

export function createSubs({
  panel, video, playerEl, roomId, request, isHost, userToken,
  embeddedInfo = () => null, embeddedLangs: embeddedLangsOf = () => [],
  audioTracks = () => [], onSelectAudio = () => {},
  multiAudioLikely = () => false, compatActive = () => false, onSwitchCompat = () => {},
  reencodeBlocked = () => false, onForceCompat = () => {},
}) {
  let list = [];
  let hostSel = null; // { subId, offset } | null, shared by the host
  let personal = null; // { subId, offset } when this viewer chose on their own
  const localFiles = []; // guest-only uploads: { subId, label, url }
  let trackEl = null;
  let appliedId = null;
  let trackFailed = false;
  // Masaüstü/telefon uygulamasında dosyanın içindeki (gömülü) altyazıyı seçen kişi.
  // Kişisel seçim: oynatıcı çiziyor, odanın altyazısı bu kişide kapanıyor.
  let embeddedChosen = null;
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
    if (/(tur|tr|turkish|türkçe|turkce)/.test(key)) return 0;
    if (/(eng|en|english|ingilizce|İngilizce)/.test(key)) return 1;
    return 2;
  };
  const groupRank = (name) => (name === 'Senin dosyaların' ? 0 : name === langLabel('tur') ? 1 : name === langLabel('eng') ? 2 : 3);
  const embeddedTracks = () => (window.masaustuGomulu?.liste() || [])
    .map((t, i) => ({ t, i }))
    .sort((a, b) => embeddedRank(a.t) - embeddedRank(b.t) || a.i - b.i)
    .map(({ t }) => t);
  window.addEventListener('masaustu-gomulu', () => render());
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
    overlay.style.bottom = `${100 - (line ?? DEFAULT_LINE)}%`;
    window.masaustuAltyazi?.stil({ size, bg: Number(bg), outline, line: line ?? DEFAULT_LINE });
  }
  new ResizeObserver(applyStyle).observe(playerEl);

  function renderCues() {
    const cues = trackEl?.track?.activeCues;
    const lines = [];
    for (const cue of cues || []) {
      const span = el('span', { class: 'sub-line' });
      span.append(cue.getCueAsHTML()); // browser-parsed VTT markup (i, b, u only), never raw HTML
      lines.push(span);
    }
    overlay.replaceChildren(...lines);
  }

  const effective = () => personal || hostSel || { subId: null, offset: 0 };
  const findSub = (id) => localFiles.find((f) => f.subId === id) || list.find((s) => s.subId === id);
  const srcFor = (id) =>
    localFiles.find((f) => f.subId === id)?.url
    || `/sub/${roomId}/${encodeURIComponent(id)}.vtt${reloadCount ? `?r=${reloadCount}` : ''}`;

  // iOS's own fullscreen player can only show native subtitles.
  let nativeFullscreen = false;
  video.addEventListener('webkitbeginfullscreen', () => { nativeFullscreen = true; showOnly(); });
  video.addEventListener('webkitendfullscreen', () => { nativeFullscreen = false; showOnly(); });

  function showOnly() {
    for (const t of video.textTracks) {
      const ours = trackEl && t === trackEl.track;
      t.mode = ours ? (nativeFullscreen ? 'showing' : 'hidden') : 'disabled';
    }
    renderCues();
  }

  function shift(offset) {
    const cues = trackEl?.track?.cues;
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
    size = Math.round(Math.min(2.5, Math.max(0.6, size + delta)) * 10) / 10;
    storage.set('cueSize', String(size));
    applyStyle();
    render();
  }

  function moveLine(delta) {
    line = delta === null ? null : Math.min(100, Math.max(10, (line ?? DEFAULT_LINE) + delta));
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
    renderCues();
    render();
    // Masaüstü kabuğunda altyazıyı mpv çiziyor: mpv yerel (native) bir pencerede
    // çizdiği için ne <track> ipuçları ne de bu HTML katmanı videonun üstüne gelebiliyor.
    window.masaustuAltyazi?.uygula(eff.subId && findSub(eff.subId) ? srcFor(eff.subId) : null, eff.offset);
  }

  function clearEmbedded() {
    if (embeddedChosen === null) return;
    window.masaustuGomulu?.sec('');
    embeddedChosen = null;
  }

  function chooseEmbedded(id) {
    personal = { subId: null, offset: 0 };
    apply();
    window.masaustuGomulu?.sec(id);
    embeddedChosen = id;
    render();
  }

  async function choose(subId) {
    clearEmbedded();
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

  function render() {
    const eff = effective();
    const offsetText = `${eff.offset > 0 ? '+' : ''}${eff.offset.toFixed(1)} sn`;
    const mode = personal
      ? el('div', { class: 'row' }, el('span', { text: '👤 Kişisel seçim (host değişiklikleri sana uygulanmıyor)' }),
        el('button', { type: 'button', text: "Host'unkine dön", onclick: () => { clearEmbedded(); personal = null; apply(); } }))
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
    const realEmbedded = embeddedTracks();
    const embeddedLangs = new Set(realEmbedded.length ? [] : embeddedLangsOf());
    for (const lang of embeddedLangs) if (!groups.has(lang)) groups.set(lang, []);
    const embeddedRow = (lang) => el('li', { class: 'embedded' },
      el('span', { text: `💬 ${lang} · dosyanın içinde` }),
      el('span', { class: 'tag-embedded', text: 'gömülü' }),
      el('span', { class: 'info-i', tabindex: '0', title: 'Bu altyazı video dosyasının içinde. Tarayıcı gömülü altyazıyı gösteremez; bu dilde aşağıdan bir altyazı seç.' }, 'i'));

    const fileInput = el('input', { type: 'file', accept: '.srt,.vtt,text/vtt', hidden: true, onchange: (e) => upload(e.target.files[0]) });
    // replaceChildren would print null/false as text, so drop them first.
    const put = (...nodes) => panel.replaceChildren(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
    const embedded = realEmbedded.length ? null : embeddedInfo();
    const embeddedGroup = realEmbedded.length
      ? [
        el('h3', {}, '📦 Dosyanın içindeki altyazılar'),
        el('ul', {}, ...realEmbedded.map((t, i) => el('li', {},
          el('button', {
            type: 'button',
            class: embeddedChosen === t.id ? 'current' : '',
            onclick: () => chooseEmbedded(t.id),
          },
          el('span', { text: t.title || (t.lang ? langLabel(t.lang) : `Altyazı ${i + 1}`) }),
          el('span', { class: 'muted small', text: [t.lang ? langLabel(t.lang) : '', 'sadece sende'].filter(Boolean).join(' · ') }))))),
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
      trackFailed
        ? el('div', { class: 'row warning-row' },
          el('span', { text: '⚠️ Altyazı yüklenemedi.' }),
          el('button', { type: 'button', text: '↻ Tekrar yükle', onclick: reloadTrack }))
        : null,
      el('div', { class: 'row' },
        el('span', { class: 'muted small', text: 'Gecikme' }),
        el('button', { type: 'button', text: `−${STEP}`, disabled: !eff.subId, onclick: () => nudge(-STEP) }),
        el('span', { text: offsetText }),
        el('button', { type: 'button', text: `+${STEP}`, disabled: !eff.subId, onclick: () => nudge(STEP) })),
      el('div', { class: 'row' },
        el('span', { class: 'muted small', text: 'Yazı' }),
        el('button', { type: 'button', text: 'A−', title: 'Küçült', onclick: () => resize(-0.1) }),
        el('span', { class: 'muted small', text: `%${Math.round(size * 100)}` }),
        el('button', { type: 'button', text: 'A+', title: 'Büyüt', onclick: () => resize(0.1) }),
        el('button', { type: 'button', text: bg === '0' ? 'Arka plan: yok' : 'Arka plan: var', onclick: () => { bg = bg === '0' ? '0.6' : '0'; storage.set('cueBg', bg); applyStyle(); render(); } }),
        el('button', { type: 'button', text: `Kenarlık: ${OUTLINES[outline][0]}`, title: 'Harflerin etrafındaki çizgi: Yok / İnce / Kalın / Gölge', onclick: cycleOutline })),
      el('div', { class: 'row' },
        el('span', { class: 'muted small', text: 'Konum' }),
        el('button', { type: 'button', text: '▲ Yukarı', title: 'Altyazıyı yukarı taşı', onclick: () => moveLine(-5) }),
        el('button', { type: 'button', text: '▼ Aşağı', title: 'Altyazıyı aşağı taşı', onclick: () => moveLine(5) }),
        el('span', { class: 'muted small', text: line === null ? 'otomatik' : `%${line}` }),
        line === null ? null : el('button', { type: 'button', text: 'Sıfırla', onclick: () => moveLine(null) })),
      el('div', { class: 'row' },
        fileInput,
        el('button', { type: 'button', text: '📄 .srt / .vtt yükle', onclick: () => fileInput.click() }),
        el('span', { class: 'muted small', text: isHost() ? 'herkese eklenir' : 'sadece sende görünür' })),
      el('ul', {}, el('li', {}, el('button', { type: 'button', class: eff.subId || embeddedChosen !== null ? '' : 'current', onclick: () => choose(null), text: 'Kapalı' }))),
      ...embeddedGroup,
      el('div', { class: 'row' },
        el('span', { class: 'muted small', text: list.length ? `${list.length} altyazı` : 'Altyazı listesi boş ya da yükleniyor.' }),
        el('button', { type: 'button', text: '↻ Listeyi yenile', title: "Altyazıları addon'lardan yeniden çek", onclick: refreshList })),
      // Dil grupları her platformda aynı sırada: kendi dosyaların, Türkçe, İngilizce, diğerleri.
      ...[...groups].map((g, i) => ({ g, i }))
        .sort((a, b) => groupRank(a.g[0]) - groupRank(b.g[0]) || a.i - b.i)
        .map(({ g }) => g)
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
      apply();
    },
    setHost(sel) {
      hostSel = sel;
      apply();
    },
    rerender: render,
  };
}
