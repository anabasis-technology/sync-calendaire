// Synchronisation bidirectionnelle TickTick <-> Notion (projet "Sync Calendaire")
//
// Détection des changements par empreinte de contenu, pas par horodatage. Deux raisons :
// - Notion arrondit last_edited_time à la seconde : deux écritures rapprochées (la nôtre,
//   puis un humain) peuvent tomber sur la même seconde et rendre le changement invisible.
// - TickTick ne met pas toujours à jour modifiedTime après une modification via l'API
//   (constaté empiriquement) : ce champ n'est pas fiable comme unique signal de changement.
// Chaque page Notion stocke donc "Sync Snapshot" : une empreinte JSON des champs
// synchronisables (titre, date, tags, description, coché, projet) telle qu'on l'a vue en
// dernier, des DEUX côtés à la fois puisqu'à l'équilibre TickTick et Notion doivent produire
// la même empreinte. Si l'empreinte TickTick actuelle diffère de la mémorisée -> TickTick a
// changé. Si l'empreinte Notion actuelle diffère -> Notion a changé. Si les deux diffèrent
// (conflit rare, édité des deux côtés dans la même fenêtre de 5 min) : TickTick gagne, par
// convention simple et documentée plutôt que de deviner qui est "le plus récent".
//
// "Freelance" ne va PAS dans ⚡ Workflow (qui liste des projets, pas des tâches) mais dans
// "Tâches Freelance", une base dédiée. Un tag TickTick qui correspond au nom d'un projet
// existant dans ⚡ Workflow relie automatiquement la tâche à ce projet (et inversement :
// lier la relation "Projet" dans Notion ajoute le tag correspondant côté TickTick).
//
// Limite connue et assumée : si une tâche TickTick est supprimée, la page Notion
// correspondante est archivée (miroir). L'inverse n'est pas fait : archiver une page dans
// Notion ne supprime jamais la tâche TickTick — TickTick reste la donnée de référence, on
// ne prend pas le risque de supprimer sa source de vérité sur la foi d'un état Notion.
//
// Garde-fou : une page Notion sans TickTick ID n'est JAMAIS poussée vers TickTick à moins
// que la case "→ TickTick" soit cochée explicitement. Sans ce garde-fou, une base utilisée
// pour autre chose que ce sync (des années de notes perso pré-existantes, par exemple)
// verrait tout son contenu historique dupliqué dans TickTick au premier passage — c'est
// exactement ce qui s'est produit avant l'ajout de ce garde-fou, sur la base Personnel.

const TICKTICK_TOKEN = process.env.TICKTICK_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const NOTION_VERSION = '2025-09-03';
const DEFAULT_TIMEZONE = 'Europe/Paris';
const ORPHAN_PUSH_FLAG_PROP = '→ TickTick';
const MAX_ORPHAN_PUSH_PER_RUN = 5;
const MAX_NEW_PROJECTS_PER_RUN = 3;
const MAX_GCAL_DELETIONS_PER_RUN = 5;
const MAX_GCAL_INCOMING_PER_RUN = 5;
// Un évènement GCal encore loin dans le futur (ex. la 50e occurrence d'une série
// récurrente) n'a pas besoin d'exister comme tâche TickTick tout de suite : seules les
// occurrences dans cette fenêtre sont importées, le reste suit au fil des passages suivants
// à mesure qu'elles s'en approchent (incident constaté le 27/08/2026 : sans cette fenêtre,
// une série "Publisher of the week" a créé 39 tâches en un seul passage avant d'être stoppée).
const GCAL_INCOMING_LOOKAHEAD_DAYS = 14;

// Un TickTick <-> Google Calendar par calendrier, TickTick restant le relais central (une
// modif dans Notion remonte à TickTick puis redescend vers GCal, et inversement). Périmètre
// volontairement limité à "aujourd'hui et après" des deux côtés : ni import de l'historique
// des calendriers (des séries récurrentes vieilles de plusieurs années y vivent, cf. page
// Notion du projet), ni tâche TickTick en retard poussée vers GCal. Une tâche qui devient
// en retard voit simplement son évènement GCal disparaître.
const GCAL_CALENDARS = [
  { name: 'Freelance AMGE - ENOVEA', ticktickProjectId: '67ee6a2c8f082fe808671e39', schema: 'freelanceTasks', projectMatchKey: 'amge' },
  { name: 'FreeLance', ticktickProjectId: '67ee6a2c8f082fe808671e39', schema: 'freelanceTasks', timedOnly: true },
  { name: 'Freelance To Do', ticktickProjectId: '67ee6a2c8f082fe808671e39', schema: 'freelanceTasks', timedOnly: false },
  { name: 'To Do List', ticktickProjectId: '67ee6a2c8f082fe808671e3c', schema: 'personnel' },
];

const WORKFLOW_DATA_SOURCE_ID = '2f0ab52f-34f1-80b8-b9ce-000b7a24fb71';
// Projet "fourre-tout" (créé le 27/08/2026) : une tâche freelance sans tag correspondant à
// un projet client précis est du travail interne Anabasis quand même — jamais "sans projet".
const DEFAULT_PROJECT_ID = '3c9ab52f-34f1-8123-b297-cbade90bd3e6'; // page "Anabasis" dans Workflow

const PROJECTS = [
  {
    name: 'Freelance <-> Tâches Freelance',
    ticktickProjectId: '67ee6a2c8f082fe808671e39',
    notionDataSourceId: 'bf6dd6cd-3ac2-49d8-aeca-35a61f40a1c5',
    schema: 'freelanceTasks',
    matchProjects: true,
    // Base neuve, dédiée à ce sync : pas des années de notes perso pré-existantes à risque
    // de se faire aspirer (c'est précisément ce qui s'est produit sur Personnel). Une page
    // sans TickTick ID y est donc automatiquement poussée, sans case à cocher à activer.
    autoCreateWithoutFlag: true,
  },
  {
    name: 'Personnel <-> Personnel',
    ticktickProjectId: '67ee6a2c8f082fe808671e3c',
    notionDataSourceId: '24eab52f-34f1-8152-92af-000b75158c4a',
    schema: 'personnel',
    matchProjects: false,
    // Le backlog historique (247 pages cochées + doublons) a été déplacé vers la base
    // "Archives Perso Historique" le 27/08/2026 : la base ne contient plus que des tâches
    // actives, la création automatique est donc sûre ici aussi (voir page Notion du projet).
    autoCreateWithoutFlag: true,
  },
];

// TickTick renvoie/attend des tags en minuscules ; on les remappe vers les options exactes
// (avec accents/casse) configurées côté Notion, et inversement.
const TAG_MAP = {
  // Clés = forme normalize() du tag TickTick (sans accent) ; valeurs = libellé affiché dans
  // le multi-select Notion. Une clé accentée ici ne matcherait jamais (bug constaté le
  // 27/08/2026 : "comptabilité" était silencieusement ignoré depuis la mise en place du sync).
  // "anabasis" volontairement absent ici : c'est un nom de projet Workflow (comme "brainup"
  // ou "prepass"), jamais une étiquette générique, sur Tâches Freelance — un tag ne peut
  // relier qu'un seul projet à la fois, jamais aussi apparaître dans Tags (règle confirmée
  // le 27/08/2026). Reste une étiquette générique valide côté Personnel (pas de notion de
  // projet là-bas), volontairement laissé tel quel juste en dessous.
  freelanceTasks: { comptabilite: 'Comptabilité', bug: 'BUG', finance: 'Finance', adm: 'ADM', article: 'Article' },
  personnel: { gcal: 'GCal', adm: 'ADM', anabasis: 'Anabasis', finance: 'Finance', comptabilite: 'Comptabilité', bug: 'BUG' },
};

// Échelle TickTick standard (identique dans toutes leurs apps) : 0/1/3/5, jamais 2/4.
// Vérifié sur données réelles le 27/08/2026 (priority:3 = "Medium Priority" et priority:5 =
// "High Priority" dans l'ancien système). Uniquement sur Tâches Freelance pour l'instant.
const PRIORITY_TO_NOTION = { 0: 'Aucune', 1: 'Basse', 3: 'Moyenne', 5: 'Haute' };
const PRIORITY_FROM_NOTION = { Aucune: 0, Basse: 1, Moyenne: 3, Haute: 5 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(str) {
  return String(str).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

async function ticktickFetch(path, options = {}) {
  const res = await fetch(`https://api.ticktick.com/open/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TICKTICK_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 404) return { __notFound: true };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TickTick API a répondu ${res.status}${body ? ` (${body.slice(0, 150)})` : ''}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function notionFetch(path, options = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Notion API a répondu ${res.status}${body ? ` (${body.slice(0, 150)})` : ''}`);
  }
  return res.json();
}

let cachedGoogleAccessToken = null;
async function getGoogleAccessToken() {
  if (cachedGoogleAccessToken) return cachedGoogleAccessToken;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`rafraîchissement du jeton Google a échoué: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedGoogleAccessToken = data.access_token;
  return cachedGoogleAccessToken;
}

async function gcalFetch(path, options = {}) {
  const token = await getGoogleAccessToken();
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google Calendar API a répondu ${res.status}${body ? ` (${body.slice(0, 150)})` : ''}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------- Dates : TickTick (instant UTC "journée entière") <-> Notion (date locale) ----------

function ticktickAllDayToNotionDate(isoUtc, timeZone) {
  return new Date(isoUtc).toLocaleDateString('en-CA', { timeZone: timeZone || DEFAULT_TIMEZONE });
}

function getTimeZoneOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asUTC - date.getTime()) / 60000;
}

function notionDateToTicktickAllDay(dateStr, timeZone) {
  const tz = timeZone || DEFAULT_TIMEZONE;
  const referenceUtc = new Date(`${dateStr}T12:00:00Z`);
  const offsetMin = getTimeZoneOffsetMinutes(referenceUtc, tz);
  const [y, m, d] = dateStr.split('-').map(Number);
  const localMidnightUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMin * 60000;
  return new Date(localMidnightUtcMs).toISOString().replace(/\.\d{3}Z$/, '+0000');
}

function notionDateTimeToTicktickInstant(isoWithOffset) {
  return new Date(isoWithOffset).toISOString().replace(/\.\d{3}Z$/, '+0000');
}

function addDaysToDateString(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function isBeforeToday(isoInstant) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return new Date(isoInstant) < startOfToday;
}

// TickTick ("...+0000") et Notion ("...+00:00") sérialisent le même instant avec un
// décalage horaire écrit différemment (deux-points ou non) : comparer ces chaînes brutes
// pour une tâche avec horaire précis ne s'équilibre jamais, même à contenu strictement
// identique (bug constaté le 27/08/2026, la première tâche freelance à horaire réel ayant
// jamais transité par ce chemin — jusque-là tout passait par la branche "journée entière",
// déjà correcte). On canonicalise donc systématiquement tout instant avant de le comparer
// ou de le stocker dans une empreinte, qu'elle soit côté Notion<->TickTick ou GCal.
function canonicalInstant(value) {
  return new Date(value).toISOString();
}

// ---------- Lecture des projets ⚡ Workflow (pour la relation Projet) ----------

async function loadWorkflowProjects() {
  const byNormalizedTitle = new Map();
  const titleById = new Map();
  let cursor;
  do {
    const result = await notionFetch(`/data_sources/${WORKFLOW_DATA_SOURCE_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
    });
    for (const page of result.results) {
      // Propriété titre renommée "Nom" -> "Nom du projet" le 27/08/2026 (constaté en
      // tentant de créer une page) : ce champ pointait dans le vide depuis, la mise en
      // relation Projet ne fonctionnait donc plus silencieusement (aucune erreur levée).
      const title = page.properties?.['Nom du projet']?.title?.[0]?.plain_text;
      if (title) {
        byNormalizedTitle.set(normalize(title), page.id);
        titleById.set(page.id, title);
      }
    }
    cursor = result.has_more ? result.next_cursor : undefined;
    await sleep(300);
  } while (cursor);
  return { byNormalizedTitle, titleById };
}

// Une étiquette TickTick qui ne correspond à aucun projet Workflow existant ni à un tag
// générique connu (TAG_MAP) est traitée comme un projet manquant : on la crée dans Workflow
// à la volée, pour ne pas avoir à créer le projet à la main avant de pouvoir tagger une tâche.
// Plafonné comme les autres créations en masse, par précaution (voir incident orphelins).
async function createMissingWorkflowProjects(tasks, projectIndex, schema) {
  if (!projectIndex) return 0;
  const tagMap = TAG_MAP[schema] || {};
  const seen = new Set();
  let created = 0;
  for (const task of tasks) {
    for (const tag of task.tags || []) {
      const key = normalize(tag);
      if (seen.has(key) || projectIndex.byNormalizedTitle.has(key) || tagMap[key]) continue;
      seen.add(key);
      if (created >= MAX_NEW_PROJECTS_PER_RUN) {
        console.error(`Nouvelle étiquette TickTick "${tag}" ignorée : plafond de ${MAX_NEW_PROJECTS_PER_RUN} nouveaux projets Workflow par passage atteint.`);
        continue;
      }
      const result = await notionFetch('/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { type: 'data_source_id', data_source_id: WORKFLOW_DATA_SOURCE_ID },
          properties: { 'Nom du projet': { title: [{ text: { content: tag } }] } },
        }),
      });
      projectIndex.byNormalizedTitle.set(key, result.id);
      projectIndex.titleById.set(result.id, tag);
      created++;
      console.log(`Nouveau projet Workflow créé depuis l'étiquette TickTick "${tag}".`);
      await sleep(300);
    }
  }
  return created;
}

async function loadAllPages(dataSourceId) {
  const pages = [];
  let cursor;
  do {
    const result = await notionFetch(`/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
    });
    pages.push(...result.results);
    cursor = result.has_more ? result.next_cursor : undefined;
    await sleep(300);
  } while (cursor);
  return pages;
}

// ---------- Helpers de lecture de page Notion ----------

function pageTitleProp(schema) {
  return schema === 'freelanceTasks' ? 'Nom' : 'Title';
}
function pageDateProp(schema) {
  return schema === 'freelanceTasks' ? 'Due Date' : 'Date';
}
function getTitle(page, schema) {
  return page.properties?.[pageTitleProp(schema)]?.title?.[0]?.plain_text || '';
}
function getTicktickId(page) {
  return page.properties?.['TickTick ID']?.rich_text?.[0]?.plain_text || '';
}
function getDescription(page) {
  return page.properties?.Description?.rich_text?.[0]?.plain_text || '';
}
function getTags(page) {
  return (page.properties?.Tags?.multi_select || []).map((t) => t.name);
}
function getChecked(page) {
  return Boolean(page.properties?.Checkbox?.checkbox);
}
function getProjetRelationId(page) {
  return page.properties?.Projet?.relation?.[0]?.id || null;
}
function getPriority(page, schema) {
  if (schema !== 'freelanceTasks') return null;
  return page.properties?.Priorité?.select?.name || 'Aucune';
}
function getStoredSnapshot(page) {
  return page.properties?.['Sync Snapshot']?.rich_text?.[0]?.plain_text || null;
}

// ---------- Empreintes de contenu ----------
// Même forme des deux côtés : à l'équilibre, computeNotionSnapshot(page) ===
// computeTicktickSnapshot(task). C'est ce qui permet de détecter "qui a changé" sans
// dépendre d'un horodatage d'aucun des deux systèmes.

function snapshotOf({ title, date, tags, description, checked, projet, priority }) {
  return JSON.stringify({ title, date, tags: tags.slice().sort(), description, checked, projet, priority });
}

function computeNotionSnapshot(page, schema) {
  const dateValue = page.properties?.[pageDateProp(schema)]?.date;
  // Notion sérialise un horaire en "+00:00" (deux-points) ; TickTick en "+0000" (voir
  // canonicalInstant). Ne canoniser que si un horaire est présent : une date seule
  // ("2026-08-27") ne doit pas se voir attribuer artificiellement un horaire minuit.
  const dateStart = dateValue ? (dateValue.start.includes('T') ? canonicalInstant(dateValue.start) : dateValue.start) : null;
  return snapshotOf({
    title: getTitle(page, schema),
    date: dateStart,
    tags: getTags(page),
    description: getDescription(page),
    checked: getChecked(page),
    projet: schema === 'freelanceTasks' ? getProjetRelationId(page) : null,
    priority: getPriority(page, schema),
  });
}

function splitTagsAndProject(taskTags, schema, projectIndex) {
  const genericTags = [];
  let projectPageId = null;
  if (taskTags && taskTags.length) {
    const map = TAG_MAP[schema] || {};
    for (const tag of taskTags) {
      const key = normalize(tag);
      if (projectIndex && !projectPageId && projectIndex.byNormalizedTitle.has(key)) {
        projectPageId = projectIndex.byNormalizedTitle.get(key);
        continue;
      }
      const mapped = map[key];
      if (mapped && !genericTags.includes(mapped)) genericTags.push(mapped);
    }
  }
  return { genericTags, projectPageId };
}

function ticktickDerivedFields(task, schema, projectIndex) {
  const { genericTags, projectPageId } = splitTagsAndProject(task.tags, schema, projectIndex);
  const rawDate = task.dueDate || task.startDate;
  const dateStart = rawDate
    ? (task.isAllDay ? ticktickAllDayToNotionDate(rawDate, task.timeZone) : canonicalInstant(rawDate))
    : null;
  return {
    title: task.title || '(sans titre)',
    date: dateStart,
    tags: genericTags,
    description: (task.content || task.desc || '').slice(0, 1900),
    // task.completedTime n'est PAS un indicateur d'état courant : TickTick ne l'efface pas
    // quand on rouvre une tâche (vérifié empiriquement). Seul task.status fait foi.
    checked: task.status === 2,
    projet: schema === 'freelanceTasks' ? (projectPageId || DEFAULT_PROJECT_ID) : null,
    priority: schema === 'freelanceTasks' ? (PRIORITY_TO_NOTION[task.priority] || 'Aucune') : null,
  };
}

function computeTicktickSnapshot(task, schema, projectIndex) {
  return snapshotOf(ticktickDerivedFields(task, schema, projectIndex));
}

// Une tâche complétée dans TickTick n'a plus d'intérêt à rester visible dans Notion (confirmé
// par l'utilisateur le 27/08/2026, sur Tâches Freelance et Personnel) : on archive sa page
// plutôt que de simplement cocher la case. TickTick reste seul à garder l'historique des
// tâches terminées ; archiver ici n'y touche jamais (voir limite "Suppression Notion ->
// TickTick" du README).
async function pushTicktickStateToNotion(task, page, project, projectIndex, stats) {
  if (task.status === 2) {
    await notionFetch(`/pages/${page.id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
    stats.archived++;
  } else {
    const properties = buildNotionPropertiesFromTask(task, project.schema, projectIndex);
    await notionFetch(`/pages/${page.id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
    stats.toNotionUpdated++;
  }
}

// ---------- Construction des propriétés Notion à partir d'une tâche TickTick ----------

function buildNotionPropertiesFromTask(task, schema, projectIndex) {
  const fields = ticktickDerivedFields(task, schema, projectIndex);
  const titleProp = pageTitleProp(schema);
  const dateProp = pageDateProp(schema);

  const properties = {
    [titleProp]: { title: [{ text: { content: fields.title } }] },
    'TickTick ID': { rich_text: [{ text: { content: task.id } }] },
    Source: { select: { name: 'TickTick' } },
    Tags: { multi_select: fields.tags.map((name) => ({ name })) },
    Checkbox: { checkbox: fields.checked },
    Description: { rich_text: fields.description ? [{ text: { content: fields.description } }] : [] },
    [dateProp]: { date: fields.date ? { start: fields.date } : null },
    'Sync Snapshot': { rich_text: [{ text: { content: snapshotOf(fields) } }] },
  };

  if (schema === 'freelanceTasks') {
    properties.Projet = { relation: fields.projet ? [{ id: fields.projet }] : [] };
    properties.Priorité = { select: { name: fields.priority } };
  }

  return properties;
}

// ---------- Construction du payload TickTick à partir d'une page Notion ----------

// TickTick stocke certains tags accentués (ex. "comptabilité", "prépass"). normalize() les
// dénormalise volontairement pour un matching robuste, mais renvoyer cette forme "nue" vers
// TickTick créerait un tag frère sans accent au lieu de réutiliser l'existant. On préfère
// donc l'orthographe déjà vue dans les tâches TickTick chargées, quand elle existe.
function buildKnownTagSpellings(tasks) {
  const spellings = new Map();
  for (const task of tasks) {
    for (const tag of task.tags || []) {
      const key = normalize(tag);
      if (!spellings.has(key)) spellings.set(key, tag);
    }
  }
  return spellings;
}

function preferredTagSpelling(tag, knownTagSpellings) {
  const key = normalize(tag);
  return (knownTagSpellings && knownTagSpellings.get(key)) || key;
}

function buildTicktickPayloadFromPage(page, schema, projectIndex, knownTagSpellings) {
  const title = getTitle(page, schema);
  const description = getDescription(page);
  const genericTags = getTags(page).map((t) => preferredTagSpelling(t, knownTagSpellings));
  const tags = [...genericTags];

  if (schema === 'freelanceTasks' && projectIndex) {
    const projetId = getProjetRelationId(page);
    if (projetId && projectIndex.titleById.has(projetId)) {
      const projectTag = preferredTagSpelling(projectIndex.titleById.get(projetId), knownTagSpellings);
      if (!tags.includes(projectTag)) tags.push(projectTag);
    }
  }

  const payload = { title: title || '(sans titre)', content: description, tags, timeZone: DEFAULT_TIMEZONE };
  if (schema === 'freelanceTasks') {
    payload.priority = PRIORITY_FROM_NOTION[getPriority(page, schema)] ?? 0;
  }

  const dateValue = page.properties?.[pageDateProp(schema)]?.date;
  if (dateValue && dateValue.start) {
    const hasTime = dateValue.start.includes('T');
    if (hasTime) {
      payload.isAllDay = false;
      payload.startDate = notionDateTimeToTicktickInstant(dateValue.start);
      payload.dueDate = payload.startDate;
    } else {
      payload.isAllDay = true;
      payload.startDate = notionDateToTicktickAllDay(dateValue.start, DEFAULT_TIMEZONE);
      payload.dueDate = payload.startDate;
    }
  }

  return payload;
}

// ---------- Google Calendar : lecture des calendriers, empreintes, routage ----------

async function loadCalendarIdsByName() {
  const byName = new Map();
  let pageToken;
  do {
    const params = new URLSearchParams({ maxResults: '250' });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await gcalFetch(`/users/me/calendarList?${params}`);
    for (const cal of data.items || []) byName.set(cal.summary, cal.id);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return byName;
}

function gcalEventFields(event) {
  const isAllDay = !!(event.start?.date && !event.start?.dateTime);
  return {
    title: event.summary || '(sans titre)',
    isAllDay,
    start: isAllDay ? event.start.date : canonicalInstant(event.start.dateTime),
    end: isAllDay ? event.end.date : canonicalInstant(event.end.dateTime),
  };
}

function gcalSnapshotOf(fields) {
  return JSON.stringify({ title: fields.title, isAllDay: fields.isAllDay, start: fields.start, end: fields.end });
}

function gcalEventBody(fields) {
  if (fields.isAllDay) {
    return { summary: fields.title, start: { date: fields.start }, end: { date: fields.end } };
  }
  return {
    summary: fields.title,
    start: { dateTime: fields.start, timeZone: fields.timeZone || DEFAULT_TIMEZONE },
    end: { dateTime: fields.end, timeZone: fields.timeZone || DEFAULT_TIMEZONE },
  };
}

// Traduit une tâche TickTick en champs comparables à un évènement GCal. Retourne null si la
// tâche n'a pas de date, ou si sa date est passée (une tâche en retard sort du périmètre du
// miroir GCal plutôt que d'y laisser un évènement obsolète).
function ticktickToGcalFields(task) {
  const rawStart = task.startDate || task.dueDate;
  if (!rawStart) return null;
  if (task.isAllDay) {
    const dateStr = ticktickAllDayToNotionDate(rawStart, task.timeZone);
    if (isBeforeToday(`${dateStr}T00:00:00`)) return null;
    return { title: task.title || '(sans titre)', isAllDay: true, start: dateStr, end: addDaysToDateString(dateStr, 1) };
  }
  if (isBeforeToday(rawStart)) return null;
  const start = canonicalInstant(rawStart);
  let end = canonicalInstant(task.dueDate || task.startDate);
  if (end === start) {
    // Pas de vraie durée côté TickTick : créneau de 30 min par défaut, uniquement pour
    // l'affichage GCal (ne modifie rien côté TickTick/Notion).
    end = canonicalInstant(new Date(rawStart).getTime() + 30 * 60000);
  }
  return { title: task.title || '(sans titre)', isAllDay: false, start, end, timeZone: task.timeZone || DEFAULT_TIMEZONE };
}

// Un tag qui correspond à un projet Workflow connu (ex. "amge"), s'il y en a un.
function ticktickTaskProjectMatchKey(task, projectIndex) {
  for (const tag of task.tags || []) {
    const key = normalize(tag);
    if (projectIndex && projectIndex.byNormalizedTitle.has(key)) return key;
  }
  return null;
}

function taskBelongsToCalendar(task, calConfig, projectIndex) {
  if (calConfig.schema === 'personnel') return true;
  const projectMatchKey = ticktickTaskProjectMatchKey(task, projectIndex);
  if (calConfig.projectMatchKey) return projectMatchKey === calConfig.projectMatchKey;
  // "anabasis" est le projet fourre-tout par défaut (voir DEFAULT_PROJECT_ID), pas un
  // client précis : une tâche qui le porte (explicitement, ou repoussée en tag par le sync
  // Notion -> TickTick) reste dans le lot par défaut FreeLance/Freelance To Do, pas exclue.
  if (projectMatchKey && projectMatchKey !== 'anabasis') return false; // projet précis -> son propre calendrier (ex. AMGE)
  const hasPreciseTime = !task.isAllDay;
  return calConfig.timedOnly ? hasPreciseTime : !hasPreciseTime;
}

// ---------- Google Calendar : sync d'un calendrier <-> une liste TickTick ----------

async function syncGoogleCalendarProject(calConfig, calendarId, tasks, projectIndex, stats) {
  const scopedTasks = tasks.filter((t) => taskBelongsToCalendar(t, calConfig, projectIndex));
  const tasksById = new Map(scopedTasks.map((t) => [t.id, t]));

  const timeMin = new Date();
  timeMin.setHours(0, 0, 0, 0);
  const timeMax = new Date(Date.now() + 365 * 86400000);

  const events = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      maxResults: '250', singleEvents: 'true', showDeleted: 'true',
      timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
    });
    if (pageToken) params.set('pageToken', pageToken);
    const result = await gcalFetch(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
    events.push(...(result.items || []));
    pageToken = result.nextPageToken;
  } while (pageToken);

  // A) Évènements GCal actifs sans lien connu -> nouvelle tâche TickTick (jamais pour du
  // passé : timeMin=aujourd'hui filtre déjà l'historique du calendrier à la source). Limité
  // aux occurrences proches (voir GCAL_INCOMING_LOOKAHEAD_DAYS) et plafonné par passage :
  // une série récurrente ne doit pas déverser tout son futur en un seul coup.
  const incomingCutoff = new Date(Date.now() + GCAL_INCOMING_LOOKAHEAD_DAYS * 86400000);
  let incomingCreated = 0;
  for (const ev of events) {
    if (ev.status === 'cancelled' || ev.extendedProperties?.private?.ticktickId) continue;
    const evStart = new Date(ev.start?.dateTime || ev.start?.date);
    // timeMin filtre côté Google sur la fin de l'évènement, pas son début (constaté le
    // 27/08/2026 sur un évènement multi-jours déjà en cours) : un évènement commencé avant
    // aujourd'hui peut donc quand même apparaître ici. On refiltre explicitement sur le début.
    if (evStart < timeMin || evStart > incomingCutoff) continue;
    if (incomingCreated >= MAX_GCAL_INCOMING_PER_RUN) {
      console.error(`[GCal ${calConfig.name}] création TickTick depuis évènement ${ev.id} ignorée : plafond de ${MAX_GCAL_INCOMING_PER_RUN} par passage atteint.`);
      continue;
    }
    try {
      const fields = gcalEventFields(ev);
      const payload = {
        title: fields.title,
        content: ev.description || '',
        tags: calConfig.projectTag ? [calConfig.projectTag] : [],
        timeZone: DEFAULT_TIMEZONE,
      };
      if (fields.isAllDay) {
        payload.isAllDay = true;
        payload.startDate = notionDateToTicktickAllDay(fields.start, DEFAULT_TIMEZONE);
        payload.dueDate = payload.startDate;
      } else {
        payload.isAllDay = false;
        payload.startDate = notionDateTimeToTicktickInstant(fields.start);
        payload.dueDate = notionDateTimeToTicktickInstant(fields.end);
      }
      const created = await ticktickFetch('/task', { method: 'POST', body: JSON.stringify({ projectId: calConfig.ticktickProjectId, ...payload }) });
      await sleep(300);
      await gcalFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${ev.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ extendedProperties: { private: { ticktickId: created.id, syncSnapshot: gcalSnapshotOf(fields) } } }),
      });
      stats.fromGcalCreated++;
      incomingCreated++;
      await sleep(300);
    } catch (err) {
      console.error(`[GCal ${calConfig.name}] échec création TickTick depuis évènement ${ev.id}: ${err.message}`);
      stats.errors++;
    }
  }

  const eventsByTicktickId = new Map();
  for (const ev of events) {
    const ttId = ev.extendedProperties?.private?.ticktickId;
    if (ttId) eventsByTicktickId.set(ttId, ev);
  }

  // B) Tâches TickTick du périmètre -> évènement GCal à créer, mettre à jour ou supprimer.
  for (const task of scopedTasks) {
    const fields = ticktickToGcalFields(task);
    const existing = eventsByTicktickId.get(task.id);

    if (!fields) {
      if (existing && existing.status !== 'cancelled') {
        try {
          await gcalFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${existing.id}`, { method: 'DELETE' });
          stats.gcalDeleted++;
          await sleep(300);
        } catch (err) {
          console.error(`[GCal ${calConfig.name}] échec suppression évènement (tâche ${task.id} sans date pertinente): ${err.message}`);
          stats.errors++;
        }
      }
      continue;
    }

    if (!existing) {
      try {
        const body = { ...gcalEventBody(fields), extendedProperties: { private: { ticktickId: task.id, syncSnapshot: gcalSnapshotOf(fields) } } };
        await gcalFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: JSON.stringify(body) });
        stats.gcalCreated++;
        await sleep(300);
      } catch (err) {
        console.error(`[GCal ${calConfig.name}] échec création évènement pour tâche ${task.id}: ${err.message}`);
        stats.errors++;
      }
      continue;
    }

    if (existing.status === 'cancelled') {
      // Évènement supprimé côté GCal par l'utilisateur -> on supprime la tâche TickTick.
      if (stats.gcalTriggeredDeletes >= MAX_GCAL_DELETIONS_PER_RUN) {
        console.error(`[GCal ${calConfig.name}] suppression de la tâche ${task.id} ignorée : plafond de ${MAX_GCAL_DELETIONS_PER_RUN} suppressions par passage atteint.`);
        continue;
      }
      try {
        await ticktickFetch(`/project/${calConfig.ticktickProjectId}/task/${task.id}`, { method: 'DELETE' });
        stats.gcalTriggeredDeletes++;
        await sleep(300);
      } catch (err) {
        console.error(`[GCal ${calConfig.name}] échec suppression TickTick suite à évènement supprimé ${existing.id}: ${err.message}`);
        stats.errors++;
      }
      continue;
    }

    // Les deux existent : comparaison d'empreinte, TickTick gagne en cas de conflit.
    const storedSnapshot = existing.extendedProperties?.private?.syncSnapshot || null;
    const currentGcalSnapshot = gcalSnapshotOf(gcalEventFields(existing));
    const currentTicktickSnapshot = gcalSnapshotOf(fields);
    if (storedSnapshot === currentGcalSnapshot && storedSnapshot === currentTicktickSnapshot) continue;

    const ticktickChanged = currentTicktickSnapshot !== storedSnapshot;

    if (ticktickChanged) {
      try {
        await gcalFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${existing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ ...gcalEventBody(fields), extendedProperties: { private: { ticktickId: task.id, syncSnapshot: currentTicktickSnapshot } } }),
        });
        stats.gcalUpdated++;
        await sleep(300);
      } catch (err) {
        console.error(`[GCal ${calConfig.name}] échec mise à jour évènement pour tâche ${task.id}: ${err.message}`);
        stats.errors++;
      }
    } else {
      try {
        const gcalFieldsNow = gcalEventFields(existing);
        await ticktickFetch(`/task/${task.id}`, {
          method: 'POST',
          body: JSON.stringify({
            id: task.id,
            projectId: task.projectId,
            title: gcalFieldsNow.title,
            isAllDay: gcalFieldsNow.isAllDay,
            timeZone: task.timeZone || DEFAULT_TIMEZONE,
            startDate: gcalFieldsNow.isAllDay
              ? notionDateToTicktickAllDay(gcalFieldsNow.start, DEFAULT_TIMEZONE)
              : notionDateTimeToTicktickInstant(gcalFieldsNow.start),
            dueDate: gcalFieldsNow.isAllDay
              ? notionDateToTicktickAllDay(gcalFieldsNow.start, DEFAULT_TIMEZONE)
              : notionDateTimeToTicktickInstant(gcalFieldsNow.end),
          }),
        });
        await sleep(300);
        await gcalFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${existing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ extendedProperties: { private: { ticktickId: task.id, syncSnapshot: currentGcalSnapshot } } }),
        });
        stats.ticktickUpdatedFromGcal++;
        await sleep(300);
      } catch (err) {
        console.error(`[GCal ${calConfig.name}] échec mise à jour TickTick depuis évènement ${existing.id}: ${err.message}`);
        stats.errors++;
      }
    }
  }

  // C) Évènements GCal encore actifs dont la tâche a disparu du périmètre (complétée ou
  // supprimée côté TickTick) -> vérification individuelle puis suppression de l'évènement.
  // /project/{id}/data exclut les tâches complétées : "absente" ne veut pas dire "supprimée"
  // (même prudence que pour l'archivage Notion, voir syncProject).
  for (const ev of events) {
    const ttId = ev.extendedProperties?.private?.ticktickId;
    if (!ttId || ev.status === 'cancelled' || tasksById.has(ttId)) continue;
    try {
      const fetched = await ticktickFetch(`/project/${calConfig.ticktickProjectId}/task/${ttId}`);
      await sleep(300);
      // `fetched` peut valoir `null` (200 avec corps vide, constaté sur une tâche réellement
      // supprimée le 27/08/2026) : traité comme équivalent à __notFound, voir syncProject.
      const isGoneOrDone = !fetched || fetched.__notFound || fetched.status === 2;
      if (!isGoneOrDone) continue;
      await gcalFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${ev.id}`, { method: 'DELETE' });
      stats.gcalDeleted++;
      await sleep(300);
    } catch (err) {
      console.error(`[GCal ${calConfig.name}] échec suppression évènement pour tâche disparue ${ttId}: ${err.message}`);
      stats.errors++;
    }
  }
}

async function syncGoogleCalendar() {
  const stats = { gcalCreated: 0, gcalUpdated: 0, gcalDeleted: 0, fromGcalCreated: 0, ticktickUpdatedFromGcal: 0, gcalTriggeredDeletes: 0, errors: 0 };
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    console.log('[Google Calendar] secrets absents, sync ignorée.');
    return stats;
  }

  let projectIndex;
  let calendarIdsByName;
  try {
    projectIndex = await loadWorkflowProjects();
    calendarIdsByName = await loadCalendarIdsByName();
  } catch (err) {
    console.error(`[Google Calendar] initialisation impossible: ${err.message}`);
    stats.errors++;
    return stats;
  }

  const taskCache = new Map();
  async function getTasks(ticktickProjectId) {
    if (!taskCache.has(ticktickProjectId)) {
      const data = await ticktickFetch(`/project/${ticktickProjectId}/data`);
      taskCache.set(ticktickProjectId, (data.tasks || []).filter((t) => !t.parentId));
    }
    return taskCache.get(ticktickProjectId);
  }

  for (const calConfig of GCAL_CALENDARS) {
    const calendarId = calendarIdsByName.get(calConfig.name);
    if (!calendarId) {
      console.error(`[Google Calendar] calendrier "${calConfig.name}" introuvable dans la liste des agendas.`);
      stats.errors++;
      continue;
    }
    let projectTag = null;
    if (calConfig.projectMatchKey) {
      const projectId = projectIndex.byNormalizedTitle.get(calConfig.projectMatchKey);
      projectTag = projectId ? projectIndex.titleById.get(projectId) : calConfig.projectMatchKey;
    }
    try {
      const tasks = await getTasks(calConfig.ticktickProjectId);
      await syncGoogleCalendarProject({ ...calConfig, projectTag }, calendarId, tasks, projectIndex, stats);
    } catch (err) {
      console.error(`[Google Calendar] échec sync "${calConfig.name}": ${err.message}`);
      stats.errors++;
    }
  }

  return stats;
}

// ---------- Sync d'un projet (une liste TickTick <-> une base Notion) ----------

async function syncProject(project) {
  const stats = { toNotionCreated: 0, toNotionUpdated: 0, toTicktickCreated: 0, toTicktickUpdated: 0, archived: 0, seeded: 0, newProjects: 0, errors: 0 };

  let data;
  try {
    data = await ticktickFetch(`/project/${project.ticktickProjectId}/data`);
  } catch (err) {
    console.error(`[${project.name}] lecture TickTick impossible: ${err.message}`);
    stats.errors++;
    return stats;
  }

  const knownTagSpellings = buildKnownTagSpellings(data.tasks || []);

  let projectIndex = null;
  if (project.matchProjects) {
    try {
      projectIndex = await loadWorkflowProjects();
      stats.newProjects = await createMissingWorkflowProjects(data.tasks || [], projectIndex, project.schema);
    } catch (err) {
      console.error(`[${project.name}] lecture des projets Workflow impossible: ${err.message}`);
    }
  }

  let pages;
  try {
    pages = await loadAllPages(project.notionDataSourceId);
  } catch (err) {
    console.error(`[${project.name}] lecture Notion impossible: ${err.message}`);
    stats.errors++;
    return stats;
  }

  // On ignore les sous-tâches (checklist items rattachés à une tâche parente) : les
  // synchroniser individuellement noierait Notion sous des entrées sans intérêt.
  const topLevelTasks = (data.tasks || []).filter((task) => !task.parentId);
  const tasksById = new Map(topLevelTasks.map((t) => [t.id, t]));

  const pagesByTicktickId = new Map();
  let orphanPages = [];

  for (const page of pages) {
    const ttId = getTicktickId(page);
    if (ttId) {
      pagesByTicktickId.set(ttId, page);
    } else if (project.autoCreateWithoutFlag || page.properties?.[ORPHAN_PUSH_FLAG_PROP]?.checkbox) {
      orphanPages.push(page);
    }
  }

  if (orphanPages.length > MAX_ORPHAN_PUSH_PER_RUN) {
    console.error(`[${project.name}] ${orphanPages.length} pages à créer côté TickTick en même temps, plafonné à ${MAX_ORPHAN_PUSH_PER_RUN} par passage (garde-fou).`);
    orphanPages = orphanPages.slice(0, MAX_ORPHAN_PUSH_PER_RUN);
  }

  // 1) Tâches TickTick sans page Notion -> création côté Notion.
  for (const task of topLevelTasks) {
    if (pagesByTicktickId.has(task.id)) continue;
    try {
      const properties = buildNotionPropertiesFromTask(task, project.schema, projectIndex);
      await notionFetch('/pages', {
        method: 'POST',
        body: JSON.stringify({ parent: { type: 'data_source_id', data_source_id: project.notionDataSourceId }, properties }),
      });
      stats.toNotionCreated++;
      await sleep(300);
    } catch (err) {
      console.error(`[${project.name}] échec création Notion pour la tâche ${task.id}: ${err.message}`);
      stats.errors++;
    }
  }

  // 2) Tâches/pages présentes des deux côtés -> comparaison d'empreintes.
  for (const [taskId, page] of pagesByTicktickId) {
    let task = tasksById.get(taskId);

    if (!task) {
      // Absente de la liste standard : /project/{id}/data n'inclut PAS les tâches
      // complétées (vérifié empiriquement) — "absente de la liste" ne veut donc PAS dire
      // "supprimée". On vérifie individuellement avant de conclure quoi que ce soit.
      let fetched;
      try {
        fetched = await ticktickFetch(`/project/${project.ticktickProjectId}/task/${taskId}`);
      } catch (err) {
        console.error(`[${project.name}] échec vérification de la tâche ${taskId}: ${err.message}`);
        stats.errors++;
        continue;
      }
      await sleep(300);

      if (!fetched || fetched.__notFound) {
        // Là, vraiment supprimée -> on archive le miroir Notion. On ne fait jamais
        // l'inverse (archiver Notion ne supprime pas la tâche TickTick). `fetched` peut
        // valoir `null` (corps de réponse vide avec un statut 200 tout de même) : constaté
        // le 27/08/2026 sur deux tâches réellement supprimées, faisait planter le sync avec
        // "Cannot read properties of null" avant ce correctif.
        try {
          await notionFetch(`/pages/${page.id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
          stats.archived++;
          await sleep(300);
        } catch (err) {
          console.error(`[${project.name}] échec archivage Notion pour ${taskId}: ${err.message}`);
          stats.errors++;
        }
        continue;
      }

      task = fetched; // toujours là (complétée, ou simplement absente du lot standard)
    }

    try {
      const stored = getStoredSnapshot(page);
      const notionSnapshot = computeNotionSnapshot(page, project.schema);
      const ticktickSnapshot = computeTicktickSnapshot(task, project.schema, projectIndex);

      if (stored === null) {
        // Jamais vue : on ne peut pas savoir qui a changé. On initialise sur l'état
        // TickTick (source de vérité par défaut pour une page qu'on découvre côté sync)
        // sans rien pousser vers TickTick, pour ne jamais écraser une tâche à l'aveugle.
        if (notionSnapshot !== ticktickSnapshot) {
          await pushTicktickStateToNotion(task, page, project, projectIndex, stats);
        } else {
          await notionFetch(`/pages/${page.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ properties: { 'Sync Snapshot': { rich_text: [{ text: { content: notionSnapshot } }] } } }),
          });
          stats.seeded++;
        }
        await sleep(300);
        continue;
      }

      const ticktickChanged = ticktickSnapshot !== stored;
      const notionChanged = notionSnapshot !== stored;

      if (!ticktickChanged && !notionChanged) continue;

      // Conflit (les deux ont changé depuis le dernier sync connu) : TickTick gagne, par
      // convention simple plutôt que de deviner qui est "le plus récent" sans horodatage fiable.
      const pushFromTicktick = ticktickChanged;

      if (pushFromTicktick) {
        await pushTicktickStateToNotion(task, page, project, projectIndex, stats);
      } else {
        const payload = buildTicktickPayloadFromPage(page, project.schema, projectIndex, knownTagSpellings);
        const checked = getChecked(page);
        const currentlyDone = task.status === 2;

        if (checked && !currentlyDone) {
          await ticktickFetch(`/project/${task.projectId}/task/${task.id}/complete`, { method: 'POST' });
          await sleep(300);
        }
        await ticktickFetch(`/task/${task.id}`, {
          method: 'POST',
          body: JSON.stringify({
            id: task.id,
            projectId: task.projectId,
            title: payload.title,
            content: payload.content,
            tags: payload.tags,
            timeZone: payload.timeZone,
            isAllDay: payload.isAllDay,
            startDate: payload.startDate,
            dueDate: payload.dueDate,
            ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
            ...(!checked && currentlyDone ? { status: 0 } : {}),
          }),
        });

        await notionFetch(`/pages/${page.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ properties: { 'Sync Snapshot': { rich_text: [{ text: { content: notionSnapshot } }] } } }),
        });
        stats.toTicktickUpdated++;
      }
      await sleep(300);
    } catch (err) {
      console.error(`[${project.name}] échec sync sur la tâche ${taskId}: ${err.message}`);
      stats.errors++;
    }
  }

  // 3) Pages Notion créées à la main, avec "→ TickTick" coché -> création côté TickTick.
  for (const page of orphanPages) {
    const title = getTitle(page, project.schema);
    if (!title) continue; // page vide (juste créée), on attend qu'elle ait un titre
    try {
      const payload = buildTicktickPayloadFromPage(page, project.schema, projectIndex, knownTagSpellings);
      const created = await ticktickFetch('/task', {
        method: 'POST',
        body: JSON.stringify({ projectId: project.ticktickProjectId, ...payload }),
      });

      if (getChecked(page)) {
        await ticktickFetch(`/project/${project.ticktickProjectId}/task/${created.id}/complete`, { method: 'POST' });
        await sleep(300);
      }

      const properties = {
        'TickTick ID': { rich_text: [{ text: { content: created.id } }] },
        'Sync Snapshot': { rich_text: [{ text: { content: computeNotionSnapshot(page, project.schema) } }] },
        [ORPHAN_PUSH_FLAG_PROP]: { checkbox: false },
      };
      if (!page.properties?.Source?.select) {
        properties.Source = { select: { name: 'Manuel' } };
      }
      await notionFetch(`/pages/${page.id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
      stats.toTicktickCreated++;
      await sleep(300);
    } catch (err) {
      console.error(`[${project.name}] échec création TickTick depuis Notion (page ${page.id}): ${err.message}`);
      stats.errors++;
    }
  }

  return stats;
}

async function main() {
  if (!TICKTICK_TOKEN || !NOTION_TOKEN) {
    console.error('Variables TICKTICK_TOKEN et/ou NOTION_TOKEN manquantes.');
    process.exit(1);
  }

  const gcalStats = await syncGoogleCalendar();
  console.log(
    `[Google Calendar] créées: ${gcalStats.gcalCreated}, mises à jour: ${gcalStats.gcalUpdated}, ` +
    `supprimées: ${gcalStats.gcalDeleted}, TickTick créées depuis GCal: ${gcalStats.fromGcalCreated}, ` +
    `TickTick mises à jour depuis GCal: ${gcalStats.ticktickUpdatedFromGcal}, ` +
    `tâches supprimées (évènement effacé): ${gcalStats.gcalTriggeredDeletes}, erreurs: ${gcalStats.errors}`
  );

  let hadErrors = gcalStats.errors > 0;
  for (const project of PROJECTS) {
    const stats = await syncProject(project);
    console.log(
      `[${project.name}] Notion créées: ${stats.toNotionCreated}, Notion mises à jour: ${stats.toNotionUpdated}, ` +
      `TickTick créées: ${stats.toTicktickCreated}, TickTick mises à jour: ${stats.toTicktickUpdated}, ` +
      `archivées: ${stats.archived}, empreintes initialisées: ${stats.seeded}, nouveaux projets: ${stats.newProjects}, ` +
      `erreurs: ${stats.errors}`
    );
    if (stats.errors > 0) hadErrors = true;
  }

  if (hadErrors) process.exit(1);
}

main().catch((err) => {
  console.error('Échec du script:', err.message);
  process.exit(1);
});
