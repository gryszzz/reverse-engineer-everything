import { deflateSync } from "node:zlib";

/** zlib payload matching the embedded dependency JSON shape. */
export const rustDependencyPayload = (
  document: unknown = {
    packages: [
      { name: "itoa", version: "1.0.18", source: "crates.io" },
      {
        name: "sample",
        version: "0.1.0",
        source: "local",
        dependencies: [0],
        root: true,
      },
    ],
    format: 1,
  },
): Buffer => deflateSync(Buffer.from(JSON.stringify(document)));

export const RUSTC_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RUSTC_PATH = `/rustc/${RUSTC_HASH}/library/core`;

/** Synthetic ELF, PE, or thin Mach-O with an optional dependency section. */
export const createRustImage = (options: {
  readonly format: "elf" | "pe" | "macho";
  readonly payload?: Buffer;
  readonly omitSection?: boolean;
  readonly includeRustc?: boolean;
}): Buffer => {
  const payload = options.payload ?? rustDependencyPayload();
  const rustc = options.includeRustc === false ? null : Buffer.from(RUSTC_PATH);
  const bytes = Buffer.alloc(4096);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = (offset: number, value: number, width: 16 | 32 | 64) => {
    if (width === 16) view.setUint16(offset, value, true);
    else if (width === 32) view.setUint32(offset, value, true);
    else view.setBigUint64(offset, BigInt(value), true);
  };
  const image = {
    bytes,
    little,
    payload,
    omitSection: options.omitSection === true,
    rustc,
  };
  if (options.format === "elf") writeElf(image);
  else if (options.format === "pe") writePe(image);
  else writeMacho(image);
  return bytes;
};

interface RustImageWrite {
  readonly bytes: Buffer;
  readonly little: (offset: number, value: number, width: 16 | 32 | 64) => void;
  readonly payload: Buffer;
  readonly omitSection: boolean;
  readonly rustc: Buffer | null;
}

const writeElf = ({
  bytes,
  little,
  payload,
  omitSection,
  rustc,
}: RustImageWrite): void => {
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  little(16, 2, 16);
  little(18, 62, 16);
  little(20, 1, 32);
  little(32, 128, 64);
  little(40, 256, 64);
  little(52, 64, 16);
  little(54, 56, 16);
  little(56, 1, 16);
  little(58, 64, 16);
  const names = omitSection
    ? Buffer.from("\0.shstrtab\0.rodata\0")
    : Buffer.from("\0.shstrtab\0.dep-v0\0.rodata\0");
  little(60, rustc === null && omitSection ? 0 : omitSection ? 3 : 4, 16);
  little(62, rustc === null && omitSection ? 0 : 1, 16);
  little(128, 1, 32);
  little(132, 6, 32);
  little(144, 0x400000, 64);
  little(160, bytes.length, 64);
  little(168, bytes.length, 64);
  if (rustc === null && omitSection) return;
  names.copy(bytes, 768);
  const shstr = 320;
  little(shstr, 1, 32);
  little(shstr + 4, 3, 32);
  little(shstr + 24, 768, 64);
  little(shstr + 32, names.length, 64);
  let next = 384;
  if (!omitSection) {
    little(next, 11, 32);
    little(next + 4, 1, 32);
    little(next + 24, 1024, 64);
    little(next + 32, payload.length, 64);
    payload.copy(bytes, 1024);
    next += 64;
  }
  if (rustc !== null) {
    const name = omitSection ? 11 : 19;
    little(next, name, 32);
    little(next + 4, 1, 32);
    little(next + 8, 2, 64);
    little(next + 16, 0x400000 + 2048, 64);
    little(next + 24, 2048, 64);
    little(next + 32, rustc.length, 64);
    rustc.copy(bytes, 2048);
  }
};

const writePe = ({
  bytes,
  little,
  payload,
  omitSection,
  rustc,
}: RustImageWrite): void => {
  bytes.write("MZ", 0, "ascii");
  little(60, 128, 32);
  bytes.write("PE\0\0", 128, "ascii");
  little(132, 0x8664, 16);
  const count = Number(!omitSection) + Number(rustc !== null);
  little(134, count, 16);
  little(148, 112, 16);
  little(152, 0x20b, 16);
  little(176, 0x140000000, 64);
  const writeSection = (section: {
    readonly entry: number;
    readonly name: string;
    readonly offset: number;
    readonly body: Buffer;
    readonly address: number;
  }) => {
    bytes.write(section.name, section.entry, "ascii");
    little(section.entry + 8, section.body.length, 32);
    little(section.entry + 12, section.address, 32);
    little(section.entry + 16, section.body.length, 32);
    little(section.entry + 20, section.offset, 32);
    little(section.entry + 36, 0x40000040, 32);
    section.body.copy(bytes, section.offset);
  };
  let entry = 264;
  if (!omitSection) {
    writeSection({
      entry,
      name: ".dep-v0",
      offset: 1024,
      body: payload,
      address: 0x1000,
    });
    entry += 40;
  }
  if (rustc !== null)
    writeSection({
      entry,
      name: ".rdata",
      offset: 2048,
      body: rustc,
      address: 0x2000,
    });
};

const writeMacho = ({
  bytes,
  little,
  payload,
  omitSection,
  rustc,
}: RustImageWrite): void => {
  const commands = Number(rustc !== null) + Number(!omitSection);
  little(0, 0xfeedfacf, 32);
  little(4, 0x0100000c, 32);
  little(12, 2, 32);
  little(16, commands, 32);
  little(20, commands * 152, 32);
  let command = 32;
  if (rustc !== null) {
    writeMachoSegment({
      bytes,
      little,
      command,
      segment: "__TEXT",
      section: "__cstring",
      body: rustc,
      fileOffset: 2048,
      protection: 5,
      flags: 2,
    });
    command += 152;
  }
  if (!omitSection)
    writeMachoSegment({
      bytes,
      little,
      command,
      segment: "__DATA",
      section: ".dep-v0",
      body: payload,
      fileOffset: 1024,
      protection: 3,
      flags: 0,
    });
};

const writeMachoSegment = ({
  bytes,
  little,
  command,
  segment,
  section,
  body,
  fileOffset,
  protection,
  flags,
}: {
  readonly bytes: Buffer;
  readonly little: RustImageWrite["little"];
  readonly command: number;
  readonly segment: string;
  readonly section: string;
  readonly body: Buffer;
  readonly fileOffset: number;
  readonly protection: number;
  readonly flags: number;
}): void => {
  little(command, 0x19, 32);
  little(command + 4, 152, 32);
  bytes.write(segment, command + 8, "ascii");
  little(command + 24, 0x100000000, 64);
  little(command + 32, 0x2000, 64);
  little(command + 40, fileOffset, 64);
  little(command + 48, body.length, 64);
  little(command + 56, protection, 32);
  little(command + 60, protection, 32);
  little(command + 64, 1, 32);
  const header = command + 72;
  bytes.write(section, header, "ascii");
  bytes.write(segment, header + 16, "ascii");
  little(header + 32, 0x100000000, 64);
  little(header + 40, body.length, 64);
  little(header + 48, fileOffset, 32);
  little(header + 64, flags, 32);
  body.copy(bytes, fileOffset);
};

/** Read-only ELF data exceeding the distinct rustc-hash retention capacity. */
export const createRustHashOverflowImage = (): Buffer => {
  const bytes = createRustImage({ format: "elf", omitSection: true });
  // Without .dep-v0 the read-only section header is the second one, at 384.
  // Section names end before byte 800, so the hash block starts there.
  bytes.writeBigUInt64LE(800n, 384 + 24);
  bytes.writeBigUInt64LE(3296n, 384 + 32);
  bytes.fill(0, 800);
  for (let index = 0; index < 65; index += 1) {
    const hash = index.toString(16).padStart(40, "0");
    bytes.write(`/rustc/${hash}/`, 800 + index * 48, "latin1");
  }
  return bytes;
};
