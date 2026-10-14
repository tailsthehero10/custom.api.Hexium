# Hexium Video Catalog site

This small Node.js site serves `videos.json` at `GET /videos` and a status page at `/`.
It has no external package dependencies.

## Deploy on Render

1. Push this repository to GitHub.
2. In Render, choose **New > Blueprint** and select that repository.
3. Render reads `render.yaml` from the repository root and deploys this project
   as a Node.js web service named `hexium-video-catalog`.
4. After deployment, open the service URL. The status page should load, and
   `/health` should return `{"status":"ok"}`. The catalog endpoint is
   `https://<your-render-service>.onrender.com/videos`.
5. Put that full HTTPS `/videos` URL in `API_URL` in
   `VideoCatalogServer.server.luau`, publish the Roblox experience, and enable
   **Game Settings > Security > Allow HTTP Requests**.

The free Render service may spin down while idle, so the first request after
idle can take longer.

## Run locally

From the repository root, run:

```text
npm start
```

Then open `http://localhost:3000` in a browser. The JSON endpoint is
`http://localhost:3000/videos`.

Add catalog entries by editing `videos.json`:

```json
{
  "videos": [
    {
      "videoId": "your-video-id",
      "title": "Your video title",
      "thumbnailUrl": "rbxassetid://123456789"
    }
  ]
}
```

`thumbnailUrl` is optional. If used in the Roblox UI, it must be a Roblox image
asset ID in `rbxassetid://...` format. `videoId` is displayed as metadata only;
it does not stream or play the video.

## Connect Roblox

Deploy this Node.js app to a public HTTPS host, then set `API_URL` in
`VideoCatalogServer.server.luau` to the deployed `/videos` address, for example:

```lua
local API_URL = "https://your-deployed-host.example/videos"
```

Enable **Game Settings > Security > Allow HTTP Requests** in Roblox Studio. The
Roblox server script calls this endpoint; the LocalScript receives the catalog
through `ReplicatedStorage.VideoCatalogRequest`.

The endpoint returns the schema expected by the Roblox server script:
`{"videos":[{"videoId":"...","title":"...","thumbnailUrl":"..."}]}`.
The catalog API only transports metadata. Roblox cannot embed YouTube or stream
an external site's videos in a `VideoFrame`; playback requires Roblox video
assets.
