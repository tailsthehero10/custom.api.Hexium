const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const PAGE_PATH = path.join(__dirname, "index.html");
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const POPULAR_REGION_CODE = /^[A-Z]{2}$/.test(process.env.YOUTUBE_REGION_CODE || "US")
	? process.env.YOUTUBE_REGION_CODE || "US"
	: "US";
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const catalogCache = new Map();
const commentCache = new Map();
const VALID_CATEGORIES = new Set(["1", "2", "10", "15", "17", "20", "22", "23", "24", "25", "26", "27", "28"]);

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

function cacheResult(cache, key, body) {
	cache.delete(key);
	while (cache.size >= MAX_CACHE_ENTRIES) {
		cache.delete(cache.keys().next().value);
	}
	cache.set(key, {
		expiresAt: Date.now() + CACHE_TTL_MS,
		body,
	});
}

async function fetchYouTubeVideos(query, order, feed, filters) {
	if (!YOUTUBE_API_KEY) {
		return {
			statusCode: 503,
			body: { error: "YouTube search is not configured. Set YOUTUBE_API_KEY in the Render environment." },
		};
	}

	const cacheKey = JSON.stringify([feed, order, query.toLowerCase(), filters]);
	const cached = catalogCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return { statusCode: 200, body: cached.body };
	}
	if (cached) {
		catalogCache.delete(cacheKey);
	}

	try {
		const usePopularChart = feed === "videos" && !query && order === "viewCount"
			&& !filters.duration && !filters.publishedAfter && !filters.channelId;
		let searchItems;
		let detailsById = new Map();
		if (usePopularChart) {
			const popularUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
			popularUrl.searchParams.set("part", "snippet,contentDetails,statistics,liveStreamingDetails,status");
			popularUrl.searchParams.set("chart", "mostPopular");
			popularUrl.searchParams.set("regionCode", POPULAR_REGION_CODE);
			popularUrl.searchParams.set("maxResults", "50");
			popularUrl.searchParams.set("key", YOUTUBE_API_KEY);
			if (filters.categoryId) popularUrl.searchParams.set("videoCategoryId", filters.categoryId);

			const popularResult = await requestYouTubeJson(popularUrl);
			if (!Array.isArray(popularResult.items)) {
				throw new Error("YouTube returned an unexpected popular video list.");
			}
			const popularItems = popularResult.items.filter((item) =>
				item &&
				typeof item.id === "string" &&
				item.snippet &&
				typeof item.snippet.title === "string" &&
				item.status &&
				item.status.embeddable === true &&
				item.status.privacyStatus === "public");
			searchItems = popularItems.slice(0, 12).map((item) => ({
				id: { videoId: item.id },
				snippet: item.snippet,
			}));
			detailsById = new Map(popularItems.map((item) => [item.id, item]));
		} else {
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
			if (feed === "channel") searchUrl.searchParams.set("channelId", filters.channelId);
			if (feed !== "shorts" && filters.duration) searchUrl.searchParams.set("videoDuration", filters.duration);
			if (filters.categoryId) searchUrl.searchParams.set("videoCategoryId", filters.categoryId);
			if (filters.publishedAfter) searchUrl.searchParams.set("publishedAfter", filters.publishedAfter);
			const searchQuery = feed === "shorts"
				? `${query}${query ? " " : ""}#shorts`
				: query;
			if (searchQuery) searchUrl.searchParams.set("q", searchQuery);

			const searchResult = await requestYouTubeJson(searchUrl);
			if (!Array.isArray(searchResult.items)) {
				throw new Error("YouTube returned an unexpected video list.");
			}

			searchItems = searchResult.items.filter((item) =>
				item &&
				item.id &&
				typeof item.id.videoId === "string" &&
				item.snippet &&
				typeof item.snippet.title === "string");
		}

		if (searchItems.length > 0 && !usePopularChart) {
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
					channelId: item.snippet.channelId || "",
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
		cacheResult(catalogCache, cacheKey, body);
		return { statusCode: 200, body };
	} catch (error) {
		console.error("[Hexium Catalog] YouTube search failed:", error.message);
		const errorMessage = error.message.includes("quota")
			? "YouTube search quota exceeded. Try again later."
			: "YouTube search failed. Check the API key, YouTube Data API access, and network connection.";
		return { statusCode: 502, body: { error: errorMessage } };
	}
}

async function fetchYouTubeComments(videoId) {
	if (!YOUTUBE_API_KEY) {
		return {
			statusCode: 503,
			body: { error: "Comments are not configured. Set YOUTUBE_API_KEY in the Render environment." },
		};
	}

	const cached = commentCache.get(videoId);
	if (cached && cached.expiresAt > Date.now()) {
		return { statusCode: 200, body: cached.body };
	}
	if (cached) commentCache.delete(videoId);

	try {
		const commentsUrl = new URL("https://www.googleapis.com/youtube/v3/commentThreads");
		commentsUrl.searchParams.set("part", "snippet");
		commentsUrl.searchParams.set("videoId", videoId);
		commentsUrl.searchParams.set("maxResults", "20");
		commentsUrl.searchParams.set("order", "relevance");
		commentsUrl.searchParams.set("textFormat", "plainText");
		commentsUrl.searchParams.set("key", YOUTUBE_API_KEY);
		const result = await requestYouTubeJson(commentsUrl);
		if (!Array.isArray(result.items)) {
			throw new Error("YouTube returned an unexpected comments list.");
		}

		const comments = result.items
			.filter((item) => item && item.snippet && item.snippet.topLevelComment)
			.map((item) => {
				const comment = item.snippet.topLevelComment.snippet || {};
				return {
					author: comment.authorDisplayName || "YouTube user",
					text: comment.textDisplay || "",
					publishedAt: comment.publishedAt || "",
					likeCount: comment.likeCount || 0,
					replyCount: item.snippet.totalReplyCount || 0,
				};
			});
		const body = { comments };
		cacheResult(commentCache, videoId, body);
		return { statusCode: 200, body };
	} catch (error) {
		console.error("[Hexium Catalog] Could not load comments:", error.message);
		return {
			statusCode: 502,
			body: { error: "Comments are unavailable for this video. You can still join the conversation on YouTube." },
		};
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
		const requestedFeed = requestUrl.searchParams.get("feed");
		const feed = ["videos", "shorts", "live", "channel"].includes(requestedFeed) ? requestedFeed : "videos";
		const requestedOrder = requestUrl.searchParams.get("order");
		const order = ["date", "viewCount", "relevance"].includes(requestedOrder)
			? requestedOrder
			: query ? "relevance" : feed === "videos" ? "viewCount" : "date";
		const duration = requestUrl.searchParams.get("duration") || "";
		const categoryId = requestUrl.searchParams.get("categoryId") || "";
		const requestedPublished = requestUrl.searchParams.get("published") || "";
		const channelId = requestUrl.searchParams.get("channelId") || "";
		const publishedIntervals = { day: 1, week: 7, month: 30, year: 365 };
		if (query.length > 100) {
			sendJson(response, 400, { error: "Search query must be 100 characters or fewer." });
			return;
		}
		if (duration && !["short", "medium", "long"].includes(duration)) {
			sendJson(response, 400, { error: "Duration must be short, medium, or long." });
			return;
		}
		if (categoryId && !VALID_CATEGORIES.has(categoryId)) {
			sendJson(response, 400, { error: "Unknown YouTube video category." });
			return;
		}
		if (requestedPublished && !publishedIntervals[requestedPublished]) {
			sendJson(response, 400, { error: "Upload date must be day, week, month, or year." });
			return;
		}
		if (feed === "channel" && !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
			sendJson(response, 400, { error: "A valid YouTube channelId is required for channel videos." });
			return;
		}
		if (feed !== "channel" && channelId) {
			sendJson(response, 400, { error: "channelId is only supported with the channel feed." });
			return;
		}
		let publishedAfter = "";
		if (publishedIntervals[requestedPublished]) {
			const date = new Date();
			date.setUTCHours(0, 0, 0, 0);
			date.setUTCDate(date.getUTCDate() - publishedIntervals[requestedPublished]);
			publishedAfter = date.toISOString();
		}
		const filters = {
			duration: duration && feed === "videos" ? duration : "",
			categoryId,
			publishedAfter,
			channelId,
		};

		fetchYouTubeVideos(query, order, feed, filters)
			.then((result) => sendJson(response, result.statusCode, result.body))
			.catch((error) => {
				console.error("[Hexium Catalog] Unexpected video catalog error:", error);
				sendJson(response, 500, { error: "Video catalog is unavailable." });
			});
		return;
	}

	if (requestUrl.pathname === "/comments") {
		const videoId = requestUrl.searchParams.get("videoId") || "";
		if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
			sendJson(response, 400, { error: "A valid YouTube videoId is required." });
			return;
		}
		fetchYouTubeComments(videoId)
			.then((result) => sendJson(response, result.statusCode, result.body))
			.catch((error) => {
				console.error("[Hexium Catalog] Unexpected comments error:", error);
				sendJson(response, 500, { error: "Comments are unavailable." });
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
