const board = document.querySelector("#taskBoard");
const feedback = document.querySelector("#taskFeedback");
const statuses = [
  { key: "pending", label: "待处理", empty: "从纪要加入的待办会出现在这里。" },
  { key: "doing", label: "进行中", empty: "开始处理后，将待办状态改成进行中。" },
  { key: "done", label: "已完成", empty: "做完的事项会留在这里，方便下次开会查看。" },
];
let tasks = [];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function makeTask(task) {
  const card = element("article", "task-item");
  card.dataset.taskId = task.id;
  card.append(element("h3", "task-title", task.content));
  if (task.topic) card.append(element("p", "task-topic", task.topic));

  const fields = element("dl", "task-fields");
  for (const [label, value] of [["负责人", task.responsible], ["截止", task.deadline]]) {
    const pair = element("div");
    pair.append(element("dt", "", label), element("dd", "", value));
    fields.append(pair);
  }
  card.append(fields);

  const origin = element("a", "task-source", task.meeting + " · 查看纪要");
  origin.href = "/#session/" + encodeURIComponent(task.sessionId) + "/minute/" + encodeURIComponent(task.minuteId);
  card.append(origin);

  const actions = element("div", "task-actions");
  const select = element("select", "task-status-select");
  select.setAttribute("aria-label", "修改待办状态：" + task.content);
  for (const status of statuses) {
    const option = element("option", "", status.label);
    option.value = status.key;
    option.selected = task.status === status.key;
    select.append(option);
  }
  const remove = element("button", "task-remove", "移出看板");
  remove.type = "button";
  card.append(actions);
  actions.append(select, remove);
  return card;
}

function render(focusTaskId) {
  board.replaceChildren();
  for (const status of statuses) {
    const entries = tasks.filter((task) => task.status === status.key);
    const column = element("section", "task-column");
    column.dataset.status = status.key;
    const labelId = "task-column-" + status.key;
    column.setAttribute("aria-labelledby", labelId);
    const heading = element("h2", "task-column-heading", status.label);
    heading.id = labelId;
    const count = element("span", "task-count", String(entries.length));
    count.setAttribute("aria-label", entries.length + " 条");
    heading.append(count);
    column.append(heading);
    if (!entries.length) column.append(element("p", "task-empty", status.empty));
    for (const entry of entries) column.append(makeTask(entry));
    board.append(column);
  }
  board.hidden = false;
  board.setAttribute("aria-busy", "false");
  if (focusTaskId) {
    const card = [...board.querySelectorAll(".task-item")].find((node) => node.dataset.taskId === focusTaskId);
    card?.querySelector("select").focus({ preventScroll: true });
  }
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作失败，请刷新后重试。");
  return data;
}

board.addEventListener("change", async (event) => {
  const select = event.target.closest(".task-status-select");
  if (!select) return;
  const id = select.closest(".task-item").dataset.taskId;
  const original = tasks.find((task) => task.id === id);
  if (!original) return;
  select.disabled = true;
  try {
    const { task } = await request("/api/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: select.value }),
    });
    tasks = tasks.map((entry) => entry.id === id ? task : entry);
    render(id);
    feedback.textContent = "已更新待办状态。";
  } catch (error) {
    select.disabled = false;
    select.value = original.status;
    feedback.textContent = error.message;
  }
});

board.addEventListener("click", async (event) => {
  const remove = event.target.closest(".task-remove");
  if (!remove) return;
  const id = remove.closest(".task-item").dataset.taskId;
  if (!window.confirm("从看板移出这条待办？纪要仍可在录音库查看。")) return;
  remove.disabled = true;
  try {
    await request("/api/tasks?id=" + encodeURIComponent(id), { method: "DELETE" });
    tasks = tasks.filter((task) => task.id !== id);
    render();
    feedback.textContent = "已移出看板。";
  } catch (error) {
    remove.disabled = false;
    feedback.textContent = error.message;
  }
});

request("/api/tasks").then((payload) => {
  tasks = payload.tasks;
  render();
  feedback.textContent = "";
}).catch((error) => {
  board.setAttribute("aria-busy", "false");
  feedback.textContent = error.message;
});
