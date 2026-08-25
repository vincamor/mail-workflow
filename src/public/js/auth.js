/**
 * Module de gestion de l'authentification et de la session
 */
import { showConfirmModal } from './toast.js';

// Fonction de déconnexion automatique
export function handleAutoLogout() {
  console.log("❌ Session expirée - Déconnexion automatique");
  // Nettoyer la session
  sessionStorage.clear();
  // Retourner à la page de connexion
  window.location = window.location.pathname;
}

// Wrapper fetch avec gestion auto-déconnexion
export function setupFetchInterceptor() {
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      const response = await originalFetch(...args);

      // Si erreur 401 (non authentifié)
      if (response.status === 401) {
        const clonedResponse = response.clone();
        try {
          const data = await clonedResponse.json();
          if (data.requiresLogout) {
            handleAutoLogout();
            return response;
          }
        } catch (e) {
          // Si pas de JSON, juste déconnecter
          handleAutoLogout();
        }
      }

      return response;
    } catch (error) {
      throw error;
    }
  };
}

// Déconnexion manuelle
export async function handleDisconnect() {
  const ok = await showConfirmModal({
    title: 'D\u00e9connexion',
    message: '\u00cates-vous s\u00fbr de vouloir vous d\u00e9connecter\u00a0?',
    type: 'warning',
    confirmText: 'Se d\u00e9connecter',
  });
  if (ok) {
    // Detruire la session serveur (tokens OAuth + cookie) avant de rediriger.
    // Best-effort : on nettoie l'UI et on redirige meme si la requete echoue.
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } catch (e) {
      console.warn('Logout serveur echoue (nettoyage local malgre tout) :', e);
    }
    // Masquer la section utilisateur
    document.getElementById("userSection").style.display = "none";
    // Retourner à l'interface de connexion
    document.getElementById("appInterface").style.display = "none";
    document.getElementById("loginInterface").style.display = "block";
    // Rediriger pour nettoyer l'URL
    setTimeout(() => {
      window.location = window.location.pathname;
    }, 500);
  }
}

// Initialiser les boutons de connexion
export function initLoginButtons() {
  document.getElementById("gmailBtn").onclick = () => {
    window.location = "/gmail/";
  };
  document.getElementById("outlookBtn").onclick = () => {
    window.location = "/outlook/";
  };
}


