// ============================================================================
// AUTH – Microsoft-fiókos bejelentkezés az MSAL.js könyvtárral.
// Ez a lépés adja az app identitását (ki vagyok) ÉS a OneDrive-hozzáférést
// egyszerre – nincs külön "app-jelszó", a saját Microsoft-fiókod a kulcs.
//
// A window.msal globális objektumot a js/vendor/msal-browser.min.js biztosítja
// (lásd index.html).
// ============================================================================

const SCOPES = ['User.Read', 'Files.ReadWrite'];

let msalInstance = null;
let currentAccount = null;

function makeError(code, cause) {
  const err = new Error(code);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

export function isAuthConfigured(clientId) {
  return typeof clientId === 'string' && clientId.trim() !== '' && !/^IDE-/i.test(clientId.trim());
}

/** A redirect URI = az app címe az "index.html" és a query nélkül. Pontosan ezt
 * kell megadni az Azure alkalmazás-regisztrációnál (SPA redirect URI). */
export function getRedirectUri() {
  const path = window.location.pathname.replace(/index\.html$/i, '');
  return window.location.origin + path;
}

export async function initAuth(clientId, authority) {
  if (typeof msal === 'undefined') throw makeError('MSAL_NOT_LOADED');

  msalInstance = new msal.PublicClientApplication({
    auth: {
      clientId,
      authority: authority || 'https://login.microsoftonline.com/common',
      redirectUri: getRedirectUri(),
      postLogoutRedirectUri: getRedirectUri(),
      navigateToLoginRequestUrl: false,
    },
    cache: {
      // localStorage: az app bejelentkezve marad böngésző-újraindítás után is.
      // (Ez egy nálad futó, valódi telepített alkalmazás; ez az MSAL ajánlott
      // beállítása olyan SPA-khoz, amelyeknek tartós munkamenet kell.)
      cacheLocation: 'localStorage',
    },
  });
  await msalInstance.initialize();

  // Ha redirect-alapú bejelentkezésből térünk vissza (pl. mert a popup blokkolva volt).
  let redirectResult = null;
  try {
    redirectResult = await msalInstance.handleRedirectPromise();
  } catch (e) {
    redirectResult = null;
  }
  if (redirectResult && redirectResult.account) {
    currentAccount = redirectResult.account;
  } else {
    const accounts = msalInstance.getAllAccounts();
    currentAccount = accounts.length > 0 ? accounts[0] : null;
  }
  return currentAccount;
}

export async function login() {
  if (!msalInstance) throw makeError('MSAL_NOT_READY');
  try {
    const result = await msalInstance.loginPopup({ scopes: SCOPES, prompt: 'select_account' });
    currentAccount = result.account;
    return currentAccount;
  } catch (err) {
    const code = err && err.errorCode;
    // Ha a felugró ablak nem nyitható (blokkolva / telepített PWA), átváltunk átirányításos belépésre.
    if (code === 'popup_window_error' || code === 'empty_window_error') {
      await msalInstance.loginRedirect({ scopes: SCOPES, prompt: 'select_account' });
      return null; // az oldal újratöltődik, a bejelentkezést az initAuth() fejezi be
    }
    throw err;
  }
}

export async function logout() {
  const account = currentAccount;
  currentAccount = null;
  if (!msalInstance || !account) return;
  try {
    await msalInstance.logoutPopup({
      account,
      postLogoutRedirectUri: getRedirectUri(),
      mainWindowRedirectUri: getRedirectUri(),
    });
  } catch (e) {
    try {
      if (typeof msalInstance.clearCache === 'function') await msalInstance.clearCache({ account });
    } catch (e2) { /* nem gond */ }
  }
}

export function getCurrentAccount() {
  return currentAccount;
}

/**
 * Hozzáférési token a Graph API híváshoz.
 * - Először mindig csendben próbálja (felhasználói beavatkozás nélkül).
 * - Ha ez nem megy, mert újra kell jelentkezni:
 *     interactive=true  -> felugró ablak (csak felhasználói kattintásra hívd így!)
 *     interactive=false -> INTERACTION_REQUIRED hiba (a háttér-szinkron ezt kapja, nem ugrik fel semmi)
 * - Ha hálózati hiba miatt nem sikerül, TOKEN_NETWORK hibát dob (nem "lejárt bejelentkezés").
 */
export async function getAccessToken({ interactive = false } = {}) {
  if (!msalInstance || !currentAccount) throw makeError('NOT_LOGGED_IN');
  const request = { scopes: SCOPES, account: currentAccount };
  try {
    const resp = await msalInstance.acquireTokenSilent(request);
    return resp.accessToken;
  } catch (silentErr) {
    const needsInteraction =
      (typeof msal !== 'undefined' &&
        typeof msal.InteractionRequiredAuthError === 'function' &&
        silentErr instanceof msal.InteractionRequiredAuthError) ||
      ['interaction_required', 'login_required', 'consent_required', 'no_tokens_found'].includes(
        silentErr && silentErr.errorCode
      );

    if (!needsInteraction) throw makeError('TOKEN_NETWORK', silentErr);
    if (!interactive) throw makeError('INTERACTION_REQUIRED', silentErr);

    try {
      const resp = await msalInstance.acquireTokenPopup(request);
      return resp.accessToken;
    } catch (popupErr) {
      throw makeError('TOKEN_ACQUISITION_FAILED', popupErr);
    }
  }
}
