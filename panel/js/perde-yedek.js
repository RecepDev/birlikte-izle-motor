// Açılış perdesi (logo) için yedek: uygulama.js bir sebeple yüklenemez ya da başlarken hata verirse
// (modül eksik/bozuk, ağ kopması, sunucu eski sürüm) perde sonsuza dek donup kalıyordu.
// Klasik betik: modül yüklenemese de çalışır. 12 sn içinde uygulama başladığını bildirmezse
// bir kez kendiliğinden yeniden yüklenir; yine olmazsa perdede hata ve "Yeniden yükle" düğmesi görünür.
(function () {
  var hatalar = [];
  window.addEventListener('error', function (e) { hatalar.push(e.message || 'betik hatası'); });
  window.addEventListener('unhandledrejection', function (e) { hatalar.push(String((e.reason && e.reason.message) || e.reason || 'söz reddedildi')); });
  setTimeout(function () {
    var perde = document.getElementById('acilis-perde');
    if (!perde) return;
    if (window.__uygulamaBasladi) { perde.remove(); return; } // uygulama çalışıyor ama perde kalkmadı
    var denendi = false;
    try { denendi = sessionStorage.getItem('perdeYenilendi') === '1'; sessionStorage.setItem('perdeYenilendi', '1'); } catch (e) { denendi = true; }
    if (!denendi) { location.reload(); return; }
    var kutu = document.createElement('div');
    kutu.className = 'perde-hata';
    var yazi = document.createElement('p');
    yazi.textContent = 'Uygulama yüklenemedi.' + (hatalar.length ? ' (' + hatalar[0] + ')' : ' Sunucu eski sürümde ya da kapalı olabilir.');
    var dugme = document.createElement('button');
    dugme.type = 'button';
    dugme.textContent = 'Yeniden yükle';
    dugme.onclick = function () { try { sessionStorage.removeItem('perdeYenilendi'); } catch (e) { /* yok */ } location.reload(); };
    kutu.appendChild(yazi);
    kutu.appendChild(dugme);
    perde.appendChild(kutu);
  }, 12000);
  // Başarılı açılışta bayrak sıfırlansın (bir sonraki açılış yine bir kez otomatik yeniden denesin).
  window.addEventListener('load', function () {
    setTimeout(function () { if (window.__uygulamaBasladi) { try { sessionStorage.removeItem('perdeYenilendi'); } catch (e) { /* yok */ } } }, 3000);
  });
})();
