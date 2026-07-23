import { useState, useEffect, useMemo, useCallback, useRef } from "react";

// ─── Данные: объекты из Fire_Safety_Compliance_Matrix.xlsx ───
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

// ─── Нормы по странам ───
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
  "China":      { basis: "消防法: ежемесячные внутренние проверки, назначение ответственного", briefing: 12, ptm: null, drills: 2, sys: { alarm: 1, ext: 1 } },
  "Israel":     { basis: "הוראות נציב כבאות", briefing: 12, ptm: null, drills: 1 },
  "Turkey":     { basis: "BYKHY: огнетушители ежегодно, tahliye planı", briefing: 12, ptm: null, drills: 1 },
  "Ghana":      { basis: "GNFS: Fire Certificate ежегодно", briefing: 12, ptm: null, drills: 1 },
  "Colombia":   { basis: "Resolución 0312/2019 (SG-SST): план эвакуации и бригада — на работодателе", briefing: 12, ptm: null, drills: 1 },
  "Netherlands":{ basis: "Bbl ст. 6.8: поэтажный план с путями эвакуации", briefing: 12, ptm: null, drills: 1 },
  "Switzerland":{ basis: "VKF BSV 2015 (BSV 2026 — с осени 2027)", briefing: 12, ptm: null, drills: 1 },
};
const normFor = (c) => NORMS[c] || NORMS.default;

const GROUP_INFO = {
  A: { label: "сертификат = условие лицензии" },
  B: { label: "сертификат привязан к зданию" },
  C: { label: "надзор без разрешения" },
  D: { label: "номинальное регулирование" },
};
const CONF_MARK = { "Проверено": "🟢", "Структура — общие знания": "🟡", "Публичного источника нет": "🔴" };

// ─── Регионы: порядок отображения + переопределение (СНГ выделен из ASIA) ───
const REGION_ORDER = ["CIS", "ASIA", "AFRICA", "MIDEAST", "EUROPE", "LATAM", "OTHER"];
const REGION_LABEL = {
  CIS: "СНГ и Кавказ", ASIA: "Азия", AFRICA: "Африка",
  MIDEAST: "Ближний Восток", EUROPE: "Европа", LATAM: "Латинская Америка", OTHER: "Прочее",
};
const REGION_OF = {
  Armenia: "CIS", Azerbaijan: "CIS", Georgia: "CIS", Kyrgyzstan: "CIS", Qazaqstan: "CIS", Uzbekistan: "CIS",
};
const regionFor = (o) => REGION_OF[o.country] || o.region || "OTHER";

// статусные цвета: критичный = фирменный красный
const ST = { critical: "#F0342C", warning: "#E8930C", ok: "#1FA35C", unknown: "#9A9CA0" };
const ST_LABEL = { critical: "критично", warning: "внимание", unknown: "нет данных", ok: "в порядке" };

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

// ─── Миграция объекта ───
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

// ─── Оценка состояния объекта ───
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
  <span title={title} aria-label={title} style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: ST[k], flex: "none" }} />
);

// сегментная полоса статусов
const SegBar = ({ counts, height = 8 }) => {
  const total = counts.critical + counts.warning + counts.unknown + counts.ok || 1;
  return (
    <div style={{ display: "flex", height, borderRadius: height / 2, overflow: "hidden", background: "#EEEEF0" }} aria-hidden="true">
      {["critical", "warning", "unknown", "ok"].map((k) =>
        counts[k] ? <div key={k} style={{ width: `${(counts[k] / total) * 100}%`, background: ST[k] }} /> : null
      )}
    </div>
  );
};

export default function App() {
  const [doc, setDoc] = useState(null);
  const [view, setView] = useState({ name: "dash" }); // dash | {name:'region', region} | {name:'country', region, country}
  const [filters, setFilters] = useState({ q: "", status: "all" });
  const [editing, setEditing] = useState(null);
  const [tab, setTab] = useState("passport");
  const [saveState, setSaveState] = useState("");
  const fileRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await store.get(KEY_V3);
        const d = JSON.parse(r.value);
        setDoc({ schema: SCHEMA, objects: d.objects.map(migrate), log: d.log || [] });
        return;
      } catch {}
      try {
        const r2 = await store.get(KEY_V2);
        const arr = JSON.parse(r2.value);
        setDoc({ schema: SCHEMA, objects: arr.map(migrate), log: [{ ts: today(), id: "*", action: "миграция данных v2 → v3" }] });
        return;
      } catch {}
      setDoc({ schema: SCHEMA, objects: DATA.map(migrate), log: [{ ts: today(), id: "*", action: "инициализация из матрицы" }] });
    })();
  }, []);

  const persist = useCallback(async (objects, logEntry) => {
    const next = {
      schema: SCHEMA, objects,
      log: logEntry ? [{ ts: today(), ...logEntry }, ...(doc?.log || [])].slice(0, 300) : doc?.log || [],
    };
    setDoc(next);
    try { await store.set(KEY_V3, JSON.stringify(next)); setSaveState("сохранено"); }
    catch { setSaveState("ошибка сохранения"); }
    setTimeout(() => setSaveState(""), 2500);
  }, [doc]);

  const enriched = useMemo(() => (doc?.objects || []).map((o) => ({ ...o, _a: assess(o) })), [doc]);

  // ─── Агрегации: регионы и страны ───
  const emptyCounts = () => ({ critical: 0, warning: 0, unknown: 0, ok: 0 });
  const regionStats = useMemo(() => {
    const m = new Map();
    enriched.forEach((o) => {
      const r = regionFor(o);
      if (!m.has(r)) m.set(r, { region: r, objects: [], counts: emptyCounts(), countries: new Set() });
      const c = m.get(r);
      c.objects.push(o); c.counts[o._a.overall]++; c.countries.add(o.country);
    });
    return REGION_ORDER.filter((r) => m.has(r)).map((r) => {
      const c = m.get(r);
      return { ...c, countries: c.countries.size, overall: worst(c.objects.map((o) => o._a.overall)) };
    });
  }, [enriched]);

  const countryStats = useMemo(() => {
    if (view.name !== "region") return [];
    const m = new Map();
    enriched.filter((o) => regionFor(o) === view.region).forEach((o) => {
      if (!m.has(o.country)) m.set(o.country, { country: o.country, objects: [], counts: emptyCounts(), groups: new Set() });
      const c = m.get(o.country);
      c.objects.push(o); c.counts[o._a.overall]++; c.groups.add(o.group);
    });
    return [...m.values()].map((c) => ({ ...c, overall: worst(c.objects.map((o) => o._a.overall)), groups: [...c.groups].sort() }))
      .sort((a, b) => {
        const r = { critical: 0, warning: 1, unknown: 2, ok: 3 };
        return r[a.overall] - r[b.overall] || b.objects.length - a.objects.length || a.country.localeCompare(b.country);
      });
  }, [enriched, view]);

  const globalKpi = useMemo(() => ({
    total: enriched.length,
    countries: new Set(enriched.map((o) => o.country)).size,
    critical: enriched.filter((o) => o._a.overall === "critical").length,
    warning: enriched.filter((o) => o._a.overall === "warning").length,
    ok: enriched.filter((o) => o._a.overall === "ok").length,
  }), [enriched]);

  const countryObjects = useMemo(() => {
    if (view.name !== "country") return [];
    return enriched.filter((o) => {
      if (o.country !== view.country) return false;
      if (filters.status !== "all" && o._a.overall !== filters.status) return false;
      const q = filters.q.trim().toLowerCase();
      if (q && !`${o.id} ${o.name} ${o.city} ${o.type} ${o.specRisks} ${o.responsible}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => {
      const r = { critical: 0, warning: 1, unknown: 2, ok: 3 };
      const p = { P1: 0, P2: 1, P3: 2, "P?": 3 };
      return r[a._a.overall] - r[b._a.overall] || p[a.priority] - p[b.priority];
    });
  }, [enriched, view, filters]);

  const openRegion = (r) => { setView({ name: "region", region: r }); window.scrollTo(0, 0); };
  const openCountry = (c) => { setView({ name: "country", region: view.region, country: c }); setFilters({ q: "", status: "all" }); window.scrollTo(0, 0); };
  const openEdit = (o) => { const { _a, ...rest } = o; setEditing(JSON.parse(JSON.stringify(rest))); setTab("passport"); };
  const setField = (k, v) => setEditing((e) => ({ ...e, [k]: v }));
  const setSys = (key, field, v) => setEditing((e) => ({ ...e, systems: { ...e.systems, [key]: { ...e.systems[key], [field]: v } } }));
  const setTrain = (k, v) => setEditing((e) => ({ ...e, training: { ...e.training, [k]: v } }));
  const addDrill = () => setEditing((e) => ({ ...e, drills: [...e.drills, { date: today(), note: "" }] }));
  const setDrill = (i, k, v) => setEditing((e) => ({ ...e, drills: e.drills.map((d, j) => (j === i ? { ...d, [k]: v } : d)) }));
  const rmDrill = (i) => setEditing((e) => ({ ...e, drills: e.drills.filter((_, j) => j !== i) }));

  const saveObject = () => {
    if (!editing.name.trim()) return;
    const stamped = { ...editing, updatedAt: today(), country: editing.country || (view.name === "country" ? view.country : "") };
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
    a.href = URL.createObjectURL(blob); a.download = `fire_safety_tracker_${today()}.json`; a.click();
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

  if (doc === null) return <div style={{ fontFamily: "system-ui", padding: 40, color: "#75767A" }}>Загрузка…</div>;
  const ea = editing ? assess(editing) : null;

  return (
    <div className="app">
      <style>{`
        :root {
          --red:#F0342C; --ink:#17181A; --mut:#75767A; --bg:#F7F7F8; --card:#FFFFFF;
          --line:#E7E7EA; --r:1.25rem; --rs:.75rem;
        }
        * { box-sizing:border-box; margin:0; }
        html { font-size:clamp(15px, .5vw + 12px, 17px); }
        .app { min-height:100vh; background:var(--bg); color:var(--ink);
          font-family:-apple-system,"Segoe UI","Helvetica Neue",Arial,sans-serif;
          font-size:.9rem; line-height:1.45; padding:0 0 4rem; }
        .wrap { max-width:76rem; margin:0 auto; padding:0 1.25rem; }

        /* ─ Шапка ─ */
        .top { background:var(--card); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:5; }
        .top-in { display:flex; align-items:center; gap:1rem; padding:.9rem 1.25rem; max-width:76rem; margin:0 auto; flex-wrap:wrap; }
        .brand { display:flex; align-items:center; gap:.6rem; cursor:pointer; user-select:none; }
        .mark { width:1.6rem; height:1.6rem; border-radius:.45rem; background:var(--red); flex:none;
          display:flex; align-items:center; justify-content:center; color:#fff; font-weight:900; font-style:italic; font-size:.95rem; }
        .brand h1 { font-size:1.15rem; font-weight:900; font-style:italic; letter-spacing:-.02em; text-transform:uppercase; }
        .crumb { color:var(--mut); font-weight:700; font-style:normal; text-transform:none; letter-spacing:0; }
        .save { font-size:.8rem; color:#1FA35C; margin-left:auto; }
        .top-actions { display:flex; gap:.5rem; }

        /* ─ Кнопки/поля ─ */
        button { font:inherit; cursor:pointer; border-radius:.7rem; border:1px solid var(--line); background:var(--card); padding:.5rem .9rem; font-weight:600; }
        button:hover { border-color:#c9c9ce; }
        .primary { background:var(--ink); color:#fff; border-color:var(--ink); }
        .primary:hover { background:#000; }
        .accent { background:var(--red); color:#fff; border-color:var(--red); }
        .danger { color:var(--red); border-color:var(--red); background:transparent; }
        .ghost { background:transparent; }
        input,select,textarea { font:inherit; color:inherit; background:var(--card); border:1px solid var(--line); border-radius:.7rem; padding:.5rem .8rem; }
        input:focus,select:focus,textarea:focus,button:focus-visible { outline:2px solid var(--red); outline-offset:1px; }
        .mono { font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; }

        /* ─ Дашборд ─ */
        .hero { padding:2.2rem 0 1.4rem; }
        .hero h2 { font-size:clamp(1.5rem, 3vw, 2.1rem); font-weight:900; letter-spacing:-.03em; line-height:1.1; }
        .hero h2 em { font-style:italic; color:var(--red); }
        .hero p { color:var(--mut); margin-top:.4rem; max-width:44rem; }
        .stats { display:flex; gap:2rem; flex-wrap:wrap; margin:1.4rem 0 .4rem; }
        .stat b { display:block; font-size:1.7rem; font-weight:900; letter-spacing:-.02em; }
        .stat span { font-size:.8rem; color:var(--mut); }
        .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(17rem,100%), 1fr)); gap:1rem; margin-top:1rem; }
        .ccard { background:var(--card); border:1px solid var(--line); border-radius:var(--r); padding:1.1rem 1.2rem 1.2rem;
          cursor:pointer; transition:transform .12s ease, box-shadow .12s ease; display:flex; flex-direction:column; gap:.7rem; }
        .ccard:hover { transform:translateY(-2px); box-shadow:0 .5rem 1.4rem rgba(23,24,26,.07); }
        .ccard:focus-visible { outline:2px solid var(--red); outline-offset:2px; }
        .ccard-top { display:flex; align-items:baseline; gap:.6rem; }
        .ccard h3 { font-size:1.05rem; font-weight:800; letter-spacing:-.01em; flex:1; min-width:0; }
        .count { color:var(--mut); font-weight:600; font-size:.85rem; white-space:nowrap; }
        .pill { font-size:.72rem; font-weight:800; padding:.15rem .55rem; border-radius:999px; color:#fff; text-transform:uppercase; letter-spacing:.04em; white-space:nowrap; }
        .ccard-meta { display:flex; justify-content:space-between; gap:.6rem; font-size:.78rem; color:var(--mut); flex-wrap:wrap; }
        .regions { grid-template-columns:repeat(auto-fill, minmax(min(20rem,100%), 1fr)); }
        .rcard { padding:1.3rem 1.4rem 1.35rem; }
        .rname { font-size:1.35rem; font-weight:900; font-style:italic; letter-spacing:-.02em; text-transform:uppercase; }
        .rsub { font-size:.8rem; color:var(--mut); }
        .objs { grid-template-columns:repeat(auto-fill, minmax(min(19rem,100%), 1fr)); }
        .ocard { gap:.55rem; }
        .odots { display:flex; gap:.9rem; flex-wrap:wrap; padding:.15rem 0; }
        .odots .mini i { font-size:.7rem; }
        .orisk { font-size:.78rem; color:#B4560E; }
        .crumb-link { cursor:pointer; }
        .crumb-link:hover { color:var(--ink); text-decoration:underline; }
        @media (prefers-reduced-motion:reduce){ .ccard { transition:none; } .ccard:hover { transform:none; } }

        /* ─ Страница страны ─ */
        .chead { padding:1.8rem 0 1rem; display:flex; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
        .chead h2 { font-size:clamp(1.4rem, 2.6vw, 1.9rem); font-weight:900; letter-spacing:-.03em; }
        .back { border-radius:999px; padding:.45rem .95rem; }
        .basis { background:var(--card); border:1px solid var(--line); border-radius:var(--rs); padding:.7rem 1rem; font-size:.82rem; color:var(--mut); margin-bottom:1rem; }
        .basis b { color:var(--ink); }
        .toolbar { display:flex; flex-wrap:wrap; gap:.6rem; margin-bottom:1rem; align-items:center; }
        .search { flex:1 1 14rem; min-width:11rem; }

        .rows { display:flex; flex-direction:column; gap:.6rem; }
        .row { display:grid; grid-template-columns:.4rem 1fr auto; background:var(--card); border:1px solid var(--line);
          border-radius:var(--rs); overflow:hidden; cursor:pointer; }
        .row:hover { border-color:#c9c9ce; }
        .row:focus-visible { outline:2px solid var(--red); outline-offset:2px; }
        .row-main { padding:.8rem 1rem; min-width:0; }
        .row-title { font-weight:700; display:flex; flex-wrap:wrap; gap:.55rem; align-items:center; }
        .tag { font-size:.72rem; font-weight:800; padding:.1rem .5rem; border-radius:.4rem; background:var(--ink); color:#fff; }
        .tag.p1 { background:var(--red); }
        .row-sub { font-size:.78rem; color:var(--mut); margin-top:.25rem; display:flex; flex-wrap:wrap; gap:.3rem .9rem; align-items:center; }
        .mini { display:inline-flex; gap:.28rem; align-items:center; }
        .mini i { font-style:normal; font-size:.66rem; color:var(--mut); }
        .row-side { padding:.8rem 1rem; text-align:right; display:flex; flex-direction:column; gap:.2rem; justify-content:center; }
        .chip { font-size:.8rem; font-weight:700; }
        .empty { padding:2.4rem; text-align:center; color:var(--mut); background:var(--card); border:1px dashed var(--line); border-radius:var(--r); }

        /* ─ Модалка ─ */
        .overlay { position:fixed; inset:0; background:rgba(23,24,26,.5); display:flex; justify-content:center; align-items:flex-start; padding:1.6rem .9rem; overflow:auto; z-index:10; }
        .modal { background:var(--card); border-radius:var(--r); padding:1.4rem; width:100%; max-width:48rem; }
        .modal h2 { font-size:1.05rem; font-weight:800; display:flex; gap:.55rem; align-items:center; flex-wrap:wrap; }
        .hint { font-size:.78rem; color:var(--mut); margin:.2rem 0 .7rem; }
        .mbasis { background:var(--bg); border-radius:var(--rs); padding:.6rem .9rem; font-size:.8rem; margin-bottom:.8rem; }
        .tabs { display:flex; gap:.15rem; border-bottom:1px solid var(--line); margin-bottom:1rem; flex-wrap:wrap; }
        .tab { border:none; background:transparent; padding:.55rem .8rem; border-radius:0; border-bottom:2px solid transparent; color:var(--mut); font-weight:700; font-size:.82rem; }
        .tab.on { color:var(--ink); border-bottom-color:var(--red); }
        .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:.7rem; }
        .grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:.7rem; }
        label { display:flex; flex-direction:column; gap:.25rem; font-size:.75rem; color:var(--mut); margin-bottom:.6rem; }
        label > input, label > select, label > textarea { color:var(--ink); }
        .sysrow { display:grid; grid-template-columns:minmax(9rem,1.4fr) 6.5rem 8.5rem 1fr; gap:.5rem; align-items:center;
          padding:.5rem 0; border-bottom:1px solid var(--line); font-size:.82rem; }
        .sysname b { display:block; }
        .sysname span { font-size:.7rem; color:var(--mut); }
        .stlabel { font-size:.78rem; font-weight:700; }
        .drill { display:grid; grid-template-columns:8.5rem 1fr auto; gap:.5rem; margin-bottom:.5rem; align-items:center; }
        .loglist { font-size:.82rem; display:flex; flex-direction:column; gap:.4rem; max-height:22rem; overflow:auto; }
        .logitem { border-bottom:1px solid var(--line); padding-bottom:.4rem; }
        .actions { display:flex; gap:.5rem; margin-top:.9rem; }
        .spacer { flex:1; }
        @media (max-width:40rem){ .grid2,.grid3 { grid-template-columns:1fr; } .row-side{display:none;}
          .sysrow { grid-template-columns:1fr 1fr; } .drill { grid-template-columns:1fr; } .top-actions { width:100%; } }
      `}</style>

      {/* ─── Шапка ─── */}
      <header className="top">
        <div className="top-in">
          <div className="brand" role="button" tabIndex={0} onClick={() => setView({ name: "dash" })}
            onKeyDown={(e) => e.key === "Enter" && setView({ name: "dash" })}>
            <span className="mark" aria-hidden="true">F</span>
            <h1>Fire Safety Tracker
              {view.name !== "dash" && view.region && (
                <span className="crumb"> / <span className="crumb-link" onClick={(e) => { e.stopPropagation(); openRegion(view.region); }}>{view.region}</span></span>
              )}
              {view.name === "country" && <span className="crumb"> / {view.country}</span>}
            </h1>
          </div>
          <span className="save" role="status">{saveState}</span>
          <div className="top-actions">
            <button className="ghost" onClick={exportJson}>Экспорт</button>
            <button className="ghost" onClick={() => fileRef.current?.click()}>Импорт</button>
            <input ref={fileRef} type="file" accept=".json" style={{ display: "none" }} onChange={importJson} />
          </div>
        </div>
      </header>

      {/* ─── Дашборд по странам ─── */}
      {view.name === "dash" && (
        <main className="wrap">
          <section className="hero">
            <h2>Состояние портфеля.<br /><em>{globalKpi.countries} стран, {globalKpi.total} объектов.</em></h2>
            <p>Статус страны — худший из статусов её объектов. Нажмите на страну, чтобы увидеть объекты и работать с карточками.</p>
            <div className="stats">
              <div className="stat"><b style={{ color: ST.critical }}>{globalKpi.critical}</b><span>критично</span></div>
              <div className="stat"><b style={{ color: ST.warning }}>{globalKpi.warning}</b><span>требуют внимания</span></div>
              <div className="stat"><b style={{ color: ST.ok }}>{globalKpi.ok}</b><span>в порядке</span></div>
            </div>
          </section>

          <div className="grid regions">
            {regionStats.map((r) => (
              <div key={r.region} className="ccard rcard" role="button" tabIndex={0}
                onClick={() => openRegion(r.region)} onKeyDown={(e) => e.key === "Enter" && openRegion(r.region)}>
                <div className="ccard-top">
                  <h3 className="rname">{r.region}</h3>
                  <span className="pill" style={{ background: ST[r.overall] }}>{ST_LABEL[r.overall]}</span>
                </div>
                <div className="rsub">{REGION_LABEL[r.region]} · {r.countries} стран · {r.objects.length} объектов</div>
                <SegBar counts={r.counts} height={10} />
                <div className="ccard-meta">
                  <span>
                    {r.counts.critical > 0 && `${r.counts.critical} критично · `}
                    {r.counts.warning > 0 && `${r.counts.warning} внимание · `}
                    {r.counts.ok} ок
                  </span>
                </div>
              </div>
            ))}
          </div>
        </main>
      )}

      {/* ─── Страница региона: страны ─── */}
      {view.name === "region" && (
        <main className="wrap">
          <div className="chead">
            <button className="back" onClick={() => setView({ name: "dash" })}>← Все регионы</button>
            <div style={{ flex: 1, minWidth: "12rem" }}>
              <h2>{view.region} <span style={{ color: "var(--mut)", fontWeight: 700 }}>· {REGION_LABEL[view.region]}</span></h2>
              <span style={{ color: "var(--mut)", fontSize: ".82rem" }}>{countryStats.length} стран</span>
            </div>
          </div>
          <div className="grid">
            {countryStats.map((c) => (
              <div key={c.country} className="ccard" role="button" tabIndex={0}
                onClick={() => openCountry(c.country)} onKeyDown={(e) => e.key === "Enter" && openCountry(c.country)}>
                <div className="ccard-top">
                  <h3>{c.country}</h3>
                  <span className="count">{c.objects.length} об.</span>
                  <span className="pill" style={{ background: ST[c.overall] }}>{ST_LABEL[c.overall]}</span>
                </div>
                <SegBar counts={c.counts} />
                <div className="ccard-meta">
                  <span>
                    {c.counts.critical > 0 && `${c.counts.critical} критично · `}
                    {c.counts.warning > 0 && `${c.counts.warning} внимание · `}
                    {c.counts.ok} ок
                  </span>
                  <span>группы {c.groups.join("·")}</span>
                </div>
              </div>
            ))}
          </div>
        </main>
      )}

      {/* ─── Страница страны ─── */}
      {view.name === "country" && (
        <main className="wrap">
          <div className="chead">
            <button className="back" onClick={() => openRegion(view.region)}>← {view.region}</button>
            <div style={{ flex: 1, minWidth: "12rem" }}>
              <h2>{view.country}</h2>
              <span style={{ color: "var(--mut)", fontSize: ".82rem" }}>{countryObjects.length} из {enriched.filter((o) => o.country === view.country).length} объектов</span>
            </div>
            <button className="accent" onClick={() => { setEditing(JSON.parse(JSON.stringify({ ...EMPTY, country: view.country }))); setTab("passport"); }}>+ Объект</button>
          </div>

          <div className="basis"><b>Нормативная база:</b> {normFor(view.country).basis}{normFor(view.country).basisNote ? ` · ${normFor(view.country).basisNote}` : ""}</div>

          <div className="toolbar">
            <input className="search" placeholder="Поиск по объектам страны" value={filters.q}
              onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} aria-label="Поиск" />
            <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} aria-label="Статус">
              <option value="all">Любой статус</option>
              <option value="critical">Критично</option><option value="warning">Внимание</option>
              <option value="unknown">Нет данных</option><option value="ok">В порядке</option>
            </select>
          </div>

          {countryObjects.length === 0 && <div className="empty">Объектов не найдено.</div>}
          <div className="grid objs">
            {countryObjects.map((o) => (
              <div key={o.id} className="ccard ocard" role="button" tabIndex={0}
                style={{ borderTop: `3px solid ${ST[o._a.overall]}` }}
                onClick={() => openEdit(o)} onKeyDown={(e) => e.key === "Enter" && openEdit(o)}>
                <div className="ccard-top">
                  <span className={`tag ${o.priority === "P1" ? "p1" : ""}`}>{o.priority}</span>
                  <h3 style={{ fontSize: ".95rem" }}>{o.name}</h3>
                  <span className="pill" style={{ background: ST[o._a.overall] }}>{ST_LABEL[o._a.overall]}</span>
                </div>
                <div className="rsub mono" style={{ marginTop: "-.3rem" }}>{o.id} · {o.city} · гр. {o.groupRaw || o.group}</div>
                <div className="odots">
                  <span className="mini"><Dot k={o._a.cert.key} title={o._a.cert.label} /><i>сертификат</i></span>
                  <span className="mini"><Dot k={o._a.sysKey} title="Системы ПБ" /><i>системы</i></span>
                  <span className="mini"><Dot k={o._a.trainKey} title="Обучение" /><i>обучение</i></span>
                  <span className="mini"><Dot k={o._a.drillStatus.key} title={o._a.drillStatus.label} /><i>эвакуация</i></span>
                </div>
                <div className="ccard-meta">
                  <span>{o.type}{isOperatorHeld(o) ? " · серт. у оператора" : ""}</span>
                  <span className="mono">{o.area ? `${o.area} м²` : "м²?"} · {o.occupancy ? `${o.occupancy} чел` : "чел?"}</span>
                </div>
                {o.specRisks && <div className="orisk">⚠ {o.specRisks}</div>}
                <div className="ccard-meta" style={{ marginTop: "auto" }}>
                  <span>{CONF_MARK[o.confidence] || ""} {o.responsible || "ответственный не назначен"}</span>
                  <span>{o.updatedAt ? `обновлён ${o.updatedAt}` : "не сверялся"}</span>
                </div>
              </div>
            ))}
          </div>
        </main>
      )}

      {/* ─── Карточка объекта ─── */}
      {editing && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="modal" role="dialog" aria-label="Карточка объекта">
            <h2>
              <span className="tag" style={{ background: ST[ea.overall] }}>{ST_LABEL[ea.overall]}</span>
              {editing.id ? `${editing.id} · ${editing.name || ""}` : "Новый объект"}
            </h2>
            <div className="hint">
              {editing.country} {editing.city && `· ${editing.city}`} · гр. {editing.groupRaw || editing.group}
              {editing.confidence && ` · ${CONF_MARK[editing.confidence] || ""} ${editing.confidence}`}
              {editing.updatedAt && ` · обновлён ${editing.updatedAt}`}
            </div>
            <div className="mbasis"><b>Нормы:</b> {ea.norm.basis}{ea.norm.basisNote ? ` · ${ea.norm.basisNote}` : ""}</div>

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
                <label>Группа<select value={editing.group} onChange={(e) => setField("group", e.target.value)}>{["A", "B", "C", "D"].map((g) => <option key={g} value={g}>{g} — {GROUP_INFO[g].label}</option>)}</select></label>
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
              <div className="hint">Интервал — из норм страны, иначе NFPA. «Дата проверки» = последнее ТО/испытание по акту.</div>
              {ea.sysRows.map((r) => (
                <div key={r.key} className="sysrow">
                  <div className="sysname"><b>{r.name}</b><span>{r.ref || `интервал ${r.interval} мес`}{r.ref && ` · ${r.interval} мес`}</span></div>
                  <select value={r.st.present} onChange={(e) => setSys(r.key, "present", e.target.value)} aria-label={`Наличие: ${r.name}`}>
                    <option value="unknown">?</option><option value="yes">есть</option>
                    <option value="no">нет</option><option value="na">не прим.</option>
                  </select>
                  <input type="date" className="mono" value={r.st.lastCheck} disabled={r.st.present !== "yes"}
                    onChange={(e) => setSys(r.key, "lastCheck", e.target.value)} aria-label={`Дата проверки: ${r.name}`} />
                  <span className="stlabel" style={{ color: ST[r.status.key] }}>{r.status.label}</span>
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
                  <span className="stlabel" style={{ color: ST[r.status.key] }}>{r.status.label}</span>
                </div>
              ))}
              <div style={{ margin: "1rem 0 .5rem", fontWeight: 700 }}>
                Тренировки по эвакуации — норма {ea.norm.drills}×/год ·{" "}
                <span className="stlabel" style={{ color: ST[ea.drillStatus.key] }}>{ea.drillStatus.label}</span>
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
              <div className="loglist" style={{ maxHeight: "26rem" }}>
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
