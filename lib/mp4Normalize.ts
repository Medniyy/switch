/**
 * Rewrite a MediaRecorder MP4 into the boring, editable shape — **without
 * decoding, re-encoding or otherwise touching a single byte of media**.
 *
 * Why this exists
 * ---------------
 * lib/mp4Recorder.ts (WebCodecs) already produces a flat, faststart,
 * constant-frame-rate H.264/AAC file. But it is deliberately skipped on WebKit
 * whenever sound is on, because the only route from a mic into `AudioEncoder`
 * there is a WebAudio graph, and real iPhones feed that graph digital silence
 * while every API reports success. So every iOS take with audio comes out of
 * MediaRecorder instead — which records the raw mic track and sounds great, and
 * writes a container that editors hate:
 *
 *   - **fragmented** (`ftyp moov moof mdat moof mdat …`). `recorder.start(1000)`
 *     is required on iOS to stop the video encoder stalling mid-clip, and it
 *     buys that at the cost of one fragment per second — ~60 of them in a
 *     maximum-length clip.
 *   - **variable frame rate**. The canvas frame pump asks for 30 fps; at 1080p
 *     with face detection on the same thread it delivers ~21, unevenly. Editors
 *     that assume CFR import that as stutter and drifting audio.
 *
 * Measured by the user on a real iPhone: a clip imported into CapCut jumped and
 * desynced badly enough to be uneditable, and the fix was to push it through
 * Telegram, which re-encodes to a flat ~18.6 fps CFR MP4. That round trip is
 * what this module removes.
 *
 * What it does
 * ------------
 * Demux the recording, then re-mux the *same encoded samples* into a single flat
 * `moov`-first MP4:
 *
 *   - **Video** samples are copied verbatim and re-stamped onto a uniform grid,
 *     so the track is genuinely CFR (one `stts` run) at whatever rate the device
 *     really achieved. Total span is preserved exactly, so nothing drifts.
 *   - **Audio** samples are copied verbatim, at their original timestamps, with
 *     the original AudioSpecificConfig. Nothing is decoded, resampled, gained or
 *     re-encoded — the AAC bitstream in the output is byte-identical to the one
 *     WebKit recorded. The sound the user is happy with is not in scope here and
 *     must never become so.
 *
 * Anything unexpected — a codec we can't pass through, a rotation matrix, a
 * missing box, a track that ends up short — abandons the rewrite and returns the
 * ORIGINAL blob. A slightly awkward clip beats a lost or damaged one, always.
 */
import { ArrayBufferTarget, Muxer } from "mp4-muxer";

/**
 * Timescale mp4-muxer gives a video track when `frameRate` is not supplied.
 * Worth knowing exactly, because CFR here means "every `stts` delta is the same
 * integer" — so the uniform frame duration has to be a whole number of THESE
 * units. Pick it in seconds and the muxer's own rounding reintroduces the
 * ±1-unit wobble we came to remove.
 */
const VIDEO_TIMESCALE = 57_600;

/** Microseconds per video timescale unit — the muxer's raw API speaks µs. */
const US_PER_UNIT = 1_000_000 / VIDEO_TIMESCALE;

/** Deepest box nesting we'll follow. Guards against a malformed file looping. */
const MAX_DEPTH = 12;

/** Boxes whose payload is nothing but more boxes. `stsd` is NOT one of them —
 *  its entries carry a fixed-size header before their children. */
const CONTAINERS = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "edts",
  "mvex",
  "moof",
  "traf",
  "udta",
  "dinf",
]);

interface Box {
  type: string;
  /** Offset of the box header. */
  start: number;
  /** Offset of the payload, past the header. */
  body: number;
  /** Offset one past the last byte of the box. */
  end: number;
  children: Box[];
}

function readBoxes(d: DataView, from: number, to: number, depth: number): Box[] {
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
      if (i + 16 > to) break;
      // 64-bit size. Safe as a Number for anything a phone can record.
      size = d.getUint32(i + 8) * 2 ** 32 + d.getUint32(i + 12);
      header = 16;
    } else if (size === 0) {
      size = to - i; // extends to the end of the file
    }
    if (size < header || i + size > to) break;
    const box: Box = {
      type,
      start: i,
      body: i + header,
      end: i + size,
      children: [],
    };
    if (CONTAINERS.has(type) && depth < MAX_DEPTH) {
      box.children = readBoxes(d, box.body, box.end, depth + 1);
    }
    out.push(box);
    i += size;
  }
  return out;
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

/** Child boxes of a sample entry, which begin `offset` bytes into its payload. */
function entryChildren(d: DataView, entry: Box, offset: number): Box[] {
  const from = entry.body + offset;
  if (from >= entry.end) return [];
  return readBoxes(d, from, entry.end, 0);
}

// ---------------------------------------------------------------------------
// Demuxed shape
// ---------------------------------------------------------------------------

interface RawSample {
  /** The encoded access unit, as a view into the source buffer (no copy). */
  data: Uint8Array;
  /** Decode time, in the track's own timescale. */
  dts: number;
  /** Duration, in the track's own timescale. */
  duration: number;
  /** Composition offset (PTS − DTS), in the track's own timescale. */
  cts: number;
  /** Sync sample — a frame that can be seeked to. */
  key: boolean;
}

interface Track {
  id: number;
  kind: "video" | "audio";
  /** Sample-entry format code: "avc1", "mp4a", … */
  format: string;
  timescale: number;
  /** avcC record (video) or AudioSpecificConfig (audio). */
  description: Uint8Array | null;
  width: number;
  height: number;
  sampleRate: number;
  channels: number;
  samples: RawSample[];
  /** Per-track defaults from `trex`, used when a fragment omits them. */
  defaults: { duration: number; size: number; flags: number };
}

/** The identity transform every canvas capture carries, as tkhd stores it. */
const IDENTITY_MATRIX = [
  0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000,
];

/**
 * Walk the MPEG-4 descriptor chain inside an `esds` and return the
 * DecoderSpecificInfo — for AAC, the AudioSpecificConfig the muxer needs to
 * write a faithful `esds` of its own.
 */
function audioSpecificConfig(
  bytes: Uint8Array,
  d: DataView,
  esds: Box
): Uint8Array | null {
  let i = esds.body + 4; // version + flags
  const end = esds.end;

  /** Descriptor headers are a tag byte plus a 7-bits-per-byte varint length. */
  const readHeader = (): { tag: number; length: number } | null => {
    if (i >= end) return null;
    const tag = d.getUint8(i++);
    let length = 0;
    for (let n = 0; n < 4; n++) {
      if (i >= end) return null;
      const b = d.getUint8(i++);
      length = (length << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return { tag, length };
  };

  const es = readHeader();
  if (!es || es.tag !== 0x03) return null;
  if (i + 3 > end) return null;
  i += 2; // ES_ID
  const flags = d.getUint8(i++);
  if (flags & 0x80) i += 2; // dependsOn_ES_ID
  if (flags & 0x40) {
    if (i >= end) return null;
    i += 1 + d.getUint8(i); // URL
  }
  if (flags & 0x20) i += 2; // OCR_ES_Id

  const dcd = readHeader();
  if (!dcd || dcd.tag !== 0x04) return null;
  i += 13; // objectTypeIndication, streamType, bufferSize, max/avg bitrate

  const dsi = readHeader();
  if (!dsi || dsi.tag !== 0x05) return null;
  if (i + dsi.length > end) return null;
  return bytes.subarray(i, i + dsi.length);
}

/** Sample rate and channel count as the AudioSpecificConfig itself declares
 *  them — authoritative, and guaranteed to agree with the description we pass
 *  the muxer (which uses the declared rate as the audio track's timescale). */
const ASC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];

function ascLayout(asc: Uint8Array): { sampleRate: number; channels: number } | null {
  if (asc.length < 2) return null;
  const bits = (asc[0] << 8) | asc[1];
  const freqIndex = (bits >> 7) & 0x0f;
  if (freqIndex === 15) {
    if (asc.length < 5) return null;
    // 24-bit explicit rate starting at bit 9.
    const raw =
      ((asc[1] & 0x7f) << 17) | (asc[2] << 9) | (asc[3] << 1) | (asc[4] >> 7);
    const channels = (asc[4] >> 3) & 0x0f;
    return raw > 0 && channels > 0 ? { sampleRate: raw, channels } : null;
  }
  const sampleRate = ASC_RATES[freqIndex];
  const channels = (bits >> 3) & 0x0f;
  if (!sampleRate || channels < 1 || channels > 2) return null;
  return { sampleRate, channels };
}

/** Read the track-level metadata out of `moov`. Samples come later, from either
 *  the flat sample tables or the fragments. */
function readTracks(bytes: Uint8Array, d: DataView, moov: Box): Track[] {
  const tracks: Track[] = [];

  for (const trak of findAll([moov], "trak")) {
    const tkhd = find([trak], "tkhd");
    const mdhd = find([trak], "mdhd");
    const hdlr = find([trak], "hdlr");
    const stsd = find([trak], "stsd");
    if (!tkhd || !mdhd || !hdlr || !stsd) continue;

    const tkhdV = d.getUint8(tkhd.body);
    const idOff = tkhdV === 1 ? 20 : 12;
    const matrixOff = tkhdV === 1 ? 52 : 40;
    const id = d.getUint32(tkhd.body + idOff);

    const mdhdV = d.getUint8(mdhd.body);
    const timescale = d.getUint32(mdhd.body + (mdhdV === 1 ? 20 : 12));
    if (!timescale) throw new Error("track has no timescale");

    const handler = String.fromCharCode(
      d.getUint8(hdlr.body + 8),
      d.getUint8(hdlr.body + 9),
      d.getUint8(hdlr.body + 10),
      d.getUint8(hdlr.body + 11)
    );
    if (handler !== "vide" && handler !== "soun") continue;

    // Canvas capture always writes the identity transform, so anything else on
    // the VIDEO track is a rotation we would silently drop — refuse the rewrite
    // rather than hand back a clip that plays on its side. Only the video track
    // is checked: the display matrix means nothing for sound, and Chrome leaves
    // the audio one filled with zeroes.
    if (handler === "vide") {
      for (let m = 0; m < 9; m++) {
        const at = tkhd.body + matrixOff + m * 4;
        if (at + 4 > tkhd.end) throw new Error("tkhd truncated");
        if (d.getInt32(at) !== IDENTITY_MATRIX[m]) {
          throw new Error("video track carries a non-identity transform");
        }
      }
    }

    // stsd: version/flags (4) + entry_count (4), then sized sample entries.
    const entries = readBoxes(d, stsd.body + 8, stsd.end, 0);
    const entry = entries[0];
    if (!entry) throw new Error("empty stsd");

    const track: Track = {
      id,
      kind: handler === "vide" ? "video" : "audio",
      format: entry.type,
      timescale,
      description: null,
      width: 0,
      height: 0,
      sampleRate: 0,
      channels: 0,
      samples: [],
      defaults: { duration: 0, size: 0, flags: 0 },
    };

    if (track.kind === "video") {
      // VisualSampleEntry: 78 bytes of fixed header before the child boxes.
      track.width = d.getUint16(entry.body + 24);
      track.height = d.getUint16(entry.body + 26);
      const avcC = find(entryChildren(d, entry, 78), "avcC");
      if (avcC) track.description = bytes.subarray(avcC.body, avcC.end);
    } else {
      // AudioSampleEntry: 28 bytes of fixed header before the child boxes.
      const esds = find(entryChildren(d, entry, 28), "esds");
      const asc = esds ? audioSpecificConfig(bytes, d, esds) : null;
      const layout = asc ? ascLayout(asc) : null;
      if (asc && layout) {
        track.description = asc;
        track.sampleRate = layout.sampleRate;
        track.channels = layout.channels;
      }
    }

    tracks.push(track);
  }

  // Fragment defaults, when the file is fragmented.
  const mvex = find([moov], "mvex");
  for (const trex of mvex ? findAll([mvex], "trex") : []) {
    const track = tracks.find((t) => t.id === d.getUint32(trex.body + 4));
    if (!track) continue;
    track.defaults = {
      duration: d.getUint32(trex.body + 12),
      size: d.getUint32(trex.body + 16),
      flags: d.getUint32(trex.body + 20),
    };
  }

  return tracks;
}

/** `sample_is_non_sync_sample` lives at bit 16 of a sample-flags word. */
const isKeyframe = (flags: number) => (flags & 0x00010000) === 0;

/** Pull samples out of every `moof`/`traf`/`trun` in the file. */
function readFragmentedSamples(
  bytes: Uint8Array,
  d: DataView,
  boxes: Box[],
  tracks: Track[]
): void {
  for (const moof of boxes.filter((b) => b.type === "moof")) {
    for (const traf of findAll([moof], "traf")) {
      const tfhd = find([traf], "tfhd");
      if (!tfhd) continue;
      const tfhdFlags = d.getUint32(tfhd.body) & 0x00ffffff;
      const track = tracks.find((t) => t.id === d.getUint32(tfhd.body + 4));
      if (!track) continue;

      let p = tfhd.body + 8;
      // `default-base-is-moof` (and, in practice, its absence too) puts the base
      // at the start of the enclosing moof.
      let base = moof.start;
      if (tfhdFlags & 0x000001) {
        base = d.getUint32(p) * 2 ** 32 + d.getUint32(p + 4);
        p += 8;
      }
      if (tfhdFlags & 0x000002) p += 4; // sample_description_index
      let defDuration = track.defaults.duration;
      let defSize = track.defaults.size;
      let defFlags = track.defaults.flags;
      if (tfhdFlags & 0x000008) {
        defDuration = d.getUint32(p);
        p += 4;
      }
      if (tfhdFlags & 0x000010) {
        defSize = d.getUint32(p);
        p += 4;
      }
      if (tfhdFlags & 0x000020) {
        defFlags = d.getUint32(p);
        p += 4;
      }

      const tfdt = find([traf], "tfdt");
      let dts = 0;
      if (tfdt) {
        dts =
          d.getUint8(tfdt.body) === 1
            ? d.getUint32(tfdt.body + 4) * 2 ** 32 + d.getUint32(tfdt.body + 8)
            : d.getUint32(tfdt.body + 4);
      } else if (track.samples.length) {
        const last = track.samples[track.samples.length - 1];
        dts = last.dts + last.duration;
      }

      let cursor = base;
      for (const trun of findAll([traf], "trun")) {
        const version = d.getUint8(trun.body);
        const flags = d.getUint32(trun.body) & 0x00ffffff;
        const count = d.getUint32(trun.body + 4);
        let q = trun.body + 8;
        if (flags & 0x000001) {
          cursor = base + d.getInt32(q);
          q += 4;
        }
        let firstFlags: number | null = null;
        if (flags & 0x000004) {
          firstFlags = d.getUint32(q);
          q += 4;
        }

        for (let s = 0; s < count; s++) {
          let duration = defDuration;
          let size = defSize;
          let sampleFlags = s === 0 && firstFlags !== null ? firstFlags : defFlags;
          let cts = 0;
          if (flags & 0x000100) {
            duration = d.getUint32(q);
            q += 4;
          }
          if (flags & 0x000200) {
            size = d.getUint32(q);
            q += 4;
          }
          if (flags & 0x000400) {
            sampleFlags = d.getUint32(q);
            q += 4;
          }
          if (flags & 0x000800) {
            cts = version === 0 ? d.getUint32(q) : d.getInt32(q);
            q += 4;
          }
          if (cursor + size > bytes.length) throw new Error("sample past EOF");
          track.samples.push({
            data: bytes.subarray(cursor, cursor + size),
            dts,
            duration,
            cts,
            key: track.kind === "audio" || isKeyframe(sampleFlags),
          });
          cursor += size;
          dts += duration;
        }
      }
    }
  }
}

/** Pull samples out of a flat `stbl` sample table (a non-fragmented file). */
function readFlatSamples(
  bytes: Uint8Array,
  d: DataView,
  moov: Box,
  tracks: Track[]
): void {
  for (const trak of findAll([moov], "trak")) {
    const tkhd = find([trak], "tkhd");
    if (!tkhd) continue;
    const id = d.getUint32(tkhd.body + (d.getUint8(tkhd.body) === 1 ? 20 : 12));
    const track = tracks.find((t) => t.id === id);
    if (!track) continue;

    const stts = find([trak], "stts");
    const stsz = find([trak], "stsz");
    const stsc = find([trak], "stsc");
    const stco = find([trak], "stco") ?? find([trak], "co64");
    if (!stts || !stsz || !stsc || !stco) throw new Error("incomplete stbl");

    // Sizes
    const uniformSize = d.getUint32(stsz.body + 4);
    const sampleCount = d.getUint32(stsz.body + 8);
    const sizes: number[] = new Array(sampleCount);
    for (let s = 0; s < sampleCount; s++) {
      sizes[s] = uniformSize || d.getUint32(stsz.body + 12 + s * 4);
    }

    // Durations
    const durations: number[] = [];
    const sttsCount = d.getUint32(stts.body + 4);
    for (let e = 0; e < sttsCount; e++) {
      const at = stts.body + 8 + e * 8;
      const runCount = d.getUint32(at);
      const delta = d.getUint32(at + 4);
      for (let n = 0; n < runCount && durations.length < sampleCount; n++) {
        durations.push(delta);
      }
    }
    while (durations.length < sampleCount) durations.push(durations.at(-1) ?? 0);

    // Composition offsets (absent means all zero).
    const offsets: number[] = new Array(sampleCount).fill(0);
    const ctts = find([trak], "ctts");
    if (ctts) {
      const version = d.getUint8(ctts.body);
      const cttsCount = d.getUint32(ctts.body + 4);
      let w = 0;
      for (let e = 0; e < cttsCount && w < sampleCount; e++) {
        const at = ctts.body + 8 + e * 8;
        const runCount = d.getUint32(at);
        const offset = version === 1 ? d.getInt32(at + 4) : d.getUint32(at + 4);
        for (let n = 0; n < runCount && w < sampleCount; n++) offsets[w++] = offset;
      }
    }

    // Sync samples (absent means every sample is one).
    const stss = find([trak], "stss");
    let sync: Set<number> | null = null;
    if (stss) {
      sync = new Set<number>();
      const n = d.getUint32(stss.body + 4);
      for (let e = 0; e < n; e++) sync.add(d.getUint32(stss.body + 8 + e * 4));
    }

    // Chunk offsets, and how many samples live in each chunk.
    const wide = stco.type === "co64";
    const chunkCount = d.getUint32(stco.body + 4);
    const chunkOffsets: number[] = new Array(chunkCount);
    for (let c = 0; c < chunkCount; c++) {
      const at = stco.body + 8 + c * (wide ? 8 : 4);
      chunkOffsets[c] = wide
        ? d.getUint32(at) * 2 ** 32 + d.getUint32(at + 4)
        : d.getUint32(at);
    }
    const runs: { firstChunk: number; perChunk: number }[] = [];
    const stscCount = d.getUint32(stsc.body + 4);
    for (let e = 0; e < stscCount; e++) {
      const at = stsc.body + 8 + e * 12;
      runs.push({
        firstChunk: d.getUint32(at),
        perChunk: d.getUint32(at + 4),
      });
    }

    let sample = 0;
    let dts = 0;
    for (let c = 0; c < chunkCount && sample < sampleCount; c++) {
      // The last run whose firstChunk (1-based) is at or before this chunk.
      let perChunk = runs[0]?.perChunk ?? 0;
      for (const run of runs) if (run.firstChunk <= c + 1) perChunk = run.perChunk;

      let at = chunkOffsets[c];
      for (let n = 0; n < perChunk && sample < sampleCount; n++) {
        const size = sizes[sample];
        if (at + size > bytes.length) throw new Error("sample past EOF");
        track.samples.push({
          data: bytes.subarray(at, at + size),
          dts,
          duration: durations[sample],
          cts: offsets[sample],
          key: track.kind === "audio" || !sync || sync.has(sample + 1),
        });
        at += size;
        dts += durations[sample];
        sample++;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Re-mux
// ---------------------------------------------------------------------------

/** Drop leading samples so both tracks begin at the same instant.
 *
 *  A flat MP4's sample table has nowhere to record "this track starts 80 ms in"
 *  — time comes only from `stts` deltas. Zero-basing both tracks regardless
 *  would therefore pull the later one forward by exactly that gap, which is a
 *  lip-sync error introduced by us. Trimming whole samples off the front of the
 *  earlier track instead leaves a residual below one sample (≈21 ms of audio,
 *  one video frame) and keeps the two in step. On WebKit both tracks start at
 *  zero and this does nothing at all. */
function alignStarts(video: Track, audio: Track | null): void {
  if (!audio || !video.samples.length || !audio.samples.length) return;
  const startOf = (t: Track) => t.samples[0].dts / t.timescale;
  const common = Math.max(startOf(video), startOf(audio));
  for (const track of [video, audio]) {
    let drop = 0;
    while (
      drop < track.samples.length - 1 &&
      (track.samples[drop].dts + track.samples[drop].duration) / track.timescale <=
        common
    ) {
      drop++;
    }
    if (drop) track.samples.splice(0, drop);
  }
}

/**
 * Re-time a video track onto a uniform grid and hand it to the muxer.
 *
 * The grid step is chosen in whole `VIDEO_TIMESCALE` units so the muxer's own
 * rounding cannot smear it back into a two-run `stts`, and it is derived from
 * the take's real span divided by its real frame count — so the clip keeps its
 * exact duration and stays in step with the untouched audio. The rate that
 * falls out is whatever the device actually managed (~21 fps on an iPhone at
 * 1080p), which is fine: constant beats fast. Editors choke on the variance,
 * not on the number.
 */
function addVideo(muxer: Muxer<ArrayBufferTarget>, track: Track): void {
  const samples = track.samples;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const spanSeconds = (last.dts + last.duration - first.dts) / track.timescale;
  const unit = Math.max(
    1,
    Math.round((VIDEO_TIMESCALE * spanSeconds) / samples.length)
  );
  const durationUs = unit * US_PER_UNIT;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const ctsUs = (s.cts / track.timescale) * 1_000_000;
    muxer.addVideoChunkRaw(
      s.data,
      s.key ? "key" : "delta",
      i * unit * US_PER_UNIT + ctsUs,
      durationUs,
      i === 0 && track.description
        ? {
            decoderConfig: {
              codec: "avc1.42E01E",
              description: track.description,
              codedWidth: track.width,
              codedHeight: track.height,
            },
          }
        : undefined,
      ctsUs
    );
  }
}

/** Copy the audio track through verbatim: same bytes, same timing, same config.
 *  Every line here exists to avoid changing the sound. */
function addAudio(muxer: Muxer<ArrayBufferTarget>, track: Track): void {
  const base = track.samples[0].dts;
  const toUs = (units: number) => (units / track.timescale) * 1_000_000;
  for (const s of track.samples) {
    muxer.addAudioChunkRaw(
      s.data,
      "key",
      toUs(s.dts - base),
      toUs(s.duration),
      s === track.samples[0] && track.description
        ? {
            decoderConfig: {
              codec: "mp4a.40.2",
              description: track.description,
              sampleRate: track.sampleRate,
              numberOfChannels: track.channels,
            },
          }
        : undefined
    );
  }
}

function rewrite(bytes: Uint8Array): Blob {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = readBoxes(d, 0, bytes.byteLength, 0);

  const moov = boxes.find((b) => b.type === "moov");
  if (!moov) throw new Error("no moov");

  const tracks = readTracks(bytes, d, moov);
  if (boxes.some((b) => b.type === "moof")) {
    readFragmentedSamples(bytes, d, boxes, tracks);
  } else {
    readFlatSamples(bytes, d, moov, tracks);
  }

  const video = tracks.find((t) => t.kind === "video") ?? null;
  const audio = tracks.find((t) => t.kind === "audio") ?? null;

  if (!video) throw new Error("no video track");
  if (video.format !== "avc1" || !video.description) {
    throw new Error(`unsupported video sample entry: ${video.format}`);
  }
  if (!video.samples.length) throw new Error("video track has no samples");
  if (!video.width || !video.height) throw new Error("video track has no size");

  // An audio track we cannot pass through must abandon the whole rewrite. The
  // one thing worse than an awkward container is a clip that lost its sound.
  if (audio) {
    if (audio.format !== "mp4a" || !audio.description) {
      throw new Error(`unsupported audio sample entry: ${audio.format}`);
    }
    if (!audio.samples.length) throw new Error("audio track has no samples");
  }

  alignStarts(video, audio);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    // No `frameRate` on purpose: supplying it would make the frame rate the
    // track timescale, and the real rate here is fractional.
    video: { codec: "avc", width: video.width, height: video.height },
    ...(audio
      ? {
          audio: {
            codec: "aac",
            sampleRate: audio.sampleRate,
            numberOfChannels: audio.channels,
          },
        }
      : {}),
    // Flat `moov` at the front of the file — the whole point of the exercise.
    fastStart: "in-memory",
    // Both tracks are already zero-based by alignStarts; this is the safety net
    // that keeps a stray offset from throwing away the take.
    firstTimestampBehavior: "cross-track-offset",
  });

  addVideo(muxer, video);
  if (audio) addAudio(muxer, audio);
  muxer.finalize();

  const { buffer } = muxer.target;
  if (!buffer || buffer.byteLength === 0) throw new Error("muxer wrote nothing");
  return new Blob([buffer], { type: "video/mp4" });
}

/**
 * Return an editable version of a recorded clip, or the clip itself if it can't
 * be rewritten safely.
 *
 * Never throws and never returns something worse than what it was given: any
 * failure at all — a container shape we don't recognise, a codec we can't pass
 * through, an out-of-memory on a long take — falls back to the original blob.
 */
export async function normalizeRecordedMp4(blob: Blob): Promise<Blob> {
  if (!blob.type.includes("mp4") || blob.size === 0) return blob;
  try {
    const out = rewrite(new Uint8Array(await blob.arrayBuffer()));
    // A rewrite that lost most of the file is a parse we got wrong, however
    // cleanly it finished. Re-muxing drops fragment overhead, so the output is
    // expected to be a little smaller — but only a little.
    return out.size > blob.size * 0.5 ? out : blob;
  } catch (err) {
    // Not fatal, but never silent: a clip that comes back fragmented looks
    // identical in the browser and only misbehaves once it reaches an editor,
    // which is far too late to work out why. Say which shape defeated us.
    console.warn("[mp4Normalize] keeping the original recording:", err);
    return blob;
  }
}
