/**
 * The few primitives a provider chat page needs. The real implementation drives an Electron
 * webContents over the Chrome DevTools Protocol (Task 19); tests use a scripted in-memory page.
 *
 * Selectors are plain CSS. A comma-separated list means "any of these".
 */
export interface PageDriver {
  goto(url: string, timeoutMs: number): Promise<void>;
  /** How many elements currently match; 0 means absent. Never waits. */
  count(selector: string): Promise<number>;
  /** Resolves true as soon as something matches (observing DOM mutations, not sleeping), false on timeout. */
  waitFor(selector: string, timeoutMs: number): Promise<boolean>;
  /** Attaches local files, in order, to a file input. */
  setInputFiles(selector: string, paths: readonly string[]): Promise<void>;
  /** Inserts text in one step (clipboard-style), not key by key. */
  insertText(selector: string, text: string): Promise<void>;
  click(selector: string): Promise<void>;
  /** The page's visible text, for state markers. */
  pageText(): Promise<string>;
  /**
   * Fetches the original-resolution bytes of the image behind `selector`, inside the page context so
   * the session cookies apply. Throws if only a preview or nothing is available.
   */
  fetchImage(selector: string, timeoutMs: number): Promise<Uint8Array>;
}
