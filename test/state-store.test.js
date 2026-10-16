import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearModeSession,
  createConvoStore,
  getModeSession,
  setModeSession
} from '../src/state.js';

let tmp;
let oldEnv;

beforeEach(() => {
  oldEnv = process.env.TELE_LOG_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-state-'));
  process.env.TELE_LOG_DIR = tmp;
});

afterEach(() => {
  if (oldEnv === undefined) delete process.env.TELE_LOG_DIR;
  else process.env.TELE_LOG_DIR = oldEnv;
  fs.rmSync(tmp, { force: true, recursive: true });
});

describe('mode sessions (atomic)', () => {
  it('set/get/clear round-trip', () => {
    assert.equal(getModeSession('CODE'), null);
    setModeSession('CODE', 'ses-1');
    assert.equal(getModeSession('CODE'), 'ses-1');
    clearModeSession('CODE');
    assert.equal(getModeSession('CODE'), null);
  });

  it('corrupt state file -> null, no crash', () => {
    fs.writeFileSync(path.join(tmp, 'state.json'), 'broken{{{');
    assert.equal(getModeSession('CODE'), null);
  });
});

describe('convo store', () => {
  it('AWAIT_INPUT expires to IDLE after TTL', () => {
    let now = 1000;
    const store = createConvoStore({ idleTtlMs: 60 * 1000, nowFn: () => now });
    store.set(7, 'AWAIT_INPUT', 'CODE');
    assert.equal(store.get(7).status, 'AWAIT_INPUT');
    now += 31 * 60 * 1000;
    assert.equal(store.get(7).status, 'IDLE');
  });

  it('RUNNING does not expire by TTL', () => {
    let now = 1000;
    const store = createConvoStore({ idleTtlMs: 60 * 1000, nowFn: () => now });
    store.set(7, 'RUNNING', 'MMO');
    now += 120 * 60 * 1000;
    assert.equal(store.get(7).status, 'RUNNING');
  });
});
