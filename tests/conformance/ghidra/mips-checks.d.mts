import type { MipsElfMetadata } from "../../../src/domain/binaryTargetTypes.js";

export type MipsFloatAbi = "hard" | "soft";
export interface MipsReadelfFacts {
  mips: MipsElfMetadata;
  symbols: Record<string, string>;
}
export function parseMipsReadelf(
  text: string,
  byteOrder: string,
  floatAbi?: MipsFloatAbi,
  objectType?: "exec" | "rel",
): MipsReadelfFacts;
export function inspectMipsReadelf(
  path: string,
  byteOrder: string,
  floatAbi?: MipsFloatAbi,
): Promise<
  MipsReadelfFacts & { command: string; version: string; raw: string }
>;
export function assertMipsLoadedImage(
  observations: unknown,
  byteOrder: string,
  sha256: string,
): void;
export function assertMipsProbe(
  move: unknown,
  branch: unknown,
  byteOrder: string,
  address: string,
): void;
export function assertMipsGlobal(bytes: string, byteOrder: string): void;
export function assertMipsSoftFloatStorage(
  boundaries: Record<string, unknown>,
  byteOrder: string,
): void;
