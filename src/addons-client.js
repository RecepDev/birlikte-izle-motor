// Talks to other Stremio addons (Torrentio, OpenSubtitles...) and Cinemeta.

const CINEMETA = 'https://v3-cinemeta.strem.io';
const KNOWN_RESOURCES = ['stream', 'subtitles'];

// Cinemeta "runtime": "148 min", "2h 28min", "45 min" -> saniye; anlaşılmazsa null.
export function sureSnCoz(runtime) {
  const m = String(runtime || '').toLowerCase();
  const saat = Number(m.match(/(\d+)\s*h/)?.[1] || 0);
  const dakika = Number(m.match(/(\d+)\s*m/)?.[1] || 0);
  const sn = (saat * 60 + dakika) * 60;
  return sn >= 60 && sn <= 12 * 3600 ? sn : null;
}

export function addonBase(manifestUrl) {
  return manifestUrl.replace(/\/manifest\.json$/, '');
}

function supports(addon, resource) {
  return addon.enabled !== false && (!addon.resources?.length || addon.resources.includes(resource));
}

function errorMessage(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'zaman aşımı';
  // fetch hides the real network reason (ECONNRESET, ETIMEDOUT...) in err.cause.
  const cause = err?.cause?.code || err?.cause?.message;
  return cause ? `${err.message} (${cause})` : err?.message || String(err);
}

export function createAddonsClient({ fetchImpl = fetch, timeoutMs = 10_000, metaTimeoutMs = 5_000, retryDelayMs = 700 } = {}) {
  async function getJson(url, ms = timeoutMs) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // One retry: public addons like Torrentio fail or stall now and then.
  async function getJsonRetry(url) {
    try {
      return await getJson(url);
    } catch (err) {
      if (/^HTTP 4\d\d$/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, retryDelayMs));
      return getJson(url);
    }
  }

  // Calls `path` on every addon that supports `resource`, in parallel. When given,
  // onAddon fires as each individual addon settles (arrival order, for a
  // progressive UI) while the returned { results, errors } stays in addon-list
  // order regardless, same as before onAddon existed.
  async function fanOut(addons, resource, path, pick, onAddon) {
    const targets = addons.filter((a) => supports(a, resource));
    const promises = targets.map((a) => getJsonRetry(`${addonBase(a.url)}${path}`));
    if (onAddon) {
      promises.forEach((p, i) => {
        p.then(
          (body) => onAddon({ addonName: targets[i].name, items: pick(body), error: null }),
          (err) => onAddon({ addonName: targets[i].name, items: null, error: errorMessage(err) }),
        );
      });
    }
    const settled = await Promise.allSettled(promises);
    const results = [];
    const errors = [];
    settled.forEach((r, i) => {
      const addonName = targets[i].name;
      if (r.status === 'fulfilled') results.push({ addonName, items: pick(r.value) });
      else errors.push({ addonName, message: errorMessage(r.reason) });
    });
    return { results, errors };
  }

  return {
    async manifest(url) {
      const m = await getJson(url);
      const names = (m.resources || []).map((r) => (typeof r === 'string' ? r : r?.name));
      return { name: String(m.name || url), resources: KNOWN_RESOURCES.filter((r) => names.includes(r)) };
    },

    // onAddon(name, streams|null, error|null) fires as each addon replies, for a
    // progressive UI; the returned promise still resolves once every addon has.
    async streams(addons, type, id, onAddon) {
      const wrapped = onAddon && ((r) => onAddon(r.addonName, r.items, r.error));
      const { results, errors } = await fanOut(addons, 'stream', `/stream/${type}/${id}.json`, (b) =>
        Array.isArray(b?.streams) ? b.streams : [], wrapped);
      return { results: results.map((r) => ({ addonName: r.addonName, streams: r.items })), errors };
    },

    async subtitles(addons, type, id, video = null) {
      const extra = video?.hash ? `/videoHash=${video.hash}&videoSize=${video.size}` : '';
      const { results, errors } = await fanOut(addons, 'subtitles', `/subtitles/${type}/${id}${extra}.json`, (b) =>
        Array.isArray(b?.subtitles) ? b.subtitles : [],
      );
      const subtitles = results.flatMap((r) =>
        r.items
          .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//.test(s.url))
          .map((s) => ({ id: String(s.id ?? s.url), url: s.url, lang: String(s.lang || 'und'), addonName: r.addonName })),
      );
      return { subtitles, errors };
    },

    // Title search via Cinemeta's own catalog (not the configured stream addons).
    async search(type, query) {
      const q = String(query || '').trim();
      if (!q) return [];
      try {
        const { metas } = await getJson(`${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(q)}.json`, metaTimeoutMs);
        return (Array.isArray(metas) ? metas : []).map((m) => ({
          id: String(m.id), type, name: String(m.name || m.id),
          poster: m.poster || null, year: m.releaseInfo || (m.year ? String(m.year) : null),
        }));
      } catch {
        return [];
      }
    },

    // Season/episode list for a series (Cinemeta's `videos` array), for the episode picker.
    async seriesEpisodes(id) {
      const { meta } = await getJson(`${CINEMETA}/meta/series/${id}.json`, metaTimeoutMs);
      return (meta?.videos || [])
        .filter((v) => Number.isInteger(v.season) && Number.isInteger(v.episode))
        .map((v) => ({
          season: v.season, episode: v.episode, name: v.name || v.title || `Bölüm ${v.episode}`,
          thumbnail: v.thumbnail || null, released: v.released || v.firstAired || null,
        }));
    },

    async meta(type, id) {
      const [imdbId, season, episode] = id.split(':');
      try {
        const { meta } = await getJson(`${CINEMETA}/meta/${type}/${imdbId}.json`, metaTimeoutMs);
        let name = meta?.name || id;
        if (season && episode) {
          const code = `S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`;
          const video = (meta?.videos || []).find((v) => String(v.season) === season && String(v.episode) === episode);
          const title = video?.name || video?.title;
          name = `${name} ${code}${title ? ` · ${title}` : ''}`;
        }
        // Süre (sn): "Oda aç" otomatik seçimi kaynağın ihtiyacını (boyut / süre) bununla hesaplıyor.
        return { name, poster: meta?.poster || null, sureSn: sureSnCoz(meta?.runtime) };
      } catch {
        return { name: id, poster: null, sureSn: null };
      }
    },
  };
}
