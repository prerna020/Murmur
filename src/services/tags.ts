/** Maximum number of tags on one entry (fixed-list and custom combined). */
export const MAX_TAGS_PER_ENTRY = 3;

/** Maximum length of a single tag after normalization. */
export const MAX_TAG_LENGTH = 24;

export type AddTagResult =
  | { ok: true; tags: string[] }
  | { ok: false; tags: string[]; reason: 'empty' | 'too_long' | 'duplicate' | 'limit' };

/** Trims, lowercases and drops a leading '#'. Inner spaces are kept. */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').trim().toLowerCase();
}

/**
 * Adds a tag to the list if it passes validation. The input list is never mutated.
 * Rules: not empty, at most MAX_TAG_LENGTH characters, not already present,
 * and at most MAX_TAGS_PER_ENTRY tags in total.
 */
export function addTag(current: readonly string[], raw: string): AddTagResult {
  const tag = normalizeTag(raw);
  const tags = [...current];
  if (!tag) return { ok: false, tags, reason: 'empty' };
  if (tag.length > MAX_TAG_LENGTH) return { ok: false, tags, reason: 'too_long' };
  if (tags.includes(tag)) return { ok: false, tags, reason: 'duplicate' };
  if (tags.length >= MAX_TAGS_PER_ENTRY) return { ok: false, tags, reason: 'limit' };
  return { ok: true, tags: [...tags, tag] };
}

export function addTagErrorMessage(reason: 'empty' | 'too_long' | 'duplicate' | 'limit'): string {
  switch (reason) {
    case 'empty':
      return 'Tag is empty.';
    case 'too_long':
      return `Tags can be at most ${MAX_TAG_LENGTH} characters.`;
    case 'duplicate':
      return 'That tag is already added.';
    case 'limit':
      return `An entry can have at most ${MAX_TAGS_PER_ENTRY} tags. Remove one first.`;
  }
}
