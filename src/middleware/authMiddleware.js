/**
 * Middleware d'authentification
 * Vérifie la présence des tokens en session
 */

/**
 * Vérifie que l'utilisateur est authentifié
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.tokens) {
    return res.status(401).json({ 
      error: 'Non authentifié',
      requiresLogout: true 
    });
  }
  next();
}

module.exports = {
  requireAuth
};

