// Stałe wspólne dla zadań i eksportu (osobny moduł, by uniknąć cyklicznych importów).
/** Próg „ponad normę kanału”: wyświetlenia >= NORM_MULTIPLIER × mediana Shortsów kanału. */
export const NORM_MULTIPLIER = 2;
/** Minimalny odstęp między pomiarami tego samego filmu (krótsze powtórki nie tworzą nowego pomiaru). */
export const SNAPSHOT_MIN_GAP_MS = 3600_000;
/** Minimalna liczba Shortsów z wyświetleniami, od której liczymy normę (mediana) i TOP 5%. */
export const MIN_SHORTS_FOR_NORM = 5;
export const MIN_SHORTS_FOR_TOP5 = 20;

/** Wersja serwera (zwracana przez /health i w serverInfo MCP) — pozwala sprawdzić, jaki kod faktycznie działa. */
export const SERVER_VERSION = "2.5.0";
