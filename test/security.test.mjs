import test from 'node:test';
import assert from 'node:assert/strict';
import { splitBackup } from '../tools/split-backup.mjs';
import { directoryRecord, mergeDirectoryRecords, mergeUserProfile, assertUserFileOwnership, selectSyncUsers } from '../js/sync.js';

const adam = {
  id: '11111111-1111-4111-8111-111111111111', email: 'adam@humanmachine.hu',
  name: 'Admin', role: 'admin', active: true, breakRules: [{ from: '2026-01-01', minutes: 30 }],
  dataFolderLink: 'https://example.sharepoint.com/admin-folder',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
};
const bea = {
  id: '22222222-2222-4222-8222-222222222222', email: 'bea@humanmachine.hu',
  name: 'Bea', role: 'user', active: true, breakRules: [],
  dataFolderLink: 'https://example.sharepoint.com/bea-folder',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
};

test('A migráció személyenként szétválasztja a rekordokat, és nem veszít adatot', () => {
  const backup = { users: [adam, bea], entries: [
    { id: 'e1', userId: adam.id, updatedAt: '2026-01-02T00:00:00Z' },
    { id: 'e2', userId: bea.id, updatedAt: '2026-01-02T00:00:00Z' },
  ] };
  const result = splitBackup(backup);
  assert.equal(result.directory.users.length, 2);
  assert.equal(result.directory.entries.length, 0);
  assert.equal(result.directory.users[0].breakRules, undefined);
  assert.equal(result.directory.users[0].dataFolderLink, '');
  assert.deepEqual(result.personal.map((p) => p.data.entries.length), [1, 1]);
  assert.equal(result.personal[0].data.users[0].profileUpdatedAt, adam.updatedAt);
  assert.equal(result.personal.reduce((sum, p) => sum + p.data.entries.length, 0), backup.entries.length);
});

test('A migráció idegen rekordot és ismétlődő azonosítót elutasít', () => {
  assert.throws(() => splitBackup({ users: [adam], entries: [{ id: 'e1', userId: 'invalid' }] }));
  assert.throws(() => splitBackup({ users: [adam, adam], entries: [] }));
});

test('A névjegyzék nem tartalmazhat személyes szünetszabályokat', () => {
  const record = directoryRecord(adam);
  assert.equal(record.breakRules, undefined);
  assert.equal(record.dataFolderLink, adam.dataFolderLink);
  assert.equal(record.role, 'admin');
});

test('Nem admin nem emelheti a saját szerepkörét a névjegyzékben', () => {
  const remote = directoryRecord(bea);
  const tampered = { ...bea, role: 'admin', directoryUpdatedAt: '2099-01-01T00:00:00Z' };
  assert.equal(mergeDirectoryRecords([remote], [tampered], false)[0].role, 'user');
});

test('Normál dolgozó csak saját fájlt szinkronizálhat, admin az összeset', () => {
  const directory = [directoryRecord(adam), directoryRecord(bea)];
  assert.deepEqual(selectSyncUsers(directory, 'bea@humanmachine.hu').targets.map((u) => u.id), [bea.id]);
  assert.deepEqual(selectSyncUsers(directory, 'adam@humanmachine.hu').targets.map((u) => u.id), [adam.id, bea.id]);
  assert.throws(() => selectSyncUsers(directory, 'idegen@humanmachine.hu'));
  assert.throws(() => selectSyncUsers([{ ...directory[1], active: false }], 'bea@humanmachine.hu'));
});

test('Az admin újabb, explicit névjegyzékváltozása menthető', () => {
  const remote = directoryRecord(bea);
  const changed = { ...bea, active: false, directoryUpdatedAt: '2026-02-01T00:00:00Z' };
  assert.equal(mergeDirectoryRecords([remote], [changed], true)[0].active, false);
});

test('A profilból hamisított admin szerepkör soha nem írja felül a névjegyzéket', () => {
  const remote = { ...bea, role: 'admin', profileUpdatedAt: '2026-03-01T00:00:00Z' };
  const merged = mergeUserProfile(directoryRecord(bea), null, remote);
  assert.equal(merged.role, 'user');
});

test('Személyes adatfájlban idegen felhasználó rekordja tiltott', () => {
  assert.doesNotThrow(() => assertUserFileOwnership({ users: [bea], entries: [{ userId: bea.id }] }, bea.id));
  assert.throws(() => assertUserFileOwnership({ users: [bea], entries: [{ userId: adam.id }] }, bea.id));
  assert.throws(() => assertUserFileOwnership({ users: [adam], entries: [] }, bea.id));
});
