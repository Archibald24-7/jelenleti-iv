#!/usr/bin/env node
// Egyszeri, OFFLINE migráció a korábbi közös JSON-mentésből.
// A bemeneti adatokat nem küldi sehova; csak külön helyi fájlokat hoz létre.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function splitBackup(backup) {
  if (!backup || !Array.isArray(backup.users) || !Array.isArray(backup.entries)) {
    throw new Error('A mentésben users és entries tömbnek kell lennie.');
  }
  const users = backup.users;
  const emails = new Set();
  const ids = new Set();
  const entriesByUser = new Map();
  let admins = 0;

  for (const user of users) {
    const email = String(user.email || '').trim().toLowerCase();
    if (typeof user.id !== 'string' || !/^[\w-]{8,}$/.test(user.id) || !email.includes('@') ||
        ids.has(user.id) || emails.has(email) || !['admin', 'user'].includes(user.role)) {
      throw new Error('Hibás vagy ismétlődő felhasználó: ' + (email || '?'));
    }
    ids.add(user.id);
    emails.add(email);
    entriesByUser.set(user.id, []);
    if (user.role === 'admin' && !user.deleted && user.active !== false) admins++;
  }
  if (!admins) throw new Error('A mentésben nincs aktív adminisztrátor.');
  const entryIds = new Set();
  for (const entry of backup.entries) {
    if (typeof entry.id !== 'string' || entryIds.has(entry.id) || !entriesByUser.has(entry.userId)) {
      throw new Error('Hibás, ismétlődő vagy ismeretlen tulajdonosú bejegyzés.');
    }
    entryIds.add(entry.id);
    entriesByUser.get(entry.userId).push(entry);
  }

  const directory = {
    schemaVersion: 1,
    users: users.map((user) => {
      const directoryUpdatedAt = user.directoryUpdatedAt || user.updatedAt;
      return {
        id: user.id, name: user.name,
        email: String(user.email).trim().toLowerCase(),
        role: user.role, active: user.active !== false,
        deleted: !!user.deleted, createdAt: user.createdAt,
        // A linket a megfelelő "Konkrét személyek" OneDrive-mappa létrehozása
        // után az admin tölti ki a névjegyzék helyi JSON-fájljában.
        dataFolderLink: '',
        directoryUpdatedAt, updatedAt: directoryUpdatedAt,
      };
    }),
    entries: [],
    updatedAt: new Date().toISOString(),
  };
  const personal = users.map((user) => ({
    id: user.id,
    email: String(user.email).trim().toLowerCase(),
    file: `users/${user.id}/jelenleti-adatok.json`,
    data: {
      schemaVersion: 1,
      users: [{
        ...user, email: String(user.email).trim().toLowerCase(),
        directoryUpdatedAt: user.directoryUpdatedAt || user.updatedAt,
        profileUpdatedAt: user.profileUpdatedAt || user.updatedAt,
      }],
      entries: entriesByUser.get(user.id),
      updatedAt: new Date().toISOString(),
    },
  }));
  return { directory, personal, count: backup.entries.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error('Használat: node tools/split-backup.mjs <mentes.json> <uj-ures-kimeneti-mappa>');
    process.exitCode = 2;
  } else {
    try {
      const backup = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
      const result = splitBackup(backup);
      const output = resolve(outputPath);
      await mkdir(join(output, 'directory'), { recursive: true, mode: 0o700 });
      await mkdir(join(output, 'users'), { recursive: true, mode: 0o700 });
      const json = (data) => JSON.stringify(data, null, 2) + '\n';
      await writeFile(join(output, 'directory', 'felhasznalok.json'), json(result.directory), { flag: 'wx', mode: 0o600 });
      for (const person of result.personal) {
        const folder = join(output, 'users', person.id);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await writeFile(join(folder, 'jelenleti-adatok.json'), json(person.data), { flag: 'wx', mode: 0o600 });
      }
      await writeFile(join(output, 'mapping.json'), json(result.personal.map(({ id, email, file }) => ({ id, email, file }))), { flag: 'wx', mode: 0o600 });
      console.log(`Átalakítva: ${result.personal.length} felhasználó, ${result.count} bejegyzés. A kimenetet NE töltsd fel GitHubra.`);
    } catch (error) {
      console.error('Az átalakítás nem sikerült: ' + error.message);
      process.exitCode = 1;
    }
  }
}
