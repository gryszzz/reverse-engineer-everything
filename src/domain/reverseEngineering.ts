import { z } from "zod";

const objdumpArtifactInputSchema = z
  .object({
    path: z.string().min(1),
    operation: z.enum([
      "file_headers",
      "section_headers",
      "symbols",
      "relocations",
      "dwarf",
      "disassemble",
      "disassemble_all",
    ]),
    follow_debug_links: z.boolean().default(false),
  })
  .strict();

/** Caller-selected artifact facet or pathless provider capability query. */
export const objdumpInputSchema = z.discriminatedUnion("operation", [
  objdumpArtifactInputSchema,
  z.strictObject({ operation: z.literal("architectures") }),
]);

/** Caller-selected Rizin command against one local artifact. */
export const rizinInputSchema = z
  .object({
    path: z.string().min(1),
    command: z
      .string()
      .min(1)
      .refine(
        (value) => !/[\r\n\u0000]/u.test(value),
        "A single command line is required",
      ),
  })
  .strict();

export type ObjdumpInput = z.input<typeof objdumpInputSchema>;
export type RizinInput = z.input<typeof rizinInputSchema>;
