// English – the reference dictionary for the hub's own texts. Every key must exist here.
// Placeholders: {name}. Plural forms: { one, other } picked by vars.n.
export default {
  errors: {
    server: 'Server error',
    unknownPath: 'Unknown path: {path}',
    notFound: 'Not found',
    imgOnly: 'Only /api/img here',
    tooLarge: 'Request too large',
    badJson: 'Invalid JSON',
    badAdminToken: 'Wrong or missing admin token',
    badToken: 'Wrong or missing token',
    badKind: 'kind must be live, vod or series',
    missingCategory: 'category is missing',
    missingId: 'id is missing',
    missingIds: 'ids is missing',
    mediaFavoriteInput: 'kind (vod|series) and id are required',
    progressInput: 'id and kind (vod|episode) are required',
    channelNotFound: 'The channel doesn\'t exist',
    noCatchup: 'The channel has no catch-up',
    catchupNeedsXtream: 'Catch-up needs an Xtream playlist',
    startEndRequired: 'start and end are required (ms)',
    notStarted: 'The programme hasn\'t started yet',
    tooOldForCatchup: 'The programme is too old for catch-up',
    movieNotFound: 'The movie doesn\'t exist',
    seriesNotFound: 'The series doesn\'t exist',
    playlistNotFound: 'The playlist doesn\'t exist',
    wallpapersOff: 'Wallpapers are not turned on',
    aerialOff: 'Aerial videos via the hub are not turned on',
    streamOff: 'The stream proxy is not turned on',
    notBackup: 'This is not a G3 Hub backup',
    badAddress: 'Invalid address',
    httpOnly: 'Only http/https',
    notPlaylistAddress: 'The address doesn\'t belong to any playlist',
    notAerialAddress: 'The address isn\'t one of the aerial videos',
    videoFilesOnly: 'Video files only',
    tooManyVideos: 'Too many videos are being fetched at once',
    videoRedirect: 'The video server replied with a redirect',
    videoServerSilent: 'the video server isn\'t responding',
    videoFetch: 'Couldn\'t fetch the video: {error}',
    badRedirect: 'Invalid redirect',
    tooManyRedirects: 'Too many redirects',
    providerSilent: 'The provider isn\'t responding',
    providerPaused: 'The provider ({host}) has blocked the hub for now (HTTP {code}) – next try at {time}',
    http: 'HTTP {status} from {host}',
    notJson: 'Invalid response (not JSON): {snippet}',
    empty: 'empty',
    imgPublicOnly: 'u must be a public http(s) address',
    imgFailed: 'Couldn\'t fetch the image: {reason}',
    imgTooLarge: 'too large',
    notImage: 'not an image'
  },
  providers: {
    serverAndUserRequired: 'Server and username are required',
    loginDenied: 'Login refused – check the username and password',
    moviesFailed: 'Movies: {error}',
    seriesFailed: 'Series: {error}',
    m3uMissing: 'M3U address is missing',
    notM3u: 'This doesn\'t look like an M3U list',
    firstPart: '{n}+ (first part)'
  },
  catalog: {
    unnamed: 'Unnamed',
    misc: 'Other',
    uncategorised: 'Uncategorised',
    m3uName: 'M3U list',
    step: {
      waiting: 'waiting',
      loggingIn: 'logging in',
      live: 'fetching channels',
      vod: 'fetching movies',
      series: 'fetching series'
    }
  },
  media: {
    extras: 'Extras',
    season: 'Season {n}',
    episode: 'Episode {n}',
    episodeLine: 'S{season} · E{episode} – {title}'
  },
  wallpapers: {
    noItems: 'no items',
    photoBy: 'Photo: {name}',
    sets: {
      space: { title: 'Space', detail: 'The most popular images from Webb, Hubble and ESO' },
      earth: { title: 'Earth from above', detail: 'Satellite images from Google Earth View' },
      nature: { title: 'Nature and landscapes', detail: 'Featured landscapes from Wikimedia Commons' },
      featured: { title: 'Featured pictures', detail: 'A mix from Wikimedia Commons: animals, buildings, art' },
      bing: { title: 'Picture of the day', detail: 'Bing\'s daily image – the collection grows every day' },
      photos: { title: 'Photographs', detail: 'The pictures from Chromecast\'s ambient mode' }
    }
  }
};
