/* ===========================================================
   planta.js — Plano interactivo de la planta tipo (Plan del día)

   Se toca un elemento del plano (pilar, pantalla o sector de losa) y
   se agrega al plan del día, con sus m3, dimensiones y la cota del
   nivel elegido. Volver a tocarlo lo saca del plan.

   Datos tomados de los PDF de la planta tipo de la Torre (Summit).
   Para sumar niveles: agregar una línea a PLANTA_NIVELES.
   Las coordenadas de cada figura (poly) están en píxeles de un
   dibujo a 110 dpi; el SVG de fondo es planta-tipo.svg.
   =========================================================== */

// Niveles de la torre: nivel, NCI (cota, m) y piso.
const PLANTA_NIVELES = [
  { nivel: 102, nci: 9.60, piso: 2 },
  { nivel: 103, nci: 12.48, piso: 3 },
  { nivel: 104, nci: 15.36, piso: 4 },
  { nivel: 105, nci: 18.24, piso: 5 },
  { nivel: 106, nci: 21.12, piso: 6 },
  { nivel: 107, nci: 24.00, piso: 7 },
  { nivel: 108, nci: 26.88, piso: 8 },
];

// Hormigón mínimo sugerido por tipo (se puede cambiar después en la tabla del plan).
const PLANTA_HORMIGON = { P: "C45", PA: "C45", L: "C35", E: "C35" };
const PLANTA_COD_ELEMENTO = { P: "P", PA: "PA", L: "L", E: "E" };
const PLANTA_ESCALA = 72 / 110; // px a 110 dpi -> unidades del SVG (puntos)

const PLANTA_DATA = {"E":[{"id":"p_C-08","codigo":"C08","tipo":"P","desc":"0,22 x 3,50 (con retorno)","m3":3.138,"poly":[[321,82],[312,86],[312,110],[304,116],[304,187],[310,192],[320,187],[320,127],[328,121],[328,87]],"alturaCm":270},{"id":"p_C-07","codigo":"C07","tipo":"P","desc":"0,22 x 3,50","m3":2.079,"poly":[[434,110],[428,116],[428,188],[438,193],[445,188],[445,116]],"alturaCm":270,"largoCm":350,"anchoCm":22},{"id":"p_C-06","codigo":"C06","tipo":"P","desc":"0,22 x 3,50","m3":2.079,"poly":[[559,110],[552,116],[552,188],[562,193],[570,188],[570,116]],"alturaCm":270,"largoCm":350,"anchoCm":22},{"id":"p_C-05","codigo":"C05","tipo":"P","desc":"0,22 x 3,50 (con retorno)","m3":3.138,"poly":[[676,82],[668,87],[668,121],[676,127],[676,187],[686,192],[693,187],[693,116],[686,110],[685,86]],"alturaCm":270},{"id":"p_C-04","codigo":"C04","tipo":"P","desc":"1,50 x 0,25","m3":1.0935,"poly":[[770,157],[764,162],[764,194],[774,200],[782,194],[782,162]],"alturaCm":270},{"id":"p_D-04A","codigo":"D04A","tipo":"P","desc":"0,25 x 1,80","m3":1.215,"poly":[[732,266],[733,273],[740,277],[774,277],[780,272],[780,264],[774,260],[740,260]],"alturaCm":270,"largoCm":180,"anchoCm":25},{"id":"p_C-09","codigo":"C09","tipo":"P","desc":"1,50 x 0,27","m3":1.0935,"poly":[[154,164],[146,170],[146,200],[156,206],[164,200],[164,170]],"alturaCm":270,"largoCm":150,"anchoCm":27},{"id":"p_D-09","codigo":"D09","tipo":"P","desc":"0,22 x 3,50 (con retorno)","m3":3.138,"poly":[[90,320],[96,326],[127,326],[134,318],[193,318],[200,314],[200,307],[193,302],[126,302],[118,310],[92,311]],"alturaCm":270},{"id":"p_E-05","codigo":"E05","tipo":"P","desc":"0,22 x 2,00","m3":1.188,"poly":[[684,384],[676,390],[676,431],[686,436],[693,431],[693,390]],"alturaCm":270,"largoCm":200,"anchoCm":22},{"id":"p_E-06","codigo":"E06","tipo":"P","desc":"0,22 x 2,00","m3":1.188,"poly":[[559,384],[552,390],[552,432],[562,437],[570,432],[570,390]],"alturaCm":270,"largoCm":200,"anchoCm":22},{"id":"p_E-09","codigo":"E09","tipo":"P","desc":"0,22 x 3,50","m3":2.079,"poly":[[118,425],[118,433],[125,437],[194,437],[200,432],[200,424],[194,420],[125,420]],"alturaCm":270,"largoCm":350,"anchoCm":22},{"id":"p_F-07","codigo":"F07","tipo":"P","desc":"0,22 x 2,00","m3":1.188,"poly":[[392,550],[392,558],[399,562],[438,562],[444,556],[444,548],[438,544],[399,544]],"alturaCm":270,"largoCm":200,"anchoCm":22},{"id":"p_F-09","codigo":"F09","tipo":"P","desc":"0,22 x 3,50","m3":2.079,"poly":[[118,550],[118,558],[125,562],[194,562],[200,556],[200,548],[194,544],[125,544]],"alturaCm":270,"largoCm":350,"anchoCm":22},{"id":"p_G-07","codigo":"G07","tipo":"P","desc":"0,22 x 2,00","m3":1.188,"poly":[[392,674],[392,682],[399,686],[437,686],[444,680],[444,673],[437,669],[399,669]],"alturaCm":270,"largoCm":200,"anchoCm":22},{"id":"p_G-08","codigo":"G08","tipo":"P","desc":"0,25 x 1,80","m3":1.215,"poly":[[275,725],[268,730],[268,768],[278,773],[285,768],[285,730]],"alturaCm":270,"largoCm":180,"anchoCm":25},{"id":"p_G-09","codigo":"G09","tipo":"P","desc":"0,22 x 3,50 (con retorno)","m3":3.138,"poly":[[90,666],[92,676],[118,678],[126,686],[193,686],[200,680],[200,673],[193,669],[134,669],[127,661],[96,661]],"alturaCm":270},{"id":"p_H-09","codigo":"H09","tipo":"P","desc":"0,25 x 1,50","m3":1.0125,"poly":[[164,761],[165,770],[172,774],[200,774],[208,768],[207,760],[200,756],[172,756]],"alturaCm":270,"largoCm":150,"anchoCm":25},{"id":"p_C-09A","codigo":"C09A","tipo":"P","desc":"Ø 0,50","m3":0.53,"poly":[[173,126],[170,134],[162,137],[154,134],[151,126],[154,118],[162,115],[170,118]],"diamCm":50,"alturaCm":270},{"id":"pa_T01 asc. sup. izq.","codigo":"T01 asc. sup. izq.","tipo":"PA","desc":"Tipo 01 e=0,25","m3":5.805,"poly":[[309,300],[352,300],[352,390],[309,390]],"alturaCm":270},{"id":"pa_T02 asc. sup. der.","codigo":"T02 asc. sup. der.","tipo":"PA","desc":"Tipo 02 e=0,25","m3":5.805,"poly":[[596,301],[687,301],[687,345],[596,345]],"alturaCm":270},{"id":"pa_T02 asc. inf. izq.","codigo":"T02 asc. inf. izq.","tipo":"PA","desc":"Tipo 02 e=0,25","m3":5.805,"poly":[[309,589],[352,589],[352,680],[309,680]],"alturaCm":270},{"id":"pa_T04 fachada der.","codigo":"T04 fachada der.","tipo":"PA","desc":"Tipo 04 e=0,20","m3":4.09,"poly":[[845,294],[838,294],[834,298],[834,421],[790,426],[774,422],[770,426],[770,438],[774,444],[842,437],[849,433],[850,298]],"alturaCm":270},{"id":"pa_T05 fachada inf.","codigo":"T05 fachada inf.","tipo":"PA","desc":"Tipo 05 e=0,20","m3":4.09,"poly":[[451,766],[444,762],[429,766],[429,774],[434,780],[428,826],[307,826],[300,830],[300,838],[307,842],[440,841],[445,834]],"alturaCm":270},{"id":"pa_esc","codigo":"T01 escalera nucleo","tipo":"PA","desc":"Tipo 01 e=0,25 (núcleo grande, 1ª etapa)","m3":10.84,"poly":[[440,296],[374,296],[370,298],[370,304],[374,306],[430,307],[430,422],[308,422],[304,426],[306,434],[442,432]],"alturaCm":270},{"id":"e_esc","codigo":"Escalera","tipo":"E","desc":"Tramos de escalera","m3":1.79,"poly":[[376,312],[427,312],[427,375],[376,375]]},{"id":"pa_esct","codigo":"T01 escalera pata","tipo":"PA","desc":"Tipo 01 e=0,25 (pata del medio, 2ª etapa)","m3":1.72,"poly":[[377,374],[378,382],[384,386],[433,386],[440,380],[440,372],[433,368],[384,368]],"alturaCm":270}],"SL":[{"id":"l_s1","codigo":"Sector 1","tipo":"L","desc":"Losa","m3":51.79,"poly":[[101,492],[101,663],[105,667],[129,667],[130,675],[146,675],[148,782],[159,793],[173,797],[271,797],[275,763],[311,763],[313,832],[430,832],[435,829],[439,778],[434,773],[434,615],[456,615],[459,610],[470,494],[467,491]]},{"id":"l_s2","codigo":"Sector 2","tipo":"L","desc":"Losa","m3":70.87,"poly":[[494,91],[326,91],[325,118],[316,119],[316,128],[273,128],[269,95],[161,95],[138,104],[128,117],[127,250],[132,264],[129,320],[104,320],[103,489],[470,489],[473,467],[494,464],[496,456]]},{"id":"l_s3","codigo":"Sector 3","tipo":"L","desc":"Losa","m3":45.28,"poly":[[504,91],[499,98],[499,462],[622,450],[623,425],[781,425],[782,431],[838,424],[838,302],[769,301],[769,265],[804,264],[804,163],[800,148],[777,135],[682,135],[682,122],[674,119],[674,92]]}]};

const plantaUI = { svgListo: false, cargando: false, abierta: false, nivel: null, conBomba: false };

function plantaObraActual() { return byId(state.obras, state.obraId); }
function plantaDisponible() {
  const o = plantaObraActual();
  return !!o && /summit/i.test(o.nombre || "");
}

function plantaNivelActual() {
  return PLANTA_NIVELES.find((n) => n.nivel === plantaUI.nivel) || PLANTA_NIVELES[0];
}

function plantaNomenclatura(e) { return e.codigo; }
// Compara sin espacios, guiones ni el sufijo " · P2" de versiones anteriores.
function plantaNorm(t) { return String(t || "").replace(/\s*·\s*P\d+$/, "").replace(/[\s-]/g, "").toLowerCase(); }
function plantaFmt(n) { return String(n).replace(".", ","); }
function plantaFmtCota(n) { return `${n > 0 ? "+" : ""}${plantaFmt(n.toFixed(2))}`; }

// Estado de un elemento para el día y nivel actuales:
// "hoy" (ya está en el plan de este día), "otro" (en el plan de otro día) o "libre".
function plantaEstado(e, niv) {
  const nom = plantaNorm(plantaNomenclatura(e));
  const mismo = state.planDia.filter((r) => plantaNorm(r.nomenclatura) === nom && Math.abs((r.cota ?? 0) - niv.nci) < 0.001);
  const hoy = mismo.find((r) => r.fecha === state.planFecha);
  if (hoy) return { estado: "hoy", fila: hoy };
  const otro = mismo.find((r) => r.fecha !== state.planFecha);
  if (otro) return { estado: "otro", fila: otro };
  return { estado: "libre" };
}

// Una figura puede ser un polígono [[x,y],...] o varios (lista de polígonos).
function plantaPolys(e) { return Array.isArray(e.poly[0][0]) ? e.poly : [e.poly]; }

function plantaTodos() { return PLANTA_DATA.SL.concat(PLANTA_DATA.E); }

function plantaTitulo(e, niv, est) {
  const dim = e.desc ? ` (${e.desc})` : "";
  let t = `${e.tipo === "L" ? "Losa" : e.tipo === "P" ? "Pilar" : e.tipo === "E" ? "" : "Pantalla"} ${e.codigo}${dim} — ${plantaFmt(e.m3)} m³`;
  if (est.estado === "hoy") t += " — en el plan de hoy (tocá para sacarlo)";
  else if (est.estado === "otro") t += ` — ya cargado el ${fmtFechaCorta(est.fila.fecha)}`;
  return t;
}

async function plantaCargarSvg() {
  if (plantaUI.svgListo || plantaUI.cargando) return;
  plantaUI.cargando = true;
  const cont = $("#plantaSvgWrap");
  try {
    const resp = await fetch("planta-tipo.svg");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    cont.innerHTML = await resp.text();
    const svg = cont.querySelector("svg");
    svg.setAttribute("id", "plantaSvg");
    const NS = "http://www.w3.org/2000/svg";
    // La planta del PDF viene girada: se gira 90° a la izquierda (todo el dibujo
    // y las figuras tocables juntos); los rótulos se des-giran para leerse derechos.
    const rot = document.createElementNS(NS, "g");
    rot.setAttribute("transform", "rotate(-90)");
    while (svg.firstChild) rot.appendChild(svg.firstChild);
    svg.appendChild(rot);
    svg.setAttribute("viewBox", "34 -568 535 520");
    const g = document.createElementNS(NS, "g");
    g.setAttribute("id", "plantaHot");
    g.setAttribute("transform", `scale(${PLANTA_ESCALA})`);
    rot.appendChild(g);
    plantaUI.svgListo = true;
  } catch (err) {
    cont.textContent = "No se pudo cargar el plano de la planta (" + err.message + ").";
  }
  plantaUI.cargando = false;
}

function plantaDibujar() {
  const g = $("#plantaHot");
  if (!g) return;
  const NS = "http://www.w3.org/2000/svg";
  const niv = plantaNivelActual();
  g.innerHTML = "";
  let enPlan = 0, m3Plan = 0;
  plantaTodos().forEach((e) => {
    const est = plantaEstado(e, niv);
    if (est.estado === "hoy") { enPlan++; m3Plan += est.fila.m3; }
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", plantaPolys(e).map((pl) => "M" + pl.map((q) => q.join(",")).join(" L") + " Z").join(" "));
    p.setAttribute("class", `pl-el pl-${est.estado} pl-t${e.tipo}`);
    p.setAttribute("data-id", e.id);
    const t = document.createElementNS(NS, "title");
    t.textContent = plantaTitulo(e, niv, est);
    p.appendChild(t);
    p.addEventListener("click", () => plantaClick(e));
    g.appendChild(p);
  });
  // Rótulos (encima de todo, sin capturar el clic)
  plantaTodos().forEach((e) => {
    const pts = [].concat(...plantaPolys(e));
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const tx = document.createElementNS(NS, "text");
    const corto = e.tipo === "E" ? "Escalera" : e.tipo === "PA" ? e.codigo.split(" ")[0] + (e.id === "pa_esc" ? " núcleo" : e.id === "pa_esct" ? " pata" : "") : e.codigo;
    tx.textContent = corto;
    tx.setAttribute("x", e.tipo === "P" ? Math.max(...xs) + 3 : e.id === "pa_esc" ? Math.max(...xs) + 3 : cx);
    tx.setAttribute("y", e.tipo === "P" ? cy : e.tipo === "L" ? cy + 40 : e.id === "pa_esc" ? cy + 30 : cy);
    tx.setAttribute("class", "pl-rot pl-rot" + e.tipo);
    tx.setAttribute("transform", `rotate(90 ${tx.getAttribute("x")} ${tx.getAttribute("y")})`);
    g.appendChild(tx);
  });
  $("#plantaResumen").textContent = enPlan
    ? `Piso ${niv.piso}: ${enPlan} elemento${enPlan === 1 ? "" : "s"} en el plan de este día, ${fmtM3(m3Plan)} m³.`
    : `Piso ${niv.piso}: todavía no hay nada de este piso en el plan de este día.`;
}

async function plantaClick(e) {
  if (!puedeAgregar()) return;
  if (!state.planFecha) return toast("Elegí el día", "error");
  const niv = plantaNivelActual();
  const est = plantaEstado(e, niv);
  if (est.estado === "hoy") {
    try { await DB.delete("planDia", est.fila.id); } catch (err) { return; }
    state.planDia = state.planDia.filter((r) => r.id !== est.fila.id);
    renderPlanDia();
    return;
  }
  if (est.estado === "otro" &&
      !confirm(`${plantaNomenclatura(e, niv)} ya está cargado en el plan del ${fmtFechaCorta(est.fila.fecha)}. ¿Agregarlo también a este día?`)) return;
  const codigoEl = PLANTA_COD_ELEMENTO[e.tipo];
  const elem = state.catalogo.elementos.find((x) => (x.codigo || "").toUpperCase() === codigoEl);
  if (!elem) return toast(`Falta el elemento "${codigoEl}" en Referencias`, "error");
  const horm = PLANTA_HORMIGON[e.tipo];
  if (!planHormigonesCatalogo().some((h) => h.codigo === horm)) return toast(`Falta el hormigón ${horm} en Referencias`, "error");
  const filas = planFilasDelDia();
  let area = null;
  if (e.alturaCm) area = Math.round((e.m3 / (e.alturaCm / 100)) * 10000) / 10000;
  const fila = {
    id: uid("plan"),
    obraId: state.obraId,
    fecha: state.planFecha,
    orden: filas.length ? Math.max(...filas.map((f) => f.orden)) + 1 : 1,
    zona: "TORRE",
    elementoId: elem.id,
    nomenclatura: plantaNomenclatura(e, niv),
    cota: niv.nci,
    largoCm: e.diamCm || e.largoCm || null,
    anchoCm: e.diamCm || e.anchoCm || null,
    areaM2: area,
    alturaCm: e.alturaCm || null,
    m3: planR2(e.m3),
    hormigon: horm,
    bombeado: plantaUI.conBomba,
    observaciones: "Desde el plano",
    cargado: false,
  };
  try { await DB.put("planDia", fila); } catch (err) { return; }
  state.planDia.push(fila);
  renderPlanDia();
}

function plantaCargarNiveles() {
  const sel = $("#plantaNivel");
  if (!sel) return;
  if (sel.options.length !== PLANTA_NIVELES.length) {
    sel.innerHTML = "";
    PLANTA_NIVELES.forEach((n) => sel.appendChild(el("option", { value: String(n.nivel) }, `Piso ${n.piso} — Nivel ${n.nivel} (NCI ${plantaFmtCota(n.nci)})`)));
  }
  if (plantaUI.nivel === null) {
    let guardado = null;
    try { guardado = parseInt(localStorage.getItem("plantaNivel"), 10); } catch (e) { /* sin storage */ }
    plantaUI.nivel = PLANTA_NIVELES.some((n) => n.nivel === guardado) ? guardado : PLANTA_NIVELES[0].nivel;
  }
  sel.value = String(plantaUI.nivel);
}

// Se llama cada vez que se redibuja el Plan del día.
function renderPlanta() {
  const btn = $("#btnPlantaAbrir");
  if (!btn) return;
  const ok = plantaDisponible();
  btn.style.display = ok ? "" : "none";
  const panel = $("#plantaPanel");
  if (!ok) { panel.style.display = "none"; return; }
  panel.style.display = plantaUI.abierta ? "" : "none";
  btn.textContent = plantaUI.abierta ? "Ocultar plano" : "Plano de la planta";
  if (!plantaUI.abierta) return;
  plantaCargarNiveles();
  plantaCargarSvg().then(plantaDibujar);
}

function bindPlantaHandlers() {
  const btn = $("#btnPlantaAbrir");
  if (!btn) return;
  btn.addEventListener("click", () => { plantaUI.abierta = !plantaUI.abierta; renderPlanta(); });
  $("#plantaNivel").addEventListener("change", (ev) => {
    plantaUI.nivel = parseInt(ev.target.value, 10);
    try { localStorage.setItem("plantaNivel", String(plantaUI.nivel)); } catch (e) { /* sin storage */ }
    plantaDibujar();
  });
  $("#plantaBomba").addEventListener("change", (ev) => { plantaUI.conBomba = ev.target.checked; });
}
