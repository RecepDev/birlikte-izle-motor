// Oynat düğmesi simgesi ("İzlemeye devam" afişleri). Stil: ince beyaz halka (css/ana.css .oyna-dugme).
const OYNA = '<path d="M8.6 5.2v13.6L19 12z"/>';

// Üçgenin ağırlık merkezi çemberin merkezindedir (yol optik olarak ortalı), ek kaydırma gerekmez.
export function oynaIkon() {
  const kok = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">${OYNA}</svg>`,
    'image/svg+xml').documentElement;
  return document.importNode(kok, true);
}
