// Sunucu panelini Edge yerine masaüstü uygulamasının "Panel" penceresinde açar (baslat.vbs çağırıyor).
// Uygulama bulunamazsa çıkış kodu 1: baslat.vbs eskisi gibi Edge'i açar.
import { masaustuAc } from '../src/masaustu-baslat.js';

process.exit(masaustuAc('--panel').ok ? 0 : 1);
