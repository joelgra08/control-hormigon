/* ===========================================================
   auth.js — Login, sesión y permisos por rol.
   La seguridad REAL vive en el servidor (Row Level Security):
   esto solo decide qué botones mostrar para que la experiencia
   sea prolija. Si algo igual se intenta sin permiso, el servidor
   lo rechaza y aparece un aviso de error.
   =========================================================== */

const ROLES_INFO = {
  administrador: "Administrador",
  controller: "Controller",
  asistente: "Asistente",
  probetas: "Probetas",
};

function esAdmin() { return state.miPerfil?.rol === "administrador"; }
function esAsistente() { return state.miPerfil?.rol === "asistente"; }
function esProbetas() { return state.miPerfil?.rol === "probetas"; }
function puedeAgregar() { return esAdmin() || esAsistente(); } // remitos y pedidos de hierro

function mostrarLogin(mensaje) {
  $("#app").style.display = "none";
  $("#loginOverlay").style.display = "flex";
  $("#loginError").textContent = mensaje || "";
  $("#loginError").style.display = mensaje ? "block" : "none";
}

function ocultarLogin() {
  $("#loginOverlay").style.display = "none";
  $("#app").style.display = "block";
}

async function cargarMiPerfil(userId) {
  const { data, error } = await supabaseClient.from("perfiles").select("*").eq("id", userId).maybeSingle();
  if (error) {
    console.error(error);
    return null;
  }
  if (!data) return null;
  return { nombre: data.nombre, puesto: data.puesto, rol: data.rol };
}

async function iniciarSesion(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    mostrarLogin(error.message === "Invalid login credentials" ? "Email o contraseña incorrectos" : error.message);
    return false;
  }
  const perfil = await cargarMiPerfil(data.user.id);
  if (!perfil || !perfil.rol) {
    await supabaseClient.auth.signOut();
    mostrarLogin("Tu cuenta todavía no tiene un rol asignado. Pedile al administrador que te lo asigne.");
    return false;
  }
  state.miPerfil = perfil;
  return true;
}

async function cerrarSesion() {
  await supabaseClient.auth.signOut();
  state.miPerfil = null;
  location.reload();
}

function aplicarPermisosUI() {
  const rol = state.miPerfil?.rol || "";
  document.body.dataset.rol = rol;
  const info = $("#miUsuarioInfo");
  if (info) info.textContent = `${state.miPerfil.nombre || ""} · ${ROLES_INFO[rol] || rol}`;

  // Probetas: solo puede ver/usar la pestaña de Probetas.
  if (esProbetas()) {
    showTab("probetas");
  }

  // Campos que solo el administrador puede editar (temperatura del día,
  // horas/feriados del mes): el resto los ve pero no los puede tocar.
  const tarjetaTemp = $("#tarjetaTemperatura");
  if (tarjetaTemp) tarjetaTemp.disabled = !esAdmin();
  const pmHoras = $("#pm_horas");
  if (pmHoras) pmHoras.disabled = !esAdmin();
  const pmFeriados = $("#pm_feriados");
  if (pmFeriados) pmFeriados.disabled = !esAdmin();
}

function bindLoginForm() {
  $("#formLogin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#loginEmail").value.trim();
    const password = $("#loginPassword").value;
    const btn = $("#btnLogin");
    btn.disabled = true;
    btn.textContent = "Entrando...";
    const ok = await iniciarSesion(email, password);
    btn.disabled = false;
    btn.textContent = "Entrar";
    if (ok) {
      ocultarLogin();
      await continuarInicioLuegoDeLogin();
    }
  });
  $("#btnLogout").addEventListener("click", cerrarSesion);
}
