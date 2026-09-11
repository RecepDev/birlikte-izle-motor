// Best-effort check whether the browser uses the GPU (hardware acceleration).
// Pages cannot read the setting itself; two signals tell it reliably enough:
// the WebGL renderer (software rasterisers have telltale names) and whether the
// browser reports power-efficient (hardware) decoding for 4K HEVC.

const SOFTWARE_RENDERER = /swiftshader|basic render|llvmpipe|software|softpipe/i;

export async function checkHardware() {
  let renderer = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    renderer = gl ? String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : null;
  } catch {
    renderer = null;
  }
  let hevcHardware = null;
  try {
    const info = await navigator.mediaCapabilities?.decodingInfo({
      type: 'media-source',
      video: { contentType: 'video/mp4; codecs="hvc1.2.4.L150.90"', width: 3840, height: 2160, bitrate: 20_000_000, framerate: 24 },
    });
    if (info) hevcHardware = Boolean(info.supported && info.powerEfficient);
  } catch {
    hevcHardware = null;
  }
  return { renderer, gpu: Boolean(renderer) && !SOFTWARE_RENDERER.test(renderer), hevcHardware };
}

// Short GPU name for display, e.g. "NVIDIA GeForce RTX 3060".
export function gpuName(renderer) {
  if (!renderer) return '';
  const inner = renderer.match(/ANGLE \((.*)\)/)?.[1] || renderer;
  const parts = inner.split(',').map((p) => p.trim());
  const name = parts.find((p) => /nvidia|geforce|radeon|amd|intel|arc|apple|adreno|mali/i.test(p)) || parts[1] || parts[0];
  return name.replace(/\s*\(0x[0-9a-f]+\)/gi, '').replace(/Direct3D.*$/i, '').trim();
}

export const HW_HELP = 'Donanım hızlandırmayı açmak için:\n\n'
  + '• Edge: Ayarlar → Sistem ve performans → "Kullanılabilir olduğunda grafik hızlandırmayı kullan"ı aç → Yeniden başlat.\n'
  + '• Chrome: Ayarlar → Sistem → "Mümkün olduğunda grafik hızlandırmayı kullan"ı aç → Yeniden başlat.\n'
  + '• Opera: Ayarlar → Gelişmiş → Tarayıcı → Sistem → "Mümkün olduğunda donanım hızlandırmayı kullan".\n\n'
  + 'Ekran kartı sürücüsünün güncel olduğundan emin ol, sonra odayı yenile.';
