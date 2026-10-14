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
let ROBLOX_VIDEO_ASSET_MAP = Object.create(null);
if (process.env.ROBLOX_VIDEO_ASSET_MAP) {
	try {
		const configuredMap = JSON.parse(process.env.ROBLOX_VIDEO_ASSET_MAP);
		if (!configuredMap || typeof configuredMap !== "object" || Array.isArray(configuredMap)) {
			throw new Error("Expected a JSON object keyed by YouTube video ID.");
		}
		for (const [videoId, assetId] of Object.entries(configuredMap)) {
			if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !/^\d{1,20}$/.test(String(assetId))) {
				throw new Error(`Invalid YouTube video ID or Roblox video asset ID for "${videoId}".`);
			}
			ROBLOX_VIDEO_ASSET_MAP[videoId] = String(assetId);
		}
	} catch (error) {
		throw new Error(`Invalid ROBLOX_VIDEO_ASSET_MAP: ${error.message}`);
	}
}
let ROBLOX_THUMBNAIL_ASSET_MAP = Object.create(null);
if (process.env.ROBLOX_THUMBNAIL_ASSET_MAP) {
	try {
		const configuredMap = JSON.parse(process.env.ROBLOX_THUMBNAIL_ASSET_MAP);
		if (!configuredMap || typeof configuredMap !== "object" || Array.isArray(configuredMap)) {
			throw new Error("Expected a JSON object keyed by YouTube video ID.");
		}
		for (const [videoId, assetId] of Object.entries(configuredMap)) {
			if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !/^\d{1,20}$/.test(String(assetId))) {
				throw new Error(`Invalid YouTube video ID or Roblox thumbnail asset ID for "${videoId}".`);
			}
			ROBLOX_THUMBNAIL_ASSET_MAP[videoId] = String(assetId);
		}
	} catch (error) {
		throw new Error(`Invalid ROBLOX_THUMBNAIL_ASSET_MAP: ${error.message}`);
	}
}
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

async function fetchYouTubeVideos(query, order, feed, filters, pageToken) {
	if (!YOUTUBE_API_KEY) {
		return {
			statusCode: 503,
			body: { error: "YouTube search is not configured. Set YOUTUBE_API_KEY in the Render environment." },
		};
	}

	const cacheKey = JSON.stringify([feed, order, query.toLowerCase(), filters, pageToken]);
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
		let nextPageToken = "";
		if (usePopularChart) {
			const popularUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
			popularUrl.searchParams.set("part", "snippet,contentDetails,statistics,liveStreamingDetails,status");
			popularUrl.searchParams.set("chart", "mostPopular");
			popularUrl.searchParams.set("regionCode", POPULAR_REGION_CODE);
			popularUrl.searchParams.set("maxResults", "12");
			if (pageToken) popularUrl.searchParams.set("pageToken", pageToken);
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
			searchItems = popularItems.map((item) => ({
				id: { videoId: item.id },
				snippet: item.snippet,
			}));
			nextPageToken = popularResult.nextPageToken || "";
			detailsById = new Map(popularItems.map((item) => [item.id, item]));
		} else if (feed === "channel") {
			const channelResult = await fetchYouTubeChannels(filters.channelId);
			if (channelResult.statusCode !== 200) {
				throw new Error(channelResult.body.error || "YouTube channel could not be loaded.");
			}
			const uploadsPlaylistId = channelResult.body.channel.uploadsPlaylistId;
			if (uploadsPlaylistId) {
				const uploadsUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
				uploadsUrl.searchParams.set("part", "snippet,contentDetails");
				uploadsUrl.searchParams.set("playlistId", uploadsPlaylistId);
				uploadsUrl.searchParams.set("maxResults", "12");
				if (pageToken) uploadsUrl.searchParams.set("pageToken", pageToken);
				uploadsUrl.searchParams.set("key", YOUTUBE_API_KEY);
				const uploadsResult = await requestYouTubeJson(uploadsUrl);
				if (!Array.isArray(uploadsResult.items)) {
					throw new Error("YouTube returned an unexpected channel uploads list.");
				}
				searchItems = uploadsResult.items.map((item) => {
					const snippet = item.snippet || {};
					const videoId = item.contentDetails && item.contentDetails.videoId
						|| snippet.resourceId && snippet.resourceId.videoId || "";
					return {
						id: { videoId },
						snippet: {
							...snippet,
							channelId: snippet.videoOwnerChannelId || filters.channelId,
							channelTitle: snippet.videoOwnerChannelTitle || channelResult.body.channel.title,
						},
					};
				}).filter((item) => /^[A-Za-z0-9_-]{11}$/.test(item.id.videoId));
				nextPageToken = uploadsResult.nextPageToken || "";
			} else {
				searchItems = [];
			}
		} else {
			const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
			searchUrl.searchParams.set("part", "snippet");
			searchUrl.searchParams.set("type", "video");
			searchUrl.searchParams.set("maxResults", feed === "shorts" ? "50" : "12");
			searchUrl.searchParams.set("order", order);
			searchUrl.searchParams.set("videoEmbeddable", "true");
			searchUrl.searchParams.set("safeSearch", "moderate");
			searchUrl.searchParams.set("key", YOUTUBE_API_KEY);
			if (pageToken) searchUrl.searchParams.set("pageToken", pageToken);
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
			nextPageToken = searchResult.nextPageToken || "";
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
				const video = {
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
				const robloxVideoId = ROBLOX_VIDEO_ASSET_MAP[videoId];
				if (robloxVideoId) video.robloxVideoId = robloxVideoId;
				const robloxThumbnailId = ROBLOX_THUMBNAIL_ASSET_MAP[videoId];
				if (robloxThumbnailId) video.robloxThumbnailId = robloxThumbnailId;
				return video;
			})
			.filter((video) => feed !== "shorts" || video.isShort);

		const body = { videos, nextPageToken };
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

async function fetchYouTubeSearch(query, type, pageToken) {
	if (!YOUTUBE_API_KEY) {
		return {
			statusCode: 503,
			body: { error: "YouTube search is not configured. Set YOUTUBE_API_KEY in the Render environment." },
		};
	}
	if (!query) return { statusCode: 400, body: { error: "A search query is required." } };

	const cacheKey = JSON.stringify(["search", type, query.toLowerCase(), pageToken]);
	const cached = catalogCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) return { statusCode: 200, body: cached.body };
	if (cached) catalogCache.delete(cacheKey);

	try {
		const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
		searchUrl.searchParams.set("part", "snippet");
		searchUrl.searchParams.set("type", type);
		searchUrl.searchParams.set("q", query);
		searchUrl.searchParams.set("maxResults", "12");
		searchUrl.searchParams.set("safeSearch", "moderate");
		searchUrl.searchParams.set("key", YOUTUBE_API_KEY);
		if (pageToken) searchUrl.searchParams.set("pageToken", pageToken);
		const result = await requestYouTubeJson(searchUrl);
		if (!Array.isArray(result.items)) throw new Error("YouTube returned an unexpected search list.");

		const results = result.items.map((item) => {
			const id = item.id || {};
			const snippet = item.snippet || {};
			const thumbnails = snippet.thumbnails || {};
			const thumbnail = thumbnails.high || thumbnails.medium || thumbnails.default;
			const resourceId = type === "channel" ? id.channelId : id.playlistId;
			return {
				id: resourceId || "",
				title: snippet.title || "",
				description: snippet.description || "",
				channelId: snippet.channelId || "",
				channelTitle: snippet.channelTitle || "",
				publishedAt: snippet.publishedAt || "",
				thumbnailUrl: thumbnail ? thumbnail.url : "",
			};
		}).filter((item) => item.id && item.title);
		const body = { results, nextPageToken: result.nextPageToken || "" };
		cacheResult(catalogCache, cacheKey, body);
		return { statusCode: 200, body };
	} catch (error) {
		console.error(`[Hexium Catalog] YouTube ${type} search failed:`, error.message);
		return {
			statusCode: 502,
			body: { error: `YouTube ${type} search failed. Check API access and try again.` },
		};
	}
}

async function fetchYouTubeChannels(channelId) {
	if (!YOUTUBE_API_KEY) return { statusCode: 503, body: { error: "YouTube API is not configured." } };
	try {
		const channelsUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
		channelsUrl.searchParams.set("part", "snippet,statistics,contentDetails,brandingSettings");
		channelsUrl.searchParams.set("id", channelId);
		channelsUrl.searchParams.set("key", YOUTUBE_API_KEY);
		const result = await requestYouTubeJson(channelsUrl);
		const item = Array.isArray(result.items) ? result.items[0] : null;
		if (!item) return { statusCode: 404, body: { error: "YouTube channel was not found or is not public." } };
		const snippet = item.snippet || {};
		const statistics = item.statistics || {};
		const thumbnails = snippet.thumbnails || {};
		const thumbnail = thumbnails.high || thumbnails.medium || thumbnails.default;
		return {
			statusCode: 200,
			body: {
				channel: {
					channelId: item.id,
					title: snippet.title || "",
					description: snippet.description || "",
					customUrl: snippet.customUrl || "",
					publishedAt: snippet.publishedAt || "",
					thumbnailUrl: thumbnail ? thumbnail.url : "",
					subscriberCount: statistics.hiddenSubscriberCount ? null : statistics.subscriberCount || "0",
					viewCount: statistics.viewCount || "0",
					videoCount: statistics.videoCount || "0",
					uploadsPlaylistId: item.contentDetails && item.contentDetails.relatedPlaylists
						? item.contentDetails.relatedPlaylists.uploads || "" : "",
				},
			},
		};
	} catch (error) {
		console.error("[Hexium Catalog] YouTube channel lookup failed:", error.message);
		return { statusCode: 502, body: { error: "YouTube channel details could not be loaded." } };
	}
}

async function fetchYouTubePlaylists(channelId, playlistId, pageToken) {
	if (!YOUTUBE_API_KEY) return { statusCode: 503, body: { error: "YouTube API is not configured." } };
	try {
		const playlistsUrl = new URL("https://www.googleapis.com/youtube/v3/playlists");
		playlistsUrl.searchParams.set("part", "snippet,contentDetails,status");
		playlistsUrl.searchParams.set("maxResults", "12");
		playlistsUrl.searchParams.set("key", YOUTUBE_API_KEY);
		if (playlistId) playlistsUrl.searchParams.set("id", playlistId);
		else playlistsUrl.searchParams.set("channelId", channelId);
		if (pageToken) playlistsUrl.searchParams.set("pageToken", pageToken);
		const result = await requestYouTubeJson(playlistsUrl);
		if (!Array.isArray(result.items)) throw new Error("YouTube returned an unexpected playlist list.");
		const playlists = result.items.map((item) => {
			const snippet = item.snippet || {};
			const thumbnails = snippet.thumbnails || {};
			const thumbnail = thumbnails.high || thumbnails.medium || thumbnails.default;
			return {
				playlistId: item.id,
				title: snippet.title || "",
				description: snippet.description || "",
				channelId: snippet.channelId || "",
				channelTitle: snippet.channelTitle || "",
				publishedAt: snippet.publishedAt || "",
				thumbnailUrl: thumbnail ? thumbnail.url : "",
				itemCount: item.contentDetails && item.contentDetails.itemCount || 0,
				privacyStatus: item.status && item.status.privacyStatus || "public",
			};
		}).filter((playlist) => playlist.playlistId && playlist.title);
		return {
			statusCode: 200,
			body: playlistId
				? { playlist: playlists[0] || null }
				: { playlists, nextPageToken: result.nextPageToken || "" },
		};
	} catch (error) {
		console.error("[Hexium Catalog] YouTube playlists lookup failed:", error.message);
		return { statusCode: 502, body: { error: "YouTube playlists could not be loaded." } };
	}
}

async function fetchYouTubePlaylistItems(playlistId, pageToken) {
	if (!YOUTUBE_API_KEY) return { statusCode: 503, body: { error: "YouTube API is not configured." } };
	try {
		const itemsUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
		itemsUrl.searchParams.set("part", "snippet,contentDetails");
		itemsUrl.searchParams.set("playlistId", playlistId);
		itemsUrl.searchParams.set("maxResults", "12");
		itemsUrl.searchParams.set("key", YOUTUBE_API_KEY);
		if (pageToken) itemsUrl.searchParams.set("pageToken", pageToken);
		const result = await requestYouTubeJson(itemsUrl);
		if (!Array.isArray(result.items)) throw new Error("YouTube returned an unexpected playlist item list.");
		const items = result.items.map((item) => {
			const snippet = item.snippet || {};
			const thumbnails = snippet.thumbnails || {};
			const thumbnail = thumbnails.high || thumbnails.medium || thumbnails.default;
			return {
				videoId: item.contentDetails && item.contentDetails.videoId
					|| snippet.resourceId && snippet.resourceId.videoId || "",
				title: snippet.title || "",
				channelId: snippet.videoOwnerChannelId || "",
				channelTitle: snippet.videoOwnerChannelTitle || "",
				publishedAt: snippet.publishedAt || "",
				thumbnailUrl: thumbnail ? thumbnail.url : "",
			};
		}).filter((item) => /^[A-Za-z0-9_-]{11}$/.test(item.videoId) && item.title !== "Private video" && item.title !== "Deleted video");
		return { statusCode: 200, body: { videos: items, nextPageToken: result.nextPageToken || "" } };
	} catch (error) {
		console.error("[Hexium Catalog] YouTube playlist items lookup failed:", error.message);
		return { statusCode: 502, body: { error: "YouTube playlist videos could not be loaded." } };
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
		const pageToken = requestUrl.searchParams.get("pageToken") || "";
		const publishedIntervals = { day: 1, week: 7, month: 30, year: 365 };
		if (query.length > 100) {
			sendJson(response, 400, { error: "Search query must be 100 characters or fewer." });
			return;
		}
		if (pageToken.length > 512) {
			sendJson(response, 400, { error: "pageToken must be 512 characters or fewer." });
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

		fetchYouTubeVideos(query, order, feed, filters, pageToken)
			.then((result) => sendJson(response, result.statusCode, result.body))
			.catch((error) => {
				console.error("[Hexium Catalog] Unexpected video catalog error:", error);
				sendJson(response, 500, { error: "Video catalog is unavailable." });
			});
		return;
	}

	if (requestUrl.pathname === "/search") {
		const query = (requestUrl.searchParams.get("query") || "").trim();
		const type = requestUrl.searchParams.get("type") || "video";
		const pageToken = requestUrl.searchParams.get("pageToken") || "";
		if (!["channel", "playlist"].includes(type)) {
			sendJson(response, 400, { error: "Search type must be channel or playlist." });
			return;
		}
		if (query.length > 100) {
			sendJson(response, 400, { error: "Search query must be 100 characters or fewer." });
			return;
		}
		if (pageToken.length > 512) {
			sendJson(response, 400, { error: "pageToken must be 512 characters or fewer." });
			return;
		}
		fetchYouTubeSearch(query, type, pageToken)
			.then((result) => sendJson(response, result.statusCode, result.body))
			.catch((error) => {
				console.error("[Hexium Catalog] Unexpected search error:", error);
				sendJson(response, 500, { error: "YouTube search is unavailable." });
			});
		return;
	}

	if (requestUrl.pathname === "/channels") {
		const channelId = requestUrl.searchParams.get("channelId") || "";
		if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
			sendJson(response, 400, { error: "A valid public YouTube channelId is required." });
			return;
		}
		fetchYouTubeChannels(channelId)
			.then((result) => sendJson(response, result.statusCode, result.body))
			.catch((error) => {
				console.error("[Hexium Catalog] Unexpected channel error:", error);
				sendJson(response, 500, { error: "YouTube channel is unavailable." });
			});
		return;
	}

	if (requestUrl.pathname === "/playlists") {
		const channelId = requestUrl.searchParams.get("channelId") || "";
		const playlistId = requestUrl.searchParams.get("playlistId") || "";
		const pageToken = requestUrl.searchParams.get("pageToken") || "";
		if (Boolean(channelId) === Boolean(playlistId)) {
			sendJson(response, 400, { error: "Provide exactly one of channelId or playlistId." });
			return;
		}
		if (channelId && !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
			sendJson(response, 400, { error: "A valid public YouTube channelId is required." });
			return;
		}
		if (playlistId && !/^[A-Za-z0-9_-]{10,64}$/.test(playlistId)) {
			sendJson(response, 400, { error: "A valid public YouTube playlistId is required." });
			return;
		}
		if (pageToken.length > 512) {
			sendJson(response, 400, { error: "pageToken must be 512 characters or fewer." });
			return;
		}
		fetchYouTubePlaylists(channelId, playlistId, pageToken)
			.then((result) => sendJson(response, result.statusCode, result.body))
			.catch((error) => {
				console.error("[Hexium Catalog] Unexpected playlist error:", error);
				sendJson(response, 500, { error: "YouTube playlists are unavailable." });
			});
		return;
	}

	if (requestUrl.pathname === "/playlistItems") {
		const playlistId = requestUrl.searchParams.get("playlistId") || "";
		const pageToken = requestUrl.searchParams.get("pageToken") || "";
		if (!/^[A-Za-z0-9_-]{10,64}$/.test(playlistId)) {
			sendJson(response, 400, { error: "A valid public YouTube playlistId is required." });
			return;
		}
		if (pageToken.length > 512) {
			sendJson(response, 400, { error: "pageToken must be 512 characters or fewer." });
			return;
		}
		fetchYouTubePlaylistItems(playlistId, pageToken)
			.then((result) => sendJson(response, result.statusCode, result.body))
			.catch((error) => {
				console.error("[Hexium Catalog] Unexpected playlist items error:", error);
				sendJson(response, 500, { error: "YouTube playlist videos are unavailable." });
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
