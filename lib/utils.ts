import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

export function generateApiKey(): string {
  return 'sk-' + crypto.randomBytes(32).toString('hex');
}

export function generateId(): string {
  return uuidv4();
}
