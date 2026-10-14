import { createHash } from "node:crypto";
import type { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import { streamChunkToBuffer } from "./StreamBytes.js";

import { ArtifactReaderFailure } from "./ArtifactReader.js";
import {
  assertFilePathIdentity,
  readFileIdentity,
  type FileIdentity,
} from "./SafeOutputTreeIdentity.js";

/** Hash one retained readback descriptor and confirm it still names the output file. */
export const hashOutputFile = async (
  owner: OwnedFileHandle,
  path: string,
  identity: FileIdentity,
  options: {
    readonly maximum: number;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<{ readonly sha256: string; readonly bytes: number }> => {
  const admittedIdentity = await readFileIdentity(owner.handle, path);
  await assertFilePathIdentity(path, identity);
  if (
    admittedIdentity.dev !== identity.dev ||
    admittedIdentity.ino !== identity.ino
  )
    throw new ArtifactReaderFailure(
      "path",
      `Extraction file identity changed: ${path}`,
    );
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const raw of readFileHandleChunks(owner.handle, options)) {
      if (options.signal?.aborted === true)
        throw new ArtifactReaderFailure(
          "cancelled",
          "Artifact extraction cancelled",
        );
      const chunk = streamChunkToBuffer(raw);
      bytes += chunk.length;
      if (bytes > options.maximum)
        throw new ArtifactReaderFailure(
          "integrity",
          "Readback exceeded the bytes written",
        );
      hash.update(chunk);
    }
  } catch (cause: unknown) {
    if (options.signal?.aborted === true)
      throw new ArtifactReaderFailure(
        "cancelled",
        "Artifact extraction cancelled",
        { cause },
      );
    throw cause;
  }
  await assertFilePathIdentity(path, identity);
  return { sha256: hash.digest("hex"), bytes };
};
