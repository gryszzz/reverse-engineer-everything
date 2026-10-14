import { deflateSync, inflateSync } from "node:zlib";
import { z } from "zod";
import {
  RUST_AUDITABLE_FORMAT_VERSION,
  cyclicDependencyIndices,
  type RustAuditableMetadata,
  type RustPackage,
} from "../domain/rust/rustBinary.js";

/** Selected-file admission limit shared with the stable artifact reader. */
export const RUST_BINARY_INPUT_BYTES = 256 * 1024 * 1024;
/** Compressed `.dep-v0` section limit. */
export const RUST_SECTION_BYTES = 1024 * 1024;
/** Inflated JSON may grow by at most this multiple of the section size. */
export const RUST_INFLATE_RATIO = 64;
/** Absolute inflated JSON limit, applied together with the ratio. */
export const RUST_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
/** Complete normalized report limit. */
export const RUST_OUTPUT_BYTES = 8 * 1024 * 1024;

const JSON_DEPTH = 32;
const packageSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  source: z.string().min(1),
  kind: z.enum(["runtime", "build"]).optional(),
  dependencies: z.array(z.number().int().nonnegative()).optional(),
  root: z.boolean().optional(),
});
const documentVersionSchema = z.object({
  format: z.number().int().nonnegative().optional(),
});
const documentSchema = documentVersionSchema
  .extend({
    format: z.literal(RUST_AUDITABLE_FORMAT_VERSION).optional(),
    packages: z.array(packageSchema),
  })
  .strict();

/** Malformed or unsupported dependency-section bytes. */
export class RustAuditableFormatFailure extends Error {
  constructor(
    readonly kind: "malformed" | "unsupported",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RustAuditableFormatFailure";
  }
}

/** A resource admission limit with explicit semantic units. */
export type RustAuditableConstraint =
  | {
      readonly resource: "memory";
      readonly reported_limits: { readonly maximum_bytes: number };
    }
  | {
      readonly resource: "transport";
      readonly reported_limits: { readonly maximum_output_bytes: number };
    }
  | {
      readonly resource: "capacity";
      readonly reported_limits: { readonly maximum_rustc_hashes: number };
    };

/** Admission refused before retained output or graph expansion. */
export class RustAuditableResourceFailure extends Error {
  constructor(
    readonly constraint: RustAuditableConstraint,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RustAuditableResourceFailure";
  }
}

/** Parsed section payload. Cycles are listed and are not walked. */
export const readAuditableSection = (
  sectionName: RustAuditableMetadata["section_name"],
  fileOffset: number,
  bytes: Buffer,
): RustAuditableMetadata => {
  if (bytes.length === 0)
    throw new RustAuditableFormatFailure(
      "malformed",
      "Dependency section is empty",
    );
  if (bytes.length > RUST_SECTION_BYTES)
    throw new RustAuditableResourceFailure(
      {
        resource: "memory",
        reported_limits: { maximum_bytes: RUST_SECTION_BYTES },
      },
      "Dependency section exceeds the 1 MiB compressed limit",
    );
  const inflated = inflateSection(bytes);
  const document = parseDocument(inflated);
  const packages = normalizePackages(document.packages);
  const root = rootIndex(packages);
  return {
    section_name: sectionName,
    file_offset: fileOffset,
    section_bytes: bytes.length,
    compressed_bytes: bytes.length,
    uncompressed_bytes: inflated.length,
    format_version: document.format ?? null,
    packages,
    root_package_index: root,
    dependency_edges: packages.flatMap((pkg, fromIndex) =>
      pkg.dependencies.map((toIndex) => ({
        from_index: fromIndex,
        to_index: toIndex,
      })),
    ),
    cyclic_dependency_indices: cyclicDependencyIndices(packages),
  };
};

const inflateSection = (bytes: Buffer): Buffer => {
  const maximum = Math.min(
    RUST_UNCOMPRESSED_BYTES,
    bytes.length * RUST_INFLATE_RATIO,
  );
  try {
    const inflated = inflateSync(bytes, {
      maxOutputLength: maximum,
      ...(rejectsTrailingJunk() ? { rejectGarbageAfterEnd: true } : {}),
    });
    if (
      !rejectsTrailingJunk() &&
      shortestPrefix(bytes, inflated, maximum) !== bytes.length
    )
      throw new RustAuditableFormatFailure(
        "malformed",
        "Dependency section has bytes after the zlib stream",
      );
    return inflated;
  } catch (cause) {
    if (cause instanceof RustAuditableFormatFailure) throw cause;
    throw inflateFailure(cause, maximum);
  }
};

let trailingJunkRejected: boolean | undefined;

const rejectsTrailingJunk = (): boolean => {
  if (trailingJunkRejected !== undefined) return trailingJunkRejected;
  const trailed = Buffer.concat([
    deflateSync(Buffer.from("a")),
    Buffer.from([0]),
  ]);
  try {
    inflateSync(trailed, { rejectGarbageAfterEnd: true });
    trailingJunkRejected = false;
  } catch (cause) {
    trailingJunkRejected =
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ERR_TRAILING_JUNK_AFTER_STREAM_END";
  }
  return trailingJunkRejected;
};

const shortestPrefix = (
  input: Buffer,
  output: Buffer,
  maximum: number,
): number => {
  let low = 0;
  let high = input.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (prefixMatches(input.subarray(0, mid), output, maximum)) high = mid;
    else low = mid + 1;
  }
  return high;
};

const prefixMatches = (
  prefix: Buffer,
  output: Buffer,
  maximum: number,
): boolean => {
  try {
    return inflateSync(prefix, { maxOutputLength: maximum }).equals(output);
  } catch {
    return false;
  }
};

const inflateFailure = (cause: unknown, maximum: number): Error => {
  const code =
    cause instanceof Error && "code" in cause ? String(cause.code) : "";
  if (code === "ERR_BUFFER_TOO_LARGE")
    return new RustAuditableResourceFailure(
      { resource: "memory", reported_limits: { maximum_bytes: maximum } },
      "Inflated dependency JSON exceeds the size limit",
    );
  if (
    code === "ERR_TRAILING_JUNK_AFTER_STREAM_END" ||
    code.startsWith("Z_") ||
    code === "ERR_INVALID_ARG_TYPE"
  )
    return new RustAuditableFormatFailure(
      "malformed",
      "Dependency section is not a complete zlib stream",
    );
  return cause instanceof Error ? cause : new Error(String(cause));
};

const parseDocument = (bytes: Buffer): z.infer<typeof documentSchema> => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new RustAuditableFormatFailure(
      "malformed",
      "Dependency JSON is not valid UTF-8",
      { cause },
    );
  }
  assertDepth(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new RustAuditableFormatFailure(
      "malformed",
      "Dependency section JSON is invalid",
      { cause },
    );
  }
  const version = documentVersionSchema.safeParse(value);
  if (!version.success)
    throw new RustAuditableFormatFailure(
      "malformed",
      "Dependency JSON does not match the format schema",
      { cause: version.error },
    );
  if (
    version.data.format !== undefined &&
    version.data.format !== RUST_AUDITABLE_FORMAT_VERSION
  )
    throw new RustAuditableFormatFailure(
      "unsupported",
      `Unsupported cargo-auditable format version ${version.data.format}`,
    );
  admitGraphExpansion(value);
  // One malformed package must fail before Zod retains an issue for every field.
  rejectMalformedPackages(value);
  const parsed = documentSchema.safeParse(value);
  if (!parsed.success)
    throw new RustAuditableFormatFailure(
      "malformed",
      "Dependency JSON does not match the package schema",
      { cause: parsed.error },
    );
  return parsed.data;
};

// These are lower bounds on the required normalized representation, not
// guessed per-object heap sizes. Count source arrays before Zod clones them,
// normalization builds edge objects, or SCC analysis creates reverse edges.
const MIN_PACKAGE_OUTPUT_BYTES = JSON.stringify({
  name: "a",
  version: "a",
  source: "a",
  kind: null,
  dependencies: [],
  root: true,
}).length;
const MIN_EDGE_OUTPUT_BYTES = JSON.stringify({
  from_index: 0,
  to_index: 0,
}).length;
const admitGraphExpansion = (value: unknown): void => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("packages" in value) ||
    !Array.isArray(value.packages)
  )
    return;
  const packages: readonly unknown[] = value.packages;
  let minimumBytes =
    packages.length * MIN_PACKAGE_OUTPUT_BYTES +
    Math.max(0, packages.length - 1);
  let edges = 0;
  const admit = () => {
    const edgeBytes = edges * MIN_EDGE_OUTPUT_BYTES + Math.max(0, edges - 1);
    if (minimumBytes + edgeBytes > RUST_OUTPUT_BYTES)
      throw new RustAuditableResourceFailure(
        {
          resource: "transport",
          reported_limits: { maximum_output_bytes: RUST_OUTPUT_BYTES },
        },
        "Dependency graph exceeds the complete report byte budget before expansion",
      );
  };
  admit();
  for (const pkg of packages) {
    // Shape and index validity remain owned by documentSchema/rootIndex.
    if (
      typeof pkg !== "object" ||
      pkg === null ||
      !("dependencies" in pkg) ||
      !Array.isArray(pkg.dependencies)
    )
      continue;
    const count = pkg.dependencies.length;
    edges += count;
    minimumBytes += Math.max(0, count * 2 - 1);
    admit();
  }
};

const PACKAGE_FIELDS = new Set([
  "name",
  "version",
  "source",
  "kind",
  "dependencies",
  "root",
]);

const rejectMalformedPackages = (value: unknown): void => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("packages" in value) ||
    !Array.isArray(value.packages)
  )
    return;
  for (const [index, pkg] of value.packages.entries()) {
    if (!packageRecord(pkg))
      throw new RustAuditableFormatFailure(
        "malformed",
        `Dependency package ${String(index)} does not match the package schema`,
      );
  }
};

const packageRecord = (
  pkg: unknown,
): pkg is {
  readonly dependencies?: readonly unknown[];
} => {
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg))
    return false;
  const record = pkg as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PACKAGE_FIELDS.has(key)) return false;
  }
  if (
    !nonEmptyString(record.name) ||
    !nonEmptyString(record.version) ||
    !nonEmptyString(record.source)
  )
    return false;
  if (
    record.kind !== undefined &&
    record.kind !== "runtime" &&
    record.kind !== "build"
  )
    return false;
  if (record.root !== undefined && typeof record.root !== "boolean")
    return false;
  const dependencies = record.dependencies;
  if (dependencies === undefined) return true;
  return (
    Array.isArray(dependencies) &&
    dependencies.every(
      (entry) =>
        typeof entry === "number" && Number.isInteger(entry) && entry >= 0,
    )
  );
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const assertDepth = (text: string): void => {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      if (depth > JSON_DEPTH)
        throw new RustAuditableFormatFailure(
          "malformed",
          "Dependency JSON nesting exceeds 32 levels",
        );
    } else if ((char === "}" || char === "]") && depth > 0) depth -= 1;
  }
};

const normalizePackages = (
  packages: z.infer<typeof documentSchema>["packages"],
): RustPackage[] =>
  packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    source: pkg.source,
    kind: pkg.kind ?? null,
    dependencies: pkg.dependencies ?? [],
    root: pkg.root ?? false,
  }));

const rootIndex = (packages: readonly RustPackage[]): number | null => {
  const roots = packages.flatMap((pkg, index) => (pkg.root ? [index] : []));
  if (roots.length > 1)
    throw new RustAuditableFormatFailure(
      "malformed",
      "Dependency JSON declares more than one root package",
    );
  for (const [index, pkg] of packages.entries()) {
    const outside = pkg.dependencies.find(
      (target) => target >= packages.length,
    );
    if (outside !== undefined)
      throw new RustAuditableFormatFailure(
        "malformed",
        `Dependency index ${String(outside)} from package ${String(index)} is outside the package list`,
      );
  }
  return roots[0] ?? null;
};
