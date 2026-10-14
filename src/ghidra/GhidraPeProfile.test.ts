import { describe, expect, it } from "vitest";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { ghidraPeCodeViewLimitations } from "./GhidraPeProfile.js";

describe("ghidraPeCodeViewLimitations", () => {
  it("returns empty limitations for non-PE targets", () => {
    const elfTarget: BinaryTarget = {
      path: "/test/file",
      sha256: "abc",
      kind: "executable",
      format: "elf",
      architecture: "x86_64",
      availableArchitectures: ["x86_64"],
    };
    expect(ghidraPeCodeViewLimitations(elfTarget)).toEqual([]);
  });

  it("does not claim CodeView symbols were unapplied when the session loaded a PDB", () => {
    const peTarget: BinaryTarget = {
      path: "/test/file.exe",
      sha256: "abc",
      kind: "executable",
      architecture: "x86_64",
      availableArchitectures: ["x86_64"],
      executableRole: "application",
      managed: false,
      format: "pe",
      codeView: {
        pdbPath: "C:\\symbols.pdb",
        pdbFileName: "symbols.pdb",
        guid: "12345678-1234-1234-1234-123456789abc",
        age: 1,
      },
    };
    expect(ghidraPeCodeViewLimitations(peTarget, true)).toEqual([]);
  });

  it("returns empty limitations for PE target without codeView", () => {
    const peTarget: BinaryTarget = {
      path: "/test/file.exe",
      sha256: "def",
      kind: "executable",
      format: "pe",
      architecture: "x86_64",
      availableArchitectures: ["x86_64"],
      executableRole: "application",
      managed: false,
    };
    expect(ghidraPeCodeViewLimitations(peTarget)).toEqual([]);
  });

  it("returns limitation with GUID and age for RSDS CodeView records", () => {
    const peTarget: BinaryTarget = {
      path: "/test/file.exe",
      sha256: "def",
      kind: "executable",
      format: "pe",
      architecture: "x86_64",
      availableArchitectures: ["x86_64"],
      executableRole: "application",
      managed: false,
      codeView: {
        pdbPath: "C:\\build\\app.pdb",
        pdbFileName: "app.pdb",
        guid: "01234567-89ab-cdef-0123-456789abcdef",
        age: 1,
      },
    };
    expect(ghidraPeCodeViewLimitations(peTarget)).toEqual([
      'The target references debug symbols "app.pdb" (GUID 01234567-89ab-cdef-0123-456789abcdef, age 1) that were not applied; procedure names are analysis-generated.',
    ]);
  });

  it("returns limitation without GUID for NB10 CodeView records", () => {
    const peTarget: BinaryTarget = {
      path: "/test/file.exe",
      sha256: "def",
      kind: "executable",
      format: "pe",
      architecture: "x86",
      availableArchitectures: ["x86"],
      executableRole: "application",
      managed: false,
      codeView: {
        pdbPath: "D:\\test\\legacy.pdb",
        pdbFileName: "legacy.pdb",
        guid: null,
        age: 2,
      },
    };
    expect(ghidraPeCodeViewLimitations(peTarget)).toEqual([
      'The target references debug symbols "legacy.pdb" (age 2) that were not applied; procedure names are analysis-generated.',
    ]);
  });
});
