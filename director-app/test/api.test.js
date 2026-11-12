'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DirectorClient, normalizeBaseUrl, toList, parseExtraHeaders } = require('../src/api');
const { createMockServer } = require('./mock-server');

test('helpers', () => {
  assert.equal(normalizeBaseUrl('suite-release.onlinesmartcities.be/'), 'https://suite-release.onlinesmartcities.be');
  assert.deepEqual(toList(' a, b;c\n'), ['a', 'b', 'c']);
  assert.deepEqual(parseExtraHeaders('{"X-A":"1"}'), { 'X-A': '1' });
  assert.deepEqual(parseExtraHeaders('X-A: 1\nX-B: two: x'), { 'X-A': '1', 'X-B': 'two: x' });
});

test('volledige flow tegen mock', async (t) => {
  const mock = createMockServer();
  const port = await mock.listen();
  t.after(() => mock.close());
  const base = `http://127.0.0.1:${port}`;
  const client = new DirectorClient({
    baseUrl: base, tokenUrl: base + '/token', clientId: 'suite-api-client', clientSecret: 'geheim',
    organIds: '12.0623.8213.4871, 15.0623.8213.2303', meetingStatuses: 'AGENDA_OPEN', listStyle: 'comma', extraHeaders: 'X-Tenant: gent',
  });

  const organs = await client.getOrgans();
  assert.equal(organs.length, 2);

  const meetings = await client.getMeetings();
  assert.equal(meetings.content.length, 2);
  const mCall = mock.calls.find(c => c.path.endsWith('/meetings'));
  assert.match(decodeURIComponent(mCall.query), /organ=12\.0623\.8213\.4871,15\.0623\.8213\.2303/);
  assert.match(mCall.query, /sort=-meetingDate/);
  assert.equal(mCall.headers['x-tenant'], 'gent');

  client.updateSettings({ ...client.settings, listStyle: 'repeat' });
  await client.getMeetings();
  assert.equal((mock.calls.at(-1).query.match(/organ=/g) || []).length, 2);

  const members = await client.getMembers('M1');
  assert.equal(members.length, 3);

  await client.updateMember('M1', '19.0101.0000.0003', { status: 'PRESENT' });
  const patch = mock.calls.at(-1);
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(patch.body), { status: 'PRESENT' });
  assert.equal(mock.members.M1[2].status, 'PRESENT');

  // token hergebruikt: precies 1 tokencall tot nu toe
  assert.equal(mock.calls.filter(c => c.path === '/token').length, 1);

  // verlopen token -> automatisch vernieuwd
  mock.expireToken();
  await client.getMembers('M1');
  assert.equal(mock.calls.filter(c => c.path === '/token').length, 2);

  await assert.rejects(client.updateMember('M1', 'onbekend', { status: 'PRESENT' }), /Geen toegang \(403\)/);
  await assert.rejects(client.updateMember('M1', '19.0101.0000.0001', {}), /Ongeldige aanvraag \(400\)/);
});

test('foute secret en ontbrekende filters', async (t) => {
  const mock = createMockServer();
  const port = await mock.listen();
  t.after(() => mock.close());
  const base = `http://127.0.0.1:${port}`;
  const bad = new DirectorClient({ baseUrl: base, tokenUrl: base + '/token', clientId: 'x', clientSecret: 'fout' });
  await assert.rejects(bad.getOrgans(), /Token ophalen mislukt \(401\): Invalid client secret/);
  const noFilter = new DirectorClient({ baseUrl: base, tokenUrl: base + '/token', clientId: 'x', clientSecret: 'geheim' });
  await assert.rejects(noFilter.getMeetings(), /minstens één orgaan-ID of één vergaderstatus/);
});
