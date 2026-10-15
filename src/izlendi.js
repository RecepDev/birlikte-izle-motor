// Elle "izledim" işaretleri (host'un): film/dizi ya da tek tek bölüm. data/izlendi.json.
// Otomatik izleme geçmişi (gecmis.js) ayrı; burada işaretlenen ya da kaldırılan şeyler onun üstüne biniyor:
// bir bölüm izlenmiş sayılır = (geçmişte VAR ya da elle işaretli ya da dizi "hepsi" işaretli) ve "hariç"te DEĞİL.
import fs from 'node:fs';
import path from 'node:path';

export function createIzlendi({ file, log }) {
  let veri = {}; // "series:tt1" -> { hepsi, eps:[], haric:[] } | "movie:tt2" -> { hepsi:true }
  try {
    veri = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch { /* ilk çalıştırma */ }

  function yaz() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(veri, null, 1));
    } catch (err) {
      log?.warn('İzlendi işaretleri yazılamadı', { error: err.message });
    }
  }
  const anahtar = (type, id) => `${type}:${id}`;
  const kayit = (type, id) => (veri[anahtar(type, id)] ||= { hepsi: false, eps: [], haric: [] });
  const temizle = (type, id) => {
    const k = veri[anahtar(type, id)];
    if (k && !k.hepsi && !k.eps?.length && !k.haric?.length) delete veri[anahtar(type, id)];
  };

  return {
    tumu: () => veri,
    filmIzlendiMi: (id) => Boolean(veri[anahtar('movie', id)]?.hepsi),
    // Dizi: bölümler "s:e" listesi. gecmisBolumleri: otomatik geçmişten gelenler.
    bolumIzlendiMi(id, sb, gecmisBolumleri = []) {
      const k = veri[anahtar('series', id)];
      if (k?.haric?.includes(sb)) return false;
      return Boolean(k?.hepsi || k?.eps?.includes(sb) || gecmisBolumleri.includes(sb));
    },
    // Filmi ya da diziyi bütünüyle işaretle / kaldır.
    // Kaldırırken geçmişten gelen otomatik izlenmişler de "hariç"e alınıyor ki işaret gerçekten kalksın.
    butunAyarla(type, id, deger, gecmisBolumleri = []) {
      if (type === 'movie') {
        if (deger) kayit('movie', id).hepsi = true; else delete veri[anahtar('movie', id)];
      } else if (deger) {
        const k = kayit('series', id);
        k.hepsi = true;
        k.haric = [];
      } else {
        const k = kayit('series', id);
        k.hepsi = false;
        k.eps = [];
        k.haric = [...gecmisBolumleri];
        temizle('series', id);
      }
      yaz();
    },
    // Dizide seçili bölümleri işaretle / kaldır.
    bolumlerAyarla(id, bolumler, deger) {
      const k = kayit('series', id);
      for (const sb of bolumler) {
        k.eps = k.eps.filter((x) => x !== sb);
        k.haric = k.haric.filter((x) => x !== sb);
        if (deger) k.eps.push(sb); else k.haric.push(sb);
      }
      temizle('series', id);
      yaz();
    },
  };
}
