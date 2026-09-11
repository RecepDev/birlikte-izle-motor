import fs from 'node:fs';
import path from 'node:path';

export const WAIT_MODES = ['wait', 'continue'];
export const ADDON_RESOURCES = ['stream', 'subtitles'];
export const MAX_RELAY_LIMIT = 10;

export const DEFAULT_CONFIG = {
  nickname: 'Host',
  addons: [
    {
      url: 'https://opensubtitles-v3.strem.io/manifest.json',
      name: 'OpenSubtitles v3',
      enabled: true,
      resources: ['subtitles'],
    },
  ],
  defaults: { locked: true, waitMode: 'wait', relayEnabled: true, relayLimit: 2, relay4k: false },
};

export class ConfigError extends Error {}

export function validateSettings(input, errors = [], prefix = 'defaults') {
  const s = input || {};
  const out = {
    locked: s.locked,
    waitMode: s.waitMode,
    relayEnabled: s.relayEnabled,
    relayLimit: s.relayLimit,
    // Optional (added later): older config files simply get false.
    relay4k: s.relay4k === true,
  };
  if (typeof out.locked !== 'boolean') errors.push(`${prefix}.locked true/false olmalı`);
  if (!WAIT_MODES.includes(out.waitMode)) errors.push(`${prefix}.waitMode "wait" veya "continue" olmalı`);
  if (typeof out.relayEnabled !== 'boolean') errors.push(`${prefix}.relayEnabled true/false olmalı`);
  if (!Number.isInteger(out.relayLimit) || out.relayLimit < 0 || out.relayLimit > MAX_RELAY_LIMIT) {
    errors.push(`${prefix}.relayLimit 0-${MAX_RELAY_LIMIT} arası tam sayı olmalı`);
  }
  return out;
}

function validateAddon(a, i, errors) {
  const addon = a || {};
  const p = `addons[${i}]`;
  let url = typeof addon.url === 'string' ? addon.url.trim() : '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.push(`${p}.url http veya https olmalı`);
    else if (!u.pathname.endsWith('/manifest.json')) errors.push(`${p}.url /manifest.json ile bitmeli`);
  } catch {
    errors.push(`${p}.url geçerli bir adres değil`);
  }
  const name = typeof addon.name === 'string' && addon.name.trim() ? addon.name.trim().slice(0, 60) : url;
  const resources = Array.isArray(addon.resources)
    ? ADDON_RESOURCES.filter((r) => addon.resources.includes(r))
    : [];
  return { url, name, enabled: addon.enabled !== false, resources };
}

export function validateConfig(input) {
  const errors = [];
  const cfg = input || {};
  const nickname = typeof cfg.nickname === 'string' ? cfg.nickname.trim() : '';
  if (!nickname || nickname.length > 30) errors.push('nickname 1-30 karakter olmalı');
  if (!Array.isArray(cfg.addons) || cfg.addons.length > 20) errors.push('addons en fazla 20 elemanlı liste olmalı');
  const addons = Array.isArray(cfg.addons) ? cfg.addons.map((a, i) => validateAddon(a, i, errors)) : [];
  const defaults = validateSettings(cfg.defaults, errors);
  if (errors.length) throw new ConfigError(errors.join('; '));
  return { nickname, addons, defaults };
}

const clone = (v) => JSON.parse(JSON.stringify(v));

export function createConfigStore(file, log) {
  let current = clone(DEFAULT_CONFIG);
  if (fs.existsSync(file)) {
    try {
      current = validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      const backup = `${file}.bozuk-${Date.now()}`;
      fs.renameSync(file, backup);
      log?.warn('Ayar dosyası okunamadı, varsayılanlar kullanılıyor', { backup, error: err.message });
    }
  }

  return {
    get: () => clone(current),
    save(next) {
      const valid = validateConfig(next);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(valid, null, 2));
      fs.renameSync(tmp, file);
      current = valid;
      return clone(valid);
    },
  };
}
