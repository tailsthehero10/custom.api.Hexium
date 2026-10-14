# Hexium YouTube

The Render site searches YouTube and embeds selected videos on the website.
The Roblox game uses the same API to show searchable video titles and YouTube
links in its UI. Roblox cannot play YouTube streams inside a game UI.

## Configure YouTube API access

YouTube search requires a Google API key:

1. Create a project in Google Cloud Console and enable **YouTube Data API v3**.
2. Create an API key for that project. Restrict the key to the YouTube Data API.
3. In Render, open the `hexium-video-catalog` service's **Environment** settings
   and add `YOUTUBE_API_KEY` with the key as its value.
4. Save the setting and redeploy/restart the service.

Never put the API key in source files or commit it to GitHub. The server uses
the key privately when calling Google; it is not sent to the site or game.
Without the key, `/videos` returns a configuration error rather than a fake
video list.

## Use the website

Open the Render service URL. The page loads recent embeddable videos by default.
Use the search box to find videos, then select a result to play it in the
Hexium-hosted watch page. Watch links use `/watch?v=VIDEO_ID`, so they can be
copied, shared, opened directly, and revisited with browser Back/Forward.
Channel and public playlist details also have shareable `/channel?id=...` and
`/playlist?id=...` routes. These pages use YouTube's official privacy-enhanced
embed for playback; the actual YouTube video stream is not copied or hosted by
Hexium. Search results are cached for five minutes.

API examples:

```text
GET /videos
GET /videos?query=roblox
GET /videos?order=viewCount
GET /videos?query=roblox&order=relevance
GET /videos?feed=shorts
GET /videos?feed=live
GET /videos?query=gaming&feed=shorts
GET /videos?videoId=YouTubeVideoId
GET /videos?duration=long&published=month&categoryId=20
GET /videos?feed=channel&channelId=UCxxxxxxxxxxxxxxxxxxxxxx
GET /search?type=channel&query=Roblox
GET /search?type=playlist&query=Roblox
GET /channels?channelId=UCxxxxxxxxxxxxxxxxxxxxxx
GET /playlists?channelId=UCxxxxxxxxxxxxxxxxxxxxxx
GET /playlists?playlistId=PLxxxxxxxxxxxxxxxx
GET /playlistItems?playlistId=PLxxxxxxxxxxxxxxxx
GET /comments?videoId=YouTubeVideoId
GET /health
```

The website search selector searches public videos, channels, or playlists.
Channel result pages include channel details, recent uploads, and public
playlists. Public playlist pages show their videos. Feed, search, channel
playlist, and playlist-item responses include `nextPageToken`; send it back as
`pageToken` to continue browsing.

The `/videos` feed supports `videos` (default), `shorts`, `live`, and `channel`.
Shorts search adds a `#shorts` hint and filters for videos up to three minutes long.
The YouTube Data API does not expose a Shorts label or video orientation, so
this is a best-effort Shorts-style feed rather than an exact copy of YouTube's
Shorts classification. Video details include duration and view counts.

Home and Popular use YouTube's regional `mostPopular` chart (`US` by default;
set `YOUTUBE_REGION_CODE` to another two-letter region code). Search, channel
pages, upload-date filters, duration filters, and category filters use YouTube
search. Set Shorts and Live as feed types. Public comments are read-only and
may be unavailable when a video's owner has disabled comments.

The website includes Home, Shorts, Live, Trending, Gaming/Music/Technology,
Latest and Popular views, search filters, public channel and playlist search
and detail pages, public comments, a watch page with an up-next list, and local
Watch later, History, Liked videos, Subscriptions, and Playlists stored in the
visitor's browser. These local library features do not sync with a YouTube
account. This app exposes public, read-only Data API browsing; private
resources and account actions such as subscribing, liking, commenting, and
editing playlists require OAuth and are not available through an API key alone.

The Roblox video browser opens full-screen when the LocalScript starts, fetches
the live catalog through the server, and refreshes it every five minutes while
open. It has Videos, Shorts, Live, Latest, Popular and search controls. Results
show video metadata and copyable links. Roblox cannot render an arbitrary
website, external YouTube thumbnails, or the YouTube player inside a ScreenGui;
thumbnail placeholders are shown unless a thumbnail is separately uploaded as
a Roblox asset.

The default video and live feeds return up to 12 results. Shorts searches up to
50 candidates before filtering by duration, so its response can contain up to
50 results. Each result has this shape:

```json
{
  "videos": [
    {
      "videoId": "YouTubeVideoId",
      "title": "Video title",
      "channelTitle": "Channel",
      "publishedAt": "2026-01-01T00:00:00Z",
      "thumbnailUrl": "https://i.ytimg.com/vi/YouTubeVideoId/hqdefault.jpg",
      "watchUrl": "https://www.youtube.com/watch?v=YouTubeVideoId",
      "shortUrl": "https://www.youtube.com/shorts/YouTubeVideoId",
      "duration": "PT2M10S",
      "durationSeconds": 130,
      "isShort": true,
      "isLive": false,
      "viewCount": "12345",
      "likeCount": "321"
    }
  ]
}
```

## Connect Roblox Studio 2021

Put `VideoCatalogServer.server.luau` in `ServerScriptService` and
`YouTubeBrowser.luau` in `StarterGui` as a `LocalScript`. The server script
requests the deployed `/videos` endpoint over HTTPS. It passes the search
phrase and selected feed (`shorts` or `live`) through a `RemoteFunction`; API
keys stay on the server. Enable **Game Settings > Security > Allow HTTP
Requests**. The browser opens full-screen on join; close it with **X**, then
use **Open Video Browser** to reopen it. Search and feed selections query the
API, and the current feed refreshes every five minutes while the browser is
open.

The in-game UI displays dynamic metadata and selectable watch links; it cannot
embed the website, stream YouTube playback, load external thumbnail URLs into
an `ImageLabel`, or force-open external browser windows. A result exposes its
URL for the player to copy and open outside the game. If the feed reports an
HTTP error, confirm HTTP requests are enabled and that the Render service has
`YOUTUBE_API_KEY` configured.

For optional Roblox-hosted in-game videos or thumbnails, configure
`ROBLOX_VIDEO_ASSET_MAP` or `ROBLOX_THUMBNAIL_ASSET_MAP` as JSON objects
mapping YouTube video IDs to approved Roblox asset ID strings. For example:

```text
ROBLOX_THUMBNAIL_ASSET_MAP={"dQw4w9WgXcQ":"9876543210"}
ROBLOX_VIDEO_ASSET_MAP={"dQw4w9WgXcQ":"1234567890"}
```

The corresponding image/video assets must already be uploaded, approved, and
usable by the Roblox experience. The YouTube image URLs returned by the Data
API cannot be assigned directly to Roblox `ImageLabel`s.

## Run locally

Requires Node.js 16 or later. From this folder:

```text
npm start
```

Set `YOUTUBE_API_KEY` in the environment before starting. The site is then
available at `http://localhost:3000`.
