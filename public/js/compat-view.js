// The device-compatibility screen: what is wrong, what to do about it, what this device can open.

import { $, el, formatSize, storage } from './ui.js';
import { gpuName } from './hwaccel.js';

const ICON = { error: '❌', warn: '⚠️', info: 'ℹ️' };

function chip(label, state, hint = '') {
  const mark = state === 'ok' ? '✅' : state === 'bad' ? '❌' : '❔';
  return el('span', { class: `chip ${state}`, title: hint || null }, `${mark} ${label}`);
}

const flag = (value) => (value === true ? 'ok' : value === false ? 'bad' : 'unknown');

function problemCard(p) {
  return el('div', { class: `compat-problem lv-${p.level}` },
    el('div', { class: 'compat-problem-title' }, `${ICON[p.level]} ${p.title}`),
    el('div', { class: 'muted small' }, p.detail),
    p.advice.length ? el('ul', { class: 'compat-advice' }, ...p.advice.map((a) => el('li', {}, a))) : null);
}

function deviceChips(device) {
  const has = (list, codec) => list.includes(codec);
  const chips = [
    chip('H.264', 'ok'),
    chip('HEVC (x265)', flag(has(device.videoCodecs, 'hevc')), 'Çoğu 4K ve HDR dosya HEVC kullanır'),
    chip('AV1', flag(has(device.videoCodecs, 'av1'))),
    chip('HDR10 çözme', flag(device.hdr10Decode)),
    chip('Ekran HDR', flag(device.screenHdr), 'Ekran ve Windows HDR açıkken "evet" görünür'),
    chip('4K akıcı', flag(device.hevc4kSmooth)),
    chip('AC3 ses', flag(has(device.audioCodecs, 'ac3')), 'Değilse Uyumlu mod sesi dönüştürür'),
    chip('E-AC3 ses', flag(has(device.audioCodecs, 'eac3')), 'Değilse Uyumlu mod sesi dönüştürür'),
    chip(device.gpu && device.gpuRenderer ? `Ekran kartı: ${gpuName(device.gpuRenderer)}` : 'Donanım hızlandırma', flag(device.gpu)),
  ];
  if (device.touch) chips.push(chip('Video motoru yok', 'unknown'));
  else chips.push(chip('Video motoru', flag(device.stremio)));
  return el('div', { class: 'compat-chips' }, ...chips);
}

function bestCard(result, currentStreamId, onPick) {
  const s = result.best;
  if (!s) return null;
  const detail = [s.quality || '?', s.sizeBytes ? formatSize(s.sizeBytes) : null, Number.isFinite(s.seeders) ? `👤 ${s.seeders}` : null, s.addonName]
    .filter(Boolean).join(' · ');
  const isCurrent = s.streamId === currentStreamId;
  return el('div', { class: 'compat-best' },
    el('div', {},
      el('div', { class: 'compat-problem-title' }, '⭐ Bu cihaz için önerilen kaynak'),
      el('div', { class: 'small' }, detail),
      el('div', { class: 'muted small' }, String(s.title || s.name || '').split('\n')[0])),
    isCurrent
      ? el('span', { class: 'badge' }, 'izliyorsun')
      : el('button', { type: 'button', class: 'primary', text: 'Bunu izle', onclick: () => onPick(s.streamId) }));
}

export function createCompatScreen({ onPick, onOpenQuality }) {
  const root = $('#compat-screen');
  let last = null;

  function render() {
    if (!last) return;
    const { result, device, currentStreamId } = last;
    const c = result.counts;
    $('#compat-sub').textContent = result.needsAttention
      ? 'Bu cihazda bazı videolar sorun çıkarabilir. Aşağıda ne yapabileceğin yazıyor.'
      : 'Bu cihaz odadaki tüm videoları açabiliyor.';
    $('#compat-body').replaceChildren(
      ...(result.problems.length ? result.problems.map(problemCard) : [el('div', { class: 'compat-ok' }, '✅ Sorun bulunmadı.')]),
      bestCard(result, currentStreamId, (id) => { onPick(id); hide(); }),
      c.total
        ? el('p', { class: 'small muted' },
          `Odadaki ${c.total} kaynaktan ${c.direct} tanesi doğrudan açılır, ${c.compat} tanesi Uyumlu mod (ses dönüşümü) ister, ${c.reencode} tanesinin görüntüsü açılamaz.`)
        : null,
      el('div', { class: 'compat-section' }, 'Bu cihaz neyi açabiliyor?'),
      deviceChips(device),
    );
  }

  function hide() {
    if (root.hidden) return;
    root.hidden = true;
    if ($('#compat-mute').checked && last) {
      const seen = new Set((storage.get('compatSeen') || '').split(',').filter(Boolean));
      for (const p of last.result.problems) if (p.level !== 'info') seen.add(p.id);
      storage.set('compatSeen', [...seen].join(','));
    }
  }

  $('#compat-close').addEventListener('click', hide);
  $('#compat-quality').addEventListener('click', () => { hide(); onOpenQuality(); });
  root.addEventListener('click', (e) => { if (e.target === root) hide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });

  return {
    isOpen: () => !root.hidden,
    update(data) {
      last = data;
      if (!root.hidden) render();
    },
    show(data) {
      last = data;
      $('#compat-mute').checked = false;
      render();
      root.hidden = false;
    },
  };
}
