import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Readable } from "node:stream";

import {
  ArtifactReaderFailure,
  sameArtifactSourceIdentity,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOmission,
  type ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { hostExecutableMarking } from "./hostExecutableMarking.js";
import { OwnedDirectoryHandle } from "../filesystem/OwnedDirectoryHandle.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";

interface DirectoryTraversalOptions extends ArtifactTraversalOptions {
  readonly descendInto?: (path: string) => boolean;
}

/** Non-symlink-following directory reader. */
export class DirectoryArtifactReader implements ArtifactReader {
  readonly format = "directory" as const;
  #rootPromise: Promise<string> | undefined;
  readonly #rootPath: string;
  readonly #directories = new Set<OwnedDirectoryHandle>();
  readonly #files = new Map<OwnedFileHandle, string>();

  constructor(root: string) {
    this.#rootPath = root;
  }

  /** Enumerate entries, optionally restricting descent while retaining directories. */
  async *entries(
    signal?: AbortSignal,
    selection?: DirectoryTraversalOptions | ((path: string) => boolean),
  ): AsyncIterable<ArtifactEntry> {
    const root = await this.#resolveRoot();
    const options =
      typeof selection === "function" ? { descendInto: selection } : selection;
    const pending = [root];
    while (pending.length > 0) {
      abortIfNeeded(signal);
      const directory = pending.pop();
      if (directory === undefined) break;
      await withDirectoryIoContext("inspect directory", directory, () =>
        assertContainedDirectory(root, directory),
      );
      for await (const entry of this.#readDirectory(
        directory,
        pending,
        signal,
        options,
      ))
        yield entry;
      await withDirectoryIoContext("inspect directory", directory, () =>
        assertContainedDirectory(root, directory),
      );
    }
  }

  async #resolveRoot(): Promise<string> {
    return (this.#rootPromise ??= realpath(this.#rootPath)).catch(
      (cause: unknown) => {
        throw directoryIoFailure(
          "resolve artifact root",
          this.#rootPath,
          cause,
        );
      },
    );
  }

  async *#readDirectory(
    directory: string,
    pending: string[],
    signal?: AbortSignal,
    options?: DirectoryTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    const root = await this.#resolveRoot();
    const handle = new OwnedDirectoryHandle(
      await opendir(directory).catch((cause: unknown) => {
        throw directoryIoFailure("open directory", directory, cause);
      }),
    );
    this.#directories.add(handle);
    const childDirectories: string[] = [];
    let traversal:
      | { readonly kind: "complete" }
      | { readonly kind: "failed"; readonly cause: unknown } = {
      kind: "complete",
    };
    try {
      for (;;) {
        const child = await handle.handle.read();
        if (child === null) break;
        abortIfNeeded(signal);
        const absolute = join(directory, child.name);
        const metadata = await lstat(absolute, { bigint: true }).catch(
          (cause: unknown) => {
            throw directoryIoFailure("inspect entry", absolute, cause);
          },
        );
        const path = relative(root, absolute).split(sep).join("/");
        const entry = artifactEntry(path, absolute, metadata);
        if (entry === undefined) {
          options?.onOmission?.({ path, kind: unsupportedEntryKind(metadata) });
          continue;
        }
        yield entry;
        if (entry.kind === "directory") {
          if (options?.descendInto?.(path) ?? true)
            childDirectories.push(absolute);
          else options?.onOmission?.({ path, kind: "directory-descendants" });
        }
      }
    } catch (cause: unknown) {
      traversal = {
        kind: "failed",
        cause:
          cause instanceof ArtifactReaderFailure
            ? cause
            : directoryIoFailure("read directory", directory, cause),
      };
    } finally {
      await this.#finishDirectory(handle, directory, traversal);
    }
    if (traversal.kind === "failed") throw traversal.cause;
    childDirectories.reverse();
    pending.push(...childDirectories);
  }

  async #finishDirectory(
    handle: OwnedDirectoryHandle,
    path: string,
    traversal:
      | { readonly kind: "complete" }
      | { readonly kind: "failed"; readonly cause: unknown },
  ): Promise<void> {
    try {
      await handle.close();
      this.#directories.delete(handle);
    } catch (cause: unknown) {
      const closeFailure = directoryIoFailure("close directory", path, cause);
      if (traversal.kind === "failed")
        throw ArtifactReaderFailure.withCleanup(
          traversal.cause,
          ArtifactReaderFailure.cleanupObservation(closeFailure, path),
        );
      throw closeFailure;
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    abortIfNeeded(signal);
    if (entry.kind !== "file")
      throw new ArtifactReaderFailure(
        "format",
        "Only regular files can be opened",
      );
    const fileHandle = await open(
      entry.adapterKey,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((cause: unknown) => {
      throw directoryIoFailure("open entry", entry.adapterKey, cause);
    });
    const owner = new OwnedFileHandle(fileHandle);
    this.#files.set(owner, entry.adapterKey);
    try {
      const observed = await owner.handle
        .stat({ bigint: true })
        .catch((cause: unknown) => {
          throw directoryIoFailure(
            "inspect opened entry",
            entry.adapterKey,
            cause,
          );
        });
      if (
        !observed.isFile() ||
        !sameArtifactSourceIdentity(entry.sourceIdentity, observed)
      ) {
        throw new ArtifactReaderFailure(
          "integrity",
          `Directory entry changed before open: ${entry.path}`,
        );
      }
      abortIfNeeded(signal);
      const source = Readable.from(
        mapStableFileRead(owner.handle, entry, signal),
        { objectMode: false },
      );
      source.once("close", () => {
        void this.#closeFile(owner).catch(() => undefined);
      });
      return source;
    } catch (cause: unknown) {
      try {
        await this.#closeFile(owner);
      } catch (closeCause: unknown) {
        throw ArtifactReaderFailure.withCleanup(
          cause,
          ArtifactReaderFailure.cleanupObservation(
            directoryIoFailure(
              "close opened entry",
              entry.adapterKey,
              closeCause,
            ),
            entry.adapterKey,
          ),
        );
      }
      throw cause;
    }
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    for (const [owner, path] of this.#files) {
      try {
        await this.#closeFile(owner);
      } catch (cause: unknown) {
        failures.push(directoryIoFailure("close opened entry", path, cause));
      }
    }
    for (const owner of this.#directories) {
      try {
        await owner.close();
        this.#directories.delete(owner);
      } catch (cause: unknown) {
        failures.push(
          directoryIoFailure("close directory", owner.handle.path, cause),
        );
      }
    }
    if (failures.length > 0) {
      const reason = failures.map(failureMessage).join("; ");
      throw new ArtifactReaderFailure(
        "io",
        `Directory artifact cleanup failed: ${reason}`,
        {
          cause: new AggregateError(failures),
          cleanup: {
            reason,
            resources: [
              ...this.#files.values(),
              ...[...this.#directories].map((owner) => owner.handle.path),
            ],
          },
        },
      );
    }
  }

  async #closeFile(owner: OwnedFileHandle<FileHandle>): Promise<void> {
    await owner.close();
    this.#files.delete(owner);
  }

  provenance(): readonly [] {
    return [];
  }
}

const unsupportedEntryKind = (
  metadata: BigIntStats,
): ArtifactTraversalOmission["kind"] =>
  metadata.isFIFO()
    ? "fifo"
    : metadata.isSocket()
      ? "socket"
      : metadata.isBlockDevice()
        ? "block-device"
        : metadata.isCharacterDevice()
          ? "character-device"
          : "unsupported";

const artifactEntry = (
  path: string,
  absolute: string,
  metadata: BigIntStats,
): ArtifactEntry | undefined => {
  const kind = metadata.isSymbolicLink()
    ? "symlink"
    : metadata.isDirectory()
      ? "directory"
      : metadata.isFile()
        ? "file"
        : undefined;
  if (kind === undefined) return undefined;
  return {
    path,
    kind,
    declaredSize: kind === "file" ? safeArtifactSize(metadata.size) : null,
    compressedSize: null,
    executable: hostExecutableMarking(absolute, metadata),
    encrypted: false,
    byteOffset: null,
    declaredSha256: null,
    unpacked: false,
    limitations:
      kind === "symlink"
        ? ["Symlink target was not followed or disclosed."]
        : [],
    adapterKey: absolute,
    ...(kind === "file"
      ? {
          sourceIdentity: {
            device: metadata.dev,
            inode: metadata.ino,
            size: metadata.size,
            mode: metadata.mode,
            mtimeNs: metadata.mtimeNs,
            ctimeNs: metadata.ctimeNs,
          },
        }
      : {}),
  };
};

const safeArtifactSize = (size: bigint): number | null => {
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(size);
};

const directoryIoFailure = (
  operation: string,
  path: string,
  cause: unknown,
): ArtifactReaderFailure => {
  if (cause instanceof ArtifactReaderFailure) return cause;
  const code =
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
      ? ` (${cause.code})`
      : "";
  const detail = failureMessage(cause);
  return new ArtifactReaderFailure(
    "io",
    `Could not ${operation} at ${path}${code}: ${detail}`,
    { cause },
  );
};

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const mapStableFileRead = async function* (
  handle: FileHandle,
  entry: ArtifactEntry,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  let bytes = 0n;
  try {
    const expectedBytes = entry.sourceIdentity?.size;
    if (expectedBytes === undefined)
      throw new ArtifactReaderFailure(
        "integrity",
        `Directory entry has no captured file state: ${entry.path}`,
      );
    for await (const chunk of readFileHandleChunks(handle, {
      // Include one extra byte so a growing file cannot make this read unbounded.
      end: expectedBytes,
      signal,
    })) {
      abortIfNeeded(signal);
      bytes += BigInt(chunk.length);
      yield chunk;
    }
    abortIfNeeded(signal);
    const [opened, current] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(entry.adapterKey, { bigint: true }),
    ]);
    abortIfNeeded(signal);
    if (
      !opened.isFile() ||
      !current.isFile() ||
      !sameArtifactSourceIdentity(entry.sourceIdentity, opened) ||
      !sameArtifactSourceIdentity(entry.sourceIdentity, current) ||
      bytes !== expectedBytes
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Directory entry changed during read: ${entry.path}`,
      );
  } catch (cause: unknown) {
    if (signal?.aborted === true)
      throw new ArtifactReaderFailure(
        "cancelled",
        "Directory artifact read cancelled",
        { cause },
      );
    if (
      cause instanceof Error &&
      "code" in cause &&
      ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(cause.code))
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Directory entry changed during read: ${entry.path}`,
        { cause },
      );
    if (!(cause instanceof ArtifactReaderFailure))
      throw directoryIoFailure("validate read entry", entry.adapterKey, cause);
    throw cause;
  }
};

const withDirectoryIoContext = async <T>(
  operation: string,
  path: string,
  action: () => Promise<T>,
): Promise<T> => {
  try {
    return await action();
  } catch (cause: unknown) {
    throw directoryIoFailure(operation, path, cause);
  }
};

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Artifact traversal cancelled",
    );
};

const assertContainedDirectory = async (
  root: string,
  directory: string,
): Promise<void> => {
  const canonical = await realpath(directory);
  const fromRoot = relative(root, canonical);
  const metadata = await lstat(directory);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  )
    throw new ArtifactReaderFailure(
      "path",
      "Directory traversal escaped or changed its artifact root",
    );
};
