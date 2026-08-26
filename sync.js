// Synchronisation TickTick -> Notion (projet "Sync Calendaire")
// Deux listes TickTick sources ("Freelance", "Personnel"), routées vers deux bases Notion
// distinctes. Architecture volontairement à sens unique : TickTick reste la seule source
// de vérité pour les tâches, Notion n'est qu'un miroir. Ne jamais écrire vers TickTick ici.

const TICKTICK_TOKEN = process.env.TICKTICK_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2025-09-03';

const PROJECTS = [
  {
    name: 'Freelance -> Workflow',
    ticktickProjectId: '67ee6a2c8f082fe808671e39',
    notionDataSourceId: '2f0ab52f-34f1-80b8-b9ce-000b7a24fb71',
    schema: 'workflow',
  },
  {
    name: 'Personnel -> Personnel',
    ticktickProjectId: '67ee6a2c8f082fe808671e3c',
    notionDataSourceId: '24eab52f-34f1-8152-92af-000b75158c4a',
    schema: 'personnel',
  },
];

// TickTick renvoie les tags en minuscules ; on les remappe vers les options exactes
// (avec accents/casse) déjà configurées dans les bases Notion.
const TAG_MAP = {
  workflow: { comptabilité: 'Comptabilité', bug: 'BUG', finance: 'Finance', anabasis: 'Anabasis', adm: 'ADM' },
  personnel: { gcal: 'GCal', adm: 'ADM', anabasis: 'Anabasis', finance: 'Finance', comptabilité: 'Comptabilité', bug: 'BUG' },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ticktickFetch(path) {
  const res = await fetch(`https://api.ticktick.com/open/v1${path}`, {
    headers: { Authorization: `Bearer ${TICKTICK_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`TickTick API a répondu ${res.status}`);
  }
  return res.json();
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

// Pour une tâche "journée entière", TickTick stocke l'instant UTC correspondant à minuit
// dans le fuseau de la tâche. On reconvertit vers la date calendaire locale attendue.
function allDayDate(isoUtc, timeZone) {
  return new Date(isoUtc).toLocaleDateString('en-CA', { timeZone: timeZone || 'Europe/Paris' });
}

function buildTags(taskTags, schema) {
  if (!taskTags || !taskTags.length) return [];
  const map = TAG_MAP[schema];
  const seen = new Set();
  for (const tag of taskTags) {
    const mapped = map[String(tag).toLowerCase()];
    if (mapped) seen.add(mapped);
  }
  return [...seen];
}

function buildProperties(task, schema) {
  const titleProp = schema === 'workflow' ? 'Nom' : 'Title';
  const dateProp = schema === 'workflow' ? 'Due Date' : 'Date';

  const properties = {
    [titleProp]: { title: [{ text: { content: task.title || '(sans titre)' } }] },
    'TickTick ID': { rich_text: [{ text: { content: task.id } }] },
    Source: { select: { name: 'TickTick' } },
    Tags: { multi_select: buildTags(task.tags, schema).map((name) => ({ name })) },
  };

  const description = task.content || task.desc || '';
  if (description) {
    properties.Description = { rich_text: [{ text: { content: description.slice(0, 1900) } }] };
  }

  const rawDate = task.dueDate || task.startDate;
  if (rawDate) {
    properties[dateProp] = {
      date: task.isAllDay
        ? { start: allDayDate(rawDate, task.timeZone) }
        : { start: rawDate },
    };
  }

  if (schema === 'personnel') {
    properties.Checkbox = { checkbox: task.status === 2 || Boolean(task.completedTime) };
  }

  return properties;
}

async function findExistingPage(dataSourceId, taskId) {
  const result = await notionFetch(`/data_sources/${dataSourceId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'TickTick ID', rich_text: { equals: taskId } },
      page_size: 1,
    }),
  });
  return result.results[0] || null;
}

async function syncProject(project) {
  const stats = { created: 0, updated: 0, errors: 0 };
  let data;
  try {
    data = await ticktickFetch(`/project/${project.ticktickProjectId}/data`);
  } catch (err) {
    console.error(`[${project.name}] lecture TickTick impossible: ${err.message}`);
    stats.errors++;
    return stats;
  }

  // On ignore les sous-tâches (checklist items rattachés à une tâche parente) : les
  // synchroniser individuellement noierait Notion sous des entrées sans intérêt.
  const topLevelTasks = (data.tasks || []).filter((task) => !task.parentId);

  for (const task of topLevelTasks) {
    try {
      const properties = buildProperties(task, project.schema);
      const existing = await findExistingPage(project.notionDataSourceId, task.id);
      await sleep(300);

      if (existing) {
        await notionFetch(`/pages/${existing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ properties }),
        });
        stats.updated++;
      } else {
        await notionFetch('/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: { type: 'data_source_id', data_source_id: project.notionDataSourceId },
            properties,
          }),
        });
        stats.created++;
      }
      await sleep(300);
    } catch (err) {
      // On ne journalise jamais le titre ou le contenu de la tâche : ce dépôt est public
      // et ces logs le seraient aussi. Seul l'identifiant opaque de la tâche est loggué.
      console.error(`[${project.name}] échec sur la tâche ${task.id}: ${err.message}`);
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
    console.log(`[${project.name}] créées: ${stats.created}, mises à jour: ${stats.updated}, erreurs: ${stats.errors}`);
    if (stats.errors > 0) hadErrors = true;
  }

  if (hadErrors) process.exit(1);
}

main().catch((err) => {
  console.error('Échec du script:', err.message);
  process.exit(1);
});
