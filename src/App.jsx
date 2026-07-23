import { useState, useEffect, useMemo, useCallback, useRef } from "react";

// ─── Данные: 58 объектов из Fire_Safety_Compliance_Matrix.xlsx ───
// Перед публичной публикацией замените/очистите src/data/seed.json — там внутренние данные.
import SEED from "./data/seed.json";
const DATA = SEED;

// ─── Адаптер хранилища: window.storage (артефакт Claude) → localStorage (браузер) ───
const store = {
  async get(key) {
    if (typeof window !== "undefined" && window.storage?.get) return window.storage.get(key);
    const v = localStorage.getItem(key);
    if (v === null) throw new Error("not found");
    return { key, value: v };
  },
  async set(key, value) {
    if (typeof window !== "undefined" && window.storage?.set) return window.storage.set(key, value);
    localStorage.setItem(key, value);
    return { key, value };
  },
};

const SCHEMA = 3;
const KEY_V3 = "fintrent-fire-doc-v3";
const KEY_V2 = "fintrent-fire-objects-v2";

// ─── Каталог систем ПБ ───
const SYSTEMS_CATALOG = [
  { key: "ext",       name: "Огнетушители",                    interval: 12, ref: "NFPA 10: осмотр ежемесячно, ТО ежегодно" },
  { key: "alarm",     name: "Пожарная сигнализация (АУПС)",    interval: 12, ref: "NFPA 72: испытание ежегодно" },
  { key: "sprinkler", name: "Спринклеры / АУПТ",               interval: 12, ref: "NFPA 25: инспекции ежекварт./ежегодно" },
  { key: "emlight",   name: "Аварийное освещение и знаки",     interval: 12, ref: "NFPA 101" },
  { key: "hydrant",   name: "Пожарные краны / рукава",         interval: 12, ref: "NFPA 25" },
  { key: "smoke",     name: "Дымоудаление / вентиляция",       interval: 12, ref: "" },
  { key: "kitchen",   name: "Кухонная система (класс F/K)",    interval: 6,  ref: "NFPA 96: ТО каждые 6 мес", auto: (o) => /food|kitchen|deli/i.test(o.specRisks) },
  { key: "liion",     name: "Хранение Li-ion / зарядка",       interval: 6,  ref: "UAE FLS Code: план ПБ, отсечки 2 ч", auto: (o) => /li-ion/i.test(o.specRisks) },
  { key: "fuel",      name: "Топливо / ГСМ на площадке",       interval: 6,  ref: "локальные нормы опасных веществ", auto: (o) => /fuel|vehicle/i.test(o.specRisks) },
  { key: "hassantuk", name: "Hassantuk (подключение к DCD)",   interval: 12, ref: "обязателен для коммерческих с 2026", auto: (o) => o.country === "UAE" },
];

// ─── Нормы по странам (интервалы в месяцах; ptm = обучение руководителя/ответственного в учебном центре) ───
const CIS = { briefing: 6, ptm: 36, drills: 1, basisNote: "инструктаж каждые 6 мес; ПТМ в учебном центре раз в 3 года" };
const NORMS = {
  default:      { basis: "NFPA 10/25/72/101 как внутренний стандарт (слой 2 фреймворка)", briefing: 12, ptm: null, drills: 1 },
  "Qazaqstan":  { ...CIS, basis: "Приказ МЧС РК №276 + письмо МЧС от 14.04.2026 (ПТМ обязателен даже без штата)" },
  "Uzbekistan": { ...CIS, basis: "Закон «О пожарной безопасности»; ШНК 2.01.02 🟡" },
  "Armenia":    { ...CIS, basis: "Правила ПБ РА 🟡" },
  "Azerbaijan": { ...CIS, basis: "Yanğın təhlükəsizliyi Qaydaları 🟡" },
  "Georgia":    { ...CIS, basis: "ПП №370 (2015) 🟡" },
  "Kyrgyzstan": { ...CIS, basis: "Закон «О пожарной безопасности» КР 🟡" },
  "UAE":        { basis: "UAE Fire & Life Safety Code; AMC ежегодно, PPM ежеквартально; Hassantuk", briefing: 12, ptm: null, drills: 1, sys: { alarm: 3, sprinkler: 3 } },
  "Bolivia":    { basis: "SIPPCI (DS 2995): memoria técnica, готовность к инспекциям Bomberos", briefing: 12, ptm: null, drills: 1 },
  "China":      { basis: "消防法: ежемесячные внутренние проверки, назначение 消防安全责任人", briefing: 12, ptm: null, drills: 2, sys: { alarm: 1, ext: 1 } },
  "Israel":     { basis: "הוראות נציב כבאות", briefing: 12, ptm: null, drills: 1 },
  "Turkey":     { basis: "BYKHY: огнетушители ежегодно, tahliye planı", briefing: 12, ptm: null, drills: 1 },
  "Ghana":      { basis: "GNFS: Fire Certificate ежегодно", briefing: 12, ptm: null, drills: 1 },
  "Colombia":   { basis: "Resolución 0312/2019 (SG-SST): план эвакуации и бригада — на работодателе", briefing: 12, ptm: null, drills: 1 },
  "Netherlands":{ basis: "Bbl ст. 6.8: поэтажный план с путями эвакуации", briefing: 12, ptm: null, drills: 1 },
  "Switzerland":{ basis: "VKF BSV 2015 (BSV 2026 — с осени 2027)", briefing: 12, ptm: null, drills: 1 },
};
const normFor = (c) => NORMS[c] || NORMS.default;

const GROUP_INFO = {
  A: { color: "#C7361B", label: "сертификат = условие лицензии" },
  B: { color: "#B0791C", label: "сертификат привязан к зданию" },
  C: { color: "#3E6C9E", label: "надзор без разрешения" },
  D: { color: "#77816F", label: "номинальное регулирование" },
};
const PRIO_COLOR = { P1: "#C7361B", P2: "#B0791C", P3: "#5C645E", "P?": "#8A928B" };
const CONF_MARK = { "Проверено": "🟢", "Структура — общие знания": "🟡", "Публичного источника нет": "🔴" };
const STATUS_COLOR = { critical: "#C7361B", warning: "#B0791C", ok: "#2F7A46", unknown: "#8A928B" };

// ─── Даты ───
const daysTo = (d) => {
  if (!d) return null;
  const t = new Date(d + "T00:00:00");
  return isNaN(t) ? null : Math.ceil((t - new Date()) / 86400000);
};
const addMonths = (d, m) => {
  const t = new Date(d + "T00:00:00");
  if (isNaN(t)) return null;
  t.setMonth(t.getMonth() + m);
  return t.toISOString().slice(0, 10);
};
// статус периодической обязанности: last + interval(мес)
function dueStatus(last, months) {
  if (!last) return { key: "unknown", label: "нет данных", due: null };
  const due = addMonths(last, months);
  const d = daysTo(due);
  if (d < 0) return { key: "critical", label: `просрочено ${-d} дн`, due };
  if (d <= 30) return { key: "warning", label: `до ${due} (${d} дн)`, due };
  return { key: "ok", label: `до ${due}`, due };
}
const worst = (arr) => ["critical", "warning", "unknown", "ok"].find((k) => arr.includes(k)) || "ok";
const isOperatorHeld = (o) => /не у вас|оператор/i.test(o.certHolder || "");
const today = () => new Date().toISOString().slice(0, 10);

// ─── Миграция объекта к схеме v3 ───
function migrate(o) {
  const systems = { ...(o.systems || {}) };
  SYSTEMS_CATALOG.forEach((s) => {
    if (!systems[s.key]) systems[s.key] = { present: s.auto?.(o) ? "yes" : "unknown", lastCheck: "", notes: "" };
  });
  return {
    ...o,
    systems,
    training: { orderDate: "", ptmDate: "", briefingDate: "", journal: "unknown", ...(o.training || {}) },
    drills: Array.isArray(o.drills) ? o.drills : [],
    updatedAt: o.updatedAt || "",
  };
}

// ─── Расчёт состояния объекта ───
function assess(o) {
  const n = normFor(o.country);
  const exp = daysTo(o.certExpiry);

  let cert;
  if ((o.prescriptions || "").trim()) cert = { key: "critical", label: "предписание" };
  else if (exp !== null && exp < 0) cert = { key: "critical", label: `истёк ${-exp} дн назад` };
  else if (o.group === "A" && !isOperatorHeld(o) && !o.certExpiry) cert = { key: "critical", label: "нет сертификата (гр. A)" };
  else if (exp !== null && exp <= 90) cert = { key: "warning", label: `истекает: ${exp} дн` };
  else if (isOperatorHeld(o) && !o.certExpiry) cert = { key: "warning", label: "запросить копию у оператора" };
  else if (!o.certExpiry) cert = { key: "unknown", label: "срок не внесён" };
  else cert = { key: "ok", label: `до ${o.certExpiry}` };

  const sysRows = SYSTEMS_CATALOG.map((s) => {
    const st = o.systems?.[s.key] || { present: "unknown", lastCheck: "" };
    const interval = n.sys?.[s.key] || s.interval;
    let status;
    if (st.present === "na" || st.present === "no") status = { key: "ok", label: st.present === "na" ? "не применимо" : "отсутствует (подтверждено)" };
    else if (st.present === "unknown") status = { key: "unknown", label: "наличие не подтверждено" };
    else status = dueStatus(st.lastCheck, interval);
    return { ...s, interval, st, status };
  });
  const sysKey = worst(sysRows.filter((r) => r.st.present === "yes" || r.st.present === "unknown").map((r) => r.status.key));

  const t = o.training || {};
  const trainRows = [
    { name: "Приказ о назначении ответственного", status: t.orderDate ? { key: "ok", label: `от ${t.orderDate}` } : { key: "warning", label: "нет приказа" } },
    { name: `Инструктаж (кажд. ${n.briefing} мес) + журнал`, status: dueStatus(t.briefingDate, n.briefing) },
    ...(n.ptm ? [{ name: "ПТМ в учебном центре (раз в 3 года)", status: dueStatus(t.ptmDate, n.ptm) }] : []),
  ];
  const trainKey = worst(trainRows.map((r) => r.status.key));

  const lastDrill = (o.drills || []).map((d) => d.date).sort().pop() || "";
  const drillStatus = dueStatus(lastDrill, Math.round(12 / (n.drills || 1)));
  // «нет данных» по тренировке = warning, а не unknown: обязанность универсальна
  if (drillStatus.key === "unknown") drillStatus.label = "тренировок не зафиксировано";

  const noBase = !o.area || !o.occupancy;
  const overall = worst([cert.key, sysKey, trainKey, drillStatus.key === "unknown" ? "warning" : drillStatus.key, noBase ? "warning" : "ok"]);
  return { cert, sysRows, sysKey, trainRows, trainKey, drillStatus, lastDrill, overall, norm: n, noBase };
}

const EMPTY = migrate({
  id: null, name: "", country: "", city: "", region: "", tier: "", type: "",
  area: "", occupancy: "", specRisks: "", groupRaw: "", group: "C",
  certHolder: "", regulator: "", keyDoc: "", monitorSource: "", tenantDuties: "",
  threshold: "", periodicity: "", riskText: "", priority: "P?", confidence: "",
  comment: "", certType: "", certNumber: "", certExpiry: "", amcDate: "",
  responsible: "", lastCheck: "", prescriptions: "", notes: "",
});

const Dot = ({ k, title }) => (
  <span title={title} style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: STATUS_COLOR[k] }} />
);

export default function App() {
  const [doc, setDoc] = useState(null); // {schema, objects, log}
  const [filters, setFilters] = useState({ q: "", country: "all", group: "all", priority: "all", status: "all" });
  const [editing, setEditing] = useState(null);
  const [tab, setTab] = useState("passport");
  const [saveState, setSaveState] = useState("");
  const fileRef = useRef(null);

  // ─── Загрузка + миграция хранилища ───
  useEffect(() => {
    (async () => {
      try {
        const r = await store.get(KEY_V3);
        const d = JSON.parse(r.value);
        setDoc({ schema: SCHEMA, objects: d.objects.map(migrate), log: d.log || [] });
        return;
      } catch {}
      try {
        const r2 = await store.get(KEY_V2); // миграция со старой версии
        const arr = JSON.parse(r2.value);
        setDoc({ schema: SCHEMA, objects: arr.map(migrate), log: [{ ts: today(), id: "*", action: "миграция данных v2 → v3" }] });
        return;
      } catch {}
      setDoc({ schema: SCHEMA, objects: DATA.map(migrate), log: [{ ts: today(), id: "*", action: "инициализация из Fire_Safety_Compliance_Matrix (58 объектов)" }] });
    })();
  }, []);

  const persist = useCallback(async (objects, logEntry) => {
    const next = {
      schema: SCHEMA,
      objects,
      log: logEntry ? [{ ts: today(), ...logEntry }, ...(doc?.log || [])].slice(0, 300) : doc?.log || [],
    };
    setDoc(next);
    try { await store.set(KEY_V3, JSON.stringify(next)); setSaveState("сохранено"); }
    catch { setSaveState("ошибка сохранения — данные только в памяти"); }
    setTimeout(() => setSaveState(""), 2500);
  }, [doc]);

  const enriched = useMemo(() => (doc?.objects || []).map((o) => ({ ...o, _a: assess(o) })), [doc]);
  const countries = useMemo(() => [...new Set(enriched.map((o) => o.country))].sort(), [enriched]);

  const kpi = useMemo(() => ({
    critical: enriched.filter((o) => o._a.overall === "critical").length,
    certs: enriched.filter((o) => ["critical", "warning"].includes(o._a.cert.key)).length,
    systems: enriched.filter((o) => o._a.sysKey === "critical" || o._a.sysKey === "warning").length,
    people: enriched.filter((o) => ["critical", "warning"].includes(o._a.trainKey) || o._a.drillStatus.key !== "ok").length,
  }), [enriched]);

  const byGroup = useMemo(() => {
    const m = { A: 0, B: 0, C: 0, D: 0 };
    enriched.forEach((o) => { m[o.group]++; });
    return m;
  }, [enriched]);

  const visible = useMemo(() => enriched.filter((o) => {
    if (filters.country !== "all" && o.country !== filters.country) return false;
    if (filters.group !== "all" && o.group !== filters.group) return false;
    if (filters.priority !== "all" && o.priority !== filters.priority) return false;
    if (filters.status !== "all" && o._a.overall !== filters.status) return false;
    const q = filters.q.trim().toLowerCase();
    if (q && !`${o.id} ${o.name} ${o.city} ${o.country} ${o.type} ${o.certNumber} ${o.responsible} ${o.specRisks}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => {
    const rank = { critical: 0, warning: 1, unknown: 2, ok: 3 };
    const pr = { P1: 0, P2: 1, P3: 2, "P?": 3 };
    return rank[a._a.overall] - rank[b._a.overall] || pr[a.priority] - pr[b.priority];
  }), [enriched, filters]);

  const openEdit = (o) => { const { _a, ...rest } = o; setEditing(JSON.parse(JSON.stringify(rest))); setTab("passport"); };
  const setField = (k, v) => setEditing((e) => ({ ...e, [k]: v }));
  const setSys = (key, field, v) => setEditing((e) => ({ ...e, systems: { ...e.systems, [key]: { ...e.systems[key], [field]: v } } }));
  const setTrain = (k, v) => setEditing((e) => ({ ...e, training: { ...e.training, [k]: v } }));
  const addDrill = () => setEditing((e) => ({ ...e, drills: [...e.drills, { date: today(), note: "" }] }));
  const setDrill = (i, k, v) => setEditing((e) => ({ ...e, drills: e.drills.map((d, j) => (j === i ? { ...d, [k]: v } : d)) }));
  const rmDrill = (i) => setEditing((e) => ({ ...e, drills: e.drills.filter((_, j) => j !== i) }));

  const saveObject = () => {
    if (!editing.name.trim()) return;
    const stamped = { ...editing, updatedAt: today() };
    const exists = doc.objects.some((o) => o.id === editing.id);
    const objects = exists
      ? doc.objects.map((o) => (o.id === editing.id ? stamped : o))
      : [...doc.objects, { ...stamped, id: editing.id || "FAC-N" + Date.now() }];
    persist(objects, { id: stamped.id || "новый", action: exists ? `изменение: ${stamped.name}` : `создан объект: ${stamped.name}` });
    setEditing(null);
  };
  const deleteObject = () => {
    persist(doc.objects.filter((o) => o.id !== editing.id), { id: editing.id, action: `удалён: ${editing.name}` });
    setEditing(null);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `fintrent_fire_registry_${today()}.json`; a.click();
  };
  const importJson = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const p = JSON.parse(rd.result);
        const arr = Array.isArray(p) ? p : p.objects;
        if (Array.isArray(arr)) persist(arr.map(migrate), { id: "*", action: `импорт файла (${arr.length} объектов)` });
        else setSaveState("файл не похож на реестр");
      } catch { setSaveState("не удалось прочитать JSON"); }
    };
    rd.readAsText(f); e.target.value = "";
  };
  const resetToMatrix = () => persist(DATA.map(migrate), { id: "*", action: "сброс к исходной матрице (58 объектов)" });

  if (doc === null) return <div style={{ fontFamily: "system-ui", padding: 40, color: "#556" }}>Загрузка реестра…</div>;
  const total = enriched.length || 1;
  const ea = editing ? assess(editing) : null;

  return (
    <div className="app">
      <style>{`
        :root { --paper:#EEF0EB; --card:#FBFCFA; --ink:#181C1E; --mut:#5C645E; --line:#D8DCD3; }
        * { box-sizing:border-box; margin:0; }
        .app { min-height:100vh; background:var(--paper); color:var(--ink);
          font-family:-apple-system,"Segoe UI",Roboto,sans-serif; font-size:14px; padding:20px 22px 60px; }
        .mono { font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; }
        .head { display:flex; flex-wrap:wrap; align-items:baseline; gap:12px; margin-bottom:6px; }
        h1 { font-size:19px; font-weight:700; }
        .eyebrow { font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--mut); }
        .save { font-size:12px; color:#2F7A46; margin-left:auto; }
        .bar { display:flex; height:14px; border-radius:3px; overflow:hidden; margin:14px 0 6px; border:1px solid var(--line); }
        .legend { display:flex; flex-wrap:wrap; gap:14px; font-size:12px; color:var(--mut); margin-bottom:18px; }
        .ldot { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px; }
        .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:18px; }
        .kpi { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:12px 14px; cursor:pointer; }
        .kpi b { font-size:24px; display:block; }
        .kpi span { font-size:12px; color:var(--mut); }
        .toolbar { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; align-items:center; }
        input,select,textarea { font:inherit; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:5px; padding:7px 10px; }
        input:focus,select:focus,textarea:focus,button:focus-visible { outline:2px solid #3E6C9E; outline-offset:1px; }
        .search { flex:1 1 220px; min-width:170px; }
        button { font:inherit; cursor:pointer; border-radius:5px; border:1px solid var(--line); background:var(--card); padding:7px 12px; }
        .primary { background:var(--ink); color:#fff; border-color:var(--ink); font-weight:600; }
        .danger { color:#C7361B; border-color:#C7361B; background:transparent; }
        .ghost { background:transparent; }
        .rows { display:flex; flex-direction:column; gap:7px; }
        .row { display:grid; grid-template-columns:6px 1fr auto; background:var(--card); border:1px solid var(--line);
          border-radius:6px; overflow:hidden; cursor:pointer; }
        .row:hover { border-color:#9aa39a; }
        .row-main { padding:10px 14px; min-width:0; }
        .row-title { font-weight:600; display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
        .badge { font-size:11px; font-weight:700; padding:1px 7px; border-radius:3px; color:#fff; }
        .pbadge { font-size:11px; font-weight:700; padding:1px 6px; border-radius:3px; border:1.5px solid; background:transparent; }
        .row-sub { font-size:12px; color:var(--mut); margin-top:3px; display:flex; flex-wrap:wrap; gap:4px 14px; align-items:center; }
        .mini { display:inline-flex; gap:4px; align-items:center; }
        .mini i { font-style:normal; font-size:10px; color:var(--mut); margin-right:1px; }
        .row-side { padding:10px 14px; text-align:right; display:flex; flex-direction:column; gap:3px; justify-content:center; }
        .chip { font-size:12px; font-weight:600; }
        .empty { padding:36px; text-align:center; color:var(--mut); background:var(--card); border:1px dashed var(--line); border-radius:6px; }
        .overlay { position:fixed; inset:0; background:rgba(20,24,20,.45); display:flex; justify-content:center; align-items:flex-start; padding:26px 14px; overflow:auto; z-index:10; }
        .modal { background:var(--card); border-radius:8px; padding:20px; width:100%; max-width:760px; }
        .modal h2 { font-size:16px; margin-bottom:2px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
        .hint { font-size:12px; color:var(--mut); margin-bottom:10px; }
        .basis { background:#F2F4EF; border:1px solid var(--line); border-radius:6px; padding:9px 12px; font-size:12.5px; margin-bottom:12px; }
        .tabs { display:flex; gap:2px; border-bottom:1px solid var(--line); margin-bottom:14px; flex-wrap:wrap; }
        .tab { border:none; background:transparent; padding:8px 12px; border-bottom:2px solid transparent; border-radius:0; color:var(--mut); font-weight:600; font-size:13px; }
        .tab.on { color:var(--ink); border-bottom-color:var(--ink); }
        .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
        .grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; }
        label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--mut); margin-bottom:10px; }
        label > input, label > select, label > textarea { color:var(--ink); }
        .sysrow { display:grid; grid-template-columns:minmax(150px,1.4fr) 110px 140px 1fr; gap:8px; align-items:center;
          padding:8px 0; border-bottom:1px solid var(--line); font-size:13px; }
        .sysname b { display:block; }
        .sysname span { font-size:11px; color:var(--mut); }
        .stlabel { font-size:12px; font-weight:600; }
        .drill { display:grid; grid-template-columns:140px 1fr auto; gap:8px; margin-bottom:8px; align-items:center; }
        .loglist { font-size:13px; display:flex; flex-direction:column; gap:6px; max-height:300px; overflow:auto; }
        .logitem { border-bottom:1px solid var(--line); padding-bottom:6px; }
        .actions { display:flex; gap:8px; margin-top:14px; }
        .spacer { flex:1; }
        @media (max-width:620px){ .grid2,.grid3 { grid-template-columns:1fr; } .row-side{display:none;}
          .sysrow { grid-template-columns:1fr 1fr; } .drill { grid-template-columns:1fr; } }
      `}</style>

      <div className="head">
        <div>
          <div className="eyebrow">FINTRENT · Система отслеживания состояния объектов · ПБ</div>
          <h1>Реестр — {enriched.length} объектов</h1>
        </div>
        <span className="save" role="status">{saveState}</span>
      </div>

      <div className="bar" aria-hidden="true">
        {["A", "B", "C", "D"].map((g) => (
          <div key={g} style={{ width: `${(byGroup[g] / total) * 100}%`, background: GROUP_INFO[g].color }} title={`Группа ${g}: ${byGroup[g]}`} />
        ))}
      </div>
      <div className="legend">
        {["A", "B", "C", "D"].map((g) => (
          <span key={g}><span className="ldot" style={{ background: GROUP_INFO[g].color }} />{g} · {byGroup[g]} — {GROUP_INFO[g].label}</span>
        ))}
      </div>

      <div className="kpis">
        <div className="kpi" role="button" tabIndex={0} onClick={() => setFilters((f) => ({ ...f, status: f.status === "critical" ? "all" : "critical" }))}>
          <b style={{ color: kpi.critical ? "#C7361B" : "#2F7A46" }}>{kpi.critical}</b><span>объектов в критичном состоянии</span>
        </div>
        <div className="kpi"><b style={{ color: kpi.certs ? "#B0791C" : "#2F7A46" }}>{kpi.certs}</b><span>проблемы с сертификатами</span></div>
        <div className="kpi"><b style={{ color: kpi.systems ? "#B0791C" : "#2F7A46" }}>{kpi.systems}</b><span>системы ПБ: просрочено / не подтверждено</span></div>
        <div className="kpi"><b style={{ color: kpi.people ? "#B0791C" : "#2F7A46" }}>{kpi.people}</b><span>обучение или эвакуация не в норме</span></div>
      </div>

      <div className="toolbar">
        <input className="search" placeholder="Поиск: ID, объект, город, тип, риски" value={filters.q}
          onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} aria-label="Поиск" />
        <select value={filters.country} onChange={(e) => setFilters((f) => ({ ...f, country: e.target.value }))}>
          <option value="all">Все страны ({countries.length})</option>
          {countries.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select value={filters.group} onChange={(e) => setFilters((f) => ({ ...f, group: e.target.value }))}>
          <option value="all">Группа: все</option>{["A", "B", "C", "D"].map((g) => <option key={g}>{g}</option>)}
        </select>
        <select value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}>
          <option value="all">Приоритет: все</option>{["P1", "P2", "P3"].map((p) => <option key={p}>{p}</option>)}
        </select>
        <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
          <option value="all">Любой статус</option>
          <option value="critical">Критично</option><option value="warning">Внимание</option>
          <option value="unknown">Не определён</option><option value="ok">В порядке</option>
        </select>
        <button onClick={exportJson}>Экспорт</button>
        <button className="ghost" onClick={() => fileRef.current?.click()}>Импорт</button>
        <input ref={fileRef} type="file" accept=".json" style={{ display: "none" }} onChange={importJson} />
        <button className="ghost" onClick={resetToMatrix} title="Вернуть исходные 58 объектов">Сброс</button>
        <button className="primary" onClick={() => { setEditing(JSON.parse(JSON.stringify(EMPTY))); setTab("passport"); }}>+ Объект</button>
      </div>

      <div className="rows">
        {visible.length === 0 && <div className="empty">Ничего не найдено. Измените фильтры или добавьте объект.</div>}
        {visible.map((o) => (
          <div key={o.id} className="row" onClick={() => openEdit(o)} role="button" tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && openEdit(o)}>
            <div style={{ background: STATUS_COLOR[o._a.overall] }} />
            <div className="row-main">
              <div className="row-title">
                <span className="badge" style={{ background: GROUP_INFO[o.group].color }}>{o.groupRaw || o.group}</span>
                <span className="pbadge" style={{ color: PRIO_COLOR[o.priority], borderColor: PRIO_COLOR[o.priority] }}>{o.priority}</span>
                <span className="mono" style={{ fontWeight: 400, color: "var(--mut)", fontSize: 12 }}>{o.id}</span>
                {o.name}
                <span style={{ color: "var(--mut)", fontWeight: 400 }}>{o.country} · {o.city}</span>
              </div>
              <div className="row-sub">
                <span className="mini"><i>серт</i><Dot k={o._a.cert.key} title={`Сертификат: ${o._a.cert.label}`} /></span>
                <span className="mini"><i>сист</i><Dot k={o._a.sysKey} title="Системы ПБ" /></span>
                <span className="mini"><i>обуч</i><Dot k={o._a.trainKey} title="Обучение" /></span>
                <span className="mini"><i>эвак</i><Dot k={o._a.drillStatus.key} title={`Эвакуация: ${o._a.drillStatus.label}`} /></span>
                <span>{o.type}{isOperatorHeld(o) ? " · серт. у оператора" : ""}</span>
                <span className="mono">{o.area ? `${o.area} м²` : "м²?"} · {o.occupancy ? `${o.occupancy} чел` : "чел?"}</span>
                {o.specRisks && <span style={{ color: "#8a4a12" }}>⚠ {o.specRisks}</span>}
                <span title={o.confidence}>{CONF_MARK[o.confidence] || ""}</span>
              </div>
            </div>
            <div className="row-side">
              <span className="chip" style={{ color: STATUS_COLOR[o._a.overall] }}>
                {o._a.overall === "critical" ? "критично" : o._a.overall === "warning" ? "внимание" : o._a.overall === "ok" ? "в порядке" : "нет данных"}
              </span>
              <span className="mono" style={{ fontSize: 12, color: "var(--mut)" }}>{o.updatedAt ? `обновлён ${o.updatedAt}` : "не сверялся"}</span>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="modal" role="dialog" aria-label="Карточка объекта">
            <h2>
              {editing.group && <span className="badge" style={{ background: GROUP_INFO[editing.group].color }}>{editing.groupRaw || editing.group}</span>}
              {editing.id ? `${editing.id} · ${editing.name || ""}` : "Новый объект"}
            </h2>
            <div className="hint">
              {editing.country} {editing.city && `· ${editing.city}`} {editing.tier && `· Tier ${editing.tier}`}
              {editing.confidence && ` · ${CONF_MARK[editing.confidence] || ""} ${editing.confidence}`}
              {editing.updatedAt && ` · последнее обновление ${editing.updatedAt}`}
            </div>
            <div className="basis"><b>Нормативная база:</b> {ea.norm.basis}{ea.norm.basisNote ? ` · ${ea.norm.basisNote}` : ""}</div>

            <div className="tabs" role="tablist">
              {[["passport", "Паспорт"], ["systems", "Системы ПБ"], ["people", "Обучение и эвакуация"], ["ref", "Требования"], ["log", "История"]].map(([k, t]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{t}</button>
              ))}
            </div>

            {tab === "passport" && (<>
              <div className="grid2">
                <label>Название объекта<input value={editing.name} onChange={(e) => setField("name", e.target.value)} /></label>
                <label>Приоритет<select value={editing.priority} onChange={(e) => setField("priority", e.target.value)}>{["P1", "P2", "P3", "P?"].map((p) => <option key={p}>{p}</option>)}</select></label>
                <label>Страна<input value={editing.country} onChange={(e) => setField("country", e.target.value)} /></label>
                <label>Город<input value={editing.city} onChange={(e) => setField("city", e.target.value)} /></label>
              </div>
              <div className="grid3">
                <label>Группа<select value={editing.group} onChange={(e) => setField("group", e.target.value)}>{["A", "B", "C", "D"].map((g) => <option key={g}>{g}</option>)}</select></label>
                <label>Площадь, м²<input className="mono" value={editing.area} onChange={(e) => setField("area", e.target.value)} inputMode="decimal" /></label>
                <label>Вместимость, чел<input className="mono" value={editing.occupancy} onChange={(e) => setField("occupancy", e.target.value)} inputMode="numeric" /></label>
              </div>
              <div className="grid2">
                <label>Тип сертификата<input value={editing.certType} onChange={(e) => setField("certType", e.target.value)} placeholder="DCD CC / SIPPCI / копия от оператора…" /></label>
                <label>№ сертификата<input className="mono" value={editing.certNumber} onChange={(e) => setField("certNumber", e.target.value)} /></label>
                <label>Сертификат действует до<input type="date" className="mono" value={editing.certExpiry} onChange={(e) => setField("certExpiry", e.target.value)} /></label>
                <label>Ответственный на площадке<input value={editing.responsible} onChange={(e) => setField("responsible", e.target.value)} /></label>
              </div>
              <label>Открытые предписания (пусто = нет)<input value={editing.prescriptions} onChange={(e) => setField("prescriptions", e.target.value)} /></label>
              <label>Заметки<textarea rows={2} value={editing.notes} onChange={(e) => setField("notes", e.target.value)} /></label>
            </>)}

            {tab === "systems" && (<>
              <div className="hint">Интервал проверки берётся из норм страны, иначе — NFPA. «Дата проверки» = последнее ТО/испытание по акту.</div>
              {ea.sysRows.map((r) => (
                <div key={r.key} className="sysrow">
                  <div className="sysname"><b>{r.name}</b><span>{r.ref || `интервал ${r.interval} мес`}{r.ref && ` · ${r.interval} мес`}</span></div>
                  <select value={r.st.present} onChange={(e) => setSys(r.key, "present", e.target.value)} aria-label={`Наличие: ${r.name}`}>
                    <option value="unknown">?</option><option value="yes">есть</option>
                    <option value="no">нет</option><option value="na">не прим.</option>
                  </select>
                  <input type="date" className="mono" value={r.st.lastCheck} disabled={r.st.present !== "yes"}
                    onChange={(e) => setSys(r.key, "lastCheck", e.target.value)} aria-label={`Дата проверки: ${r.name}`} />
                  <span className="stlabel" style={{ color: STATUS_COLOR[r.status.key] }}>{r.status.label}</span>
                </div>
              ))}
            </>)}

            {tab === "people" && (<>
              <div className="grid3">
                <label>Приказ об ответственном (дата)
                  <input type="date" className="mono" value={editing.training.orderDate} onChange={(e) => setTrain("orderDate", e.target.value)} />
                </label>
                <label>Последний инструктаж (кажд. {ea.norm.briefing} мес)
                  <input type="date" className="mono" value={editing.training.briefingDate} onChange={(e) => setTrain("briefingDate", e.target.value)} />
                </label>
                {ea.norm.ptm ? (
                  <label>ПТМ в учебном центре (раз в 3 года)
                    <input type="date" className="mono" value={editing.training.ptmDate} onChange={(e) => setTrain("ptmDate", e.target.value)} />
                  </label>
                ) : <label>Журнал инструктажей ведётся
                  <select value={editing.training.journal} onChange={(e) => setTrain("journal", e.target.value)}>
                    <option value="unknown">?</option><option value="yes">да</option><option value="no">нет</option>
                  </select>
                </label>}
              </div>
              {ea.trainRows.map((r, i) => (
                <div key={i} className="sysrow" style={{ gridTemplateColumns: "1fr auto" }}>
                  <div className="sysname"><b>{r.name}</b></div>
                  <span className="stlabel" style={{ color: STATUS_COLOR[r.status.key] }}>{r.status.label}</span>
                </div>
              ))}
              <div style={{ margin: "16px 0 8px", fontWeight: 600 }}>
                Тренировки по эвакуации — норма: {ea.norm.drills}×/год ·{" "}
                <span className="stlabel" style={{ color: STATUS_COLOR[ea.drillStatus.key] }}>{ea.drillStatus.label}</span>
              </div>
              {editing.drills.map((d, i) => (
                <div key={i} className="drill">
                  <input type="date" className="mono" value={d.date} onChange={(e) => setDrill(i, "date", e.target.value)} />
                  <input value={d.note} placeholder="участники, время эвакуации, замечания" onChange={(e) => setDrill(i, "note", e.target.value)} />
                  <button className="ghost" onClick={() => rmDrill(i)} aria-label="Удалить запись">✕</button>
                </div>
              ))}
              <button onClick={addDrill}>+ Зафиксировать тренировку</button>
            </>)}

            {tab === "ref" && (
              <div className="loglist" style={{ maxHeight: 420 }}>
                {editing.certHolder && <div className="logitem"><b>Кто держит сертификат:</b> {editing.certHolder}</div>}
                {editing.regulator && <div className="logitem"><b>Регулятор:</b> {editing.regulator}{editing.keyDoc ? ` — ${editing.keyDoc}` : ""}</div>}
                {editing.tenantDuties && <div className="logitem"><b>Что на арендаторе:</b> {editing.tenantDuties}</div>}
                {editing.threshold && <div className="logitem"><b>Триггер порога:</b> {editing.threshold}</div>}
                {editing.riskText && <div className="logitem"><b>Риск при нарушении:</b> {editing.riskText}</div>}
                {editing.monitorSource && <div className="logitem"><b>Источник мониторинга:</b> {editing.monitorSource}</div>}
                {editing.comment && <div className="logitem"><b>Комментарий:</b> {editing.comment}</div>}
                <div className="logitem"><b>Универсальное ядро (слой 1):</b> ответственный приказом; инструктаж + журнал; учебная эвакуация; план по фактической планировке; свободные выходы; огнетушители в своей зоне; документы на площадке.</div>
              </div>
            )}

            {tab === "log" && (
              <div className="loglist">
                {(doc.log || []).filter((l) => l.id === "*" || l.id === editing.id).slice(0, 40).map((l, i) => (
                  <div key={i} className="logitem"><span className="mono" style={{ color: "var(--mut)" }}>{l.ts}</span> — {l.action}</div>
                ))}
                {!(doc.log || []).some((l) => l.id === "*" || l.id === editing.id) && <div style={{ color: "var(--mut)" }}>Изменений пока не зафиксировано.</div>}
              </div>
            )}

            <div className="actions">
              {editing.id && doc.objects.some((o) => o.id === editing.id) && <button className="danger" onClick={deleteObject}>Удалить</button>}
              <span className="spacer" />
              <button onClick={() => setEditing(null)}>Отмена</button>
              <button className="primary" onClick={saveObject} disabled={!editing.name.trim()}>Сохранить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
