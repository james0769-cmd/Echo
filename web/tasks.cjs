const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const STATUSES = new Set(["pending", "doing", "done"]);

function fault(status, message) {
  return Object.assign(new Error(message), { status });
}

function normalizeField(value) {
  const text = String(value ?? "").trim();
  return !text || /^(?:未定|未指明|未指定|未知|[—-])/.test(text) ? "未知" : text;
}

function createTaskStore(filename) {
  function read() {
    try {
      return JSON.parse(fs.readFileSync(filename, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  function save(tasks) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const pending = filename + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(pending, JSON.stringify(tasks, null, 2), "utf8");
      fs.renameSync(pending, filename);
    } finally {
      fs.rmSync(pending, { force: true });
    }
  }

  function add(session, minuteId) {
    const source = session.minutes.items.find((item) => item.id === minuteId && item.type === "待办");
    if (!source) throw fault(404, "这条待办已经找不到，请刷新纪要后再试。");
    const tasks = read();
    const existing = tasks.find((task) => task.sessionId === session.id && task.minuteId === minuteId);
    if (existing) return { task: existing, created: false };
    const task = {
      id: randomUUID(),
      sessionId: session.id,
      minuteId: source.id,
      meeting: session.audioName,
      topic: source.topic || "",
      content: source.content,
      responsible: normalizeField(source.responsible),
      deadline: normalizeField(source.deadline),
      status: "pending",
    };
    tasks.push(task);
    save(tasks);
    return { task, created: true };
  }

  function update(id, status) {
    if (!STATUSES.has(status)) throw fault(400, "待办状态无效。");
    const tasks = read();
    const task = tasks.find((entry) => entry.id === id);
    if (!task) throw fault(404, "找不到这条待办。");
    task.status = status;
    save(tasks);
    return task;
  }

  function remove(id) {
    const tasks = read();
    const remaining = tasks.filter((task) => task.id !== id);
    if (remaining.length === tasks.length) throw fault(404, "找不到这条待办。");
    save(remaining);
  }

  return { read, add, update, remove };
}

module.exports = { createTaskStore, fault };
