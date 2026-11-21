# G3 Hub

**[English](README.md)** · [Huvud-README](../README.sv.md) · [Arkitektur](../docs/ARCHITECTURE.md)

IPTV-hubben för launchern. Den körs på din Proxmox-server (eller vilken dator som helst med Node 18 eller senare) och sköter det tunga arbetet:

- **Hämtar dina spellistor** (Xtream Codes eller M3U) och sparar en kopia, så att TV:n startar snabbt även när leverantören är seg.
- **Kommer ihåg ditt urval:** vilka kategorier som syns, i vilken ordning, och vilka favoritkanaler du har. Av 22 000 kanaler laddar TV:n bara ner de du valt.
- **Filmer och serier** med omslag och handling, och "Fortsätt titta" som följer med mellan tittningar. Med en TMDB-nyckel fyller hubben i omslag som saknas.
- **Snabb sökning** i allt, även utan å, ä och ö ("skargard" hittar "Skärgård").
- **Webbadmin** som fungerar från mobilen. Ändringar syns direkt på TV:n, och det du stjärnmärker på TV:n syns direkt i webbadmin.
- **Svenska och engelska** på TV:n, i webbadmin och i hubbens egna meddelanden. Se [Språk](#språk).

## Installera på Proxmox

Enklast är att köra det här från datorn, i repots rotmapp. Skriptet skapar en Debian 12-container på Proxmox-värden och installerar hubben i den:

```bash
hub/deploy/update.sh --create root@<proxmox-ip>
```

Som standard får containern 1 kärna, 1 GB RAM, 4 GB disk på `local-lvm` och en adress via DHCP på `vmbr0`, och den startar när värden startar. Det går att ändra med miljövariabler, och du kan ange ett container-id sist (annars tas nästa lediga). Till exempel:

```bash
IP=192.168.1.20/24 GW=192.168.1.1 STORAGE=local-zfs hub/deploy/update.sh --create root@<proxmox-ip> 120
```

| Variabel | Standard | |
| --- | --- | --- |
| `IP` | `dhcp` | Eller en fast adress som `192.168.1.20/24`, som också kräver `GW` |
| `GW` | – | Gateway vid fast adress |
| `STORAGE` | `local-lvm` | Lagring för rotdisken |
| `TEMPLATE_STORAGE` | `local` | Där Debian-mallen laddas ner |
| `BRIDGE` | `vmbr0` | Nätverksbrygga |
| `CORES`, `MEMORY`, `DISK` | `1`, `1024` (MB), `4` (GB) | |
| `PORT` | `8787` | Hubbens port. Bilderna använder nästa port. |
| `CT_HOSTNAME` | `g3hub` | |
| `PASSWORD` | slumpat | Root-lösenord i containern. Ett slumpat skrivs ut på slutet. |
| `SSH_KEY` | – | En fil med publika nycklar **på Proxmox-värden** (t.ex. `/root/.ssh/authorized_keys`) som läggs in för root i containern |

Du kan också kopiera `hub/`-mappen till Proxmox-värden och köra `bash deploy/proxmox-create-lxc.sh [CTID]` där som root.

När skriptet är klart skriver det ut adressen, till exempel `http://192.168.1.20:8787`. Ge gärna containern en fast adress i routern, så att TV:n alltid hittar den.

**Uppdatera senare:**

```bash
hub/deploy/update.sh root@192.168.1.20             # direkt mot containern (SSH till LXC:n)
hub/deploy/update.sh --pve root@<proxmox-ip> 120   # via Proxmox-värden (pct), ingen SSH till containern behövs
```

**En annan Debian- eller Ubuntu-maskin:** kopiera `hub/`-mappen dit och kör `bash deploy/install.sh` som root i den. Skriptet installerar Node.js om det behövs, försöker installera `sharp` och lägger upp systemd-tjänsten `g3hub`. Samma skript uppdaterar. Val: `G3HUB_PORT` (standard `8787`) och `G3HUB_SHARP=0` för att hoppa över `sharp`. Hubben hamnar i `/opt/g3hub` och dess data i `/var/lib/g3hub`, som uppdateringar inte rör. Loggar: `journalctl -u g3hub -f`.

**För hand:** `node hub/server.mjs [--port 8787] [--data <katalog>] [--host <adress>] [--img-port <port>]`, eller miljövariablerna `G3HUB_PORT`, `G3HUB_DATA`, `G3HUB_HOST` och `G3HUB_IMG_PORT`.

## Språk

Hubben kan svenska och engelska. Det finns två inställningar, båda i webbadmin under **Inställningar › Språk**:

- **Språk på den här sidan** är webbadminens eget språk. *Automatiskt* följer webbläsaren. Valet sparas bara i den webbläsaren, så alla kan ha sitt eget.
- **Hubbens språk** gäller hela hubben. Launchern talar om sitt språk för hubben i varje anrop (TV:ns menyspråk, eller det du valt under Inställningar › Språk på TV:n), så TV:n får alltid meddelanden och status på sitt eget språk. Hubbens språk används när ett anrop inte säger något, och styr de här standardvalen:
  - **TMDB-språket** för handlingen, så länge fältet *Språk för TMDB* är tomt: `sv-SE` för svenska, `en-US` för engelska. Fyll i fältet, till exempel `en-GB`, för att välja ett annat;
  - marknaden för Bings **Dagens bild** bland bakgrunderna;
  - svenska bildtexter på **flygfilmerna** (bara när hubben är på svenska);
  - namn som hubben hittar på själv, till exempel "Okategoriserat".

En ny hubb startar på engelska. En hubb som fanns innan inställningen kom till, eller en säkerhetskopia från en sådan, fortsätter på svenska. Du kan byta när du vill. Handling som redan hämtats från TMDB behåller sitt gamla språk i upp till 60 dagar, och listorna för Dagens bild och flygfilmerna byter nästa gång de hämtas.

## Använda webbadmin

1. **Spellistor › Lägg till spellista:** ange server, användarnamn och lösenord för Xtream, eller en M3U-adress. Tryck på *Testa* och sedan *Lägg till*. Hämtningen tar några sekunder till någon minut.
2. **Live-kategorier:** från början visas bara kategorier som ser svenska eller nordiska ut (finns inga, de fem första). Filtrera på t.ex. "sport" eller ett landsprefix ("UK", "SE"), slå på det du vill ha och dra kategorierna i den ordning du vill se dem på TV:n. *Dölj allt* nollställer urvalet.
3. **Kanaler:** sök bland alla kanaler och stjärnmärk dina favoriter. De hamnar överst i TV-guiden och på hemskärmen.
4. **Favoriter:** dra för att ändra ordningen.
5. **Filmer och Serier:** välj vilka kategorier som blir rader i TV-appen.
6. **Inställningar:**
   - **Namn:** visas på TV:n.
   - **Uppdatera listor:** hur ofta listorna hämtas om.
   - **Bildproxy:** om bilderna ska gå via hubben.
   - **Språk:** se [Språk](#språk).
   - **TMDB API-nyckel:** valfri, gratis på [themoviedb.org](https://www.themoviedb.org/settings/api). **Språk för TMDB:** tomt följer hubbens språk.
   - **Admin-token:** ett lösenord för webbadmin.
   - **TV-token:** om TV:n ska behöva en nyckel.
   - **Säkerhetskopia:** *Ladda ner* sparar spellistor (med lösenord), urval, favoriter, inställningar och Fortsätt titta i en fil. *Återställ…* läser in en sådan fil; kanaler och bilder hämtas sedan om. Nuvarande admin- och TV-token behålls.

Har leverantören spärrat hubben tillfälligt (HTTP 403/429) syns det överst på översiktssidan, med tiden då hubben försöker igen.

## Ansluta TV:n

Öppna **Inställningar › IPTV** i launchern på TV:n, välj **Hubb** och ange hubbens adress, till exempel `http://192.168.1.20:8787`. Ange också TV-token om du har satt en. Adressen står på översiktssidan i webbadmin.

Hubben svarar på två portar: **8787** för API och webbadmin, och **8788** för bilder (`/api/img`). TV:n har bara sex samtidiga anslutningar per adress och port, så en långsam bild får inte låta tablån och detaljsidorna vänta. TV:n får bildadressen från hubben (`imgBase` i bootstrap) och behöver inga inställningar. Annan port: `--img-port` eller `G3HUB_IMG_PORT`; `0` lägger allt på huvudporten.

Utan hubb fungerar launcherns direktläge fortfarande, mot en enda Xtream-server.

## Utveckling

```bash
npm run dev          # launchern på :8080 + en hubb med demodata på :8787
npm run hub          # bara hubben (data i build/hub-data)
node hub/test/smoke.mjs   # röktest av alla API-vägar mot demoleverantören (även npm test)
node hub/test/bench.mjs   # svarstider med 22 000 kanaler och 30 000 filmer
```

Demoleverantören finns i `scripts/dev-mocks.mjs` och har cirka 22 000 kanaler i cirka 400 kategorier, 3 000 filmer och 400 serier. API:t beskrivs (på engelska) i [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md#1-the-hubs-api-hub-default-port-8787), och hur språken fungerar i [§7](../docs/ARCHITECTURE.md#7-languages-i18n). Hubbens texter finns i `hub/lib/locales/` (serverns meddelanden) och `hub/web/i18n/` (webbadmin); `npm run i18n:check` kontrollerar att varje nyckel finns på alla språk.

Inga beroenden behövs. Om paketet [`sharp`](https://sharp.pixelplumbing.com) finns installerat skalas bilderna ner i hubben, och installationsskriptet försöker installera det automatiskt.

## Via VPN (WireGuard)

Hubbens egen trafik kan gå via en WireGuard-profil, till exempel från Mullvad: listor, EPG, bilder och TMDB.
En spärr stoppar all utgående trafik som inte går genom tunneln. TV:n och webbadminen på hemnätet når hubben som vanligt.
Kopiera `hub/deploy/wireguard.sh` och din profil till Proxmox-värden och kör som root:

```bash
bash wireguard.sh <CTID> profil.conf [192.168.1.0/24]
```

Det sista argumentet är ditt hemnät, det som TV:n sitter på, som fortfarande når hubben utanför tunneln. Utan det använder skriptet containerns eget nät. Kolla läget med `pct exec <CTID> -- curl -s https://am.i.mullvad.net/connected`. Ångra: `pct exec <CTID> -- systemctl disable --now wg-quick@wg0 g3-killswitch`, och återställ sedan `/etc/resolv.conf` och ta bort `/etc/.pve-ignore.resolv.conf` i containern.

> Live-TV går direkt från leverantören till TV:n, inte genom hubben eller tunneln. Filmer och avsnitt går via hubben bara när launchern ritar undertexterna i en `.mkv`-fil, och Apples flygfilmer gör det alltid.
>
> **Viktigt:** använd aldrig samma WireGuard-profil (samma nyckel) i hubben och i routern samtidigt.
> Mullvads filer för olika servrar (`se-sto-wg-001`, `-002` …) hör till samma enhet och nyckel. Kör du
> redan VPN i routern är det enklast att lägga hubbens IP-adress i routerns VPN-lista i stället.

## Snäll mot leverantören

Xtream-paneler spärrar IP-adresser som skickar för många anrop (svarar 403 på allt). Därför:

- **Takt:** hubben skickar som mest cirka 2,5 anrop per sekund till leverantörens API.
- **Paus:** vid 403 eller 429 (eller 503, 509, 513) pausar den i 15 minuter, och sedan längre (som mest 2 h) om spärren finns kvar.
- **EPG:** hämtas som **en** fil (`xmltv.php`) var 12:e timme. Bara kanalerna i dina synliga kategorier och favoriter sparas, också på disk. Kanal-för-kanal-EPG används bara om `xmltv.php` inte fungerar. Kanaler utanför urvalet som TV:n ändå tittar på (t.ex. via "sök i alla kanaler") tas med i nästa nedladdning; ett nytt urval ger en ny nedladdning tidigast efter 3 timmar.
- **Alla anrop till leverantörens värdar** följer takten och pauserna – även logotyper som ligger på panelens egen server, och direkt efter en omstart. Leverantörens egna API-anrop går före köade bilder. 403 på enstaka bilder räknas först när det händer tre gånger inom två minuter.
- **Över omstarter:** pauser och påbörjade hämtningar sparas i `runtime.json`. Dör hubben mitt i en hämtning väntar den 30 minuter innan nästa försök, i stället för att börja om direkt.
- **Detaljsidor** (filmer och serier) sparas på disk (`cache/info/`): filmer räknas som färska i 7 dagar och serier i 12 timmar. Äldre visas direkt medan en ny version hämtas i bakgrunden, och om leverantören inte svarar behålls den gamla.
- **Bilder:** originalet hämtas en gång; alla storlekar görs av det, i hubben. Adresser som inte svarar vilar i 30 minuter.

## Catch-up och programsök

Kanaler där leverantören sparar sändningar (`tv_archive` i Xtream) får `catchup` och `catchupDays`. För dem sparar hubben även passerade program (högst 7 dagar bakåt), och `/api/live/catchup` ger adressen till ett passerat program, med starttiden i leverantörens tidszon. Tablån på TV:n visar sådana program med ↺, och OK spelar dem. `/api/epg/search` söker i tablån bland dina kanaler.
