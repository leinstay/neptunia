import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryOf } from '../src/protocol/adapter.ts';

type Ref = { iface: string; conversationId: string; messageId: string };
type Part = {
  status: 'ok' | 'failed' | 'unknown' | 'unsupported' | 'forbidden';
  ref?: Ref;
  at?: number;
  error?: { code: string; retryable: boolean };
};

const ref = (messageId: string): Ref => ({ iface: 'test', conversationId: 'c1', messageId });
const posted = (messageId: string, at: number): Part => ({ status: 'ok', ref: ref(messageId), at });

test('reports ok with the first ref and every ref when all parts are ok', () => {
  const delivery = deliveryOf([posted('m1', 100), posted('m2', 101), posted('m3', 102)], 'key-1');
  assert.equal(delivery.status, 'ok');
  assert.deepEqual(delivery.ref, ref('m1'));
  assert.deepEqual(delivery.parts, [ref('m1'), ref('m2'), ref('m3')]);
  assert.equal(delivery.error, null);
});

test('reports ok with one part when a single part is ok', () => {
  const delivery = deliveryOf([posted('m1', 100)], 'key-2');
  assert.equal(delivery.status, 'ok');
  assert.deepEqual(delivery.ref, ref('m1'));
  assert.deepEqual(delivery.parts, [ref('m1')]);
});

test('carries the idempotency key', () => {
  const delivery = deliveryOf([posted('m1', 100)], 'key-3');
  assert.equal(delivery.idempotencyKey, 'key-3');
});

test('reports the first part status and no parts when the first part failed', () => {
  const failure: Part = { status: 'failed', error: { code: 'http-500', retryable: true } };
  const delivery = deliveryOf([failure, posted('m2', 101)], 'key-4');
  assert.equal(delivery.status, 'failed');
  assert.equal(delivery.ref, null);
  assert.deepEqual(delivery.parts, []);
  assert.equal(delivery.error?.code, 'http-500');
  assert.equal(delivery.error?.retryable, true);
  assert.equal(delivery.idempotencyKey, 'key-4');
});

test('reports forbidden when the first part was forbidden', () => {
  const refusal: Part = { status: 'forbidden', error: { code: 'missing-permission', retryable: false } };
  const delivery = deliveryOf([refusal], 'key-5');
  assert.equal(delivery.status, 'forbidden');
  assert.deepEqual(delivery.parts, []);
});

test('reports unknown with the parts posted before it when a later part failed', () => {
  const failure: Part = { status: 'failed', error: { code: 'http-500', retryable: true } };
  const delivery = deliveryOf([posted('m1', 100), failure, posted('m3', 102)], 'key-6');
  assert.equal(delivery.status, 'unknown');
  assert.deepEqual(delivery.ref, ref('m1'));
  assert.deepEqual(delivery.parts, [ref('m1')]);
  assert.equal(delivery.idempotencyKey, 'key-6');
});

test('keeps every earlier ref when the last part failed', () => {
  const failure: Part = { status: 'failed', error: { code: 'http-500', retryable: true } };
  const delivery = deliveryOf([posted('m1', 100), posted('m2', 101), failure], 'key-7');
  assert.equal(delivery.status, 'unknown');
  assert.deepEqual(delivery.parts, [ref('m1'), ref('m2')]);
});
