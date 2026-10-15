// Elle "izledim" işaretleri (sunucuda data/izlendi.json). Menüler durumu buradan okur.
import { api } from './api.js';

let tumu = {};

export async function izlendiYukle() {
  try { tumu = await api('/api/izlendi'); } catch { /* eski liste */ }
}
export const izlendiHazir = izlendiYukle();

export const filmIzlendi = (id) => Boolean(tumu[`movie:${id}`]?.hepsi);
export const diziHepsi = (id) => Boolean(tumu[`series:${id}`]?.hepsi);

// bolumler verilmezse bütün film/dizi. deger false = işareti kaldır.
export async function izlendiAyarla(type, id, deger, bolumler = null) {
  await api('/api/izlendi', { method: 'POST', body: { type, id, deger, ...(bolumler ? { bolumler } : {}) } });
  await izlendiYukle();
}
