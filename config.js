// ============================================================================
// KONFIGURÁCIÓ – ezt a fájlt kell testreszabnod a saját beállításaiddal.
// Lásd a README.md "Első lépések" részét a pontos lépésekért.
// ============================================================================

export const CONFIG = {
  // Az Azure/Microsoft Entra alkalmazás-regisztráció "Application (client) ID"-ja.
  // README → "1. lépés: Azure alkalmazás regisztráció"
  clientId: '8095ff08-cb81-4637-8953-7bf260ce8782',

  // Biztonságos, személyenként elkülönített OneDrive-tárolás.
  // FIGYELEM: addig ne egyesítsd ezt az ágat a publikált oldalba, amíg a
  // SECURITY-MIGRATION.md lépései (mentés, mappák, jogosultságok, import) nem készültek el.
  storageMode: 'isolated',

  // A névjegyzéknek külön mappája van. Minden dolgozó OLVASHATJA,
  // de csak az adminisztrátor SZERKESZTHETI. A link csak "konkrét személyek" típusú lehet.
  directoryFolderLink: 'https://humanmachinekft24-my.sharepoint.com/:f:/g/personal/skovran_adam_humanmachine_hu/IgCOfqFRs5oYRZ2jeMXciXvdAXlJTEK8gkJkgIIXITzxR3c?e=rtK4Oy',
  directoryFileName: 'felhasznalok.json',

  // A személyes mappák linkjei nem kerülnek ebbe a nyilvános GitHub-fájlba.
  // Azokat a hozzáférésvédett felhasznalok.json névjegyzék tárolja, illetve
  // új felhasználó felvételekor az admin űrlapján kell megadni.

  // A korábbi közösen szerkeszthető fájl NEM használható a biztonságos módban.
  sharedFolderLink: '',

  // A szinkronizált adatfájl neve a megosztott mappában. Alapesetben nem kell módosítani.
  dataFileName: 'jelenleti-adatok.json',

  // Automatikus háttér-szinkronizáció gyakorisága, percben (amíg az app nyitva van).
  autoSyncIntervalMinutes: 5,

  // MSAL / Microsoft bejelentkezés hatóköre. 'common' = személyes ÉS munkahelyi/iskolai
  // fiókok egyaránt működnek. Ne módosítsd, hacsak nem tudod pontosan, mit csinálsz.
  msalAuthority: 'https://login.microsoftonline.com/common',
};
