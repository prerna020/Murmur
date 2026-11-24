import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleTranscript,
  evaluateHindiGate,
  isLocaleInstalled,
  normalizeLocale,
} from '../src/services/hindiGate.ts';

const passing = {
  platform: 'android',
  apiLevel: 36,
  supportsOnDevice: true,
  installedLocales: ['en-US', 'hi-IN'],
};

describe('Hindi on-device gate', () => {
  it('passes only when every condition holds', () => {
    assert.deepStrictEqual(evaluateHindiGate(passing), { ok: true });
  });

  it('refuses non-Android platforms', () => {
    assert.deepStrictEqual(evaluateHindiGate({ ...passing, platform: 'ios' }), {
      ok: false,
      reason: 'not_android',
    });
  });

  it('refuses Android 12 and below, where on-device mode is not enforced', () => {
    assert.deepStrictEqual(evaluateHindiGate({ ...passing, apiLevel: 32 }), {
      ok: false,
      reason: 'android_too_old',
    });
    assert.strictEqual(evaluateHindiGate({ ...passing, apiLevel: 33 }).ok, true);
  });

  it('refuses when on-device recognition is unsupported', () => {
    assert.deepStrictEqual(evaluateHindiGate({ ...passing, supportsOnDevice: false }), {
      ok: false,
      reason: 'on_device_unavailable',
    });
  });

  it('refuses when the locale query failed', () => {
    assert.deepStrictEqual(evaluateHindiGate({ ...passing, installedLocales: null }), {
      ok: false,
      reason: 'locale_check_failed',
    });
  });

  it('refuses when hi-IN is not installed', () => {
    assert.deepStrictEqual(evaluateHindiGate({ ...passing, installedLocales: ['en-US'] }), {
      ok: false,
      reason: 'pack_not_installed',
    });
  });

  it('matches locales after normalization, but "hi" alone does not count', () => {
    assert.strictEqual(normalizeLocale(' hi_IN '), 'hi-in');
    assert.strictEqual(isLocaleInstalled(['HI-in']), true);
    assert.strictEqual(isLocaleInstalled(['hi_IN']), true);
    assert.strictEqual(isLocaleInstalled(['hi']), false);
    assert.strictEqual(isLocaleInstalled([]), false);
  });
});

describe('assembleTranscript', () => {
  it('joins final segments and a pending partial in order, without changing words', () => {
    assert.strictEqual(
      assembleTranscript(['आज office में', 'meeting थी'], 'बहुत  लंबी'),
      'आज office में meeting थी बहुत लंबी'
    );
  });

  it('ignores empty pieces', () => {
    assert.strictEqual(assembleTranscript(['', '  '], ''), '');
    assert.strictEqual(assembleTranscript([], 'hello'), 'hello');
  });
});
