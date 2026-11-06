# Jelenléti ív – biztonságos, külön OneDrive-adatfájlok

Ez a változat **nem igényel saját, folyamatosan futó szervert**. A hitelesítést
a Microsoft Entra ID, a tényleges fájljogosultságokat a Microsoft OneDrive /
SharePoint ellenőrzi. A GitHub Pages továbbra is csak a statikus webes felületet
szolgáltatja ki.

## Miért kell áttérni?

A korábbi közös `jelenleti-adatok.json` fájlhoz minden, szerkesztési joggal
rendelkező dolgozó közvetlen Microsoft Graph-hozzáférést kapott. A JavaScriptben
beállított `user`/`admin` szerepkör nem akadályozhatta meg a fájl közvetlen
olvasását vagy módosítását.

Az új modellben:

- `felhasznalok.json`: külön **névjegyzék**, benne csak ID, név, e-mail-cím,
  szerepkör és aktív állapot. Minden munkatárs **olvasási**, csak az admin
  **szerkesztési** jogot kap.
- Minden dolgozó saját `jelenleti-adatok.json` fájlt kap, benne a saját
  bejegyzéseivel és személyes szünetszabályaival. Csak az adott dolgozó és az
  adminisztrátor kap **szerkesztési** jogot ehhez a fájlhoz.
- A böngésző a névjegyzéket tölti le a bejelentkezés ellenőrzéséhez. Normál
  dolgozó kizárólag a saját adatfájlját kéri le; adminisztrátor az összesét.
- A dolgozó által meghamisított `role: "admin"` mező a saját fájljában
  nem ad adminjogot: a névjegyzékbeli szerepkör számít, **és** a OneDrive
  jogosultságának is engednie kell a másik fájlt.

**Fontos korlát:** A böngészőben helyileg már letöltött adatok a készülék
tárhelyén megmaradhatnak. Használj eszközzárat, külön Windows-/böngészőprofilokat,
és ne használj közös, őrizetlen gépet. Az offline működésből eredően a korábban
letöltött adatok távoli visszavonása nem garantálható.

## 0. Ne módosítsd a működő rendszert az átállás közben

1. Az összes eszközön indíts kézi szinkront, és ellenőrizd a sikeres állapotot.
2. Admin fiókkal tölts le friss **JSON biztonsági mentést** a Beállításokból.
3. Külön mappába tedd el a mentést. A korábbi közös adatfájlt ne töröld.
4. A biztonsági fejlesztési ágat ne egyesítsd a `main` ágba addig, amíg az új
   mappák és a migráció **nincsenek készen és külön tesztelve**.

## 1. OneDrive-mappák és hozzáférések

Hozz létre egymástól független OneDrive-mappákat a HumanMachine céges fiókban:

| Mappa | Ki olvashatja? | Ki szerkesztheti? |
|---|---|---|
| `JelenletiIv_Nevjegyzek` | Valamennyi résztvevő | Csak admin |
| `JelenletiIv_Adam` | Ádám és admin | Ádám és admin |
| `JelenletiIv_Dolgozo2` | A második dolgozó és admin | A második dolgozó és admin |
| `JelenletiIv_Dolgozo3` | A harmadik dolgozó és admin | A harmadik dolgozó és admin |

- Használd a **„Konkrét személyek”** (*Specific people*) megosztást.
- Ne használj **„Bárki, akinél megvan a hivatkozás”** vagy a teljes szervezet
  számára hozzáférést adó linket.
- A személyes mappák ne örököljenek szélesebb jogot egy mindenkivel megosztott
  szülőmappától. A személyenkénti ACL legyen a tényleges védelmi határ.
- A névjegyzék mappáját a normál dolgozókkal csak **olvasásra** oszd meg.
- Új dolgozó hozzáadásakor először hozd létre és oszd meg a személyes mappáját.
- Dolgozó letiltásakor a névjegyzékben való inaktiváláson **felül** vond vissza
  a személyes OneDrive-megosztási jogosultságát is.

Az adminisztrátor minden mappát kezelhet. A jelenlegi kód nem tudja automatikusan
létrehozni a OneDrive-megosztásokat; a jogosultságokat a Microsoft 365 felületén
kell konfigurálni és ellenőrizni.

## 2. Meglévő mentés felosztása

Node.js szükséges csak ehhez az egyszeri művelethez; az app használatához nem.
Nyiss terminált a repozitórium gyökerében, és futtasd:

```powershell
node tools/split-backup.mjs "C:\mentes\jelenleti-iv-mentes.json" "C:\mentes\felosztott"
```

Az új, üres kimeneti mappában létrejön:

```text
felosztott/
  directory/felhasznalok.json
  users/<felhasznalo-id>/jelenleti-adatok.json
  mapping.json
```

A `mapping.json` tartalmazza, hogy melyik e-mail-címhez melyik fájl tartozik.
A program ellenőrzi a felhasználóazonosítók egyediségét, a bejegyzések
tulajdonosát és az összes bejegyzés megőrzését. Nem írja felül a meglévő
kimeneti fájlokat, és semmit nem tölt fel az internetre.

1. **Előbb** szerkeszd a helyi `directory/felhasznalok.json` fájlt: minden
   felhasználó `dataFolderLink` mezőjébe illeszd be a hozzá tartozó,
   "Konkrét személyek" típusú személyes mappa megosztási linkjét. Ez a
   névjegyzék csak a céges dolgozók számára olvasható, és kizárólag admin
   módosíthatja.
2. A kitöltött `directory/felhasznalok.json` fájlt töltsd fel a névjegyzék
   mappájába (ne a linkek kitöltése előtti változatot).
3. Minden személyes `jelenleti-adatok.json` fájlt tölts fel a megfelelő személyes
   OneDrive-mappába.
4. A fájlok és a `mapping.json` **bizalmasak**: ne tedd őket GitHub-repozitóriumba.
5. Ellenőrizd, hogy a személyenkénti bejegyzésszámok összege megegyezik a mentés
   teljes bejegyzésszámával.

## 3. `config.js` beállítása

A biztonságos ágon jelenleg szándékosan **nincsenek kitöltve** az új linkek.
Ezért az alkalmazás nem lép vissza a korábbi, nem biztonságos közös fájlhoz;
konfigurációs hibával megáll, amíg minden szükséges adat hiányzik.

```javascript
storageMode: 'isolated',
directoryFolderLink: 'https://.../A_NEVJEGYZEK_SZEMELYEKRE_KORLATOZOTT_LINKJE',
directoryFileName: 'felhasznalok.json',
sharedFolderLink: '',
```

A személyes linkeket a `felhasznalok.json` fájl `dataFolderLink` mezőiben
tároljuk, nem a nyilvános `config.js`-ben. A dolgozófelvételi admin űrlap is
ilyen linket kér; új dolgozó üres személyes adatfájlját a program az első
adminisztrátori szinkron során létrehozza. A korábbi dolgozók hiányzó fájlját
viszont nem hozza létre üresen, hogy véletlenül se vesszenek el a régi adatok.

Mivel a `config.js` statikus és mindenki által letölthető, **sem kliens-titkot,
sem jelszót, sem hozzáférési tokent nem tartalmazhat**. A OneDrive-linkekre
önmagukban nem szabad jogosultságként támaszkodni; kizárólag a „Konkrét személyek”
megosztás és a Microsoft fiókhitelesítése nyújthat hozzáférésvédelmet.

Az Entra alkalmazásregisztráció támogatott fióktípusát lehetőleg korlátozd a
HumanMachine szervezeti címtárára (*single tenant*), és a `msalAuthority` mezőt
állítsd át a saját tenantazonosítódra. A `clientId` publikus azonosító, nem titok.

## 4. Jogosultsági teszt két külön Microsoft-fiókkal

1. **Admin:** a névjegyzéket és minden személyes adatfájlt megnyit és szerkeszt.
2. **Dolgozó:** saját személyes adatfájlját megnyitja és szerkeszti.
3. **Dolgozó:** egy másik dolgozó OneDrive-mappájának linkjét megnyitva
   hozzáférés-megtagadást kap. Ne csak a webalkalmazás felületét teszteld!
4. **Dolgozó:** a névjegyzékfájlt olvasni tudja, de közvetlenül módosítani nem.
5. **Külső Microsoft-fiók:** a mappák és a vállalati belépés nem adnak hozzáférést.
6. **Offline:** korábban online ellenőrzött fiókkal a saját gyorsítótárazott
   adatok elérhetők; új fiókkal offline első belépés tiltott.
7. A migráció után több eszközről hozz létre és módosíts bejegyzést, ellenőrizd
   az oda-vissza szinkronizációt és az admin nézetet.

Csak a tesztek után egyesítsd a fejlesztési ágat a `main` ágba. A régi közös
fájlhoz adott korábbi szerkesztési jogokat ekkor szüntesd meg; a mentéseket
őrizd meg külön.

## Ismert műszaki korlátok

- A szolgáltatás tényleges jogosultsági biztonsága a OneDrive ACL helyes
  beállításától függ. A frontend saját szerepkör-ellenőrzése nem helyettesíti azt.
- Az alkalmazás IndexedDB-alapú offline gyorsítótára nem végponttól végpontig
  titkosított adattár. Elveszett/fertőzött, feloldott eszköznél további
  kockázatok maradnak.
- Az admin által létrehozott új felhasználó személyes OneDrive-mappáját és annak
  megosztási jogosultságait előbb kézzel létre kell hozni; az üres adatfájlt
  ezután a program inicializálhatja. A felhasználó inaktiválása nem vonja vissza
  automatikusan a Microsoft-mappamegosztást.
- Egyszerre történő módosításoknál továbbra is a rekordok `updatedAt` ideje
  és a OneDrive-fájl `eTag` feltételei döntenek. Élesítés előtt kétklienses
  konfliktusteszt szükséges.
- Valódi Microsoft 365 fiókokkal végzett end-to-end teszt nélkül a rendszer
  **nem tekinthető éles biztonsági auditon átesettnek**.
