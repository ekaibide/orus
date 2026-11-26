// Duración real de un Ogg/Opus: granule position de la última página / 48 kHz.
// No nos fiamos del tamaño: a muy baja calidad caben horas en pocos MB.
export function oggOpusSeconds(buf: Uint8Array): number | null {
  if (buf.length < 64 || String.fromCharCode(...buf.subarray(0, 4)) !== "OggS") return null;
  const head = new TextDecoder().decode(buf.subarray(0, 200));
  if (!head.includes("OpusHead")) return null;
  for (let i = buf.length - 27; i >= 0; i--) {
    if (buf[i] === 0x4f && buf[i + 1] === 0x67 && buf[i + 2] === 0x67 && buf[i + 3] === 0x53) {
      const granule = new DataView(buf.buffer, buf.byteOffset + i + 6, 8).getBigUint64(0, true);
      return Number(granule) / 48000;
    }
  }
  return null;
}
