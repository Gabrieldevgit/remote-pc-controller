// Tiny atomic JSON file store. No database dependency: the whole dataset lives
// in a single JSON file, written atomically (tmp file + rename) on a short
// debounce so bursts of writes coalesce.

import fs from 'node:fs';
import path from 'node:path';

export class JsonStore {
  /**
   * @param {string} filePath absolute path to the JSON database file
   * @param {object} defaults shape used when the file does not exist / is corrupt
   */
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.data = structuredClone(defaults);
    this._saveTimer = null;
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed;
      }
    } catch {
      // Missing or corrupt file: start from defaults (a corrupt file is left on
      // disk untouched until the first successful save overwrites it).
    }
  }

  /** Debounced save; coalesces rapid mutations into one disk write. */
  save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 100);
    if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
  }

  /** Immediate atomic save (tmp file + rename). */
  saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}
