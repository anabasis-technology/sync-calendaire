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
const NOTION_VERSION = '2025-09-03';
const DEFAULT_TIMEZONE = 'Europe/Paris';
const ORPHAN_PUSH_FLAG_PROP = '→ TickTick';
const MAX_ORPHAN_PUSH_PER_RUN = 5;

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
  },
  {
    name: 'Personnel <-> Personnel',
    ticktickProjectId: '67ee6a2c8f082fe808671e3c',
    notionDataSourceId: '24eab52f-34f1-8152-92af-000b75158c4a',
    schema: 'personnel',
    matchProjects: false,
  },
];

// TickTick renvoie/attend des tags en minuscules ; on les remappe vers les options exactes
// (avec accents/casse) configurées côté Notion, et inversement.
const TAG_MAP = {
  freelanceTasks: { comptabilité: 'Comptabilité', bug: 'BUG', finance: 'Finance', anabasis: 'Anabasis', adm: 'ADM', article: 'Article' },
  personnel: { gcal: 'GCal', adm: 'ADM', anabasis: 'Anabasis', finance: 'Finance', comptabilité: 'Comptabilité', bug: 'BUG' },
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
  return snapshotOf({
    title: getTitle(page, schema),
    date: dateValue ? dateValue.start : null,
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
    ? (task.isAllDay ? ticktickAllDayToNotionDate(rawDate, task.timeZone) : rawDate)
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

function buildTicktickPayloadFromPage(page, schema, projectIndex) {
  const title = getTitle(page, schema);
  const description = getDescription(page);
  const genericTags = getTags(page).map((t) => normalize(t));
  const tags = [...genericTags];

  if (schema === 'freelanceTasks' && projectIndex) {
    const projetId = getProjetRelationId(page);
    if (projetId && projectIndex.titleById.has(projetId)) {
      const projectTag = normalize(projectIndex.titleById.get(projetId));
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

// ---------- Sync d'un projet (une liste TickTick <-> une base Notion) ----------

async function syncProject(project) {
  const stats = { toNotionCreated: 0, toNotionUpdated: 0, toTicktickCreated: 0, toTicktickUpdated: 0, archived: 0, seeded: 0, errors: 0 };

  let data;
  try {
    data = await ticktickFetch(`/project/${project.ticktickProjectId}/data`);
  } catch (err) {
    console.error(`[${project.name}] lecture TickTick impossible: ${err.message}`);
    stats.errors++;
    return stats;
  }

  let projectIndex = null;
  if (project.matchProjects) {
    try {
      projectIndex = await loadWorkflowProjects();
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
    } else if (page.properties?.[ORPHAN_PUSH_FLAG_PROP]?.checkbox) {
      orphanPages.push(page);
    }
  }

  if (orphanPages.length > MAX_ORPHAN_PUSH_PER_RUN) {
    console.error(`[${project.name}] ${orphanPages.length} pages cochées "→ TickTick" en même temps, plafonné à ${MAX_ORPHAN_PUSH_PER_RUN} par passage (garde-fou).`);
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

      if (fetched && fetched.__notFound) {
        // Là, vraiment supprimée -> on archive le miroir Notion. On ne fait jamais
        // l'inverse (archiver Notion ne supprime pas la tâche TickTick).
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
          const properties = buildNotionPropertiesFromTask(task, project.schema, projectIndex);
          await notionFetch(`/pages/${page.id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
          stats.toNotionUpdated++;
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
        const properties = buildNotionPropertiesFromTask(task, project.schema, projectIndex);
        await notionFetch(`/pages/${page.id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
        stats.toNotionUpdated++;
      } else {
        const payload = buildTicktickPayloadFromPage(page, project.schema, projectIndex);
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
      const payload = buildTicktickPayloadFromPage(page, project.schema, projectIndex);
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

  let hadErrors = false;
  for (const project of PROJECTS) {
    const stats = await syncProject(project);
    console.log(
      `[${project.name}] Notion créées: ${stats.toNotionCreated}, Notion mises à jour: ${stats.toNotionUpdated}, ` +
      `TickTick créées: ${stats.toTicktickCreated}, TickTick mises à jour: ${stats.toTicktickUpdated}, ` +
      `archivées: ${stats.archived}, empreintes initialisées: ${stats.seeded}, erreurs: ${stats.errors}`
    );
    if (stats.errors > 0) hadErrors = true;
  }

  if (hadErrors) process.exit(1);
}

main().catch((err) => {
  console.error('Échec du script:', err.message);
  process.exit(1);
});
