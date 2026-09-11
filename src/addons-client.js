// Talks to other Stremio addons (Torrentio, OpenSubtitles...) and Cinemeta.

const CINEMETA = 'https://v3-cinemeta.strem.io';
const KNOWN_RESOURCES = ['stream', 'subtitles'];

export function addonBase(manifestUrl) {
  return manifestUrl.replace(/\/manifest\.json$/, '');
}

function supports(addon, resource) {
  return addon.enabled !== false && (!addon.resources?.length || addon.resources.includes(resource));
}

function errorMessage(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'zaman aşımı';
  return err?.message || String(err);
}

export function createAddonsClient({ fetchImpl = fetch, timeoutMs = 10_000, metaTimeoutMs = 5_000 } = {}) {
  async function getJson(url, ms = timeoutMs) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Calls `path` on every addon that supports `resource`, in parallel.
  async function fanOut(addons, resource, path, pick) {
    const targets = addons.filter((a) => supports(a, resource));
    const settled = await Promise.allSettled(targets.map((a) => getJson(`${addonBase(a.url)}${path}`)));
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

    async streams(addons, type, id) {
      const { results, errors } = await fanOut(addons, 'stream', `/stream/${type}/${id}.json`, (b) =>
        Array.isArray(b?.streams) ? b.streams : [],
      );
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
        return { name, poster: meta?.poster || null };
      } catch {
        return { name: id, poster: null };
      }
    },
  };
}
