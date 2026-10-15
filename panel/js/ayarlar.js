// Uygulama ayarları: eskiden açılış ekranındaydı (masaustu/electron/baslangic.html), artık burada.
// Değerler masaüstü uygulamasının köprüsünden (window.kabuk) okunup yazılıyor; tarayıcıda köprü yok.
import { api, $ } from './api.js';
import { onayla, sor } from '/js/diyalog.js';
import { kisayolListesiCiz } from '/js/kisayollar.js';
import { ayarlarCiz as indirmeSecenekCiz } from './indirme-secenek.js';

const kabuk = window.kabuk;
kisayolListesiCiz($('#kisayol-icerik'));

// Sol menü: gizli bölümün (ör. tarayıcıda masaüstü ayarları) bağlantısı da gizlenir; görünür bölüm menüde vurgulanır.
function ayarMenusuKur() {
  const linkler = [...document.querySelectorAll('.ayar-nav a')];
  const bolumler = linkler.map((a) => document.getElementById(a.dataset.hedef));
  const vurgula = () => {
    if ($('#gorunum-ayarlar').hidden) return;
    let secili = null;
    bolumler.forEach((b, i) => { if (b && !b.hidden && b.getBoundingClientRect().top <= 140) secili = linkler[i]; });
    // Sayfanın sonuna gelince son bölüm, başında ilk bölüm vurgulu kalsın.
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) secili = [...linkler].reverse().find((a) => !a.hidden) || secili;
    for (const a of linkler) a.classList.toggle('aktif', a === (secili || linkler.find((x) => !x.hidden)));
  };
  linkler.forEach((a, i) => { if (bolumler[i]?.hidden) a.hidden = true; });
  window.addEventListener('scroll', vurgula, { passive: true });
  window.addEventListener('resize', vurgula);
  new MutationObserver(vurgula).observe($('#gorunum-ayarlar'), { attributes: true, attributeFilter: ['hidden'] });
  vurgula();
}
$('#afis-sifirla').addEventListener('click', () => {
  try { localStorage.removeItem('afisOlcek'); } catch { /* yok */ }
  document.documentElement.style.setProperty('--afis-olcek', '1');
});
if (!kabuk?.surum) {
  $('#uygulama-yok').hidden = false;
  for (const id of ['#bolum-genel', '#bolum-oynatma', '#bolum-motor', '#bolum-bildirim', '#satir-guncelle']) $(id).hidden = true;
}

// Bildirim ayarları (masaüstü): her anahtar değişince hemen kaydolur (ana süreç ayar.json'a yazar).
if (kabuk?.bildirimAyar) {
  const mevcut = kabuk.bildirimAyar();
  for (const [id, anahtar] of [['#bil-disk-bildirim', 'diskBildirim'], ['#bil-disk-ses', 'diskSes'], ['#bil-disk-pencere', 'diskPencere'],
    ['#bil-disk-serit', 'diskSerit'], ['#bil-bitti', 'indirmeBitti'], ['#bil-bitti-ses', 'indirmeBittiSes']]) {
    const kutu = $(id);
    if (!kutu) continue;
    kutu.checked = Boolean(mevcut[anahtar]);
    kutu.addEventListener('change', () => kabuk.bildirimAyarYaz({ [anahtar]: kutu.checked }));
  }
}

if (kabuk?.surum) {
  $('#surum').textContent = `Sürüm ${kabuk.surum() || '?'}`;

  // Ad
  const isimGoster = () => { $('#isim-degis').textContent = `${kabuk.isim?.() || '—'} ✎`; };
  isimGoster();
  $('#isim-degis').addEventListener('click', async () => {
    const ad = await sor('Adın (odada görünür):', kabuk.isim?.() || '');
    if (!ad?.trim()) return;
    kabuk.isimYaz?.(ad.trim().slice(0, 30));
    setTimeout(isimGoster, 50);
  });

  // Sunucu otomatik aç (varsayılan açık)
  const sunucuOto = $('#sunucu-oto');
  sunucuOto.checked = kabuk.sunucuOto ? kabuk.sunucuOto() : true;
  sunucuOto.addEventListener('change', () => kabuk.sunucuOtoYaz?.(sunucuOto.checked));

  // Oynatma
  const kalite = $('#kalite');
  const kayitliKalite = kabuk.kalite?.();
  if (kayitliKalite) kalite.value = kayitliKalite;
  else api('/api/tercih').then((t) => { if (t?.kalite) kalite.value = t.kalite; }).catch(() => {});
  kalite.addEventListener('change', () => {
    kabuk.kaliteYaz?.(kalite.value);
    api('/api/tercih', { method: 'POST', body: { kalite: kalite.value } }).catch(() => {});
  });
  const oto = $('#oto');
  oto.checked = kabuk.otoKaynak ? kabuk.otoKaynak() : true;
  oto.addEventListener('change', () => kabuk.otoKaynakYaz?.(oto.checked));
  const internet = $('#internet-hiz');
  internet.value = kabuk.internetMbps?.() ?? '';
  internet.addEventListener('change', () => {
    const mbps = internet.value ? Number(internet.value) : null;
    kabuk.internetMbpsYaz?.(mbps);
    api('/api/tercih', { method: 'POST', body: { internetMbps: mbps } }).catch(() => {});
  });
  const tamEkran = $('#oto-tam-ekran');
  tamEkran.checked = kabuk.otoTamEkran ? kabuk.otoTamEkran() : true;
  tamEkran.addEventListener('change', () => kabuk.otoTamEkranYaz?.(tamEkran.checked));
  const hizli = $('#hizli-baslat');
  hizli.checked = kabuk.hizliBaslat ? kabuk.hizliBaslat() : true;
  hizli.addEventListener('change', () => kabuk.hizliBaslatYaz?.(hizli.checked));

  // Motor ve önbellek
  const MOTOR_ROZET = {
    kendi: ['iyi', 'Video motoru açık'],
    sunucu: ['iyi', 'Bu bilgisayardaki sunucunun motoru'],
    stremio: ['', 'Stremio'],
    aciliyor: ['uyari', 'Açılıyor…'],
    yok: ['kotu', 'Yok'],
  };
  const motorRozet = $('#motor-rozet');
  const motorIpucu = $('#motor-ipucu');
  const motorBekci = $('#motor-bekci');
  const vo = $('#video-onbellek');
  const voIpucu = $('#video-onbellek-ipucu');
  const voVarsayilan = voIpucu.textContent;
  const obYerSatir = $('#ob-yer-satir');
  const obYer = $('#ob-yer');
  const obYerVarsayilan = $('#ob-yer-varsayilan');

  // Uygulama sunucunun motorunu kullanıyorsa (normal durum) önbellek sunucudadır: aynı ayar sunucu API'siyle yapılır.
  let sunucuMotoru = false;
  const sunucuOnbellekGoster = async () => {
    const m = await api('/api/motor').catch(() => null);
    const ob = m?.onbellek;
    if (!ob) { vo.disabled = true; voIpucu.textContent = 'Sunucunun motoru önbellek bilgisi vermiyor'; obYerSatir.hidden = true; return; }
    vo.disabled = false;
    if (document.activeElement !== vo) vo.value = ob.gb === null || ob.gb === undefined ? '' : String(ob.gb);
    voIpucu.textContent = `${voVarsayilan}${ob.sinir > 0 ? '' : ' (şu an sınırsız)'}`;
    obYerSatir.hidden = !ob.klasor;
    const bayt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round((n || 0) / 1e6)} MB`);
    $('#ob-temizle-satir').hidden = false;
    $('#ob-doluluk').textContent = `${bayt(ob.bayt)}${ob.sinir > 0 ? ` / ${bayt(ob.sinir)}` : ''} · ${ob.film} film`;
    $('#ob-temizle').disabled = !ob.bayt;
    obYer.textContent = ob.klasor || '';
    obYerVarsayilan.hidden = !ob.secilen;
  };
  $('#ob-temizle').addEventListener('click', async () => {
    if (!await onayla('Önbellekteki bütün filmler silinsin mi? Sonraki açılışlar yeniden internetten gelir.')) return;
    await api('/api/motor/onbellek-bosalt', { method: 'POST' }).catch((err) => alert(err.message));
    sunucuOnbellekGoster();
  });
  const videoOnbellekGoster = () => kabuk.videoOnbellek?.().then((d) => {
    sunucuMotoru = d?.motor === 'sunucu';
    if (sunucuMotoru) return sunucuOnbellekGoster();
    if (d?.motor === 'aciliyor') {
      vo.disabled = true;
      voIpucu.textContent = 'Motor açılıyor…';
    } else if (!d || d.motor === null) {
      vo.disabled = true;
      voIpucu.textContent = 'Video motoru açık değil: açılınca buradan ayarlanır';
    } else {
      vo.disabled = false;
      voIpucu.textContent = voVarsayilan;
      vo.value = d.gb === null ? '' : String(d.gb);
      if (d.motor === 'stremio') voIpucu.textContent = `${voVarsayilan} (Stremio'nun ayarı)`;
    }
    // Yer yalnız kendi motorunda seçilebiliyor (Stremio'nun yeri Stremio'nun ayarı).
    obYerSatir.hidden = !(d?.motor === 'torrserver' && d.klasor && kabuk.videoOnbellekYer);
    if (!obYerSatir.hidden) {
      obYer.textContent = d.klasor;
      obYerVarsayilan.hidden = !d.secilen;
    }
  });
  async function obYerTasi(secilen) {
    obYer.textContent = 'Taşınıyor…';
    const r = sunucuMotoru
      ? await api('/api/motor/onbellek', { method: 'POST', body: { klasor: secilen } }).catch((err) => ({ error: err.message }))
      : await kabuk.videoOnbellekYer(secilen);
    await videoOnbellekGoster();
    if (r?.error) obYer.textContent = `${obYer.textContent} · bu klasöre yazılamıyor, başka yer seç`;
    else if (r?.silinen) obYer.textContent = `${obYer.textContent} · ${r.silinen} film başka diske taşınamadığı için silindi`;
  }
  $('#ob-yer-degistir').addEventListener('click', async () => {
    const secilen = await kabuk.klasorSec?.('Önbellek için klasör seç');
    if (!secilen) return;
    if (!await onayla(`Önbellek "${secilen}" içine alınsın mı? Aynı diskteyse filmler taşınır, başka diskteyse eski önbellek silinir.`)) return;
    obYerTasi(secilen);
  });
  obYerVarsayilan.addEventListener('click', async () => {
    if (await onayla('Önbellek varsayılan yerine alınsın mı?')) obYerTasi(null);
  });
  async function motorGoster() {
    const m = await kabuk.motor?.().catch(() => null);
    if (!m) return;
    const [sinif, yazi] = MOTOR_ROZET[m.tur] || ['', m.tur];
    motorRozet.className = `ayar-rozet ${sinif}`;
    motorRozet.textContent = yazi;
    if (m.tur === 'kendi') motorIpucu.textContent = `Kendi TorrServer'ı${m.surum ? ` ${m.surum}` : ''}${m.peerPort ? ` · peer portu ${m.peerPort}` : ''}`;
    else if (m.tur === 'yok') motorIpucu.textContent = m.hata ? `Açılamadı: ${m.hata}` : 'Uygulamayı yeniden aç';
    else if (m.tur === 'aciliyor') motorIpucu.textContent = 'İlk açılışta TorrServer indiriliyor (yaklaşık 64 MB)';
    $('#motor-bekci-satir').hidden = m.tur !== 'kendi';
    motorBekci.checked = m.bekci === true;
    if (m.tur === 'aciliyor') setTimeout(motorGoster, 1500);
    else videoOnbellekGoster();
  }
  motorGoster();
  videoOnbellekGoster();
  motorBekci.addEventListener('change', () => kabuk.motorBekciYaz?.(motorBekci.checked));
  vo.addEventListener('change', async () => {
    const r = sunucuMotoru
      ? await api('/api/motor/onbellek', { method: 'POST', body: { gb: Number(vo.value) } }).then((x) => ({ ok: !x.error, gb: x.gb })).catch(() => null)
      : await kabuk.videoOnbellekYaz?.(Number(vo.value));
    voIpucu.textContent = r?.ok ? (r.gb ? `Önbellek: ${r.gb} GB` : 'Önbellek kapalı') : 'Ayarlanamadı (0-1000 GB)';
  });

  // Güncelleme
  $('#guncelle').addEventListener('click', async (e) => {
    const b = e.target;
    b.disabled = true;
    b.textContent = 'Denetleniyor…';
    await kabuk.guncelle();
    b.disabled = false;
    b.textContent = 'Güncellemeleri denetle';
  });
}

ayarMenusuKur();

if (document.getElementById('dl-secenek-kap')) indirmeSecenekCiz(document.getElementById('dl-secenek-kap'));
