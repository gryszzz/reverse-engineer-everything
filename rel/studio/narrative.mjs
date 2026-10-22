function say(statements, evidenceId, text, path) {
  statements.push({ text, evidence_id: evidenceId, path });
}

function strings(value, limit = 12) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string").slice(0, limit);
}

function itemsOf(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  return null;
}

function addLimitations(unknowns, record, result) {
  for (const source of [record?.limitations, result?.limitations]) {
    for (const item of strings(source, 20))
      if (!unknowns.includes(item)) unknowns.push(item);
  }
}

function narratePe(statements, unknowns, evidenceId, result) {
  if (!result || typeof result !== "object") {
    unknowns.push("PE resource result was not an object.");
    return;
  }
  if (typeof result.format === "string" && result.artifact?.bytes)
    say(
      statements,
      evidenceId,
      `This is a ${result.format} image of ${result.artifact.bytes} bytes.`,
      "normalized_result.format",
    );
  if (result.artifact?.sha256)
    say(
      statements,
      evidenceId,
      `SHA-256 ${result.artifact.sha256}.`,
      "normalized_result.artifact.sha256",
    );
  if (result.coverage)
    say(
      statements,
      evidenceId,
      `Resource coverage is ${result.coverage.status}: ${result.coverage.examined_entries} entries examined, ${result.coverage.resources} resources recorded.`,
      "normalized_result.coverage",
    );
  const groups = Array.isArray(result.icon_groups) ? result.icon_groups : [];
  say(
    statements,
    evidenceId,
    `${groups.length} icon group${groups.length === 1 ? "" : "s"} recorded.`,
    "normalized_result.icon_groups",
  );
  unknowns.push(
    "Entry points, imports, and executable behavior are not part of this PE resource inspection.",
  );
}

function narrateEvm(statements, unknowns, evidenceId, result) {
  if (!result || typeof result !== "object") {
    unknowns.push("EVM interface result was not an object.");
    return;
  }
  say(
    statements,
    evidenceId,
    `Bytecode carrier is ${result.artifact?.encoding ?? "unrecorded"} encoding, ${result.bytecode?.bytes ?? "unrecorded"} bytes. Evidence kind is ${result.evidence_kind ?? "unrecorded"}.`,
    "normalized_result.bytecode",
  );
  const functions = Array.isArray(result.functions) ? result.functions : [];
  if (functions.length === 0)
    say(
      statements,
      evidenceId,
      "No function selectors were reported.",
      "normalized_result.functions",
    );
  for (const [index, fn] of functions.slice(0, 12).entries())
    say(
      statements,
      evidenceId,
      `Inferred selector ${fn.selector} at bytecode offset ${fn.bytecode_offset}, dispatch ${fn.dispatch}.`,
      `normalized_result.functions[${index}]`,
    );
  say(
    statements,
    evidenceId,
    `Discovery completeness is ${result.discovery_completeness}. Runtime execution is ${result.runtime_execution}. Deployment authenticity is ${result.bytecode?.deployment_authenticity}. Hardfork is ${result.bytecode?.hardfork}.`,
    "normalized_result.discovery_completeness",
  );
  if (result.discovery_completeness === "unknown")
    unknowns.push("Function discovery completeness is unknown.");
  if (result.runtime_execution === "not-performed")
    unknowns.push("The bytecode was not executed.");
}

function narrateWasm(statements, unknowns, evidenceId, result) {
  if (!result || typeof result !== "object") {
    unknowns.push("WebAssembly result was not an object.");
    return;
  }
  const sections = Array.isArray(result.sections) ? result.sections : [];
  const kinds = [
    ...new Set(sections.map((section) => section.kind).filter(Boolean)),
  ];
  say(
    statements,
    evidenceId,
    `Validation is ${result.validation}. ${sections.length} sections${kinds.length ? `: ${kinds.slice(0, 8).join(", ")}` : ""}.`,
    "normalized_result.sections",
  );
  const exports = strings(result.exports);
  const imports = strings(result.imports);
  say(
    statements,
    evidenceId,
    exports.length
      ? `Exports: ${exports.join(", ")}.`
      : "No exports were reported.",
    "normalized_result.exports",
  );
  say(
    statements,
    evidenceId,
    imports.length
      ? `Imports: ${imports.join(", ")}.`
      : "No imports were reported.",
    "normalized_result.imports",
  );
  if (result.tool_profile?.release)
    say(
      statements,
      evidenceId,
      `WABT profile ${result.tool_profile.release}.`,
      "normalized_result.tool_profile.release",
    );
  if (exports.length === 0)
    unknowns.push("No export was reported to treat as an entry point.");
}

function narrateAndroid(statements, unknowns, evidenceId, result) {
  if (!result || typeof result !== "object") {
    unknowns.push("Android package result was not an object.");
    return;
  }
  say(
    statements,
    evidenceId,
    `Package ${result.package_name ?? "unrecorded"}, version ${result.version_name ?? "unrecorded"} (${result.version_code ?? "unrecorded"}).`,
    "normalized_result.package_name",
  );
  say(
    statements,
    evidenceId,
    `${result.class_count ?? "unrecorded"} classes and ${result.resource_count ?? "unrecorded"} resources. ${Array.isArray(result.permissions) ? result.permissions.length : "unrecorded"} permissions. Signature verification: ${result.signature_verification}.`,
    "normalized_result.class_count",
  );
  if (result.package_name == null)
    unknowns.push("Package name was not recorded.");
  if (result.signature_verification === "not_performed")
    unknowns.push("Signature verification was not performed.");
}

function narrateApktool(statements, unknowns, evidenceId, result) {
  if (!result || typeof result !== "object") {
    unknowns.push("Apktool result was not an object.");
    return;
  }
  const meta = result.metadata ?? {};
  say(
    statements,
    evidenceId,
    `Decoded package ${meta.package_name ?? "unrecorded"}, version ${meta.version_name ?? "unrecorded"}. ${result.decoded_file_count ?? "unrecorded"} files. Coverage ${result.coverage}.`,
    "normalized_result.metadata",
  );
  const locales = strings(result.locales);
  say(
    statements,
    evidenceId,
    locales.length
      ? `Locales: ${locales.join(", ")}.`
      : "No locales were reported.",
    "normalized_result.locales",
  );
  if (result.manifest == null)
    unknowns.push("The manifest text was not recorded.");
}

function narrateObjdump(statements, unknowns, evidenceId, result) {
  if (!result || typeof result !== "object") {
    unknowns.push("objdump result was not an object.");
    return;
  }
  say(
    statements,
    evidenceId,
    `objdump file_headers completion ${result.completion_status}, exit ${result.exit_code}. Artifact changed: ${result.artifact_changed}.`,
    "normalized_result.completion_status",
  );
  if (typeof result.stdout === "string" && result.stdout.trim() !== "")
    say(
      statements,
      evidenceId,
      `Raw file-header output begins: ${result.stdout.trim().slice(0, 400)}`,
      "normalized_result.stdout",
    );
  unknowns.push(
    "REA does not parse this objdump stdout into imports, dependencies, or entry points.",
  );
  if (result.completion_status === "unknown")
    unknowns.push("objdump completion status is unknown.");
}

function narrateLayout(statements, unknowns, evidenceId, result) {
  if (!result || typeof result !== "object") {
    unknowns.push("ELF layout result was not an object.");
    return;
  }
  say(
    statements,
    evidenceId,
    `ELF ${result.image_type}, machine ${result.architecture?.machine}.`,
    "normalized_result.image_type",
  );
  if (result.entry_point)
    say(
      statements,
      evidenceId,
      `Entry point ${result.entry_point.reported_value} means ${result.entry_point.meaning}. Execution status ${result.entry_point.execution_status}.`,
      "normalized_result.entry_point",
    );
  const libraries = strings(result.linkage?.needed_libraries);
  say(
    statements,
    evidenceId,
    `${Array.isArray(result.segments) ? result.segments.length : "unrecorded"} segments. Needed libraries: ${libraries.length ? libraries.join(", ") : "none reported"}.`,
    "normalized_result.linkage.needed_libraries",
  );
  if (result.entry_point?.execution_status === "unknown")
    unknowns.push("Whether that entry point runs is unknown.");
  if (result.runtime_load_base == null)
    unknowns.push("Runtime load base was not recorded.");
  if (result.relocation_inventory_completeness === "unknown")
    unknowns.push("Relocation inventory completeness is unknown.");
}

function narrateMacho(statements, unknowns, evidenceId, result) {
  if (!result || typeof result !== "object") {
    unknowns.push("Mach-O result was not an object.");
    return;
  }
  say(
    statements,
    evidenceId,
    `Mach-O file type ${result.file_type ?? "unrecorded"}, word size ${result.word_size ?? "unrecorded"}, endian ${result.endian ?? "unrecorded"}.`,
    "normalized_result.file_type",
  );
  const entries = itemsOf(result.entrypoints);
  say(
    statements,
    evidenceId,
    entries
      ? `${entries.length} entry points recorded${result.entrypoints.exhaustive === false ? ", not exhaustive" : ""}.`
      : "Entry-point collection was not recorded.",
    "normalized_result.entrypoints",
  );
  const dependencies = itemsOf(result.dependencies) ?? [];
  const names = dependencies
    .map((item) => item?.path)
    .filter((item) => typeof item === "string")
    .slice(0, 12);
  say(
    statements,
    evidenceId,
    names.length
      ? `Dependencies: ${names.join(", ")}.`
      : "No dependencies were reported.",
    "normalized_result.dependencies",
  );
  if (result.entrypoints?.exhaustive === false)
    unknowns.push("The Mach-O entry-point collection is not exhaustive.");
}

function narrateGeneric(statements, unknowns, evidenceId, record, result) {
  const format = record?.subject?.format;
  if (typeof format === "string")
    say(statements, evidenceId, `Subject format ${format}.`, "subject.format");
  if (
    result &&
    typeof result === "object" &&
    Array.isArray(result.graph?.nodes) &&
    Array.isArray(result.graph?.edges)
  )
    say(
      statements,
      evidenceId,
      `Application graph stores ${result.graph.nodes.length} nodes and ${result.graph.edges.length} edges.`,
      "normalized_result.graph",
    );
  else
    unknowns.push(
      "No application relationship graph is stored on this Evidence record.",
    );
}

/** Plain-English lines that quote only fields present on one Evidence record. */
export function narrateEvidence(record) {
  const statements = [];
  const unknowns = [];
  const evidenceId =
    typeof record?.evidence_id === "string" ? record.evidence_id : null;
  if (!evidenceId) {
    unknowns.push("The engine result has no Evidence id.");
    return { statements, unknowns, limitations: [] };
  }
  const provider = record.provider;
  if (provider?.id && provider?.name)
    say(
      statements,
      evidenceId,
      `Recorded by ${provider.name} (${provider.id}${provider.version ? `, ${provider.version}` : ""}).`,
      "provider",
    );
  else unknowns.push("Provider identity is missing on this Evidence record.");
  if (typeof record.operation === "string")
    say(statements, evidenceId, `Operation ${record.operation}.`, "operation");
  const result = record.normalized_result;
  const op = record.operation;
  if (op === "inspect_pe_resources")
    narratePe(statements, unknowns, evidenceId, result);
  else if (op === "inspect_evm_interface")
    narrateEvm(statements, unknowns, evidenceId, result);
  else if (op === "inspect_wasm_artifact")
    narrateWasm(statements, unknowns, evidenceId, result);
  else if (op === "inspect_android_package")
    narrateAndroid(statements, unknowns, evidenceId, result);
  else if (op === "decode_android_resources")
    narrateApktool(statements, unknowns, evidenceId, result);
  else if (op === "inspect_with_objdump")
    narrateObjdump(statements, unknowns, evidenceId, result);
  else if (op === "inspect_binary_layout")
    narrateLayout(statements, unknowns, evidenceId, result);
  else if (op === "inspect_macho")
    narrateMacho(statements, unknowns, evidenceId, result);
  else narrateGeneric(statements, unknowns, evidenceId, record, result);
  const limitations = strings(record.limitations, 20);
  addLimitations(unknowns, record, result);
  return { statements, unknowns, limitations };
}

/** Lines for a JavaScript run whose summary.json is already stored. */
export function narrateJavascriptSummary(summary, evidenceId) {
  const statements = [];
  const counts = summary?.counts;
  if (counts && evidenceId)
    statements.push({
      text: `Static JavaScript analysis recorded ${counts.nodes} nodes and ${counts.edges} edges.`,
      evidence_id: evidenceId,
      path: "summary.counts",
    });
  return {
    statements,
    unknowns: strings(summary?.unknowns, 12),
    limitations: strings(summary?.limitations, 12),
  };
}
