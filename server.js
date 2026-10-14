const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const CATALOG_PATH = path.join(__dirname, "videos.json");
const PAGE_PATH = path.join(__dirname, "index.html");

function sendJson(response, statusCode, body) {
	response.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(JSON.stringify(body));
}

function readCatalog() {
	const contents = fs.readFileSync(CATALOG_PATH, "utf8");
	const catalog = JSON.parse(contents);

	if (!catalog || !Array.isArray(catalog.videos)) {
		throw new Error('videos.json must contain a "videos" array.');
	}

	for (let index = 0; index < catalog.videos.length; index += 1) {
		const video = catalog.videos[index];
		if (
			!video ||
			typeof video.videoId !== "string" ||
			video.videoId.length === 0 ||
			video.videoId.length > 128 ||
			typeof video.title !== "string" ||
			video.title.length === 0 ||
			video.title.length > 200 ||
			(video.thumbnailUrl !== undefined &&
				(typeof video.thumbnailUrl !== "string" || video.thumbnailUrl.length > 512))
		) {
			throw new Error(`Video entry ${index + 1} has an invalid schema.`);
		}
	}

	return catalog;
}

const server = http.createServer((request, response) => {
	const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

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
		try {
			sendJson(response, 200, readCatalog());
		} catch (error) {
			console.error("[Hexium Catalog] Could not read videos.json:", error);
			sendJson(response, 500, { error: "Video catalog is unavailable." });
		}
		return;
	}

	if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
		fs.readFile(PAGE_PATH, (error, page) => {
			if (error) {
				console.error("[Hexium Catalog] Could not read index.html:", error);
				sendJson(response, 500, { error: "Catalog status page is unavailable." });
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
