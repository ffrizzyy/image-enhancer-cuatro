import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AppSettingsSchema, type AppSettings } from '@ie/contracts';

export interface SettingsStore {
  get(): AppSettings;
  /** Merges a validated patch and persists it atomically. Throws on an invalid patch. */
  set(patch: Partial<AppSettings>): AppSettings;
}

/** JSON-file settings in the user data folder. Corrupt or missing files fall back to defaults. */
export function createSettingsStore(filePath: string, defaultDataFolder: string): SettingsStore {
  const defaults: AppSettings = {
    firstRunAcknowledged: false,
    pacingPreset: 'safe',
    dataFolder: defaultDataFolder,
    watchMode: false,
    riskNoticeVersion: 0,
  };

  function read(): AppSettings {
    try {
      const stored = AppSettingsSchema.partial().safeParse(JSON.parse(readFileSync(filePath, 'utf8')));
      if (!stored.success) return { ...defaults };
      // Drop undefined keys so they cannot overwrite defaults.
      const defined = Object.fromEntries(Object.entries(stored.data).filter(([, v]) => v !== undefined));
      return { ...defaults, ...defined };
    } catch {
      return { ...defaults };
    }
  }

  return {
    get: read,
    set(patch) {
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const next = AppSettingsSchema.parse({ ...read(), ...defined });
      mkdirSync(path.dirname(filePath), { recursive: true });
      const temp = `${filePath}.tmp`;
      writeFileSync(temp, JSON.stringify(next, null, 2));
      renameSync(temp, filePath);
      return next;
    },
  };
}
