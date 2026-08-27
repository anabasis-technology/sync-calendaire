# Sync Calendaire — TickTick ↔ Notion ↔ Google Calendar

Synchronisation bidirectionnelle et gratuite entre TickTick, Notion, et Google Calendar.
Fait partie du projet "Sync Calendaire" (voir la page Notion dédiée dans la base ⚡ Workflow).

## Principe

- Deux listes TickTick (`Freelance`, `Personnel`) sont synchronisées avec deux bases Notion
  (`✅ Tâches Freelance`, `Personnel`) toutes les 5 minutes via
  [GitHub Actions](.github/workflows/sync.yml). **TickTick est le relais central** : Google
  Calendar (voir plus bas) suit exactement la même logique, une modification dans Notion
  remontant à TickTick puis redescendant vers Google Calendar, et inversement.
- **Bidirectionnel** : éditer le titre, la date, les tags, la description ou cocher "fait"
  d'un côté se répercute de l'autre, et inversement.
- **Détection des changements par empreinte de contenu**, pas par horodatage. Notion arrondit
  `last_edited_time` à la seconde et TickTick ne met pas toujours à jour `modifiedTime` après
  une modification via l'API (constaté empiriquement) — aucun des deux horodatages n'est fiable
  comme unique signal. Chaque page Notion stocke donc "Sync Snapshot", une empreinte JSON des
  champs synchronisables telle qu'on l'a vue en dernier des deux côtés à la fois. **Piège
  rencontré** : TickTick sérialise un horaire en "+0000" et Notion en "+00:00" (même instant,
  écriture différente) — comparer ces chaînes brutes ne s'équilibre jamais. Toute date avec
  horaire est donc passée par `canonicalInstant()` (conversion en instant UTC) avant toute
  comparaison ou stockage d'empreinte, aussi bien ici que côté Google Calendar.
- **Conflit** (les deux côtés modifiés dans la même fenêtre de 5 min) : TickTick gagne, par
  convention simple plutôt que de deviner qui est "le plus récent" sans horodatage fiable.
- `⚡ Workflow` (les projets : AMGE, BrainUp, etc.) n'est jamais touché par ce sync — seule la
  relation "Projet" sur `✅ Tâches Freelance` s'y connecte, via une correspondance tag TickTick
  ↔ nom de projet. Un tag TickTick qui ne correspond à aucun projet existant ni à une étiquette
  générique connue crée automatiquement un nouveau projet dans ⚡ Workflow (plafonné à 3
  créations/passage).
- Les sous-tâches (checklist items rattachés à une tâche parente) ne sont pas synchronisées
  individuellement.

## Google Calendar

Quatre calendriers Google (déjà existants, pas de calendrier dédié créé) sont synchronisés
dans les deux sens avec TickTick, chacun routé vers un projet/une base précise :

| Calendrier Google | Base Notion | Projet |
|---|---|---|
| Freelance AMGE - ENOVEA | ✅ Tâches Freelance | AMGE |
| FreeLance | ✅ Tâches Freelance | Anabasis (défaut) — tâches avec horaire précis |
| Freelance To Do | ✅ Tâches Freelance | Anabasis (défaut) — tâches sans horaire précis (journée entière) |
| To Do List | Personnel | — |

Tous les autres calendriers (Calls Freelance, Sylvain Héliou, Mathilde, Calendly, etc.) ne
sont jamais touchés — ce sont de vrais rendez-vous/évènements, pas des tâches.

- **Périmètre limité à "aujourd'hui et après"**, des deux côtés. Aucun import de l'historique
  des calendriers (certaines séries récurrentes remontent à 2017) : seuls les nouveaux
  évènements sont importés comme tâches TickTick, et une tâche dont l'échéance passe dans le
  passé voit simplement son évènement Google Calendar disparaître plutôt que d'y laisser un
  évènement obsolète.
- **Fenêtre de 14 jours pour l'import de nouveaux évènements** (`GCAL_INCOMING_LOOKAHEAD_DAYS`),
  plafonnée à 5 créations/passage/calendrier (`MAX_GCAL_INCOMING_PER_RUN`) : une série
  récurrente (ex. "Planning Semaine" chaque semaine) ne doit jamais déverser tout son futur
  d'un coup, seulement ses prochaines occurrences, au fil de l'eau.
- **Le lien entre une tâche TickTick et un évènement Google Calendar vit sur l'évènement
  lui-même** (`extendedProperties.private.ticktickId` + une empreinte de contenu dédiée),
  sans toucher au schéma Notion — pas de nouvelle propriété "GCal Event ID" à gérer.
- **Suppression à trois branches, plafonnée** (`MAX_GCAL_DELETIONS_PER_RUN`) : compléter/
  supprimer une tâche TickTick supprime son évènement Google Calendar ; supprimer l'évènement
  Google Calendar supprime la tâche TickTick (qui archive ensuite sa page Notion via le
  mécanisme existant).
- **Piège rencontré** : le paramètre `timeMin` de l'API Google Calendar filtre sur la date de
  **fin** d'un évènement, pas son début — un évènement multi-jours déjà en cours (commencé
  avant aujourd'hui) passait donc le filtre. Un filtre explicite sur le début a été ajouté.
- **Piège rencontré** : un tag "anabasis" (le projet fourre-tout par défaut, pas un client
  précis — voir plus haut) faisait exclure à tort une tâche du routage par défaut
  FreeLance/Freelance To Do, qui ne traite que les tâches sans projet client précis.

## Créer une tâche depuis Notion

Ajouter une page dans `✅ Tâches Freelance` ou `Personnel` crée automatiquement la tâche
TickTick correspondante au passage suivant (pas de case à cocher) — la page reçoit alors son
TickTick ID. Un plafond de 5 créations par passage (`MAX_ORPHAN_PUSH_PER_RUN`) protège contre
tout pic anormal (import en masse, bug amont) : le reste suit automatiquement sur les
passages suivants, sans intervention.

Ce plafond existe suite à un incident réel : avant sa mise en place, une page Notion sans
TickTick ID était interprétée comme "à créer" sans limite, ce qui a dupliqué en masse des
années de contenu pré-existant dans `Personnel` (voir historique de la page Notion du projet).
Le backlog historique de `Personnel` a depuis été déplacé vers une base séparée
(`Archives Perso Historique`, hors sync) le 27/08/2026, ce qui a permis d'activer la création
automatique sur cette base aussi, en toute sécurité grâce au plafond.

## Pourquoi 5 minutes, pas plus rapide ?

TickTick n'expose aucun webhook — impossible d'être notifié en temps réel, quel que soit
l'outil. Cinq minutes est le minimum technique imposé par GitHub Actions (`schedule` cron),
gratuit ou payant. Le dépôt est **public** pour bénéficier des minutes Actions illimitées
(un dépôt privé serait plafonné à 2000 min/mois, insuffisant pour un passage toutes les 5 min
facturé minute entière par run).

Aucune donnée personnelle ne transite par le dépôt lui-même : le code ne fait que lire/écrire
via API à la volée, et n'écrit jamais de contenu de tâche dans les logs (dépôt public = logs
publics).

## Limites connues

- **Suppression TickTick → Notion : best-effort, pas fiable.** L'API TickTick ne permet pas
  de distinguer proprement "tâche supprimée" de "tâche complétée" (`/project/{id}/data`
  exclut les deux), et son endpoint individuel `GET .../task/{id}` a été observé renvoyant
  un succès même après suppression confirmée. Le script vérifie individuellement avant
  d'archiver un miroir Notion, ce qui rend l'archivage quasi inopérant en pratique — c'est le
  compromis de sécurité assumé : ne jamais archiver à tort plutôt que nettoyer à coup sûr.
  Une page Notion dont la tâche TickTick a été vraiment supprimée peut donc rester visible ;
  à nettoyer manuellement si besoin.
- **Suppression Notion → TickTick : toujours pas faite pour une page archivée "à la main".**
  Archiver une page Notion ne supprime pas la tâche TickTick correspondante — TickTick reste
  la donnée de référence. (La suppression d'un évènement Google Calendar, elle, supprime bien
  la tâche TickTick — voir section Google Calendar — mais ce n'est pas la même chose : l'ID
  TickTick de la page archivée disparaît simplement de la vue Notion sans déclencher de
  suppression.) Fermer complètement cette boucle nécessiterait de mémoriser, d'un passage à
  l'autre, quelles pages étaient liées à une tâche encore active — non fait à ce stade.
- **Champ `completedTime` de TickTick non fiable comme indicateur d'état courant** : il reste
  renseigné même après réouverture d'une tâche. Seul le champ `status` fait foi (géré
  correctement dans le script).

## Secrets requis

À configurer dans *Settings → Secrets and variables → Actions* :

- `TICKTICK_TOKEN` — jeton d'accès OAuth TickTick (app "Sync Calendaire" sur
  [developer.ticktick.com](https://developer.ticktick.com/manage)). **Expire au bout
  d'environ 180 jours, sans refresh token** — il faudra relancer le flux d'autorisation
  manuellement à ce moment-là (rappel programmé pour le 24/01/2027).
- `NOTION_TOKEN` — jeton de la connexion interne Notion "Sync Calendaire"
  ([notion.so/profile/integrations](https://www.notion.so/profile/integrations)), partagée
  avec les bases `✅ Tâches Freelance` et `Personnel`.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` — app OAuth "Sync
  Calendaire" créée sur [console.cloud.google.com](https://console.cloud.google.com) (projet
  `sync-calendaire`), scopes `calendar.events` (lecture/écriture des évènements) et
  `calendar.readonly` (liste des agendas, pour retrouver un calendrier par son nom). ⚠️ **Doit
  être en statut "Production"** dans l'écran de consentement OAuth (Google Auth Platform →
  Audience), sans quoi le jeton de rafraîchissement expire au bout de 7 jours seulement — en
  cas d'expiration, refaire le flux d'autorisation manuellement (compte Google perso).

## Maintenance

- `.github/workflows/keepalive.yml` fait un petit commit hebdomadaire pour éviter la
  désactivation automatique du planning après 60 jours d'inactivité du dépôt.
- Pour tester manuellement : onglet *Actions* → *Sync TickTick -> Notion* → *Run workflow*.
