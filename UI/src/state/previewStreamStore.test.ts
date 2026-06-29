/**
 * previewStreamStore.test.ts — Preview 流 store 单测
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { usePreviewStreamStore } from './previewStreamStore';
import type { PreviewPayload, StreamState } from '../services/canvas/UniversalAST';

const SAMPLE_PAYLOAD: PreviewPayload = {
  language: 'python',
  framework: 'Flask',
  source_code: 'print("hi")',
  preview: {
    root: { type: 'column', style: {}, children: [{ type: 'text', content: 'hi' }] },
  },
};

const STREAMING_STATE: StreamState = {
  raw: '{"language":"python","framework":"Flask"',
  payload: {
    language: 'python',
    framework: 'Flask',
    source_code: '',
    preview: { root: { type: 'column', children: [] } },
  },
  errors: [],
  done: false,
};

describe('previewStreamStore', () => {
  beforeEach(() => {
    usePreviewStreamStore.getState().reset();
  });

  it('initEntry creates empty entry', () => {
    const { initEntry, getEntry } = usePreviewStreamStore.getState();
    initEntry('chat-1', { language: 'python' });
    const e = getEntry('chat-1');
    expect(e).toBeDefined();
    expect(e!.language).toBe('python');
    expect(e!.isStreaming).toBe(true);
  });

  it('updateStream tracks ast and language', () => {
    const { initEntry, updateStream, getEntry } = usePreviewStreamStore.getState();
    initEntry('chat-1', { language: 'typescript' });
    updateStream('chat-1', STREAMING_STATE);
    const e = getEntry('chat-1');
    expect(e!.language).toBe('python'); // updated from payload
    expect(e!.ast).toBeDefined();
    expect(e!.rawBytes).toBe(STREAMING_STATE.raw.length);
  });

  it('confirmPayload marks done + sets sourceCode', () => {
    const { initEntry, updateStream, confirmPayload, getEntry } = usePreviewStreamStore.getState();
    initEntry('chat-1', { language: 'python' });
    updateStream('chat-1', STREAMING_STATE);
    confirmPayload('chat-1', SAMPLE_PAYLOAD);
    const e = getEntry('chat-1');
    expect(e!.isStreaming).toBe(false);
    expect(e!.payload).toEqual(SAMPLE_PAYLOAD);
    expect(e!.sourceCode).toBe(SAMPLE_PAYLOAD.source_code);
  });

  it('confirmPayload with null does not crash', () => {
    const { initEntry, confirmPayload, getEntry } = usePreviewStreamStore.getState();
    initEntry('chat-1', { language: 'python' });
    confirmPayload('chat-1', null);
    expect(getEntry('chat-1')!.isStreaming).toBe(false);
  });

  it('recordPushError captures error message', () => {
    const { initEntry, recordPushError, getEntry } = usePreviewStreamStore.getState();
    initEntry('chat-1', { language: 'python' });
    recordPushError('chat-1', 'IPC timeout');
    expect(getEntry('chat-1')!.pushError).toBe('IPC timeout');
  });

  it('clearEntry removes', () => {
    const { initEntry, clearEntry, getEntry } = usePreviewStreamStore.getState();
    initEntry('chat-1', { language: 'python' });
    clearEntry('chat-1');
    expect(getEntry('chat-1')).toBeUndefined();
  });

  it('reset clears all entries', () => {
    const { initEntry, reset, getEntry } = usePreviewStreamStore.getState();
    initEntry('chat-1', { language: 'python' });
    initEntry('chat-2', { language: 'c' });
    reset();
    expect(getEntry('chat-1')).toBeUndefined();
    expect(getEntry('chat-2')).toBeUndefined();
  });

  it('getAst / getPayload / isStreaming selectors', () => {
    const { initEntry, updateStream, getAst, getPayload, isStreaming } =
      usePreviewStreamStore.getState();
    initEntry('chat-1', { language: 'python' });
    updateStream('chat-1', STREAMING_STATE);
    expect(isStreaming('chat-1')).toBe(true);
    expect(getPayload('chat-1')).toBeNull();
    expect(getAst('chat-1')).toBeDefined();
  });

  it('updateStream on non-existent entry creates one (safety net)', () => {
    const { updateStream, getEntry } = usePreviewStreamStore.getState();
    // 不 initEntry，直接 update（safety net：自动创建）
    updateStream('chat-nonexistent', STREAMING_STATE);
    const e = getEntry('chat-nonexistent');
    expect(e).toBeDefined();
    expect(e!.rawBytes).toBe(STREAMING_STATE.raw.length);
  });
});
