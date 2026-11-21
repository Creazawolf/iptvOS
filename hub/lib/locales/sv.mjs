// Swedish – the same keys as en.mjs.
export default {
  errors: {
    server: 'Serverfel',
    unknownPath: 'Okänd väg: {path}',
    notFound: 'Hittades inte',
    imgOnly: 'Bara /api/img här',
    tooLarge: 'För stor förfrågan',
    badJson: 'Ogiltig JSON',
    badAdminToken: 'Fel eller saknad admin-token',
    badToken: 'Fel eller saknad token',
    badKind: 'kind måste vara live, vod eller series',
    missingCategory: 'category saknas',
    missingId: 'id saknas',
    missingIds: 'ids saknas',
    mediaFavoriteInput: 'kind (vod|series) och id krävs',
    progressInput: 'id och kind (vod|episode) krävs',
    channelNotFound: 'Kanalen finns inte',
    noCatchup: 'Kanalen har ingen catch-up',
    catchupNeedsXtream: 'Catch-up kräver en Xtream-spellista',
    startEndRequired: 'start och end krävs (ms)',
    notStarted: 'Programmet har inte börjat',
    tooOldForCatchup: 'Programmet är för gammalt för catch-up',
    movieNotFound: 'Filmen finns inte',
    seriesNotFound: 'Serien finns inte',
    playlistNotFound: 'Spellistan finns inte',
    wallpapersOff: 'Bakgrunder är inte påslagna',
    aerialOff: 'Flygfilmer via hubben är inte påslagna',
    streamOff: 'Strömproxyn är inte påslagen',
    notBackup: 'Det här är ingen säkerhetskopia från G3 Hub',
    badAddress: 'Ogiltig adress',
    httpOnly: 'Bara http/https',
    notPlaylistAddress: 'Adressen hör inte till någon spellista',
    notAerialAddress: 'Adressen hör inte till flygfilmerna',
    videoFilesOnly: 'Bara filmfiler',
    tooManyVideos: 'För många filmer hämtas samtidigt',
    videoRedirect: 'Filmservern svarade med en omdirigering',
    videoServerSilent: 'filmservern svarar inte',
    videoFetch: 'Kunde inte hämta filmen: {error}',
    badRedirect: 'Ogiltig omdirigering',
    tooManyRedirects: 'För många omdirigeringar',
    providerSilent: 'Leverantören svarar inte',
    providerPaused: 'Leverantören ({host}) spärrade hubben tillfälligt (HTTP {code}) – nytt försök kl. {time}',
    http: 'HTTP {status} från {host}',
    notJson: 'Ogiltigt svar (inte JSON): {snippet}',
    empty: 'tomt',
    imgPublicOnly: 'u måste vara en publik http(s)-adress',
    imgFailed: 'Bilden gick inte att hämta: {reason}',
    imgTooLarge: 'för stor',
    notImage: 'inte en bild'
  },
  providers: {
    serverAndUserRequired: 'Server och användarnamn krävs',
    loginDenied: 'Inloggningen nekades – kontrollera användarnamn och lösenord',
    moviesFailed: 'Filmer: {error}',
    seriesFailed: 'Serier: {error}',
    m3uMissing: 'M3U-adress saknas',
    notM3u: 'Det här ser inte ut som en M3U-lista',
    firstPart: '{n}+ (första delen)'
  },
  catalog: {
    unnamed: 'Utan namn',
    misc: 'Övrigt',
    uncategorised: 'Okategoriserat',
    m3uName: 'M3U-lista',
    step: {
      waiting: 'väntar',
      loggingIn: 'loggar in',
      live: 'hämtar kanaler',
      vod: 'hämtar filmer',
      series: 'hämtar serier'
    }
  },
  media: {
    extras: 'Extramaterial',
    season: 'Säsong {n}',
    episode: 'Avsnitt {n}',
    episodeLine: 'S{season} · A{episode} – {title}'
  },
  wallpapers: {
    noItems: 'inga poster',
    photoBy: 'Foto: {name}',
    sets: {
      space: { title: 'Rymden', detail: 'De mest uppskattade bilderna från Webb, Hubble och ESO' },
      earth: { title: 'Jorden från ovan', detail: 'Satellitbilder från Google Earth View' },
      nature: { title: 'Natur och landskap', detail: 'Utvalda landskapsbilder från Wikimedia Commons' },
      featured: { title: 'Utvalda bilder', detail: 'Blandat från Wikimedia Commons: djur, byggnader, konst' },
      bing: { title: 'Dagens bild', detail: 'Bings dagliga bild – samlingen växer för varje dag' },
      photos: { title: 'Fotografier', detail: 'Bilderna från Chromecasts bakgrundsläge' }
    }
  }
};
