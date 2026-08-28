/**
 * Authentication and session management module
 */
import { showConfirmModal } from './toast.js';

// Automatic logout function
export function handleAutoLogout() {
  console.log('❌ Session expired - automatic logout');
  // Clear the session
  sessionStorage.clear();
  // Return to the login page
  window.location = window.location.pathname;
}

// Fetch wrapper with auto-logout handling
export function setupFetchInterceptor() {
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch(...args);

    // If 401 error (not authenticated)
    if (response.status === 401) {
      const clonedResponse = response.clone();
      try {
        const data = await clonedResponse.json();
        if (data.requiresLogout) {
          handleAutoLogout();
          return response;
        }
      } catch (e) {
        // If no JSON, just log out
        handleAutoLogout();
      }
    }

    return response;
  };
}

// Manual logout
export async function handleDisconnect() {
  const ok = await showConfirmModal({
    title: 'Sign out',
    message: 'Are you sure you want to sign out?',
    type: 'warning',
    confirmText: 'Sign out',
  });
  if (ok) {
    // Destroy the server session (OAuth tokens + cookie) before redirecting.
    // Best-effort: clean up the UI and redirect even if the request fails.
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } catch (e) {
      console.warn('Server logout failed (cleaning up locally regardless):', e);
    }
    // Hide the user section
    document.getElementById('userSection').style.display = 'none';
    // Return to the sign-in interface
    document.getElementById('appInterface').style.display = 'none';
    document.getElementById('loginInterface').style.display = 'block';
    // Redirect to clean up the URL
    setTimeout(() => {
      window.location = window.location.pathname;
    }, 500);
  }
}

// Initialise the sign-in buttons
export function initLoginButtons() {
  document.getElementById('gmailBtn').onclick = () => {
    window.location = '/gmail/';
  };
  document.getElementById('outlookBtn').onclick = () => {
    window.location = '/outlook/';
  };
}
