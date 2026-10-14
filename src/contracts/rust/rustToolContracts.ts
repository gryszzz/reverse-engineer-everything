import {
  inspectRustBinaryInputSchema,
  rustBinarySchema,
} from "../../domain/rust/rustBinary.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static Rust dependency metadata is independent of active native-analysis providers. */
export const RUST_TOOL_CONTRACTS = [
  {
    name: "inspect_rust_binary",
    ...toolContractMetadata("inspect_rust_binary"),
    kind: "artifact-provider",
    description:
      "Inspect the cargo-auditable crate dependency list embedded in an explicit local ELF, PE or thin Mach-O image. Returns the artifact SHA-256, the .dep-v0 section file offset and size, compressed and uncompressed sizes, format version, packages in their original order, the root package index, and dependency edges by index. Reads zlib-compressed JSON without installing Rust, opening a disassembler, executing the target, writing temporary files or accessing the network. A missing section is null metadata with a limitation and is not proof that the binary has no dependencies. A rustc commit hash is reported only as an inference when a /rustc/<40-hex>/ path is present in read-only data. Resource guards bound files to 256 MiB, dependency sections to 1 MiB, inflated JSON to the smaller of 8 MiB and 64 times the compressed size, and the complete report to 8 MiB. Malformed, unsupported and oversized inputs receive typed failures rather than partial success.",
    inputSchema: inspectRustBinaryInputSchema,
    outputSchema: evidenceResultOf(rustBinarySchema),
    examples: [
      {
        title: "Inspect an embedded Rust dependency list",
        input: { path: "/artifacts/application" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
