# Déploiement Railway (CD via GitHub Actions)

Le workflow `.github/workflows/ci.yml` déploie automatiquement sur Railway
**à chaque push sur `main`**, après le succès des tests. Le job `deploy` reste
inactif (juste un avertissement) tant que le secret `RAILWAY_TOKEN` n'est pas
défini — donc rien ne casse avant que tu l'aies configuré.

Deux endroits à ne PAS confondre :

- **Secrets/variables GitHub Actions** → servent au *déploiement* (auth Railway).
- **Variables Railway** → servent à l'*exécution* de l'app (SESSION_SECRET,
  clés OAuth, REDIS_URL, APP_ORIGIN, ALLOW_LOCAL_AI…). Elles se mettent côté
  Railway, pas dans GitHub.

---

## 1. Récupérer un token Railway

1. Va sur https://railway.app → ouvre **ton projet**.
2. **Settings → Tokens** (jeton *de projet*, recommandé car limité à ce projet).
   - Alternative : jeton de compte via https://railway.app/account/tokens.
3. Clique **Create Token**, donne-lui un nom (ex. `github-actions`), puis
   **copie la valeur** (elle ne sera affichée qu'une fois).

## 2. Ajouter le token dans GitHub (secret)

1. Sur le repo GitHub : **Settings → Secrets and variables → Actions**.
2. Onglet **Secrets** → **New repository secret**.
3. Name : `RAILWAY_TOKEN`
4. Secret : *(colle le token de l'étape 1)*
5. **Add secret**.

## 3. (Optionnel) Cibler un service précis

Utile seulement si ton projet Railway a **plusieurs services**.

1. Même page → onglet **Variables** → **New repository variable**.
2. Name : `RAILWAY_SERVICE`
3. Value : le nom exact du service tel qu'affiché dans Railway.
4. **Add variable**.

Si tu ne mets rien, `railway up` déploie le service par défaut du projet.

## 4. Configurer l'app côté Railway (variables d'exécution)

Dans **Railway → ton service → Variables**, ajoute les variables dont l'app a
besoin au runtime (⚠️ pas dans GitHub) :

| Variable | Rôle |
|---|---|
| `SESSION_SECRET` | obligatoire hors dev (sinon l'app refuse de démarrer) |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | OAuth Gmail |
| `OUTLOOK_CLIENT_ID` / `OUTLOOK_CLIENT_SECRET` | OAuth Outlook |
| `APP_ORIGIN` | origine publique de l'app (ex. `https://<projet>.up.railway.app`) pour le CORS |
| `REDIS_URL` | fourni automatiquement si tu ajoutes le plugin Redis Railway |
| `ALLOW_LOCAL_AI` | `true` seulement si tu utilises un Ollama local (inutile en prod) |
| `PORT` | géré par Railway automatiquement — ne pas forcer |

Pense aussi à mettre à jour les **URIs de redirection OAuth** (Google Cloud /
Azure) avec l'URL Railway.

## 5. Déclencher et vérifier

1. Fusionne/pousse sur **`main`** (sur une branche `feature/*`, le job deploy
   est volontairement **sauté**).
2. GitHub → onglet **Actions** → ouvre le run → job **Deploy to Railway**.
3. En cas de souci : vérifie que `RAILWAY_TOKEN` est bien présent (le job
   affiche un avertissement s'il est absent) et que le service Railway démarre
   avec `npm start`.
