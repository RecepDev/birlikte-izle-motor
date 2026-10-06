// Video önbelleği (Stremio'nun disk önbelleğinin karşılığı). TorrServer'ın kendi disk önbelleği yalnız
// süreç açıkken işe yarıyor: açılışta diskteki parçaları okumuyor (kaynak kodunda Init boş başlıyor),
// yeniden başlayınca her şeyi baştan indiriyordu. Burada Stremio taklidinden geçen video sabit
// boyda bloklar halinde diske yazılıyor; aynı yer yeniden istenince internete gitmeden diskten veriliyor
// (daha önce izlenen film, yarım kalan yerden devam, geri sarma).
//
// Düzen: <klasör>/<hash>/<dosya no>/<blok no>.blk ve <hash>/secim.json (sıra/ad -> dosya no, boy, yol).
// Toplam boy sınırlı: aşınca en uzun süredir kullanılmayan bloklar siliniyor.

import fs from 'node:fs';
import path from 'node:path';

export const BLOK = 4 * 1024 * 1024;

// sinirBayt 0: önbellek kapalı (yazılmıyor, okunmuyor; temizlikte hepsi siliniyor).
export function createOnbellek({ klasor, sinirBayt = 10 * 1024 ** 3, blok = BLOK, log }) {
  fs.mkdirSync(klasor, { recursive: true });
  let sinir = sinirBayt;
  const yazilan = new Set(); // şu an yazılmakta olan bloklar (aynı blok iki kez yazılmasın)

  const blokYolu = (ih, id, no) => path.join(klasor, ih, String(id), `${no}.blk`);
  const secimYolu = (ih) => path.join(klasor, ih, 'secim.json');

  function secimler(ih) {
    try {
      return JSON.parse(fs.readFileSync(secimYolu(ih), 'utf8'));
    } catch {
      return {};
    }
  }

  // Dosyanın son blokları ilk açılışta gelmiyor: dosya sonundaki blok tam boy olmayabilir.
  function blokBoyu(boy, no) {
    return Math.min(blok, boy - no * blok);
  }

  // Diskteki bütün bloklar: [{ yol, boy, zaman }]
  async function tara() {
    const dosyalar = [];
    for (const ih of await fs.promises.readdir(klasor).catch(() => [])) {
      const d = path.join(klasor, ih);
      for (const id of await fs.promises.readdir(d).catch(() => [])) {
        const dd = path.join(d, id);
        if (!(await fs.promises.stat(dd).catch(() => null))?.isDirectory()) continue;
        for (const ad of await fs.promises.readdir(dd).catch(() => [])) {
          if (!ad.endsWith('.blk')) continue;
          const yol = path.join(dd, ad);
          const st = await fs.promises.stat(yol).catch(() => null);
          if (st) dosyalar.push({ yol, boy: st.size, zaman: st.mtimeMs });
        }
      }
    }
    return dosyalar;
  }

  async function temizle() {
    try {
      const dosyalar = await tara();
      let toplam = dosyalar.reduce((a, f) => a + f.boy, 0);
      if (toplam <= sinir) return { toplam, silinen: 0 };
      dosyalar.sort((a, b) => a.zaman - b.zaman);
      let silinen = 0;
      for (const f of dosyalar) {
        if (toplam <= sinir * 0.9) break;
        await fs.promises.unlink(f.yol).catch(() => {});
        toplam -= f.boy;
        silinen++;
      }
      log?.info?.('Önbellek temizlendi', { silinen, kalanMB: Math.round(toplam / 1e6) });
      return { toplam, silinen };
    } catch (err) {
      log?.warn?.('Önbellek temizlenemedi', { error: err.message });
      return null;
    }
  }

  return {
    blok,
    blokBoyu,
    temizle,
    acik: () => sinir > 0,
    sinir: () => sinir,
    // Panel için: diskteki toplam bayt ve film (torrent) sayısı.
    async kullanim() {
      const dosyalar = await tara();
      const filmler = new Set(dosyalar.map((f) => path.basename(path.dirname(path.dirname(f.yol)))));
      return { bayt: dosyalar.reduce((a, f) => a + f.boy, 0), film: filmler.size };
    },
    // Hepsini sil (panelden). O an okunan blok yoksa oynatma TorrServer'dan devam eder.
    async bosalt() {
      let silinen = 0;
      for (const ih of await fs.promises.readdir(klasor).catch(() => [])) {
        await fs.promises.rm(path.join(klasor, ih), { recursive: true, force: true }).catch(() => {});
        silinen++;
      }
      log?.info?.('Önbellek boşaltıldı', { film: silinen });
      return { silinen };
    },
    // Elle girilen boyut (bkz. src/onbellek-ayar.js); küçülünce fazlası hemen siliniyor.
    sinirAyarla(bayt) {
      sinir = Math.max(0, bayt);
      return temizle();
    },
    // Daha önce seçilmiş dosya (TorrServer'a sormadan, internet yokken de): { id, length, path } | null
    secim(ih, anahtar) {
      return secimler(ih)[anahtar] || null;
    },
    secimKaydet(ih, anahtar, f) {
      try {
        const s = secimler(ih);
        if (s[anahtar]?.id === f.id) return;
        s[anahtar] = { id: f.id, length: f.length, path: f.path };
        fs.mkdirSync(path.join(klasor, ih), { recursive: true });
        fs.writeFileSync(secimYolu(ih), JSON.stringify(s));
      } catch { /* önbellek yazılamazsa izleme yine sürer */ }
    },
    // Tam blok ya da null. Okunan blok "yeni kullanıldı" sayılır (temizlikte en son silinir).
    async oku(ih, id, no, boy) {
      const yol = blokYolu(ih, id, no);
      try {
        const veri = await fs.promises.readFile(yol);
        if (veri.length !== blokBoyu(boy, no)) return null;
        const simdi = new Date();
        fs.promises.utimes(yol, simdi, simdi).catch(() => {});
        return veri;
      } catch {
        return null;
      }
    },
    // Geçici dosyaya yazıp yeniden adlandırarak: yarım blok hiçbir zaman "var" görünmesin.
    yaz(ih, id, no, veri) {
      const yol = blokYolu(ih, id, no);
      if (yazilan.has(yol)) return;
      yazilan.add(yol);
      const gecici = `${yol}.${process.pid}.yaziliyor`;
      fs.promises.mkdir(path.dirname(yol), { recursive: true })
        .then(() => fs.promises.writeFile(gecici, veri))
        .then(() => fs.promises.rename(gecici, yol))
        .catch(() => fs.promises.unlink(gecici).catch(() => {}))
        .finally(() => yazilan.delete(yol));
    },
  };
}
