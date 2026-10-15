// İndirilmiş dosyadan doğrudan oda açar ("Oda aç" ekranı olmadan): dosya kaynağı olarak eklenir, oda açılır, uygulamada oynatıcıya geçilir.
import { api } from './api.js';
import { bildir } from '/js/diyalog.js';

export async function indirilenAc(kayit, baslik, dugme = null, etiket = '▶ İzle') {
  if (dugme) { dugme.disabled = true; dugme.textContent = 'Açılıyor…'; }
  try {
    const trackerlar = (kayit.sources || []).filter((x) => x.startsWith('tracker:')).map((x) => x.slice('tracker:'.length));
    const k = await api('/api/magnet/kaynak', { method: 'POST', body: {
      infoHash: kayit.infoHash, trackerlar, filename: kayit.filename, boyut: kayit.boyut, type: kayit.type, id: kayit.contentId, ad: baslik || kayit.ad,
    } });
    const res = await api('/api/rooms', { method: 'POST', body: { type: kayit.type, id: kayit.contentId, streamId: k.streamId, olcumler: [] } });
    if (window.kabuk?.odayaGit) window.kabuk.odayaGit(res.roomUrl);
    else location.href = res.roomUrl;
  } catch (err) {
    bildir(`Oda açılamadı: ${err.message}`);
    if (dugme) { dugme.disabled = false; dugme.textContent = etiket; }
  }
}
