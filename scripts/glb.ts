// A binary glTF 2.0 container: JSON is space-padded and BIN is zero-padded to four-byte boundaries.
export function encodeGlb(json: object, binary: Uint8Array): Uint8Array<ArrayBuffer> {
  const padded = (length: number) => (length + 3) & ~3;
  const text = Buffer.from(JSON.stringify(json));
  const description = Buffer.alloc(padded(text.byteLength), 0x20);
  text.copy(description);
  const binaryLength = padded(binary.byteLength);
  const file = Buffer.alloc(12 + 8 + description.byteLength + 8 + binaryLength);
  file.writeUInt32LE(0x46546c67, 0);
  file.writeUInt32LE(2, 4);
  file.writeUInt32LE(file.byteLength, 8);
  file.writeUInt32LE(description.byteLength, 12);
  file.writeUInt32LE(0x4e4f534a, 16);
  description.copy(file, 20);
  const binaryStart = 20 + description.byteLength;
  file.writeUInt32LE(binaryLength, binaryStart);
  file.writeUInt32LE(0x004e4942, binaryStart + 4);
  file.set(binary, binaryStart + 8);
  return new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
}
