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
const cacheOrder = [];

function sendJson(response, statusCode, body) {
	response.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(JSON.stringify(body));
}

function fetchYouTubeVideos(query, order) {
	if (!YOUTUBE_API_KEY) {
		return Promise.resolve({
			statusCode: 503,
			body: { error: "YouTube search is not configured. Set YOUTUBE_API_KEY in the Render environment." },
		});
	}

	const cacheKey = `${order}|${query.toLowerCase()}`;
	const cached = catalogCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return Promise.resolve({ statusCode: 200, body: cached.body });
	}
	if (cached) {
		catalogCache.delete(cacheKey);
		const expiredIndex = cacheOrder.indexOf(cacheKey);
		if (expiredIndex !== -1) {
			cacheOrder.splice(expiredIndex, 1);
		}
	}

	const apiUrl = new URL("https://www.googleapis.com/youtube/v3/search");
	apiUrl.searchParams.set("part", "snippet");
	apiUrl.searchParams.set("type", "video");
	apiUrl.searchParams.set("maxResults", "12");
	apiUrl.searchParams.set("order", order);
	apiUrl.searchParams.set("videoEmbeddable", "true");
	apiUrl.searchParams.set("safeSearch", "moderate");
	apiUrl.searchParams.set("key", YOUTUBE_API_KEY);
	if (query) {
		apiUrl.searchParams.set("q", query);
	}

	return new Promise((resolve) => {
		const request = https.get(apiUrl, (upstreamResponse) => {
			let responseBody = "";
			upstreamResponse.setEncoding("utf8");

			upstreamResponse.on("data", (chunk) => {
				responseBody += chunk;
				if (responseBody.length > 1024 * 1024) {
					request.destroy(new Error("YouTube API response exceeded 1 MB."));
				}
			});

			upstreamResponse.on("end", () => {
				let payload;
				try {
					payload = JSON.parse(responseBody);
				} catch (error) {
					console.error("[Hexium Catalog] YouTube API returned invalid JSON:", error);
					resolve({ statusCode: 502, body: { error: "YouTube returned an invalid response." } });
					return;
				}

				if (upstreamResponse.statusCode !== 200) {
					const reason = payload.error && payload.error.message
						? payload.error.message
						: `HTTP ${upstreamResponse.statusCode}`;
					console.error("[Hexium Catalog] YouTube API request failed:", reason);
					resolve({ statusCode: 502, body: { error: "YouTube search failed. Check the API key and YouTube Data API quota." } });
					return;
				}

				if (!Array.isArray(payload.items)) {
					resolve({ statusCode: 502, body: { error: "YouTube returned an unexpected video list." } });
					return;
				}

				const videos = payload.items
					.filter((item) =>
						item &&
						item.id &&
						typeof item.id.videoId === "string" &&
						item.snippet &&
						typeof item.snippet.title === "string")
					.map((item) => {
						const videoId = item.id.videoId;
						const thumbnails = item.snippet.thumbnails || {};
						const thumbnail = thumbnails.high || thumbnails.medium || thumbnails.default;

						return {
							videoId,
							title: item.snippet.title,
							channelTitle: item.snippet.channelTitle || "",
							publishedAt: item.snippet.publishedAt || "",
							thumbnailUrl: thumbnail ? thumbnail.url : "",
							watchUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
						};
					});

				const result = {
					statusCode: 200,
					body: { videos },
				};

				while (catalogCache.size >= MAX_CACHE_ENTRIES) {
					catalogCache.delete(cacheOrder.shift());
				}
				catalogCache.set(cacheKey, {
					expiresAt: Date.now() + CACHE_TTL_MS,
					body: result.body,
				});
				cacheOrder.push(cacheKey);

				resolve(result);
			});
		});

		request.setTimeout(12000, () => {
			request.destroy(new Error("YouTube API request timed out."));
		});
		request.on("error", (error) => {
			console.error("[Hexium Catalog] Could not reach YouTube API:", error.message);
			resolve({ statusCode: 502, body: { error: "Could not reach YouTube. Try again shortly." } });
		});
	});
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
		if (query.length > 100) {
			sendJson(response, 400, { error: "Search query must be 100 characters or fewer." });
			return;
		}

		fetchYouTubeVideos(query, order)
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
