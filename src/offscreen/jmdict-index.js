/**
 * Reader for the packed JMdict gloss index.
 *
 * The map used to ship as JSON and was JSON.parse'd into a plain object with
 * 462,753 keys — 60 MB of heap for 26 MB of data, plus a ~42 MB transient
 * string during the parse, and an object that size lands V8 in dictionary
 * mode. The offscreen document holds it for as long as it lives, so that was a
 * standing cost for a lookup table that is only ever read.
 *
 * It is now three flat buffers — a UTF-8 key blob, a UTF-8 gloss blob, and
 * offset tables over keys sorted by UTF-8 byte order — which is roughly the
 * raw byte size in ArrayBuffers and nothing else. Lookup binary-searches the
 * key blob by comparing encoded bytes, so no key is ever decoded.
 *
 * No chrome.* here on purpose: the offline test loads the same file from disk.
 */

export const JMDICT_MAGIC = 0x4b4a4d44; // 'KJMD'
export const JMDICT_FORMAT_VERSION = 1;
export const JMDICT_HEADER_BYTES = 24;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Compare a key stored in the blob against an encoded probe.
 * Returns <0, 0 or >0 like a sort comparator.
 */
function compareStoredKey(blob, start, end, probe) {
  const storedLen = end - start;
  const shared = Math.min(storedLen, probe.length);
  for (let i = 0; i < shared; i++) {
    const diff = blob[start + i] - probe[i];
    if (diff !== 0) return diff;
  }
  return storedLen - probe.length;
}

/**
 * Wrap a decompressed index buffer.
 * @param {ArrayBuffer} buffer
 * @returns {{count: number, lookup: (key: string) => string, keyAt: (i: number) => string}}
 */
export function decodeJmdictIndex(buffer) {
  const header = new Uint32Array(buffer, 0, 6);
  if (header[0] !== JMDICT_MAGIC) {
    throw new Error(`jmdict: bad magic 0x${header[0].toString(16)}`);
  }
  if (header[1] !== JMDICT_FORMAT_VERSION) {
    throw new Error(`jmdict: unsupported format version ${header[1]}`);
  }

  const count = header[2];
  const keyBytesLen = header[3];
  const glossBytesLen = header[4];

  let offset = JMDICT_HEADER_BYTES;
  const keyOffsets = new Uint32Array(buffer, offset, count + 1);
  offset += (count + 1) * 4;
  const glossOffsets = new Uint32Array(buffer, offset, count + 1);
  offset += (count + 1) * 4;
  const keyBlob = new Uint8Array(buffer, offset, keyBytesLen);
  offset += keyBytesLen;
  const glossBlob = new Uint8Array(buffer, offset, glossBytesLen);

  function indexOfKey(key) {
    const probe = encoder.encode(key);
    let lo = 0;
    let hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cmp = compareStoredKey(keyBlob, keyOffsets[mid], keyOffsets[mid + 1], probe);
      if (cmp === 0) return mid;
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  return {
    count,
    lookup(key) {
      if (!key) return '';
      const i = indexOfKey(key);
      if (i === -1) return '';
      return decoder.decode(glossBlob.subarray(glossOffsets[i], glossOffsets[i + 1]));
    },
    keyAt(i) {
      return decoder.decode(keyBlob.subarray(keyOffsets[i], keyOffsets[i + 1]));
    },
  };
}

/**
 * Pack a { key: gloss } map into the index format. Used by the build script;
 * kept beside the reader so the two layouts cannot drift apart.
 * @param {Record<string, string>} map
 * @returns {Uint8Array}
 */
export function encodeJmdictIndex(map) {
  const keys = Object.keys(map);
  const encodedKeys = new Map();
  for (const key of keys) encodedKeys.set(key, encoder.encode(key));

  // Sort by UTF-8 byte order, which is what lookup binary-searches on. Sorting
  // the strings directly would use UTF-16 code-unit order, and that disagrees
  // with byte order for supplementary-plane characters (rare kanji).
  keys.sort((a, b) => {
    const ea = encodedKeys.get(a);
    const eb = encodedKeys.get(b);
    return compareStoredKey(ea, 0, ea.length, eb);
  });

  const count = keys.length;
  const encodedGlosses = keys.map(k => encoder.encode(map[k]));

  let keyBytesLen = 0;
  for (const k of keys) keyBytesLen += encodedKeys.get(k).length;
  let glossBytesLen = 0;
  for (const g of encodedGlosses) glossBytesLen += g.length;

  const total = JMDICT_HEADER_BYTES + (count + 1) * 8 + keyBytesLen + glossBytesLen;
  const buffer = new ArrayBuffer(total);

  const header = new Uint32Array(buffer, 0, 6);
  header[0] = JMDICT_MAGIC;
  header[1] = JMDICT_FORMAT_VERSION;
  header[2] = count;
  header[3] = keyBytesLen;
  header[4] = glossBytesLen;
  header[5] = 0;

  let offset = JMDICT_HEADER_BYTES;
  const keyOffsets = new Uint32Array(buffer, offset, count + 1);
  offset += (count + 1) * 4;
  const glossOffsets = new Uint32Array(buffer, offset, count + 1);
  offset += (count + 1) * 4;
  const keyBlob = new Uint8Array(buffer, offset, keyBytesLen);
  offset += keyBytesLen;
  const glossBlob = new Uint8Array(buffer, offset, glossBytesLen);

  let keyPos = 0;
  let glossPos = 0;
  for (let i = 0; i < count; i++) {
    keyOffsets[i] = keyPos;
    glossOffsets[i] = glossPos;
    const ek = encodedKeys.get(keys[i]);
    keyBlob.set(ek, keyPos);
    keyPos += ek.length;
    const eg = encodedGlosses[i];
    glossBlob.set(eg, glossPos);
    glossPos += eg.length;
  }
  keyOffsets[count] = keyPos;
  glossOffsets[count] = glossPos;

  return new Uint8Array(buffer);
}
