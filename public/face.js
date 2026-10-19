// Grabs the camera frame from the loudest moment of a recording: usually the funniest face.

const SAMPLE_MS = 80;
const WIDTH = 320;

let audioCtx = null;
let grabVideo = null;

export function startFaceCapture(stream) {
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack || videoTrack.readyState !== "live") return { stop: async () => null };

  if (!grabVideo) {
    grabVideo = document.createElement("video");
    grabVideo.muted = true;
    grabVideo.playsInline = true;
  }
  if (grabVideo.srcObject !== stream) grabVideo.srcObject = stream;
  grabVideo.play().catch(() => {});

  audioCtx ??= new AudioContext();
  audioCtx.resume().catch(() => {});
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d");
  let best = -1;

  const grab = () => {
    const vw = grabVideo.videoWidth;
    const vh = grabVideo.videoHeight;
    if (!vw || !vh) return false;
    canvas.width = WIDTH;
    canvas.height = Math.round((WIDTH * vh) / vw);
    // unmirrored, the way the opponent sees you (text on clothes reads correctly)
    g.drawImage(grabVideo, 0, 0, canvas.width, canvas.height);
    return true;
  };

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += v * v;
    const level = Math.sqrt(sum / samples.length);
    if (level > best && grab()) best = level;
  }, SAMPLE_MS);

  return {
    async stop() {
      clearInterval(timer);
      source.disconnect();
      if (best < 0 && !grab()) return null; // never got a frame
      return canvas.toDataURL("image/jpeg", 0.75);
    },
  };
}
