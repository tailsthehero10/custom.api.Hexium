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
embedded YouTube player. Search results are cached for five minutes.

API examples:

```text
GET /videos
GET /videos?query=roblox
GET /health
```

The response contains up to 12 results in this shape:

```json
{
  "videos": [
    {
      "videoId": "YouTubeVideoId",
      "title": "Video title",
      "channelTitle": "Channel",
      "publishedAt": "2026-01-01T00:00:00Z",
      "thumbnailUrl": "https://i.ytimg.com/vi/YouTubeVideoId/hqdefault.jpg",
      "watchUrl": "https://www.youtube.com/watch?v=YouTubeVideoId"
    }
  ]
}
```

## Connect Roblox Studio 2021

The server script in `ServerScriptService` requests `/videos` over HTTPS. It
passes a search phrase using the `query` parameter when the player searches.
The LocalScript in `StarterGui` displays those same YouTube results. Enable
**Game Settings > Security > Allow HTTP Requests**.

The in-game UI displays metadata and watch links; it cannot embed the website
or stream YouTube playback. Players can watch videos using the Render site.

## Run locally

Requires Node.js 16 or later. From this folder:

```text
npm start
```

Set `YOUTUBE_API_KEY` in the environment before starting. The site is then
available at `http://localhost:3000`.
