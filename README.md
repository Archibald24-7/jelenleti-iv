# Jelenléti Ív Kezelő

Cross-platform (Windows 11, Windows 10, Android, később iOS), csapatszintű jelenléti ív
kezelő alkalmazás, megosztott OneDrive-alapú szinkronizációval, offline működéssel,
automatikus bejegyzés-észleléssel és véletlen időpont-generátorral.

Ez egy **Progressive Web App (PWA)**: egyetlen HTML/CSS/JS kódbázis, amit bármelyik
eszközödön telepíthetsz, böngészőn keresztül, Play Store/App Store nélkül. Az adatok
egy általad megosztott OneDrive-mappában tárolódnak; minden eszköz a Microsoft Graph
API-n keresztül szinkronizál oda-vissza. Nincs szükség saját szerverre.

**Fontos, hogy tudd:** ez a projekt egy fejlesztői sandbox-környezetben készült, éles
Windows/Android eszközön nem volt tesztelve. A kódot alapos automatikus tesztekkel
(lásd `test/` mappa a forrás-csomagban, ha kéred) és böngésző-szimulációval ellenőriztem,
de az első éles beüzemeléskor apróbb hibák előfordulhatnak - ezekben szívesen segítek.

----

## Tartalomjegyzék

1. [Gyors áttekintés – mit tud az app](#gyors-áttekintés--mit-tud-az-app)
2. [Architektúra dióhéjban](#architektúra-dióhéjban)
3. [Első lépések (telepítés)](#első-lépések-telepítés)
4. [Használat](#használat)
5. [Ismert korlátok – olvasd el, mielőtt bevezeted](#ismert-korlátok--olvasd-el-mielőtt-bevezeted)
6. [Hibaelhárítás](#hibaelhárítás)
7. [Fájlszerkezet](#fájlszerkezet)
8. [Jövőbeli bővítési ötletek](#jövőbeli-bővítési-ötletek)

---

## Gyors áttekintés – mit tud az app

- **Automatikus bejegyzés-észlelés**: telefonon az app megnyitásakor, Windows gépen a
  bejelentkezéskor automatikusan induló alkalmazás elindulásakor.
- **Kézi és visszamenőleges bejegyzés** bármelyik napra.
- **Véletlen időpont-generátor**: a kezdés a megadott tartományban egyenletesen
  véletlenszerű, a napi munkaidő hossza egy minimum-maximum sávon belül
  **Gauss-eloszlású** (a sáv közepe a leggyakoribb érték). Kihagyhatja a hétvégéket
  ÉS a magyar munkaszüneti napokat (Húsvéthez kötött mozgó ünnepekkel együtt,
  automatikusan bármelyik évre). Opcionálisan **heti vagy havi célóraszám** is
  megadható (± tűréssel) - ilyenkor a generátor a hét/hónap hátralévő napjaira
  dinamikusan újraszámolja a szükséges napi átlagot, hogy megközelítse a célt.
- **Részletes szűrés a bejegyzések között**: felhasználó, év, hónap, szabad
  dátumtartomány, forrás (mindig csak a ténylegesen előforduló forrásokkal
  feltöltve), és szabad szöveges keresés a megjegyzésekben (részleges
  egyezéssel, `*` joker-karakterrel bővíthetően). A nyomtatás és a
  CSV-exportálás mindig csak az éppen szűrt listát exportálja.
- **Munkaközi szünet levonása**: felhasználónként, tetszőleges számú dátumtartománnyal
  (pl. 20 perc 2024.02.01–10. között, 30 perc 2024.02.11-től). A bejegyzés sorában
  látszik a levonás, a ledolgozott idő = (vége − kezdés) − levonás; szűrhető és
  tömegesen szerkeszthető. A véletlen generátor a valós munkaidőt tartja a megadott
  sávban, a levonást a záró időponthoz adja.
- **Tömeges kijelölés és műveletek**: a bejegyzés-sorok elején lévő
  jelölőnégyzetekkel (vagy a fejléc "összes kijelölése" dobozával) egyszerre
  több bejegyzés is kiválasztható, majd tömegesen szerkeszthető (Forrás és/vagy
  Megjegyzés) vagy törölhető. Saját nézetben csak a saját bejegyzések
  jelennek meg, tehát ott csak azokat lehet kijelölni; admin az "Összes
  bejegyzés" nézetben bárkiét.
- **Több felhasználó, két szerepkör**: "felhasználó" (csak saját adatok) és "admin"
  (mindenki adatának megtekintése és szerkesztése).
- **Megosztott OneDrive-tárolás**, Microsoft Graph API-n keresztül, saját szerver nélkül.
- **Offline-first működés**: minden adat előbb helyben (IndexedDB) tárolódik, a
  szinkronizáció csak ezután, a háttérben történik. Az app internet nélkül is 100%-ban
  használható.
- **Automatikus újraszinkronizálás**, amint helyreáll a kapcsolat, plusz kézi
  "Szinkronizálj most" gomb, és jól látható hibaüzenet, ha a szinkron nem sikerül.
- **CSV-exportálás és nyomtatható nézet** a bejegyzésekhez.
- **Telepíthető PWA**: Windows 10/11-en és Androidon saját ablakkal/ikonnal települ.

---

## Architektúra dióhéjban

```
 Windows laptop        Windows PC          Android telefon
 (helyi offline tár)   (helyi offline tár) (helyi offline tár)
        │                    │                    │
        └──────────────┬─────┴─────┬──────────────┘
                        ▼           ▼
              OneDrive – megosztott mappa
                 (egy közös JSON adatfájl)
```

Minden eszköz a **saját Microsoft-fiókjával** jelentkezik be (MSAL.js könyvtár), és ez a
bejelentkezés egyszerre adja meg:

1. **ki vagy** (az app ez alapján dönti el, hogy melyik felhasználói rekordhoz tartozol,
   és milyen szerepkörrel), és
2. **hozzáférést a megosztott OneDrive-mappához** (Microsoft Graph API, `Files.ReadWrite`
   jogosultsággal).

Nincs saját backend szerver: az alkalmazás egy statikus fájlokból álló weboldal, ami
közvetlenül a Microsoft felhőjével beszél.

---

## Első lépések (telepítés)

Összesen 3 fő lépés van: **(1)** fájlok feltöltése egy webtárhelyre, **(2)** egy Microsoft
alkalmazás-regisztráció, **(3)** egy megosztott OneDrive-mappa. Utána már csak
be kell lépni.

Ha ezt még nem csinálod végig, az app **helyi módban** is elindul (lásd
[Helyi mód kipróbáláshoz](#helyi-mód-kipróbáláshoz) lent) - így azonnal ki tudod
próbálni a felületet, mielőtt a teljes beüzemelésbe belevágsz.

### 1. lépés: fájlok feltöltése HTTPS-tárhelyre

A böngészős bejelentkezéshez (MSAL) és a PWA-telepítéshez **HTTPS címre** van szükség
(nem elég a fájlok helyi megnyitása `file://`-ként). A legegyszerűbb, ingyenes megoldás
a **GitHub Pages**:

1. Hozz létre egy (akár privát) GitHub-repót, pl. `jelenleti-iv`.
2. Töltsd fel bele ennek a csomagnak **az összes fájlját és mappáját** (a `test/` mappa
   nem kell, ha esetleg kapnád, az csak fejlesztői teszt).
3. A repó **Settings → Pages** menüjében kapcsold be a GitHub Pages-t (branch: `main`,
   mappa: `/ (root)`).
4. Néhány perc múlva elérhető lesz itt: `https://FELHASZNALONEVED.github.io/jelenleti-iv/`

*Alternatíva:* Azure Static Web Apps (ingyenes szint, ugyanabban a Microsoft-ökoszisztémában,
ahol az Azure-alkalmazást is regisztrálod), vagy bármilyen más statikus HTTPS-tárhely
(Netlify, Vercel, saját IIS/nginx). A lényeg: sima statikus fájlkiszolgálás kell,
build-lépés nélkül.

Jegyezd fel a végleges URL-t - a következő lépésekben többször kelleni fog.

### 2. lépés: Azure alkalmazás-regisztráció (Microsoft Entra ID)

Ez adja meg az app-nak az engedélyt, hogy Microsoft-fiókkal be lehessen jelentkezni.
Ingyenes, és **személyes Microsoft-fiókkal is működik** (nem kell céges/Microsoft 365
előfizetés).

1. Nyisd meg: <https://entra.microsoft.com> (ha ez nem lenne elérhető, a klasszikus
   <https://portal.azure.com> → "Microsoft Entra ID" is ugyanide vezet).
2. Bal oldali menü → **Alkalmazás-regisztrációk** (App registrations) → **Új regisztráció**.
3. Név: pl. `Jelenléti Ív Kezelő`.
4. Támogatott fióktípusok: **"Fiókok bármely szervezeti címtárban és személyes Microsoft-fiókok"**
   (ez engedi, hogy céges ÉS személyes @outlook.com/@gmail-lel regisztrált Microsoft-fiókok
   egyaránt bejelentkezhessenek).
5. Átirányítási URI (Redirect URI): típus **"Egyoldalas alkalmazás (SPA)"**, érték: az
   1. lépésben kapott URL-ed (pl. `https://felhasznalonev.github.io/jelenleti-iv/`).
   - Helyi teszteléshez érdemes egy második bejegyzést is felvenni, pl.
     `http://localhost:5500/` (attól függően, milyen porton futtatod helyben).
6. **Regisztráció** gomb.
7. A megnyíló "Áttekintés" oldalon másold ki az **"Alkalmazás (ügyfél) azonosítója"**
   (Application/Client ID) értéket - ez egy GUID, pl. `a1b2c3d4-...`.
8. Bal oldali menü → **API-engedélyek** (API permissions) → **Engedély hozzáadása** →
   **Microsoft Graph** → **Delegált engedélyek** → keresd meg és pipáld be:
   - `User.Read` (általában alapból ott van)
   - `Files.ReadWrite`

   Személyes Microsoft-fiókoknál ehhez nem kell külön admin-jóváhagyás; a felhasználó
   az első bejelentkezéskor saját maga hagyja jóvá.

Másold be a Client ID-t a `config.js` fájlba (lásd 4. lépés).

### 3. lépés: megosztott OneDrive-mappa

1. A OneDrive-odon (<https://onedrive.com>, azzal a fiókkal, amivel az 2. lépésben is
   dolgoztál) hozz létre egy mappát, pl. `JelenletiIvAdatok`.
2. Kattints jobb gombbal → **Megosztás**.
3. Adj **szerkesztési jogosultságot** (nem csak megtekintést!) a csapattagok e-mail
   címeinek megadásával, VAGY válaszd az "Bárki, akinél megvan a hivatkozás" opciót,
   ha ez elfogadható a ti környezetetekben.
4. Másold ki a létrejött **megosztási linket**.

Ez a link megy a `config.js`-be. Az app ebben a mappában fog létrehozni egy
`jelenleti-adatok.json` nevű fájlt - ide kerül majd minden felhasználó és bejegyzés.

### 4. lépés: `config.js` kitöltése

Nyisd meg a feltöltött `config.js` fájlt (akár közvetlenül a GitHub webes szerkesztőjével),
és töltsd ki:

```js
export const CONFIG = {
  clientId: 'ide-a-2-lepesben-kapott-client-id',
  sharedFolderLink: 'ide-a-3-lepesben-kapott-megosztasi-link',
  dataFileName: 'jelenleti-adatok.json',
  autoSyncIntervalMinutes: 5,
  msalAuthority: 'https://login.microsoftonline.com/common',
};
```

Mentsd el, és ha GitHub Pages-t használsz, várj kb. 1 percet, amíg újra közzéteszi az oldalt.

### 5. lépés: első bejelentkezés

Nyisd meg az app URL-jét bármelyik böngészőben. Jelentkezz be a Microsoft-fiókoddal.
**Az elsőként bejelentkező fiók automatikusan adminisztrátor lesz** (feltéve, hogy a
megosztott adatfájl még teljesen üres - ez az első indításnál mindig igaz).

### 6. lépés: további felhasználók felvétele

Admin → **Felhasználók** → **Felhasználó felvétele**. Add meg a kollégád nevét és
**pontosan azt az e-mail címet**, amivel ő be fog jelentkezni. Csak az itt felvett
címek tudnak majd belépni.

### 7. lépés: telepítés minden eszközre

- **Windows (Edge/Chrome)**: nyisd meg az URL-t, majd a címsor jobb szélén (vagy a
  böngésző menüjében) kattints a **"Telepítés"** / **"Alkalmazás telepítése"** gombra.
  Ez után az app a Start menüből, saját ablakban indul.
- **Android (Chrome)**: nyisd meg az URL-t, a menüben válaszd a **"Alkalmazás telepítése"**
  / **"Hozzáadás a kezdőképernyőhöz"** lehetőséget.
- **iPhone/iPad (Safari)**: Megosztás ikon → **"Főképernyőhöz adás"**.

### 8. lépés (opcionális, Windows): automatikus indítás bejelentkezéskor

Ez teszi lehetővé, hogy a Windows-bejelentkezés automatikusan rögzítse a munkakezdést.
A telepített app **Beállítások** oldala legenerál neked egy kész, a saját URL-eddel
kitöltött PowerShell-parancsot - csak másold ki, és illeszd be egy PowerShell-ablakba
(Start → írd be: `PowerShell`).

Ha inkább egy önálló szkriptfájlt szeretnél (pl. több gépen szeretnéd egyszerre
beállítani), használd a csomagban lévő `windows-setup/setup-autostart.ps1`-t:

```powershell
powershell -ExecutionPolicy Bypass -File setup-autostart.ps1 -AppUrl "https://felhasznalonev.github.io/jelenleti-iv/index.html"
```

Ez egy parancsikont hoz létre a Startup mappában - nem igényel rendszergazdai jogot.
Eltávolítás: `Win+R` → `shell:startup` → töröld a `JelenletiIv.lnk` fájlt.

### Fejlesztői tipp: ha a módosítások "nem látszanak"

Helyi teszteléshez (pl. VS Code Live Server, `localhost`/`127.0.0.1`) az app
mostantól **szándékosan nem regisztrál Service Workert** - éles (nem localhost)
címen még mindig igen, az offline-működéshez. Ha mégis egy régebbi verziót
látnál beragadva (mert korábban már futott a service worker), egyszer
töröld a böngésző tárolt adatait erre az oldalra: DevTools (F12) → Application
fül → Service Workers → "Unregister", majd Storage → "Clear site data", és
töltsd újra az oldalt.

### Helyi mód kipróbáláshoz

Ha a `config.js`-t még nem töltötted ki (a `clientId` / `sharedFolderLink` még a
`IDE-ÍRD-BE-...` alapértéken van), az app automatikusan **helyi módba** kapcsol:
nincs Microsoft-bejelentkezés, nincs szinkron, minden adat csak az adott böngészőben/
eszközön tárolódik. Ez a mód a teljes felületet kipróbálhatóvá teszi (irányítópult,
bejegyzések, admin nézetek, véletlen generátor) anélkül, hogy bármit be kellene
állítanod - és build-lépés sincs, elég egy tetszőleges statikus fájlszerverrel
(pl. `npx serve` vagy VS Code "Live Server" kiegészítője) megnyitni.

---

## Használat

- **Irányítópult**: mai állapot (bejelentkezve/nincs bejelentkezve), gyors
  bejelentkezés/kijelentkezés, mai és havi óraszám, legutóbbi bejegyzések.
- **Bejegyzéseim / Összes bejegyzés** (admin): szűrés felhasználóra (admin), évre,
  hónapra, szabad dátumtartományra, forrásra, és a megjegyzés szövegére (részleges
  egyezéssel, `*` joker-karakterrel - pl. `proj*terv` megtalálja a "projekt záró
  terv" szöveget is). Új bejegyzés felvétele (akár visszamenőleg), szerkesztés,
  törlés (visszavonható), CSV-exportálás, nyomtatás - mindkettő mindig csak az
  éppen aktív szűrésnek megfelelő, látható bejegyzéseket exportálja/nyomtatja.
  Az "Szűrők törlése" gomb egy kattintással visszaállítja az alapállapotot.
  Egy vagy több sor kijelölésekor megjelenik a tömeges művelet-sáv
  ("Tömeges szerkesztés" / "Törlés" / "Kijelölés törlése").
- **Véletlen generátor**: adj meg egy dátumtartományt, egy kezdés-időtartományt
  (mikor kezdődhet a munka), és egy napi minimum/maximum munkaidő-sávot (órában).
  A generátor a sáv közepéhez közeli időtartamokat gyakrabban választja
  (Gauss-eloszlás), a szélsőértékeket ritkábban. Kihagyhatod a hétvégéket és a
  magyar munkaszüneti napokat. Opcionálisan heti vagy havi célóraszámot (± tűréssel)
  is megadhatsz - ilyenkor a napi átlagot a hét/hónap hátralévő napjaira dinamikusan
  újraszámolja, hogy megközelítse a célt (a már meglévő bejegyzések órái is
  beleszámítanak). Ez sosem lesz perc-pontos - ahogy nem is kell annak lennie.
  A Forrás oszlopban a generált bejegyzések "Kézi"-ként jelennek meg (nem
  különböztethetők meg vizuálisan a kézzel felvettektől) - a Megjegyzés mezőben
  viszont megmarad az "Automatikusan generált időpont" szöveg, saját
  tájékoztatásul, hogy utólag is lásd, melyik bejegyzés származik innen.
- **Felhasználók** (csak admin): felhasználók felvétele, szerkesztése, inaktiválása.
- **Beállítások**: szinkron-állapot és kézi szinkron, eszköznév, automatikus
  bejegyzés-észlelés be/ki, PWA telepítés, Windows automatikus indítás parancsa,
  biztonsági mentés (admin), helyi adatok törlése.

---

## Munkaközi szünet levonása

**Hol állítható be?** Mindenki a saját szabályait a *Beállítások → Szünet-levonás*
kártyán, az admin bárkiét a *Felhasználók* listában (óra-ikon a sor végén; az oszlop
az aznapra érvényes értéket mutatja). Egy szabály: *ettől* – *eddig* – *levonandó perc*.
Az üres „ettől” = kezdettől, az üres „eddig” = nincs vége. **Átfedő időszakoknál a később
kezdődő szabály érvényes**; ahol egy szabály sem illik a napra, a levonás 0 perc.
Az értékek szabadon szerkeszthetők, az app nem ellenőrzi őket jogszabály szerint.

**Mi történik a bejegyzésekkel?**
- Minden bejegyzés eltárolja a rá érvényes levonást (`breakMinutes`). Új bejegyzésnél
  (kézi, automatikus, generált) ez a bejegyzés dátuma szerinti szabályból töltődik ki;
  a kézi űrlapon felülírható, és élőben kiírja a ledolgozott időt.
- **Ledolgozott idő = (vége − kezdés) − levonás.** A levonás utólagos átírása
  (bejegyzésen vagy tömegesen) azonnal újraszámol mindent: a listát, az összesítőket,
  a nyomtatást és az exportot.
- A szabályok mentésekor választható, hogy a **meglévő bejegyzések** levonása is frissüljön
  az új szabályok szerint (alapból igen). A *kézzel módosított* levonású bejegyzéseket
  (sorban `*` jelöli) ez nem írja felül; a mentés után „Visszavonás” is elérhető.
- **Szűrés:** a „Levonás” legördülő csak a ténylegesen előforduló értékeket kínálja.
- **Tömeges szerkesztés:** a levonás egyedi értékre állítható, vagy a felhasználó
  szabályai szerint újraszámoltatható (ez a `*` jelölést is törli).

**Véletlen generátor:** a megadott min./max. munkaidő a **valós, levonás utáni** idő.
A generátor napról napra az érvényes szabály szerinti szünetet adja a záró időponthoz
(pl. 8:00 kezdés, 8 óra valós munka, 20 perc levonás → 16:20 vége; 11-e után 30 perc → 16:30).
A heti/havi célóraszám is a valós munkaidőre vonatkozik, és a meglévő bejegyzések valós
órái számítanak az alapba. A generátor ablaka kiírja a kiválasztott felhasználó szabályait.
A CSV-export a bruttó időt, a levonást és a ledolgozott időt külön oszlopban adja.

## Dátum- és időformátum

Az app mindenhol a magyar sorrendet követi: **év.hónap.nap.** (pl. `2026.09.29.`),
pontokkal elválasztva - szándékosan nem kettősponttal, mert a kettőspont magyarul
hagyományosan az időt jelöli (és Windows-fájlnévben egyébként sem használható, ami
a biztonsági mentés/CSV-export fájlneveit érintené). Az idő mindig 24 órás. Ahol az
app hetekben gondolkodik (a véletlen generátor heti célkitűzése), a hét **hétfővel**
kezdődik.

A natív böngésző-dátum- és időválasztók megjelenése a böngésző/OS nyelvi
beállítását követi, és ezt egy weboldal nem tudja felülírni - ezért az app
**saját, beépített dátum- és időmezőket** használ:

- **Dátummező**: szabadon begépelhető (csak a számjegyeket kell írni, a pontokat a
  mező magától beszúrja: `20160315` → `2016.03.15.`; a `/` jel is elfogadott
  elválasztó), VAGY a mező melletti naptár-ikonnal választható. A naptár hétfővel
  kezdődik, a hétvégék és magyar munkaszüneti napok halvány pirossal vannak
  jelölve. **Gyors lapozás:** a naptár fejlécére (hónap + év) kattintva hónap-,
  még egyszer kattintva évválasztó rács nyílik (12 évenként lapozható), így pl.
  10 évvel korábbra 3-4 kattintással el lehet jutni. Nem létező dátumot (pl.
  2026.02.30.) a mező piros jelöléssel elutasít.
- **Időmező**: két külön számjegyes szegmens (óra 0–23, perc 0–59) FIX
  kettősponttal, mindig 24 órás. Gépelhető (két számjegy után magától a percre
  ugrik; pl. egyetlen `9` beírása is `09`-et ad), és a ▲/▼ gombokkal (vagy a
  fel/le nyilakkal) körbeforgatható (23 után 0, 59 után 0). Telefonon számbillentyűzet
  jelenik meg, a kettőspontot soha nem kell begépelni.

**Nyomtatás**: a nyomtatási nézet külön, tömör táblázat - egy bejegyzés egy sor
(dátum, kezdés, vége, időtartam, forrás, megjegyzés egymás mellett), a fejléc
minden oldalon megismétlődik, alul összesítő sor van. Csak az éppen szűrt
bejegyzéseket tartalmazza.

## Ismert korlátok – olvasd el, mielőtt bevezeted

- **A Windows "bejelentkezés-figyelés" nem valódi háttérszolgáltatás.** Egy böngészős
  alkalmazás nem tud közvetlenül "belehallgatni" a Windows bejelentkezési eseménybe.
  Amit az app csinál: a bejelentkezéskor automatikusan elinduló app **induláskor**
  rögzíti a munkakezdést. A gyakorlatban ugyanazt az eredményt adja, de ha valaki
  nem indítja el az appot bejelentkezéskor (pl. törölte a parancsikont), nem lesz
  automatikus bejegyzés.
- **A "munka befejezése" mindig kézi.** Nincs megbízható módja annak, hogy egy
  böngészős app észlelje a kijelentkezést/leállítást/gép lezárását. A felület emiatt
  jól láthatóan jelzi, ha egy bejegyzés nyitva maradt, hogy utólag könnyen javítható
  legyen.
- **A jogosultságkezelés alkalmazás-szintű, nem szerver-szintű.** Mivel nincs saját
  backend, az "admin mindent szerkeszthet, felhasználó csak a sajátját" szabályt maga
  az alkalmazás logikája kényszeríti ki. Aki technikailag hozzáfér a nyers OneDrive-
  fájlhoz (mert megosztottad vele szerkesztési joggal), azt közvetlenül is
  szerkesztheti a OneDrive-on keresztül. Megbízható, kis csapatnak ez tökéletes
  megoldás, de nem helyettesíti egy vállalati backend biztonsági garanciáit.
- **iOS-en korlátozottabb a működés**, mint Androidon/Windowson (pl. nincs igazi
  háttér-szinkron, a Safari szigorúbban kezeli a helyi tárolást). Ahogy jelezted is,
  ez lesz a legkésőbb csiszolt platform.
- **A OneDrive-fájl egyetlen közös JSON.** Kis-közepes csapatra (néhány fő - néhány
  tucat fő, néhány év bejegyzései) ez bőven elég gyors és egyszerű. Nagyon nagy
  csapatnál (több száz fő, napi sok száz egyidejű írás) egy valódi adatbázis-alapú
  backend jobban skálázódna.
- **A munkaszüneti nap-lista a hivatalos, 11 napos magyar ünnepnaplistát tartalmazza**
  (évről évre automatikusan kiszámolva, a Húsvéthoz kötött mozgó ünnepekkel együtt -
  nem kell évente frissíteni). Amit szándékosan NEM tartalmaz: az évente egyedi
  kormányrendelettel meghatározott "ledolgozós szombat" / "kapott pihenőnap"
  áthelyezéseket, mert azok nem számolhatók ki előre, algoritmikusan.
- **Ezt a sandbox-környezetet nem lehetett éles Windows/Android eszközön tesztelni.**
  A kódot alapos automatikus teszteléssel (egységtesztek + böngésző-szimuláció)
  ellenőriztem, de az első éles beüzemeléskor apróbb hibák előfordulhatnak.

---

## Hibaelhárítás

**"A OneDrive-szinkron még nincs beállítva" / helyi mód, pedig kitöltöttem a config.js-t**
→ Ellenőrizd, hogy a fájl valóban elmentődött és újra közzétett-e (GitHub Pages esetén
ez percekbe telhet). Nézd meg a böngésző fejlesztői konzolját (F12 → Console) hibáért.

**"Nincs jogosultságod a megosztott mappához"**
→ A OneDrive-megosztás nem szerkesztési (csak megtekintési) jogú, vagy nem azzal az
e-mail címmel osztottad meg, amivel a felhasználó bejelentkezik.

**"A bejelentkezés lejárt" gyakran megjelenik**
→ Ellenőrizd, hogy a 2. lépésben megadott Redirect URI **pontosan** egyezik-e az app
tényleges címével (a `/index.html` nélküli, "mappa" formában, záró `/`-per).

**A Microsoft bejelentkezés felugró ablaka nem jelenik meg**
→ A böngésző letiltotta a felugró ablakot. Engedélyezd az oldalnak, vagy az app
automatikusan átvált átirányításos bejelentkezésre.

**Az automatikus Windows-indítás nem hoz létre bejegyzést**
→ Ellenőrizd, hogy a parancsikon célja valóban tartalmazza-e a `?autostart=1`
paramétert (jobb klikk a parancsikonon → Tulajdonságok → Cél mező), és hogy volt-e
már aznap nyitott bejegyzésed (ha igen, ez szándékos - lásd `autoCheckin.js`).

**Két eszköz "versenyzett", és egy módosítás mintha eltűnt volna**
→ Ritka, egyidejű írás esetén fordulhat elő. Mivel minden eszköz megőrzi a saját
helyi másolatát is, a következő szinkron-kör (max. `autoSyncIntervalMinutes` perc,
vagy kézi "Szinkronizálj most") magától helyreállítja.

**Sérültnek tűnő adatfájl**
→ Az app szándékosan NEM ír felül egy olyan OneDrive-fájlt, amit nem tud értelmezni
(hibaüzenet: "sérültnek tűnik"). Nyisd meg a OneDrive-on a fájl **Verzióelőzmények**
funkcióját, és állíts vissza egy korábbi, jó verziót.

---

## Fájlszerkezet

```
jelenleti-iv-kezelo/
├── README.md                    ez a fájl
├── index.html                   app-váz
├── manifest.json                PWA manifest
├── service-worker.js            offline gyorsítótárazás
├── config.js                    ← ide kerülnek a saját beállításaid
├── css/styles.css                teljes stíluslap
├── js/
│   ├── app.js                    fő vezérlő (állapot, útválasztás, műveletek)
│   ├── db.js                     IndexedDB réteg (helyi, offline tárolás)
│   ├── models.js                 adatmodellek (Felhasználó, Bejegyzés) és segédek
│   ├── auth.js                   Microsoft bejelentkezés (MSAL.js)
│   ├── sync.js                   OneDrive szinkronizáció (Microsoft Graph API)
│   ├── randomGenerator.js        véletlen időpont-generátor
│   ├── autoCheckin.js            automatikus bejegyzés-észlelés
│   ├── views.js                  a teljes felhasználói felület
│   └── vendor/msal-browser.min.js  Microsoft Authentication Library (MIT licenc)
├── icons/                        alkalmazásikonok
└── windows-setup/
    └── setup-autostart.ps1       Windows automatikus indítás (önálló szkript)
```

**Adatmodell** (a OneDrive-on tárolt `jelenleti-adatok.json` belseje):

```json
{
  "schemaVersion": 1,
  "users": [
    { "id": "...", "name": "Kovács János", "email": "janos@example.com",
      "role": "admin", "active": true,
      "breakRules": [ { "id": "...", "from": "2024-02-01", "to": "2024-02-10", "minutes": 20 },
                      { "id": "...", "from": "2024-02-11", "to": "", "minutes": 30 } ],
      "createdAt": "...", "updatedAt": "...", "deleted": false }
  ],
  "entries": [
    { "id": "...", "userId": "...", "date": "2026-09-29", "startTime": "08:14",
      "endTime": "16:47", "breakMinutes": 30, "breakManual": false, "source": "auto-login", "deviceId": "...", "deviceName": "Windows gép",
      "note": "", "createdAt": "...", "updatedAt": "...", "deleted": false }
  ],
  "updatedAt": "..."
}
```

---

## Jövőbeli bővítési ötletek

Ezekre most nem volt szükség/kapacitás, de jó jelöltek egy következő körre - szólj
bátran, ha bármelyiket szeretnéd, hogy megépítsem:

- **Finomabb Windows-integráció**: külön natív segédprogram (pl. egy apró Python/C#
  háttérfolyamat), ami a Feladatütemező "Munkaállomás zárolása/feloldása" eseményeit
  is felismeri, nem csak a bejelentkezést.
- **E-mail/push értesítés**, ha valaki elfelejt kijelentkezni, vagy ha egy hónap
  óraszáma jelentősen eltér a szokásostól.
- **Havi összesítő/riport nézet**, exportálható PDF-ként (bérszámfejtéshez).
- **Szabadság/betegszabadság kezelése** külön bejegyzés-típusként.
- **Finomabb jogosultsági szintek** (pl. "csapatvezető", aki csak a saját csapatát látja).
