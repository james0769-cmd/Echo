const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.ECHO_WEB_PORT || 8124);
const STATIC_ROOT = __dirname;
const DEMO_ROOT = path.join(PROJECT_ROOT, "results", "demo");
const LIVE_ROOT = path.join(PROJECT_ROOT, "results", "demo-live");
const EDITS_ROOT = path.join(LIVE_ROOT, "edits");
const ASR_CACHE_ROOT = path.join(PROJECT_ROOT, "data", "cache", "asr");
const CLIPS_AUDIO_ROOT = path.join(PROJECT_ROOT, "data", "public", "alimeeting", "clips");
const MINUTES_ROOT = path.join(PROJECT_ROOT, "results", "minutes");
const DEMO_AUDIO = path.join(CLIPS_AUDIO_ROOT, "clip01.wav");
const LIVE_AUDIO = path.join(LIVE_ROOT, "audio.wav");

function resolvePython() {
  const candidates = [
    process.env.ECHO_PYTHON,
    path.join(PROJECT_ROOT, ".venv", "Scripts", "python.exe"),
    path.join(PROJECT_ROOT, "..", ".venv", "Scripts", "python.exe"),
    path.join(PROJECT_ROOT, ".venv", "bin", "python"),
    path.join(PROJECT_ROOT, "..", ".venv", "bin", "python"),
  ].filter(Boolean);
  const fallback = process.platform === "win32" ? "python" : "python3";
  return candidates.find((candidate) => candidate === process.env.ECHO_PYTHON || fs.existsSync(candidate)) || fallback;
}

const PYTHON = resolvePython();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".svg": "image/svg+xml",
};

const SAMPLE_IDS = ["clip01", "clip02", "clip03", "clip04", "clip05"];

function isValidSessionId(id) {
  return id === "live" || /^clip0[1-5]$/.test(String(id || ""));
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function readJsonSafe(file) {
  try {
    return await readJson(file);
  } catch {
    return null;
  }
}

async function findAsrCacheFile(clipId) {
  try {
    const entries = await fsp.readdir(ASR_CACHE_ROOT);
    const match = entries.find((name) => name.startsWith(`${clipId}_`) && name.endsWith(".json"));
    return match ? path.join(ASR_CACHE_ROOT, match) : null;
  } catch {
    return null;
  }
}

function buildSessionTitle(items) {
  const topics = [];
  for (const item of items || []) {
    const topic = String(item.topic || "").trim();
    if (topic && !topics.includes(topic)) {
      topics.push(topic);
      if (topics.length >= 2) break;
    }
  }
  return topics.length ? topics.join(" / ") : "未检出纪要事项";
}

function mergeEdits(asr, minutes, edits) {
  if (!edits) return { asr, minutes, hasEdits: false };
  const mergedAsr = { ...asr };
  if (Array.isArray(edits.transcript) && edits.transcript.length === (asr.sentences || []).length) {
    mergedAsr.sentences = asr.sentences.map((sentence, idx) => {
      const edited = edits.transcript[idx];
      if (!edited) return sentence;
      return {
        ...sentence,
        text: typeof edited.text === "string" ? edited.text : sentence.text,
        corrected: Boolean(edited.corrected),
        original_text: edited.original_text || sentence.original_text,
      };
    });
  } else if (Array.isArray(edits.transcript) && edits.transcript.length) {
    mergedAsr.sentences = edits.transcript;
  }

  const mergedMinutes = { ...minutes };
  if (Array.isArray(edits.minutes)) {
    mergedMinutes.items = edits.minutes;
  }
  return { asr: mergedAsr, minutes: mergedMinutes, hasEdits: true };
}

async function resolveSessionFiles(id) {
  if (!isValidSessionId(id)) return null;

  if (id === "live") {
    const transcriptFile = path.join(LIVE_ROOT, "transcript.json");
    const minutesFile = path.join(LIVE_ROOT, "minutes.json");
    if (!fs.existsSync(transcriptFile) || !fs.existsSync(minutesFile)) return null;
    const meta = (await readJsonSafe(path.join(LIVE_ROOT, "meta.json"))) || {};
    const audioExists = fs.existsSync(LIVE_AUDIO);
    return {
      id: "live",
      kind: "live",
      audioName: meta.audioName || "uploaded.wav",
      audioUrl: audioExists ? "/media/live.wav" : null,
      transcriptFile,
      minutesFile,
    };
  }

  const minutesSample = path.join(MINUTES_ROOT, "segmented_asr", `${id}.json`);
  const minutesDemo = id === "clip01" ? path.join(DEMO_ROOT, "minutes.json") : null;
  const minutesFile = [minutesSample, minutesDemo].find((file) => file && fs.existsSync(file));

  const asrCache = await findAsrCacheFile(id);
  const asrDemo = id === "clip01" ? path.join(DEMO_ROOT, "transcript.json") : null;
  const transcriptFile = [asrCache, asrDemo].find((file) => file && fs.existsSync(file));

  if (!transcriptFile || !minutesFile) return null;

  const audioFile = path.join(CLIPS_AUDIO_ROOT, `${id}.wav`);
  return {
    id,
    kind: "sample",
    audioName: `${id}.wav`,
    audioUrl: fs.existsSync(audioFile) ? `/media/clip/${id}.wav` : null,
    transcriptFile,
    minutesFile,
  };
}

async function loadSession(id) {
  const info = await resolveSessionFiles(id);
  if (!info) return null;

  const [rawAsr, rawMinutes, edits] = await Promise.all([
    readJson(info.transcriptFile),
    readJson(info.minutesFile),
    readJsonSafe(path.join(EDITS_ROOT, `${id}.json`)),
  ]);

  const { asr, minutes, hasEdits } = mergeEdits(rawAsr, rawMinutes, edits);
  const items = minutes.items || [];
  return {
    id: info.id,
    kind: info.kind,
    title: buildSessionTitle(items),
    audioName: info.audioName,
    audioUrl: info.audioUrl,
    hasEdits,
    asr,
    minutes,
  };
}

async function listSessions() {
  const candidates = ["live", ...SAMPLE_IDS];
  const sessions = [];
  for (const id of candidates) {
    const session = await loadSession(id);
    if (!session) continue;
    const items = session.minutes.items || [];
    const sentences = session.asr.sentences || [];
    const topics = [];
    const typeCounts = { 决定: 0, 待办: 0, 待确认: 0 };
    let flaggedCount = 0;

    for (const item of items) {
      const topic = String(item.topic || "").trim();
      if (topic && !topics.includes(topic)) topics.push(topic);
      if (Object.prototype.hasOwnProperty.call(typeCounts, item.type)) {
        typeCounts[item.type] += 1;
      }
      if (Array.isArray(item.flags) && item.flags.length > 0) {
        flaggedCount += 1;
      }
    }

    const previewText = items[0]?.content
      ? String(items[0].content).trim()
      : sentences.slice(0, 2).map((s) => String(s.text || "").trim()).join(" ");

    sessions.push({
      id: session.id,
      kind: session.kind,
      title: session.title,
      audioName: session.audioName,
      audioUrl: session.audioUrl,
      duration: Number(session.asr.duration || 0),
      sentenceCount: sentences.length,
      itemCount: items.length,
      verifiedCount: items.filter((item) => Boolean(item.verified)).length,
      hasEdits: session.hasEdits,
      topics,
      typeCounts,
      flaggedCount,
      previewText,
    });
  }
  return sessions;
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function sendFile(req, res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";
  const total = stat.size;
  const range = req.headers.range;

    if (range && total > 0) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!match) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      res.end();
      return;
    }
    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : total - 1;
    if (match[1] === "" && match[2] !== "") {
      const suffixLen = Number(match[2]);
      start = Math.max(0, total - suffixLen);
      end = total - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      res.end();
      return;
    }
    end = Math.min(end, total - 1);
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on("error", () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    stream.pipe(res);
    return;
  }

  res.writeHead(200, {
    "Accept-Ranges": "bytes",
    "Content-Length": total,
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(404);
    res.end("Not found");
  });
  stream.pipe(res);
}

function readBody(req, maxBytes = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("请求体超过限制（80 MB）"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function runDemo(audioPath, originalName, method) {
  const safeMethod = method === "baseline" ? "baseline" : "segmented";
  await fsp.mkdir(LIVE_ROOT, { recursive: true });
  await fsp.copyFile(audioPath, LIVE_AUDIO);
  await fsp.rm(path.join(EDITS_ROOT, "live.json"), { force: true });
  await fsp.writeFile(
    path.join(LIVE_ROOT, "meta.json"),
    JSON.stringify({ audioName: originalName || "uploaded.wav", method: safeMethod, analyzedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );

  return new Promise((resolve, reject) => {
    const child = spawn(
      PYTHON,
      ["-m", "echotrace.cli", "demo", "--audio", audioPath, "--method", safeMethod, "--out", LIVE_ROOT],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          PYTHONPATH: [path.join(PROJECT_ROOT, "src"), process.env.PYTHONPATH]
            .filter(Boolean)
            .join(path.delimiter),
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `分析进程退出：${code}`));
        return;
      }
      try {
        const session = await loadSession("live");
        if (!session) throw new Error("未生成分析结果");
        resolve(session);
      } catch (error) {
        reject(error);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      sendJson(res, 200, { sessions: await listSessions() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/session") {
      const id = url.searchParams.get("id") || "clip01";
      if (!isValidSessionId(id)) {
        sendJson(res, 400, { error: "无效的会话 ID" });
        return;
      }
      const session = await loadSession(id);
      if (!session) {
        sendJson(res, 404, { error: `未找到会话 ${id}` });
        return;
      }
      sendJson(res, 200, session);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/demo") {
      const [session, sessions] = await Promise.all([loadSession("clip01"), listSessions()]);
      if (!session) {
        sendJson(res, 404, { error: "默认演示数据不存在" });
        return;
      }
      sendJson(res, 200, { ...session, sessions });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const body = await readBody(req);
      if (!body.length) {
        sendJson(res, 400, { error: "没有收到音频文件" });
        return;
      }
      const rawName = url.searchParams.get("name") || "meeting.wav";
      let safeName = path.basename(rawName).replace(/[^\w.\-\u4e00-\u9fa5]/g, "_") || "meeting.wav";
      if (!safeName.toLowerCase().endsWith(".wav")) {
        safeName = `${safeName}.wav`;
      }
      const method = url.searchParams.get("method") || "segmented";
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "echotrace-demo-"));
      const audioPath = path.join(tempDir, safeName);
      await fsp.writeFile(audioPath, body);
      try {
        const session = await runDemo(audioPath, safeName, method);
        sendJson(res, 200, session);
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/session/save") {
      const body = await readBody(req, 10 * 1024 * 1024);
      const data = JSON.parse(body.toString("utf8") || "{}");
      const id = data.id;
      if (!isValidSessionId(id)) {
        sendJson(res, 400, { error: "无效的会话 ID" });
        return;
      }
      const existing = await resolveSessionFiles(id);
      if (!existing) {
        sendJson(res, 404, { error: `会话 ${id} 不存在` });
        return;
      }
      await fsp.mkdir(EDITS_ROOT, { recursive: true });
      await fsp.writeFile(
        path.join(EDITS_ROOT, `${id}.json`),
        JSON.stringify({
          id,
          updatedAt: new Date().toISOString(),
          minutes: Array.isArray(data.minutes) ? data.minutes : [],
          transcript: Array.isArray(data.transcript) ? data.transcript : [],
        }, null, 2),
        "utf8",
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/session/reset") {
      const id = url.searchParams.get("id") || "clip01";
      if (!isValidSessionId(id)) {
        sendJson(res, 400, { error: "无效的会话 ID" });
        return;
      }
      await fsp.rm(path.join(EDITS_ROOT, `${id}.json`), { force: true });
      const session = await loadSession(id);
      if (!session) {
        sendJson(res, 404, { error: `会话 ${id} 不存在` });
        return;
      }
      sendJson(res, 200, session);
      return;
    }

    const isRead = req.method === "GET" || req.method === "HEAD";

    if (isRead && url.pathname === "/media/demo.wav") {
      sendFile(req, res, DEMO_AUDIO);
      return;
    }

    if (isRead && url.pathname === "/media/live.wav") {
      sendFile(req, res, LIVE_AUDIO);
      return;
    }

    if (isRead && url.pathname.startsWith("/media/clip/")) {
      const filename = url.pathname.slice("/media/clip/".length);
      if (!/^clip0[1-5]\.wav$/.test(filename)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      sendFile(req, res, path.join(CLIPS_AUDIO_ROOT, filename));
      return;
    }

    if (isRead && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (isRead) {
      const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const filePath = path.resolve(STATIC_ROOT, relative);
      if (!filePath.startsWith(STATIC_ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      sendFile(req, res, filePath);
      return;
    }

    res.writeHead(405);
    res.end("Method not allowed");
  } catch (error) {
    sendJson(res, 500, { error: error.message || "服务器错误" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`EchoTrace web demo: http://127.0.0.1:${PORT}`);
});
