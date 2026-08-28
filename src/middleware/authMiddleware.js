/**
 * Authentication middleware
 * Verifies the presence of tokens in session
 */

/**
 * Verifies that the user is authenticated
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.tokens) {
    return res.status(401).json({
      error: 'Not authenticated',
      requiresLogout: true,
    });
  }
  next();
}

module.exports = {
  requireAuth,
};
