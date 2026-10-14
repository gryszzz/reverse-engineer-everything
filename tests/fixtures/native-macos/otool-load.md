# Representative native load-command fixture

`otool-load.txt` is a compact, handcrafted representative used by the native
fixture runner. Its Mach header is made internally consistent with the five
listed commands (296 command bytes); it is not a capture from a real binary.
Use fixtures under `native-macho-header/` or `native-reexport/` for producer
captures.
