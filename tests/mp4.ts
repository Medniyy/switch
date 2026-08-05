/**
 * A deliberately small MP4 box reader, just big enough to assert on the things
 * that made exported clips uneditable. Written by hand rather than shelling out
 * to ffprobe so the video regression test needs nothing installed beyond the
 * repo itself.
 *
 * What it answers:
 *   - is the file progressive (flat `moov`, no `moof` fragments) and faststart?
 *   - which codecs are actually in the sample descriptions? (`avc1` / `mp4a` —
 *     an Opus track shows up here as `Opus`, which is the bug we are guarding)
 *   - is the video track constant-frame-rate, and at what rate?
 */

/** Boxes whose payload is just more boxes. */
const CONTAINERS = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "edts",
  "mvex",
  "udta",
  "moof",
  "traf",
]);

export interface Box {
  type: string;
  start: number;
  size: number;
  /** Offset of the payload (past the header). */
  body: number;
  children: Box[];
}

function readBoxes(d: DataView, from: number, to: number): Box[] {
  const out: Box[] = [];
  let i = from;
  while (i + 8 <= to) {
    let size = d.getUint32(i);
    const type = String.fromCharCode(
      d.getUint8(i + 4),
      d.getUint8(i + 5),
      d.getUint8(i + 6),
      d.getUint8(i + 7)
    );
    let header = 8;
    if (size === 1) {
      // 64-bit size. Safe as a Number for any file we produce.
      const hi = d.getUint32(i + 8);
      const lo = d.getUint32(i + 12);
      size = hi * 2 ** 32 + lo;
      header = 16;
    } else if (size === 0) {
      size = to - i; // extends to end of file
    }
    if (size < header || i + size > to) break;
    const box: Box = { type, start: i, size, body: i + header, children: [] };
    if (CONTAINERS.has(type)) {
      box.children = readBoxes(d, box.body, i + size);
    }
    out.push(box);
    i += size;
  }
  return out;
}

export function parseMp4(bytes: Uint8Array): Box[] {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return readBoxes(d, 0, bytes.byteLength);
}

function findAll(boxes: Box[], type: string, acc: Box[] = []): Box[] {
  for (const b of boxes) {
    if (b.type === type) acc.push(b);
    if (b.children.length) findAll(b.children, type, acc);
  }
  return acc;
}

function find(boxes: Box[], type: string): Box | null {
  return findAll(boxes, type)[0] ?? null;
}

export interface TrackInfo {
  /** "vide" | "soun" | other, from hdlr. */
  handler: string;
  /** Sample-entry format code: "avc1", "mp4a", "Opus", … */
  format: string;
  timescale: number;
  /** Number of samples (video: frames). */
  samples: number;
  /** Distinct [count, delta] runs from stts. One run == constant frame rate. */
  sttsRuns: { count: number; delta: number }[];
  durationSeconds: number;
}

export interface Mp4Summary {
  /** Top-level box types, in file order. */
  topLevel: string[];
  /** True when `moov` precedes the first `mdat` — i.e. faststart. */
  faststart: boolean;
  /** True when the file uses `moof` fragments instead of a flat index. */
  fragmented: boolean;
  brands: string[];
  tracks: TrackInfo[];
  video: TrackInfo | null;
  audio: TrackInfo | null;
}

export function summarizeMp4(bytes: Uint8Array): Mp4Summary {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = parseMp4(bytes);
  const topLevel = boxes.map((b) => b.type);

  const moovIdx = topLevel.indexOf("moov");
  const mdatIdx = topLevel.indexOf("mdat");
  const faststart = moovIdx >= 0 && (mdatIdx === -1 || moovIdx < mdatIdx);
  const fragmented = topLevel.includes("moof");

  const brands: string[] = [];
  const ftyp = boxes.find((b) => b.type === "ftyp");
  if (ftyp) {
    for (let i = ftyp.body; i + 4 <= ftyp.start + ftyp.size; i += 4) {
      brands.push(
        String.fromCharCode(
          d.getUint8(i),
          d.getUint8(i + 1),
          d.getUint8(i + 2),
          d.getUint8(i + 3)
        )
      );
    }
  }

  const tracks: TrackInfo[] = [];
  const moov = find(boxes, "moov");
  for (const trak of moov ? findAll([moov], "trak") : []) {
    const hdlrBox = find([trak], "hdlr");
    const handler = hdlrBox
      ? String.fromCharCode(
          d.getUint8(hdlrBox.body + 8),
          d.getUint8(hdlrBox.body + 9),
          d.getUint8(hdlrBox.body + 10),
          d.getUint8(hdlrBox.body + 11)
        )
      : "";

    const mdhd = find([trak], "mdhd");
    let timescale = 0;
    let durationUnits = 0;
    if (mdhd) {
      const version = d.getUint8(mdhd.body);
      if (version === 1) {
        timescale = d.getUint32(mdhd.body + 20);
        const hi = d.getUint32(mdhd.body + 24);
        const lo = d.getUint32(mdhd.body + 28);
        durationUnits = hi * 2 ** 32 + lo;
      } else {
        timescale = d.getUint32(mdhd.body + 12);
        durationUnits = d.getUint32(mdhd.body + 16);
      }
    }

    // stsd: 4 bytes version/flags, 4 bytes entry_count, then sized entries whose
    // second word is the four-character format code.
    const stsd = find([trak], "stsd");
    let format = "";
    if (stsd) {
      const entryStart = stsd.body + 8;
      if (entryStart + 8 <= stsd.start + stsd.size) {
        format = String.fromCharCode(
          d.getUint8(entryStart + 4),
          d.getUint8(entryStart + 5),
          d.getUint8(entryStart + 6),
          d.getUint8(entryStart + 7)
        );
      }
    }

    const stts = find([trak], "stts");
    const sttsRuns: { count: number; delta: number }[] = [];
    let samples = 0;
    if (stts) {
      const entries = d.getUint32(stts.body + 4);
      for (let e = 0; e < entries; e++) {
        const at = stts.body + 8 + e * 8;
        if (at + 8 > stts.start + stts.size) break;
        const count = d.getUint32(at);
        const delta = d.getUint32(at + 4);
        sttsRuns.push({ count, delta });
        samples += count;
      }
    }

    tracks.push({
      handler,
      format,
      timescale,
      samples,
      sttsRuns,
      durationSeconds: timescale ? durationUnits / timescale : 0,
    });
  }

  return {
    topLevel,
    faststart,
    fragmented,
    brands,
    tracks,
    video: tracks.find((t) => t.handler === "vide") ?? null,
    audio: tracks.find((t) => t.handler === "soun") ?? null,
  };
}

/** Frames per second implied by the sample table, or 0 if unknown. */
export function measuredFps(t: TrackInfo): number {
  if (!t.timescale || !t.sttsRuns.length) return 0;
  const totalUnits = t.sttsRuns.reduce((n, r) => n + r.count * r.delta, 0);
  if (!totalUnits) return 0;
  return t.samples / (totalUnits / t.timescale);
}

/** True when every sample has the same duration — a genuinely CFR track. */
export function isConstantFrameRate(t: TrackInfo): boolean {
  const runs = t.sttsRuns.filter((r) => r.count > 0);
  if (runs.length <= 1) return true;
  // A final run of length 1 is the last sample's duration and is allowed to
  // differ; anything else means the timing wobbled.
  const body = runs.slice(0, -1);
  const last = runs[runs.length - 1];
  const delta = body[0].delta;
  return body.every((r) => r.delta === delta) && (last.count === 1 || last.delta === delta);
}
