import { describe, expect, it } from "vitest";

import {
  readMetadataBlob,
  readMetadataUserString,
} from "./ManagedMetadataHeaps.js";
import type { ManagedMetadataLayout } from "./ManagedMetadataLayout.js";

describe("managed metadata heaps", () => {
  it("reads a blob item's compressed length from its ECMA-335 prefix", () => {
    const itemLength = 1_048_577;
    const bytes = Buffer.alloc(itemLength + 5);
    bytes.set([0xc0, 0x10, 0x00, 0x01], 1);
    const layout: ManagedMetadataLayout = {
      rootOffset: 0,
      size: bytes.length,
      version: "",
      streamNames: ["#Blob"],
      strings: { name: "#Strings", offset: 0, size: 0 },
      guid: { name: "#GUID", offset: 0, size: 0 },
      blob: { name: "#Blob", offset: 0, size: bytes.length },
      userStrings: null,
      tables: new Map(),
      rowCounts: [],
      stringIndexSize: 2,
      guidIndexSize: 2,
      blobIndexSize: 2,
      table: () => undefined,
      tableIndexSize: () => 2,
      codedIndexSize: () => 2,
    };

    expect(readMetadataBlob(bytes, layout, 1, layout.blob.size)).toHaveLength(
      itemLength,
    );
  });

  it.each([[[0x80]], [[0xc0, 0x00, 0x00]]])(
    "reports a #US length prefix cut off by the end of the artifact as a string failure",
    (prefix) => {
      // #US ends at the end of the artifact, inside a multi-byte length prefix.
      const bytes = Buffer.from([0x00, ...prefix]);
      const layout = {
        userStrings: { name: "#US", offset: 0, size: bytes.length },
      } as unknown as ManagedMetadataLayout;

      expect(() =>
        readMetadataUserString(bytes, layout, "0x70000001"),
      ).toThrowError(
        expect.objectContaining({
          issue: expect.objectContaining({
            code: "invalid-string",
            scope: "metadata.#US:0x70000001",
          }),
        }),
      );
    },
  );
});
