// ============================================================================
// KONFIGURÁCIÓ – ezt a fájlt kell testreszabnod a saját beállításaiddal.
// Lásd a README.md "Első lépések" részét a pontos lépésekért.
// ============================================================================

export const CONFIG = {
  // Az Azure/Microsoft Entra alkalmazás-regisztráció "Application (client) ID"-ja.
  // README → "1. lépés: Azure alkalmazás regisztráció"
  clientId: 'IDE-ÍRD-BE-A-CLIENT-ID-T',

  // A megosztott OneDrive mappa MEGOSZTÁSI LINKJE (szerkesztési joggal!).
  // README → "2. lépés: megosztott OneDrive mappa"
  // Példa: 'https://1drv.ms/f/s!Abc123...' vagy '...-my.sharepoint.com/:f:/g/...'
  sharedFolderLink: 'IDE-ÍRD-BE-A-ONEDRIVE-MEGOSZTÁSI-LINKET',

  // A szinkronizált adatfájl neve a megosztott mappában. Alapesetben nem kell módosítani.
  dataFileName: 'jelenleti-adatok.json',

  // Automatikus háttér-szinkronizáció gyakorisága, percben (amíg az app nyitva van).
  autoSyncIntervalMinutes: 5,

  // MSAL / Microsoft bejelentkezés hatóköre. 'common' = személyes ÉS munkahelyi/iskolai
  // fiókok egyaránt működnek. Ne módosítsd, hacsak nem tudod pontosan, mit csinálsz.
  msalAuthority: 'https://login.microsoftonline.com/common',
};
