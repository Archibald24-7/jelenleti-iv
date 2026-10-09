// ============================================================================
// KONFIGURÁCIÓ – ezt a fájlt kell testreszabnod a saját beállításaiddal.
// Lásd a README.md "Első lépések" részét a pontos lépésekért.
// ============================================================================

export const CONFIG = {
  // Az Azure/Microsoft Entra alkalmazás-regisztráció "Application (client) ID"-ja.
  // README → "1. lépés: Azure alkalmazás regisztráció"
  clientId: '8095ff08-cb81-4637-8953-7bf260ce8782',

  // A megosztott OneDrive mappa MEGOSZTÁSI LINKJE (szerkesztési joggal!).
  // README → "2. lépés: megosztott OneDrive mappa"
  // Példa: 'https://1drv.ms/f/s!Abc123...' vagy '...-my.sharepoint.com/:f:/g/...'
  sharedFolderLink: 'https://humanmachinekft24-my.sharepoint.com/:f:/g/personal/skovran_adam_humanmachine_hu/IgDyjYSct2M5RrtcCsBgzEEeATjdNrMqmWrfaOM-o6NksVA',

  // A szinkronizált adatfájl neve a megosztott mappában. Alapesetben nem kell módosítani.
  dataFileName: 'jelenleti-adatok.json',

  // Automatikus háttér-szinkronizáció gyakorisága, percben (amíg az app nyitva van).
  autoSyncIntervalMinutes: 5,

  // MSAL / Microsoft bejelentkezés hatóköre. 'common' = személyes ÉS munkahelyi/iskolai
  // fiókok egyaránt működnek. Ne módosítsd, hacsak nem tudod pontosan, mit csinálsz.
  msalAuthority: 'https://login.microsoftonline.com/common',
};
