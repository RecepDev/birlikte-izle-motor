// Afişe sağ tık menüsü: Kütüphane, izledim işareti, film indir, sezon indir, tüm sezonları indir.
import { api } from './api.js';
import { bildir } from '/js/diyalog.js';
import { indirmeIstegi } from './indirme-secenek.js';
import { kutuphanedeMi, ekle, cikar, yenile as kutuphaneYenile } from './kutuphane.js';
import { filmIzlendi, izlendiAyarla, izlendiYukle } from './izlendi.js';
import { menuAc, menuKapat, menuAcik, menuBaslik, menuAyrac, menuOge } from './menu.js';

// Bölümleri 80'erli gruplar hâlinde sıraya ekler (sunucu tek istekte en çok 80 kabul ediyor).
async function indir(items, aciklama, toplu = null) {
  if (!items.length) return bildir('İndirilecek bölüm bulunamadı.');
  if (await indirmeIstegi(items, aciklama, toplu)) bildir('İndirme sıraya eklendi. İlerlemeyi İndirilenler sayfasında görürsün.');
}

async function sezonlar(id) {
  const bolumler = await api(`/api/series/${encodeURIComponent(id)}/episodes`).catch(() => []);
  const harita = new Map();
  for (const b of bolumler) {
    if (!(b.season > 0)) continue; // 0. sezon (özel bölümler) toplu indirmeye girmez
    if (!harita.has(b.season)) harita.set(b.season, []);
    harita.get(b.season).push({ type: 'series', id: `${id}:${b.season}:${b.episode}` });
  }
  return [...harita.entries()].sort((a, b) => a[0] - b[0]);
}

async function dizi(m, x, y) {
  menuAc(x, y, [menuBaslik('Sezonlar alınıyor…')]);
  const liste = await sezonlar(m.id);
  if (!menuAcik()) return; // kullanıcı bu arada menüyü kapattı
  if (!liste.length) return menuAc(x, y, [menuBaslik('Bölüm listesi alınamadı.')]);
  const toplam = liste.reduce((t, [, b]) => t + b.length, 0);
  menuAc(x, y, [
    menuBaslik(m.name),
    menuOge(`↓ Tüm sezonları indir (${liste.length} sezon, ${toplam} bölüm)`, () => indir(liste.flatMap(([, b]) => b), `${m.name}: tüm sezonlar (${toplam} bölüm)`, 'dizi')),
    menuAyrac(),
    ...liste.map(([s, b]) => menuOge(`↓ Sezon ${s} (${b.length} bölüm)`, () => indir(b, `${m.name} Sezon ${s}: ${b.length} bölüm`, 'sezon'))),
  ]);
}

async function isaretle(m, deger) {
  await izlendiAyarla(m.type, m.id, deger);
  // İzledim işaretlenen kütüphaneye de girer (kütüphanede "İzlendi" görünür).
  if (deger && !kutuphanedeMi(m.type, m.id)) await ekle(m);
  else await kutuphaneYenile();
}

document.addEventListener('contextmenu', async (e) => {
  const a = e.target.closest?.('a.afis[data-id]');
  if (!a) return;
  e.preventDefault();
  const m = { type: a.dataset.type, id: a.dataset.id, name: a.dataset.ad, poster: a.dataset.poster || null, year: a.dataset.yil || null };
  const kutuphanede = kutuphanedeMi(m.type, m.id);
  const ogeler = [
    menuBaslik(m.name),
    menuOge(kutuphanede ? '✖ Kütüphaneden çıkar' : '＋ Kütüphaneye ekle', () => (kutuphanede ? cikar(m.type, m.id) : ekle(m))),
    menuAyrac(),
  ];
  if (m.type === 'movie') {
    ogeler.push(filmIzlendi(m.id)
      ? menuOge('✖ İzlendi işaretini kaldır', () => isaretle(m, false))
      : menuOge('✓ İzledim olarak işaretle', () => isaretle(m, true)));
    ogeler.push(menuOge('↓ Filmi indir', () => indir([{ type: 'movie', id: m.id }], m.name)));
  } else {
    ogeler.push(menuOge('✓ Bütün bölümleri izledim işaretle', () => isaretle(m, true)));
    ogeler.push(menuOge('✖ Bütün izlendi işaretlerini kaldır', () => isaretle(m, false)));
    ogeler.push(menuOge('↓ İndirme seçenekleri…', () => dizi(m, e.clientX, e.clientY)));
  }
  menuAc(e.clientX, e.clientY, ogeler);
});

export { menuKapat, izlendiYukle };
