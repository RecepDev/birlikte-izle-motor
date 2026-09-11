// Subtitle tab: list, host-shared selection, personal override, delay, style.

import { el, toast, storage, errorText } from './ui.js';
import { decodeSubtitle, toVtt, langLabel } from './shared/subtitle-text.js';

const MAX_BYTES = 2 * 1024 * 1024;
const STEP = 0.5;

export function createSubs({ panel, video, playerEl, roomId, request, isHost, userToken }) {
  let list = [];
  let hostSel = null; // { subId, offset } | null, shared by the host
  let personal = null; // { subId, offset } when this viewer chose on their own
  const localFiles = []; // guest-only uploads: { subId, label, url }
  let trackEl = null;
  let appliedId = null;
  const originals = new WeakMap();
  let size = Number(storage.get('cueSize')) || 1;
  let bg = storage.get('cueBg') ?? '0.6';

  function applyStyle() {
    playerEl.style.setProperty('--cue-size', `${size}em`);
    playerEl.style.setProperty('--cue-bg', bg);
  }

  const effective = () => personal || hostSel || { subId: null, offset: 0 };
  const findSub = (id) => localFiles.find((f) => f.subId === id) || list.find((s) => s.subId === id);
  const srcFor = (id) => localFiles.find((f) => f.subId === id)?.url || `/sub/${roomId}/${encodeURIComponent(id)}.vtt`;

  function showOnly() {
    for (const t of video.textTracks) t.mode = trackEl && t === trackEl.track ? 'showing' : 'disabled';
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

  function apply() {
    const eff = effective();
    if (eff.subId !== appliedId) {
      trackEl?.remove();
      trackEl = null;
      appliedId = eff.subId;
      if (eff.subId && findSub(eff.subId)) {
        trackEl = el('track', { kind: 'subtitles', src: srcFor(eff.subId), srclang: 'tr', label: 'Altyazı' });
        trackEl.addEventListener('load', () => shift(effective().offset));
        trackEl.addEventListener('error', () => toast('Altyazı yüklenemedi.'));
        video.append(trackEl);
      }
      showOnly();
    }
    shift(eff.offset);
    render();
  }

  async function choose(subId) {
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
        el('button', { type: 'button', text: "Host'unkine dön", onclick: () => { personal = null; apply(); } }))
      : el('div', { class: 'muted small', text: isHost() ? 'Seçtiğin altyazı herkese uygulanır.' : "Host'un seçimini izliyorsun. Kendin seçersen kişisel moda geçersin." });

    const groups = new Map();
    for (const s of [...localFiles.map((f) => ({ ...f, lang: 'local' })), ...list]) {
      const key = s.lang === 'local' ? 'Senin dosyaların' : langLabel(s.lang);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }

    const fileInput = el('input', { type: 'file', accept: '.srt,.vtt,text/vtt', hidden: true, onchange: (e) => upload(e.target.files[0]) });
    panel.replaceChildren(
      mode,
      el('div', { class: 'row' },
        el('span', { class: 'muted small', text: 'Gecikme' }),
        el('button', { type: 'button', text: `−${STEP}`, disabled: !eff.subId, onclick: () => nudge(-STEP) }),
        el('span', { text: offsetText }),
        el('button', { type: 'button', text: `+${STEP}`, disabled: !eff.subId, onclick: () => nudge(STEP) })),
      el('div', { class: 'row' },
        el('span', { class: 'muted small', text: 'Yazı' }),
        el('button', { type: 'button', text: 'A−', onclick: () => { size = Math.max(0.6, size - 0.1); storage.set('cueSize', size); applyStyle(); } }),
        el('button', { type: 'button', text: 'A+', onclick: () => { size = Math.min(2.5, size + 0.1); storage.set('cueSize', size); applyStyle(); } }),
        el('button', { type: 'button', text: bg === '0' ? 'Arka plan: yok' : 'Arka plan: var', onclick: () => { bg = bg === '0' ? '0.6' : '0'; storage.set('cueBg', bg); applyStyle(); render(); } })),
      el('div', { class: 'row' },
        fileInput,
        el('button', { type: 'button', text: '📄 .srt / .vtt yükle', onclick: () => fileInput.click() }),
        el('span', { class: 'muted small', text: isHost() ? 'herkese eklenir' : 'sadece sende görünür' })),
      el('ul', {}, el('li', {}, el('button', { type: 'button', class: eff.subId ? '' : 'current', onclick: () => choose(null), text: 'Kapalı' }))),
      ...(list.length || localFiles.length ? [] : [el('p', { class: 'muted small', text: 'Altyazılar yükleniyor… Panelde altyazı eklentisi (OpenSubtitles) açık olmalı.' })]),
      ...[...groups].flatMap(([name, subs]) => [el('h3', { text: name }), el('ul', {}, ...subs.map((s) => subButton(s, eff.subId)))]),
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
