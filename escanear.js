/* ===========================================================
   escanear.js — Escanear un remito (foto) y completar la fila
   en "Remitos del día" del Plan.

   - La lectura (OCR) se hace en el propio celular/navegador con
     Tesseract.js (archivos en vendor/tesseract). Es gratis, la foto
     no sale del dispositivo y NO se guarda en ningún lado.
   - Lee lo impreso: N° de remito, fecha, m3, hormigón y bombeo. Las
     horas y el asentamiento (a mano) no se leen: se completan a mano.
   - Lo dudoso queda marcado en amarillo para revisar.
   =========================================================== */

// m3 de un texto corto: "8.00", "8,00", "800" (sin punto) -> 8. Devuelve null si no es plausible (1 a 12).
function escNumeroM3(txt) {
  const t = String(txt || "");
  const plausible = (v) => v >= 1 && v <= 12;
  for (const m of t.matchAll(/(\d{1,3})\s*[.,]\s*(\d{1,2})/g)) {
    let ent = m[1];
    let v = parseFloat(`${ent}.${m[2]}`);
    while (!plausible(v) && ent.length > 1) { ent = ent.slice(1); v = parseFloat(`${ent}.${m[2]}`); }
    if (plausible(v)) return v;
  }
  for (const m of t.matchAll(/(?<!\d)(\d)(\d{2})(?!\d)/g)) {
    const v = parseFloat(`${m[1]}.${m[2]}`);
    if (plausible(v) && /00|50|25|75/.test(m[2])) return v;
  }
  return null;
}

// Interpreta el texto leído. Función pura (se puede probar sola).
// hormigones: códigos del catálogo, ej. ["C20","C30","C35","C45"].
function escParsear(texto, hormigones) {
  const t = String(texto || "");
  const out = { nro: "", fecha: "", m3: "", hormigon: "", bombeo: /BOMB/i.test(t), dudas: {} };

  // N° de remito: 8 dígitos que empiezan con 2 (ej. 21037363).
  const nros = [...t.matchAll(/(?<!\d)(2\d{7})(?!\d)/g)].map((m) => m[1]);
  if (nros.length) out.nro = nros[0];
  else out.dudas.nro = true;
  // Aunque se haya leído, si hay más de un candidato distinto hay duda.
  if (new Set(nros).size > 1) out.dudas.nro = true;

  // Fecha dd/mm/aa o dd/mm/aaaa
  for (const m of t.matchAll(/(?<!\d)(\d{2})\s*[\/.\-]\s*(\d{2})\s*[\/.\-]\s*(\d{4}|\d{2})(?!\d)/g)) {
    const d = +m[1], mo = +m[2];
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      out.fecha = `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2]}-${m[1]}`;
      break;
    }
  }

  // m3: número seguido de "M3". Con OCR sucio es común que aparezcan dígitos de más
  // (ej. "18.00" por "8.00"): se prueba quitando dígitos del principio.
  const reM3 = /(\d{1,3})\s*[.,]\s*(\d{1,3})\s*[,.]?\s*M\s*[3S]/gi;
  for (const m of t.matchAll(reM3)) {
    let ent = m[1];
    let val = parseFloat(`${ent}.${m[2].slice(0, 2)}`);
    const plausible = (v) => v >= 1 && v <= 12;
    let dudoso = m[2].length > 2 || !/^0{1,2}$/.test(m[2].slice(0, 2)) && false;
    while (!plausible(val) && ent.length > 1) { ent = ent.slice(1); val = parseFloat(`${ent}.${m[2].slice(0, 2)}`); dudoso = true; }
    if (plausible(val)) {
      out.m3 = String(val.toFixed(2)).replace(/\.00$/, "");
      if (m[2].length !== 2 || dudoso) out.dudas.m3 = true;
      break;
    }
  }
  if (!out.m3) {
    const m = /(?<!\d)(\d)(00|50|25|75)\s*,?\s*M\s*[3S]/i.exec(t);
    if (m) { out.m3 = String(parseFloat(`${m[1]}.${m[2]}`)); out.dudas.m3 = true; }
  }
  if (!out.m3) out.dudas.m3 = true;

  // Hormigón: letra + 2 dígitos que coincidan con un código del catálogo (C35, C45...).
  const nums = (hormigones || []).map((h) => ({ h, n: (/\d+/.exec(h) || [""])[0] })).filter((x) => x.n);
  for (const m of t.matchAll(/(?<![A-Za-z0-9])[CcEe£G]\s?(\d{2})/g)) {
    const hit = nums.find((x) => x.n === m[1]);
    if (hit) { out.hormigon = hit.h; break; }
  }
  if (!out.hormigon) out.dudas.hormigon = true;
  return out;
}

// Prepara la foto: respeta la orientación, la achica y la pasa a un solo canal
// (el verde: el resaltador amarillo queda claro y no tapa la letra) con contraste.
async function escPrepararImagen(file, anchoMax = 1800) {
  const bmp = await createImageBitmap(file);
  const esc = Math.min(1, anchoMax / bmp.width);
  const w = Math.round(bmp.width * esc), h = Math.round(bmp.height * esc);
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[d[i + 1]]++;
  const total = w * h;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.15) { hi = v; break; } }
  const rango = Math.max(30, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, Math.round(((d[i + 1] - lo) / rango) * 255)));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  if (bmp.close) bmp.close();
  return cv;
}

let escWorker = null;
async function escObtenerWorker(onProgreso) {
  if (escWorker) return escWorker;
  if (typeof Tesseract === "undefined") {
    await new Promise((ok, mal) => {
      const s = document.createElement("script");
      s.src = "vendor/tesseract/tesseract.min.js";
      s.onload = ok; s.onerror = () => mal(new Error("No se pudo cargar el lector de texto"));
      document.head.appendChild(s);
    });
  }
  escWorker = await Tesseract.createWorker("eng", 1, {
    workerPath: "vendor/tesseract/worker.min.js",
    corePath: "vendor/tesseract/",
    langPath: "vendor/tesseract/lang",
    gzip: true,
    logger: (m) => { if (onProgreso && m.status === "recognizing text") onProgreso(Math.round(m.progress * 100)); },
  });
  return escWorker;
}

// Segunda pasada, solo si la primera falló: vuelve a leer una zona chica del remito
// (agrandada, y solo con dígitos), ubicada a partir de palabras impresas fijas.
function escPalabra(words, re) {
  const c = (words || []).filter((w) => re.test(w.text || ""));
  return c.sort((a, b) => (b.bbox.y1 - b.bbox.y0) - (a.bbox.y1 - a.bbox.y0))[0] || null;
}
// Blanco y negro (Otsu) y borra las rayas horizontales largas (las líneas impresas del
// formulario que a veces atraviesan los números).
function escBinarizarSinLineas(cv) {
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const w = cv.width, h = cv.height;
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
  const total = w * h;
  let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, mx = 0, th = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (sum - sumB) / wF, varB = wB * wF * (mB - mF) * (mB - mF);
    if (varB > mx) { mx = varB; th = v; }
  }
  const neg = new Uint8Array(total);
  for (let i = 0; i < total; i++) neg[i] = d[i * 4] <= th ? 1 : 0;
  const minRun = Math.max(40, Math.round(w * 0.12));
  const borrar = new Uint8Array(total);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!neg[y * w + x]) { x++; continue; }
      let x2 = x; while (x2 < w && neg[y * w + x2]) x2++;
      if (x2 - x >= minRun) for (let k = x; k < x2; k++) for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy >= 0 && yy < h) borrar[yy * w + k] = 1; }
      x = x2;
    }
  }
  for (let i = 0; i < total; i++) { const v = neg[i] && !borrar[i] ? 0 : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; }
  ctx.putImageData(img, 0, 0);
  return cv;
}

async function escLeerZona(worker, canvas, x0, y0, x1, y1, digitos, modos = ["6", "7", "11"]) {
  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
  x1 = Math.min(canvas.width, Math.round(x1)); y1 = Math.min(canvas.height, Math.round(y1));
  if (x1 - x0 < 20 || y1 - y0 < 10) return "";
  const k = 2;
  const cv = document.createElement("canvas");
  cv.width = (x1 - x0) * k; cv.height = (y1 - y0) * k;
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, cv.width, cv.height);
  let todo = "";
  const leer = async (lienzo, lista) => {
    for (const modo of lista) {
      await worker.setParameters({ tessedit_char_whitelist: digitos, tessedit_pageseg_mode: modo });
      const { data } = await worker.recognize(lienzo);
      todo += "\n" + (data.text || "");
    }
  };
  await leer(cv, modos);
  if (!/\d{3,}/.test(todo.replace(/\s/g, ""))) await leer(escBinarizarSinLineas(cv), ["11", "6"]);
  await worker.setParameters({ tessedit_char_whitelist: "", tessedit_pageseg_mode: "3" });
  return todo;
}
async function escReintentar(worker, canvas, words, r) {
  if (r.dudas.nro) {
    const a = escPalabra(words, /^REMITO/i);
    if (a) {
      const u = canvas.width * 0.03;
      const tx = await escLeerZona(worker, canvas, a.bbox.x0 - u * 0.5, a.bbox.y1 + u * 0.9, a.bbox.x0 + u * 8, a.bbox.y1 + u * 3.3, "0123456789 ");
      const m = /(?<!\d)(2\d{7})(?!\d)/.exec(tx.replace(/[ \t]+/g, " ")) || /(2\d{7})/.exec(tx.replace(/\s/g, ""));
      if (m) { r.nro = m[1]; r.dudas.nro = true; /* leído por 2ª pasada: queda para revisar */ }
    }
  }
  if (r.dudas.m3) {
    let a = escPalabra(words, /^(Producto|Solicitado)/i);
    let desdeIzq = false;
    if (!a) { a = escPalabra(words, /^(Cantidad|Unidad)/i); desdeIzq = true; }
    if (a) {
      const u = canvas.width * 0.03;
      const tx = await escLeerZona(worker, canvas, desdeIzq ? 0 : a.bbox.x0 - u, a.bbox.y1 + u * 0.4, desdeIzq ? canvas.width * 0.4 : a.bbox.x0 + canvas.width * 0.3, a.bbox.y1 + u * 3.2, "0123456789.,M ");
      const v = escNumeroM3(tx);
      if (v !== null) { r.m3 = String(v).replace(/\.0+$/, ""); r.dudas.m3 = true; }
    }
  }
}

async function escEscanearArchivos(files) {
  const btn = $("#btnPlanEscanear");
  const original = btn.textContent;
  btn.disabled = true;
  let ok = 0;
  try {
    for (const file of files) {
      btn.textContent = "Preparando lector...";
      const worker = await escObtenerWorker((p) => { btn.textContent = `Leyendo remito... ${p}%`; });
      btn.textContent = "Leyendo remito...";
      const canvas = await escPrepararImagen(file);
      const { data } = await worker.recognize(canvas);
      const hs = planHormigonesCatalogo().map((h) => h.codigo);
      const r = escParsear(data.text, hs);
      if (r.dudas.nro || r.dudas.m3) {
        btn.textContent = "Releyendo datos dudosos...";
        try { await escReintentar(worker, canvas, data.words, r); } catch (e) { console.warn("[Escanear] 2ª pasada", e); }
      }
      const fila = {
        nro: r.nro, hormigon: r.hormigon || (planUI.remitos[planUI.remitos.length - 1] || {}).hormigon || hs[hs.length - 1] || "",
        m3: r.m3, horaAObra: "", horaDescarga: "", dudas: r.dudas, bombeo: !!r.bombeo,
      };
      planUI.remitos = planUI.remitos.filter((x) => x.nro || x.m3);
      planUI.remitos.push(fila);
      renderPlanRemitosForm();
      ok++;
      if (r.fecha && state.planFecha && r.fecha !== state.planFecha) {
        toast(`Ojo: el remito dice ${fmtFechaCorta(r.fecha)} y el plan es del ${fmtFechaCorta(state.planFecha)}`, "error");
      }
      planUI.ultimoTexto = data.text;
    }
    if (ok) toast(`Leí ${ok} remito${ok === 1 ? "" : "s"}. Revisá lo marcado en amarillo y completá las horas.`, "ok");
  } catch (e) {
    console.error("[Escanear remito]", e);
    toast("No pude leer la foto: " + (e.message || e), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function bindEscanearHandlers() {
  const btn = $("#btnPlanEscanear");
  if (!btn) return;
  btn.addEventListener("click", () => $("#planFoto").click());
  $("#planFoto").addEventListener("change", (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) escEscanearArchivos(files);
  });
}
