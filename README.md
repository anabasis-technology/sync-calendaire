# Sync Calendaire — TickTick → Notion

Synchronisation automatique, unidirectionnelle et gratuite des tâches TickTick vers Notion.
Fait partie du projet "Sync Calendaire" (voir la page Notion dédiée dans la base ⚡ Workflow).

## Principe

- **TickTick** reste la seule source de vérité pour les tâches (créées à la voix via Alexa,
  depuis l'app, peu importe).
- Ce script lit les listes TickTick `Freelance` et `Personnel` toutes les 5 minutes via
  [GitHub Actions](.github/workflows/sync.yml) et crée/met à jour les pages correspondantes
  dans les bases Notion `⚡ Workflow` et `Personnel`.
- Le sens est unique : Notion n'est jamais réécrit vers TickTick. Pas de boucle possible.
- Les sous-tâches (checklist items rattachés à une tâche parente) ne sont pas synchronisées
  individuellement.

## Pourquoi 5 minutes, pas plus rapide ?

TickTick n'expose aucun webhook — impossible d'être notifié en temps réel, quel que soit
l'outil. Cinq minutes est le minimum technique imposé par GitHub Actions (`schedule` cron),
gratuit ou payant. Le dépôt est **public** pour bénéficier des minutes Actions illimitées
(un dépôt privé serait plafonné à 2000 min/mois, insuffisant pour un passage toutes les 5 min
facturé minute entière par run).

Aucune donnée personnelle ne transite par le dépôt lui-même : le code ne fait que lire/écrire
via API à la volée, et n'écrit jamais de contenu de tâche dans les logs (dépôt public = logs
publics).

## Secrets requis

À configurer dans *Settings → Secrets and variables → Actions* :

- `TICKTICK_TOKEN` — jeton d'accès OAuth TickTick (app "Sync Calendaire" sur
  [developer.ticktick.com](https://developer.ticktick.com/manage)). **Expire au bout
  d'environ 180 jours, sans refresh token** — il faudra relancer le flux d'autorisation
  manuellement à ce moment-là.
- `NOTION_TOKEN` — jeton de la connexion interne Notion "Sync Calendaire"
  ([notion.so/profile/integrations](https://www.notion.so/profile/integrations)), partagée
  avec les bases `⚡ Workflow` et `Personnel`.

## Maintenance

- `.github/workflows/keepalive.yml` fait un petit commit hebdomadaire pour éviter la
  désactivation automatique du planning après 60 jours d'inactivité du dépôt.
- Pour tester manuellement : onglet *Actions* → *Sync TickTick -> Notion* → *Run workflow*.
