export async function requestJson(url, options) {
  const res = await fetch(url, options);
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

export function fetchDemo() {
  return requestJson("/api/demo");
}

export function fetchSessions() {
  return requestJson("/api/sessions");
}

export function fetchSession(id) {
  return requestJson(`/api/session?id=${encodeURIComponent(id)}`);
}

export function saveSessionEdits({ id, minutes, transcript }) {
  return requestJson("/api/session/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, minutes, transcript }),
  });
}

export function resetSessionEdits(id) {
  return requestJson(`/api/session/reset?id=${encodeURIComponent(id)}`, {
    method: "POST",
  });
}

export async function downloadSessionWord(id) {
  const res = await fetch(`/api/session/word?id=${encodeURIComponent(id)}`);
  if (!res.ok) {
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    throw new Error(data.error || "Word 导出失败");
  }
  return res.blob();
}

export function analyzeAudio(file, method = "segmented") {
  const name = encodeURIComponent(file?.name || "meeting.wav");
  const safeMethod = encodeURIComponent(method || "segmented");
  return requestJson(`/api/analyze?name=${name}&method=${safeMethod}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
}

export function fetchTasks() {
  return requestJson("/api/tasks");
}

export function addTask({ sessionId, minuteId }) {
  return requestJson("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, minuteId }),
  });
}

export function updateTaskStatus({ id, status }) {
  return requestJson("/api/tasks", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, status }),
  });
}

export function removeTask(id) {
  return requestJson(`/api/tasks?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
