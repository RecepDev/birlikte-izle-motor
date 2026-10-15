// Kaynaktan çalışan (Kurulumsuz) Electron'un Görev Yöneticisi'nde "Electron" yerine uygulama adıyla görünmesi için
// electron.exe'nin sürüm bilgisini (FileDescription, ProductName...) değiştirir. Windows adı bu kaynaktan okuyor.
// Kullanım: node exe-adini-ayarla.cjs [electron.exe yolu]   (uygulama açıkken exe kilitli, önce kapat)
// npm install electron'u yeniden indirirse bu betiği bir kez daha çalıştır.
const fs = require('node:fs');
const path = require('node:path');
const { NtExecutable, NtExecutableResource } = require('pe-library');
const ResEdit = require('resedit');

const AD = 'Birlikte Izle Motor';
const hedef = process.argv[2] || path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
const exe = NtExecutable.from(fs.readFileSync(hedef));
const res = NtExecutableResource.from(exe);
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: AD, ProductName: AD, InternalName: AD, OriginalFilename: `${AD}.exe`,
});
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
fs.writeFileSync(hedef, Buffer.from(exe.generate()));
console.log('Güncellendi:', hedef);
