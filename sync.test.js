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
