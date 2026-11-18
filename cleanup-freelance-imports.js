// Nettoyage ponctuel (18/11/2026) : des blocs de planning du calendrier Google "FreeLance"
// ont été importés à tort comme tâches TickTick (puis comme pages Notion). Pour chaque
// identifiant de cleanup-targets.json :
//   1) on retire le lien de synchro de l'évènement Google (il reste un évènement ordinaire) ;
//   2) on supprime la tâche TickTick (le miroir de sync.js archive ensuite la page Notion).
// Par défaut : essai à blanc, rien n'est modifié. EXECUTE=true pour exécuter, et seulement si
// TOUTES les cibles passent les vérifications. Le dépôt est public : les logs n'affichent que
// des identifiants courts et des statuts, jamais les titres.
const fs = require('node:fs');
const { gcalFetch, ticktickFetch, loadCalendarIdsByName, sleep } = require('./sync.js');

const TICKTICK_PROJECT_ID = '67ee6a2c8f082fe808671e39';
const CALENDAR_NAME = 'FreeLance';
const EXECUTE = process.env.EXECUTE === 'true';

async function loadEvents(calendarId) {
  const events = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      maxResults: '250', singleEvents: 'true', showDeleted: 'false',
      timeMin: '2026-11-18T00:00:00Z', timeMax: '2027-02-01T00:00:00Z',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const result = await gcalFetch(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
    events.push(...(result.items || []));
    pageToken = result.nextPageToken;
  } while (pageToken);
  return events;
}

async function diag() {
  const targetIds = JSON.parse(fs.readFileSync(`${__dirname}/cleanup-targets.json`, 'utf8'));
  const data = await ticktickFetch(`/project/${TICKTICK_PROJECT_ID}/data`);
  const inList = new Set((data.tasks || []).map((t) => t.id));
  console.log(`Tâches du projet dans la liste standard: ${inList.size}; cibles encore listées: ${targetIds.filter((id) => inList.has(id)).length}`);
  for (const id of targetIds.slice(0, 3)) {
    const task = await ticktickFetch(`/project/${TICKTICK_PROJECT_ID}/task/${id}`);
    const view = task && !task.__notFound
      ? Object.fromEntries(Object.entries(task).filter(([k]) => /^(status|deleted|kind|projectId|isAllDay|completedTime|modifiedTime|createdTime)$/.test(k)))
      : task;
    console.log(`  ${id.slice(-6)}: ${JSON.stringify(view)}`);
  }
}

async function main() {
  if (process.env.DIAG === 'true') return diag();
  const targetIds = JSON.parse(fs.readFileSync(`${__dirname}/cleanup-targets.json`, 'utf8'));
  console.log(`Mode: ${EXECUTE ? 'EXÉCUTION' : 'ESSAI À BLANC (rien n\'est modifié)'} — ${targetIds.length} cibles`);

  const calendarId = (await loadCalendarIdsByName()).get(CALENDAR_NAME);
  if (!calendarId) throw new Error(`calendrier "${CALENDAR_NAME}" introuvable`);
  const events = await loadEvents(calendarId);
  const eventsByTicktickId = new Map();
  for (const ev of events) {
    const ttId = ev.extendedProperties?.private?.ticktickId;
    if (ttId) eventsByTicktickId.set(ttId, ev);
  }
  console.log(`Calendrier ${CALENDAR_NAME}: ${events.length} évènements à partir du 18/11, dont ${eventsByTicktickId.size} liés à une tâche TickTick.`);

  const plan = [];
  let problems = 0;
  for (const id of targetIds) {
    const short = id.slice(-6);
    const task = await ticktickFetch(`/project/${TICKTICK_PROJECT_ID}/task/${id}`);
    await sleep(200);
    const ev = eventsByTicktickId.get(id);
    const taskOk = !!task && !task.__notFound;
    const titleOk = taskOk && ev && ev.summary === task.title;
    const status = [
      `tâche=${taskOk ? 'trouvée' : 'ABSENTE'}`,
      `évènement=${ev ? 'trouvé' : 'ABSENT'}`,
      `titre=${titleOk ? 'identique' : (taskOk && ev ? 'DIFFÉRENT' : 'n/a')}`,
    ];
    // Une cible est saine si l'évènement existe et que, si la tâche existe, les titres concordent.
    const ok = !!ev && (!taskOk || titleOk);
    if (!ok) problems++;
    console.log(`  ${short}: ${status.join(', ')} -> ${ok ? 'OK' : 'À EXAMINER'}`);
    plan.push({ id, short, ev, taskOk, ok });
  }

  const targetSet = new Set(targetIds);
  const untouchedLinked = [...eventsByTicktickId.keys()].filter((k) => !targetSet.has(k)).length;
  console.log(`Évènements liés hors cibles (ne seront PAS touchés): ${untouchedLinked}`);
  console.log(`Cibles OK: ${plan.filter((p) => p.ok).length}/${plan.length}, à examiner: ${problems}`);

  if (!EXECUTE) return;
  if (problems > 0) {
    console.error('Abandon : au moins une cible à examiner, aucune modification effectuée.');
    process.exit(1);
  }

  let unlinked = 0;
  let deleted = 0;
  for (const p of plan) {
    // 1) Détacher l'évènement (null supprime la clé côté Google) AVANT de supprimer la tâche.
    await gcalFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${p.ev.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ extendedProperties: { private: { ticktickId: null, syncSnapshot: null } } }),
    });
    unlinked++;
    await sleep(300);
    // 2) Supprimer la tâche TickTick (si elle existe encore).
    if (p.taskOk) {
      await ticktickFetch(`/project/${TICKTICK_PROJECT_ID}/task/${p.id}`, { method: 'DELETE' });
      deleted++;
      await sleep(300);
    }
  }
  console.log(`Évènements détachés: ${unlinked}, tâches TickTick supprimées: ${deleted}.`);

  // Vérification finale : les évènements existent toujours et ne portent plus de lien.
  const after = await loadEvents(calendarId);
  const afterById = new Map(after.map((ev) => [ev.id, ev]));
  let stillThere = 0;
  let stillLinked = 0;
  for (const p of plan) {
    const ev = afterById.get(p.ev.id);
    if (ev && ev.status !== 'cancelled') stillThere++;
    if (ev?.extendedProperties?.private?.ticktickId) stillLinked++;
  }
  console.log(`Vérification: ${stillThere}/${plan.length} évènements toujours présents dans ${CALENDAR_NAME}, ${stillLinked} encore liés.`);
  if (stillThere !== plan.length || stillLinked !== 0) process.exit(1);
}

main().catch((err) => {
  console.error('Échec du nettoyage:', err.message);
  process.exit(1);
});
