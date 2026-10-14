import type {
  BinaryArchitecture,
  ElfFamilyMetadata,
  HeaderArchitecture,
  MipsElfMetadata,
  PeCodeViewRecord,
  RiscvElfMetadata,
  PowerPcElfMetadata,
  UniversalMachOSlice,
} from "./binaryTargetTypes.js";
import { err, ok, type Result } from "./result.js";
import { readElfFixedHeader } from "./elfFixedHeader.js";
import { observeMzWindowsHeader, parseDosMzHeader } from "./dosMz.js";
import { decodePeMachine } from "./peMachine.js";
import {
  classifyFatContainerIdentity,
  readFatContainerHeader,
} from "./apple/machoContainer.js";

/** Format and architecture facts recovered from an executable header. */
export type ExecutableMetadata =
  | {
      readonly format: "elf";
      readonly architecture: "mips";
      readonly availableArchitectures: readonly "mips"[];
      readonly mips: MipsElfMetadata;
    }
  | {
      readonly format: "elf";
      readonly architecture: "riscv";
      readonly availableArchitectures: readonly "riscv"[];
      readonly riscv: RiscvElfMetadata;
    }
  | {
      readonly format: "elf";
      readonly architecture: "powerpc";
      readonly availableArchitectures: readonly "powerpc"[];
      readonly powerpc: PowerPcElfMetadata;
    }
  | {
      readonly format: "mach-o" | "elf" | "dos-mz" | "dos-com";
      readonly architecture: HeaderArchitecture;
      readonly availableArchitectures: readonly HeaderArchitecture[];
      readonly universalSlice?: never;
    }
  | {
      readonly format: "mach-o-universal";
      readonly architecture: HeaderArchitecture;
      readonly availableArchitectures: readonly HeaderArchitecture[];
      readonly universalSlice: UniversalMachOSlice;
    }
  | {
      readonly format: "pe";
      readonly architecture: HeaderArchitecture;
      readonly availableArchitectures: readonly HeaderArchitecture[];
      readonly executableRole:
        | "application"
        | "shared-library"
        | "non-executable";
      readonly managed: boolean;
      readonly codeView?: PeCodeViewRecord;
    };

/**
 * Parse supported executable headers without I/O. The caller supplies the host
 * architecture used for deterministic FAT Mach-O slice selection.
 */
export const parseExecutableHeader = (
  bytes: Buffer,
  hostArchitecture: NodeJS.Architecture,
  fileSize = bytes.length,
  mzWindowsHeaderSignature?: Buffer,
): Result<ExecutableMetadata, string> => {
  if (
    bytes.length >= 4 &&
    bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  )
    return parseElf(bytes, fileSize);
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a)
    return parseMz(bytes, fileSize, mzWindowsHeaderSignature);
  if (bytes.length < 8) return err("truncated or unsupported binary header");
  const magic = bytes.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic))
    return parseThinMachO(bytes, magic, fileSize);
  const fatHeader = readFatContainerHeader(bytes, fileSize);
  if (fatHeader.state !== "not-fat")
    return parseFatMachO(bytes, hostArchitecture, fatHeader);
  return err("unsupported binary format");
};

const parseThinMachO = (
  bytes: Buffer,
  magic: number,
  fileSize: number,
): Result<ExecutableMetadata, string> => {
  const is64 = magic === 0xfeedfacf || magic === 0xcffaedfe;
  const headerSize = is64 ? 32 : 28;
  if (bytes.length < headerSize)
    return err(
      `truncated Mach-O header: a ${is64 ? 64 : 32}-bit header needs ${headerSize} bytes; the file has ${fileSize}`,
    );
  const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const read = (offset: number): number =>
    little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const architecture = machArchitecture(read(4));
  if (architecture === undefined) return err("unsupported Mach-O architecture");
  const commandBytes = read(20);
  if (headerSize + commandBytes > fileSize)
    return err(
      `truncated Mach-O load commands: the header declares ${commandBytes} bytes after its ${headerSize}-byte header; the file has ${fileSize}`,
    );
  return ok({
    format: "mach-o",
    architecture,
    availableArchitectures: [architecture],
  });
};

const parseFatMachO = (
  bytes: Buffer,
  host: NodeJS.Architecture,
  header: Exclude<
    ReturnType<typeof readFatContainerHeader>,
    { state: "not-fat" }
  >,
): Result<ExecutableMetadata, string> => {
  if (header.state === "needs-data")
    return err("truncated or invalid FAT architecture table");
  if (header.state === "malformed") return err(header.reason);
  const identityError = fatIdentityError(bytes, header);
  if (identityError !== null) return err(identityError);
  const architectures: HeaderArchitecture[] = [];
  const slices = new Map<
    HeaderArchitecture,
    { readonly offset: number; readonly size: number }
  >();
  for (const declaration of header.slices) {
    const architecture = machArchitecture(declaration.cpuType);
    if (architecture === undefined || architectures.includes(architecture))
      continue;
    architectures.push(architecture);
    slices.set(architecture, {
      offset: declaration.offset,
      size: declaration.size,
    });
  }
  const preferred = fatHostArchitecture(host);
  const slice = preferred === undefined ? undefined : slices.get(preferred);
  if (preferred === undefined || slice === undefined)
    return err(`FAT binary has no host-compatible ${host} architecture`);
  const minimumHeaderSize =
    preferred === "arm64" || preferred === "x86_64" ? 32 : 28;
  if (slice.size < minimumHeaderSize)
    return err(`FAT slice for ${preferred} is shorter than its Mach-O header`);
  return ok({
    format: "mach-o-universal",
    architecture: preferred,
    availableArchitectures: architectures,
    universalSlice: { offset: slice.offset, size: slice.size },
  });
};

const fatHostArchitecture = (
  host: NodeJS.Architecture,
): HeaderArchitecture | undefined => {
  switch (host) {
    case "arm64":
      return "arm64";
    case "x64":
      return "x86_64";
    case "ia32":
      return "x86";
    case "arm":
      return "arm";
    default:
      return undefined;
  }
};

const fatIdentityError = (
  bytes: Buffer,
  header: Extract<
    ReturnType<typeof readFatContainerHeader>,
    { state: "parsed" }
  >,
): string | null => {
  const identity = classifyFatContainerIdentity(header, (offset) => {
    if (offset >= bytes.length) return undefined;
    if (offset + 4 > bytes.length) return null;
    return bytes.readUInt32BE(offset);
  });
  if (identity.state === "needs-slice-header")
    return "FAT slice identity is outside the bounded prefix";
  if (identity.state === "not-mach-o")
    return "FAT table does not identify a Mach-O image";
  if (identity.state === "malformed") return identity.reason;
  return null;
};

const parseElf = (
  bytes: Buffer,
  fileSize: number,
): Result<ExecutableMetadata, string> => {
  const fixedHeader = readElfFixedHeader(bytes, fileSize);
  if (!fixedHeader.ok) return fixedHeader;
  const { elfClass, byteOrder } = fixedHeader.value;
  const little = byteOrder === "little";
  const machine = little ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18);
  const architecture = elfArchitecture(machine);
  if (architecture === undefined) return err("unsupported ELF architecture");
  if (
    architecture === "mips" ||
    architecture === "riscv" ||
    architecture === "powerpc"
  ) {
    const flagsOffset = elfClass === 32 ? 36 : 48;
    const metadata: ElfFamilyMetadata = {
      elfClass,
      byteOrder: little ? "little" : "big",
      type: little ? bytes.readUInt16LE(16) : bytes.readUInt16BE(16),
      flags: little
        ? bytes.readUInt32LE(flagsOffset)
        : bytes.readUInt32BE(flagsOffset),
    };
    if (architecture === "powerpc")
      return ok({
        format: "elf",
        architecture,
        availableArchitectures: [architecture],
        powerpc: metadata,
      });
    return architecture === "mips"
      ? ok({
          format: "elf",
          architecture,
          availableArchitectures: [architecture],
          mips: metadata,
        })
      : ok({
          format: "elf",
          architecture,
          availableArchitectures: [architecture],
          riscv: metadata,
        });
  }
  return ok({
    format: "elf",
    architecture,
    availableArchitectures: [architecture],
  });
};

const parseMz = (
  bytes: Buffer,
  fileSize: number,
  signatureAtOffset?: Buffer,
): Result<ExecutableMetadata, string> => {
  const windowsHeader = observeMzWindowsHeader(
    bytes,
    fileSize,
    signatureAtOffset,
  );
  if (
    windowsHeader.state === "header-needed" ||
    windowsHeader.state === "signature-needed"
  )
    return err(
      "Windows new-header pointer or signature is outside the bounded prefix",
    );
  if (windowsHeader.state === "declared") {
    const { offset } = windowsHeader;
    if (offset < 64 || offset > bytes.length - 24)
      return err("invalid or truncated Windows executable header in MZ image");
    if (["NE", "LE", "LX"].includes(windowsHeader.signature))
      return err(
        `unsupported ${windowsHeader.signature} executable in MZ image`,
      );
    if (windowsHeader.signature !== "PE")
      return err("invalid or truncated Windows executable header in MZ image");
    const codeView = parsePeCodeViewFromBuffer(bytes, offset);
    return parsePeRecord(bytes.subarray(offset), codeView);
  }
  const parsed = parseDosMzHeader(bytes, fileSize, signatureAtOffset);
  return parsed.ok
    ? ok({
        format: "dos-mz",
        architecture: "x86",
        availableArchitectures: ["x86"],
      })
    : parsed;
};

/** Parse a bounded PE signature, COFF record, and optional header without I/O. */
export const parsePeRecord = (
  record: Buffer,
  codeView: PeCodeViewRecord | undefined,
): Result<ExecutableMetadata, string> => {
  if (
    record.length < 24 ||
    record.toString("binary", 0, 4) !== "PE\u0000\u0000"
  )
    return err("invalid or truncated PE header");
  const machineType = record.readUInt16LE(4);
  const machine = decodePeMachine(machineType);
  if (machine === undefined)
    return err(
      `unsupported PE architecture (COFF machine 0x${machineType.toString(16).padStart(4, "0")})`,
    );
  const { architecture } = machine;
  const optionalHeaderSize = record.readUInt16LE(20);
  if (optionalHeaderSize > 4096 || record.length < 24 + optionalHeaderSize)
    return err("invalid or truncated PE optional header");
  const optionalHeader = record.subarray(24, 24 + optionalHeaderSize);
  const managed = peManagedStatus(optionalHeader, architecture);
  if (!managed.ok) return managed;
  if (machine.nativeOsOverride && !managed.value)
    return err("unsupported PE architecture");
  const characteristics = record.readUInt16LE(22);
  return ok({
    format: "pe",
    architecture,
    availableArchitectures: [architecture],
    executableRole:
      (characteristics & 0x0002) === 0
        ? "non-executable"
        : (characteristics & 0x2000) === 0
          ? "application"
          : "shared-library",
    managed: managed.value,
    ...(codeView !== undefined ? { codeView } : {}),
  });
};

/** Parse CodeView record data (RSDS or NB10) from raw data bytes. */
export const parseCodeViewData = (
  buffer: Buffer,
  sizeOfData: number,
): PeCodeViewRecord | undefined => {
  if (sizeOfData < 16 || buffer.length < 16) return undefined;
  const magic = buffer.subarray(0, 4).toString("binary");
  const pathOffset = magic === "RSDS" ? 24 : magic === "NB10" ? 16 : undefined;
  if (
    pathOffset === undefined ||
    sizeOfData <= pathOffset ||
    buffer.length <= pathOffset
  )
    return undefined;
  const end = buffer.indexOf(0, pathOffset);
  if (end <= pathOffset || end >= sizeOfData) return undefined;
  const pdbPath = buffer.toString("utf8", pathOffset, end);
  const pdbFileName = pdbPath.split(/[/\\]/u).pop() ?? pdbPath;
  if (magic === "RSDS" && sizeOfData >= 24 && buffer.length >= 24) {
    const part1 = buffer.readUInt32LE(4).toString(16).padStart(8, "0");
    const part2 = buffer.readUInt16LE(8).toString(16).padStart(4, "0");
    const part3 = buffer.readUInt16LE(10).toString(16).padStart(4, "0");
    const part4 = buffer.subarray(12, 14).toString("hex");
    const part5 = buffer.subarray(14, 20).toString("hex");
    const guid = `${part1}-${part2}-${part3}-${part4}-${part5}`;
    const age = buffer.readUInt32LE(20);
    return { pdbPath, pdbFileName, guid, age };
  }
  if (magic === "NB10") {
    const age = buffer.readUInt32LE(12);
    return { pdbPath, pdbFileName, guid: null, age };
  }
  return undefined;
};

/** Locate the debug directory RVA and size from a PE optional header. */
export const peDebugDirectoryEntry = (
  optionalHeader: Buffer,
):
  | {
      readonly debugRva: number;
      readonly debugSize: number;
      readonly sizeOfHeaders: number;
    }
  | undefined => {
  if (optionalHeader.length < 2) return undefined;
  const magic = optionalHeader.readUInt16LE(0);
  if (magic !== 0x10b && magic !== 0x20b) return undefined;
  const directoryOffset = magic === 0x20b ? 112 : 96;
  const directoryCountOffset = directoryOffset - 4;
  if (optionalHeader.length < directoryCountOffset + 4) return undefined;
  const directoryCount = optionalHeader.readUInt32LE(directoryCountOffset);
  if (directoryCount <= 6) return undefined;
  const debugEntryOffset = directoryOffset + 6 * 8;
  if (optionalHeader.length < debugEntryOffset + 8) return undefined;
  const debugRva = optionalHeader.readUInt32LE(debugEntryOffset);
  const debugSize = optionalHeader.readUInt32LE(debugEntryOffset + 4);
  if (debugRva === 0 || debugSize < 28) return undefined;
  return {
    debugRva,
    debugSize,
    sizeOfHeaders: optionalHeader.readUInt32LE(60),
  };
};

/** Translate an RVA to an absolute file offset using the PE section table. */
export const peRvaToFileOffset = (
  rva: number,
  sectionTable: Buffer,
  numberOfSections: number,
  sizeOfHeaders: number,
  size = 1,
): number | undefined => {
  if (rva < sizeOfHeaders && size <= sizeOfHeaders - rva) return rva;
  for (let i = 0; i < numberOfSections; i++) {
    const offset = i * 40;
    if (sectionTable.length < offset + 40) break;
    const virtualAddress = sectionTable.readUInt32LE(offset + 12);
    const sizeOfRawData = sectionTable.readUInt32LE(offset + 16);
    const pointerToRawData = sectionTable.readUInt32LE(offset + 20);
    if (
      pointerToRawData > 0 &&
      rva >= virtualAddress &&
      rva - virtualAddress < sizeOfRawData &&
      size <= sizeOfRawData - (rva - virtualAddress)
    ) {
      return pointerToRawData + (rva - virtualAddress);
    }
  }
  return undefined;
};

/** Parse CodeView metadata from a bounded in-memory PE image buffer. */
export const parsePeCodeViewFromBuffer = (
  fileBytes: Buffer,
  peOffset: number,
): PeCodeViewRecord | undefined => {
  if (fileBytes.length < peOffset + 24) return undefined;
  const numberOfSections = fileBytes.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = fileBytes.readUInt16LE(peOffset + 20);
  if (
    optionalHeaderSize > 4096 ||
    fileBytes.length < peOffset + 24 + optionalHeaderSize
  )
    return undefined;
  const optionalHeader = fileBytes.subarray(
    peOffset + 24,
    peOffset + 24 + optionalHeaderSize,
  );
  const debugDir = peDebugDirectoryEntry(optionalHeader);
  if (debugDir === undefined) return undefined;
  const sectionTableOffset = peOffset + 24 + optionalHeaderSize;
  const sectionTableSize = numberOfSections * 40;
  if (fileBytes.length < sectionTableOffset + sectionTableSize)
    return undefined;
  const sectionTable = fileBytes.subarray(
    sectionTableOffset,
    sectionTableOffset + sectionTableSize,
  );
  const debugFileOffset = peRvaToFileOffset(
    debugDir.debugRva,
    sectionTable,
    numberOfSections,
    debugDir.sizeOfHeaders,
    Math.min(debugDir.debugSize, 4096),
  );
  if (debugFileOffset === undefined || fileBytes.length < debugFileOffset + 28)
    return undefined;
  const maxDebugBytes = Math.min(
    debugDir.debugSize,
    fileBytes.length - debugFileOffset,
  );
  const numEntries = Math.floor(maxDebugBytes / 28);
  for (let j = 0; j < numEntries; j++) {
    const entryOffset = debugFileOffset + j * 28;
    const type = fileBytes.readUInt32LE(entryOffset + 12);
    if (type !== 2) continue; // IMAGE_DEBUG_TYPE_CODEVIEW
    const sizeOfData = fileBytes.readUInt32LE(entryOffset + 16);
    let pointerToRawData = fileBytes.readUInt32LE(entryOffset + 24);
    if (pointerToRawData === 0) {
      const addressOfRawData = fileBytes.readUInt32LE(entryOffset + 20);
      const mapped = peRvaToFileOffset(
        addressOfRawData,
        sectionTable,
        numberOfSections,
        debugDir.sizeOfHeaders,
        Math.min(sizeOfData, 4096),
      );
      if (mapped === undefined) continue;
      pointerToRawData = mapped;
    }
    if (
      sizeOfData < 16 ||
      fileBytes.length < pointerToRawData + Math.min(sizeOfData, 24)
    )
      continue;
    const codeViewData = fileBytes.subarray(
      pointerToRawData,
      Math.min(fileBytes.length, pointerToRawData + sizeOfData),
    );
    const parsed = parseCodeViewData(codeViewData, sizeOfData);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const peManagedStatus = (
  optionalHeader: Buffer,
  architecture: BinaryArchitecture,
): Result<boolean, string> => {
  if (optionalHeader.length < 2) return err("truncated PE optional header");
  const magic = optionalHeader.readUInt16LE(0);
  const expectedMagic =
    architecture === "x86_64" || architecture === "arm64" ? 0x20b : 0x10b;
  if (magic !== expectedMagic)
    return err("PE optional-header magic does not match its architecture");
  const directoryOffset = magic === 0x20b ? 112 : 96;
  const directoryCountOffset = directoryOffset - 4;
  if (optionalHeader.length < directoryCountOffset + 4)
    return err("truncated PE optional header");
  const directoryCount = optionalHeader.readUInt32LE(directoryCountOffset);
  const requiredBytes = directoryOffset + directoryCount * 8;
  if (
    !Number.isSafeInteger(requiredBytes) ||
    requiredBytes > optionalHeader.length
  )
    return err("truncated PE data-directory table");
  if (directoryCount <= 14) return ok(false);
  const cliDirectory = directoryOffset + 14 * 8;
  return ok(
    optionalHeader.readUInt32LE(cliDirectory) !== 0 ||
      optionalHeader.readUInt32LE(cliDirectory + 4) !== 0,
  );
};

const machArchitecture = (cpu: number): HeaderArchitecture | undefined => {
  switch (cpu) {
    case 7:
      return "x86";
    case 0x01000007:
      return "x86_64";
    case 12:
      return "arm";
    case 0x0100000c:
      return "arm64";
  }
  return undefined;
};

const elfArchitecture = (
  machine: number,
): Exclude<BinaryArchitecture, "6502"> | undefined => {
  switch (machine) {
    case 3:
      return "x86";
    case 62:
      return "x86_64";
    case 8: // EM_MIPS: ISA, ABI and byte order remain separate ELF facts.
      return "mips";
    case 20: // EM_PPC; byte order and processor variant remain ELF declarations.
      return "powerpc";
    case 40:
      return "arm";
    case 183:
      return "arm64";
    case 243: // EM_RISCV: XLEN, byte order and e_flags remain separate ELF facts.
      return "riscv";
  }
  return undefined;
};
