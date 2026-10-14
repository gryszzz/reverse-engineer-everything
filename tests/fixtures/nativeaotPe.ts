import { createHash } from "node:crypto";

const IMAGE_BASE = 0x140000000n;
const address = (rva: number): bigint => IMAGE_BASE + BigInt(rva);

export const nativeAotPeDigest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

export const nativeAotPeFixture = (major = 9, minor = 1): Buffer => {
  const bytes = Buffer.alloc(0xa00);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(2, 0x86);
  bytes.writeUInt16LE(0xf0, 0x94);
  const optional = 0x98;
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeBigUInt64LE(IMAGE_BASE, optional + 24);
  bytes.writeUInt32LE(0x3000, optional + 56);
  bytes.writeUInt32LE(0x400, optional + 60);
  const sectionTable = optional + 0xf0;
  bytes.write(".text", sectionTable, "ascii");
  bytes.writeUInt32LE(0x200, sectionTable + 8);
  bytes.writeUInt32LE(0x1000, sectionTable + 12);
  bytes.writeUInt32LE(0x200, sectionTable + 16);
  bytes.writeUInt32LE(0x400, sectionTable + 20);
  bytes.writeUInt32LE(0x60000020, sectionTable + 36);
  const data = sectionTable + 40;
  bytes.write(".rdata", data, "ascii");
  bytes.writeUInt32LE(0x400, data + 8);
  bytes.writeUInt32LE(0x2000, data + 12);
  bytes.writeUInt32LE(0x400, data + 16);
  bytes.writeUInt32LE(0x600, data + 20);
  bytes.writeUInt32LE(0x40000040, data + 36);

  bytes.writeUInt8(0xc3, 0x410);
  bytes.writeUInt8(0xc3, 0x420);
  bytes.writeUInt8(0xc3, 0x430);
  const header = 0x600;
  bytes.writeUInt32LE(0x00525452, header);
  bytes.writeUInt16LE(major, header + 4);
  bytes.writeUInt16LE(minor, header + 6);
  bytes.writeUInt16LE(2, header + 12);
  bytes.writeUInt8(24, header + 14);
  bytes.writeUInt8(1, header + 15);
  bytes.writeUInt32LE(207, header + 16);
  bytes.writeUInt32LE(1, header + 20);
  bytes.writeBigUInt64LE(address(0x2100), header + 24);
  bytes.writeBigUInt64LE(address(0x2105), header + 32);
  bytes.writeUInt32LE(206, header + 40);
  bytes.writeBigUInt64LE(address(0x2300), header + 48);
  bytes.writeBigUInt64LE(address(0x2380), header + 56);
  bytes.writeInt32LE(0x280, 0x700);
  bytes.writeUInt8(0x09, 0x704);

  const writeMethodTable = (
    rva: number,
    flags: number,
    baseSize: number,
    related: bigint,
    slots: readonly bigint[],
  ) => {
    const offset = 0x600 + rva - 0x2000;
    bytes.writeUInt32LE(flags, offset);
    bytes.writeUInt32LE(baseSize, offset + 4);
    bytes.writeBigUInt64LE(related, offset + 8);
    bytes.writeUInt16LE(slots.length, offset + 16);
    bytes.writeUInt16LE(0, offset + 18);
    bytes.writeUInt32LE(0x1234, offset + 20);
    slots.forEach((slot, index) =>
      bytes.writeBigUInt64LE(slot, offset + 24 + index * 8),
    );
  };
  const object = address(0x2200);
  writeMethodTable(0x2200, 0x50000000, 0x18, 0n, [
    address(0x1010),
    address(0x1020),
    address(0x1030),
  ]);
  writeMethodTable(0x2280, 0x50000000, 0x20, object, [address(0x1040)]);
  writeMethodTable(0x22c0, 0x50000000, 0x16, object, []);

  const frozen = 0x600 + 0x2300 - 0x2000;
  bytes.writeBigUInt64LE(address(0x22c0), frozen);
  const value = Buffer.from("REA_NATIVEAOT_FROZEN", "utf16le");
  bytes.writeUInt32LE(value.length / 2, frozen + 8);
  value.copy(bytes, frozen + 12);
  bytes.writeUInt16LE(0, frozen + 12 + value.length);
  return bytes;
};
