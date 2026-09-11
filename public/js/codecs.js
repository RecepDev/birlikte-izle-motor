// Which codecs this browser can decode inside HLS (fMP4), for Stremio's converter.

const PROBES = {
  video: [
    // HEVC only if both 8-bit and 10-bit decode: most x265 releases are 10-bit.
    ['hevc', ['video/mp4; codecs="hvc1.1.6.L120.90"', 'video/mp4; codecs="hvc1.2.4.L120.90"']],
    ['av1', ['video/mp4; codecs="av01.0.08M.08"']],
  ],
  audio: [
    ['opus', ['audio/mp4; codecs="opus"']],
    ['flac', ['audio/mp4; codecs="flac"']],
    ['ac3', ['audio/mp4; codecs="ac-3"']],
    ['eac3', ['audio/mp4; codecs="ec-3"']],
  ],
};

export function browserCodecs(video) {
  const supported = (type) => {
    try {
      return Boolean(window.MediaSource?.isTypeSupported(type)) || video.canPlayType(type) !== '';
    } catch {
      return false;
    }
  };
  const pick = (list) => list.filter(([, types]) => types.every(supported)).map(([name]) => name);
  // Stremio packs HEVC as 'hev1', which Safari's HLS player rejects (Apple wants 'hvc1').
  const safari = /Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR|Android/.test(navigator.userAgent);
  const extraVideo = pick(PROBES.video).filter((c) => !(safari && c === 'hevc'));
  return {
    videoCodecs: ['h264', ...extraVideo],
    audioCodecs: ['aac', 'mp3', ...pick(PROBES.audio)],
  };
}
