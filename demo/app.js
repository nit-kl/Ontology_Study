const numberFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
const SVG = "http://www.w3.org/2000/svg";
const STEPS = [
  { key: "data", index: "01", label: "データの可視化" },
  { key: "issues", index: "02", label: "課題" },
  { key: "orders", index: "03", label: "解決指令" },
];
const SERIES = [
  { key: "売場", color: "#8d3d22" },
  { key: "バックルーム", color: "#17382f" },
  { key: "倉庫", color: "#3f6f8f" },
  { key: "外気", color: "#a56b22" },
];
const STATUS_COLOR = {
  ok: "#2a7a4b",
  warn: "#c48a1a",
  bad: "#b4332a",
};
let briefing = null;
let step = 0;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === "className") node.className = value;
    else if (key === "hidden") node.hidden = value;
    else node.setAttribute(key, value);
  });
  children.forEach((child) => {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG, tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  children.forEach((child) => node.append(child));
  return node;
}

function text(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return numberFormat.format(value);
  return String(value);
}

function last(values) {
  const present = (values || []).filter((value) => value !== null && value !== undefined);
  return present.length ? present[present.length - 1] : null;
}

function renderTable(target, columns, rows, classify) {
  target.replaceChildren();
  if (!rows || rows.length === 0) {
    target.append(el("p", { className: "note" }, ["表示する行はありません。"]));
    return;
  }
  const table = el("table");
  table.append(el("thead", {}, [
    el("tr", {}, columns.map((column) => el("th", {}, [column.label]))),
  ]));
  const body = el("tbody");
  rows.forEach((row) => {
    const tr = el("tr", { className: classify ? classify(row) : "" });
    columns.forEach((column) => tr.append(el("td", {}, [text(row[column.key])])));
    body.append(tr);
  });
  table.append(body);
  target.append(table);
}

function attention(row) {
  if (row.kind === "作業指示" || row.service === "点検") return "low";
  if (row.comfort === "快適範囲外" || row.humidityStatus === "高め") return "low";
  if (row.kind === "機器指令") return "go";
  return "";
}

function temperatureChart(trends) {
  const width = 640;
  const height = 250;
  const pad = { l: 36, r: 12, t: 14, b: 28 };
  const yMin = 24;
  const yMax = 36;
  const labels = trends.times.concat(trends.forecast.map((item) => item.at));
  const xAt = (index) => pad.l + (index * (width - pad.l - pad.r)) / Math.max(labels.length - 1, 1);
  const yAt = (value) => pad.t + ((yMax - value) / (yMax - yMin)) * (height - pad.t - pad.b);
  const plot = svg("svg", {
    class: "chart",
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": "朝の温度推移と外気予報",
  });
  [24, 28, 32, 36].forEach((tick) => {
    const y = yAt(tick);
    plot.append(
      svg("line", { x1: pad.l, x2: width - pad.r, y1: y, y2: y, stroke: "#e1e8e3", "stroke-width": 1 }),
      svg("text", { x: 0, y: y + 4, fill: "#5d6a64", "font-size": 11 }, [text(tick)]),
    );
  });
  labels.forEach((label, index) => {
    plot.append(svg("text", {
      x: xAt(index),
      y: height - 8,
      fill: "#5d6a64",
      "font-size": 11,
      "text-anchor": "middle",
    }, [label]));
  });
  const lines = trends.zones.map((zone) => ({
    color: (SERIES.find((item) => item.key === zone.label) || {}).color || "#17382f",
    points: zone.temperature.map((value, index) => [xAt(index), yAt(value)]),
  }));
  const outside = trends.outside.map((value, index) => [xAt(index), yAt(value)]);
  const forecast = [[xAt(trends.times.length - 1), yAt(last(trends.outside))]].concat(
    trends.forecast.map((item, index) => [xAt(trends.times.length + index), yAt(item.temperature)]),
  );
  lines.concat([{ color: "#a56b22", points: outside }]).forEach((line) => {
    plot.append(svg("polyline", {
      points: line.points.map((point) => point.join(",")).join(" "),
      fill: "none",
      stroke: line.color,
      "stroke-width": 2.5,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }));
    line.points.forEach((point) => {
      plot.append(svg("circle", { cx: point[0], cy: point[1], r: 3.5, fill: line.color }));
    });
  });
  plot.append(svg("polyline", {
    points: forecast.map((point) => point.join(",")).join(" "),
    fill: "none",
    stroke: "#a56b22",
    "stroke-width": 2.5,
    "stroke-dasharray": "5 4",
  }));
  return plot;
}

function higherStatus(value, warnAt, badAt) {
  if (value >= badAt) return "bad";
  if (value >= warnAt) return "warn";
  return "ok";
}

function worse(left, right) {
  const rank = { ok: 0, warn: 1, bad: 2 };
  return rank[left] >= rank[right] ? left : right;
}

function temperatureStatus(zone) {
  return higherStatus(Math.abs(last(zone.temperature) - zone.setpoint), zone.tolerance * 0.9, zone.tolerance);
}

function humidityLevel(zone) {
  const value = last(zone.humidity);
  const span = zone.humidityHigh - zone.humidityLow;
  if (value > zone.humidityHigh || value < zone.humidityLow) return "bad";
  if (value >= zone.humidityHigh - span * 0.1 || value <= zone.humidityLow + span * 0.1) return "warn";
  return "ok";
}

function meter(title, value, note, ratio, tickAt, status) {
  const fill = el("span", { className: "fill" });
  fill.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
  fill.style.background = STATUS_COLOR[status];
  const tick = el("i", { className: "tick" });
  tick.style.left = `${Math.max(0, Math.min(100, tickAt * 100))}%`;
  return el("article", { className: "card meter" }, [
    el("div", { className: "meter-top" }, [el("h3", {}, [title]), el("strong", {}, [value])]),
    el("div", { className: "meter-bar" }, [el("div", { className: "track" }, [fill]), tick]),
    el("p", {}, [note]),
  ]);
}

function zoneCard(zone) {
  const humidity = last(zone.humidity);
  const low = ((zone.humidityLow - 30) / 60) * 100;
  const high = ((zone.humidityHigh - 30) / 60) * 100;
  const markAt = Math.max(0, Math.min(100, ((humidity - 30) / 60) * 100));
  const band = el("span", { className: "band" });
  band.style.left = `${low}%`;
  band.style.width = `${high - low}%`;
  const humid = humidityLevel(zone);
  const mark = el("span", { className: `mark ${humid}` });
  mark.style.left = `${markAt}%`;
  return el("article", { className: `zone ${worse(temperatureStatus(zone), humid)}` }, [
    el("header", {}, [el("h3", {}, [zone.label]), el("strong", {}, [`${text(last(zone.temperature))}℃`])]),
    el("p", {}, [`設定 ${text(zone.setpoint)}±${text(zone.tolerance)}`]),
    el("div", { className: "humid" }, [band, mark]),
    el("p", {}, [`湿度 ${text(humidity)}%`]),
  ]);
}

function renderData(data) {
  const trends = data.trends;
  const context = data.dispatch.context;
  const outdoor = data.outdoor;
  const peopleMax = Math.max(context.footfall, context.footfallBaseline) * 1.2;
  const forecast = trends.forecast[trends.forecast.length - 1];
  const legend = el("ul", { className: "legend" }, SERIES.map((item) => el("li", {}, [
    el("i", { className: "swatch" }),
    item.key,
  ])));
  legend.querySelectorAll(".swatch").forEach((swatch, index) => {
    swatch.style.background = SERIES[index].color;
  });
  legend.append(el("li", {}, [el("i", { className: "swatch" }), "予報"]));
  legend.querySelector("li:last-child .swatch").style.background = "repeating-linear-gradient(90deg, #a56b22 0 6px, transparent 6px 10px)";
  return el("section", {}, [
    el("div", { className: "stage-head" }, [
      el("h2", {}, ["データの可視化"]),
      el("p", {}, [`${trends.times[0]}–${forecast.at}`]),
      el("ul", { className: "status-legend" }, [
        el("li", {}, [el("i", { className: "ok" }), "正常"]),
        el("li", {}, [el("i", { className: "warn" }), "警告"]),
        el("li", {}, [el("i", { className: "bad" }), "異常"]),
      ]),
    ]),
    el("div", { className: "viz" }, [
      el("article", { className: "card" }, [
        el("h3", {}, ["温度"]),
        temperatureChart(trends),
        legend,
      ]),
      el("div", { className: "side" }, [
        meter(
          "室外機",
          `${text(outdoor.power)}kW`,
          `定格 ${text(outdoor.capacity)}kW`,
          outdoor.power / outdoor.capacity,
          1,
          higherStatus(outdoor.power, outdoor.capacity * context.nearCapacityRatio, outdoor.capacity),
        ),
        meter(
          "来店",
          `${text(context.footfall)}人`,
          `平常 ${text(context.footfallBaseline)}人`,
          context.footfall / peopleMax,
          context.footfallBaseline / peopleMax,
          context.footfall > context.footfallBaseline ? "warn" : "ok",
        ),
        meter(
          "ドア",
          `${text(Math.round(context.doorOpenRatio * 100))}%`,
          `上限 ${text(Math.round(context.doorOpenRatioLimit * 100))}%`,
          context.doorOpenRatio,
          context.doorOpenRatioLimit,
          higherStatus(
            context.doorOpenRatio,
            context.doorOpenRatioLimit * context.nearCapacityRatio,
            context.doorOpenRatioLimit,
          ),
        ),
      ]),
    ]),
    el("div", { className: "zones" }, trends.zones.map(zoneCard)),
  ]);
}

const STATUS_LABEL = { ok: "正常", warn: "警告", bad: "異常" };

function lineList(lines) {
  return el("ul", {}, lines.map((line) => el("li", {}, [line])));
}

function renderIssues(data) {
  const issues = data.dispatch.issues;
  return el("section", {}, [
    el("div", { className: "stage-head" }, [
      el("h2", {}, ["課題"]),
      el("p", {}, [`${issues.length}件。経緯のあと、分かった課題`]),
    ]),
    el("div", { className: "issues" }, issues.map((issue) => el("article", { className: `issue ${issue.status}` }, [
      el("div", { className: "trail" }, [
        el("div", { className: "step" }, [el("b", {}, ["関係"]), lineList(issue.relations)]),
        el("div", { className: "step" }, [el("b", {}, ["実測"]), lineList(issue.readings)]),
      ]),
      el("header", { className: "found" }, [
        el("div", {}, [
          el("p", { className: "kicker" }, ["分かった課題"]),
          el("h3", {}, [issue.finding]),
        ]),
        el("b", { className: "status-word" }, [STATUS_LABEL[issue.status]]),
      ]),
    ]))),
  ]);
}

function orderSteps(row) {
  const work = row.kind === "作業指示";
  return [
    el("div", { className: "step" }, [
      el("b", {}, [work ? "作業" : "指令"]),
      el("div", {}, [
        el("p", { className: "order-change" }, [`${row.label}　${row.current} → ${row.command}`]),
        el("p", { className: "order-why" }, [row.because]),
      ]),
    ]),
    el("div", { className: "step" }, [el("b", {}, ["戻す"]), el("p", {}, [row.revert])]),
  ];
}

function renderOrders(data) {
  const orders = [...data.dispatch.commands, ...data.dispatch.workOrders];
  const groups = data.dispatch.issues
    .map((issue) => ({ issue, orders: orders.filter((row) => row.issueTitle === issue.title) }))
    .filter((group) => group.orders.length);
  return el("section", {}, [
    el("div", { className: "stage-head" }, [
      el("h2", {}, ["解決指令"]),
      el("p", {}, [`課題 ${groups.length}件への指令 ${data.dispatch.commands.length}・作業 ${data.dispatch.workOrders.length}`]),
    ]),
    el("div", { className: "issues" }, groups.map((group) => el("article", { className: `issue ${group.issue.status}` }, [
      el("div", { className: "step" }, [
        el("b", {}, ["課題"]),
        el("p", { className: "order-why" }, [group.issue.finding]),
      ]),
      ...group.orders.flatMap(orderSteps),
    ]))),
  ]);
}

function renderNav() {
  const nav = document.querySelector("#steps");
  nav.replaceChildren();
  STEPS.forEach((item, index) => {
    const button = el("button", { type: "button" }, [
      el("b", {}, [item.index]),
      el("span", {}, [item.label]),
    ]);
    button.className = index === step ? "current" : index < step ? "done" : "";
    if (index === step) button.setAttribute("aria-current", "step");
    button.addEventListener("click", () => {
      step = index;
      render();
    });
    nav.append(button);
  });
  const back = document.querySelector("#back");
  const next = document.querySelector("#next");
  back.hidden = step === 0;
  next.hidden = step === STEPS.length - 1;
  back.textContent = step > 0 ? STEPS[step - 1].label : "";
  next.textContent = step < STEPS.length - 1 ? STEPS[step + 1].label : "";
}

function render() {
  const stage = document.querySelector("#stage");
  const view = [renderData, renderIssues, renderOrders][step];
  stage.replaceChildren(view(briefing));
  renderNav();
  stage.scrollTop = 0;
}

function renderQueries(target, blocks) {
  target.replaceChildren();
  if (!blocks || blocks.length === 0) {
    target.append(el("p", { className: "note" }, ["この回答では実行していません。"]));
    return;
  }
  blocks.forEach((block) => {
    const params = block.params ? `\n-- params: ${JSON.stringify(block.params)}` : "";
    target.append(el("h3", {}, [block.name || "SQL"]), el("pre", {}, [(block.text || block.statement || "") + params]));
  });
}

function renderResult(result) {
  const box = document.querySelector("#result");
  box.hidden = false;
  document.querySelector("#result-title").textContent = result.title;
  const answer = document.querySelector("#answer");
  answer.hidden = true;
  answer.textContent = "";
  const tableHost = document.querySelector("#result-table");
  tableHost.className = "table-wrap";
  renderTable(tableHost, result.columns || [], result.rows || [], attention);
  renderQueries(document.querySelector("#sparql"), result.sparql);
  renderQueries(document.querySelector("#sql"), result.sql);
}

async function ask(question) {
  const button = document.querySelector("#ask-button");
  button.disabled = true;
  try {
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "質問に失敗しました。");
    renderResult(body);
  } catch (error) {
    const box = document.querySelector("#result");
    box.hidden = false;
    document.querySelector("#result-title").textContent = "エラー";
    const answer = document.querySelector("#answer");
    answer.hidden = false;
    answer.textContent = error.message;
    document.querySelector("#result-table").replaceChildren();
  } finally {
    button.disabled = false;
  }
}

function bind(data) {
  briefing = data;
  document.querySelector("#brand").textContent = data.store.storeCode;
  document.querySelector("#clock").textContent = `${data.dispatch.context.weekday} ${data.asOf.slice(11, 16)}`;
  document.querySelector("#disclaimer").textContent = data.disclaimer;
  const prompts = document.querySelector("#prompts");
  prompts.replaceChildren();
  data.prompts.forEach((prompt) => {
    const button = el("button", { type: "button" }, [prompt]);
    button.addEventListener("click", () => {
      document.querySelector("#question").value = prompt;
      ask(prompt);
    });
    prompts.append(button);
  });
  render();
}

document.querySelector("#back").addEventListener("click", () => {
  if (step > 0) {
    step -= 1;
    render();
  }
});
document.querySelector("#next").addEventListener("click", () => {
  if (step < STEPS.length - 1) {
    step += 1;
    render();
  }
});
document.querySelector("#ask-open").addEventListener("click", () => {
  document.querySelector("#ask").showModal();
});
document.querySelector("#ask-close").addEventListener("click", () => {
  document.querySelector("#ask").close();
});
document.querySelector("#ask-form").addEventListener("submit", (event) => {
  event.preventDefault();
  ask(document.querySelector("#question").value);
});

fetch("/api/bootstrap")
  .then((response) => response.json().then((body) => ({ ok: response.ok, body })))
  .then(({ ok, body }) => {
    if (!ok) throw new Error(body.error || "初期データの読み込みに失敗しました。");
    bind(body);
  })
  .catch((error) => {
    document.querySelector("#brand").textContent = error.message;
  });
