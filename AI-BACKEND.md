# Backend IA — VitiTrace

## Ou vit l'IA
Toutes les analyses IA passent par des fonctions serverless Vercel dans `api/` :
- `api/chat.js`   : proxy generique (analyses texte)
- `api/conseil.js`: diagnostic phyto a partir d'une photo (vision)
- `api/scan.js`   : scan etiquette / cadastre / E-phy (vision)

Chacune appelle l'API Anthropic (`https://api.anthropic.com/v1/messages`).

## Modele
Le nom du modele n'est PLUS code en dur. Il est lu depuis la variable
d'environnement Vercel `ANTHROPIC_MODEL`, avec un fallback dans le code :

```js
const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
```

Valeur actuelle : `ANTHROPIC_MODEL = claude-sonnet-4-5` (Production + Preview).

## En cas de depreciation de modele (procedure 30 s)
1. Vercel > projet `viti-tracabilit` > Settings > Environment Variables.
2. Editer `ANTHROPIC_MODEL` avec le nouveau nom de modele (ex. `claude-sonnet-4-6`).
3. Redeploy (le bouton propose par Vercel apres la modif suffit).
=> Aucune modification de code, aucun commit.

## Cles
- `ANTHROPIC_API_KEY` : cle API Anthropic (NE JAMAIS mettre en dur dans le code).
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` : config Supabase (servie par `api/config.js`).

## Gestion d'erreur
`api/chat.js` renvoie desormais un HTTP 502 explicite (avec `detail` + `model`)
quand l'API Anthropic retourne une erreur (ex. modele introuvable), au lieu de
masquer l'echec derriere un 200. Les logs Vercel contiennent `[chat] Erreur API...`.

## A surveiller
Les modeles Anthropic dates sont susceptibles d'etre deprecies. Verification
conseillee ~tous les 6 mois.
Prochaine verification conseillee : **decembre 2026**.
