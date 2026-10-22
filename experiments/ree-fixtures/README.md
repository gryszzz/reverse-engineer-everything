# Owned studio fixtures

These files are authored for Investigation Studio route tests. They are not third-party programs and they are safe to redistribute with this checkout.

| File                 | What it is                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `empty.wasm`         | Eight-byte WebAssembly header. It is not executed.                                                                   |
| `carrier.hex`        | Five bytes of EVM bytecode, written as hex. Interface discovery on this carrier reports no selectors.                |
| `tiny.c`             | A C program whose only behavior is `return 0`.                                                                       |
| `tiny-linux-x64.elf` | That C program compiled for Linux x64 with `gcc -Os -s`.                                                             |
| `resource32.exe`     | A PE32 image generated from `src/native/pe/PeResources.fixture.ts`. It is a resource table, not a program to launch. |

Regenerate the PE image with:

```sh
node --experimental-strip-types --input-type=module -e 'import { writeFileSync } from "node:fs"; import { peResourceFixture } from "./src/native/pe/PeResources.fixture.ts"; writeFileSync("experiments/ree-fixtures/resource32.exe", peResourceFixture(false).bytes);'
```

Regenerate the ELF on Linux with `gcc -Os -s -o experiments/ree-fixtures/tiny-linux-x64.elf experiments/ree-fixtures/tiny.c`.
