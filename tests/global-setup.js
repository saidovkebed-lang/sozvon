import fs from 'node:fs';
import { ensureMedia } from './fixtures/media.js';
import { DATA_DIR } from './fixtures/env.js';

export default async function globalSetup() {
  ensureMedia();
  fs.mkdirSync('tests/screens-qa', { recursive: true });
  if (!fs.existsSync(DATA_DIR)) throw new Error('DATA_DIR не создан сервером: ' + DATA_DIR);
}
