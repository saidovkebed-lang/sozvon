import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORT = 3200;
export const BASE_URL = `https://localhost:${PORT}`;
export const DATA_DIR = process.env.QA_DATA_DIR || path.join(os.tmpdir(), 'sozvon-qa-data');
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MEDIA_DIR = path.join(ROOT, 'tests', 'fixtures', 'media');
