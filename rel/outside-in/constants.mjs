/** Identity for the opt-in public-documentation collector. */
export const SCHEMA_VERSION = "ree.outside-in.behavior-spec.v1";

export const MODE = "outside-in";

export const USER_AGENT =
  "REE-OutsideIn/1.0 (+https://github.com/gryszzz/reverse-engineer-everything; public-documentation; no-login)";

export const QUOTE_MAX = 160;

export const SIMILARITY_THRESHOLD = 80;

export const MAX_DOCUMENT_BYTES = 512_000;

export const MAX_EXPLICIT_URLS = 25;

export const DEFAULT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const LIVE_MIN_INTERVAL_MS = 1000;

export const CLEAN_ROOM_STATEMENT =
  "This spec contains descriptions and structured facts only. It contains no copied source code and no verbatim passage beyond short attributed quotes.";

export const REDACTED = "[redacted similar passage]";
