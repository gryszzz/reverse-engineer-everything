import type { BinaryTarget } from "../domain/binaryTargetTypes.js";

/**
 * Report unapplied PE companion PDB symbols when CodeView debug information is present.
 *
 * Ghidra does not automatically locate or apply sidecar PDBs in REA's isolated
 * runtime directories without companion admission. When the PE target header
 * references debug symbols, surface this limitation so callers understand that
 * procedure names remain analysis-generated.
 */
export const ghidraPeCodeViewLimitations = (
  target: BinaryTarget,
  pdbLoaded = false,
): readonly string[] => {
  if (target.format !== "pe" || target.codeView === undefined || pdbLoaded) {
    return [];
  }
  const { pdbFileName, guid, age } = target.codeView;
  return [
    guid !== null
      ? `The target references debug symbols "${pdbFileName}" (GUID ${guid}, age ${age}) that were not applied; procedure names are analysis-generated.`
      : `The target references debug symbols "${pdbFileName}" (age ${age}) that were not applied; procedure names are analysis-generated.`,
  ];
};
