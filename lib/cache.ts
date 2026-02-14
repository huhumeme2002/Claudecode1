import { LRUCache } from 'lru-cache';
import prisma from './db';
import { ModelMapping } from '@prisma/client';

const modelCache = new LRUCache<string, ModelMapping>({
  max: 500,
  ttl: 60 * 1000,
});

const settingsCache = new LRUCache<string, string>({
  max: 100,
  ttl: 60 * 1000,
});

export async function getModelByDisplayName(displayName: string): Promise<ModelMapping | null> {
  const key = displayName.toLowerCase();
  let model = modelCache.get(key);
  if (model) return model;

  const found = await prisma.modelMapping.findFirst({
    where: {
      displayName: { equals: displayName, mode: 'insensitive' },
      enabled: true,
    },
  });

  if (found) {
    modelCache.set(key, found);
  }
  return found;
}

export async function getSetting(key: string): Promise<string | null> {
  let value = settingsCache.get(key);
  if (value !== undefined) return value;

  const setting = await prisma.setting.findUnique({ where: { key } });
  if (setting) {
    settingsCache.set(key, setting.value);
    return setting.value;
  }
  return null;
}

export function clearModelCache(): void {
  modelCache.clear();
}

export function clearSettingsCache(): void {
  settingsCache.clear();
}

export function clearAllCaches(): void {
  modelCache.clear();
  settingsCache.clear();
}
