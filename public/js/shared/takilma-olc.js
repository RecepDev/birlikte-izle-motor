// Kısa takılma ölçeri (DOM'suz, saf): oynatma konumu ilerlemeyi bıraktı mı?
//
// Niye ayrı: 1-2 saniyelik donmalar 5 saniyede bir yazılan tanı örneklerinin arasına
// sığıyor, sonra senkron ileri sararak izi kayboluyordu. Kullanıcı "takılıyor" diyor,
// kayıtta görünmüyor. Burada donmanın kendisi yakalanıyor; sebebi gösteren sayıları
// (önündeki önbellek, veri bekleniyor muydu, düşen kare) çağıran yer ekliyor.
//
// Konum örnekleri ölçüme olduğu gibi girmeli. Masaüstü kabuğunda sayfanın gördüğü
// currentTime iki mpv güncellemesi arasında saat farkıyla tahmin ediliyor (bkz.
// video-koprusu.cjs); o tahmin donmayı gizler. O yüzden masaüstünde mpv'nin ham
// konumu ve o okumanın zamanı veriliyor.

const VARSAYILAN = {
  esik: 0.3, // bu kadar saniye kaybedilmişse kayda değer
  oranEsigi: 0.5, // beklenenin bu kesrinden az ilerlediyse "donuk"
  enBuyukAra: 2, // iki örnek arası bundan uzunsa ölçüm sıfırlanır (sekme arkaya düştü)
};

export function createTakilmaOlcer(secenek = {}) {
  const ayar = { ...VARSAYILAN, ...secenek };
  let son = null; // { t, konum }
  let kayip = 0;

  return {
    sifirla() {
      son = null;
      kayip = 0;
    },
    // konum: saniye · beklemede: duraklatıldı/sarıyor/boşta · hiz: oynatma hızı
    // t: bu konumun okunduğu an (ms). Donma bittiğinde { sure, konum } döner, yoksa null.
    ol(konum, beklemede, hiz, t) {
      if (!Number.isFinite(konum) || beklemede) {
        son = null;
        kayip = 0;
        return null;
      }
      if (!son) {
        son = { t, konum };
        return null;
      }
      if (t === son.t) return null; // yeni okuma gelmemiş
      const gecen = (t - son.t) / 1000;
      const ilerleme = konum - son.konum;
      son = { t, konum };
      if (gecen <= 0 || gecen > ayar.enBuyukAra) {
        kayip = 0;
        return null;
      }
      const beklenen = gecen * (hiz || 1);
      if (ilerleme < beklenen * ayar.oranEsigi) {
        kayip += Math.max(0, beklenen - ilerleme);
        return null;
      }
      // Akış normale döndü: biriken kayıp eşiği geçtiyse bildir.
      const toplam = kayip;
      kayip = 0;
      return toplam >= ayar.esik
        ? { sure: Math.round(toplam * 100) / 100, konum: Math.round(konum * 10) / 10 }
        : null;
    },
  };
}
