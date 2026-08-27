# Sync Calendaire — TickTick ↔ Notion

Synchronisation bidirectionnelle et gratuite entre TickTick et Notion.
Fait partie du projet "Sync Calendaire" (voir la page Notion dédiée dans la base ⚡ Workflow).

## Principe

- Deux listes TickTick (`Freelance`, `Personnel`) sont synchronisées avec deux bases Notion
  (`✅ Tâches Freelance`, `Personnel`) toutes les 5 minutes via
  [GitHub Actions](.github/workflows/sync.yml).
- **Bidirectionnel** : éditer le titre, la date, les tags, la description ou cocher "fait"
  d'un côté se répercute de l'autre, et inversement.
- **Détection des changements par empreinte de contenu**, pas par horodatage. Notion arrondit
  `last_edited_time` à la seconde et TickTick ne met pas toujours à jour `modifiedTime` après
  une modification via l'API (constaté empiriquement) — aucun des deux horodatages n'est fiable
  comme unique signal. Chaque page Notion stocke donc "Sync Snapshot", une empreinte JSON des
  champs synchronisables telle qu'on l'a vue en dernier des deux côtés à la fois.
- **Conflit** (les deux côtés modifiés dans la même fenêtre de 5 min) : TickTick gagne, par
  convention simple plutôt que de deviner qui est "le plus récent" sans horodatage fiable.
- `⚡ Workflow` (les projets : AMGE, BrainUp, etc.) n'est jamais touché par ce sync — seule la
  relation "Projet" sur `✅ Tâches Freelance` s'y connecte, via une correspondance tag TickTick
  ↔ nom de projet.
- Les sous-tâches (checklist items rattachés à une tâche parente) ne sont pas synchronisées
  individuellement.

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
- **Suppression Notion → TickTick : jamais faite.** Archiver une page Notion ne supprime
  jamais la tâche TickTick correspondante — TickTick reste la donnée de référence.
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

## Maintenance

- `.github/workflows/keepalive.yml` fait un petit commit hebdomadaire pour éviter la
  désactivation automatique du planning après 60 jours d'inactivité du dépôt.
- Pour tester manuellement : onglet *Actions* → *Sync TickTick -> Notion* → *Run workflow*.
