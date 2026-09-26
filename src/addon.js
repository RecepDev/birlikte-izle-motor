// The Stremio addon itself: manifest + one "open a room" stream per title.

import express from 'express';

export const MANIFEST = {
  id: 'community.birlikteizle',
  version: '0.1.0',
  name: 'Birlikte İzle',
  description: 'Arkadaşlarınla senkron izleme odası aç',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: true },
};

const CONTENT_ID = /^tt\d{1,10}(:\d{1,4}:\d{1,5})?$/;
export const isContentId = (id) => CONTENT_ID.test(id);
export const isContentType = (type) => type === 'movie' || type === 'series';

export function createAddonRouter({ panelBase }) {
  const router = express.Router();

  router.use(['/manifest.json', '/stream'], (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', '*');
    next();
  });

  router.get('/manifest.json', (req, res) => res.json(MANIFEST));

  router.get('/stream/:type/:id.json', (req, res) => {
    const { type, id } = req.params;
    if (!isContentType(type) || !isContentId(id)) return res.json({ streams: [] });
    const query = new URLSearchParams({ type, id }).toString();
    res.json({
      streams: [
        {
          name: '👥 Birlikte İzle',
          title: 'Masaüstü uygulamasında aç · gerçek HDR, tüm ses dilleri',
          // Sıradan http adresi olmak zorunda: Stremio özel şemaları https:// diye
          // yeniden yazıyor. Uygulamayı /ac isteğini alan sunucu başlatıyor.
          externalUrl: `${panelBase}/ac?${query}`,
        },
        {
          name: '👥 Birlikte İzle',
          title: 'Tarayıcıda aç',
          externalUrl: `${panelBase}/new?${query}`,
        },
      ],
    });
  });

  router.get('/configure', (req, res) => res.redirect(302, `${panelBase}/`));

  return router;
}
