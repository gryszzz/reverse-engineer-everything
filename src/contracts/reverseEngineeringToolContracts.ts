import { z } from "zod";

import {
  objdumpInputSchema,
  rizinInputSchema,
} from "../domain/reverseEngineering.js";
import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";

const commandObservationSchema = z.strictObject({
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.union([z.string(), z.number(), z.null()]),
  signal: z.string().nullable(),
  output_truncated: z.boolean(),
  completion_status: z.enum(["complete", "unknown"]),
  artifact_sha256_after: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  artifact_changed: z.boolean().nullable(),
});

/** Caller-selected GNU objdump and Rizin observations. */
export const REVERSE_ENGINEERING_TOOL_CONTRACTS = [
  {
    name: "inspect_with_objdump",
    ...toolContractMetadata("inspect_with_objdump"),
    kind: "native-provider",
    description:
      "Run caller-selected GNU objdump inspection against a local artifact, or request operation=architectures without a path to list BFD targets advertised by the installed binary. Preserves decoded stdout and stderr inline with SHA-256 Evidence for artifact inspections, up to a shared 16 MiB combined limit; invalid UTF-8 bytes are represented by replacement characters and flagged in Evidence limitations. output_truncated reports output beyond that limit and completion_status is unknown if buffer enforcement terminated the process. The raw output is authoritative and REA does not claim a stable normalized format. DWARF does not follow local debug links by default. Set follow_debug_links to true to follow them; identities of external debug files are not bound to Evidence. REA clears DEBUGINFOD_URLS for objdump so DWARF processing does not make debuginfod network requests. Architecture output is subjectless and does not establish support for any artifact.",
    inputSchema: objdumpInputSchema,
    outputSchema: evidenceResultOf(commandObservationSchema),
    examples: [
      {
        title: "Disassemble code sections",
        input: { path: "/tmp/program", operation: "disassemble" },
      },
      {
        title: "List advertised BFD targets",
        input: { operation: "architectures" },
      },
    ],
  },
  {
    name: "execute_rizin_command",
    ...toolContractMetadata("execute_rizin_command"),
    kind: "native-provider",
    description:
      "Execute one caller-selected Rizin command against a local artifact using the Rizin CLI profile that suppresses user settings and scripts while retaining plugins. Preserves decoded stdout and stderr inline with SHA-256 Evidence, up to a shared 16 MiB combined limit; invalid UTF-8 bytes are represented by replacement characters and flagged in Evidence limitations. output_truncated reports output beyond that limit and completion_status is unknown if buffer enforcement terminated the process. Rizin commands and retained plugins can execute foreign code, mutate files, access the network, and read files outside the selected artifact; identities and contents of those external inputs are not bound to Evidence. Command effects depend on the Rizin command and loaded plugins; JSON is command-specific and raw output remains authoritative. In a shared MCP server, this admitted command closes any active binary-analysis session; after its effects have settled, call open_binary before further analysis. Close an active Ghidra session explicitly first.",
    inputSchema: rizinInputSchema,
    outputSchema: evidenceResultOf(commandObservationSchema),
    examples: [
      {
        title: "Inspect binary information",
        input: { path: "/tmp/program", command: "iI" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
