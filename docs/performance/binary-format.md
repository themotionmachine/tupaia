# Native project format

Downloads, browser storage and Dropbox write native `.map` files. Shared HTTP maps and internal history retain the text protocol. The loader also accepts existing text and gzip maps. Binary encoding preserves section order and exact text fallback for noncanonical numeric spellings.

The header is 12 bytes: magic `TUPAIA`, NUL, version byte `1`, then little-endian uint16 section count and uint16 directory-entry size (`24`). Every directory entry contains a uint8 type, uint8 compression mode, two reserved zero bytes, followed by five little-endian uint32 values: payload offset, payload length, decoded byte length, numeric element count, and FNV-1a checksum of decoded bytes. Payloads follow the directory contiguously; trailing or overlapping data is rejected.

Type `0` is UTF-8 text; `1`–`7` are Uint8, Uint16, Uint32, Int8, Int16, Int32 and Float64 arrays. Numeric values are little-endian. Text entries have zero element count. Empty optional arrays remain empty text so legacy optional-section checks retain their meaning. Native save captures owned cell buffers before yielding.

Compression `0` stores raw bytes, `1` is the earlier independently deflated section representation, and `2` is an LZ4 block. New saves choose fast blocks only when smaller than raw input. The decoder continues accepting deflate sections. Blocks contain token-delimited literal/match sequences and do not contain an LZ4 frame header; the directory supplies decoded length and checksum. Decoders reject truncated lengths, invalid backreferences, output overflow, unknown modes and checksum mismatch. Decoded sections are limited to 256 MiB each.

`BinaryMapArchive` opens the directory without decoding payloads and caches independently requested sections. The current UI adapter eagerly decompresses text bytes but defers UTF-8 decoding and hidden zone/ice JSON parsing; cell consumers receive typed arrays directly. Canonical relief glyphs serialize as vector markup without retaining duplicate raster and placement data, then compact again after loading. Custom vector content retains its original representation.
