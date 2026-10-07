/* ===========================================================
   plandia.js — Plan del día + reparto automático de remitos

   1) Plan del día: lo que se va a llenar ese día, con el desglose
      exacto de m3 por elemento (ej. Pilar H08 = 1,24 m3), la cota de
      arranque y el hormigón MÍNIMO que pide cada elemento.
   2) Remitos del día: a última hora se cargan solo N° de remito,
      hormigón, m3 y horas, y la app los reparte entre los elementos
      del plan (partiendo un remito en varias líneas cuando cruza dos
      elementos). Lo que sobra es desperdicio.

   Reglas del reparto:
   - Un hormigón más fuerte puede cubrir un elemento más débil
     (C45 en un elemento C30), nunca al revés.
   - Se procesa de mayor a menor resistencia. Los remitos de cada
     resistencia llenan primero los elementos de esa misma resistencia
     (en el orden del plan) y lo que sobra pasa a los elementos más
     débiles que todavía falten.
   - Los remitos se toman por hora de descarga (o de llegada a obra).
   - Lo que no se pudo ubicar en ningún elemento queda como Desperdicio.
   - Antes de guardar hay una vista previa donde se puede corregir.
   =========================================================== */

const PLAN_ZONAS = { TORRE: "Torre", BASAMENTO: "Basamento" };
// Hormigón mínimo habitual por código de elemento (se puede cambiar en cada fila).
const PLAN_HORMIGON_POR_ELEMENTO = { P: "C45", L: "C35", VL: "C35", CT: "C30", VR: "C30", CP: "C30", TD: "C30" };
const PLAN_EPS = 0.0005;

const planR2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// "+12,68" / "12.68" / "1,24" -> número. Vacío o inválido -> null.
function planNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return isNaN(v) ? null : v;
  const t = String(v).trim().replace(/\s/g, "").replace(",", ".").replace(/^\+/, "");
  if (t === "") return null;
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

// "C45" -> 45. Lo que no tiene número (ej. MORTERO) -> null.
function planFuerza(codigo) {
  const m = /(\d+)/.exec(String(codigo || ""));
  return m ? parseInt(m[1], 10) : null;
}

function planNorm(t) {
  return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

// ---------------------------------------------------------------
//  Algoritmo de reparto (función pura, se puede probar sola)
//  plan:    [{ id, hormigon, m3 }]            en el orden del plan
//  remitos: [{ id, hormigon, m3, horaAObra, horaDescarga }]
//  Devuelve { reparto: { [remitoId]: [{ planId|null, m3, nota }] },
//             pendientes: [{ planId, falta }] , sinHormigon: [remitoId] }
// ---------------------------------------------------------------
function planRepartir(plan, remitos) {
  const items = plan.map((p) => ({ id: p.id, rest: planR2(p.m3), min: planFuerza(p.hormigon), horm: p.hormigon }));
  const rems = remitos.map((r, i) => ({ ...r, _i: i, f: planFuerza(r.hormigon) }));
  const reparto = {};
  const sinHormigon = [];
  const clave = (r) => r.horaDescarga || r.horaAObra || "99:99";
  const grados = [...new Set(rems.filter((r) => r.f !== null).map((r) => r.f))].sort((a, b) => b - a);

  grados.forEach((g) => {
    rems.filter((r) => r.f === g)
      .sort((a, b) => (clave(a) < clave(b) ? -1 : clave(a) > clave(b) ? 1 : a._i - b._i))
      .forEach((r) => {
        let v = planR2(r.m3);
        const segs = [];
        const tomar = (it) => {
          const t = planR2(Math.min(v, it.rest));
          if (t > PLAN_EPS) {
            segs.push({ planId: it.id, m3: t, nota: it.min !== null && it.min < g ? `${r.hormigon} en elemento ${it.horm}` : "" });
            it.rest = planR2(it.rest - t);
            v = planR2(v - t);
          }
        };
        items.filter((it) => it.min === g && it.rest > PLAN_EPS).forEach((it) => { if (v > PLAN_EPS) tomar(it); });
        if (v > PLAN_EPS) {
          items.filter((it) => it.min !== null && it.min < g && it.rest > PLAN_EPS)
            .sort((a, b) => b.min - a.min)
            .forEach((it) => { if (v > PLAN_EPS) tomar(it); });
        }
        if (v > PLAN_EPS) segs.push({ planId: null, m3: planR2(v), nota: "Sobrante" });
        reparto[r.id] = segs;
      });
  });
  rems.filter((r) => r.f === null).forEach((r) => { sinHormigon.push(r.id); reparto[r.id] = []; });
  const pendientes = items.filter((it) => it.rest > PLAN_EPS).map((it) => ({ planId: it.id, falta: it.rest }));
  return { reparto, pendientes, sinHormigon };
}

// ---------------------------------------------------------------
//  Datos
// ---------------------------------------------------------------
async function cargarPlanDia(obraId) {
  const filas = [];
  const PAGINA = 1000;
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await supabaseClient
      .from("plan_dia").select("*").eq("obra_id", obraId)
      .order("fecha", { ascending: true }).order("id", { ascending: true })
      .range(desde, desde + PAGINA - 1);
    if (error) {
      console.warn("[Plan del día] No se pudo leer la tabla:", error);
      state.planDiaDisponible = false;
      state.planDia = [];
      return;
    }
    filas.push(...(data || []));
    if (!data || data.length < PAGINA) break;
  }
  state.planDiaDisponible = true;
  state.planDia = filas.map(rowFromDb).map((r) => ({
    ...r,
    m3: Number(r.m3),
    cota: r.cota === null || r.cota === undefined ? null : Number(r.cota),
    largoCm: r.largoCm == null ? null : Number(r.largoCm),
    anchoCm: r.anchoCm == null ? null : Number(r.anchoCm),
    alturaCm: r.alturaCm == null ? null : Number(r.alturaCm),
    areaM2: r.areaM2 == null ? null : Number(r.areaM2),
    orden: Number(r.orden) || 0,
  }));
}

function planFilasDelDia() {
  return state.planDia.filter((r) => r.fecha === state.planFecha).sort((a, b) => a.orden - b.orden || (a.id < b.id ? -1 : 1));
}

function planHormigonesCatalogo() {
  return state.catalogo.hormigones
    .filter((h) => planFuerza(h.codigo) !== null)
    .sort((a, b) => planFuerza(a.codigo) - planFuerza(b.codigo));
}

function planElementosCatalogo() {
  return state.catalogo.elementos.filter((e) => (e.tipoElemento || "").toUpperCase() !== "DESPERDICIO");
}

function planElementoDesperdicio() {
  return state.catalogo.elementos.find((e) => (e.tipoElemento || "").toUpperCase() === "DESPERDICIO")
    || state.catalogo.elementos.find((e) => /desperdicio/i.test(e.nombre || ""));
}

function planNombreFila(r) {
  const e = byId(state.catalogo.elementos, r.elementoId);
  return `${e ? e.codigo : "?"} ${r.nomenclatura || ""}`.trim();
}

// ---------------------------------------------------------------
//  Pantalla: plan del día
// ---------------------------------------------------------------
const planUI = { editandoId: null, remitos: [], preview: null };

function planCargarSelects() {
  const hs = planHormigonesCatalogo();
  const optsH = hs.map((h) => el("option", { value: h.codigo }, h.codigo));
  const selH = $("#plan_hormigon");
  const actual = selH.value;
  selH.innerHTML = "";
  optsH.forEach((o) => selH.appendChild(o.cloneNode(true)));
  if (hs.some((h) => h.codigo === actual)) selH.value = actual;

  const selE = $("#plan_elemento");
  const actualE = selE.value;
  selE.innerHTML = "";
  selE.appendChild(el("option", { value: "" }, "Seleccionar..."));
  planElementosCatalogo().forEach((e) => selE.appendChild(el("option", { value: e.id }, `${e.codigo} — ${e.nombre}`)));
  if (planElementosCatalogo().some((e) => e.id === actualE)) selE.value = actualE;

  selectOptions($("#planProveedor"), state.catalogo.proveedores, (p) => p.nombre, {});
  const cuadTorre = state.catalogo.cuadrillas.filter((c) => c.grupo === "TORRE");
  const cuadBas = state.catalogo.cuadrillas.filter((c) => c.grupo === "BASAMENTO");
  const llenarCuad = (sel, lista, clave) => {
    const prev = sel.value;
    sel.innerHTML = "";
    sel.appendChild(el("option", { value: "" }, lista.length ? "Seleccionar..." : "(no hay cuadrillas con este grupo)"));
    lista.forEach((c) => sel.appendChild(el("option", { value: c.id }, c.nombre)));
    let guardada = "";
    try { guardada = localStorage.getItem(clave) || ""; } catch (e) { /* sin storage */ }
    if (lista.some((c) => c.id === prev)) sel.value = prev;
    else if (lista.some((c) => c.id === guardada)) sel.value = guardada;
    else if (lista.length === 1) sel.value = lista[0].id;
  };
  llenarCuad($("#planCuadTorre"), cuadTorre, "planCuadTorre");
  llenarCuad($("#planCuadBasamento"), cuadBas, "planCuadBasamento");
}

function planAplicarHormigonDefault() {
  const e = byId(state.catalogo.elementos, $("#plan_elemento").value);
  const sugerido = e ? PLAN_HORMIGON_POR_ELEMENTO[(e.codigo || "").toUpperCase()] : null;
  if (sugerido && planHormigonesCatalogo().some((h) => h.codigo === sugerido)) $("#plan_hormigon").value = sugerido;
}

// Misma lógica que el formulario de remitos: Largo×Ancho -> Área; Área×Altura -> m³
// (salvo que los m³ se hayan escrito a mano, o se editen filas ya cargadas).
function planCalcDims(origen) {
  const v = (id) => planNum($("#" + id).value);
  if (origen === "m3") { planUI.m3Manual = $("#plan_m3").value.trim() !== ""; return; }
  if (origen === "largo" || origen === "ancho") {
    const l = v("plan_largoCm"), a = v("plan_anchoCm");
    if (l > 0 && a > 0) $("#plan_areaM2").value = String(planR2((l / 100) * (a / 100))).replace(".", ",");
  }
  if (planUI.m3Manual) return;
  const area = v("plan_areaM2"), h = v("plan_alturaCm");
  if (area > 0 && h > 0) $("#plan_m3").value = String(planR2(area * (h / 100))).replace(".", ",");
}

function planResetForm() {
  planUI.editandoId = null;
  planUI.m3Manual = false;
  ["plan_largoCm", "plan_anchoCm", "plan_areaM2", "plan_alturaCm"].forEach((id) => { $("#" + id).value = ""; });
  const zona = $("#plan_zona").value;
  $("#plan_elemento").value = "";
  $("#plan_nomenclatura").value = "";
  $("#plan_cota").value = "";
  $("#plan_m3").value = "";
  $("#plan_bomba").checked = false;
  $("#plan_obs").value = "";
  $("#plan_zona").value = zona;
  $("#btnPlanAgregar").textContent = "+ Agregar al plan";
  $("#btnPlanCancelar").style.display = "none";
}

async function planGuardarFila() {
  if (!puedeAgregar()) return;
  const fecha = state.planFecha;
  if (!fecha) return toast("Elegí el día", "error");
  const elementoId = $("#plan_elemento").value;
  if (!elementoId) return toast("Falta el elemento", "error");
  const m3 = planNum($("#plan_m3").value);
  if (m3 === null || m3 <= 0) return toast("Faltan los m³", "error");
  const hormigon = $("#plan_hormigon").value;
  if (!hormigon) return toast("Falta el hormigón mínimo", "error");
  const filas = planFilasDelDia();
  const existente = planUI.editandoId ? byId(state.planDia, planUI.editandoId) : null;
  const fila = {
    id: planUI.editandoId || uid("plan"),
    obraId: state.obraId,
    fecha,
    orden: existente ? existente.orden : (filas.length ? Math.max(...filas.map((f) => f.orden)) + 1 : 1),
    zona: $("#plan_zona").value,
    elementoId,
    nomenclatura: $("#plan_nomenclatura").value.trim(),
    cota: planNum($("#plan_cota").value),
    largoCm: planNum($("#plan_largoCm").value),
    anchoCm: planNum($("#plan_anchoCm").value),
    areaM2: planNum($("#plan_areaM2").value),
    alturaCm: planNum($("#plan_alturaCm").value),
    m3: planR2(m3),
    hormigon,
    bombeado: $("#plan_bomba").checked,
    observaciones: $("#plan_obs").value.trim(),
    cargado: false,
  };
  try { await DB.put("planDia", fila); } catch (e) { return; }
  const idx = state.planDia.findIndex((r) => r.id === fila.id);
  if (idx >= 0) state.planDia[idx] = fila; else state.planDia.push(fila);
  planResetForm();
  renderPlanDia();
  toast(existente ? "Fila actualizada" : "Agregado al plan", "ok");
  $("#plan_nomenclatura").focus();
}

function planEditarFila(r) {
  planUI.editandoId = r.id;
  $("#plan_zona").value = r.zona;
  $("#plan_elemento").value = r.elementoId || "";
  $("#plan_nomenclatura").value = r.nomenclatura || "";
  $("#plan_cota").value = r.cota ?? "";
  $("#plan_m3").value = r.m3;
  planUI.m3Manual = true;
  $("#plan_largoCm").value = r.largoCm ?? "";
  $("#plan_anchoCm").value = r.anchoCm ?? "";
  $("#plan_areaM2").value = r.areaM2 ?? "";
  $("#plan_alturaCm").value = r.alturaCm ?? "";
  $("#plan_hormigon").value = r.hormigon;
  $("#plan_bomba").checked = !!r.bombeado;
  $("#plan_obs").value = r.observaciones || "";
  $("#btnPlanAgregar").textContent = "Actualizar fila";
  $("#btnPlanCancelar").style.display = "inline-block";
  $("#plan_nomenclatura").focus();
}

async function planBorrarFila(r) {
  if (!confirm(`¿Sacar "${planNombreFila(r)}" (${fmtM3(r.m3)} m³) del plan?`)) return;
  try { await DB.delete("planDia", r.id); } catch (e) { return; }
  state.planDia = state.planDia.filter((x) => x.id !== r.id);
  if (planUI.editandoId === r.id) planResetForm();
  renderPlanDia();
}

async function planMover(r, delta) {
  const filas = planFilasDelDia();
  const i = filas.findIndex((x) => x.id === r.id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= filas.length) return;
  const otra = filas[j];
  const a = { ...r, orden: otra.orden }, b = { ...otra, orden: r.orden };
  if (a.orden === b.orden) { a.orden = j + 1; b.orden = i + 1; }
  try { await DB.bulkPut("planDia", [a, b]); } catch (e) { return; }
  [a, b].forEach((n) => { const k = state.planDia.findIndex((x) => x.id === n.id); if (k >= 0) state.planDia[k] = n; });
  renderPlanDia();
}

async function planVaciarDia() {
  const filas = planFilasDelDia();
  if (filas.length === 0) return toast("El plan de este día ya está vacío");
  if (!confirm(`¿Vaciar el plan del ${fmtFechaCorta(state.planFecha)} (${filas.length} filas)? Los remitos ya cargados no se tocan.`)) return;
  for (const f of filas) { try { await DB.delete("planDia", f.id); } catch (e) { return; } }
  state.planDia = state.planDia.filter((r) => r.fecha !== state.planFecha);
  planUI.preview = null;
  renderPlanDia();
}

function renderPlanDia() {
  const root = $("#view-plan");
  if (!root) return;
  const aviso = $("#planAviso");
  if (state.planDiaDisponible === false) {
    aviso.style.display = "block";
    aviso.textContent = "Todavía falta crear la tabla del Plan del día en Supabase (script 16_plan_del_dia.sql). Hasta entonces esta pestaña no puede guardar.";
  } else aviso.style.display = "none";

  planCargarSelects();
  $("#planFecha").value = state.planFecha;
  const filas = planFilasDelDia();
  const tbody = $("#tablaPlan tbody");
  tbody.innerHTML = "";
  $("#planVacio").style.display = filas.length ? "none" : "block";
  $("#tablaPlanWrap").style.display = filas.length ? "block" : "none";
  filas.forEach((r, i) => {
    const tr = el("tr");
    tr.appendChild(el("td", {}, String(i + 1)));
    tr.appendChild(el("td", {}, PLAN_ZONAS[r.zona] || r.zona));
    const dimTxt = [r.largoCm, r.anchoCm, r.alturaCm].some((x) => x != null)
      ? [r.largoCm, r.anchoCm, r.alturaCm].map((x) => (x == null ? "?" : String(x).replace(".", ","))).join("×") + " cm"
      : (r.areaM2 != null ? `${String(r.areaM2).replace(".", ",")} m²` : "");
    tr.appendChild(el("td", {}, [planNombreFila(r), dimTxt ? el("div", { class: "hint" }, dimTxt) : null]));
    tr.appendChild(el("td", {}, r.cota === null || r.cota === undefined ? "-" : `${r.cota > 0 ? "+" : ""}${String(r.cota).replace(".", ",")}`));
    tr.appendChild(el("td", { style: "text-align:right" }, fmtM3(r.m3)));
    tr.appendChild(el("td", {}, r.hormigon));
    tr.appendChild(el("td", {}, r.bombeado ? "Bomba" : "-"));
    tr.appendChild(el("td", { style: "white-space:normal" }, r.observaciones || (r.cargado ? "✓ remitos cargados" : "")));
    const acc = el("td", { style: "white-space:nowrap" });
    [["↑", "Subir", () => planMover(r, -1)], ["↓", "Bajar", () => planMover(r, 1)], ["✎", "Editar", () => planEditarFila(r)], ["✕", "Sacar", () => planBorrarFila(r)]]
      .forEach(([t, title, fn]) => {
        const b = el("button", { type: "button", class: "ghost" + (t === "✕" ? " danger" : ""), title }, t);
        b.addEventListener("click", fn);
        acc.appendChild(b);
      });
    tr.appendChild(acc);
    tbody.appendChild(tr);
  });
  const porHorm = {};
  filas.forEach((r) => { porHorm[r.hormigon] = (porHorm[r.hormigon] || 0) + r.m3; });
  const total = filas.reduce((a, r) => a + r.m3, 0);
  $("#planResumen").textContent = filas.length
    ? `Total del plan: ${fmtM3(total)} m³ — ` + Object.keys(porHorm).sort((a, b) => planFuerza(b) - planFuerza(a)).map((h) => `${h}: ${fmtM3(porHorm[h])} m³`).join(" · ")
    : "";
  renderPlanRemitosForm();
  renderPlanPreview();
}

// ---------------------------------------------------------------
//  Importar / planilla modelo (Excel)
// ---------------------------------------------------------------
function planDescargarModelo() {
  const aoa = [
    ["Zona", "Elemento", "Nomenclatura", "Cota de arranque", "Largo (cm)", "Ancho (cm)", "Altura (cm)", "m3", "Hormigón mínimo", "Bomba", "Observaciones"],
    ["Torre", "P", "H08", "+12,68", 40, 100, 310, "", "C45", "Sí", ""],
    ["Torre", "P", "H09", "+12,68", "", "", "", 2.08, "C45", "Sí", ""],
    ["Torre", "VR", "R101", "+12,00", 20, 50, 400, "", "C30", "No", ""],
    ["Basamento", "L", "Losa sobre N1", "+9,30", "", "", "", 38.5, "C35", "Sí", ""],
  ];
  const ayuda = [
    ["Cómo completar"],
    ["Zona: Torre o Basamento."],
    ["Elemento: código del catálogo (P, L, VL, VR, CT, CP, TD, HL...) o su nombre."],
    ["Nomenclatura: como la usás hoy (H08, Losa N106 S1, etc.)."],
    ["Cota de arranque: con o sin signo, coma o punto (+12,68)."],
    ["Largo, Ancho y Altura (cm): opcionales. Si los cargás y dejás m3 vacío, m3 = Largo×Ancho×Altura (ej. 40×100×310 cm = 1,24 m3). Si cargás m3, queda ese valor."],
    ["m3: lo que realmente lleva ese elemento (exacto, sin redondear)."],
    ["Hormigón mínimo: C20, C25, C30, C35, C45... Si lo dejás vacío se usa el habitual: P=C45, L y VL=C35, CT, VR, CP y TD=C30. En los demás elementos (HL, pantallas, etc.) es obligatorio."],
    ["Bomba: Sí o No (opcional)."],
    ["El orden de las filas es el orden de llenado."],
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 11 }, { wch: 11 }, { wch: 22 }, { wch: 16 }, { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 8 }, { wch: 16 }, { wch: 8 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(wb, ws, "Plan");
  const wa = XLSX.utils.aoa_to_sheet(ayuda);
  wa["!cols"] = [{ wch: 110 }];
  XLSX.utils.book_append_sheet(wb, wa, "Instrucciones");
  XLSX.writeFile(wb, "Plan del dia - modelo.xlsx");
}

function planBuscarElemento(texto) {
  const t = planNorm(texto);
  if (!t) return null;
  const lista = planElementosCatalogo();
  return lista.find((e) => planNorm(e.codigo) === t)
    || lista.find((e) => planNorm(e.nombre) === t)
    || lista.find((e) => planNorm(e.nombre).startsWith(t) && t.length >= 3)
    || null;
}

// Convierte una matriz (filas del Excel) en filas del plan. Devuelve { filas, errores }.
function planLeerMatriz(matriz) {
  const norm = (c) => planNorm(c);
  let h = matriz.findIndex((fila) => fila.some((c) => norm(c) === "elemento"));
  if (h < 0) return { filas: [], errores: ['No encontré la columna "Elemento". Usá la planilla modelo.'] };
  const cab = matriz[h].map(norm);
  const col = (pred) => cab.findIndex(pred);
  const c = {
    zona: col((x) => x === "zona"),
    elemento: col((x) => x === "elemento"),
    nomen: col((x) => x.startsWith("nomenclatura")),
    cota: col((x) => x.startsWith("cota")),
    largo: col((x) => x.startsWith("largo")),
    ancho: col((x) => x.startsWith("ancho")),
    alto: col((x) => x.startsWith("altura")),
    area: col((x) => x.startsWith("area")),
    m3: col((x) => x === "m3" || x === "m³" || x.startsWith("m3")),
    horm: col((x) => x.startsWith("hormigon")),
    bomba: col((x) => x.startsWith("bomba")),
    obs: col((x) => x.startsWith("observ")),
  };
  if (c.m3 < 0 && (c.largo < 0 || c.ancho < 0 || c.alto < 0)) return { filas: [], errores: ['No encontré la columna "m3".'] };
  const filas = [], errores = [];
  const hormigones = planHormigonesCatalogo().map((x) => x.codigo);
  for (let i = h + 1; i < matriz.length; i++) {
    const f = matriz[i];
    if (!f || f.every((x) => String(x ?? "").trim() === "")) continue;
    const n = i + 1;
    const get = (k) => (c[k] >= 0 ? f[c[k]] : "");
    const el_ = planBuscarElemento(get("elemento"));
    if (!el_) { errores.push(`Fila ${n}: no reconozco el elemento "${get("elemento")}".`); continue; }
    const largoCm = planNum(get("largo")), anchoCm = planNum(get("ancho")), alturaCm = planNum(get("alto"));
    let areaM2 = planNum(get("area"));
    if (largoCm > 0 && anchoCm > 0) areaM2 = planR2((largoCm / 100) * (anchoCm / 100));
    let m3 = planNum(get("m3"));
    if ((m3 === null || m3 <= 0) && areaM2 > 0 && alturaCm > 0) m3 = planR2(areaM2 * (alturaCm / 100));
    if (m3 === null || m3 <= 0) { errores.push(`Fila ${n}: faltan los m³ (o Largo, Ancho y Altura).`); continue; }
    const z = planNorm(get("zona"));
    const zona = z.startsWith("torre") ? "TORRE" : z.startsWith("basam") ? "BASAMENTO" : null;
    if (!zona) { errores.push(`Fila ${n}: la zona tiene que ser Torre o Basamento.`); continue; }
    let horm = String(get("horm") || "").trim().toUpperCase();
    if (!horm) horm = PLAN_HORMIGON_POR_ELEMENTO[(el_.codigo || "").toUpperCase()] || "";
    if (!horm) { errores.push(`Fila ${n}: falta el hormigón mínimo de ${el_.codigo}.`); continue; }
    if (!hormigones.includes(horm)) { errores.push(`Fila ${n}: el hormigón "${horm}" no existe en Referencias.`); continue; }
    const b = planNorm(get("bomba"));
    filas.push({
      elementoId: el_.id,
      zona,
      nomenclatura: String(get("nomen") ?? "").trim(),
      cota: planNum(get("cota")),
      largoCm, anchoCm, alturaCm, areaM2,
      m3: planR2(m3),
      hormigon: horm,
      bombeado: b === "si" || b === "sí" || b === "s" || b === "x" || b === "1" || b === "bomba",
      observaciones: String(get("obs") ?? "").trim(),
    });
  }
  return { filas, errores };
}

async function planImportarArchivo(file) {
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const matriz = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
    const { filas, errores } = planLeerMatriz(matriz);
    if (errores.length) {
      toast(errores.slice(0, 3).join(" · ") + (errores.length > 3 ? ` (y ${errores.length - 3} más)` : ""), "error");
      if (filas.length === 0) return;
      if (!confirm(`Hay ${errores.length} fila(s) con problemas (se saltean). ¿Importar las ${filas.length} que están bien?`)) return;
    }
    if (filas.length === 0) return toast("No encontré filas para importar", "error");
    const existentes = planFilasDelDia();
    if (existentes.length && confirm(`El plan del ${fmtFechaCorta(state.planFecha)} ya tiene ${existentes.length} filas. ¿Reemplazarlas por las del archivo? (Cancelar = agregar al final)`)) {
      for (const f of existentes) await DB.delete("planDia", f.id);
      state.planDia = state.planDia.filter((r) => r.fecha !== state.planFecha);
    }
    const base = planFilasDelDia().length ? Math.max(...planFilasDelDia().map((f) => f.orden)) : 0;
    const nuevas = filas.map((f, i) => ({ ...f, id: uid("plan"), obraId: state.obraId, fecha: state.planFecha, orden: base + i + 1, cargado: false }));
    await DB.bulkPut("planDia", nuevas);
    state.planDia.push(...nuevas);
    renderPlanDia();
    toast(`Importadas ${nuevas.length} filas al plan`, "ok");
  } catch (e) {
    console.error(e);
    toast("No se pudo leer el archivo", "error");
  }
}

// ---------------------------------------------------------------
//  Remitos del día (carga rápida) y reparto
// ---------------------------------------------------------------
function planFilaRemitoVacia() {
  const hs = planHormigonesCatalogo();
  const ultimo = planUI.remitos[planUI.remitos.length - 1];
  return { nro: "", hormigon: ultimo ? ultimo.hormigon : (hs[hs.length - 1]?.codigo || ""), m3: "", horaAObra: "", horaDescarga: "" };
}

function renderPlanRemitosForm() {
  const tbody = $("#tablaPlanRemitos tbody");
  tbody.innerHTML = "";
  if (planUI.remitos.length === 0) planUI.remitos.push(planFilaRemitoVacia());
  const hs = planHormigonesCatalogo();
  planUI.remitos.forEach((r, i) => {
    const tr = el("tr");
    const inp = (campo, tipo, ancho, extra = {}) => {
      const e = el("input", { type: tipo, value: r[campo] ?? "", style: `width:${ancho}`, ...extra });
      e.addEventListener("input", () => { r[campo] = e.value; });
      return el("td", {}, e);
    };
    tr.appendChild(el("td", {}, String(i + 1)));
    tr.appendChild(inp("nro", "text", "110px", { placeholder: "N° remito" }));
    const sel = el("select", { style: "width:90px" }, hs.map((h) => el("option", { value: h.codigo }, h.codigo)));
    sel.value = r.hormigon;
    sel.addEventListener("change", () => { r.hormigon = sel.value; });
    tr.appendChild(el("td", {}, sel));
    tr.appendChild(inp("m3", "text", "70px", { placeholder: "m³", inputmode: "decimal" }));
    tr.appendChild(inp("horaAObra", "time", "110px"));
    tr.appendChild(inp("horaDescarga", "time", "110px"));
    const b = el("button", { type: "button", class: "ghost danger", title: "Quitar" }, "✕");
    b.addEventListener("click", () => { planUI.remitos.splice(i, 1); renderPlanRemitosForm(); });
    tr.appendChild(el("td", {}, b));
    tbody.appendChild(tr);
  });
  const filas = planUI.remitos.filter((r) => planNum(r.m3));
  const total = filas.reduce((a, r) => a + planNum(r.m3), 0);
  $("#planRemitosTotal").textContent = filas.length ? `${filas.length} remito(s) — ${fmtM3(total)} m³` : "";
}

// Pega filas copiadas de Excel: N° remito, hormigón, m3, hora a obra, hora descarga.
function planPegarRemitos() {
  const txt = $("#planPegado").value;
  const filas = txt.split(/\r?\n/).map((l) => l.split(/\t|;/)).filter((f) => f.some((x) => x.trim() !== ""));
  if (filas.length === 0) return toast("Pegá primero las filas copiadas de Excel", "error");
  const hs = planHormigonesCatalogo().map((h) => h.codigo);
  const nuevos = [];
  const errores = [];
  filas.forEach((f, i) => {
    const horm = (f[1] || "").trim().toUpperCase();
    const m3 = planNum(f[2]);
    if (!hs.includes(horm)) return errores.push(`Fila ${i + 1}: hormigón "${f[1] || ""}" no válido`);
    if (m3 === null || m3 <= 0) return errores.push(`Fila ${i + 1}: faltan los m³`);
    const hora = (v) => { const m = /^(\d{1,2})[:.](\d{2})/.exec((v || "").trim()); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : ""; };
    nuevos.push({ nro: (f[0] || "").trim(), hormigon: horm, m3: String(m3), horaAObra: hora(f[3]), horaDescarga: hora(f[4]) });
  });
  if (errores.length) toast(errores.slice(0, 3).join(" · "), "error");
  if (nuevos.length === 0) return;
  planUI.remitos = planUI.remitos.filter((r) => r.nro || r.m3).concat(nuevos);
  $("#planPegado").value = "";
  renderPlanRemitosForm();
  toast(`Se agregaron ${nuevos.length} remitos`, "ok");
}

function planCalcular() {
  if (!puedeAgregar()) return;
  const plan = planFilasDelDia();
  if (plan.length === 0) return toast("Primero cargá el plan del día", "error");
  const remitos = planUI.remitos.filter((r) => r.nro || r.m3);
  if (remitos.length === 0) return toast("Cargá los remitos del día", "error");
  const errores = [];
  const vistos = new Set();
  const lista = remitos.map((r, i) => {
    const nro = (r.nro || "").trim();
    if (!nro) errores.push(`Remito ${i + 1}: falta el N°`);
    else if (vistos.has(nro.toLowerCase())) errores.push(`El remito ${nro} está repetido en la lista`);
    vistos.add(nro.toLowerCase());
    const m3 = planNum(r.m3);
    if (m3 === null || m3 <= 0) errores.push(`Remito ${nro || i + 1}: faltan los m³`);
    return { id: `pr${i}`, nro, hormigon: r.hormigon, m3: planR2(m3 || 0), horaAObra: r.horaAObra, horaDescarga: r.horaDescarga };
  });
  if (!planElementoDesperdicio()) errores.push('No hay un elemento "Desperdicio" en Referencias → Elementos');
  if (errores.length) return toast(errores.slice(0, 3).join(" · "), "error");

  const { reparto, pendientes, sinHormigon } = planRepartir(plan.map((p) => ({ id: p.id, hormigon: p.hormigon, m3: p.m3 })), lista);
  const ordenar = (a, b) => ((a.horaDescarga || a.horaAObra || "99:99") < (b.horaDescarga || b.horaAObra || "99:99") ? -1 : 1);
  planUI.preview = {
    fecha: state.planFecha,
    remitos: lista.slice().sort(ordenar).map((r) => ({ ...r, lineas: (reparto[r.id] || []).map((s) => ({ ...s })) })),
    pendientesInicial: pendientes,
    sinHormigon,
  };
  renderPlanPreview();
  $("#planPreviewPanel").scrollIntoView({ behavior: "smooth" });
}

function planOpcionesElemento(sel, valor) {
  sel.innerHTML = "";
  planFilasDelDia().forEach((p) => sel.appendChild(el("option", { value: p.id }, `${PLAN_ZONAS[p.zona] || ""} · ${planNombreFila(p)} (${p.hormigon})`)));
  sel.appendChild(el("option", { value: "" }, "Desperdicio"));
  sel.value = valor === null || valor === undefined ? "" : valor;
}

function planResumenAsignado() {
  const pv = planUI.preview;
  const asignado = {};
  pv.remitos.forEach((r) => r.lineas.forEach((l) => { asignado[l.planId || ""] = planR2((asignado[l.planId || ""] || 0) + planNum(l.m3)); }));
  return asignado;
}

function renderPlanPreview() {
  const panel = $("#planPreviewPanel");
  const pv = planUI.preview;
  if (!pv || pv.fecha !== state.planFecha) { panel.style.display = "none"; return; }
  panel.style.display = "block";
  const cont = $("#planPreviewRemitos");
  cont.innerHTML = "";
  let todoOk = true;
  pv.remitos.forEach((r, ri) => {
    const suma = planR2(r.lineas.reduce((a, l) => a + (planNum(l.m3) || 0), 0));
    const ok = Math.abs(suma - r.m3) < 0.001;
    if (!ok) todoOk = false;
    const caja = el("div", { class: "plan-remito" + (ok ? "" : " plan-remito-mal") });
    caja.appendChild(el("div", { class: "plan-remito-cab" }, [
      el("b", {}, `Remito ${r.nro}`),
      ` · ${r.hormigon} · ${fmtM3(r.m3)} m³` + (r.horaDescarga || r.horaAObra ? ` · ${r.horaDescarga || r.horaAObra} hs` : ""),
      el("span", { style: "margin-left:auto;font-weight:600;color:" + (ok ? "#2f6b49" : "#b3413a") }, ok ? "✓ suma bien" : `Suma ${fmtM3(suma)} de ${fmtM3(r.m3)}`),
    ]));
    r.lineas.forEach((l, li) => {
      const fila = el("div", { class: "plan-linea" });
      const sel = el("select", {});
      planOpcionesElemento(sel, l.planId);
      sel.addEventListener("change", () => { l.planId = sel.value || null; l.nota = l.planId ? l.nota : "Sobrante"; renderPlanPreview(); });
      const m3 = el("input", { type: "text", value: String(l.m3).replace(".", ","), inputmode: "decimal", style: "width:80px;text-align:right" });
      m3.addEventListener("change", () => { l.m3 = planNum(m3.value) ?? 0; renderPlanPreview(); });
      const quitar = el("button", { type: "button", class: "ghost danger", title: "Quitar línea" }, "✕");
      quitar.addEventListener("click", () => { r.lineas.splice(li, 1); renderPlanPreview(); });
      fila.appendChild(sel);
      fila.appendChild(m3);
      fila.appendChild(el("span", { class: "hint", style: "margin:0" }, "m³" + (l.nota ? ` — ${l.nota}` : "")));
      fila.appendChild(quitar);
      caja.appendChild(fila);
    });
    const masLinea = el("button", { type: "button", class: "ghost" }, "+ línea");
    masLinea.addEventListener("click", () => {
      const falta = planR2(r.m3 - suma);
      r.lineas.push({ planId: null, m3: falta > 0 ? falta : 0, nota: "Sobrante" });
      renderPlanPreview();
    });
    caja.appendChild(masLinea);
    cont.appendChild(caja);
  });

  // Resumen por elemento: plan vs. asignado
  const asig = planResumenAsignado();
  const filasPlan = planFilasDelDia();
  const resumen = el("table", { class: "plan-resumen" });
  resumen.appendChild(el("thead", {}, el("tr", {}, ["Elemento", "Plan (m³)", "Asignado (m³)", ""].map((t) => el("th", {}, t)))));
  const tb = el("tbody");
  let hayFalta = false;
  filasPlan.forEach((p) => {
    const a = asig[p.id] || 0;
    const dif = planR2(p.m3 - a);
    const estado = Math.abs(dif) < 0.005 ? "✓" : dif > 0 ? `Faltan ${fmtM3(dif)} m³` : `+${fmtM3(-dif)} m³ de más`;
    if (dif > 0.005) hayFalta = true;
    tb.appendChild(el("tr", {}, [
      el("td", {}, `${PLAN_ZONAS[p.zona] || ""} · ${planNombreFila(p)}`),
      el("td", { style: "text-align:right" }, fmtM3(p.m3)),
      el("td", { style: "text-align:right" }, fmtM3(a)),
      el("td", { style: dif > 0.005 ? "color:#b3413a;font-weight:600" : "" }, estado),
    ]));
  });
  const desp = asig[""] || 0;
  tb.appendChild(el("tr", {}, [el("td", {}, "Desperdicio (sobrante)"), el("td", {}, ""), el("td", { style: "text-align:right" }, fmtM3(desp)), el("td", {}, "")]));
  resumen.appendChild(tb);
  const cuerpoRes = $("#planPreviewResumen");
  cuerpoRes.innerHTML = "";
  cuerpoRes.appendChild(resumen);
  if (hayFalta) cuerpoRes.appendChild(el("p", { class: "hint", style: "color:#b3413a" }, "Hay elementos que no llegaron a completar su plan. Si es por falta de hormigón, está bien; si no, corregí las líneas de arriba."));
  $("#btnPlanGuardar").disabled = !todoOk;
  $("#planPreviewEstado").textContent = todoOk ? "" : "Corregí los remitos marcados en rojo para poder guardar.";
}

function planDuplicadoExistente(nro, proveedorId) {
  return remitoNroDuplicado(nro, proveedorId, null);
}

async function planGuardarRemitos() {
  if (!puedeAgregar()) return;
  const pv = planUI.preview;
  if (!pv) return;
  const proveedorId = $("#planProveedor").value;
  if (!proveedorId) return toast("Elegí el proveedor", "error");
  const desp = planElementoDesperdicio();
  if (!desp) return toast('Falta el elemento "Desperdicio" en Referencias', "error");
  const plan = planFilasDelDia();
  const cuad = { TORRE: $("#planCuadTorre").value, BASAMENTO: $("#planCuadBasamento").value };
  const zonasUsadas = new Set();
  pv.remitos.forEach((r) => r.lineas.forEach((l) => { const p = plan.find((x) => x.id === l.planId); if (p) zonasUsadas.add(p.zona); }));
  for (const z of zonasUsadas) if (!cuad[z]) return toast(`Elegí la cuadrilla de ${PLAN_ZONAS[z]}`, "error");
  try {
    localStorage.setItem("planCuadTorre", cuad.TORRE || "");
    localStorage.setItem("planCuadBasamento", cuad.BASAMENTO || "");
  } catch (e) { /* sin storage */ }

  const duplicados = pv.remitos.filter((r) => planDuplicadoExistente(r.nro, proveedorId)).map((r) => r.nro);
  if (duplicados.length) return toast(`Ya existen remitos con N° ${duplicados.slice(0, 5).join(", ")} para este proveedor`, "error");

  const remitosDb = [], lineasDb = [];
  for (const r of pv.remitos) {
    const horm = state.catalogo.hormigones.find((h) => h.codigo === r.hormigon);
    if (!horm) return toast(`No encuentro el hormigón ${r.hormigon} en Referencias`, "error");
    const remitoId = uid("rem");
    remitosDb.push({
      id: remitoId, obraId: state.obraId, fecha: pv.fecha, proveedorId, hormigonId: horm.id,
      remitoNro: r.nro, m3Remito: r.m3, unidadMovil: "", horaAObra: r.horaAObra || "", horaEnObra: "",
      horaDescarga: r.horaDescarga || "", horaFinDescarga: "", probeta1: null, probeta2: null, probeta3: null,
    });
    r.lineas.filter((l) => (planNum(l.m3) || 0) > 0).forEach((l) => {
      const p = plan.find((x) => x.id === l.planId);
      lineasDb.push({
        id: uid("lin"), remitoId, obraId: state.obraId,
        elementoId: p ? p.elementoId : desp.id,
        nomenclatura: p ? p.nomenclatura : "",
        sector: "", asentamiento: null,
        nivelFondo: p && p.cota !== null && p.cota !== undefined ? p.cota : null,
        largoCm: p ? p.largoCm ?? null : null, anchoCm: p ? p.anchoCm ?? null : null,
        alturaCm: p ? p.alturaCm ?? null : null, areaM2: p ? p.areaM2 ?? null : null,
        volumen: planR2(planNum(l.m3)),
        cuadrillaId: p ? cuad[p.zona] : null,
        bombeado: p ? !!p.bombeado : false,
        colocacionId: null,
        observaciones: ["Plan del día", l.nota, p && p.observaciones].filter(Boolean).join(" · "),
        modificado: false,
      });
    });
  }
  try {
    await DB.bulkPut("remitos", remitosDb);
    await DB.bulkPut("remitoLineas", lineasDb);
    const usadas = new Set();
    pv.remitos.forEach((r) => r.lineas.forEach((l) => { if (l.planId) usadas.add(l.planId); }));
    const marcadas = plan.filter((p) => usadas.has(p.id)).map((p) => ({ ...p, cargado: true }));
    if (marcadas.length) await DB.bulkPut("planDia", marcadas);
  } catch (e) { return; }
  planUI.preview = null;
  planUI.remitos = [];
  await loadObraData(state.obraId);
  renderRemitosTable();
  renderTarjetaDiaria();
  renderResumenMensual();
  renderProbetas();
  renderPlanDia();
  toast(`Se cargaron ${remitosDb.length} remitos con ${lineasDb.length} líneas`, "ok");
}

// ---------------------------------------------------------------
//  Eventos
// ---------------------------------------------------------------
function bindPlanDiaHandlers() {
  if (!$("#view-plan")) return;
  state.planFecha = todayISO();
  $("#planFecha").value = state.planFecha;
  $("#planFecha").addEventListener("change", (e) => { state.planFecha = e.target.value || todayISO(); planUI.preview = null; planResetForm(); renderPlanDia(); });
  $("#plan_elemento").addEventListener("change", planAplicarHormigonDefault);
  $("#plan_largoCm").addEventListener("input", () => planCalcDims("largo"));
  $("#plan_anchoCm").addEventListener("input", () => planCalcDims("ancho"));
  $("#plan_areaM2").addEventListener("input", () => planCalcDims("area"));
  $("#plan_alturaCm").addEventListener("input", () => planCalcDims("alto"));
  $("#plan_m3").addEventListener("input", () => planCalcDims("m3"));
  $("#btnPlanAgregar").addEventListener("click", planGuardarFila);
  $("#btnPlanCancelar").addEventListener("click", planResetForm);
  $("#btnPlanImportar").addEventListener("click", () => $("#planArchivo").click());
  $("#planArchivo").addEventListener("change", (e) => { planImportarArchivo(e.target.files[0]); e.target.value = ""; });
  $("#btnPlanModelo").addEventListener("click", planDescargarModelo);
  $("#btnPlanVaciar").addEventListener("click", planVaciarDia);
  $("#btnPlanMasRemito").addEventListener("click", () => { planUI.remitos.push(planFilaRemitoVacia()); renderPlanRemitosForm(); });
  $("#btnPlanPegar").addEventListener("click", planPegarRemitos);
  $("#btnPlanCalcular").addEventListener("click", planCalcular);
  $("#btnPlanGuardar").addEventListener("click", planGuardarRemitos);
  $("#btnPlanDescartar").addEventListener("click", () => { planUI.preview = null; renderPlanPreview(); });
  ["plan_nomenclatura", "plan_cota", "plan_m3", "plan_obs"].forEach((id) =>
    $("#" + id).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); planGuardarFila(); } }));
  renderPlanDia();
}
