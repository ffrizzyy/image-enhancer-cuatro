import { useEffect, useState } from 'react';

import { ipc } from '../ipc';

/** Thumbnails already fetched, by job, tile and output file, so a tile that has not changed is never fetched twice. */
const cache = new Map<string, string>();

export const THUMBNAIL_PX = 160;

/**
 * A small picture of a tile's output, or null while there is none (or it cannot be shown). It is fetched when the tile
 * gets an output and again when that output changes (a retry), never on a timer.
 */
export function useTileThumbnail(jobId: string, index: number, outputPath: string | undefined): string | null {
  const key = outputPath ? `${jobId}:${index}:${outputPath}` : null;
  const [url, setUrl] = useState<string | null>(key ? (cache.get(key) ?? null) : null);

  useEffect(() => {
    if (!key) {
      setUrl(null);
      return;
    }
    const cached = cache.get(key);
    if (cached) {
      setUrl(cached);
      return;
    }
    let live = true;
    void ipc.jobs
      .tileThumbnail({ jobId, index, maxSide: THUMBNAIL_PX })
      .then((result) => {
        if (!result.ok) return;
        cache.set(key, result.value.dataUrl);
        if (live) setUrl(result.value.dataUrl);
      })
      .catch(() => {
        /* a missing thumbnail is not worth an error */
      });
    return () => {
      live = false;
    };
  }, [key, jobId, index]);

  return url;
}

/** For tests: forget every fetched thumbnail. */
export const clearThumbnailCache = (): void => cache.clear();