// Tests du garde-fou "fenêtre de création" (node --test). Aucun appel réseau.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dateOverwrittenAfterCreation, CREATION_GRACE_MS } = require('./sync.js');

const NOW = Date.parse('2026-10-07T07:10:00Z');
const snap = (date, extra = {}) =>
  JSON.stringify({ title: 'Présentiel', date, tags: [], description: '', checked: false, projet: 'p', priority: 'Aucune', ...extra });
const pageCreatedAgo = (ms) => ({ created_time: new Date(NOW - ms).toISOString() });

test("date écrasée par un automatisme juste après la création -> restaurée", () => {
  const stored = snap('2026-10-21');
  const res = dateOverwrittenAfterCreation({
    page: pageCreatedAgo(5 * 60 * 1000), stored, notionSnapshot: snap('2026-10-07'), ticktickSnapshot: stored, now: NOW,
  });
  assert.deepEqual(res, { restoreDate: '2026-10-21' });
});

test('date mémorisée absente, ajoutée par un automatisme -> restaurée à null', () => {
  const stored = snap(null);
  const res = dateOverwrittenAfterCreation({
    page: pageCreatedAgo(60 * 1000), stored, notionSnapshot: snap('2026-10-07'), ticktickSnapshot: stored, now: NOW,
  });
  assert.deepEqual(res, { restoreDate: null });
});

test('page plus ancienne que la fenêtre : modification Notion = édition humaine, flux normal', () => {
  const stored = snap('2026-10-21');
  const res = dateOverwrittenAfterCreation({
    page: pageCreatedAgo(CREATION_GRACE_MS + 1), stored, notionSnapshot: snap('2026-10-07'), ticktickSnapshot: stored, now: NOW,
  });
  assert.equal(res, undefined);
});

test('TickTick a aussi changé : conflit, TickTick gagne par le flux normal', () => {
  const stored = snap('2026-10-21');
  const res = dateOverwrittenAfterCreation({
    page: pageCreatedAgo(60 * 1000), stored, notionSnapshot: snap('2026-10-07'), ticktickSnapshot: snap('2026-10-25'), now: NOW,
  });
  assert.equal(res, undefined);
});

test('seul un autre champ change dans la fenêtre (ex. titre) : flux normal', () => {
  const stored = snap('2026-10-21');
  const res = dateOverwrittenAfterCreation({
    page: pageCreatedAgo(60 * 1000), stored, notionSnapshot: snap('2026-10-21', { title: 'Autre' }), ticktickSnapshot: stored, now: NOW,
  });
  assert.equal(res, undefined);
});

test('rien n\'a changé : pas de garde-fou', () => {
  const stored = snap('2026-10-21');
  const res = dateOverwrittenAfterCreation({
    page: pageCreatedAgo(60 * 1000), stored, notionSnapshot: stored, ticktickSnapshot: stored, now: NOW,
  });
  assert.equal(res, undefined);
});

test('empreinte jamais mémorisée ou illisible, ou created_time absent : flux normal', () => {
  const stored = snap('2026-10-21');
  assert.equal(
    dateOverwrittenAfterCreation({ page: pageCreatedAgo(1000), stored: null, notionSnapshot: snap('2026-10-07'), ticktickSnapshot: stored, now: NOW }),
    undefined
  );
  assert.equal(
    dateOverwrittenAfterCreation({ page: pageCreatedAgo(1000), stored: '{pas du json', notionSnapshot: snap('2026-10-07'), ticktickSnapshot: '{pas du json', now: NOW }),
    undefined
  );
  assert.equal(
    dateOverwrittenAfterCreation({ page: {}, stored, notionSnapshot: snap('2026-10-07'), ticktickSnapshot: stored, now: NOW }),
    undefined
  );
});

// ---------- Routage des tâches vers les calendriers Google ----------
const { taskBelongsToCalendar } = require('./sync.js');

const projectIndex = { byNormalizedTitle: new Map([['amge', 'id-amge'], ['anabasis', 'id-ana'], ['prepass', 'id-prepass']]) };
const TODO = { name: 'Freelance To Do', schema: 'freelanceTasks' };
const AMGE = { name: 'Freelance AMGE - ENOVEA', schema: 'freelanceTasks', projectMatchKey: 'amge' };
const PERSO = { name: 'To Do List', schema: 'personnel' };
const timed = (tags = []) => ({ isAllDay: false, tags });
const allDay = (tags = []) => ({ isAllDay: true, tags });

test('Freelance To Do : tâches sans projet précis, avec OU sans horaire', () => {
  assert.equal(taskBelongsToCalendar(timed(), TODO, projectIndex), true);
  assert.equal(taskBelongsToCalendar(allDay(), TODO, projectIndex), true);
});

test('Freelance To Do : le tag "anabasis" (projet par défaut) reste dans le lot', () => {
  assert.equal(taskBelongsToCalendar(timed(['anabasis']), TODO, projectIndex), true);
  assert.equal(taskBelongsToCalendar(allDay(['Anabasis']), TODO, projectIndex), true);
});

test('Une tâche à projet client précis va dans son calendrier, pas dans Freelance To Do', () => {
  assert.equal(taskBelongsToCalendar(timed(['amge']), AMGE, projectIndex), true);
  assert.equal(taskBelongsToCalendar(allDay(['amge']), AMGE, projectIndex), true);
  assert.equal(taskBelongsToCalendar(timed(['amge']), TODO, projectIndex), false);
  assert.equal(taskBelongsToCalendar(timed(['prepass']), TODO, projectIndex), false);
  assert.equal(taskBelongsToCalendar(timed(), AMGE, projectIndex), false);
});

test('Personnel : toutes les tâches vont dans To Do List', () => {
  assert.equal(taskBelongsToCalendar(timed(), PERSO, projectIndex), true);
  assert.equal(taskBelongsToCalendar(allDay(['amge']), PERSO, projectIndex), true);
});

// ---------- Empreinte : plafond de taille imposé par Notion (rich_text <= 2000) ----------
const { snapshotOf } = require('./sync.js');

const base = { title: 'Tâche', date: '2026-11-19', tags: ['b', 'a'], checked: false, projet: 'p', priority: 'Aucune' };
// Pire cas : description de 1900 caractères pleine de retours à la ligne et de guillemets,
// que l'échappement JSON double presque (c'est ce qui a fait échouer la synchro le 18/11/2026).
const longDescription = ('Ligne "citée"\n').repeat(200).slice(0, 1900);

test('empreinte courte : identique à l\'ancien format (compatibilité des empreintes stockées)', () => {
  const fields = { ...base, description: 'courte' };
  assert.equal(
    snapshotOf(fields),
    JSON.stringify({ title: 'Tâche', date: '2026-11-19', tags: ['a', 'b'], description: 'courte', checked: false, projet: 'p', priority: 'Aucune' })
  );
});

test('longue description à échappements : empreinte valide sous la limite de 2000 caractères de Notion', () => {
  const snap = snapshotOf({ ...base, description: longDescription });
  assert.ok(snap.length <= 1900, `longueur ${snap.length}`);
  assert.doesNotThrow(() => JSON.parse(snap));
});

test("longue description : déterministe, et une modification en fin de texte change l'empreinte", () => {
  const a = snapshotOf({ ...base, description: longDescription });
  assert.equal(a, snapshotOf({ ...base, description: longDescription }));
  const b = snapshotOf({ ...base, description: longDescription.slice(0, -1) + 'X' });
  assert.notEqual(a, b);
});

test('titre démesuré : toujours sous la limite (repli sur un hachage)', () => {
  const snap = snapshotOf({ ...base, title: 'T'.repeat(5000), description: longDescription });
  assert.ok(snap.length <= 2000, `longueur ${snap.length}`);
});
