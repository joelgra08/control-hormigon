/* ===========================================================
   db.js — Capa de persistencia (Supabase)
   Mismo "contrato" que la versión anterior basada en IndexedDB
   (DB.getAll / DB.get / DB.put / DB.bulkPut / DB.delete / DB.clear),
   para que el resto de la app (app.js) no tenga que cambiar casi
   nada: solo cambia DÓNDE se guardan los datos, no cómo se usan.

   - Cada "store" (nombre en camelCase, como lo usa app.js) se
     mapea a una tabla real de Postgres (snake_case).
   - Los campos de cada fila se convierten automáticamente entre
     camelCase (JS) y snake_case (Postgres) con una función
     genérica, sin necesidad de mapear campo por campo a mano.
   - "config" no es una tabla: son preferencias de ESTE navegador
     (ej. cuál fue la última obra elegida), así que se guardan en
     localStorage en vez de mandarse al servidor.
   - Los permisos reales (quién puede ver/agregar/editar/borrar)
     los aplica el servidor mismo (Row Level Security), no este
     archivo: si al servidor no le gusta una operación, la rechaza
     con un error que esta capa convierte en un aviso en pantalla.
   =========================================================== */

// Orden importante: una obra tiene que existir antes que sus
// remitos, y un remito antes que sus líneas (por las referencias
// entre tablas). Lo mismo para pedidos de hierro y sus ítems.
const STORES = {
  obras: "obras",
  catalogoElementos: "catalogo_elementos",
  catalogoHormigones: "catalogo_hormigones",
  catalogoProveedores: "catalogo_proveedores",
  catalogoCuadrillas: "catalogo_cuadrillas",
  catalogoColocacion: "catalogo_colocacion",
  catalogoEquipos: "catalogo_equipos",
  remitos: "remitos",
  remitoLineas: "remito_lineas",
  diasExtra: "dias_extra",
  personalMensual: "personal_mensual",
  personal: "personal",
  pedidosHierro: "pedidos_hierro",
  pedidoHierroLineas: "pedido_hierro_lineas",
  programacion: "programacion",
  config: null, // ver nota arriba: vive en localStorage, no en Supabase
};

function toSnakeCase(key) {
  return key.replace(/([A-Z])/g, "_$1").toLowerCase();
}
function toCamelCase(key) {
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}
function rowToDb(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (k === "facturaBlob") continue; // nunca viaja a la base: va a Storage aparte
    out[toSnakeCase(k)] = obj[k];
  }
  return out;
}
function rowFromDb(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[toCamelCase(k)] = obj[k];
  return out;
}

function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function dbErrorMessage(error) {
  if (!error) return "Error desconocido";
  if (error.code === "42501" || /row-level security|permission denied/i.test(error.message || "")) {
    return "No tenés permiso para hacer esta acción";
  }
  if (error.message) return error.message;
  return "No se pudo completar la operación en el servidor";
}

function reportDbError(error, accion) {
  console.error(`[DB] Error en ${accion}:`, error);
  if (typeof toast === "function") toast(dbErrorMessage(error), "error");
}

// ---------- config (preferencias locales de este navegador) ----------
const CONFIG_PREFIX = "ch_config_";
function configGetAll() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(CONFIG_PREFIX)) {
      try {
        out.push({ key: k.slice(CONFIG_PREFIX.length), value: JSON.parse(localStorage.getItem(k)) });
      } catch (e) { /* ignorar entradas corruptas */ }
    }
  }
  return out;
}
function configGet(key) {
  const raw = localStorage.getItem(CONFIG_PREFIX + key);
  if (raw === null) return null;
  try { return { key, value: JSON.parse(raw) }; } catch (e) { return null; }
}
function configPut(value) {
  localStorage.setItem(CONFIG_PREFIX + value.key, JSON.stringify(value.value));
}
function configDelete(key) {
  localStorage.removeItem(CONFIG_PREFIX + key);
}
function configClear() {
  configGetAll().forEach((c) => configDelete(c.key));
}

const DB = {
  async getAll(store) {
    if (store === "config") return configGetAll();
    const table = STORES[store];
    const { data, error } = await supabaseClient.from(table).select("*");
    if (error) { reportDbError(error, `leer ${store}`); return []; }
    return (data || []).map(rowFromDb);
  },

  async get(store, key) {
    if (store === "config") return configGet(key);
    const table = STORES[store];
    const { data, error } = await supabaseClient.from(table).select("*").eq("id", key).maybeSingle();
    if (error) { reportDbError(error, `leer ${store}`); return null; }
    return data ? rowFromDb(data) : null;
  },

  async put(store, value) {
    if (store === "config") { configPut(value); return; }
    const table = STORES[store];
    const { error } = await supabaseClient.from(table).upsert(rowToDb(value));
    if (error) { reportDbError(error, `guardar en ${store}`); throw error; }
    if (typeof markSaved === "function") markSaved();
  },

  async bulkPut(store, values) {
    if (!values || values.length === 0) return;
    if (store === "config") { values.forEach(configPut); return; }
    const table = STORES[store];
    let rows = values.map(rowToDb);
    // Filas viejas (de versiones anteriores de la app) pueden no tener algún
    // campo que se agregó después (ej. "modificado"). Postgrest exige que
    // todas las filas de una misma carga tengan exactamente las mismas
    // columnas, así que completamos con null las que falten en cada fila.
    const todasLasClaves = new Set();
    rows.forEach((r) => Object.keys(r).forEach((k) => todasLasClaves.add(k)));
    rows = rows.map((r) => {
      const completa = {};
      todasLasClaves.forEach((k) => (completa[k] = k in r ? r[k] : null));
      return completa;
    });
    const CHUNK = 500; // evitar pedidos gigantes en restauraciones grandes
    for (let i = 0; i < rows.length; i += CHUNK) {
      let chunk = rows.slice(i, i + CHUNK);
      // Una copia de seguridad vieja puede traer campos de alguna función que
      // ya no existe en la app (ej. el "estado del tiempo" que se sacó hace
      // rato). Si el servidor dice que no conoce esa columna, la sacamos de
      // todas las filas y reintentamos — así no se pierde el resto del
      // restaurar por un campo viejo que ya nadie usa.
      for (let intentos = 0; ; intentos++) {
        const { error } = await supabaseClient.from(table).upsert(chunk);
        if (!error) break;
        const columnaDesconocida = /Could not find the '([^']+)' column/.exec(error.message || "");
        if (columnaDesconocida && intentos < 20) {
          const col = columnaDesconocida[1];
          chunk = chunk.map((r) => { const { [col]: _omitido, ...resto } = r; return resto; });
          continue;
        }
        reportDbError(error, `guardar en ${store}`);
        throw new Error(`guardar en ${store}: ${dbErrorMessage(error)}`);
      }
    }
    if (typeof markSaved === "function") markSaved();
  },

  async delete(store, key) {
    if (store === "config") { configDelete(key); return; }
    const table = STORES[store];
    const { error } = await supabaseClient.from(table).delete().eq("id", key);
    if (error) { reportDbError(error, `borrar en ${store}`); throw error; }
    if (typeof markSaved === "function") markSaved();
  },

  async clear(store) {
    if (store === "config") { configClear(); return; }
    const table = STORES[store];
    // Postgrest exige algún filtro para un delete masivo: "id is not null"
    // selecciona todas las filas sin excepción.
    const { error } = await supabaseClient.from(table).delete().not("id", "is", null);
    if (error) { reportDbError(error, `vaciar ${store}`); throw error; }
  },
};
