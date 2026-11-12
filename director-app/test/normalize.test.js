'use strict';
const test = require('node:test');
const assert = require('node:assert');
const N = require('../renderer/normalize');

test('asArray herkent wrappers', () => {
  assert.deepEqual(N.asArray([1]), [1]);
  assert.deepEqual(N.asArray({ content: [1, 2] }), [1, 2]);
  assert.deepEqual(N.asArray({ data: { items: [3] } }), [3]);
  assert.deepEqual(N.asArray({ _embedded: { meetingList: [4] } }), [4]);
  assert.deepEqual(N.asArray(null), []);
});

test('meeting en member', () => {
  const m = N.meeting({ id: 'M2', meetingDate: '2026-11-10', organ: { id: 'O1' } }, { O1: 'Gemeenteraad' });
  assert.equal(m.organName, 'Gemeenteraad');
  assert.equal(m.organId, 'O1');
  const mem = N.member({ id: 1, person: { firstName: 'An', lastName: 'Peeters' }, attendance: { code: 'PRESENT' } });
  assert.equal(mem.name, 'An Peeters');
  assert.equal(mem.status, 'PRESENT');
  assert.equal(N.member({ id: 2, name: 'Bram' }).status, '');
});

test('parseStatusList', () => {
  assert.deepEqual(N.parseStatusList('PRESENT=Aanwezig, ABSENT'), [{ code: 'PRESENT', label: 'Aanwezig' }, { code: 'ABSENT', label: 'ABSENT' }]);
});
