// Arka planda otomatik kaynak seçip indirme kuyruğuna ekleme.
// Bölüm/sezon/film yanındaki ⬇️ düğmesi buraya gelir: her içerik için addon'lardan kaynaklar
// toplanır, "otomatik mod"un seçicisiyle (public/js/shared/kaynak-sec.js: tercih edilen kalite,
// seed, kaynak hafızası) en iyisi seçilir ve src/indirme.js kuyruğuna eklenir. Hız ölçümü yok:
// arka plan indirmesinde sorun hız değil, sağlıklı (seed'li) kaynak. Torrent açılmaz, yalnız
// kaynak listesi sorulur; indirmeyi kuyruk başlatır (tek indirme çalışır).
import { indirmeSec } from '../public/js/shared/kaynak-sec.js';
import { normalizeAddonStreams } from './streams.js';

const ES_ZAMANLI = 2; // aynı anda kaç içeriğin kaynakları aranıyor
const DENEME = 2; // hiç kaynak gelmezse / addon hatasında kaç kez
const BEKLEME_MS = 4000;

export function createOtomatikIndirme({ addons, config, tercih, kaynakHafiza = null, secenek = { oku: () => ({}) }, indirme, log = { info() {}, warn() {} }, bekle = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  // anahtar -> { anahtar, type, id, ad, durum: 'sirada'|'araniyor'|'bulunamadi'|'hata', hata }
  // Başarıyla indirme kuyruğuna girenler buradan çıkar (kayıt artık indirme listesinde).
  const bekleyen = new Map();
  let calisan = 0;

  const anahtar = (type, id) => `${type}|${id}`;
  const bolumNo = (id) => { const [imdb, s, e] = String(id).split(':'); return { imdb, s: Number(s), e: Number(e) }; };
  const oncekiMi = (a, b) => a.s < b.s || (a.s === b.s && a.e < b.e);

  // Bölümler her zaman sırayla inmeli: aynı dizinin önceki bölümünün kaynağı hâlâ aranıyorsa (sirada/araniyor)
  // indirme kuyruğu sonraki bölümü başlatmaz; kaynak bulunup kayıt eklenince ya da arama bitince kuyruk yeniden işlenir.
  indirme.engelKoy?.((k) => {
    if (k.type !== 'series' || !k.contentId) return false;
    const bu = bolumNo(k.contentId);
    if (!Number.isFinite(bu.s) || !Number.isFinite(bu.e)) return false;
    for (const is of bekleyen.values()) {
      if (is.type !== 'series' || (is.durum !== 'sirada' && is.durum !== 'araniyor')) continue;
      const o = bolumNo(is.id);
      if (o.imdb === bu.imdb && Number.isFinite(o.s) && oncekiMi(o, bu)) return true;
    }
    return false;
  });

  const liste = () => [...bekleyen.values()].map(({ anahtar: a, type, id, ad, durum, hata }) => ({ anahtar: a, type, id, ad, durum, hata: hata || null }));

  async function kaynaklariTopla(type, id) {
    const toplanan = [];
    const acik = config.get().addons;
    await addons.streams(acik, type, id, (addonName, items, error) => {
      if (error) return;
      toplanan.push(...normalizeAddonStreams(addonName, items, toplanan.length));
    });
    return toplanan;
  }

  async function isle(is) {
    is.durum = 'araniyor';
    let streams = [];
    for (let i = 0; i < DENEME && !streams.some((s) => s.kind === 'torrent'); i++) {
      if (i) await bekle(BEKLEME_MS);
      if (!bekleyen.has(is.anahtar)) return; // iptal edildi
      try { streams = await kaynaklariTopla(is.type, is.id); } catch (err) { is.hata = err.message; }
    }
    if (!bekleyen.has(is.anahtar)) return;
    const hafiza = is.type === 'series' ? kaynakHafiza?.oku?.(is.id) || null : null;
    // Paketten tek bölüm indirilecekse hangi dosya olduğu bilinmeli (sıra numarası ya da ad).
    const uygun = streams.filter((s) => s.kind === 'torrent' && (!s.pack || Number.isInteger(s.fileIdx) || s.filename));
    // Kullanıcının indirme seçenekleri (bu indirme için sorulduysa o, yoksa kayıtlı olanlar).
    const { secilen, gevsetilen } = indirmeSec(uygun, is.secenek || secenek.oku(), { hafiza, kalite: tercih.kalite?.() || null });
    if (!secilen || secilen.kind !== 'torrent') {
      is.durum = 'bulunamadi';
      is.hata = is.hata || 'Kaynak bulunamadı';
      return;
    }
    const r = indirme.ekle({
      infoHash: secilen.infoHash,
      fileIdx: Number.isInteger(secilen.fileIdx) ? secilen.fileIdx : null,
      filename: secilen.filename || null,
      ad: `${is.ad}${secilen.quality ? ` · ${secilen.quality}` : ''}`,
      type: is.type,
      contentId: is.id,
      poster: is.poster || null,
      toplu: is.toplu || null,
      kalite: secilen.quality || null,
      boyut: secilen.sizeBytes || null,
      sources: Array.isArray(secilen.sources) ? secilen.sources.slice(0, 40) : [],
    });
    if (r.error) {
      is.durum = 'hata';
      is.hata = r.error;
      return;
    }
    log.info('Arka plan indirmesi eklendi', { id: is.id, kalite: secilen.quality, seed: secilen.seeders, gevsetilen });
    bekleyen.delete(is.anahtar);
  }

  async function isleyici() {
    if (calisan >= ES_ZAMANLI) return;
    calisan++;
    try {
      for (;;) {
        const is = [...bekleyen.values()].find((x) => x.durum === 'sirada');
        if (!is) break;
        try { await isle(is); } catch (err) {
          log.warn('Otomatik indirme hatası', { id: is.id, error: err.message });
          is.durum = 'hata';
          is.hata = err.message;
        }
        indirme.sirayiIsle?.(); // bu bölümün araması bitti: bekleyen sonraki bölümler başlayabilir
      }
    } finally {
      calisan--;
    }
  }

  return {
    liste,

    // items: [{ type, id }] — zaten indirme listesinde olan ya da aranmakta olanlar atlanır.
    async ekle(items, istenen = null, toplu = null) {
      let eklenen = 0;
      let atlanan = 0;
      const mevcut = new Set(indirme.liste().filter((k) => k.contentId).map((k) => anahtar(k.type, k.contentId)));
      const adlar = await Promise.all(items.map(async ({ type, id }) => {
        const a = anahtar(type, id);
        if (mevcut.has(a) || (bekleyen.has(a) && bekleyen.get(a).durum !== 'bulunamadi' && bekleyen.get(a).durum !== 'hata')) return null;
        try { const m = await addons.meta(type, id); return { ad: m?.name || id, poster: m?.poster || null }; } catch { return { ad: id, poster: null }; }
      }));
      // Bölümler sezon/bölüm sırasıyla işlensin (aramalar sırayla başlar, indirme kuyruğu da bu sırayı korur).
      const sirali = items.map((x, i) => ({ ...x, i })).sort((a, b) => {
        const p = bolumNo(a.id);
        const q = bolumNo(b.id);
        return (p.imdb === q.imdb ? (p.s - q.s) || (p.e - q.e) : 0) || (a.i - b.i);
      });
      sirali.forEach(({ type, id, i }) => {
        if (adlar[i] === null) { atlanan++; return; }
        bekleyen.set(anahtar(type, id), { anahtar: anahtar(type, id), type, id, ad: adlar[i].ad, poster: adlar[i].poster, durum: 'sirada', hata: null, secenek: istenen, toplu });
        eklenen++;
      });
      for (let i = 0; i < ES_ZAMANLI; i++) isleyici();
      return { eklenen, atlanan };
    },

    // Aranmakta/başarısız bir isteği kuyruktan çıkarır (anahtar = "type|id"); 'hepsi' = bitenleri temizle.
    iptal(a) {
      if (a === 'hepsi') {
        for (const [k, v] of bekleyen) if (v.durum === 'bulunamadi' || v.durum === 'hata') bekleyen.delete(k);
        return { ok: true };
      }
      return bekleyen.delete(a) ? { ok: true } : { error: 'yok' };
    },
  };
}
