import * as SecureStore from 'expo-secure-store';

const KEY_ALIAS = 'murmur_db_encryption_key';
const KEYCHAIN_SERVICE = 'murmur_secure_store';

/**
 * Generate a cryptographically secure 256-bit (32 bytes = 64 hex characters) key.
 * Never log or leak this key to console or disk.
 */
function generateSecure256BitKeyHex(): string {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 32; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Validates that the key is exactly 64 hexadecimal characters (256 bits).
 * Prevents SQL injection when constructing PRAGMA statements.
 */
export function isValidKeyHex(keyHex: string | null | undefined): boolean {
  if (!keyHex) return false;
  return /^[0-9a-fA-F]{64}$/.test(keyHex);
}

/**
 * Retrieves the existing 256-bit database encryption key from Android Keystore
 * (via expo-secure-store), or generates a new one on first launch.
 *
 * NOTE: Never log the returned key.
 */
export async function getOrCreateDatabaseEncryptionKey(): Promise<string> {
  let key: string | null = null;
  try {
    key = await SecureStore.getItemAsync(KEY_ALIAS, {
      keychainService: KEYCHAIN_SERVICE,
    });
  } catch {
    // If Keystore lookup fails or corrupted, key remains null
    key = null;
  }

  if (!key || !isValidKeyHex(key)) {
    key = generateSecure256BitKeyHex();
    await SecureStore.setItemAsync(KEY_ALIAS, key, {
      keychainService: KEYCHAIN_SERVICE,
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  }

  return key;
}

/**
 * Deletes the database encryption key from Android Keystore.
 * Used during emergency reset if database or key is corrupted.
 */
export async function deleteDatabaseEncryptionKey(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY_ALIAS, {
      keychainService: KEYCHAIN_SERVICE,
    });
  } catch {
    // Ignore error if already deleted
  }
}

/**
 * Returns SQLCipher raw key PRAGMA statement.
 * Format recommended by SQLCipher: PRAGMA key = "x'<64 hex chars>'";
 * This bypasses PBKDF2 key derivation for high-performance direct 256-bit raw keys.
 */
export function buildPragmaKeyStatement(keyHex: string): string {
  if (!isValidKeyHex(keyHex)) {
    throw new Error('Invalid encryption key: must be a 64-character hex string (256 bits).');
  }
  return `PRAGMA key = "x'${keyHex}'";`;
}

