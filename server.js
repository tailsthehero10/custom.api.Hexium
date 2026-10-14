const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const PAGE_PATH = path.join(__dirname, "index.html");
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const catalogCache = new Map();

function sendJson(response, statusCode, body) {
	response.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(JSON.stringify(body));
}

function requestYouTubeJson(apiUrl) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const request = https.get(apiUrl, (upstreamResponse) => {
			let responseBody = "";
			upstreamResponse.setEncoding("utf8");

			upstreamResponse.on("data", (chunk) => {
				responseBody += chunk;
				if (!settled && responseBody.length > 1024 * 1024) {
					settled = true;
					request.destroy(new Error("YouTube API response exceeded 1 MB."));
					reject(new Error("YouTube API response exceeded 1 MB."));
				}
			});

			upstreamResponse.on("end", () => {
				if (settled) return;
				if (upstreamResponse.statusCode !== 200) {
					let reason = `HTTP ${upstreamResponse.statusCode}`;
					try {
						const payload = JSON.parse(responseBody);
						if (payload.error && payload.error.message) reason = payload.error.message;
					} catch (error) {
						console.error("[Hexium Catalog] YouTube API returned invalid error JSON:", error);
					}
					settled = true;
					reject(new Error(reason));
					return;
				}

				try {
					settled = true;
					resolve(JSON.parse(responseBody));
				} catch (error) {
					settled = true;
					reject(new Error("YouTube API returned invalid JSON."));
				}
			});
		});

		request.setTimeout(12000, () => request.destroy(new Error("YouTube API request timed out.")));
		request.on("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
	});
}

function durationInSeconds(value) {
	const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value || "");
	if (!match) return 0;
	return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

async function fetchYouTubeVideos(query, order, feed) {
	if (!YOUTUBE_API_KEY) {
		return {
			statusCode: 503,
			body: { error: "YouTube search is not configured. Set YOUTUBE_API_KEY in the Render environment." },
		};
	}

	const cacheKey = `${feed}|${order}|${query.toLowerCase()}`;
	const cached = catalogCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return { statusCode: 200, body: cached.body };
	}
	if (cached) {
		catalogCache.delete(cacheKey);
	}

	try {
		const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
		searchUrl.searchParams.set("part", "snippet");
		searchUrl.searchParams.set("type", "video");
		searchUrl.searchParams.set("maxResults", feed === "shorts" ? "50" : "12");
		searchUrl.searchParams.set("order", order);
		searchUrl.searchParams.set("videoEmbeddable", "true");
		searchUrl.searchParams.set("safeSearch", "moderate");
		searchUrl.searchParams.set("key", YOUTUBE_API_KEY);
		if (feed === "shorts") searchUrl.searchParams.set("videoDuration", "short");
		if (feed === "live") searchUrl.searchParams.set("eventType", "live");
		const searchQuery = feed === "shorts"
			? `${query}${query ? " " : ""}#shorts`
			: query;
		if (searchQuery) searchUrl.searchParams.set("q", searchQuery);

		const searchResult = await requestYouTubeJson(searchUrl);
		if (!Array.isArray(searchResult.items)) {
			throw new Error("YouTube returned an unexpected video list.");
		}

		const searchItems = searchResult.items.filter((item) =>
			item &&
			item.id &&
			typeof item.id.videoId === "string" &&
			item.snippet &&
			typeof item.snippet.title === "string");
		let detailsById = new Map();
		if (searchItems.length > 0) {
			const detailsUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
			detailsUrl.searchParams.set("part", "contentDetails,statistics,liveStreamingDetails");
			detailsUrl.searchParams.set("id", searchItems.map((item) => item.id.videoId).join(","));
			detailsUrl.searchParams.set("key", YOUTUBE_API_KEY);
			const detailsResult = await requestYouTubeJson(detailsUrl);
			if (!Array.isArray(detailsResult.items)) {
				throw new Error("YouTube returned unexpected video details.");
			}
			detailsById = new Map(detailsResult.items.map((item) => [item.id, item]));
		}

		const videos = searchItems
			.map((item) => {
				const videoId = item.id.videoId;
				const details = detailsById.get(videoId) || {};
				const thumbnails = item.snippet.thumbnails || {};
				const thumbnail = thumbnails.maxres || thumbnails.high || thumbnails.medium || thumbnails.default;
				const duration = details.contentDetails && details.contentDetails.duration || "";
				const durationSeconds = durationInSeconds(duration);
				const isLive = feed === "live"
					|| Boolean(details.liveStreamingDetails
						&& details.liveStreamingDetails.actualStartTime
						&& !details.liveStreamingDetails.actualEndTime);
				return {
					videoId,
					title: item.snippet.title,
					channelTitle: item.snippet.channelTitle || "",
					publishedAt: item.snippet.publishedAt || "",
					thumbnailUrl: thumbnail ? thumbnail.url : "",
					watchUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
					shortUrl: `https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`,
					duration,
					durationSeconds,
					isShort: !isLive && durationSeconds > 0 && durationSeconds <= 180,
					isLive,
					viewCount: details.statistics && details.statistics.viewCount || "0",
					likeCount: details.statistics && details.statistics.likeCount || "0",
				};
			})
			.filter((video) => feed !== "shorts" || video.isShort);

		const body = { videos };
		catalogCache.delete(cacheKey);
		while (catalogCache.size >= MAX_CACHE_ENTRIES) {
			catalogCache.delete(catalogCache.keys().next().value);
		}
		catalogCache.set(cacheKey, {
			expiresAt: Date.now() + CACHE_TTL_MS,
			body,
		});
		return { statusCode: 200, body };
	} catch (error) {
		console.error("[Hexium Catalog] YouTube search failed:", error.message);
		const errorMessage = error.message.includes("quota")
			? "YouTube search quota exceeded. Try again later."
			: "YouTube search failed. Check the API key, YouTube Data API access, and network connection.";
		return { statusCode: 502, body: { error: errorMessage } };
	}
}

const server = http.createServer((request, response) => {
	let requestUrl;
	try {
		requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
	} catch (error) {
		sendJson(response, 400, { error: "Invalid request URL." });
		return;
	}

	if (request.method !== "GET") {
		response.setHeader("Allow", "GET");
		sendJson(response, 405, { error: "Only GET requests are supported." });
		return;
	}

	if (requestUrl.pathname === "/health") {
		sendJson(response, 200, { status: "ok" });
		return;
	}

	if (requestUrl.pathname === "/videos") {
		const query = (requestUrl.searchParams.get("query") || "").trim();
		const requestedOrder = requestUrl.searchParams.get("order");
		const order = ["date", "viewCount", "relevance"].includes(requestedOrder)
			? requestedOrder
			: query ? "relevance" : "date";
		const requestedFeed = requestUrl.searchParams.get("feed");
		const feed = ["videos", "shorts", "live"].includes(requestedFeed) ? requestedFeed : "videos";
		if (query.length > 100) {
			sendJson(response, 400, { error: "Search query must be 100 characters or fewer." });
			return;
		}

		fetchYouTubeVideos(query, order, feed)
			.then((result) => sendJson(response, result.statusCode, result.body))
			.catch((error) => {
				console.error("[Hexium Catalog] Unexpected video catalog error:", error);
				sendJson(response, 500, { error: "Video catalog is unavailable." });
			});
		return;
	}

	if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
		fs.readFile(PAGE_PATH, (error, page) => {
			if (error) {
				console.error("[Hexium Catalog] Could not read index.html:", error);
				sendJson(response, 500, { error: "Catalog page is unavailable." });
				return;
			}

			response.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			});
			response.end(page);
		});
		return;
	}

	sendJson(response, 404, { error: "Not found." });
});

server.listen(PORT, HOST, () => {
	console.log(`Hexium video catalog listening on http://${HOST}:${PORT}`);
});
